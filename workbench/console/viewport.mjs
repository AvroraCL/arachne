import {blenderExecutable,blenderScriptArgs} from './blender-runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,DATA,hash,atomic} from './store.mjs';
import {pythonExecutable} from './python-runtime.mjs';
import {listJobs} from './jobs.mjs';

const work=new Map();
const exporter=path.join(ROOT,'viewport_export.py');
const topologyExporter=path.join(ROOT,'model_topology.py');
const fingerprintCache=new Map();
function fingerprint(file){const st=fs.statSync(file),key=file+':'+st.size+':'+st.mtimeMs;if(!fingerprintCache.has(key))fingerprintCache.set(key,hash(file));return fingerprintCache.get(key);}
function location(doc){
  if(doc.source.format==='glb'){
    const dir=path.dirname(doc.source.reviewSource);
    return {dir,key:doc.source.files[doc.source.reviewSource].slice(0,32)};
  }
  const key=crypto.createHash('sha256').update(JSON.stringify([fingerprint(doc.source.reviewSource),fingerprint(exporter),doc.source.material])).digest('hex').slice(0,32);return {key,dir:path.join(DATA,'viewport',key)};}
export function viewportManifest(doc){
  const {key,dir}=location(doc);const state=work.get(key);
  const metadataFile=path.join(dir,'metadata.json');
  const ready=fs.existsSync(metadataFile)&&fs.existsSync(path.join(dir,'model.glb'));
  const baked=listJobs(doc.id).find(j=>j.status==='completed'&&j.colorUrl);
  let topUp=[0,0,-1];
  try{const u=JSON.parse(fs.readFileSync(path.join(doc.source.bundle,'cameras.json'),'utf8')).views.top.up;const flip=JSON.parse(fs.readFileSync(path.join(doc.source.bundle,'resolved_config.json'),'utf8')).designs.top.flip_v?-1:1;topUp=[u[0]*flip,u[2]*flip,-u[1]*flip];}catch{}
  return {status:ready?'ready':state?.status||'idle',error:state?.error,projectId:doc.id,revision:doc.revision,key,modelUrl:`/api/projects/${doc.id}/viewport/files/model.glb?key=${key}`,modelSha256:ready?fingerprint(path.join(dir,'model.glb')):null,metadata:ready?JSON.parse(fs.readFileSync(metadataFile,'utf8')):null,targetMaterial:doc.source.material,topUp,materialUrls:baked?.materialUrls||null,activeChannels:baked?.paintReport?.activeChannels,textureUrl:baked?.colorUrl||`/api/projects/${doc.id}/viewport/base`,textureRevision:baked?.revision??null,textureLabel:baked?`已烘焙贴图 · r${baked.revision}`:'原始 UV 贴图',textureCurrent:Boolean(baked&&baked.revision===doc.revision)};
}
function launch(key,worker,config,logFile,ready,failure,native=false){
  const state={status:'running',error:null,child:null};work.set(key,state);
  const log=fs.createWriteStream(logFile);
  const child=spawn(native?pythonExecutable():blenderExecutable(),native?['-X','utf8',worker,'topology',config]:blenderScriptArgs(worker,[config],{factory:false}),
    {cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']});
  state.child=child;
  log.on('error',error=>{state.error=error.message;child.kill();});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  const timer=setTimeout(()=>{state.error='模型准备超时，请查看本机日志';child.kill();},180000);
  child.on('error',error=>{state.status='failed';state.error=error.message;});
  child.on('close',code=>{
    clearTimeout(timer);state.child=null;
    state.status=code===0&&ready()?'ready':'failed';
    if(state.status==='failed')state.error||=failure;
    log.end();
  });
}
export function startViewport(doc){
  const manifest=viewportManifest(doc);if(['ready','running'].includes(manifest.status))return manifest;
  if(doc.source.format==='glb')throw Error('已登记的 GLB 文件缺失');
  if(doc.workflowType==='pbr_paint'&&/\.blend$/i.test(doc.source.reviewSource))
    return {...manifest,status:'migration-required',error:'旧工程没有视口 GLB。请使用「文件 → 迁移为 GLB 工程」继续。'};
  const {key,dir}=location(doc);fs.mkdirSync(dir,{recursive:true});
  const config=path.join(dir,'input.json');atomic(config,{source:doc.source.reviewSource,material:doc.source.material,out:dir});
  launch(key,exporter,config,path.join(dir,'export.log'),
    ()=>fs.existsSync(path.join(dir,'metadata.json'))&&fs.existsSync(path.join(dir,'model.glb')),
    '三维模型准备失败，请查看本地导出日志');
  return {...manifest,status:'running'};
}
function topologyLocation(doc){
  const {key,dir}=location(doc);
  const baseline=path.join(dir,'model.glb');
  if(!fs.existsSync(baseline)||!fs.existsSync(path.join(dir,'metadata.json')))return null;
  const modelSha256=fingerprint(baseline);
  if(doc.source.format==='glb')return {key:key+'/topology',dir,tag:'topology',baseline,modelSha256,out:path.join(dir,'topology.json')};
  const version=crypto.createHash('sha256').update(JSON.stringify([modelSha256,fingerprint(topologyExporter)])).digest('hex').slice(0,20);
  const tag='topology-'+version;
  return {key:key+'/'+tag,dir,tag,baseline,modelSha256,out:path.join(dir,tag+'.json')};
}
export function viewportTopology(doc,start=false){
  const item=topologyLocation(doc);
  if(!item)return {status:'waiting'};
  const {key,dir,tag,baseline,modelSha256,out}=item;
  if(fs.existsSync(out))return {status:'ready',url:'/api/projects/'+doc.id+'/viewport/topology/file'};
  const state=work.get(key);
  if(!start||state?.status==='running')return {status:state?.status||'idle',error:state?.error};
  const config=path.join(dir,tag+'-input.json');
  atomic(config,{source:doc.source.reviewSource,baseline,modelSha256,out});
  const native=doc.source.format==='glb';
  launch(key,native?path.join(ROOT,'model_surface.py'):topologyExporter,config,path.join(dir,tag+'.log'),()=>fs.existsSync(out),'原拓扑准备失败，请查看本地日志',native);
  return {status:'running'};
}
export function viewportTopologyFile(doc){
  const item=topologyLocation(doc);
  if(!item||!fs.existsSync(item.out))throw Object.assign(Error('原拓扑尚未准备'),{status:404});
  return item.out;
}
export function stopViewport(){for(const state of work.values())state.child?.kill();}
export function viewportFile(doc,name){if(!['model.glb','metadata.json'].includes(name))throw Error('三维文件不存在');return path.join(location(doc).dir,name);}

export function registeredViewportModel(doc){
  const {dir}=location(doc);
  const file=path.join(dir,'model.glb'),metadata=path.join(dir,'metadata.json');
  if(!fs.existsSync(file)||!fs.existsSync(metadata))throw Error('请先打开三维视口，准备登记模型');
  const meta=JSON.parse(fs.readFileSync(metadata,'utf8'));
  if(meta.source_sha256!==doc.source.files[doc.source.reviewSource]||meta.uv_unchanged!==true||
     !/^[a-f0-9]{64}$/.test(meta.uv_before)||meta.uv_before!==meta.uv_after)
    throw Error('三维模型与登记的原 UV 不一致');
  return {file,sha256:hash(file),uvSha256:meta.uv_before,metadata:meta};
}
