import {renderChannel,liveStride,effectiveValues,channelSpecs,paintChannels} from './paint-channels.mjs';
const workingSize=256,detailSize=4096;
const defaultRetryDelays=[150,300,600,1200,2400,4000,4000,4000];
const palette=[[0,0,0],[232,92,72],[235,169,60],[63,215,182]];
const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));
const srgbToLinear=value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
const linearToSrgb=value=>value<=.0031308?12.92*value:1.055*value**(1/2.4)-.055;

export function sampleMaterialFrame(frame,u,v){
  if(!frame||frame.request.operation||frame.request.inspectMask||!Number.isFinite(u)||!Number.isFinite(v))return null;
  const {pixels,request:{size}}=frame,stride=liveStride(pixels,size);
  if(stride!==6&&stride!==15)return null;
  // Match the viewport's UV orientation and bilinear texture sampling.
  const x=clamp(u*size-.5,0,size-1),y=clamp(v*size-.5,0,size-1);
  const left=Math.floor(x),top=Math.floor(y),right=Math.min(size-1,left+1),bottom=Math.min(size-1,top+1);
  const mix=(a,b,t)=>a+(b-a)*t;
  function sample(channel,srgb=false){
    const at=(column,row)=>{
      const value=pixels[(row*size+column)*stride+channel]/255;
      return srgb?srgbToLinear(value):value;
    };
    return mix(mix(at(left,top),at(right,top),x-left),mix(at(left,bottom),at(right,bottom),x-left),y-top);
  }
  const values=effectiveValues();
  for(const name of paintChannels){
    const {offset,type,srgb}=channelSpecs[name];
    if(offset>=stride)continue;
    if(type==='scalar'){values[name]=sample(offset);continue;}
    const color=[0,1,2].map(channel=>{
      const value=sample(offset+channel,srgb);
      return Math.round((srgb?linearToSrgb(value):value)*255).toString(16).padStart(2,'0');
    });
    values[name]='#'+color.join('');
  }
  return values;
}

export function createLiveView({viewport,canvas,guide,context:readContext,onStatus,onFrame=()=>{},renderCanvas=true,rgba=false,retryDelays=defaultRetryDelays}){
  const ctx=canvas.getContext('2d',{alpha:rgba});
  const guideContext=guide.getContext('2d');
  const page=canvas.ownerDocument;
  let intent=null,inFlight=null,queued=null,baseFrame=null,frame=null,drawn=null;
  let image=null,guideFrame=null,detailTimer=null,retryTimer=null,retrying=null;
  let detailFailure=null,fastFailure=null,visible=true,disposed=false;
  const context=()=>visible&&!disposed&&!page?.hidden?readContext():null;

  function cancelRetry(){if(retryTimer!==null)clearTimeout(retryTimer);retryTimer=null;retrying=null;}
  function cancelPending(){
    inFlight?.controller?.abort();
    cancelRetry();intent=null;queued=null;detailFailure=null;fastFailure=null;
    clearTimeout(detailTimer);detailTimer=null;
  }
  async function transport(action){try{return await action();}catch(error){if(error?.name==='TypeError')throw Object.assign(Error(error.message),{retryableTransport:true,cause:error});throw error;}}

  function drawGuide(project,pixels,size){
    if(guideFrame?.project===project&&guideFrame.size>=size)return;
    guide.width=guide.height=size;
    const guideImage=guideContext.createImageData(size,size);
    const stride=liveStride(pixels,size);
    const eligible=i=>(pixels[i*stride+5]&4)!==0;
    for(let i=0;i<size*size;i++){
      const x=i%size,y=Math.floor(i/size);
      const boundary=eligible(i)&&(x===0||x===size-1||y===0||y===size-1||
        !eligible(i-1)||!eligible(i+1)||!eligible(i-size)||!eligible(i+size));
      if(boundary){const j=i*4;guideImage.data[j]=guideImage.data[j+1]=guideImage.data[j+2]=240;guideImage.data[j+3]=125;}
    }
    guideContext.putImageData(guideImage,0,0);
    guideFrame={project,size};
  }

  function status(phase,message,failedSize,failed=false){
    if(!context())return;
    const request=frame?.request;
    const size=request?.size||0,revision=request?.revision;
    phase??=size===detailSize?'ready':'fast';
    onStatus(failed?message:request?'实时材质 · r'+revision:'正在准备实时预览…',failed,{size,revision,phase,message,...(failedSize?{failedSize}:{})});
  }

  function retryTransient(request,error){
    const attempt=request.retries??0;if((error.status!==503&&!error.retryableTransport)||attempt>=retryDelays.length)return false;
    request.retries=attempt+1;retrying={request,message:error.message};
    const delay=Math.max(1,Math.round(retryDelays[attempt]*(.8+Math.random()*.4)));
    retryTimer=setTimeout(()=>{
      retryTimer=null;retrying=null;const state=context();
      if(intent!==request||state?.key!==request.key||(request.size===detailSize&&!state.detail&&!request.manualDetail))return;
      queued=request;void flush();
    },delay);
    status('retrying',error.message,request.size);return true;
  }

  function draw(){
    const state=context();
    if(!state||frame?.request.key!==state.key)return;
    if(!renderCanvas){status();return;}
    const {pixels,request}=frame,{size}=request;
    const channel=state.inspectMask?'color':state.channel;
    const solo=!!(state.inspectMask||state.solo);
    const {preview3D}=state;
    if(drawn?.pixels===pixels&&drawn.channel===channel&&drawn.solo===solo&&drawn.preview3D===preview3D)return;
    if(!image||canvas.width!==size){
      canvas.width=canvas.height=size;
      image=ctx.createImageData(size,size);
    }
    if(rgba)image.data.set(pixels);else renderChannel(pixels,size,channel,image.data);
    if(channel==='coverage'){
      const stride=liveStride(pixels,size);
      for(let i=0,j=0;i<pixels.length;i+=stride,j+=4){const [r,g,b]=palette[pixels[i+5]&3];image.data[j]=r;image.data[j+1]=g;image.data[j+2]=b;}
    }
    ctx.putImageData(image,0,0);
    if(!rgba)drawGuide(state.id,pixels,size);
    if(preview3D){
      viewport.showLivePaint(pixels,size,solo?image.data:null,{revision:request.revision,draft:!!request.operation});
      if(!drawn?.preview3D||drawn.solo!==solo)viewport.setUnlit(solo);
    }
    drawn={pixels,channel,solo,preview3D};
    status();
  }

  async function flush(){
    if(inFlight||!queued)return;
    const request=queued;
    queued=null;inFlight=request;
    request.controller=new AbortController();
    if(request.size===detailSize)status('refining');
    const {id,revision,inspectMask,isolatedLayer,operation,key,size}=request;
    const isCurrent=()=>!request.controller.signal.aborted&&context()?.key===key&&intent?.group===request.group;
    try{
      if(context()?.modeling&&frame?.request.revision!==revision)onStatus('正在更新建模后的材质与表面…');
      const draft=Array.isArray(operation)?{operations:operation}:{operation};
      const body=JSON.stringify(rgba?{revision,...draft,documentId:request.documentId,inspectMask:request.inspectMask,resolution:size}:{revision,...draft,inspectMask,isolatedLayer,uvGuide:true,resolution:size,format:'pbr8'});
      const response=await transport(()=>fetch('/api/projects/'+id+'/paint/'+(rgba?'image-live':'live'),{
        method:'POST',headers:{'Content-Type':'application/json'},signal:request.controller.signal,
        body
      }));
      if(!isCurrent())return;
      if(response.status===204){
        if(size===detailSize&&context()?.key===key)throw Error('修订已更新，正在等待同步');
        return;
      }
      if(!response.ok){
        let message='实时预览请求失败（'+response.status+'）';try{const result=await response.json();if(typeof result?.error==='string')message=result.error;}catch{}
        throw Object.assign(Error(message),{status:response.status});
      }
      const reportedSize=response.headers?.get('X-Paint-Resolution');
      const reportedRevision=response.headers?.get('X-Paint-Revision');
      if(reportedSize&&Number(reportedSize)!==size||reportedRevision&&Number(reportedRevision)!==revision)
        throw Error('实时贴图修订或尺寸不一致');
      const next=new Uint8Array(await transport(()=>response.arrayBuffer()));
      if(rgba?next.length!==size*size*4:![6,15].includes(liveStride(next,size)))throw Error('实时贴图尺寸无效');
      if(!isCurrent())return;
      detailFailure=null;
      const candidate={request,pixels:next},previousFrame=frame,previousDrawn=drawn;onFrame(candidate);
      if(!isCurrent())return;
      frame=candidate;
      try{draw();}catch(error){frame=previousFrame;drawn=previousDrawn;throw error;}
      if(!operation)baseFrame=candidate;
    }catch(error){
      if(error.name==='AbortError'||request.controller.signal.aborted||intent!==request||context()?.key!==key)return;
      if(retryTransient(request,error))return;
      if(size===detailSize){
        detailFailure={key,message:error.message};
        status('error',error.message,size);
      }else if(error.status!==409){fastFailure={key,request,message:error.message};status('error',error.message,size,true);}
    }finally{
      inFlight=null;
      if(queued)void flush();
      else scheduleDetail();
    }
  }

  function requestFrame(state,operation,size=workingSize){
    cancelRetry();fastFailure=null;
    clearTimeout(detailTimer);
    detailTimer=null;
    // Consecutive moves in one gesture can display intermediate frames. A
    // cancel, revision change or source switch invalidates the whole gesture.
    const continued=intent?.key===state.key&&Boolean(intent.operation)===Boolean(operation);
    if(inFlight&&(inFlight.size===detailSize||!continued||inFlight.key!==state.key))inFlight.controller?.abort();
    if(size!==detailSize)detailFailure=null;
    intent={...state,operation,size,manualDetail:size===detailSize&&!state.detail,group:continued?intent.group:Symbol()};
    if(!operation&&baseFrame?.request.key===state.key&&baseFrame.request.size>=size){
      queued=null;
      intent={...intent,size:baseFrame.request.size};
      const restored={...baseFrame,request:intent},previousFrame=frame,previousDrawn=drawn;
      try{
        onFrame(restored);if(context()?.key!==state.key||intent!==restored.request)return;
        frame=restored;draw();
      }catch(error){
        frame=previousFrame;drawn=previousDrawn;if(context()?.key!==state.key||intent!==restored.request)return;
        fastFailure={key:state.key,request:intent,message:error.message};status('error',error.message,restored.request.size,true);return;
      }
      status();
      scheduleDetail();
      return;
    }
    queued=intent;
    void flush();
  }

  function scheduleDetail(){
    const state=context();
    if(detailTimer!==null||retryTimer!==null||!state?.detail||detailFailure?.key===state.key||intent?.operation||intent?.size===detailSize||
       inFlight||queued||baseFrame?.request.key!==state.key||baseFrame.request.size>=detailSize)return;
    const previous=intent;
    detailTimer=setTimeout(()=>{
      detailTimer=null;
      const latest=context();
      if(latest?.key===state.key&&latest.detail&&intent===previous)requestFrame(latest,null,detailSize);
    },state.detailDelay??900);
  }

  function suspend(){
    cancelPending();
    if(frame&&!frame.request.operation)intent=frame.request;
  }
  function onPageVisibility(){
    if(page.hidden)suspend();
    else view.refresh();
  }
  const view={getFrame:()=>frame,
    setVisible(next){
      if(visible===next)return;
      visible=next;
      if(!visible)suspend();
    },
    refresh(){
      const state=context();
      if(!state)return;
      if(intent?.key!==state.key)requestFrame(state);
      else if(retryTimer===null&&fastFailure?.request!==intent&&detailFailure?.key!==state.key&&frame?.request!==intent&&!queued&&!inFlight)requestFrame(state,intent.operation);
      draw();
      if(!inFlight&&!queued){
        if(retryTimer!==null&&retrying?.request===intent)status('retrying',retrying.message,intent.size);
        else if(fastFailure?.request===intent)status('error',fastFailure.message,intent.size,true);
        else if(detailFailure?.key===state.key)status('error',detailFailure.message,detailSize);
        else if(intent?.size===detailSize&&frame?.request.size!==detailSize)status('refining');
      }
      scheduleDetail();
    },
    preferencesChanged(){
      detailFailure=null;
      clearTimeout(detailTimer);detailTimer=null;
      if(!context()?.detail){
        if(retrying?.request.size===detailSize&&!retrying.request.manualDetail){const request=retrying.request;cancelRetry();if(intent===request)intent={...intent,size:workingSize,group:Symbol()};}
        if(queued?.size===detailSize&&!queued.manualDetail)queued=null;
        if(inFlight?.size===detailSize&&!inFlight.manualDetail){
          inFlight.controller?.abort();
          // Invalidate this generation even if a transport delivers after abort.
          intent={...intent,group:Symbol()};
        }
        if(frame)status();
      }else{
        if(intent?.size===detailSize&&frame?.request.size!==detailSize&&(!inFlight||inFlight.controller?.signal.aborted))
          intent={...intent,size:workingSize};
        scheduleDetail();
      }
    },
    retryDetail(){
      const state=context();
      if(!state||inFlight||queued)return;
      if(retryTimer!==null&&retrying?.request===intent){const request=retrying.request;requestFrame(state,request.operation,request.size);}
      else if(fastFailure?.request===intent)requestFrame(state,intent.operation,intent.size);
      else if(!intent?.operation){detailFailure=null;requestFrame(state,null,detailSize);}
    },
    sampleMaterial(u,v){
      const state=context();
      return state&&!state.inspectMask&&frame?.request.key===state.key?sampleMaterialFrame(frame,u,v):null;
    },
    update(operation){
      const state=context();
      if(!state)return;
      requestFrame(state,operation);
    },
    clear(){
      cancelPending();baseFrame=null;frame=null;drawn=null;
      onStatus('',false,{size:0,phase:'hidden'});
      guideFrame=null;
      viewport.showLivePaint(null);
      ctx.clearRect(0,0,canvas.width,canvas.height);
      guideContext.clearRect(0,0,guide.width,guide.height);
    },
    dispose(){
      if(disposed)return;
      disposed=true;
      page?.removeEventListener('visibilitychange',onPageVisibility);
      view.clear();
    }
  };
  page?.addEventListener('visibilitychange',onPageVisibility);
  return view;
}
