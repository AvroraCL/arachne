import {paintChannels,renderChannel,liveStride} from './paint-channels.mjs';
const encoder=new TextEncoder(),geometryKeys=new WeakMap();
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value)))))
  .map(byte=>byte.toString(16).padStart(2,'0')).join('');

export async function maskThumbnailKey(doc,layer){
  if(!geometryKeys.has(doc))geometryKeys.set(doc,digest([doc.source.files,doc.modeling,doc.paint.surfaceBindings]));
  // Layer color, opacity and mask enablement do not change the raw mask.
  return [doc.id,layer.id,await geometryKeys.get(doc),await digest([
    layer.kind,layer.mask,layer.maskBase,layer.maskStrokes,layer.maskEffects,
    layer.image,layer.projector,layer.space,layer.x,layer.y,layer.scale,layer.rotation,layer.uvScale
  ])].join(':');
}

export async function layerThumbnailKey(doc,layer){
  if(!geometryKeys.has(doc))geometryKeys.set(doc,digest([doc.source.files,doc.modeling,doc.paint.surfaceBindings]));
  const {name,visible,locked,parentId,...content}=layer;
  return [doc.id,'paint-layer',layer.id,await geometryKeys.get(doc),await digest([content,layer.materialId?doc.paint.materials?.[layer.materialId]?.graph:null])].join(':');
}

export function createMaskThumbnails({context,canRun}){
  const cache=new Map();let timer=null,epoch=0,queue=[],running=null,desired=new Map(),suspended=false;
  const panel=document.getElementById('layers'),scrollport=panel?.closest('.dock-content');
  const nodes=()=>Array.from(panel?.querySelectorAll('.layer-mask canvas,.layer-thumb canvas[data-layer-preview]')||[]);
  const keyFor=canvas=>canvas.dataset.thumbnailKey||canvas.dataset.maskThumbnail;
  function applyCanvas(canvas,key,pixels,state){
    canvas.parentElement.dataset.thumbnailState=state;
    canvas.title=state==='failed'?'缩略图未更新；选择图层查看内容':'';
    if(pixels&&canvas.dataset.drawnThumbnail!==key){
      canvas.getContext('2d').putImageData(pixels,0,0);
      canvas.dataset.drawnThumbnail=key;
    }
  }
  function apply(key,pixels,state){
    for(const canvas of nodes())if(keyFor(canvas)===key)applyCanvas(canvas,key,pixels,state);
  }
  function nearPanel(canvas,bounds){
    const rect=canvas.getBoundingClientRect();
    if(!rect.width||!rect.height)return false;
    const top=Math.max(0,bounds?.top??0),bottom=Math.min(innerHeight,bounds?.bottom??innerHeight);
    // The layer list scrolls within its dock. Preload one nearby row for scrolling.
    return rect.bottom>=top-32&&rect.top<=bottom+32;
  }
  function remember(key,value){cache.delete(key);cache.set(key,value);while(cache.size>128)cache.delete(cache.keys().next().value);}
  function pause(){if(running){running.paused=true;running.controller.abort();}}
  async function pump(){
    if(suspended||running||!queue.length)return;
    if(!canRun()){clearTimeout(timer);timer=setTimeout(pump,150);return;}
    const key=queue.shift(),item=desired.get(key);if(!item){void pump();return;}
    if(cache.has(key)){apply(key,cache.get(key),'ready');void pump();return;}
    const request=running={item,controller:new AbortController(),paused:false};
    try{
      const response=await fetch(`/api/projects/${item.project}/paint/live`,{method:'POST',signal:request.controller.signal,
        headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:item.revision,resolution:256,format:'pbr8',
          ...(item.kind==='layer'?{isolatedLayer:item.id,rawLayer:true}:{inspectMask:item.id})})});
      // The project poll will schedule the new revision; no false error badge.
      if(response.status===204)return;
      if(!response.ok)throw Error('缩略图未更新');
      const pixels=new Uint8Array(await response.arrayBuffer());if(![6,15].includes(liveStride(pixels,256)))throw Error('缩略图尺寸无效');
      const source=document.createElement('canvas');source.width=source.height=256;
      const sourceContext=source.getContext('2d'),image=sourceContext.createImageData(256,256);
      renderChannel(pixels,256,item.channel,image.data);
      sourceContext.putImageData(image,0,0);
      const small=document.createElement('canvas');small.width=small.height=64;
      const smallContext=small.getContext('2d');smallContext.drawImage(source,0,0,64,64);
      const result=smallContext.getImageData(0,0,64,64);remember(key,result);apply(key,result,'ready');
    }catch(error){
      if(error.name==='AbortError'){
        if(request.paused&&desired.has(key)&&!queue.includes(key))queue.unshift(key);
      }else apply(key,null,'failed');
    }finally{if(running===request)running=null;void pump();}
  }
  function sync(){
    if(suspended)return;
    const token=++epoch;clearTimeout(timer);
    timer=setTimeout(async()=>{
      try{
        const doc=context();if(!doc){pause();desired.clear();queue=[];return;}
        const next=new Map(),bounds=scrollport?.getBoundingClientRect();
        const layers=new Map(doc.paint.layers.map(layer=>[layer.id,layer]));
        await Promise.all(nodes().map(async canvas=>{
          if(!nearPanel(canvas,bounds))return;
          const id=canvas.closest('.layer-row').dataset.layerId,layer=layers.get(id);if(!layer)return;
          const kind=canvas.hasAttribute('data-layer-preview')?'layer':'mask',key=await(kind==='layer'?layerThumbnailKey(doc,layer):maskThumbnailKey(doc,layer));
          if(token!==epoch||!canvas.isConnected)return;
          canvas.dataset.thumbnailKey=key;if(kind==='mask')canvas.dataset.maskThumbnail=key;
          if(cache.has(key)){applyCanvas(canvas,key,cache.get(key),'ready');return;}
          canvas.parentElement.dataset.thumbnailState='loading';
          next.set(key,{project:doc.id,revision:doc.revision,id,key,kind,channel:kind==='mask'?'color':paintChannels.find(k=>layer.channels[k])||'color'});
        }));
        if(token!==epoch)return;desired=next;
        if(running&&!desired.has(running.item.key))running.controller.abort();
        queue=[...desired.keys()].filter(key=>running?.item.key!==key);void pump();
      }catch{for(const canvas of nodes())canvas.parentElement.dataset.thumbnailState='failed';}
    },120);
  }
  document.addEventListener('scroll',sync,{capture:true,passive:true});
  // Hidden modeling docks have no visible thumbnail boxes. Schedule them again
  // when the layer panel appears or changes size, even without a new revision.
  if(panel){
    const observer=new ResizeObserver(sync);
    observer.observe(panel);
    if(scrollport)observer.observe(scrollport);
  }
  window.addEventListener('pagehide',()=>{suspended=true;epoch++;queue=[];desired.clear();clearTimeout(timer);running?.controller.abort();});
  window.addEventListener('pageshow',()=>{suspended=false;sync();});
  return {sync,pause};
}
