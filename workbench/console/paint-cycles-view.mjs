import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {rmSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {ROOT,read} from './store.mjs';
import {paintInput,paintBakeFingerprint,verifyPaint,verifyPaintBake,renderChannels,nativePaintMaterial,reusablePaintBake,pngSizeIs} from './paint.mjs';
import {preparePaintGeometry} from './project-model.mjs';
import {cyclesOptions} from './cycles-options.mjs';
import {blenderExecutable,blenderScriptArgs} from './blender-runtime.mjs';
import {createGeometryQueue} from './geometry-queue.mjs';
import {matchesRenderAppearance} from './public/render-appearance.mjs';
import {cyclesResource} from './cycles-resource.mjs';
import {minCyclesViewportDimension,cyclesViewportLimits as profiles} from './public/cycles-limits.mjs';
import {matchesCyclesLightPaths} from './public/cycles-light-paths.mjs';
import {matchesRenderOptics} from './public/render-optics.mjs';

const activeRequests=new Map(),queue=createGeometryQueue(),cache=new Map();
const limit=4,cacheLimit=3;
let directory=null,closing=false;
const cancelled=()=>Object.assign(Error('Cycles 视口渲染已取消'),{name:'AbortError'});
const ensureRunning=signal=>{if(signal.aborted)throw cancelled();};
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

export function cyclesViewRequest(raw){
  const quality=raw.quality??'draft';
  if(typeof quality!=='string'||!Object.hasOwn(profiles,quality))throw Error('Cycles 视口质量无效');
  const profile=profiles[quality];
  const settings=cyclesOptions(raw.settings,{minDimension:minCyclesViewportDimension}),hiddenObjects=raw.hiddenObjects??[];
  if(!settings.camera||settings.width>profile.pixels||settings.height>profile.pixels||settings.samples>profile.samples||settings.textureJobId!==null||settings.fileFormat==='OPEN_EXR'||settings.bitDepth===16||settings.renderPasses?.length||
     !Array.isArray(hiddenObjects)||hiddenObjects.length>4096||hiddenObjects.some(name=>typeof name!=='string'||!name||name.length>256))
    throw Error(`Cycles 视口需要当前相机，画面最大 ${profile.pixels} 像素、${profile.samples} 次采样，使用 8 位 PNG`);
  return {quality,settings:{...settings,bitDepth:8},hiddenObjects:[...new Set(hiddenObjects)].sort()};
}

function run(exe,args,signal){
  ensureRunning(signal);
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,PYTHONUTF8:'1',OPENBLAS_NUM_THREADS:'1',ARACHNE_NATIVE_PARENT_PID:String(process.pid)}});
    let detail='',error=null,killTimer;
    for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{detail=(detail+bytes.toString()).slice(-2400);});
    function stop(reason){
      if(error)return;
      error=reason;child.kill();
      killTimer=setTimeout(()=>child.kill('SIGKILL'),1500).unref();
    }
    const abort=()=>stop(cancelled()),timer=setTimeout(()=>stop(Error('Cycles 视口更新超时，请重试')),90000).unref();
    signal.addEventListener('abort',abort,{once:true});
    child.once('error',failure=>{error??=failure.code==='ENOENT'?Error('未找到 Blender 或贴图合成工具，请检查本机运行环境'):failure;});
    child.once('close',code=>{
      clearTimeout(timer);clearTimeout(killTimer);signal.removeEventListener('abort',abort);
      if(error||code!==0)reject(error||Error(detail.split(/\r?\n/).findLast(line=>/^\w+Error: /.test(line))?.replace(/^\w+Error: /,'')||'Cycles 视口渲染失败，请重试'));
      else resolve();
    });
  });
}

async function stageDocument(doc,quality,signal,listBakes){
  const fingerprint=paintBakeFingerprint(doc),key=doc.id+':'+fingerprint+':'+quality,prior=cache.get(key);
  if(prior){cache.delete(key);cache.set(key,prior);return prior;}
  const binding=await verifyPaint(doc,{signal}),geometry=await preparePaintGeometry(doc,{signal,legacyScene:true});
  ensureRunning(signal);
  let owned=null,report,out,nodeMaterial;
  if(quality==='detail'){
    const reused=await reusablePaintBake(doc,listBakes?.()||[],fingerprint,{binding,signal});
    if(reused){report=reused.report;out=reused.folder;nodeMaterial=reused.nodeMaterial;}
  }
  try{
    if(!report){
      owned=await fs.mkdtemp(path.join(directory,'material-'));out=path.join(owned,'paint');
      const input=path.join(owned,'input.json'),draft=quality==='draft';
      await fs.writeFile(input,JSON.stringify({...paintInput(doc,binding),source:geometry.source,surfaceSources:geometry.surfaceSources,out,draft,renderView:true,bakeFingerprint:fingerprint}));
      await run(process.env.ARACHNE_PYTHON||'python',['-X','utf8',path.join(ROOT,'paint_worker.py'),input],signal);
      report=JSON.parse(await fs.readFile(path.join(out,'report.json'),'utf8'));
      await verifyPaintBake(doc,report,out,{draft,binding,signal});
      nodeMaterial=await nativePaintMaterial(doc,report,out,{signal});
    }
    ensureRunning(signal);
    const color=path.join(out,'f_16xl_BaseColor.png');
    const stage={owned,source:geometry.source,sourceHash:geometry.report?.modelSha256||doc.source.files[doc.source.reviewSource],
      color,channels:renderChannels(report,out),nodeMaterial,
      texture:{kind:'paint',roundId:key,sha256:report.files['f_16xl_BaseColor.png']}};
    cache.set(key,stage);
    await trimCache(key);
    return stage;
  }catch(error){
    if(owned)await fs.rm(owned,{recursive:true,force:true});
    throw error;
  }
}

async function trimCache(exclude){
  while(cache.size>cacheLimit){
    const entry=[...cache.entries()].find(([key,value])=>key!==exclude&&!value.users);
    if(!entry)return;
    const [key,value]=entry;cache.delete(key);
    if(value.owned)await fs.rm(value.owned,{recursive:true,force:true});
  }
}

export function leaseCyclesViewMaterial(doc,quality,{signal,listBakes}){
  return queue.submit(()=>cyclesResource.run('preview',async()=>{
    directory??=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-cycles-view-'));
    const stage=await stageDocument(doc,quality,signal,listBakes);
    stage.users=(stage.users||0)+1;
    return {stage,release(){stage.users--;}};
  },{signal}),signal,{priority:1});
}

async function render(doc,{settings,hiddenObjects,quality},signal,listBakes){
  ensureRunning(signal);
  if(read(doc.id).revision!==doc.revision)return null;
  directory??=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-cycles-view-'));
  const staged=await stageDocument(doc,quality,signal,listBakes);ensureRunning(signal);
  if(read(doc.id).revision!==doc.revision)return null;
  const folder=await fs.mkdtemp(path.join(directory,'frame-')),out=path.join(folder,'result');
  try{
    const input=path.join(folder,'input.json');
    const {source,sourceHash,color,channels,nodeMaterial,texture}=staged;
    const renderAppearance=doc.paint.renderAppearance||null,renderLighting=doc.paint.renderLighting||null,renderOptics=doc.paint.renderOptics||null;
    const renderVisibility=doc.paint.renderVisibility||null,hidden=new Set(hiddenObjects);
    const effectiveVisibility=Object.fromEntries(Object.entries(renderVisibility||{}).map(([name,visible])=>[name,visible&&!hidden.has(name)]));
    await fs.writeFile(input,JSON.stringify({source,sourceSha256:sourceHash,color,channels,nodeMaterial,out,revision:doc.revision,settings,renderAppearance,renderLighting,renderVisibility,renderOptics,texture,hiddenObjects}));
    await run(blenderExecutable(),blenderScriptArgs(path.join(ROOT,'cycles_render.py'),[input]),signal);
    const [image,report]=await Promise.all([fs.readFile(path.join(out,'cycles.png')),fs.readFile(path.join(out,'validation.json'),'utf8').then(JSON.parse)]);
    if(report.engine!=='CYCLES'||report.document_revision!==doc.revision||report.source_sha256!==sourceHash||
       report.uv_unchanged!==true||report.source_saved!==false||!isDeepStrictEqual(report.texture,texture)||
       !isDeepStrictEqual(report.camera,settings.camera)||!pngSizeIs(image,settings.width,settings.height)||
       !isDeepStrictEqual(report.hidden_objects,hiddenObjects)||report.samples!==settings.samples||
       report.denoising!==(settings.denoise??true)||
       (settings.adaptive!==undefined&&report.render_effective?.adaptive!==settings.adaptive)||
       (settings.noiseThreshold!==undefined&&!(Math.abs(report.render_effective?.noiseThreshold-settings.noiseThreshold)<=1e-6))||
       (settings.lightPaths&&!matchesCyclesLightPaths(settings.lightPaths,report.render_effective?.lightPaths))||
       (nodeMaterial&&report.nodeMaterial?.fingerprint!==nodeMaterial.fingerprint)||
       !matchesRenderAppearance(renderAppearance,report.render_effective?.colorManagement)||
       !isDeepStrictEqual(report.lighting?.options??null,renderLighting)||
       !isDeepStrictEqual(report.render_visibility||{},effectiveVisibility)||
       !matchesRenderOptics(renderOptics,report.camera_framing?.optics)||
       (settings.device==='cpu'&&report.device!=='CPU')||(settings.device==='gpu'&&report.device==='CPU')||
       Object.entries(channels).some(([key,value])=>report.channels?.[key]?.sha256!==value.sha256||report.channels[key].applied!==value.enabled))
      throw Error('Cycles 视口画面与当前模型、材质或相机不一致');
    ensureRunning(signal);
    return {image,device:report.device,model:report.source_sha256,texture:texture.sha256,sha256:digest(image),
      textureResolution:profiles[quality].size,material:report.nodeMaterial?.fingerprint||null};
  }finally{await fs.rm(folder,{recursive:true,force:true});}
}

export async function renderCyclesView(doc,request,{signal,listBakes}={}){
  if(closing||signal?.aborted)throw cancelled();
  if(activeRequests.size>=limit)throw Object.assign(Error('Cycles 视口忙，请稍后重试'),{status:503});
  const controller=new AbortController(),abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  const task=queue.submit(()=>cyclesResource.run('preview',()=>render(doc,request,controller.signal,listBakes),{signal:controller.signal}),
    controller.signal,{priority:request.quality==='draft'?1:0});
  activeRequests.set(controller,task);
  try{return await task;}
  finally{activeRequests.delete(controller);signal?.removeEventListener('abort',abort);}
}

export function stopPaintCyclesView(){
  closing=true;queue.close();
  for(const controller of activeRequests.keys())controller.abort();
  return Promise.allSettled(activeRequests.values());
}

process.on('exit',()=>{
  if(directory){try{rmSync(directory,{recursive:true,force:true});}catch{}}
});
