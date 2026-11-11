import {minCyclesViewportDimension} from './cycles-limits.mjs';
import {createInteractiveCyclesViewport} from './paint-cycles-interactive.mjs';

export function cyclesViewportSize(width,height,limit=768){
  const scale=Math.min(limit/Math.max(width,height,1),Math.max(1,minCyclesViewportDimension/Math.max(Math.min(width,height),1)));
  return [width,height].map(value=>Math.max(minCyclesViewportDimension,Math.round(value*scale)));
}

// Each area owns its current camera and request. The WebGL canvas stays live
// beneath the image so navigation and editing can resume immediately.
function createBatchCyclesViewport({host,read,onStatus,onVisibility=()=>{},request=fetch}){
  const image=document.createElement('img');
  image.className='editor-cycles-image';image.alt='当前视角的 Cycles 渲染';image.draggable=false;image.hidden=true;
  host.append(image);
  let key=null,timer=null,controller=null,last=null,disposed=false;
  const settleDelay=120,orbitSettleDelay=240;
  const viewKey=input=>JSON.stringify([input.revision,input.settings.camera,input.aspect,input.hiddenObjects]);
  let state={phase:'off',text:'',retry:false};
  function status(phase,text,retry=false){
    if(state.phase===phase&&state.text===text&&state.retry===retry)return;
    state={phase,text,retry};host.dataset.cyclesState=phase;onStatus(state);
  }
  function stop(){
    clearTimeout(timer);timer=null;controller?.abort();controller=null;
  }
  function hide(){
    if(!image.hidden){image.hidden=true;onVisibility(false);}
    delete host.dataset.cyclesRevision;delete host.dataset.cyclesDevice;delete host.dataset.cyclesSha256;delete host.dataset.cyclesMapResolution;
  }
  function release(){
    hide();
    if(last){URL.revokeObjectURL(last.url);last=null;image.removeAttribute('src');}
  }
  function describe(frame){
    return `Cycles · ${frame.device} · ${frame.width} × ${frame.height} · 贴图 ${frame.mapResolution===4096?'4K':'1K'} · ${frame.samples} 次采样`;
  }
  function show(frame,aligned=true){
    image.hidden=false;onVisibility(true,aligned);
    host.dataset.cyclesRevision=String(frame.revision);host.dataset.cyclesDevice=frame.device;
    host.dataset.cyclesSha256=frame.sha256;host.dataset.cyclesMapResolution=String(frame.mapResolution);
  }
  function ready(frame){
    show(frame);status('ready',describe(frame));
  }
  function refine(input,id){
    if(!input.detail||last?.key!==id||last.quality==='detail')return;
    timer=setTimeout(()=>void render(input,id,'detail'),input.detail.delay);
  }
  async function render(input,id,quality='draft'){
    timer=null;
    const current=new AbortController();controller=current;
    const {projectId,revision,hiddenObjects}=input,settings=quality==='detail'?input.detail.settings:input.settings;
    const matches=()=>!disposed&&!current.signal.aborted&&key===id&&controller===current;
    status(quality==='detail'?'refining':'rendering',quality==='detail'?`${describe(last)} · 正在细化 4K 贴图…`:'Cycles · 正在渲染当前视角…');
    let url;
    try{
      const response=await request('/api/projects/'+projectId+'/paint/render-view',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,settings,hiddenObjects,quality}),signal:current.signal
      });
      if(!matches())return;
      if(response.status===204||response.status===409){hide();status('stale','Cycles · 等待最新工程修订…',true);return;}
      if(!response.ok){
        const value=await response.json().catch(()=>null);throw Error(value?.error||'视口渲染暂不可用');
      }
      const device=response.headers.get('x-cycles-device'),sha256=response.headers.get('x-cycles-sha256');
      const mapResolution=Number(response.headers.get('x-cycles-map-resolution'));
      if(response.headers.get('x-cycles-revision')!==String(revision)||!device||!(/^[a-f0-9]{64}$/).test(sha256)||
         mapResolution!==(quality==='detail'?4096:1024))throw Error('视口画面修订或贴图尺寸不一致');
      const blob=await response.blob();if(!matches())return;
      url=URL.createObjectURL(blob);
      const decoded=new Image();decoded.src=url;await decoded.decode();
      if(!matches())return;
      if(decoded.naturalWidth!==settings.width||decoded.naturalHeight!==settings.height)throw Error('视口画面尺寸不一致');
      const previous=last;
      last={key:id,viewKey:viewKey(input),projectId,url,revision,device,sha256,quality,mapResolution,width:settings.width,height:settings.height,samples:settings.samples};url=null;
      image.src=last.url;ready(last);
      if(previous)URL.revokeObjectURL(previous.url);
      refine(input,id);
    }catch(error){
      if(matches()){
        if(quality==='detail'&&last?.key===id)status('detail-error',`${describe(last)} · 4K 更新失败：${error.message}`,true);
        else status('error',image.hidden?'Cycles · '+error.message:`${describe(last)} · 更新失败：${error.message}`,true);
      }
    }finally{
      if(url)URL.revokeObjectURL(url);
      if(controller===current)controller=null;
    }
  }
  function sync(force=false){
    if(disposed)return;
    const {enabled,projectId,input,navigating,editing,inspection,frozen}=read();
    if(!enabled){key=null;stop();release();status('off','');return;}
    if(last&&last.projectId!==projectId)release();
    if(inspection){
      key=null;stop();hide();status('paused','Cycles · 退出蒙版查看或图层独显后恢复');return;
    }
    if(frozen){
      key=null;stop();
      if(navigating||editing){
        hide();status('frozen','Cycles · 已暂停，操作结束后显示暂停画面');return;
      }
      if(last){
        const aligned=!!input&&last.viewKey===viewKey(input);
        show(last,aligned);
        status('frozen',describe(last)+(aligned?' · 已暂停':' · 已暂停，继续后更新'));
      }else status('frozen','Cycles · 已暂停');
      return;
    }
    if(!input||editing){
      key=null;stop();hide();
      status('paused',editing?'Cycles · 编辑中':'Cycles · 等待三维模型…');return;
    }
    const next=JSON.stringify(input);
    if(!force&&key===next)return;
    key=next;stop();
    if(last?.key===next&&!force){ready(last);refine(input,next);return;}
    if(force&&last?.key===next&&input.detail&&last.quality==='draft'&&state.phase==='detail-error'){
      void render(input,next,'detail');return;
    }
    const aligned=last?.viewKey===viewKey(input);
    if(aligned)show(last);
    else hide();
    status('waiting',aligned?`${describe(last)} · 等待更新…`:'Cycles · 等待渲染…');
    timer=setTimeout(()=>void render(input,next),force?0:navigating?orbitSettleDelay:settleDelay);
  }
  return {sync,state:()=>state,dispose(){disposed=true;stop();release();image.remove();}};
}

let availability;
export function createCyclesViewport(options){
  let preview=null,disposed=false,pending=false;
  return {
    sync(force=false){
      if(disposed)return;
      if(preview){preview.sync(force);return;}
      if(pending||!options.read().enabled)return;
      pending=true;
      availability??=fetch('/api/health').then(response=>response.json()).then(value=>value.interactiveCycles===true,()=>false);
      void availability.then(enabled=>{
        if(disposed)return;
        preview=(enabled?createInteractiveCyclesViewport:createBatchCyclesViewport)(options);
        preview.sync(force);
      });
    },
    state:()=>preview?.state()||{phase:'off',text:'',retry:false},
    dispose(){disposed=true;preview?.dispose();}
  };
}
