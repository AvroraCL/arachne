import {blenderExecutable,blenderScriptArgs} from './blender-runtime.mjs';
import {pythonExecutable} from './python-runtime.mjs';
import {registeredViewportModel,viewportManifest} from './viewport.mjs';
import {pinSurfaceInputs} from './paint-surface-bindings.mjs';
import {modelFingerprint,validateModelState,nativeModelSteps} from './model-binding.mjs';
export {modelFingerprint,validateModelState,nativeModelSteps} from './model-binding.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,DATA,atomic,hash,commit,read} from './store.mjs';
import {createGeometryQueue,waitForGeometry} from './geometry-queue.mjs';

const builds=new Map(),verified=new Map(),buildQueue=createGeometryQueue();
function verifyFile(file,expected){
  const stat=fs.statSync(file),key=[stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,expected].join(':');
  if(verified.get(file)===key)return;
  if(hash(file)!==expected)throw Error('建模缓存文件指纹变化');
  verified.set(file,key);
}
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid=()=>{throw Error('建模命令或模型绑定无效');};
export function saveProjectModel(doc,{revision,modeling}){
  if(revision!==doc.revision)throw Object.assign(Error('工程修订已变化'),{status:409,currentRevision:doc.revision});
  validateModelState(modeling);
  const model=registeredViewportModel(doc),folder=path.dirname(model.file);
  if(viewportManifest(doc).key!==modeling.binding||model.sha256!==modeling.modelSha256)invalid();
  const bytes=fs.readFileSync(model.file),glb=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
  let topology;
  if(modeling.steps.some(step=>step.targets.some(target=>target.mesh!==undefined))){
    for(const name of fs.readdirSync(folder).filter(name=>name==='topology.json'||/^topology-[a-f0-9]+\.json$/.test(name))){
      const value=JSON.parse(fs.readFileSync(path.join(folder,name),'utf8'));
      if(value.modelSha256===modeling.modelSha256){topology=value;break;}
    }
  }
  const expected=nativeModelSteps(glb,modeling.steps,topology);
  if(JSON.stringify(expected)!==JSON.stringify(modeling.nativeSteps))invalid();
  return commit(doc.id,revision,next=>{pinSurfaceInputs(next);next.modeling=structuredClone(modeling);return next;},[{op:'model',steps:modeling.steps.length}]);
}
function location(doc,legacyScene){
  const fingerprint=modelFingerprint(doc),native=doc.source.format==='glb';
  if(!fingerprint&&(!native||doc.source.preservedSurface))return null;
  if(!fingerprint){
    const folder=path.dirname(doc.source.cacheRun);
    return {key:folder,folder,fingerprint};
  }
  const scripts=legacyScene?['project_model.py','../tools/geometry.py','../tools/prepare_guides.py']:
    ['model_glb.py','model_surface.py'];
  const version=[...scripts,'native_worker_lock.py','../tools/guide_raster.py','../tools/projection_scope.py',
    '../tools/uv_raster.py','../tools/view_select.py'].map(file=>hash(path.join(ROOT,file)));
  const key=digest([doc.source.material,Object.entries(doc.source.files),fingerprint,version]);
  return {key,folder:path.join(DATA,'model-geometry',key),fingerprint};
}
export function modelGeometry(doc,{legacyScene=false}={}){
  const item=location(doc,legacyScene);if(!item)return {source:doc.source,status:'ready'};
  const state=builds.get(item.key);
  if(state?.status==='queued')return {...item,status:'queued',stage:state.stage};
  const reportFile=path.join(item.folder,'report.json');
  if(!fs.existsSync(reportFile))
    return {...item,status:state&&state.status!=='ready'?state.status:'idle',error:state?.error};
  try{
    const report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
    if(report.modelFingerprint!==item.fingerprint||report.sourceSha256!==doc.source.files[doc.source.reviewSource]||!report.uvUnchanged)
      throw Error('建模缓存的修订或 UV 指纹不一致');
    for(const [file,expected] of Object.entries(report.files))verifyFile(path.join(item.folder,file),expected);
    const source={...doc.source,...(legacyScene?{reviewSource:path.join(item.folder,'model.blend')}:{}),cacheRun:path.join(item.folder,'cache'),bundle:path.join(item.folder,'guides')};
    return {...item,status:'ready',stage:'模型表面已就绪',source,report};
  }catch(error){return {...item,status:'failed',error:error.message,invalid:true};}
}
function referenceDocuments(doc){
  return Object.entries(doc.paint?.surfaceBindings||{}).filter(([,state])=>state!==null)
    .map(([key,state])=>[key,{...doc,modeling:state}]);
}
export function modelGeometryStatus(doc){
  const current=modelGeometry(doc);
  let result=current,reference=null;
  if(current.status==='ready')for(const [key,snapshot] of referenceDocuments(doc)){
    const pending=modelGeometry(snapshot);
    if(pending.status!=='ready'){result=pending;reference=key;break;}
  }
  const state=builds.get(result.key);
  return {revision:doc.revision,fingerprint:current.fingerprint||null,status:result.status,
    stage:reference?'恢复绘制表面 · '+(result.stage||state?.stage||'准备中'):result.stage||state?.stage,error:result.error,
    logUrl:result.folder&&fs.existsSync(path.join(result.folder,'build.log'))?`/api/projects/${doc.id}/paint/model-log`+(reference?'?binding='+reference:''):null};
}
export function modelGeometryLog(doc,binding){
  let snapshot=doc;
  if(binding){const entry=referenceDocuments(doc).find(([key])=>key===binding);if(!entry)throw Error('绘制表面版本不存在');snapshot=entry[1];}
  const result=modelGeometry(snapshot);if(!result.folder)throw Error('当前模型没有准备日志');
  return path.join(result.folder,'build.log');
}
export async function preparePaintGeometry(doc,options={}){
  if(options.legacyScene&&doc.source.format==='glb')throw Error('GLB 工程支持路径追踪出图、GLB 和贴图导出');
  const baseline=doc.source.format==='glb'?await prepareModelGeometry({...doc,modeling:undefined},{...options,frozen:true}):null;
  const current=baseline&&!modelFingerprint(doc)?baseline:await prepareModelGeometry(doc,options),surfaceSources={};
  const entry=(key,source)=>({source,bindingFingerprint:digest([doc.source.files,key])});
  surfaceSources.original=entry('original',baseline?.source||doc.source);
  if(modelFingerprint(doc))surfaceSources[modelFingerprint(doc)]=entry(modelFingerprint(doc),current.source);
  await Promise.all(referenceDocuments(doc).map(async([key,snapshot])=>{
    if(surfaceSources[key])return;
    const ready=await prepareModelGeometry(snapshot,{...options,frozen:true});
    surfaceSources[key]=entry(key,ready.source);
  }));
  return {...current,surfaceSources};
}
export function prepareModelGeometry(doc,{signal,frozen=false,legacyScene=false}={}){
  if(signal?.aborted)return waitForGeometry(Promise.resolve(),signal);
  const ready=modelGeometry(doc,{legacyScene});if(ready.status==='ready')return Promise.resolve(ready);
  const previous=builds.get(ready.key);
  if(['queued','running'].includes(previous?.status)){
    previous.frozen||=frozen;
    return waitForGeometry(previous.promise,signal);
  }
  const state={status:'queued',stage:'等待模型表面准备',frozen,controller:new AbortController()};builds.set(ready.key,state);
  state.promise=buildQueue.submit(async()=>{
    if(!state.frozen&&modelFingerprint(read(doc.id))!==ready.fingerprint)
      throw Object.assign(Error('模型已经更新，跳过旧表面准备'),{status:409,cancelled:true});
    state.status='running';state.stage='保存模型副本';
    fs.mkdirSync(ready.folder,{recursive:true});
    const requests=path.join(DATA,'model-builds');fs.mkdirSync(requests,{recursive:true});
    // A restarted server must never replace a still-starting worker's input.
    const cfg=path.join(requests,crypto.randomUUID()+'.json');
    const model=legacyScene?null:registeredViewportModel(doc);
    if(model&&doc.modeling&&model.sha256!==doc.modeling.modelSha256)invalid();
    atomic(cfg,{source:doc.source,modeling:doc.modeling??null,out:ready.folder,modelFingerprint:ready.fingerprint,ownerPid:process.pid,
      ...(model?{model:model.file,modelSha256:model.sha256}:{})});
    return new Promise((resolve,reject)=>{
      const log=fs.createWriteStream(path.join(ready.folder,'build.log'));
      const child=spawn(legacyScene?blenderExecutable():pythonExecutable(),
        legacyScene?blenderScriptArgs(path.join(ROOT,'project_model.py'),[cfg]):
          ['-X','utf8',path.join(ROOT,'model_surface.py'),'rebuild',cfg],
        {cwd:ROOT,stdio:['ignore','pipe','pipe'],windowsHide:true});
      state.child=child;child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
      let partial='';
      child.stdout.on('data',data=>{
        const lines=(partial+data.toString()).split(/\r?\n/);partial=lines.pop();
        for(const line of lines)if(line.startsWith('ARACHNE_MODEL_STAGE ')){
          try{const value=JSON.parse(line.slice(20));if(typeof value.stage==='string')state.stage=value.stage;}catch{}
        }
      });
      const abort=()=>child.kill();state.controller.signal.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(()=>{state.timeout=true;child.kill();},20*60*1000);
      log.on('error',error=>{child.kill();reject(error);});
      child.on('error',reject);
      child.on('close',code=>{
        fs.rmSync(cfg,{force:true});
        clearTimeout(timer);state.controller.signal.removeEventListener('abort',abort);log.end();state.child=null;
        if(code!==0){reject(Error(state.timeout?'模型表面准备超时，可重试':'模型表面准备失败，请查看建模日志后重试'));return;}
        try{const result=modelGeometry(doc,{legacyScene});if(result.status!=='ready')throw Error(result.error||'模型表面准备未完成');state.status='ready';state.stage=result.stage;resolve(result);}
        catch(error){reject(error);}
      });
    });
  },state.controller.signal).catch(error=>{
    state.status=error.cancelled?'cancelled':'failed';state.error=error.message;throw error;
  });
  return waitForGeometry(state.promise,signal);
}
export function stopModelGeometry(){buildQueue.close();for(const state of builds.values())state.controller?.abort();}
