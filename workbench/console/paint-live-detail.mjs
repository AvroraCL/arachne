import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT} from './store.mjs';

// Full UV surfaces are large. Run one disposable detail compositor at a time;
// interactive strokes keep their own small, persistent worker.
const queue=[];
let active=null;
const abortError=()=>Object.assign(Error('4K 实时预览已取消'),{name:'AbortError'});

function pump(){
  if(active||!queue.length)return;
  const task=active=queue.shift();
  const child=task.child=spawn(process.env.ARACHNE_PYTHON||'python',
    ['-X','utf8',path.join(ROOT,'paint_worker.py'),'--live-detail'],
    {cwd:ROOT,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,OPENBLAS_NUM_THREADS:'1'}});
  const clipboard=!!task.config.clipboardRegion,encoded=clipboard||task.config.imagePng;
  const size=encoded?(clipboard?24:68)*1024*1024:4096*4096*(task.config.liveFormat==='rgba'?4:task.config.liveFormat==='pbr8'?15:6);
  let pixels=encoded?[]:Buffer.allocUnsafe(size),offset=0,log='';
  const timer=setTimeout(()=>task.cancel(Error('4K 实时合成超时，请重试')),120000);
  task.cancel=error=>{task.error=error;child.kill();};
  child.stdout.on('data',chunk=>{
    if(offset+chunk.length>size){task.cancel(Error(clipboard?'选区 PNG 超过 24 MiB，请缩小选区':'4K 实时贴图尺寸无效'));return;}
    if(encoded)pixels.push(chunk);
    else chunk.copy(pixels,offset);
    offset+=chunk.length;
  });
  child.stderr.on('data',chunk=>{log=(log+chunk).slice(-3000);});
  child.on('error',error=>{task.error=error;});
  child.stdin.on('error',error=>{task.error??=error;child.kill();});
  child.on('close',code=>{
    clearTimeout(timer);task.signal?.removeEventListener('abort',task.abort);
    active=null;
    if(task.error||code!==0||(encoded?offset<45:offset!==size))
      task.reject(task.error||Error(log.trim()||'4K 实时合成失败'));
    else task.resolve(encoded?Buffer.concat(pixels,offset):pixels);
    pixels=null;pump();
  });
  child.stdin.end(JSON.stringify(task.config));
}

export function livePaintDetail(config,{signal}={}){
  if(signal?.aborted)return Promise.reject(abortError());
  if(queue.length>=3)return Promise.reject(Object.assign(Error('4K 实时合成忙，请重试'),{status:503}));
  return new Promise((resolve,reject)=>{
    const task={config,signal,resolve,reject};
    task.abort=()=>{
      if(active===task)task.cancel(abortError());
      else{
        const index=queue.indexOf(task);if(index>=0)queue.splice(index,1);
        signal?.removeEventListener('abort',task.abort);reject(abortError());
      }
    };
    signal?.addEventListener('abort',task.abort,{once:true});
    queue.push(task);pump();
  });
}

export function stopLivePaintDetails(){
  for(const task of [...queue])task.abort();
  active?.cancel(abortError());
}
