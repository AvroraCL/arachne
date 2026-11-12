import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,DATA,atomic,forkProject} from './store.mjs';
import {pythonExecutable} from './python-runtime.mjs';
import {sha256File} from './file-fingerprint.mjs';

const execute=promisify(execFile);
const coreRegistrationFiles=['model.glb','base.png','metadata.json','registration.json'];
const preservedSurfaceFiles=[
  'surface/cache/geometry_report.json','surface/cache/resolved_config.json',
  ...['surface','faces','edges'].map(name=>'surface/cache/mapping/'+name+'.npz'),
  'surface/guides/cameras.json','surface/guides/surfaces.npz',
  ...['receiver','protected','silhouette'].map(name=>'surface/guides/top/'+name+'.png')
];
export const glbRegistrationFiles=(legacySurface=false)=>legacySurface?[...coreRegistrationFiles,...preservedSurfaceFiles]:coreRegistrationFiles;

export async function registerGlb(input,scratch,python=pythonExecutable()){
  const staging=path.join(scratch,'registration');
  const config=path.join(scratch,'input.json');
  await fs.mkdir(staging);
  atomic(config,{input,out:staging,ownerPid:process.pid});
  try{
    await execute(python,['-X','utf8',path.join(ROOT,'model_surface.py'),'register',config],
      {cwd:ROOT,windowsHide:true,timeout:180000});
  }catch(error){
    throw Error(error.stderr?.trim().slice(-1200)||'GLB 登记失败，请检查文件格式和原 UV');
  }
  return staging;
}
export async function importGlbProject(input,scratch,name){
  const staging=await registerGlb(input,scratch);
  return installGlbRegistration(staging,doc=>forkProject(doc.id,doc,name));
}
export async function describeGlbRegistration(folder,id,files=folder){
  const meta=JSON.parse(await fs.readFile(path.join(files,'metadata.json'),'utf8'));
  const cache=path.join(folder,'surface');
  const source={format:'glb',bindingVersion:2,reviewSource:path.join(folder,'model.glb'),baseImage:path.join(folder,'base.png'),
    bundle:path.join(cache,'guides'),cacheRun:path.join(cache,'cache'),material:meta.material,uvSha256:meta.uv_before,
    ...(meta.legacySurface===true?{preservedSurface:true}:{}),
    files:{}};
  for(const file of glbRegistrationFiles(meta.legacySurface===true))
    source.files[path.join(folder,file)]=await sha256File(path.join(files,file));
  return {id,schemaVersion:1,workflowType:'pbr_paint',canvas:{width:4096,height:4096},source,
    layers:[],assets:{},fonts:{},guides:{},basecoat:{color:meta.base.color},paint:{base:meta.base,layers:[],assets:{}}};
}
export async function installGlbRegistration(staging,create){
  const id=randomUUID(),folder=path.join(DATA,'model-sources',id);
  const doc=await describeGlbRegistration(folder,id,staging);
  await fs.mkdir(path.dirname(folder),{recursive:true});
  await fs.rename(staging,folder);
  try{return await create(doc);}
  catch(error){await fs.rm(folder,{recursive:true,force:true});throw error;}
}
