import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,DATA,atomic,forkProject,commit} from './store.mjs';
import {pythonExecutable} from './python-runtime.mjs';
import {sha256File} from './file-fingerprint.mjs';
import {validateModelState,verifyModelStepTargets} from './model-binding.mjs';
import {freezeOriginalBinding} from './paint-surface-bindings.mjs';
import {channelSpecs} from './public/paint-channels.mjs';

const execute=promisify(execFile);
const coreRegistrationFiles=['model.glb','base.png','metadata.json','registration.json'];
const preservedSurfaceFiles=[
  'surface/cache/geometry_report.json','surface/cache/resolved_config.json',
  ...['surface','faces','edges'].map(name=>'surface/cache/mapping/'+name+'.npz'),
  'surface/guides/cameras.json','surface/guides/surfaces.npz',
  ...['receiver','protected','silhouette'].map(name=>'surface/guides/top/'+name+'.png')
];
export function glbRegistrationFiles(legacySurface=false,history=[]){
  if(!Array.isArray(history)||history.some(sha=>typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha))||
     new Set(history).size!==history.length)throw Error('历史投影模型清单无效');
  return [...coreRegistrationFiles,...(legacySurface?preservedSurfaceFiles:[]),
    ...history.flatMap(sha=>coreRegistrationFiles.map(file=>'history/'+sha+'/'+file))];
}

// A frozen projection owns its registration cameras as well as its mesh. Rebuild
// its derived UV caches from these same inputs after a portable project restore.
export function historicalSource(source,sha){
  if(sha===source.files[source.reviewSource])return source;
  if(!source.history?.includes(sha))throw Error('缺少投放时的历史 GLB');
  const folder=path.join(path.dirname(source.reviewSource),'history',sha);
  const file=name=>path.join(folder,name);
  return {...source,history:undefined,reviewSource:file('model.glb'),baseImage:file('base.png'),
    cacheRun:file('surface/cache'),bundle:file('surface/guides'),
    files:Object.fromEntries(coreRegistrationFiles.map(name=>[file(name),source.files[file(name)]]))};
}

export async function registerGlb(input,scratch,{python=pythonExecutable(),material,textureOutput,previousModel,targetMaterial,positionReplay,markedMaterials}={}){
  const staging=path.join(scratch,'registration');
  const config=path.join(scratch,'input.json');
  await fs.mkdir(staging);
  atomic(config,{input,out:staging,material,textureOutput,previousModel,targetMaterial,positionReplay,markedMaterials,ownerPid:process.pid});
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
export async function importObjProject(input,scratch,name,{material,attachments,upAxis,preserveTextures}){
  const output=path.join(scratch,'converted.glb'),config=path.join(scratch,'obj.json');
  atomic(config,{obj:input,out:output,material,attachments,upAxis,preserveTextures,ownerPid:process.pid});
  let converted;
  try{
    const {stdout}=await execute(pythonExecutable(),['-X','utf8',path.join(ROOT,'obj_model.py'),config],
      {cwd:ROOT,windowsHide:true,timeout:180000});
    converted=JSON.parse(stdout);
  }catch(error){
    const reason=error.stderr?.trim();
    if(reason&&!/[\r\n]/.test(reason))throw Error(reason.slice(0,400));
    throw Error('OBJ 转换失败，请检查模型、MTL 和贴图');
  }
  if((await fs.stat(output)).size>128*1024*1024)throw Error('转换后的模型超过 128 MiB');
  return importGlbProject(output,scratch,name,converted.material??undefined,{preserveTextures});
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
export async function updateProjectGlb(doc,revision,input,scratch){
  if(doc.revision!==revision)throw Object.assign(Error('工程已改变，请重新选择模型'),{status:409});
  if(doc.workflowType!=='pbr_paint'||doc.source.format!=='glb'||doc.source.preservedSurface)
    throw Error('此入口适用于原生 GLB 涂装工程');
  const oldSha=doc.source.files[doc.source.reviewSource];
  const modeling=doc.modeling;
  if(modeling){
    validateModelState(modeling);
    const originalSha=doc.source.files[doc.source.reviewSource];
    if(modeling.modelSha256!==originalSha||modeling.binding!==originalSha.slice(0,32))
      throw Error('建模步骤绑定的源模型与当前工程不一致');
  }
  // Absolute vertex edits may overwrite a concurrent source edit. Compare their
  // inputs after all preceding transforms, up to the last absolute edit.
  const lastPosition=modeling?.steps.findLastIndex(step=>step.type==='vertexPositions')??-1;
  const positionReplay=lastPosition<0?undefined:modeling.steps.slice(0,lastPosition+1);
  const staging=await registerGlb(input,scratch,{
    previousModel:doc.source.reviewSource,targetMaterial:doc.source.material,positionReplay,
    markedMaterials:Object.entries(doc.paint.sourceMaterials||{}).filter(([,m])=>m.mark).map(([name])=>name)
  });
  const metadata=JSON.parse(await fs.readFile(path.join(staging,'metadata.json'),'utf8'));
  if(metadata.source_sha256===doc.source.files[doc.source.reviewSource])throw Error('所选模型与当前工程相同');
  const history=new Set(Object.entries(doc.paint.surfaceBindings||{}).map(([key,state])=>
    state?.modelSha256??(key==='original'?oldSha:key)));
  history.delete(metadata.source_sha256);
  if(history.size){
    metadata.history=[...history].sort();
    for(const sha of metadata.history){
      const frozen=historicalSource(doc.source,sha),dest=path.join(staging,'history',sha);
      await fs.mkdir(dest,{recursive:true});
      for(const name of coreRegistrationFiles){
        const from=path.join(path.dirname(frozen.reviewSource),name),to=path.join(dest,name);
        await fs.copyFile(from,to,fs.constants.COPYFILE_FICLONE);
        if(await sha256File(to)!==frozen.files[from])throw Error('历史投影模型的登记文件已改变');
      }
    }
    atomic(path.join(staging,'metadata.json'),metadata);
  }
  let rebound;
  if(modeling){
    const sha=metadata.source_sha256;
    rebound={...modeling,binding:sha.slice(0,32),modelSha256:sha};
    verifyModelStepTargets(path.join(staging,'model.glb'),rebound);
  }
  // The author is changing geometry. Keep the registered painting base, including imported images.
  await fs.copyFile(doc.source.baseImage,path.join(staging,'base.png'));
  return installGlbRegistration(staging,registered=>commit(doc.id,revision,next=>{
    freezeOriginalBinding(next.paint,oldSha);
    next.source=registered.source;
    if(rebound)next.modeling=rebound;
    return next;
  },'更新工程模型'));
}
export async function describeGlbRegistration(folder,id,files=folder){
  const meta=JSON.parse(await fs.readFile(path.join(files,'metadata.json'),'utf8'));
  const cache=path.join(folder,'surface');
  const source={format:'glb',bindingVersion:2,reviewSource:path.join(folder,'model.glb'),baseImage:path.join(folder,'base.png'),
    bundle:path.join(cache,'guides'),cacheRun:path.join(cache,'cache'),material:meta.material,uvSha256:meta.uv_before,
    ...(meta.legacySurface===true?{preservedSurface:true}:{}),
    ...(meta.history?.length?{history:meta.history}:{}),files:{}};
  for(const file of glbRegistrationFiles(meta.legacySurface===true,meta.history))
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
