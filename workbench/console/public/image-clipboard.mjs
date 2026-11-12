import {uvShapePayload} from './uv-selection-region.mjs';

const resolution=4096;
const listeners=new Set();
let clipboard=null,request=null;

function bounds({clip,feather}){
  const pad=feather?Math.ceil(3*feather)+1:0;
  return clip.map((value,index)=>Math.max(0,Math.min(resolution,
    Math.ceil(value*resolution-.5)+(index<2?-pad:pad))));
}

export function imageClipboardPlacement(width,height,center=[.5,.5]){
  return {x:center[0],y:center[1],scale:Math.max(width,height)/resolution};
}

export async function clipboardPngSize(file){
  if(file.size<24)throw Error('剪贴板 PNG 无效');
  const header=new DataView(await file.slice(0,24).arrayBuffer());
  if(header.getUint32(0)!==0x89504e47||header.getUint32(4)!==0x0d0a1a0a)throw Error('剪贴板 PNG 无效');
  const width=header.getUint32(16),height=header.getUint32(20);
  if(!width||!height||width>8192||height>8192)throw Error('剪贴板 PNG 尺寸无效');
  return [width,height];
}

export function copyImagePixels(origin,region,{merged=false}={}){
  const {clip}=region;
  request?.abort();
  const controller=request=new AbortController();
  const [left,top,right,bottom]=bounds(region);
  const copied=(async()=>{
    const response=await fetch('/api/projects/'+origin.id+'/paint/image-clipboard',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
      body:JSON.stringify({revision:origin.revision,documentId:origin.documentId,
        ...(merged?{merged}:{layerId:origin.layerId}),rect:clip,...uvShapePayload(region)})
    });
    if(response.status===204)throw Error('图像已变化，请重新复制');
    if(!response.ok)throw Error((await response.json()).error||'复制图像失败');
    const blob=await response.blob();
    if(controller.signal.aborted)throw new DOMException('复制已取消','AbortError');
    const file=new File([blob],'粘贴图像.png',{type:'image/png'});
    const [width,height]=await clipboardPngSize(file);
    if(request!==controller)throw new DOMException('复制已取消','AbortError');
    clipboard={file,projectId:origin.id,documentId:origin.documentId,width,height,
      center:[(left+right)/(2*resolution),(top+bottom)/(2*resolution)]};
    for(const listener of listeners)listener();
    return clipboard;
  })();
  if(navigator.clipboard?.write&&typeof ClipboardItem==='function'){
    const png=copied.then(value=>value.file);
    void png.catch(()=>{});
    try{void navigator.clipboard.write([new ClipboardItem({'image/png':png})]).catch(()=>{});}catch{}
  }
  return copied.finally(()=>{if(request===controller)request=null;});
}

export const copiedImage=()=>clipboard;
export function onImageClipboardChange(listener){
  listeners.add(listener);
  return ()=>listeners.delete(listener);
}
