import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {ROOT,hash} from './store.mjs';
import {livePaintDetail,stopLivePaintDetails} from './paint-live-detail.mjs';
import {createPaintLiveQueue,paintAbortError} from './paint-live-queue.mjs';

const verified=new Map();

function checkFile(file,expected){
  const stat=fs.statSync(file);
  const key=`${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${expected}`;
  if(verified.get(file)===key)return;
  if(hash(file)!==expected)throw Error('实时制作输入指纹变化：'+path.basename(file));
  if(verified.size>=512)verified.clear();
  verified.set(file,key);
}

function start({result,fail}){
  const child=spawn(process.env.ARACHNE_PYTHON||'python',
    ['-X','utf8',path.join(ROOT,'paint_worker.py'),'--interactive'],
    {cwd:ROOT,stdio:['pipe','pipe','inherit'],windowsHide:true,env:{...process.env,OPENBLAS_NUM_THREADS:'1'}});
  createInterface({input:child.stdout}).on('line',line=>{
    try{
      const {id,pixels,error}=JSON.parse(line);
      result(id,pixels,error?Error(error):null);
    }catch(error){fail(error);}
  });
  child.on('error',fail);
  child.stdin.on('error',fail);
  child.on('close',()=>fail(Error('实时合成进程已退出')));
  return {request(id,config){child.stdin.write(JSON.stringify({id,config})+'\n');},stop(){child.kill();}};
}
const fastQueue=createPaintLiveQueue(start);

export function livePaint(config,options={}){
  if(options.signal?.aborted)return Promise.reject(paintAbortError());
  if(!config.imageDocumentId){
    for(const [file,digest] of Object.entries(config.source.files))checkFile(file,digest);
  }
  for(const [id,file] of Object.entries(config.assets))checkFile(file,id);
  if(config.liveResolution===4096)return livePaintDetail(config,options);
  return fastQueue.submit(config,options).then(pixels=>Buffer.from(pixels,'base64'));
}

export function stopLivePaint(){
  stopLivePaintDetails();
  fastQueue.stop();
}
