import {PAINT,runPaintJob,paintPreviewFolder} from './paint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {ROOT,projectDir,read,list,atomic} from './store.mjs';
import {pathTraceOptions} from './path-trace-render.mjs';
import {cyclesResource} from './cycles-resource.mjs';
import {renderBookmarkLimit} from './public/paint-delivery-options.mjs';

const PYTHON=process.env.ARACHNE_PYTHON||'python';
export const paintExportTypes=['paint-export','paint-texture-export','paint-glb-export'];
let baseUrl='',running=false,generation=0;
const queue=[],active=new Map();
export const setBaseUrl=url=>{baseUrl=url;};
export const jobUpdates=()=>generation;
const safe=id=>{if(!/^[\w-]+$/.test(id))throw Error('任务ID无效');return id;};
export const jobDir=(pid,jid)=>path.join(projectDir(pid),'jobs',safe(jid));
export const getJob=(pid,jid)=>JSON.parse(fs.readFileSync(path.join(jobDir(pid,jid),'job.json'),'utf8'));
export function listJobs(pid){const dir=path.join(projectDir(pid),'jobs');return fs.existsSync(dir)?fs.readdirSync(dir).filter(j=>fs.existsSync(path.join(dir,j,'job.json'))).map(j=>getJob(pid,j)).sort((a,b)=>b.created.localeCompare(a.created)):[];}
export function readJobLog(pid,jid){
  const file=path.join(jobDir(pid,jid),'run.log');
  let fd;
  try{fd=fs.openSync(file,'r');}
  catch(error){if(error.code==='ENOENT')return {jobId:jid,text:'',truncated:false};throw error;}
  try{
    const size=fs.fstatSync(fd).size,offset=Math.max(0,size-32768),buffer=Buffer.alloc(size-offset);
    const bytes=fs.readSync(fd,buffer,0,buffer.length,offset);
    let text=buffer.toString('utf8',0,bytes);
    const line=text.indexOf('\n');
    if(offset&&line>=0)text=text.slice(line+1);
    return {jobId:jid,text,truncated:offset>0};
  }finally{fs.closeSync(fd);}
}
function update(j,patch){
  Object.assign(j,patch,{updated:new Date().toISOString()});
  atomic(path.join(jobDir(j.projectId,j.id),'job.json'),j);
  generation++;
}
const fileUrl=(j,name)=>`/api/projects/${j.projectId}/jobs/${j.id}/files/${name}`;
function cancelled(j){if(j.cancelRequested){const e=Error('任务已取消');e.cancelled=true;throw e;}}
function log(j,text){fs.appendFileSync(path.join(jobDir(j.projectId,j.id),'run.log'),text);}
function stage(j,message){cancelled(j);update(j,{stage:message});log(j,'\n'+message+'\n');}

export function runProcess(j,exe,args,{onLine}={}){
  cancelled(j);
  return new Promise((resolve,reject)=>{
    const env={...process.env,PYTHONUTF8:'1',ARACHNE_NATIVE_PARENT_PID:String(process.pid),...(exe===PYTHON?{PYTHONPATH:[path.join(ROOT,'vendor'),process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)}:{})};
    const child=spawn(exe,args,{cwd:ROOT,windowsHide:true,shell:false,env});
    if(!active.has(j.id))active.set(j.id,{});active.get(j.id).child=child;
    const decoder=new StringDecoder('utf8');
    let pendingLine='';
    child.stdout.on('data',b=>{
      const output=decoder.write(b);log(j,output);
      if(!onLine)return;
      const lines=(pendingLine+output).split(/\r?\n/);pendingLine=lines.pop();
      if(pendingLine.length>65536)pendingLine='';
      for(const line of lines)onLine(line);
    });
    child.stderr.on('data',b=>log(j,b.toString()));
    child.on('error',reject);child.on('close',code=>{const tail=decoder.end();if(tail)log(j,tail);if(onLine&&pendingLine+tail)onLine(pendingLine+tail);const a=active.get(j.id);if(a?.child===child)delete a.child;
      if(j.cancelRequested){const e=Error('任务已取消');e.cancelled=true;reject(e);}else if(code!==0)reject(Error('工具执行失败，请查看运行日志'));else resolve();});
  });
}
export function mime(name){return ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.otf':'font/otf','.ttc':'font/collection','.json':'application/json','.html':'text/html','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript','.log':'text/plain','.glb':'model/gltf-binary'})[path.extname(name).toLowerCase()]||'application/octet-stream';}
function queuedJob(doc,type,requestId,retryOf=null,task=null){
  return {id:crypto.randomUUID(),projectId:doc.id,type,revision:doc.revision,retryOf,requestId:requestId||null,
    task:task?{labId:task.labId,taskId:task.taskId,attemptId:task.attemptId}:null,status:'queued',stage:'等待执行',created:new Date().toISOString()};
}
function enqueue(doc,items){
  const created=[];
  let snapshot=null;
  fs.mkdirSync(path.join(projectDir(doc.id),'jobs'),{recursive:true});
  try{
    for(const job of items){
      const folder=jobDir(doc.id,job.id);
      fs.mkdirSync(folder);
      created.push(folder);
      const file=path.join(folder,'snapshot.json');
      if(snapshot){
        try{fs.linkSync(snapshot,file);}
        catch(error){
          if(!['EXDEV','ENOSYS','ENOTSUP','EPERM'].includes(error.code))throw error;
          fs.copyFileSync(snapshot,file,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
        }
      }else{atomic(file,doc);snapshot=file;}
      update(job,{});
    }
  }catch(error){
    for(const folder of created)fs.rmSync(folder,{recursive:true,force:true});
    throw error;
  }
  queue.push(...items);
  void drain();
}
export function submitRenderBatch(doc,{revision,requestId,bookmarkIds,settings}){
  if(doc.workflowType!==PAINT)throw Error('请选择涂装工程');
  if(revision!==doc.revision)throw Object.assign(Error('工程修订已变化'),{status:409,currentRevision:doc.revision});
  if(typeof requestId!=='string'||!/^[-\w]{1,100}$/.test(requestId)||
     !Array.isArray(bookmarkIds)||!bookmarkIds.length||bookmarkIds.length>renderBookmarkLimit||
     bookmarkIds.some(id=>typeof id!=='string')||new Set(bookmarkIds).size!==bookmarkIds.length)
    throw Error('请选择有效且不重复的相机书签');
  const bookmarks=new Map((doc.paint.renderBookmarks??[]).map(item=>[item.id,item]));
  const base=pathTraceOptions(settings??{});
  if(base.camera)throw Error('批量出图使用相机书签');
  const oldJobs=new Map(listJobs(doc.id).map(job=>[job.requestId,job]));
  const next=[];
  const items=bookmarkIds.map(id=>{
    const bookmark=bookmarks.get(id);
    if(!bookmark)throw Error('找不到所选相机书签');
    const key=requestId+':'+id,paintSettings=pathTraceOptions({...base,camera:bookmark.camera});
    const renderBookmark={id,name:bookmark.name},prior=oldJobs.get(key);
    if(prior){
      if(prior.type!=='paint-render'||prior.revision!==revision||prior.renderBookmark?.id!==id||
         JSON.stringify(pathTraceOptions(prior.paintSettings))!==JSON.stringify(paintSettings))
        throw Error('请求编号已用于其他出图设置');
      return prior;
    }
    const job={...queuedJob(doc,'paint-render',key),paintSettings,renderBookmark};
    next.push(job);
    return job;
  });
  if(next.length)enqueue(doc,next);
  return items;
}
export function submit(pid,type,revision,requestId,task=null,retryOf=null,renderOptions=null){
  const previous=retryOf?getJob(pid,retryOf):null;
  const options=['paint-render','paint-export'].includes(type)?pathTraceOptions:null;
  const paintSettings=options?.(previous?.paintSettings??renderOptions?.settings??{})??null;
  const exportPaint=paintExportTypes.includes(type);
  const paintPreviewId=exportPaint?(previous?.paintPreviewId??renderOptions?.previewId):null;
  if(exportPaint&&(!paintPreviewId||previous&&!previous.paintConfirmedAt))throw Error('缺少已确认的 4K 预览');
  if(paintSettings?.textureJobId)throw Error('工程渲染使用冻结修订的贴图');
  if(!exportPaint&&!['paint-preview','paint-draft','paint-backup','paint-render'].includes(type))throw Error('不支持的任务');
  const prior=requestId&&listJobs(pid).find(j=>j.requestId===requestId);
  if(prior&&paintSettings&&JSON.stringify(options(prior.paintSettings??{}))!==JSON.stringify(paintSettings))throw Error('请求编号已用于其他渲染设置');
  if(prior&&exportPaint&&prior.paintPreviewId!==paintPreviewId)throw Error('请求编号已用于其他 4K 预览');
  if(prior){
    if(prior.revision!==revision||prior.type!==type||(prior.retryOf||null)!==retryOf)throw Error('请求编号已用于其他任务');
    return prior;
  }
  const doc=retryOf?JSON.parse(fs.readFileSync(path.join(jobDir(pid,retryOf),'snapshot.json'),'utf8')):read(pid);if(revision!==doc.revision){const e=Error('项目版本已改变');e.status=409;throw e;}
  if((doc.workflowType===PAINT)!==type.startsWith('paint-'))throw Error('涂装任务需要对应的涂装工程');
  if(exportPaint){
    const current=read(pid);
    if(current.revision!==revision)throw Object.assign(Error('工程修订已变化，请重新确认当前预览'),{status:409,currentRevision:current.revision});
    paintPreviewFolder(doc,getJob(pid,paintPreviewId));
  }
  const j=queuedJob(doc,type,requestId,retryOf,task);
  if(exportPaint){j.paintPreviewId=paintPreviewId;j.paintConfirmedAt=previous?.paintConfirmedAt??new Date().toISOString();}
  if(paintSettings)j.paintSettings=paintSettings;
  if(previous?.renderBookmark)j.renderBookmark=previous.renderBookmark;
  enqueue(doc,[j]);
  return j;
}
export function retryJob(pid,jid,requestId,task=null){const old=getJob(pid,jid);if(!['failed','cancelled','interrupted'].includes(old.status))throw Error('只有失败、取消或中断任务可重试');return submit(pid,old.type,old.revision,requestId,task,jid);}
async function drain(){if(running||!baseUrl)return;running=true;
  try{while(queue.length){const j=queue.shift();if(j.cancelRequested)continue;active.set(j.id,{job:j,controller:new AbortController()});update(j,{status:'running'});
    try{const doc=JSON.parse(fs.readFileSync(path.join(jobDir(j.projectId,j.id),'snapshot.json'),'utf8'));
      const signal=active.get(j.id).controller.signal;
      const native=action=>cyclesResource.run('production',action,{signal,onQueued:()=>stage(j,'等待当前渲染任务释放设备')});
      const registerBrowser=browser=>{active.get(j.id).browser=browser;};
      const action=()=>runPaintJob(j,doc,{stage,update,runProcess,getJob,listJobs,signal,registerBrowser});
      await (['paint-preview','paint-render','paint-export'].includes(j.type)?native(action):action());
      cancelled(j);update(j,{status:'completed',stage:'已完成'});
    }catch(e){
      if(j.cancelRequested||e.cancelled)update(j,{status:'cancelled',stage:'已取消'});
      else{log(j,'\nERROR '+e.stack+'\n');update(j,{status:'failed',stage:e.message,error:e.message});}
    }
    finally{active.delete(j.id);}
  }}finally{running=false;}
}
export async function cancel(pid,jid){
  const q=queue.find(j=>j.id===jid&&j.projectId===pid);const live=q||[...active.keys()].includes(jid)&&queueJob(pid,jid);
  const j=live||getJob(pid,jid);if(!['running','queued'].includes(j.status))return j;
  j.cancelRequested=true;update(j,{cancelRequested:true,status:'cancelled',stage:'已取消'});
  const a=active.get(jid);if(a?.job)a.job.cancelRequested=true;
  a?.controller?.abort();
  if(a?.browser)await a.browser.close().catch(()=>{});
  if(a?.child){
    const child=a.child;
    if(process.platform==='win32'&&child.pid)spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false}).on('error',()=>child.kill());
    else{
      child.kill('SIGTERM');
      const force=setTimeout(()=>child.kill('SIGKILL'),1800).unref();
      child.once('close',()=>clearTimeout(force));
    }
  }
  return j;
}
function queueJob(pid,jid){return active.get(jid)?.job||getJob(pid,jid);}
export function recover(){for(const p of list())for(const j of listJobs(p.id))if(['queued','running'].includes(j.status))update(j,{status:'interrupted',stage:'服务重启，任务已中断；未自动重跑'});}
export async function stop(){
  const exits=Promise.allSettled([...active.values()].map(value=>value.child).filter(Boolean).map(child=>
    child.exitCode!==null||child.signalCode!==null?Promise.resolve():once(child,'close')));
  for(const j of [...queue])await cancel(j.projectId,j.id);
  for(const[id,a]of active)if(a.job)await cancel(a.job.projectId,id);
  await exits;
}
