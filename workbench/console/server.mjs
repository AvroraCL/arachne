import {createPersonalLibrary} from './personal-library-store.mjs';
import {APP_VERSION,PACKAGE_VERSION} from './public/app-version.mjs';
import {saveProjectModel,preparePaintGeometry,modelGeometry,modelGeometryStatus,modelGeometryLog,stopModelGeometry} from './project-model.mjs';
import {PAINT,createPaint,editPaint,importPaint,livePaintInput,savePaintText,restorePaint,imageDocumentInput,checkPaintPreview} from './paint.mjs';
import {livePaint,stopLivePaint} from './paint-live.mjs';
import {cyclesDevices,stopCyclesDeviceProbe} from './blender-runtime.mjs';
import {resolvePaintRenderSettings} from './cycles-options.mjs';
import {renderSceneObjects,stopRenderSceneObjects} from './render-scene-objects.mjs';
import {cyclesViewRequest,renderCyclesView,stopPaintCyclesView} from './paint-cycles-view.mjs';
import {cyclesSessionFrame,interactiveCyclesAvailable,stopCyclesSessions,updateCyclesSession} from './paint-cycles-session.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const compressLive=promisify(gzip);
import {ROOT,DATA,list,read,commit,travel,projectHistory,projectDir} from './store.mjs';
import {setBaseUrl,getJob,listJobs,submit,retryJob,cancel,jobDir,mime,recover,stop} from './jobs.mjs';
import {workspaceRoot} from './workspace-paths.mjs';
import {demoProjectId} from './demo-source.mjs';
import {viewportManifest,startViewport,viewportFile,viewportTopology,viewportTopologyFile,stopViewport} from './viewport.mjs';

const personalLibrary=createPersonalLibrary({root:path.join(DATA,'personal-library'),readProject:read,projectFolder:projectDir,commitProject:commit});

const portArg=process.argv.indexOf('--port');const PORT=portArg<0?8766:Number(process.argv[portArg+1]);
if(!Number.isInteger(PORT)||PORT<1024||PORT>65535)throw Error('端口无效');
const local=`http://127.0.0.1:${PORT}`;setBaseUrl(local);
const lock=path.join(DATA,'server-lock.json');
if(fs.existsSync(lock)){
  const owner=JSON.parse(fs.readFileSync(lock,'utf8'));let alive=false;try{process.kill(owner.pid,0);alive=true;}catch{}
  if(alive)throw Error('已有控制台使用该数据目录：'+owner.url+'；请复用该服务');
}
fs.writeFileSync(lock,JSON.stringify({pid:process.pid,url:local}));
process.on('exit',()=>{try{if(JSON.parse(fs.readFileSync(lock,'utf8')).pid===process.pid)fs.unlinkSync(lock);}catch{}});
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){
  const decoder=new StringDecoder('utf8');
  let text='',bytes=0;
  for await(const part of req){
    bytes+=part.length;
    if(bytes>50*1024*1024)throw Object.assign(Error('请求过大'),{status:413});
    text+=decoder.write(part);
  }
  text+=decoder.end();
  return text?JSON.parse(text):{};
}
const maxPaintArchive=1024*1024*1024;
let importingPaintArchive=false;
async function receivePaintArchive(req){
  if(Number(req.headers['content-length'])>maxPaintArchive)
    throw Object.assign(Error('涂装交付包不能超过 1 GiB'),{status:413});
  if(importingPaintArchive)throw Object.assign(Error('已有涂装交付包正在导入'),{status:429});
  importingPaintArchive=true;
  let scratch;
  try{
    scratch=await fs.promises.mkdtemp(path.join(DATA,'.paint-import-'));
    const archive=path.join(scratch,'delivery.zip'),upload=await fs.promises.open(archive,'wx');
    try{
      let size=0;
      for await(const part of req.iterator({destroyOnReturn:false})){
        size+=part.length;
        if(size>maxPaintArchive)throw Object.assign(Error('涂装交付包不能超过 1 GiB'),{status:413});
        await upload.writeFile(part);
      }
    }finally{await upload.close();}
    return await restorePaint(archive,scratch);
  }finally{
    try{if(scratch)await fs.promises.rm(scratch,{recursive:true,force:true});}
    finally{importingPaintArchive=false;}
  }
}
function file(res,p){if(!fs.existsSync(p)||!fs.statSync(p).isFile()){send(res,404,{error:'文件不存在'});return;}res.writeHead(200,{'Content-Type':mime(p),'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});fs.createReadStream(p).pipe(res);}
async function verifyExportPreview(res,doc,previewId){
  if(!previewId)throw Error('缺少已确认的 4K 预览');
  if(res.destroyed)return false;
  const controller=new AbortController(),disconnect=()=>controller.abort();
  res.once('close',disconnect);
  try{
    await checkPaintPreview(doc,getJob(doc.id,previewId),{signal:controller.signal});
    return !res.destroyed;
  }finally{res.off('close',disconnect);}
}
const server=http.createServer(async(req,res)=>{
  try{
    if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(req.headers.host)){send(res,403,{error:'仅限本地访问'});return;}
    if(req.headers.origin&&![local,`http://localhost:${PORT}`].includes(req.headers.origin)){send(res,403,{error:'拒绝跨来源访问'});return;}
    const url=new URL(req.url,local);
    if(req.method==='POST'&&url.pathname==='/api/projects/paint-import'){
      if(req.headers['content-type']!=='application/zip'){send(res,415,{error:'请选择涂装交付 ZIP'});return;}
      send(res,201,await receivePaintArchive(req));return;
    }
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&!String(req.headers['content-type']).startsWith('application/json')){send(res,415,{error:'写操作需要JSON'});return;}
    const parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if(parts.some(p=>p==='..'||p==='.'||p.includes('/')||p.includes('\\')||p.includes('\0')))throw Error('路径无效');
    if(parts[0]!=='api'){
      if(url.pathname==='/license'&&req.method==='GET'){
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff'});
        res.end(fs.readFileSync(path.join(workspaceRoot,'LICENSE')));return;
      }
      if(['GET','HEAD'].includes(req.method)&&parts[0]==='fonts'&&parts.length===3&&
         parts.slice(1).every(p=>/^[\w.-]+$/.test(p))&&/\.(woff2?|txt|json)$/.test(parts[2])){
        file(res,path.join(ROOT,'public',...parts));return;
      }
      if(parts[0]==='vendor'&&parts[1]==='three'){
        const relative=parts.slice(2).join('/');
        if(!/^(build|examples\/jsm)\/[\w./-]+\.js$/.test(relative)){send(res,404,{error:'模块不存在'});return;}
        file(res,path.join(ROOT,'node_modules','three',relative));return;
      }
      if(url.pathname==='/'){
        const page='/paint.html';
        if(!url.searchParams.has('project')&&list().some(p=>p.id===demoProjectId))url.searchParams.set('project',demoProjectId);
        res.writeHead(302,{Location:page+url.search});res.end();return;
      }
      const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(!/^[\w.-]+$/.test(name)){send(res,404,{error:'页面不存在'});return;}
      file(res,path.join(ROOT,'public',name));return;
    }
    if(parts[1]==='personal-library'){
      if(req.method==='GET'&&parts.length===2){send(res,200,personalLibrary.read());return;}
      if(req.method==='GET'&&parts.length===5&&parts[3]==='assets'){file(res,personalLibrary.assetFile(parts[2],parts[4]));return;}
      if(req.method==='POST'&&parts.length===3&&['save','rename','remove'].includes(parts[2])){send(res,200,personalLibrary[parts[2]](await body(req)));return;}
      send(res,404,{error:'个人库操作不存在'});return;
    }
    if(parts[1]==='health'){send(res,200,{ok:true,version:APP_VERSION,packageVersion:PACKAGE_VERSION,product:'Arachne',localOnly:true,interactiveCycles:interactiveCyclesAvailable,...(process.env.ARACHNE_BUILD_ID?{buildId:process.env.ARACHNE_BUILD_ID}:{})});return;}
    if(parts[1]==='cycles-devices'&&parts.length===2&&req.method==='GET'){send(res,200,await cyclesDevices({refresh:url.searchParams.get('refresh')==='1'}));return;}
    if(parts[1]!=='projects'){send(res,404,{error:'接口不存在'});return;}
    if(parts.length===2){
      if(req.method==='GET')send(res,200,list());
      else if(req.method==='POST'){const b=await body(req);if(b.workflowType!==PAINT)throw Error('请选择涂装工程');const doc=await createPaint(b);send(res,201,doc);}
      else send(res,405,{error:'方法不支持'});return;
    }
    const id=parts[2];let doc=read(id);
    if(parts.length===3&&req.method==='GET'){send(res,200,doc);return;}
    const action=parts[3];
    if(action==='paint'&&doc.workflowType===PAINT){
      const operation=parts[4];
      if(req.method==='GET'&&operation==='guide'&&parts.length===6&&['silhouette','receiver','protected'].includes(parts[5])){
        file(res,path.join(doc.source.bundle,'top',parts[5]+'.png'));return;
      }
      if(req.method==='GET'&&operation==='assets'&&parts.length===6){
        const a=doc.paint.assets[parts[5]];if(!a)throw Error('涂装素材不存在');
        file(res,path.join(projectDir(id),'assets',a.file));return;
      }
      if(req.method==='GET'&&operation==='render-session'){
        const controller=new AbortController();
        const disconnect=()=>controller.abort();
        res.on('close',disconnect);
        try{
          const frame=await cyclesSessionFrame(id,url.searchParams.get('token'),Number(url.searchParams.get('after'))||0,controller.signal);
          if(res.destroyed)return;
          const headers={'Cache-Control':'no-store'};
          if(!frame){res.writeHead(204,headers);res.end();return;}
          res.writeHead(200,{...headers,'Content-Type':'image/png','Content-Length':frame.image.length,
            'X-Cycles-Sequence':String(frame.sequence),'X-Cycles-Frame':String(frame.number),'X-Cycles-Session':frame.session,
            'X-Cycles-Revision':String(frame.revision),'X-Cycles-Device':frame.device,
            'X-Cycles-Map-Resolution':String(frame.mapResolution),'X-Cycles-Sha256':frame.sha256});
          res.end(frame.image);
        }finally{res.off('close',disconnect);}
        return;
      }
      if(req.method==='GET'&&operation==='history'){send(res,200,projectHistory(id));return;}
      if(req.method==='GET'&&operation==='render-objects'){send(res,200,await renderSceneObjects(doc));return;}
      if(req.method==='GET'&&operation==='model-state'){send(res,200,modelGeometryStatus(doc));return;}
      if(req.method==='GET'&&operation==='model-log'){file(res,modelGeometryLog(doc,url.searchParams.get('binding')));return;}
      if(req.method==='GET'&&parts.length===4){send(res,200,{document:doc,jobs:listJobs(id)});return;}
      if(req.method!=='POST'){send(res,405,{error:'方法不支持'});return;}
      const b=await body(req);
      doc=read(id);
      if(operation==='render-session'){
        updateCyclesSession(doc,b,()=>listJobs(id));send(res,202,{accepted:true});return;
      }
      if(operation==='image-live'){
        if(b.revision!==doc.revision){res.writeHead(204,{'Cache-Control':'no-store'});res.end();return;}
        const input=imageDocumentInput(doc,b),controller=new AbortController();
        res.on('close',()=>{if(!res.writableEnded)controller.abort();});
        const pixels=await livePaint(input,{signal:controller.signal});
        if(res.destroyed)return;
        if(read(id).revision!==b.revision){res.writeHead(204);res.end();return;}
        res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Paint-Resolution':String(input.liveResolution),'X-Paint-Revision':String(b.revision)});res.end(pixels);return;
      }
      if(operation==='live'){
        if(b.revision!==doc.revision){res.writeHead(204,{'Cache-Control':'no-store'});res.end();return;}
        const input=livePaintInput(doc,b);
        const controller=new AbortController();
        const disconnect=()=>{if(!res.writableEnded)controller.abort();};
        res.on('close',disconnect);
        try{
          if(res.destroyed)return;
          const geometry=await preparePaintGeometry(doc,{signal:controller.signal});
          if(res.destroyed||controller.signal.aborted)return;
          if(read(id).revision!==b.revision){res.writeHead(204);res.end();return;}
          input.source=geometry.source;input.surfaceSources=geometry.surfaceSources;
          let pixels=await livePaint(input,{signal:controller.signal});
          if(res.destroyed)return;
          if(read(id).revision!==b.revision){res.writeHead(204,{'Cache-Control':'no-store'});res.end();return;}
          const headers={'Content-Type':'application/octet-stream','Cache-Control':'no-store',
            'X-Paint-Resolution':String(input.liveResolution),'X-Paint-Revision':String(b.revision)};
          if(input.liveResolution===4096&&/\bgzip\b/.test(req.headers['accept-encoding']||'')){
            pixels=await compressLive(pixels,{level:1});headers['Content-Encoding']='gzip';headers.Vary='Accept-Encoding';
          }
          if(res.destroyed)return;
          res.writeHead(200,headers);res.end(pixels);return;
        }finally{res.off('close',disconnect);}
      }
      if(b.revision!==doc.revision){send(res,409,{error:'工程修订已变化',currentRevision:doc.revision});return;}
      if(operation==='render-view'){
        const request=cyclesViewRequest(b),controller=new AbortController();
        const disconnect=()=>{if(!res.writableEnded)controller.abort();};
        res.on('close',disconnect);
        try{
          if(res.destroyed)return;
          const result=await renderCyclesView(doc,request,{signal:controller.signal,listBakes:()=>listJobs(id)});
          if(res.destroyed)return;
          if(!result||read(id).revision!==doc.revision){res.writeHead(204,{'Cache-Control':'no-store'});res.end();return;}
          res.writeHead(200,{'Content-Type':'image/png','Content-Length':result.image.length,'Cache-Control':'no-store','X-Cycles-Device':result.device,
            'X-Cycles-Revision':String(doc.revision),'X-Cycles-Map-Resolution':String(result.textureResolution),'X-Cycles-Model':result.model,'X-Cycles-Texture':result.texture,'X-Cycles-Sha256':result.sha256,
            ...(result.material?{'X-Cycles-Material':result.material}:{})});
          res.end(result.image);return;
        }finally{res.off('close',disconnect);}
      }
      if(operation==='library-import'){send(res,200,personalLibrary.importResource({projectId:id,projectRevision:b.revision,revision:b.libraryRevision,id:b.id}));return;}
      if(operation==='model-prepare'){void preparePaintGeometry(doc).catch(()=>{});send(res,202,modelGeometryStatus(doc));return;}
      if(operation==='model'){send(res,200,saveProjectModel(doc,b));return;}
      if(operation==='commands'){
        const changesRenderVisibility=Array.isArray(b.operations)&&b.operations.length<=128&&b.operations.some(op=>op?.op==='renderVisibility');
        const sourceVisibility=changesRenderVisibility?(await renderSceneObjects(doc)).visibility:undefined;
        send(res,200,editPaint(changesRenderVisibility?read(id):doc,b,sourceVisibility));
      }
      else if(operation==='assets')send(res,201,importPaint(doc,b));
      else if(operation==='text')send(res,201,await savePaintText(doc,b));
      else if(['undo','redo'].includes(operation))send(res,200,travel(id,b.revision,operation,b.steps));
      else if(operation==='preview'||operation==='draft')send(res,202,submit(id,operation==='draft'?'paint-draft':'paint-preview',b.revision,b.requestId));
      else if(operation==='backup')send(res,202,submit(id,'paint-backup',b.revision,b.requestId));
      else if(operation==='render'){
        const settings=resolvePaintRenderSettings(doc.paint,b);
        send(res,202,submit(id,'paint-render',b.revision,b.requestId,null,null,{settings}));
      }
      else if(operation==='render-cancel'){
        if(getJob(id,b.jobId).type!=='paint-render')throw Error('只能取消 Cycles 出图任务');
        send(res,200,await cancel(id,b.jobId));
      }
      else if(operation==='render-retry'){
        if(getJob(id,b.jobId).type!=='paint-render')throw Error('只能重试 Cycles 出图任务');
        send(res,202,retryJob(id,b.jobId,b.requestId));
      }
      else if(operation==='cancel')send(res,200,await cancel(id,b.jobId));
      else if(operation==='export-retry'){
        if(req.headers.origin!==local&&req.headers.origin!==`http://localhost:${PORT}`)throw Error('请在工作台重试交付');
        const previous=getJob(id,b.jobId);
        if(!['paint-export','paint-texture-export'].includes(previous.type))throw Error('只能重试涂装导出任务');
        if(previous.revision!==doc.revision)throw Object.assign(Error('工程修订已变化，请重新确认当前预览'),{status:409,currentRevision:doc.revision});
        if(await verifyExportPreview(res,doc,previous.paintPreviewId))send(res,202,retryJob(id,previous.id,b.requestId));
      }
      else if(operation==='export'||operation==='export-textures'){
        if(req.headers.origin!==local&&req.headers.origin!==`http://localhost:${PORT}`)throw Error('请在工作台确认交付');
        if(b.confirmed!==true)throw Error('请确认当前修订');
        if(await verifyExportPreview(res,doc,b.previewId)){
          const type=operation==='export-textures'?'paint-texture-export':'paint-export';
          send(res,202,submit(id,type,b.revision,b.requestId,null,null,b));
        }
      }else send(res,404,{error:'制作操作不存在'});
      return;
    }
    if(action==='viewport'){
      if(parts.length===4&&req.method==='GET'){send(res,200,viewportManifest(doc));return;}
      if(parts.length===4&&req.method==='POST'){await body(req);send(res,202,startViewport(doc));return;}
      if(parts[4]==='topology'&&doc.workflowType===PAINT){
        if(parts.length===5&&req.method==='GET'){send(res,200,viewportTopology(doc));return;}
        if(parts.length===5&&req.method==='POST'){await body(req);send(res,202,viewportTopology(doc,true));return;}
        if(parts.length===6&&parts[5]==='file'&&req.method==='GET'){file(res,viewportTopologyFile(doc));return;}
      }
      if(parts.length===5&&parts[4]==='base'&&req.method==='GET'){file(res,doc.source.baseImage);return;}
      if(parts.length===6&&parts[4]==='files'&&req.method==='GET'){file(res,viewportFile(doc,parts[5]));return;}
      send(res,404,{error:'三维接口不存在'});return;
    }
    if(action==='jobs'){
      if(parts.length===4&&req.method==='GET'){send(res,200,listJobs(id));return;}
      const jid=parts[4];const j=getJob(id,jid);
      if(parts.length===5&&req.method==='GET'){send(res,200,j);return;}
      if(parts[5]==='cancel'&&req.method==='POST'){await body(req);send(res,200,await cancel(id,jid));return;}
      if(parts[5]==='snapshot'&&req.method==='GET'){file(res,path.join(jobDir(id,jid),'snapshot.json'));return;}
      if(parts[5]==='files'&&req.method==='GET'){
        const rest=parts.slice(6);if(!rest.length||rest.some(s=>!/^[-\w.]+$/.test(s)))throw Error('产物路径无效');
        file(res,path.join(jobDir(id,jid),...rest));return;
      }
    }
    send(res,404,{error:'接口不存在'});
  }catch(e){
    if(res.destroyed||res.writableEnded)return;
    const detail=e.status===409&&Number.isInteger(e.currentRevision)?{currentRevision:e.currentRevision}:{};
    send(res,e.status||((e.code==='ENOENT')?404:400),{error:e.message,...detail});
  }
});

recover();
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'端口被占用，请使用 --port 更换；未终止其他服务':e);process.exitCode=1;});
server.listen(PORT,'127.0.0.1',()=>console.log(`阿拉克涅 Web 控制台 ${local}\n仅本机 · 数据保存在 ${DATA}`));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{server.close();stopCyclesDeviceProbe();stopRenderSceneObjects();const previewStop=stopPaintCyclesView(),interactiveStop=stopCyclesSessions();stopLivePaint();stopViewport();stopModelGeometry();await Promise.all([stop(),previewStop,interactiveStop]);process.exit(0);});
