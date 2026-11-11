import {execFile} from 'node:child_process';
import {accessSync,constants,readdirSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function windowsBlender(env){
  const roots=[env.ProgramW6432,env.ProgramFiles,env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'Programs')];
  for(const root of new Set(roots.filter(value=>value&&path.isAbsolute(value)))){
    const foundation=path.join(root,'Blender Foundation');
    let versions=[];
    try{
      versions=readdirSync(foundation).filter(name=>/^Blender \d+(?:\.\d+)*$/.test(name))
        .sort((a,b)=>b.localeCompare(a,'en',{numeric:true}));
    }catch{}
    const candidates=[...versions,'Blender'].map(name=>path.join(foundation,name,'blender.exe'));
    candidates.push(path.join(root,'Blender','blender.exe'));
    for(const file of candidates){
      try{if(statSync(file).isFile())return file;}catch{}
    }
  }
  return 'blender.exe';
}

export function blenderExecutable(env=process.env,platform=process.platform){
  if(env.ARACHNE_BLENDER)return env.ARACHNE_BLENDER;
  if(platform==='win32')return windowsBlender(env);
  if(platform==='darwin'){
    const relative='Applications/Blender.app/Contents/MacOS/Blender';
    for(const file of [path.join('/',relative),path.join(os.homedir(),relative)]){
      try{accessSync(file,constants.X_OK);return file;}catch{}
    }
  }
  return 'blender';
}

export function blenderScriptArgs(script,args=[],{factory=true}={}){
  // Blender's embedded Python ignores PYTHONDONTWRITEBYTECODE in isolated mode.
  // Workers must leave the signed Mac application and installed sources read-only.
  return ['--background',...(factory?['--factory-startup']:[]),'--disable-autoexec','--python-exit-code','1',
    '--python-expr','import sys; sys.dont_write_bytecode = True','--python',script,'--',...args];
}

const marker='ARACHNE_CYCLES_DEVICES ',cacheTime=3*60*1000,failureTime=5000;
let pending=null,cache=null,expires=0,child=null;
function checkCycles(){
  return new Promise(resolve=>{
    const script=path.join(import.meta.dirname,'blender_cycles_devices.py');
    child=execFile(blenderExecutable(),blenderScriptArgs(script),{windowsHide:true,timeout:20000,maxBuffer:512*1024},(error,stdout)=>{
      child=null;
      const result=reason=>({available:false,version:null,gpus:[],renderPasses:false,reason});
      if(error){
        resolve(result(error.code==='ENOENT'?'找不到 Blender。请安装 Blender 或设置 ARACHNE_BLENDER。':
          error.killed?'检查 Cycles 设备超时，请重试。':'Blender 无法启动 Cycles。请检查本机安装。'));
        return;
      }
      try{
        const line=stdout.split(/\r?\n/).find(row=>row.startsWith(marker));
        const value=JSON.parse(line?.slice(marker.length));
        if(typeof value.version!=='string'||typeof value.available!=='boolean'||!Array.isArray(value.gpus))throw Error();
        resolve({available:value.available,version:value.version,renderPasses:value.renderPasses===true,gpus:value.gpus.filter(gpu=>
          typeof gpu?.name==='string'&&['METAL','OPTIX','CUDA','HIP','ONEAPI'].includes(gpu.backend)),
          reason:value.available?null:'这个 Blender 版本没有可用的 Cycles。'});
      }catch{resolve(result('Blender 没有返回 Cycles 设备信息。'));}
    });
  });
}

export function cyclesDevices({refresh=false}={}){
  if(pending)return pending;
  const now=Date.now();
  if(cache&&now<expires&&(!refresh||now<cache.checkedAt+failureTime))return Promise.resolve(cache);
  pending=checkCycles().then(result=>{
    const checkedAt=Date.now();
    cache={...result,checkedAt};
    expires=checkedAt+(result.available?cacheTime:failureTime);
    return cache;
  }).finally(()=>{pending=null;});
  return pending;
}

export function stopCyclesDeviceProbe(){child?.kill();}
