// The native worker advances the same viewport session until it is paused or closed.
export function createInteractiveCyclesViewport({host,read,onStatus,onVisibility,request=fetch}){
  const image=document.createElement('img');
  image.className='editor-cycles-image';image.alt='当前视角的 Cycles 交互渲染';image.draggable=false;image.hidden=true;
  host.append(image);
  let running=null,last=null,disposed=false;
  let state={phase:'off',text:'',retry:false};
  const wheelQuietMs=45;
  const viewKey=input=>JSON.stringify([input.revision,input.settings.camera,input.aspect,input.hiddenObjects]);

  function status(phase,text,retry=false){
    if(state.phase===phase&&state.text===text&&state.retry===retry)return;
    state={phase,text,retry};host.dataset.cyclesState=phase;onStatus(state);
  }

  function display(frame,aligned=false){
    image.hidden=!frame;onVisibility(!!frame,aligned);
    for(const [field,value] of Object.entries({cyclesRevision:frame?.revision,cyclesDevice:frame?.device,
      cyclesSha256:frame?.sha256,cyclesMapResolution:frame?.mapResolution,cyclesFrame:frame?.number,cyclesSession:frame?.session})){
      if(value===undefined)delete host.dataset[field];
      else host.dataset[field]=String(value);
    }
  }

  function describe(frame){
    return `Cycles · ${frame.device} · ${frame.width} × ${frame.height} · 贴图 ${frame.mapResolution===4096?'4K':'1K'}`;
  }

  function stop(){
    if(running){
      const session=running;running=null;
      clearTimeout(session.timer);session.abort.abort();
      void request(session.url,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token:session.token,close:true}),keepalive:true}).catch(()=>{});
    }
    display(null);
    if(last){URL.revokeObjectURL(last.url);last=null;image.removeAttribute('src');}
  }

  function fail(session,error){
    if(session!==running||session.abort.signal.aborted)return;
    session.failed=true;session.abort.abort();
    if(!session.frozen)display(null);
    status('error','Cycles · '+error.message,true);
  }

  async function check(response){
    if(response.ok)return;
    const value=await response.json().catch(()=>null);
    throw Object.assign(Error(value?.error||'交互 Cycles 视口暂不可用'),{status:response.status});
  }

  async function poll(session){
    try{
      while(session===running&&!session.abort.signal.aborted){
        const response=await request(`${session.url}?token=${session.token}&after=${session.after}`,{signal:session.abort.signal});
        await check(response);
        if(response.status===204)continue;
        const sequence=Number(response.headers.get('x-cycles-sequence'));
        const number=Number(response.headers.get('x-cycles-frame'));
        const revision=Number(response.headers.get('x-cycles-revision'));
        const device=response.headers.get('x-cycles-device'),sessionId=response.headers.get('x-cycles-session');
        const sha256=response.headers.get('x-cycles-sha256'),mapResolution=Number(response.headers.get('x-cycles-map-resolution'));
        if(!Number.isSafeInteger(number)||number<=session.after||!device||!sessionId||!(/^[a-f0-9]{64}$/).test(sha256)||
          ![1024,4096].includes(mapResolution))throw Error('交互 Cycles 帧无效');
        session.after=number;
        const view=session.views.get(sequence),blob=await response.blob();
        if(view!==session.target.view||revision!==session.target.revision||session.target.paused||session!==running)continue;
        const url=URL.createObjectURL(blob);
        let accepted=false;
        try{
          const decoded=new Image();decoded.src=url;await decoded.decode();
          if(session!==running||session.abort.signal.aborted||session.target.paused||view!==session.target.view||revision!==session.target.revision)continue;
          const previous=last;
          last={url,view,revision,device,sha256,mapResolution,number,session:sessionId,width:decoded.naturalWidth,height:decoded.naturalHeight};
          image.src=url;accepted=true;
          if(previous)URL.revokeObjectURL(previous.url);
          refresh(session);
        }finally{
          if(!accepted)URL.revokeObjectURL(url);
        }
      }
    }catch(error){fail(session,error);}
  }

  async function send(session){
    session.timer=null;
    if(session.sending||session.abort.signal.aborted)return;
    session.sending=true;
    try{
      while(session===running&&session.sent!==session.target&&!session.timer){
        const target=session.target,sequence=++session.sequence;
        session.views.set(sequence,target.view);
        while(session.views.size>180)session.views.delete(session.views.keys().next().value);
        const {revision,settings,hiddenObjects,quality,paused}=target;
        const response=await request(session.url,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({token:session.token,sequence,revision,settings,hiddenObjects,quality,paused}),signal:session.abort.signal});
        if(response.status===409){
          session.sent=target;
          if(!session.polling)session.views.delete(sequence);
          continue;
        }
        await check(response);
        session.sent=target;
        if(!session.polling){session.polling=true;void poll(session);}
      }
    }catch(error){fail(session,error);}
    finally{session.sending=false;}
  }

  function refresh(session){
    const {target,frozen,showLive,navigating}=session,aligned=last?.view===target.view;
    if(showLive){
      display(null);status('paused',session.inspection?'Cycles · 退出图层检查后恢复':'Cycles · 编辑中');return;
    }
    if(frozen){display(last,aligned);status('frozen',last?`${describe(last)} · 已暂停`:'Cycles · 已暂停');return;}
    // Keep the live camera visible while moving, or until Cycles supplies that pose.
    const showRendered=aligned&&!navigating;
    display(showRendered?last:null,showRendered);
    if(navigating){status('rendering','实时视图 · 导航中');return;}
    if(!last){status('waiting','Cycles · 正在准备交互视口…');return;}
    status(showRendered?'ready':'rendering',showRendered?`${describe(last)} · 交互采样`:'实时视图 · 等待 Cycles 帧…');
  }

  function sync(force=false){
    if(disposed)return;
    const {enabled,input,editing,inspection,frozen,navigating,lastWheelAt=-Infinity,projectId}=read();
    if(!enabled){stop();status('off','');return;}
    if(running?.projectId!==projectId&&running)stop();
    if(!input){
      if(inspection&&running){
        running.inspection=true;running.showLive=true;
        if(!running.target.paused){running.target={...running.target,paused:true};void send(running);}
        if(!running.failed)refresh(running);
        return;
      }
      stop();status(frozen?'frozen':'paused',frozen?'Cycles · 已暂停':'Cycles · 等待三维模型…');return;
    }
    if(force)stop();
    if(running?.failed)return;
    if(frozen&&!running){status('frozen','Cycles · 已暂停');return;}
    const quality=input.detail?'detail':'draft',settings=input.detail?.settings||input.settings;
    const next={view:viewKey(input),revision:input.revision,settings,hiddenObjects:input.hiddenObjects,quality,paused:!!(frozen||editing)};
    const key=JSON.stringify(next);
    if(!running)running={projectId,url:'/api/projects/'+projectId+'/paint/render-session',token:crypto.randomUUID(),
      abort:new AbortController(),sequence:0,after:0,views:new Map()};
    const session=running,ended=session.navigating&&!navigating;
    const newWheelInput=session.lastWheelAt!==lastWheelAt;
    session.lastWheelAt=lastWheelAt;
    session.frozen=frozen;session.showLive=editing;session.inspection=false;session.navigating=navigating;
    if(session.key!==key||session.target.paused!==next.paused){
      session.key=key;session.target=next;
    }
    if(next.paused||ended||newWheelInput){
      clearTimeout(session.timer);session.timer=null;
    }
    if(session.target!==session.sent){
      if(next.paused)void send(session);
      else if(!session.timer){
        // A wheel burst updates WebGL immediately. Send only the last zoom in the burst.
        const wheelDelay=lastWheelAt+wheelQuietMs-performance.now();
        if(wheelDelay>0||!session.sending)
          session.timer=setTimeout(()=>void send(session),wheelDelay>0?wheelDelay:session.sequence&&!ended?16:0);
      }
    }
    refresh(session);
  }

  function pagehide(){stop();}
  window.addEventListener('pagehide',pagehide);
  return {sync,state:()=>state,dispose(){disposed=true;window.removeEventListener('pagehide',pagehide);stop();image.remove();}};
}
