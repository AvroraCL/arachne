import {hasWideGamut,imageDisplaySpace,preferredDisplaySpace,writeDisplayRGB} from './image-display-rgb.mjs';
import {previewDimensions,documentFrame} from './image-document-size.mjs';
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

function strokeWindow(edits,visible,bleed=0){
  if(!visible)return;
  const bounds=[4096,4096,0,0];
  for(const {stroke} of edits){
    const reach=(stroke.radius*((stroke.tip?.tipAsset?Math.SQRT2:1)+(stroke.tip?.scatter??0)))*4096+4+bleed;
    for(const stamp of stroke.stamps){
      for(let axis=0;axis<2;axis++){
        const center=stamp[axis]*4096;
        bounds[axis]=Math.min(bounds[axis],center-reach);
        bounds[axis+2]=Math.max(bounds[axis+2],center+reach);
      }
    }
  }
  const ranges=visible.map(([start,end],axis)=>[Math.max(0,start-24,bounds[axis]),Math.min(4096,end+24,bounds[axis+2])]);
  if(ranges.some(([start,end])=>start>=end))return;
  const required=Math.ceil(Math.max(...ranges.map(([start,end])=>end-start)))+2;
  const side=[256,512,768,1024,1536,2048].find(size=>size>=required);
  return side?[...ranges.map(([start,end])=>clamp(Math.round((start+end-side)/2),0,4096-side)),side]:undefined;
}

function draftWindow(edits,state){
  if(edits.every(edit=>edit?.op==='image'&&edit.action==='stroke'&&edit.stroke?.stamps))
    return strokeWindow(edits,state.visiblePixels??(state.nativeCanvas&&state.patchLayer?[[0,detailSize],[0,detailSize]]:null),state.strokeBleed);
  // For a transform or adjustment every visible pixel may change. Use a
  // native window only when its cost is bounded by the ordinary draft size.
  if(!edits.every(edit=>edit?.op==='image'&&!edit.textDraft))return;
  const bounds=edits.length===1&&state.draftBounds?.(edits[0]);
  if(!bounds&&!state.visiblePixels)return;
  const [x,y,w,h]=documentFrame(state.imageGeometry);
  const ranges=(state.visiblePixels??[[x,x+w],[y,y+h]]).map(([start,end],i)=>[
    Math.max(i?y:x,Math.floor(start),bounds?Math.floor(bounds[i]*detailSize)-2:0),
    Math.min(i?y+h:x+w,Math.ceil(end),bounds?Math.ceil(bounds[i+2]*detailSize)+2:detailSize)
  ]);
  if(ranges.some(([start,end])=>end<=start))return;
  const needed=Math.max(...ranges.map(([start,end])=>end-start));
  const side=[256,512,768,1024].find(value=>value>=needed&&value<=(state.fastSize??256));
  if(side)return [...ranges.map(([start,end])=>clamp(Math.floor((start+end-side)/2),0,detailSize-side)),side];
}

function draftTarget(operation){
  if(!operation)return '';
  const edit=Array.isArray(operation)?operation.at(-1):operation;
  return JSON.stringify([edit.op,edit.action,edit.documentId,edit.layerId??edit.id??edit.textDraft?.layerId,edit.target,
    edit.transforms?.flatMap(t=>t.layerIds),edit.patch&&Object.keys(edit.patch)]);
}

export function createLiveView({viewport,canvas,guide,context:readContext,localBrush,onStatus,onFrame=()=>{},renderCanvas=true,rgba=false,retryDelays=defaultRetryDelays}){
  const ctx=canvas.getContext('2d',{alpha:rgba,...(rgba?{colorSpace:preferredDisplaySpace()}:{})});
  const canvasSpace=ctx.getContextAttributes?.().colorSpace??'srgb';
  const guideContext=guide.getContext('2d');
  const page=canvas.ownerDocument;
  let intent=null,inFlight=null,queued=null,detailInFlight=null,baseFrame=null,frame=null,drawn=null;
  let image=null,imageSpace=null,guideFrame=null,detailTimer=null,retryTimer=null,retrying=null;
  let localInk=null;
  let detailFailure=null,fastFailure=null,visible=true,disposed=false,patched=null;
  const context=()=>visible&&!disposed&&!page?.hidden?readContext():null;
  const fastSize=state=>(rgba||state?.textureSet)&&[512,1024].includes(state?.fastSize)?state.fastSize:workingSize;

  function cancelRetry(){if(retryTimer!==null)clearTimeout(retryTimer);retryTimer=null;retrying=null;}
  function cancelPending(){
    inFlight?.controller?.abort();
    detailInFlight?.controller?.abort();
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
    const state=context();
    if(!state)return;
    const request=frame?.request;
    const size=request?.size||0,revision=request?.revision;
    if(!phase&&detailFailure?.key===state.key){
      phase='error';message=detailFailure.message;failedSize=detailSize;
    }else if(!phase&&retrying?.request===intent){
      phase='retrying';message=retrying.message;failedSize=intent.size;
    }
    const refining=detailInFlight?.key===state.key&&detailInFlight.group===intent?.group&&!detailInFlight.controller.signal.aborted;
    phase??=size===detailSize&&request?.key===state.key?'ready':refining?'refining':'fast';
    onStatus(failed?message:request?'实时材质 · r'+revision:'正在准备实时预览…',failed,{size,revision,phase,message,...(rgba&&hasWideGamut(request?.colorSpace)&&!request.inspectMask?{displaySpace:imageSpace}:{}),...(failedSize?{failedSize}:{})});
  }

  function retryTransient(request,error){
    const attempt=request.retries??0;if((error.status!==503&&!error.retryableTransport)||attempt>=retryDelays.length)return false;
    request.retries=attempt+1;retrying={request,message:error.message};
    const delay=Math.max(1,Math.round(retryDelays[attempt]*(.8+Math.random()*.4)));
    retryTimer=setTimeout(()=>{
      retryTimer=null;retrying=null;const state=context();
      if(intent!==request||state?.key!==request.key||(request.size===detailSize&&!state.detail&&!request.manualDetail))return;
      send(request);
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
    if(localInk){
      if(intent?.operation&&request!==intent || localInk.holdKey===state.key&&size!==detailSize&&!request.operation&&state.detail&&!detailFailure)return;
      localInk=null;drawn=null;
    }
    if(patched&&size!==detailSize&&!request.operation&&state.detail&&!detailFailure&&
       patched.holdKey===request.key){
      status('refining');return;
    }
    if(drawn?.pixels===pixels&&drawn.channel===channel&&drawn.solo===solo&&drawn.preview3D===preview3D&&
       (!patched||intent?.operation&&intent.key===request.key))return;
    const [width,height]=previewDimensions(request.imageGeometry,size);
    const displaySpace=imageDisplaySpace(request.inspectMask?null:request.colorSpace,canvasSpace);
    if(!image||canvas.width!==width||canvas.height!==height||imageSpace!==displaySpace){
      canvas.width=width;canvas.height=height;
      image=ctx.createImageData(width,height,{colorSpace:displaySpace});imageSpace=displaySpace;
    }
    if(rgba)writeDisplayRGB(image.data,pixels,request.inspectMask?null:request.colorSpace,state.gamutWarning,displaySpace);else renderChannel(pixels,size,channel,image.data);
    if(channel==='coverage'){
      const stride=liveStride(pixels,size);
      for(let i=0,j=0;i<pixels.length;i+=stride,j+=4){const [r,g,b]=palette[pixels[i+5]&3];image.data[j]=r;image.data[j+1]=g;image.data[j+2]=b;}
    }
    ctx.putImageData(image,0,0);
    patched=null;
    if(!rgba)drawGuide(state.id,pixels,size);
    if(preview3D){
      viewport.showLivePaint(pixels,size,solo?image.data:null,{revision:request.revision,draft:!!request.operation});
      if(!drawn?.preview3D||drawn.solo!==solo)viewport.setUnlit(solo);
    }
    drawn={pixels,channel,solo,preview3D,colorSpace:request.inspectMask?null:request.colorSpace};
    status();
  }

  function drawPatch({request,pixels,window:[x,y,side]},warnGamut){
    const [ox,oy]=documentFrame(request.imageGeometry);
    const space=request.inspectMask?null:request.colorSpace;
    const wide=space&&!['srgb','linear'].includes(space);
    const displaySpace=imageDisplaySpace(space,canvasSpace);
    const tile=wide?ctx.createImageData(side,side,{colorSpace:displaySpace}):new ImageData(new Uint8ClampedArray(pixels.buffer,pixels.byteOffset,pixels.byteLength),side,side);
    if(wide)writeDisplayRGB(tile.data,pixels,space,warnGamut,displaySpace);
    ctx.putImageData(tile,x-ox,y-oy);
  }

  function flush(){
    if(inFlight||!queued)return;
    const request=queued;
    queued=null;inFlight=request;
    void load(request);
  }

  function send(request){
    if(request.size===detailSize){
      detailInFlight=request;
      void load(request);
    }else{
      queued=request;
      flush();
    }
  }

  async function load(request){
    request.controller=new AbortController();
    if(request.size===detailSize)status('refining');
    const {id,revision,inspectMask,isolatedLayer,operation,key,size,window}=request;
    const isCurrent=()=>!request.controller.signal.aborted&&context()?.key===key&&intent?.group===request.group&&
      (!operation||!localInk||request===intent)&&
      (operation||frame?.request.group!==request.group||frame.request.operation||frame.request.size<=size);
    try{
      if(context()?.modeling&&frame?.request.revision!==revision)onStatus('正在更新建模后的材质与表面…');
      const draft=operation?.textDraft?{textDraft:operation.textDraft,documentId:operation.documentId}:
        Array.isArray(operation)?{operations:operation}:{operation};
      const body=JSON.stringify(rgba?{revision,...draft,documentId:request.documentId,inspectMask:request.inspectMask,resolution:request.savedWindow?256:size,window,...(request.imageGeometry?{documentView:true}:{})}:{revision,...draft,textureSet:request.textureSet,inspectMask,isolatedLayer,uvGuide:true,resolution:size,format:'pbr8'});
      const response=await transport(()=>fetch('/api/projects/'+id+'/paint/'+(rgba?'image-live':'live'),{
        method:'POST',headers:{'Content-Type':'application/json'},signal:request.controller.signal,
        body
      }));
      // A superseded response can still have megabytes left to deliver. Release
      // its HTTP connection so subsequent strokes and saves can go through.
      if(!isCurrent()){request.controller.abort();return;}
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
      if(reportedSize&&Number(reportedSize)!==(request.savedWindow?256:size)||reportedRevision&&Number(reportedRevision)!==revision)
        throw Error('实时贴图修订或尺寸不一致');
      if(request.savedWindow&&response.headers.get('X-Paint-Window')!==window.join(',')){
        request.controller.abort();requestFrame(context(),null,detailSize);return;
      }
      const next=new Uint8Array(await transport(()=>response.arrayBuffer()));
      if(window&&response.headers?.get('X-Paint-Window')===window.join(',')){
        if(!isCurrent())return;
        const side=window[2];
        const [ox,oy]=documentFrame(request.imageGeometry);
        const [width,height]=previewDimensions(request.imageGeometry,detailSize);
        if(next.length!==side*side*4||canvas.width!==width||canvas.height!==height||!image)throw Error('局部预览尺寸无效');
        if(request.savedWindow){
          // The receipt advances exactly one saved stroke. Keep the untouched
          // document pixels and replace the complete affected area in both buffers.
          const left=Math.max(0,ox-window[0]),top=Math.max(0,oy-window[1]);
          const right=Math.min(side,ox+width-window[0]),bottom=Math.min(side,oy+height-window[1]);
          const tile=ctx.createImageData(side,side,{colorSpace:imageSpace});
          writeDisplayRGB(tile.data,next,request.inspectMask?null:request.colorSpace,context().gamutWarning,imageSpace);
          for(let y=top;y<bottom&&right>left;y++){
            const offset=((window[1]+y-oy)*width+window[0]+left-ox)*4;
            const start=(y*side+left)*4,end=(y*side+right)*4;
            baseFrame.pixels.set(next.subarray(start,end),offset);
            image.data.set(tile.data.subarray(start,end),offset);
          }
          ctx.putImageData(tile,window[0]-ox,window[1]-oy);
          frame=baseFrame={request,pixels:baseFrame.pixels};
          patched=localInk=null;detailFailure=null;
          onFrame({request,pixels:next,window});status();return;
        }
        if(patched&&patched.request.key===key&&patched.window.join(',')!==window.join(',')){
          const [left,top,side]=patched.window;
          ctx.putImageData(image,0,0,left-ox,top-oy,side,side);
        }
        const patch={window,request,pixels:next};
        drawPatch(patch,context().gamutWarning);
        localInk=null;
        patched=!request.inspectMask&&hasWideGamut(request.colorSpace)?patch:{window,request};
        onFrame({request,pixels:next,window});
        return;
      }
      const [width,height]=previewDimensions(request.imageGeometry,size);
      if(rgba?next.length!==width*height*4:![6,15].includes(liveStride(next,size)))throw Error('实时贴图尺寸无效');
      if(!isCurrent())return;
      if(size===detailSize)detailFailure=null;
      const candidate={request,pixels:next},previousFrame=frame,previousDrawn=drawn;onFrame(candidate);
      if(!isCurrent())return;
      frame=candidate;
      try{draw();}catch(error){frame=previousFrame;drawn=previousDrawn;throw error;}
      if(!operation){
        baseFrame=candidate;
        if(size===detailSize){
          // A late fast response for this revision must not replace this frame.
          if(inFlight?.group===request.group)inFlight.controller.abort();
          if(queued?.group===request.group)queued=null;
        }
      }
    }catch(error){
      if(error.name==='AbortError'||request.controller.signal.aborted||intent!==request||context()?.key!==key)return;
      if(retryTransient(request,error))return;
      if(size===detailSize){
        detailFailure={key,message:error.message};
        if(patched)draw();
        status('error',error.message,size);
      }else if(error.status!==409){fastFailure={key,request,message:error.message};status('error',error.message,size,true);}
    }finally{
      if(inFlight===request)inFlight=null;
      if(detailInFlight===request)detailInFlight=null;
      flush();
      scheduleDetail();
    }
  }

  function requestFrame(state,operation,size=state.nativeCanvas&&!operation?detailSize:fastSize(state),savedWindow){
    cancelRetry();fastFailure=null;
    // Consecutive moves in one gesture can display intermediate frames. A
    // cancel, revision change or source switch invalidates the whole gesture.
    const target=draftTarget(operation);
    const continued=intent?.key===state.key&&intent.target===target;
    if(!continued||size===detailSize){
      clearTimeout(detailTimer);
      detailTimer=null;
    }
    if(!continued)inFlight?.controller.abort();
    detailInFlight?.controller.abort();
    if(size!==detailSize)detailFailure=null;
    const strokes=Array.isArray(operation)?operation:[operation];
    // A later stroke can land before the preceding full-size save is displayed.
    // Its worker tile already includes the saved history for the new revision.
    const previous=frame?.request;
    const nativeSurface=previous?.size===detailSize&&(previous.key===state.key||
      state.nativeCanvas&&strokes.every(edit=>edit?.op==='image'&&edit.action==='stroke')&&
      previous.id===state.id&&previous.documentId===state.documentId&&
      previous.inspectMask===state.inspectMask&&previous.colorSpace===state.colorSpace&&
      JSON.stringify(previous.imageGeometry)===JSON.stringify(state.imageGeometry));
    const window=savedWindow??(rgba&&nativeSurface&&operation?draftWindow(strokes,state):undefined);
    intent={...state,operation,target,size,window,savedWindow,manualDetail:size===detailSize&&!state.detail,group:continued?intent.group:Symbol()};
    if(operation&&localBrush){
      const sameCanvas=frame?.request.id===state.id&&frame.request.documentId===state.documentId&&frame.request.inspectMask===state.inspectMask;
      const patch=localBrush(strokes);
      if(patch&&(sameCanvas||patch.empty)){
        const [ox,oy]=documentFrame(state.imageGeometry),[x,y,w,h]=patch.box;
        const [width,height]=previewDimensions(state.imageGeometry,detailSize);
        if(!sameCanvas){canvas.width=width;canvas.height=height;}
        else if(canvas.width!==width||canvas.height!==height){
          const previous=page.createElement('canvas');
          previous.width=canvas.width;previous.height=canvas.height;
          previous.getContext('2d',{colorSpace:canvasSpace}).drawImage(canvas,0,0);
          canvas.width=width;canvas.height=height;
          ctx.drawImage(previous,0,0,width,height);
        }
        const space=state.inspectMask?null:state.colorSpace,displaySpace=imageDisplaySpace(space,canvasSpace);
        const dirty=new ImageData(patch.pixels,w,h,{colorSpace:displaySpace});
        if(space&&space!=='srgb'&&space!=='linear')writeDisplayRGB(dirty.data,patch.pixels,space,state.gamutWarning,displaySpace);
        ctx.putImageData(dirty,x-ox,y-oy);
        localInk={request:intent};
      }
    }
    if(!operation&&baseFrame&&baseFrame.request.size>=size&&
       (baseFrame.request.key===state.key||baseFrame.request.key===state.reuseKey)){
      queued=null;
      intent={...intent,size:baseFrame.request.size};
      const restored={...baseFrame,request:intent},previousFrame=frame,previousDrawn=drawn;
      try{
        onFrame(restored);if(context()?.key!==state.key||intent!==restored.request)return;
        frame=restored;draw();baseFrame=restored;
      }catch(error){
        frame=previousFrame;drawn=previousDrawn;if(context()?.key!==state.key||intent!==restored.request)return;
        fastFailure={key:state.key,request:intent,message:error.message};status('error',error.message,restored.request.size,true);return;
      }
      status();
      scheduleDetail();
      return;
    }
    send(intent);
    scheduleDetail();
  }

  function scheduleDetail(){
    const state=context();
    if(detailTimer!==null||!state?.detail||intent?.key!==state.key||intent.operation||intent.size===detailSize||
       detailFailure?.key===state.key||baseFrame?.request.key===state.key&&baseFrame.request.size>=detailSize)return;
    // Count idle time from the committed revision while its fast frame loads.
    const group=intent.group;
    detailTimer=setTimeout(()=>{
      detailTimer=null;
      const latest=context();
      if(latest?.key===state.key&&latest.detail&&intent?.group===group)requestFrame(latest,null,detailSize);
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
      else if(retryTimer===null&&fastFailure?.request!==intent&&detailFailure?.key!==state.key&&frame?.request!==intent&&!queued&&!inFlight&&!detailInFlight)requestFrame(state,intent.operation);
      draw();
      if(!inFlight&&!queued){
        if(retryTimer!==null&&retrying?.request===intent)status('retrying',retrying.message,intent.size);
        else if(fastFailure?.request===intent)status('error',fastFailure.message,intent.size,true);
        else if(detailFailure?.key===state.key)status('error',detailFailure.message,detailSize);
        else if(intent?.size===detailSize&&frame?.request.size!==detailSize)status('refining');
      }
      scheduleDetail();
    },
    displayChanged(){
      const state=context();
      if(!rgba||!hasWideGamut(drawn?.colorSpace)||!image||!state)return;
      writeDisplayRGB(image.data,drawn.pixels,drawn.colorSpace,state.gamutWarning,imageSpace);
      ctx.putImageData(image,0,0);
      if(patched?.pixels)drawPatch(patched,state.gamutWarning);
    },
    interactionResolutionChanged(){
      const state=context();
      if(!state||intent?.key!==state.key)return;
      const edits=Array.isArray(intent.operation)?intent.operation:[intent.operation];
      const moved=frame?.request.size===detailSize&&intent.operation&&state.visiblePixels&&intent.window?.join(',')!==draftWindow(edits,state)?.join(',');
      if(moved||intent.size<fastSize(state))requestFrame(state,intent.operation);
    },
    preferencesChanged(){
      detailFailure=null;
      clearTimeout(detailTimer);detailTimer=null;
      if(!context()?.detail){
        if(retrying?.request.size===detailSize&&!retrying.request.manualDetail){const request=retrying.request;cancelRetry();if(intent===request)intent={...intent,size:workingSize,group:Symbol()};}
        if(detailInFlight&&!detailInFlight.manualDetail&&!detailInFlight.controller.signal.aborted){
          detailInFlight.controller.abort();
          if(intent===detailInFlight){
            const fast=queued??inFlight;
            intent=fast?.group===intent.group?fast:{...intent,size:fastSize(context())};
          }
        }
        if(frame)status();
      }else{
        if(intent?.size===detailSize&&frame?.request.size!==detailSize&&(!detailInFlight||detailInFlight.controller.signal.aborted))
          intent={...intent,size:workingSize};
        scheduleDetail();
      }
    },
    retryDetail(){
      const state=context();
      if(!state||inFlight||queued||(detailInFlight&&!detailInFlight.controller.signal.aborted))return;
      if(retryTimer!==null&&retrying?.request===intent){const request=retrying.request;requestFrame(state,request.operation,request.size);}
      else if(fastFailure?.request===intent)requestFrame(state,intent.operation,intent.size);
      else if(!intent?.operation){detailFailure=null;requestFrame(state,null,detailSize);}
    },
    sampleMaterial(u,v){
      const state=context();
      return state&&!state.inspectMask&&frame?.request.key===state.key?sampleMaterialFrame(frame,u,v):null;
    },
    update(operation,committedStroke){
      const state=context();
      if(!state)return;
      // Keep exact pixels through their own save. Later edits must show their
      // fast frame even when a previous patch is still waiting for detail.
      if(localInk&&committedStroke&&localInk.request.revision+1===state.revision&&localInk.request.id===state.id&&
         localInk.request.documentId===state.documentId&&localInk.request.inspectMask===state.inspectMask&&
         JSON.stringify(localInk.request.operation)===JSON.stringify(committedStroke))localInk.holdKey=state.key;
      if(patched && committedStroke && patched.request.revision+1===state.revision &&
         patched.request.id===state.id && patched.request.documentId===state.documentId &&
         patched.request.inspectMask===state.inspectMask &&
         JSON.stringify(patched.request.operation)===JSON.stringify(committedStroke))
        patched.holdKey=state.key;
      const before=baseFrame?.request;
      if(!operation&&state.nativeCanvas&&committedStroke?.stroke?.stamps&&before?.size===detailSize&&
         before.revision+1===state.revision&&before.id===state.id&&before.documentId===state.documentId&&
         before.inspectMask===state.inspectMask&&state.patchLayer===committedStroke.layerId&&
         (committedStroke.target!=='mask'||intent?.maskEnabled)&&image&&drawn?.pixels===baseFrame.pixels&&
         !committedStroke.stroke.clone){
        // Use the whole stroke, including off-screen stamps and mask feather.
        const box=strokeWindow([committedStroke],[[0,detailSize],[0,detailSize]],state.strokeBleed);
        if(box){requestFrame(state,null,detailSize,box);return;}
      }
      requestFrame(state,operation);
    },
    clear(){
      cancelPending();baseFrame=null;frame=null;drawn=null;patched=null;localInk=null;
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
