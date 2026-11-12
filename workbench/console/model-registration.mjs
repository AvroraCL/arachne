import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,DATA,atomic,forkProject} from './store.mjs';
import {pythonExecutable} from './python-runtime.mjs';
import {sha256File} from './file-fingerprint.mjs';
import {channelSpecs} from './public/paint-channels.mjs';

const execute=promisify(execFile);
const coreRegistrationFiles=['model.glb','base.png','metadata.json','registration.json'];
const preservedSurfaceFiles=[
  'surface/cache/geometry_report.json','surface/cache/resolved_config.json',
  ...['surface','faces','edges'].map(name=>'surface/cache/mapping/'+name+'.npz'),
  'surface/guides/cameras.json','surface/guides/surfaces.npz',
  ...['receiver','protected','silhouette'].map(name=>'surface/guides/top/'+name+'.png')
];
export const glbRegistrationFiles=(legacySurface=false)=>legacySurface?[...coreRegistrationFiles,...preservedSurfaceFiles]:coreRegistrationFiles;

export async function registerGlb(input,scratch,{python=pythonExecutable(),material,textureOutput}={}){
  const staging=path.join(scratch,'registration');
  const config=path.join(scratch,'input.json');
  await fs.mkdir(staging);
  atomic(config,{input,out:staging,material,textureOutput,ownerPid:process.pid});
  try{
    await execute(python,['-X','utf8',path.join(ROOT,'model_surface.py'),'register',config],
      {cwd:ROOT,windowsHide:true,timeout:180000});
  }catch(error){
    const reason=error.stderr?.trim();
    if(reason&&!/[\r\n]/.test(reason))throw Error(reason.slice(0,400));
    throw Error('GLB 登记失败，请检查文件格式和原 UV');
  }
  return staging;
}
export async function importGlbProject(input,scratch,name,material,{preserveTextures=true}={}){
  const textureOutput=preserveTextures?path.join(scratch,'paint-maps'):undefined;
  const staging=await registerGlb(input,scratch,{material,textureOutput});
  const {importedMaps=[]}=JSON.parse(await fs.readFile(path.join(staging,'metadata.json'),'utf8'));
  const maps={},images=new Map();
  for(const channel of importedMaps){
    if(!Object.hasOwn(channelSpecs,channel))throw Error('源贴图通道无效');
    const source=path.join(textureOutput,channel+'.png');
    const stat=await fs.stat(source);
    if(stat.size>64*1024*1024)throw Error('源贴图转换后超过 64 MiB');
    let dimensions;
    const id=await sha256File(source,{inspectHead:bytes=>{dimensions={width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};}});
    maps[channel]=id;
    if(!images.has(id))images.set(id,{source,entry:{id,sha256:id,file:'paint-'+id+'.png',
      name:'源材质_'+channelSpecs[channel].name+'.png',...dimensions}});
  }
  return installGlbRegistration(staging,doc=>{
    if(images.size){
      doc.paint.assets=Object.fromEntries([...images].map(([id,item])=>[id,item.entry]));
      doc.paint.layers.push({id:randomUUID(),kind:'fill',name:'源材质贴图',visible:true,opacity:1,blend:'normal',
        channels:{color:false,metallic:false,roughness:false,...Object.fromEntries(importedMaps.map(key=>[key,true]))},
        values:{...doc.paint.base},maps,x:.5,y:.5,scale:1,rotation:0,mask:null});
    }
    return forkProject(doc.id,doc,name,async destination=>{
      for(const {entry,source} of images.values()){
        const file=path.join(destination,entry.file);
        await fs.copyFile(source,file);
        if(await sha256File(file)!==entry.sha256)throw Error('复制源贴图时素材指纹变化');
      }
    });
  });
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
