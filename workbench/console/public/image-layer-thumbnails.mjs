const size=64;
const retryDelays=[150,300,600,1200,2400,4000,4000,4000];
const cache=new Map();
const canvases=new WeakMap();
let tail=Promise.resolve();

function thumbnailKey(slot,colorSpace,layer,mask){
  const maskContent=[layer.maskBase,layer.maskStrokes,layer.maskGradient];
  const content=mask?maskContent:[
    layer.kind,layer.visible,layer.opacity,layer.strokes,layer.gradient,
    layer.kind==='image'?[layer.asset,layer.x,layer.y,layer.scale,layer.rotation,layer.stretch]:null,
    layer.maskEnabled?maskContent:null
  ];
  return JSON.stringify([slot,colorSpace,content]);
}

function cachedPixels(slot,key){
  const entry=cache.get(slot);
  if(entry?.key!==key)return null;
  cache.delete(slot);
  cache.set(slot,entry);
  return entry.pixels;
}

function draw(canvas,state,key,pixels){
  if(canvas.width!==size||canvas.height!==size)canvas.width=canvas.height=size;
  canvas.getContext('2d').putImageData(pixels,0,0);
  state.shown=key;
}

export function pauseImageThumbnail(canvas){
  const state=canvases.get(canvas),request=state?.request;
  if(!request)return;
  state.request=null;
  request.controller.abort();
  clearTimeout(request.timer);
}

export function updateImageThumbnail(canvas,{projectId,revision,documentId,colorSpace},layer,mask=false){
  const slot=JSON.stringify([projectId,documentId,layer.id,mask]);
  const key=thumbnailKey(slot,colorSpace,layer,mask);
  let state=canvases.get(canvas);
  if(!state){state={shown:null,request:null};canvases.set(canvas,state);}
  if(state.request?.key===key){state.request.revision=revision;return;}
  pauseImageThumbnail(canvas);
  if(state.shown===key)return;
  const pixels=cachedPixels(slot,key);
  if(pixels){
    draw(canvas,state,key,pixels);
    return;
  }
  const request={key,revision,controller:new AbortController(),timer:null};
  state.request=request;
  const current=()=>canvas.isConnected&&state.request===request;
  function queue(attempt=0){
    tail=tail.catch(()=>{}).then(async()=>{
      if(!current())return;
      let deferred=false;
      try{
        const cached=cachedPixels(slot,key);
        if(cached){draw(canvas,state,key,cached);return;}
        const sentRevision=request.revision;
        const response=await fetch('/api/projects/'+projectId+'/paint/image-live',{
          method:'POST',
          signal:request.controller.signal,
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            revision:sentRevision,documentId,isolatedImageLayer:layer.id,resolution:size,
            ...(mask?{inspectMask:layer.id}:{})
          })
        });
        if(!current())return;
        if(response.status===204&&request.revision!==sentRevision){deferred=true;queue(attempt);return;}
        if(response.status===503){deferred=retry(attempt);return;}
        if(!response.ok||response.status===204)return;
        const bytes=await response.arrayBuffer();
        if(!current()||bytes.byteLength!==size*size*4)return;
        const pixels=new ImageData(new Uint8ClampedArray(bytes),size,size);
        cache.delete(slot);
        cache.set(slot,{key,pixels});
        while(cache.size>128)cache.delete(cache.keys().next().value);
        draw(canvas,state,key,pixels);
      }catch(error){
        if(error.name==='TypeError')deferred=retry(attempt);
      }finally{
        if(current()&&!deferred)state.request=null;
      }
    });
  }
  function retry(attempt){
    if(!current()||attempt>=retryDelays.length)return false;
    const delay=Math.round(retryDelays[attempt]*(.8+Math.random()*.4));
    request.timer=setTimeout(()=>{
      request.timer=null;
      queue(attempt+1);
    },delay);
    return true;
  }
  queue();
}
