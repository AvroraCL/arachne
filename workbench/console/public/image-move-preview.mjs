// Prepare the moving layer and the exposed background once per selection.
// The saved canvas supplies the background outside the original layer bounds.
import {placedImageBounds} from './image-layout.mjs';
import {documentFrame,editingSide as grid} from './image-document-size.mjs';
import {decodeComponent,encodeComponent} from './image-display-rgb.mjs';

const overlaps=(a,b)=>a[0]<b[2]&&b[0]<a[2]&&a[1]<b[3]&&b[1]<a[3];
const enabledStyle=l=>Object.values(l.styles??{}).some(style=>style.enabled);
const pixelBounds=box=>box.map((v,i)=>i<2?Math.floor(v*grid)-2:Math.ceil(v*grid)+2);
const curves=new Map();
function colorCurve(space){
  if(!curves.has(space))curves.set(space,{
    linear:Float32Array.from({length:256},(_,i)=>space==='linear'?i/255:decodeComponent(i/255,space)),
    byte:Uint8ClampedArray.from({length:65536},(_,i)=>255*(space==='linear'?i/65535:encodeComponent(i/65535,space)))
  });
  return curves.get(space);
}

export function moveSource(image,id,assets){
  const layer=image.layers.find(l=>l.id===id);
  if(!layer?.visible||layer.locked||!layer.opacity||layer.parentId||layer.clipped||layer.blend!=='normal'||layer.blendIf||layer.edgeDecontaminate||
     layer.maskEnabled&&layer.maskLinked===false||enabledStyle(layer)||layer.warp||!['shape','image'].includes(layer.kind))return;
  const [ox,oy,w,h]=documentFrame(image);
  if(w!==image.width||h!==image.height||![ox,oy,w,h].every(Number.isInteger)||!['srgb','linear'].includes(image.colorSpace))return;
  const bounds=placedImageBounds(layer,assets);
  if(!bounds)return;
  const rect=pixelBounds(bounds);
  if(rect[0]<ox||rect[1]<oy||rect[2]>ox+w||rect[3]>oy+h)return;
  const front=[];
  for(const l of image.layers.slice(image.layers.indexOf(layer)+1)){
    if(!l.visible||!l.opacity||l.parentId)continue;
    if(l.kind==='pixel'&&!l.raster&&!l.strokes?.length&&!enabledStyle(l)&&!l.clipped)continue;
    const b=placedImageBounds(l,assets);
    if(!b||l.clipped||enabledStyle(l)||l.warp||l.gradient?.feather)return;
    front.push(pixelBounds(b));
  }
  const side=[256,512,768,1024,1536,2048].find(n=>n>=Math.max(rect[2]-rect[0],rect[3]-rect[1]));
  // For disjoint artwork we already have both the layer and its transparent
  // backdrop in the saved frame. No preparation request is needed.
  const obstacles=[];
  const separate=image.layers.every(other=>{
    if(other===layer||!other.visible||!other.opacity)return true;
    if(enabledStyle(other)||other.warp||other.gradient?.feather)return false;
    if(other.kind==='group'||other.kind==='adjustment'&&other.adjustment.type==='invert')return true;
    if(other.kind==='pixel'&&!other.raster){
      return (other.strokes??[]).every(stroke=>{
        if(!stroke.rect||stroke.feather)return false;
        obstacles.push(pixelBounds(stroke.rect));return true;
      });
    }
    const box=placedImageBounds(other,assets);
    if(!box)return false;
    obstacles.push(pixelBounds(box));return true;
  })&&!obstacles.some(box=>overlaps(box,rect));
  if(separate||side)return {id,separate,bounds:rect,front:separate?obstacles:front,
    window:side&&[Math.min(rect[0],grid-side),Math.min(rect[1],grid-side),side]};
}

export function createMovePreview(onReady){
  let cache=null;
  function clear(){cache?.controller?.abort();cache=null;}
  function prepare(state){
    const source=state?.moveSource;
    if(!source){clear();return;}
    if(cache?.key===state.key&&cache.source.id===source.id)return;
    clear();
    const entry=cache={key:state.key,source};
    if(source.separate)return;
    const controller=entry.controller=new AbortController();
    const {id,window}=source;
    async function read(fields){
      const response=await fetch('/api/projects/'+state.id+'/paint/image-live',{method:'POST',signal:controller.signal,
        headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.revision,documentId:state.documentId,resolution:256,window,...fields})});
      if(!response.ok||response.headers.get('X-Paint-Revision')!==String(state.revision)||response.headers.get('X-Paint-Window')!==window.join(',')){
        await response.body?.cancel();return null;
      }
      const pixels=new Uint8Array(await response.arrayBuffer());
      return pixels.length===window[2]**2*4?pixels:null;
    }
    // A layer over transparent pixels can be lifted directly from the saved canvas.
    // Only request an isolated copy when something is actually underneath it.
    async function load(){
      const back=await read({operation:{op:'image',documentId:state.documentId,action:'updateLayer',layerId:id,patch:{visible:false}}});
      if(!back||cache!==entry)return;
      const [tx,ty,side]=window,[l,t,r,b]=source.bounds;
      let clear=!source.front.some(rect=>overlaps(rect,source.bounds));
      for(let y=t;clear&&y<b;y++)for(let x=l;x<r;x++){
        if(back[4*((y-ty)*side+x-tx)+3]){clear=false;break;}
      }
      const ink=clear?null:await read({isolatedImageLayer:id});
      if(cache!==entry||!clear&&!ink)return;
      Object.assign(entry,{back,ink});
      onReady();
    }
    void load().catch(error=>{if(!controller.signal.aborted)console.warn('无法预备移动图层像素',error);});
  }

  function paintedBounds(bytes,stride,ox,oy,bounds){
    const [l,t,r,b]=bounds;
    let left=r,top=b,right=l,bottom=t;
    for(let y=t;y<b;y++)for(let x=l,i=4*((y-oy)*stride+l-ox)+3;x<r;x++,i+=4){
      if(!bytes[i])continue;
      left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=y+1;
    }
    return left<right?[left,top,right,bottom]:null;
  }

  function draw(state,op,ctx,image,base,beforeDraw){
    if(state.moveSource?.separate)prepare(state);
    const tr=op?.action==='layoutLayers'&&op.transforms.length===1&&op.transforms[0];
    if(!tr||tr.angle||tr.scale!==1||tr.layerIds.length!==1||cache?.key!==state.key||cache.source.id!==tr.layerIds[0])return;
    const {source,back}=cache;
    if(!source.separate&&!back)return;
    const [ox,oy]=documentFrame(state.imageGeometry);
    const ink=cache.ink??base,[ix,iy,stride]=cache.ink?source.window:[ox,oy,image.width];
    const painted=cache.painted??=paintedBounds(ink,stride,ix,iy,source.bounds);
    if(!painted)return;
    const [l,t,r,b]=painted;
    const [dx,dy]=tr.offset.map(n=>Math.round(n*grid)),dst=[l+dx,t+dy,r+dx,b+dy];
    if(source.front.some(rect=>overlaps(rect,dst)))return;
    const w=r-l,h=b-t;
    beforeDraw(source.separate&&source);
    // Keep the saved ImageData immutable so a cancel can restore it immediately.
    if(source.separate){
      ctx.clearRect(l-ox,t-oy,w,h);
      if(!cache.sprite){
        const sprite=ctx.createImageData(w,h,{colorSpace:image.colorSpace});
        for(let y=0;y<h;y++){
          const offset=((t-oy+y)*image.width+l-ox)*4;
          sprite.data.set(image.data.subarray(offset,offset+w*4),y*w*4);
        }
        cache.sprite=sprite;
      }
      ctx.putImageData(cache.sprite,l+dx-ox,t+dy-oy);
    }else{
      const [tx,ty,side]=source.window;
      const background=cache.background??=new ImageData(new Uint8ClampedArray(back.buffer),side,side);
      ctx.putImageData(background,tx-ox,ty-oy,l-tx,t-ty,w,h);
      const left=Math.max(l+dx,ox),top=Math.max(t+dy,oy),right=Math.min(r+dx,ox+image.width),bottom=Math.min(b+dy,oy+image.height);
      if(left<right&&top<bottom){
        const patch=ctx.createImageData(right-left,bottom-top,{colorSpace:'srgb'}),output=patch.data;
        let curve;
        const words=buf=>new Uint32Array(buf.buffer,buf.byteOffset,buf.byteLength/4);
        const out32=words(output),ink32=words(ink),back32=words(back),base32=words(base);
        for(let y=top,k=0;y<bottom;y++)for(let x=left;x<right;x++,k+=4){
          const a=((y-dy-iy)*stride+x-dx-ix)*4,inside=x>=l&&x<r&&y>=t&&y<b;
          const pixels=inside?back:base,q=inside?((y-ty)*side+x-tx)*4:((y-oy)*image.width+x-ox)*4;
          if(!ink[a+3]){out32[k/4]=(inside?back32:base32)[q/4];continue;}
          if(ink[a+3]===255||!pixels[q+3]){out32[k/4]=ink32[a/4];continue;}
          const alpha=ink[a+3]/255,bg=pixels[q+3]/255*(1-alpha),sum=alpha+bg;
          output[k+3]=sum*255;
          curve??=colorCurve(state.colorSpace);
          for(let c=0;c<3;c++)output[k+c]=curve.byte[Math.round(65535*(curve.linear[ink[a+c]]*alpha+curve.linear[pixels[q+c]]*bg)/sum)];
        }
        ctx.putImageData(patch,left-ox,top-oy);
      }
    }
    return [dst[0]-ox,dst[1]-oy,w,h];
  }
  return {prepare,draw,clear};
}
