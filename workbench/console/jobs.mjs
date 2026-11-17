import {PAINT,runPaintJob,paintPreviewFolder} from './paint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {ROOT,projectDir,read,list,atomic} from './store.mjs';
import {pathTraceOptions} from './path-trace-render.mjs';
import {cyclesResource} from './cycles-resource.mjs';
import {renderBookmarkLimit} from './public/paint-delivery-options.mjs';
import {checkedTexturePreset} from './public/texture-export-presets.mjs';

const PYTHON=process.env.ARACHNE_PYTHON||'python';
export const paintExportTypes=['paint-export','paint-texture-export','paint-glb-export'];
let baseUrl='',stopping=false,generation=0;
const queue=[],active=new Map();
// Run one memory-heavy render or bake at a time. File tasks have a separate
// bounded slot so a render does not hold up an independent project backup.
const laneOf=type=>['paint-render','paint-export'].includes(type)?'render':
  ['paint-preview','paint-draft'].includes(type)?'bake':'file';
export const setBaseUrl=url=>{baseUrl=url;};
export const jobUpdates=()=>generation;
export const hasPendingJobs=()=>active.size>0||queue.some(job=>!job.cancelRequested);
const validJobId=id=>typeof id==='string'&&/^[\w-]{1,100}$/.test(id);
const safe=id=>{if(!validJobId(id))throw Error('任务ID无效');return id;};
export const jobDir=(pid,jid)=>path.join(projectDir(pid),'jobs',safe(jid));
const jobTypes=new Set([...paintExportTypes,'paint-preview','paint-draft','paint-backup','paint-render']);
const jobStatuses=new Set(['queued','running','completed','failed','cancelled','interrupted']);
const failedRecovery=new Map();
function damagedJob(pid,jid,reason){
  return {id:jid,projectId:pid,status:'corrupt',stage:'任务记录无法恢复',
    error:`任务 ${jid} 无法恢复：${reason}。原始 job.json 已保留。`};
}
export function getJob(pid,jid){
  const folder=jobDir(pid,jid),file=path.join(folder,'job.json');
  let job;
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.size>32*1024*1024)return damagedJob(pid,jid,'记录文件类型或大小无效');
    job=JSON.parse(fs.readFileSync(file,'utf8'));
  }
  catch(error){
    if(error.code==='ENOENT'||error.code==='ENOTDIR')throw error;
    return damagedJob(pid,jid,error instanceof SyntaxError?'JSON 格式无效或文件不完整':`无法读取记录（${error.code||'读取失败'}）`);
  }
  if(!job||typeof job!=='object'||Array.isArray(job))return damagedJob(pid,jid,'记录必须是 JSON 对象');
  const checks={
    id:job.id===jid,projectId:job.projectId===pid,type:jobTypes.has(job.type),
    status:jobStatuses.has(job.status),revision:Number.isSafeInteger(job.revision)&&job.revision>=0,
    created:typeof job.created==='string'&&Number.isFinite(Date.parse(job.created)),
    stage:typeof job.stage==='string',
    progress:job.progress===undefined||job.progress&&typeof job.progress==='object'&&!Array.isArray(job.progress)
  };
  if(job.status==='completed'){
    const outputs={
      'paint-draft':'colorUrl','paint-preview':'colorUrl','paint-render':'renderUrl','paint-backup':'archiveUrl',
      'paint-export':'packageUrl','paint-texture-export':'packageUrl','paint-glb-export':'glbUrl'
    };
    const key=outputs[job.type];
    const url=key&&job[key];
    if(typeof url!=='string'||!url.startsWith(`/api/projects/${pid}/jobs/${jid}/files/`))checks.output=false;
  }
  const invalid=Object.keys(checks).filter(key=>!checks[key]);
  if(invalid.length)return damagedJob(pid,jid,'字段缺失或无效：'+invalid.join('、'));
  return failedRecovery.get(file)||job;
}
export function listJobs(pid){
  const dir=path.join(projectDir(pid),'jobs');
  let entries;
  try{entries=fs.readdirSync(dir,{withFileTypes:true});}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
  return entries.filter(entry=>entry.isDirectory()&&validJobId(entry.name)).flatMap(entry=>{
    try{return [getJob(pid,entry.name)];}
    catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return [];throw error;}
  }).sort((a,b)=>(b.created||'').localeCompare(a.created||'')||a.id.localeCompare(b.id));
}
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
  const next={...j,...patch,updated:new Date().toISOString()};
  atomic(path.join(jobDir(j.projectId,j.id),'job.json'),next);
  Object.assign(j,next);
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
    let logFailure;
    const append=output=>{
      if(logFailure)return;
      try{log(j,output);}
      catch(error){logFailure=error;child.kill();}
    };
    child.stdout.on('data',b=>{
      const output=decoder.write(b);append(output);
      if(!onLine)return;
      const lines=(pendingLine+output).split(/\r?\n/);pendingLine=lines.pop();
      if(pendingLine.length>65536)pendingLine='';
      for(const line of lines)onLine(line);
    });
    child.stderr.on('data',b=>append(b.toString()));
    child.on('error',reject);child.on('close',code=>{const tail=decoder.end();if(tail)append(tail);if(onLine&&pendingLine+tail)onLine(pendingLine+tail);const a=active.get(j.id);if(a?.child===child)delete a.child;
      if(j.cancelRequested){const e=Error('任务已取消');e.cancelled=true;reject(e);}
      else if(logFailure)reject(Error('无法写入任务日志，请检查工作台数据目录的空间和权限',{cause:logFailure}));
      else if(code!==0)reject(Error('工具执行失败，请查看运行日志'));else resolve();});
  });
}
export function mime(name){return ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.otf':'font/otf','.ttc':'font/collection','.json':'application/json','.html':'text/html','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript','.log':'text/plain','.glb':'model/gltf-binary'})[path.extname(name).toLowerCase()]||'application/octet-stream';}
function queuedJob(doc,type,requestId,retryOf=null,task=null){
  return {id:crypto.randomUUID(),projectId:doc.id,type,revision:doc.revision,retryOf,requestId:requestId||null,
    task:task?{labId:task.labId,taskId:task.taskId,attemptId:task.attemptId}:null,status:'queued',stage:'等待执行',created:new Date().toISOString()};
}
function enqueue(doc,items){
  if(stopping)throw Object.assign(Error('工作台正在关闭'),{status:503});
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
  drain();
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
  const texturePreset=['paint-export','paint-texture-export'].includes(type)
    ?checkedTexturePreset(previous?previous.texturePreset:renderOptions?.texturePreset):null;
  const paintPreviewId=exportPaint?(previous?.paintPreviewId??renderOptions?.previewId):null;
  if(exportPaint&&(!paintPreviewId||previous&&!previous.paintConfirmedAt))throw Error('缺少已确认的 4K 预览');
  if(paintSettings?.textureJobId)throw Error('工程渲染使用冻结修订的贴图');
  if(!exportPaint&&!['paint-preview','paint-draft','paint-backup','paint-render'].includes(type))throw Error('不支持的任务');
  const prior=requestId&&listJobs(pid).find(j=>j.requestId===requestId);
  if(prior&&paintSettings&&JSON.stringify(options(prior.paintSettings??{}))!==JSON.stringify(paintSettings))throw Error('请求编号已用于其他渲染设置');
  if(prior&&exportPaint&&prior.paintPreviewId!==paintPreviewId)throw Error('请求编号已用于其他 4K 预览');
  if(prior&&texturePreset&&checkedTexturePreset(prior.texturePreset)!==texturePreset)
    throw Error('请求编号已用于其他贴图输出预设');
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
  if(texturePreset)j.texturePreset=texturePreset;
  if(previous?.renderBookmark)j.renderBookmark=previous.renderBookmark;
  enqueue(doc,[j]);
  return j;
}
export function retryJob(pid,jid,requestId,task=null){const old=getJob(pid,jid);if(!['failed','cancelled','interrupted'].includes(old.status))throw Error('只有失败、取消或中断任务可重试');return submit(pid,old.type,old.revision,requestId,task,jid);}
function drain(){
  if(stopping||!baseUrl)return;
  const lanes=new Set([...active.values()].map(entry=>entry.lane));
  let heavy=lanes.has('render')||lanes.has('bake');
  for(let i=0;i<queue.length;){
    const job=queue[i],lane=laneOf(job.type);
    if(job.cancelRequested){queue.splice(i,1);continue;}
    if(lanes.has(lane)||(lane!=='file'&&heavy)){i++;continue;}
    queue.splice(i,1);
    lanes.add(lane);
    if(lane!=='file')heavy=true;
    const entry={job,lane,controller:new AbortController()};
    active.set(job.id,entry);
    entry.done=executeJob(entry).catch(error=>{
      console.error(`无法记录任务 ${job.id} 的最终状态：${error.message}`);
      const file=path.join(jobDir(job.projectId,job.id),'job.json');
      failedRecovery.set(file,damagedJob(job.projectId,job.id,'无法保存任务状态'));
      generation++;
    }).finally(()=>{active.delete(job.id);drain();});
  }
}
async function executeJob(entry){
  const {job,lane,controller}=entry,signal=controller.signal;
  try{
    update(job,{status:'running'});
    const snapshot=path.join(jobDir(job.projectId,job.id),'snapshot.json');
    const doc=JSON.parse(fs.readFileSync(snapshot,'utf8'));
    if(doc.id!==job.projectId||doc.revision!==job.revision)throw Error('任务快照与冻结修订不一致');
    const registerBrowser=browser=>{entry.browser=browser;};
    const action=()=>runPaintJob(job,doc,{stage,update,runProcess,getJob,listJobs,signal,registerBrowser});
    if(lane==='file')await action();
    else await cyclesResource.run('production',action,{signal,onQueued:()=>stage(job,'等待当前渲染任务释放设备')});
    cancelled(job);
    update(job,{status:'completed',stage:'已完成'});
  }catch(error){
    if(job.cancelRequested||error.cancelled)update(job,{status:'cancelled',stage:'已取消'});
    else{
      try{log(job,'\nERROR '+error.stack+'\n');}catch(logError){console.warn('无法记录任务日志',logError.code);}
      update(job,{status:'failed',stage:error.message,error:error.message});
    }
  }
}
export async function cancel(pid,jid){
  const q=queue.find(j=>j.id===jid&&j.projectId===pid);
  const current=active.get(jid),live=q||(current?.job.projectId===pid?current.job:null);
  const j=live||getJob(pid,jid);if(!['running','queued'].includes(j.status))return j;
  j.cancelRequested=true;
  const a=current?.job===j?current:null;
  let failure;
  try{update(j,{cancelRequested:true,status:'cancelled',stage:'已取消'});}catch(error){failure=error;}
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
  if(q)drain();
  if(failure)throw failure;
  return j;
}
export function recover(){
  for(const project of list()){
    let jobs;
    try{jobs=listJobs(project.id);}
    catch(error){console.warn(`无法读取工程 ${project.id} 的任务目录：${error.code||error.message}`);continue;}
    for(const job of jobs){
      if(job.status==='corrupt'){console.warn(`工程 ${project.id}：${job.error}`);continue;}
      if(!['queued','running'].includes(job.status))continue;
      try{update(job,{status:'interrupted',stage:'服务重启，任务已中断；未自动重跑'});}
      catch(error){
        const diagnostic=damagedJob(project.id,job.id,`无法写入中断状态（${error.code||'写入失败'}）`);
        failedRecovery.set(path.join(jobDir(project.id,job.id),'job.json'),diagnostic);
        console.warn(`工程 ${project.id}：${diagnostic.error}`);
      }
    }
  }
}
export async function stop(){
  stopping=true;
  const workers=[...active.values()];
  const cancellations=await Promise.allSettled([...queue,...workers.map(entry=>entry.job)]
    .map(job=>cancel(job.projectId,job.id)));
  await Promise.allSettled(workers.map(entry=>entry.done));
  for(const result of cancellations)if(result.status==='rejected')console.error('无法记录任务取消状态',result.reason);
}
