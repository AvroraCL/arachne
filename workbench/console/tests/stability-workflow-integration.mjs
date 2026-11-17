import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {pythonExecutable} from '../python-runtime.mjs';
const python=pythonExecutable();
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-stability-workflow-'));
const cwd=path.resolve(import.meta.dirname,'..');
const env={...process.env,ARACHNE_DATA_DIR:dir,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_PYTHON:python,PYTHONDONTWRITEBYTECODE:'1'};
execFileSync(process.execPath,['scripts/seed-native-demo.mjs'],{cwd,env,stdio:'inherit'});
const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');
const port=socket.address().port;await new Promise(r=>socket.close(r));
const base='http://127.0.0.1:'+port;
let server;
async function start(){
 server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd,env,stdio:['ignore','inherit','inherit','ipc']});
 await wait(()=>{
  if(server.exitCode!==null)throw Error('服务启动失败，退出码 '+server.exitCode);
  return fetch(base+'/api/health').then(r=>r.ok,()=>false);
 },'start');
}
async function stop(){
 if(server.exitCode===null&&server.signalCode===null){
  const done=once(server,'close');
  if(process.platform==='win32')server.disconnect();
  else server.kill();
  await done;
 }
 server=null;
}
async function wait(read,label){
 for(let i=0;i<1200;i++){const r=await read();if(r)return r;await sleep(100);}
 throw Error(label);
}
async function api(route,body,status=200){
 const response=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});
 const value=await response.json();assert.equal(response.status,status,JSON.stringify(value).slice(0,450));return value;
}
const project=doc=>'/api/projects/'+doc.id,paint=doc=>project(doc)+'/paint';
const create=name=>api('/api/projects',{workflowType:'pbr_paint',name},201);
const job=(doc,id)=>api(project(doc)+'/jobs/'+id);
const queue=(doc,kind,extra={})=>api(paint(doc)+'/'+kind,{revision:doc.revision,requestId:randomUUID(),...extra},202);
const completed=(doc,id)=>wait(async()=>{const j=await job(doc,id);if(['failed','cancelled','interrupted'].includes(j.status))throw Error(j.error||j.stage);return j.status==='completed'&&j;},'job '+id);
const digest=b=>createHash('sha256').update(b).digest('hex');
const image=(action,extra)=>({op:'image',documentId:'image',layerId:'p',action,...extra});
const counts=values=>(values||[]).reduce((n,s)=>n+(s.count||1),0);
function processRSS(){
 if(process.platform==='win32')return null;
 const kib=Number(execFileSync('ps',['-o','rss=','-p',String(server.pid)],{encoding:'utf8'}).trim());
 return kib/1024;
}
async function strokeWorkflow(){
 let doc=await create('持续绘制验证');
 const update=async (operations)=>{
   doc=await api(paint(doc)+'/commands',{revision:doc.revision,operations});
 };
 await update([{op:'add',kind:'paint'},image('create',{}),image('addLayer',{kind:'pixel',patch:{opacity:.8,blend:'multiply'}}),
 image('createMask',{reveal:true})]);
 const layer=doc.paint.layers[0].id;
 const media=async (kind,extra)=>{const r=await fetch(base+paint(doc)+'/'+kind,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},
 body:JSON.stringify({revision:doc.revision,...extra})});assert.equal(r.status,200,await (r.ok?Promise.resolve(''):r.text()));return digest(Buffer.from(await r.arrayBuffer()));};
 const captures=async()=>Promise.all([media('image-live',{documentId:'image',resolution:256}),media('image-live',{documentId:'image',resolution:256,inspectMask:'p'}),media('live',{resolution:256})]);
 const times=[];const memory={start:processRSS(),peakSampled:0};let prior,after;
 for(let i=0;i<412;i++){
   const x=.1+(i%24)*.029,y=.1+(Math.floor(i/24)%20)*.031;
   const rect=i===410?[.2,.2,.7,.7]:[x,y,x+.015,y+.015];
   const mark=i===410?{rect}:{radius:.008,hardness:.75,stamps:[[x,y,.8],[x+.012,y+.01,1]]};
   const common={uv:true,...mark,opacity:i===410?1:.65};
   const drawingStroke={...common,...(mark.stamps?{flow:.8,spacing:.25}:{})};
   const rgb=i%2?'#c86315':'#1762bd';
   const tint={color:rgb,metallic:.4,roughness:.35};
   if(i===63){
     const rejected=await api(paint(doc)+'/commands',{revision:doc.revision,operations:[
       image('stroke',{target:'pixels',stroke:{...drawingStroke,color:'invalid',erase:false}})
     ]},400);
     assert.match(rejected.error,/笔触/);
     assert.equal((await api(project(doc))).revision,doc.revision);
   }
   const t=performance.now();
   await update([image('stroke',{target:'pixels',stroke:{...drawingStroke,color:rgb,erase:i%29===2}}),
     image('stroke',{target:'mask',stroke:{...drawingStroke,value:i%2}}),
     {op:'stroke',id:layer,target:'material',stroke:{...common,channels:{color:true,metallic:true,roughness:true},values:tint,erase:i%19===2}},
     {op:'stroke',id:layer,target:'mask',stroke:{...common,value:i%2}}]);
   times.push(performance.now()-t);
   if(i%16===0||i>=409)memory.peakSampled=Math.max(memory.peakSampled,processRSS()??0);
   if(i===409)prior=await captures();
   if(i===410)after=await captures();
 }
 const drawing=doc.paint.imageDocuments.image.layers[0],material=doc.paint.layers[0];
 assert.deepEqual([drawing.strokes,drawing.maskStrokes,material.strokes,material.maskStrokes].map(counts),[412,412,412,412]);
 assert.equal(drawing.strokes.filter(s=>s.strokeBlock).length,6);
 for(let i=0;i<prior.length;i++)assert.notEqual(prior[i],after[i]);
 doc=await api(paint(doc)+'/undo',{revision:doc.revision,steps:2});assert.deepEqual(await captures(),prior);
 doc=await api(paint(doc)+'/redo',{revision:doc.revision});assert.deepEqual(await captures(),after);
 const export4k=()=>media('image-export',{documentId:'image'});
 const original4k=await export4k();
 await stop();await start();doc=await api(project(doc));assert.deepEqual(await captures(),after);
 const backup=await completed(doc,(await queue(doc,'backup')).id);
 const packageResponse=await fetch(base+backup.archiveUrl);
 assert.equal(packageResponse.status,200);
 const importResponse=await fetch(base+'/api/projects/paint-import',{
   method:'POST',headers:{'Content-Type':'application/zip',Origin:base},body:await packageResponse.arrayBuffer()
 });
 const restored=await importResponse.json();
 assert.equal(importResponse.status,201,JSON.stringify(restored));
 doc=restored;
 assert.deepEqual(await captures(),after);
 assert.equal(await export4k(),original4k);
 times.sort((a,b)=>a-b);
 console.log('STROKES',JSON.stringify({savedPerTrack:412,p50ms:times[205],p95ms:times[391],maxMs:times.at(-1),serverRSSMiB:memory,backup:backup.id,project:doc.id,data:dir}));
}
async function recoveryWorkflow(){
 const mixed=await create('恢复混合任务'),healthy=await create('恢复正常任务');
 const completedBackup=await completed(healthy,(await queue(healthy,'backup')).id);
 await stop();
 const record=(doc,id)=>path.join(dir,'projects',doc.id,'jobs',id,'job.json');
 const truncated=record(mixed,'truncated'),incomplete=record(mixed,'incomplete'),running=record(mixed,'running');
 for(const file of [truncated,incomplete,running])await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(truncated,'{"id":');
 await fs.writeFile(incomplete,'{"status":"completed"}');
 await fs.writeFile(running,JSON.stringify({id:'running',projectId:mixed.id,status:'running',type:'paint-backup',
  revision:mixed.revision,stage:'运行中',created:new Date().toISOString()}));
 await start();
 assert.equal((await api(paint(mixed))).document.id,mixed.id);
 assert.equal((await job(mixed,'running')).status,'interrupted');
 assert.equal((await job(healthy,completedBackup.id)).status,'completed');
 assert.equal((await job(mixed,'truncated')).status,'corrupt');
 assert.equal((await job(mixed,'incomplete')).status,'corrupt');
 assert.equal(await fs.readFile(truncated,'utf8'),'{"id":');
 assert.equal(await fs.readFile(incomplete,'utf8'),'{"status":"completed"}');
 console.log('STARTUP RECOVERY PASS');
}
async function queueWorkflow(){
 const doc=await create('长时间渲染'),other=await create('独立备份');
 const render=await queue(doc,'render',{settings:{width:512,height:512,samples:4096,device:'cpu'}});
 try{
  await wait(async()=>{const j=await job(doc,render.id);if(j.status==='failed')throw Error(j.error);return j.progress?.sample>=1;},'render sampling');
  const backup=await queue(other,'backup');
  await completed(other,backup.id);
  assert.equal((await job(doc,render.id)).status,'running');
  const bake=await queue(other,'preview');
  assert.equal((await job(other,bake.id)).status,'queued');
  const premature=await api(paint(other)+'/export-textures',{
    revision:other.revision,requestId:randomUUID(),previewId:bake.id,confirmed:true
  },400);
  assert.match(premature.error,/有效预览/);
  await api(paint(doc)+'/render-cancel',{jobId:render.id,revision:doc.revision});
  await completed(other,bake.id);
  const output=await completed(other,(await queue(other,'export-textures',{previewId:bake.id,confirmed:true})).id);
  assert.ok(output.packageUrl);
  const next=await api(paint(doc)+'/render-retry',{jobId:render.id,revision:doc.revision,requestId:randomUUID()},202);
  assert.equal(next.retryOf,render.id);
  assert.equal(next.revision,render.revision);
  await stop();await start();
  assert.equal((await job(doc,next.id)).status,'cancelled');
  console.log('QUEUE PASS',dir);
 }finally{await api(paint(doc)+'/render-cancel',{jobId:render.id,revision:doc.revision});}
}
try{
 await start();
 await recoveryWorkflow();
 if(!process.argv.includes('--queue-only'))await strokeWorkflow();
 if(!process.argv.includes('--strokes-only'))await queueWorkflow();
}
finally{if(server)await stop();}
