import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pythonExecutable} from './python-runtime.mjs';

export function readServiceOwner(file){
  let saved;
  try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){
    if(error.code==='ENOENT'||error instanceof SyntaxError)return null;
    throw error;
  }
  if(!Number.isSafeInteger(saved?.pid)||saved.pid<=1||typeof saved.url!=='string'||
     !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(saved.url))return null;
  return saved;
}

export function ownerIsRunning(owner){
  if(!owner)return false;
  try{process.kill(owner.pid,0);return true;}
  catch(error){return error.code==='EPERM';}
}

function occupied(file){
  const owner=readServiceOwner(file);
  return Error('已有控制台使用该数据目录'+(owner?'：'+owner.url:'')+'；请复用该服务');
}

export async function acquireServiceProfile(data,url,onLost){
  const file=path.join(data,'server-lock.json');
  // The record also protects a service started by an older installation.
  if(ownerIsRunning(readServiceOwner(file)))throw occupied(file);
  const child=spawn(pythonExecutable(),['-B','-X','utf8',path.join(import.meta.dirname,'native_worker_lock.py'),
    path.join(data,'.service')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let closed=false,committed=false,reason='';
  child.stdin.on('error',()=>{});
  child.stderr.setEncoding('utf8').on('data',part=>{reason=(reason+part).slice(-2000);});
  child.once('exit',()=>{if(committed&&!closed)onLost?.();});
  const lines=createInterface({input:child.stdout});
  try{
    const response=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(reject,Error('数据目录锁启动超时')),8000);
      function finish(settle,value){
        clearTimeout(timer);
        lines.off('line',line);child.off('error',failure);child.off('close',exit);
        settle(value);
      }
      const line=value=>finish(resolve,value);
      const failure=error=>finish(reject,Error('无法启动数据目录锁：'+error.message));
      const exit=()=>finish(reject,Error('无法锁定数据目录'+(reason.trim()?'：'+reason.trim():'')));
      lines.once('line',line);child.once('error',failure);child.once('close',exit);
    });
    if(response==='busy'||ownerIsRunning(readServiceOwner(file)))throw occupied(file);
    if(response!=='ready'||child.exitCode!==null)throw Error('无法锁定数据目录');
    const temp=file+'.'+process.pid+'.tmp';
    try{
      fs.writeFileSync(temp,JSON.stringify({pid:process.pid,url}));
      fs.renameSync(temp,file);
    }finally{fs.rmSync(temp,{force:true});}
    committed=true;
  }catch(error){
    child.stdin.end();
    if(child.exitCode===null)child.kill();
    throw error;
  }finally{lines.close();}
  return ()=>{
    if(closed)return;
    closed=true;
    try{if(readServiceOwner(file)?.pid===process.pid)fs.unlinkSync(file);}
    catch(error){console.warn('无法清理控制台状态文件',error.code);}
    finally{child.stdin.end();}
  };
}
