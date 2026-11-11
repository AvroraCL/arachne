import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {blenderExecutable,blenderScriptArgs} from './blender-runtime.mjs';
import {cyclesViewRequest,leaseCyclesViewMaterial} from './paint-cycles-view.mjs';
import {cyclesViewportLimits} from './public/cycles-limits.mjs';
import {pngSizeIs} from './paint.mjs';
import {ROOT,read} from './store.mjs';

const active=new Map(),retired=new Set(),limit=2,idle=12_000,frameWait=1200;
const tokenPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const error=(message,status)=>Object.assign(Error(message),{status});
export const interactiveCyclesAvailable=process.platform==='darwin'&&process.env.ARACHNE_CYCLES_INTERACTIVE!=='0';

function identity(projectId,token){
  if(!tokenPattern.test(token||''))throw error('Cycles 视口会话编号无效',400);
  return projectId+':'+token;
}

function wake(session){
  for(const callback of session.waiters)callback();
}

function touch(session){
  clearTimeout(session.idleTimer);
  session.idleTimer=setTimeout(()=>void close(session),idle).unref();
}

function retire(id){
  retired.add(id);
  if(retired.size>128)retired.delete(retired.values().next().value);
}

async function close(session){
  if(session.closing)return session.closing;
  session.closing=(async()=>{
    active.delete(session.id);retire(session.id);
    clearTimeout(session.idleTimer);clearTimeout(session.startTimer);
    session.controller.abort();wake(session);
    await session.start.catch(()=>{});
    if(session.child&&session.child.exitCode===null&&session.child.signalCode===null){
      const exited=once(session.child,'close').catch(()=>{});
      session.child.kill();
      const force=setTimeout(()=>session.child.kill('SIGKILL'),1000).unref();
      try{await exited;}finally{clearTimeout(force);}
    }
    await session.pump?.catch(()=>{});
    for(const {lease} of session.leases.values())lease.release();
    if(session.folder)await fs.rm(session.folder,{recursive:true,force:true});
  })();
  return session.closing;
}

function fail(session,message){
  if(session.controller.signal.aborted)return;
  session.error=message;
  wake(session);
}

function releaseOld(session,revision,quality){
  for(const [key,value] of session.leases){
    if(key===revision+':'+quality||value.sequence>session.applied)continue;
    value.lease.release();session.leases.delete(key);
  }
}

async function receive(session,event){
  if(session.controller.signal.aborted)return;
  if(event.kind==='error'){fail(session,event.message||'交互 Cycles 渲染失败');return;}
  if(event.kind==='applied'){
    if(event.sequence<=session.applied)return;
    session.applied=event.sequence;
    const stage=session.commands.get(event.sequence);
    if(stage)releaseOld(session,stage.revision,stage.quality);
    for(const key of session.commands.keys())if(key<event.sequence)session.commands.delete(key);
    return;
  }
  const {sequence,revision,number,width,height,device,quality}=event;
  if(event.kind!=='frame'||sequence>session.latest?.sequence||session.latest.paused||
    revision!==session.latest.doc.revision||read(session.projectId).revision!==revision||
    !Number.isSafeInteger(number)||number<1||!Object.hasOwn(cyclesViewportLimits,quality))return;
  let image;
  try{image=await fs.readFile(path.join(session.folder,`frame-${number}.png`));}
  catch(error){if(error.code==='ENOENT')return;throw error;}
  if(session.controller.signal.aborted||session.latest.doc.revision!==revision||session.latest.paused||
    number<=(session.frame?.number||0)||!pngSizeIs(image,width,height))return;
  clearTimeout(session.startTimer);
  session.frame={image,sequence,revision,number,width,height,device,session:event.session,
    mapResolution:cyclesViewportLimits[quality].size,sha256:createHash('sha256').update(image).digest('hex')};
  wake(session);
}

function startWorker(session){
  const scriptArgs=blenderScriptArgs(path.join(ROOT,'cycles_viewport_worker.py'),[session.folder]).slice(1);
  const args=['--no-window-focus','--no-window-frame','--window-geometry','24','24','1240','900',...scriptArgs];
  const child=session.child=spawn(blenderExecutable(),args,{
    cwd:ROOT,stdio:['ignore','pipe','pipe'],windowsHide:true,
    env:{...process.env,BLENDER_USER_CONFIG:path.join(session.folder,'config'),
      ARACHNE_NATIVE_PARENT_PID:String(process.pid)}
  });
  session.startTimer=setTimeout(()=>{
    if(!session.frame&&!session.error&&!session.controller.signal.aborted){
      fail(session,'Blender 交互视口启动超时，请确认 Mac 图形会话可用');
      child.kill();
    }
  },45_000).unref();
  let diagnostics='';
  const debug=process.env.ARACHNE_CYCLES_DEBUG==='1';
  child.stderr.on('data',chunk=>{
    diagnostics=(diagnostics+chunk).slice(-2200);
    if(debug)process.stderr.write(chunk);
  });
  child.on('error',()=>fail(session,'无法启动 Blender 交互视口'));
  child.once('close',(code,signal)=>fail(session,session.error||
    ['Blender 交互视口已退出 ('+(signal||code)+')',diagnostics.trim().split(/\r?\n/).at(-1)].filter(Boolean).join(' · ')));
  const output=createInterface({input:child.stdout});
  output.on('line',line=>{
    if(debug)console.log(line);
    const prefix='ARACHNE_CYCLES_VIEW ';
    if(!line.startsWith(prefix)){diagnostics=(diagnostics+line+'\n').slice(-2200);return;}
    try{
      void receive(session,JSON.parse(line.slice(prefix.length))).catch(e=>fail(session,e.message));
    }catch(e){fail(session,e.message);}
  });
}

function updateWorker(session,listBakes){
  if(session.pump)return;
  session.pump=(async()=>{
    const signal=session.controller.signal;
    await session.start;
    while(!signal.aborted&&!session.error&&session.sent<session.latest.sequence){
      const next=session.latest,key=next.doc.revision+':'+next.quality;
      let binding=session.leases.get(key);
      if(!binding){
        const lease=await leaseCyclesViewMaterial(next.doc,next.quality,{signal,listBakes});
        if(signal.aborted||session.latest.doc.revision!==next.doc.revision||session.latest.quality!==next.quality){
          lease.release();continue;
        }
        binding={lease,sequence:0};session.leases.set(key,binding);
      }
      const desired=session.latest,doc=desired.doc,{stage}=binding.lease;
      const config={source:stage.source,sourceHash:stage.sourceHash,color:stage.color,channels:stage.channels,texture:stage.texture,
        nodeMaterial:stage.nodeMaterial,renderLighting:doc.paint.renderLighting,renderVisibility:doc.paint.renderVisibility,
        renderAppearance:doc.paint.renderAppearance,renderOptics:doc.paint.renderOptics};
      const {sequence,settings,quality,hiddenObjects,paused}=desired;
      const temp=path.join(session.folder,'command.tmp');
      await fs.writeFile(temp,JSON.stringify({sequence,revision:doc.revision,config,settings,quality,hiddenObjects,paused}),{signal});
      session.commands.set(sequence,{revision:doc.revision,quality});
      binding.sequence=sequence;
      await fs.rename(temp,path.join(session.folder,'command.json'));
      session.sent=sequence;
      if(!session.child&&!signal.aborted){
        await fs.mkdir(path.join(session.folder,'config'),{recursive:true});
        if(!signal.aborted)startWorker(session);
      }
    }
  })().catch(e=>fail(session,e.message)).finally(()=>{
    session.pump=null;
    if(!session.controller.signal.aborted&&!session.error&&session.sent<session.latest.sequence)updateWorker(session,listBakes);
  });
}

export function updateCyclesSession(doc,raw,listBakes){
  const id=identity(doc.id,raw.token);
  let session=active.get(id);
  if(raw.close===true){if(session)void close(session);else retire(id);return;}
  if(retired.has(id))throw error('Cycles 视口会话已结束',410);
  if(!interactiveCyclesAvailable)throw error('本机交互 Cycles 视口不可用',501);
  if(raw.revision!==doc.revision)throw error('工程修订已变化',409);
  if(!Number.isSafeInteger(raw.sequence)||raw.sequence<1||typeof raw.paused!=='boolean')
    throw error('Cycles 视口命令无效',400);
  const request=cyclesViewRequest(raw);
  if(!session){
    if(active.size>=limit)throw error('两个交互 Cycles 视口已在使用',503);
    session={id,projectId:doc.id,controller:new AbortController(),leases:new Map(),commands:new Map(),
      waiters:new Set(),applied:0,sent:0,latest:null};
    active.set(id,session);
    session.start=fs.mkdtemp(path.join(os.tmpdir(),'arachne-cycles-session-')).then(folder=>{session.folder=folder;});
  }
  touch(session);
  if(session.error)throw error(session.error,502);
  if(session.latest&&raw.sequence<=session.latest.sequence)return;
  session.latest={...request,sequence:raw.sequence,doc,paused:raw.paused};
  updateWorker(session,listBakes);
}

export async function cyclesSessionFrame(projectId,token,after,signal){
  const session=active.get(identity(projectId,token));
  if(!session)throw error('Cycles 视口会话已结束',404);
  touch(session);
  const current=()=>session.error||session.controller.signal.aborted||
    session.frame?.number>after&&session.frame.revision===session.latest.doc.revision&&!session.latest.paused;
  if(!current()&&!signal.aborted)await new Promise(resolve=>{
    const stop=()=>{
      clearTimeout(timer);session.waiters.delete(check);
      signal.removeEventListener('abort',stop);resolve();
    };
    const check=()=>{if(current())stop();};
    const timer=setTimeout(stop,frameWait);
    session.waiters.add(check);signal.addEventListener('abort',stop,{once:true});
  });
  if(session.error)throw error(session.error,502);
  if(!current()||session.controller.signal.aborted||signal.aborted)return null;
  return session.frame;
}

export async function stopCyclesSessions(){
  await Promise.allSettled([...active.values()].map(close));
}
