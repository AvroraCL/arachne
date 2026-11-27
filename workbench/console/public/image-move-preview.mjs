// Prepare the moving layer and the exposed background once per selection.
// The saved canvas supplies the background outside the original layer bounds.
import {placedImageBounds,unionImageBounds} from './image-layout.mjs';
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

function nativeWindow(rect){
  const side=[256,512,768,1024,1536,2048].find(n=>n>=Math.max(rect[2]-rect[0],rect[3]-rect[1]));
  if(side)return [Math.max(0,Math.min(rect[0],grid-side)),Math.max(0,Math.min(rect[1],grid-side)),side];
}

function placedSource(image,layer,selection,assets){
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
    if(selection.has(l.id)||!l.visible||!l.opacity||l.parentId)continue;
    if(l.kind==='pixel'&&!l.raster&&!l.strokes?.length&&!enabledStyle(l)&&!l.clipped)continue;
    const b=placedImageBounds(l,assets);
    if(!b||l.clipped||enabledStyle(l)||l.warp||l.gradient?.feather)return;
    const bounds=pixelBounds(b);
    const window=selection.size>1&&['normal','multiply','screen','overlay'].includes(l.blend)&&!l.blendIf&&!l.edgeDecontaminate&&nativeWindow(bounds);
    front.push({id:l.id,blend:l.blend,bounds,window});
  }
  const window=nativeWindow(rect);
  // For disjoint artwork we already have both the layer and its transparent
  // backdrop in the saved frame. No preparation request is needed.
  const obstacles=[];
  const known=image.layers.every(other=>{
    if(selection.has(other.id)||!other.visible||!other.opacity)return true;
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
  });
  const separate=known&&!obstacles.some(box=>overlaps(box,rect));
  if(separate||window)return {id:layer.id,separate,bounds:rect,front,obstacles:known?obstacles:null,window};
}

export function moveSource(image,ids,assets){
  const selection=new Set(ids);
  const parts=[];
  for(const layer of image.layers){
    if(!selection.has(layer.id))continue;
    const part=placedSource(image,layer,selection,assets);
    if(!part)return;
    parts.push(part);
  }
  if(!parts.length||parts.length!==selection.size)return;
  // Coalesce intersecting source rectangles once. Preserve the authored stack
  // order and isolate the moving pixels when the gap contains stationary artwork.
  // When a stationary layer separates overlapping sprites, keep their stack
  // positions distinct and uncover the shared backdrop with both hidden.
  const interleaved=parts.some((a,i)=>parts.slice(i+1).some(b=>overlaps(a.bounds,b.bounds)&&
    a.front.some(layer=>!b.front.some(other=>other.id===layer.id))));
  if(interleaved){
    for(const part of parts){
      if(!part.window)return;
      part.separate=false;
    }
  }
  for(let i=0;!interleaved&&i<parts.length;i++){
    for(let j=i+1;j<parts.length;j++){
      const a=parts[i],b=parts[j];
      if(!overlaps(a.bounds,b.bounds))continue;
      const bounds=unionImageBounds([a.bounds,b.bounds]);
      if(a.front.length!==b.front.length||a.front.some(layer=>!b.front.some(other=>other.id===layer.id)))return;
      const separate=a.separate&&b.separate&&!a.obstacles.some(box=>overlaps(box,bounds));
      const window=nativeWindow(bounds);
      if(!separate&&!window)return;
      parts[i]={...a,bounds,separate,window,members:[...(a.members??[a.id]),...(b.members??[b.id])]};
      parts.splice(j,1);
      i=-1;break;
    }
  }
  // Bound the two cached native planes by one document surface each.
  if(parts.reduce((sum,p)=>sum+(p.separate?0:p.window[2]**2),0)>grid**2)return;
  const front=new Map();
  let pixels=0;
  for(const part of parts)for(const layer of part.front){
    if(!layer.window||front.has(layer.id))continue;
    const area=layer.window[2]**2*(layer.blend==='overlay'?2:1);
    if(pixels+area<=grid**2){front.set(layer.id,layer);pixels+=area;}
  }
  // Overlay branches on the backdrop color. Keep the ordering above the
  // lowest moving layer so the soft edge can be blended before that decision.
  const stack=[...front.values()].some(l=>l.blend==='overlay')
    ?image.layers.slice(image.layers.findIndex(l=>selection.has(l.id))).map(l=>l.id):null;
  return {ids:selection,parts,front,stack,interleaved,bounds:unionImageBounds(parts.map(p=>p.bounds))};
}

export function isMoveSelection(source,tr){
  return source&&tr&&tr.scale===1&&!tr.angle&&tr.layerIds.length===source.ids.size&&tr.layerIds.every(id=>source.ids.has(id));
}

// Recompose just the intersection of the dragged sprite and the overlay
// tile. The underlay omits everything from the lowest selected layer upward.
function replayOverlay(plate,layers,x,y,color,curve,output,offset){
  const [tx,ty,side]=plate.window,pos=4*((y-ty)*side+x-tx);
  let alpha=plate.underlay[pos+3]/255;
  for(let c=0;c<3;c++)color[c]=curve.linear[plate.underlay[pos+c]];
  for(const {bytes,bounds:[l,t,r,b],stride,blend} of layers){
    if(x<l||x>=r||y<t||y>=b)continue;
    const i=4*((y-t)*stride+x-l),cover=bytes[i+3]/255;
    if(!cover)continue;
    const back=alpha*(1-cover),sum=cover+back;
    for(let c=0;c<3;c++){
      const dst=color[c],src=curve.linear[bytes[i+c]];
      let mix=src;
      if(blend==='overlay')mix=dst<=.5?2*dst*src:1-2*(1-dst)*(1-src);
      else if(blend==='screen')mix=dst+src-dst*src;
      else if(blend==='multiply')mix=dst*src;
      color[c]=(back*dst+cover*(src+alpha*(mix-src)))/sum;
    }
    alpha=sum;
  }
  for(let c=0;c<3;c++)output[offset+c]=curve.byte[Math.min(65535,Math.round(color[c]*65535))];
  output[offset+3]=255*alpha;
}

export function createMovePreview(onReady){
  let cache=null,next=null;
  function clear(){
    cache?.controller?.abort();next?.controller?.abort();
    cache=next=null;
  }
  function prepare(state,upcoming=false){
    const source=state?.moveSource;
    if(!source){if(!upcoming)clear();return;}
    if(cache?.key===state.key&&cache.source===source)return cache.loaded;
    if(next?.key===state.key&&next.source===source){
      if(upcoming)return next.loaded;
      cache?.controller?.abort();
      cache=next;next=null;
      return cache.loaded;
    }
    if(upcoming){next?.controller?.abort();next=null;}
    else clear();
    const entry={key:state.key,source,front:new Map(),parts:source.parts.map(part=>({source:part}))};
    // Only selected layers moved. The stationary foreground for the next
    // revision is the very same isolated ink in the same native window.
    if(upcoming)for(const layer of source.front.values()){
      const plane=cache?.front.get(layer.id);
      if(plane&&plane.window.join(',')===layer.window.join(','))entry.front.set(layer.id,plane);
    }
    if(upcoming)next=entry;else cache=entry;
    const valid=()=>entry===cache||entry===next;
    if(!source.front.size&&source.parts.every(p=>p.separate))return;
    const controller=entry.controller=new AbortController();
    async function read(window,fields){
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
      for(const part of entry.parts){
        const {id,window,bounds,separate,front}=part.source;
        if(separate)continue;
        const members=part.source.members;
        const hidden=source.interleaved?[...source.ids]:members;
        const back=await read(window,hidden?{movePlane:{ids:hidden,plane:'background'}}:
          {operation:{op:'image',documentId:state.documentId,action:'updateLayer',layerId:id,patch:{visible:false}}});
        if(!back||!valid())return;
        const [tx,ty,side]=window,[l,t,r,b]=bounds;
        let clear=!source.interleaved&&!front.some(layer=>overlaps(layer.bounds,bounds));
        for(let y=t;clear&&y<b;y++)for(let x=l;x<r;x++){
          if(back[4*((y-ty)*side+x-tx)+3]){clear=false;break;}
        }
        const ink=clear?null:await read(window,members?{movePlane:{ids:members,plane:'content'}}:{isolatedImageLayer:id});
        if(!valid()||!clear&&!ink)return;
        Object.assign(part,{back,ink});
      }
      if(entry===cache&&source.parts.some(p=>!p.separate))onReady();
      for(const layer of source.front.values()){
        if(entry.front.has(layer.id))continue;
        let underlay;
        if(layer.blend==='overlay'){
          underlay=await read(layer.window,{movePlane:{ids:[...source.ids],plane:'underlay'}});
          if(!underlay||!valid())return;
        }
        const ink=await read(layer.window,{isolatedImageLayer:layer.id});
        if(!valid())return;
        if(ink)entry.front.set(layer.id,{ink,underlay,blend:layer.blend,window:layer.window});
      }
      if(entry===cache&&source.front.size)onReady();
    }
    entry.loaded=load().catch(error=>{if(!controller.signal.aborted)console.warn('无法预备移动图层像素',error);});
    return entry.loaded;
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
    const tr=op?.action==='layoutLayers'&&op.transforms.length===1&&op.transforms[0];
    if(!isMoveSelection(state.moveSource,tr))return;
    prepare(state);
    const [ox,oy]=documentFrame(state.imageGeometry);
    const [dx,dy]=tr.offset.map(n=>Math.round(n*grid));
    const moving=[];
    for(const part of cache.parts){
      const {source,back}=part;
      if(!source.separate&&!back)return;
      const ink=part.ink??base,[ix,iy,stride]=part.ink?source.window:[ox,oy,image.width];
      const painted=part.painted??=paintedBounds(ink,stride,ix,iy,source.bounds);
      if(!painted)continue;
      const [l,t,r,b]=painted,dst=[l+dx,t+dy,r+dx,b+dy];
      const front=[];
      for(const layer of source.front){
        if(!overlaps(layer.bounds,dst))continue;
        const plane=cache.front.get(layer.id);
        if(!plane)return;
        front.push(plane);
      }
      if(!part.sprite){
        const sprite=ctx.createImageData(r-l,b-t,{colorSpace:image.colorSpace});
        for(let y=t;y<b;y++){
          const offset=((y-iy)*stride+l-ix)*4;
          sprite.data.set(ink.subarray(offset,offset+(r-l)*4),(y-t)*(r-l)*4);
        }
        part.sprite=sprite;
      }
      moving.push({part,painted,dst,front,empty:!cache.source.interleaved&&source.obstacles&&!source.obstacles.some(box=>overlaps(box,dst))});
    }
    if(!moving.length)return;
    if(cache.source.stack&&moving.some(m=>m.front.some(f=>f.underlay)&&
      cache.source.parts[0].front.some(f=>overlaps(f.bounds,m.dst)&&!cache.front.has(f.id))))return;
    beforeDraw();
    // First uncover every original position, then paint the complete selection.
    // A destination may pass directly over another selected item's old position.
    for(const {part,painted:[l,t,r,b]} of moving){
      if(!part.back)ctx.clearRect(l-ox,t-oy,r-l,b-t);
      else{
        const [tx,ty,side]=part.source.window;
        const background=part.background??=new ImageData(new Uint8ClampedArray(part.back.buffer),side,side);
        ctx.putImageData(background,tx-ox,ty-oy,l-tx,t-ty,r-l,b-t);
      }
    }
    const composited=[];
    const stack=cache.source.stack?.map(id=>{
      const item=moving.find(m=>m.part.source.id===id);
      if(item)return {bytes:item.part.sprite.data,bounds:item.dst,stride:item.part.sprite.width,blend:'normal',order:moving.indexOf(item)};
      const layer=cache.front.get(id);
      if(layer){
        const [x,y,side]=layer.window;
        return {bytes:layer.ink,bounds:[x,y,x+side,y+side],stride:side,blend:layer.blend};
      }
    }).filter(Boolean);
    for(const [order,{part,dst,front,empty}] of moving.entries()){
      const [x,y,r,b]=dst;
      if(empty){ctx.putImageData(part.sprite,x-ox,y-oy);continue;}
      const left=Math.max(x,ox),top=Math.max(y,oy),right=Math.min(r,ox+image.width),bottom=Math.min(b,oy+image.height);
      if(left>=right||top>=bottom)continue;
      const width=right-left,height=bottom-top;
      const patch=part.patch?.width===width&&part.patch.height===height?part.patch:
        (part.patch=ctx.createImageData(width,height,{colorSpace:image.colorSpace}));
      const output=patch.data,src=part.sprite.data;
      // Reuse saved pixels for stationary artwork. Inside a vacated area use
      // the backdrop with that item hidden, even when it belongs to a sibling.
      for(let row=0;row<height;row++){
        const offset=((top-oy+row)*image.width+left-ox)*4;
        output.set(base.subarray(offset,offset+width*4),row*width*4);
      }
      for(const {part:original,painted:[l,t,r,b]} of moving){
        const start=Math.max(l,left),end=Math.min(r,right);
        if(start>=end)continue;
        for(let row=Math.max(t,top);row<Math.min(b,bottom);row++){
          const offset=((row-top)*width+start-left)*4,length=(end-start)*4;
          if(!original.back)output.fill(0,offset,offset+length);
          else{
            const [tx,ty,side]=original.source.window,pos=((row-ty)*side+start-tx)*4;
            output.set(original.back.subarray(pos,pos+length),offset);
          }
        }
      }
      // A higher moving sprite must see the pixels of a lower moving sprite
      // at the destination, including any stationary layers between them.
      for(const prior of composited){
        const start=Math.max(left,prior.left),end=Math.min(right,prior.left+prior.patch.width);
        if(end<=start)continue;
        for(let y=Math.max(top,prior.top);y<Math.min(bottom,prior.top+prior.patch.height);y++){
          const pos=4*((y-prior.top)*prior.patch.width+start-prior.left);
          output.set(prior.patch.data.subarray(pos,pos+4*(end-start)),4*((y-top)*width+start-left));
        }
      }
      const overlays=front.filter(layer=>layer.underlay);
      // Higher selected sprites are drawn in their own pass.
      const layers=overlays.length?stack.filter(l=>l.order===undefined||l.order<=order):null;
      const color=[0,0,0];
      // A single band often has long flat runs. Reuse a result only when
      // every contributing RGBA value (including the overlay underlay) matches.
      const band=front.length===1&&(!layers||layers.length===2)?front[0]:null;
      const band32=band&&new Uint32Array(band.ink.buffer);
      const under32=band?.underlay&&new Uint32Array(band.underlay.buffer);
      const [bx,by,side]=band?.window??[0,0,0];
      let curve,lastInk=-1,lastBack=-1,lastBand=-1,lastUnder=-1,lastMix=0;
      const ink32=new Uint32Array(src.buffer),out32=new Uint32Array(output.buffer);
      for(let row=top,k=0;row<bottom;row++)for(let col=left;col<right;col++,k+=4){
        const a=((row-y)*part.sprite.width+col-x)*4;
        if(!src[a+3])continue;
        if(band){
          const pos=col>=bx&&row>=by&&col<bx+side&&row<by+side?(row-by)*side+col-bx:-1;
          const tint=band32[pos]??0,under=under32?.[pos]??0,ink=ink32[a/4],back=out32[k/4];
          if(ink===lastInk&&back===lastBack&&tint===lastBand&&under===lastUnder){
            out32[k/4]=lastMix;continue;
          }
          lastInk=ink;lastBack=back;lastBand=tint;lastUnder=under;
        }
        if(overlays.length){
          const plate=overlays.find(({window:[tx,ty,side]})=>col>=tx&&col<tx+side&&row>=ty&&row<ty+side);
          if(plate){
            curve??=colorCurve(state.colorSpace);
            replayOverlay(plate,layers,col,row,color,curve,output,k);
            if(band)lastMix=out32[k/4];
            continue;
          }
        }
        if(!front.length){
          const ink=ink32[a/4],back=out32[k/4];
          if(src[a+3]===255||!output[k+3]){out32[k/4]=ink;continue;}
          // Flat fills and lettering commonly repeat the same RGBA pair in a row.
          if(ink===lastInk&&back===lastBack){out32[k/4]=lastMix;continue;}
          lastInk=ink;lastBack=back;
        }
        // For normal, multiply and screen, the foreground stack is affine in the
        // backdrop's premultiplied RGB and alpha. Blend the saved composite
        // with that same stack over opaque moving ink, using the ink's masked
        // alpha. This also works when the underlying document is transparent.
        const alpha=src[a+3]/255,bg=output[k+3]/255*(1-alpha),sum=alpha+bg;
        curve??=colorCurve(state.colorSpace);
        let red=curve.linear[src[a]],green=curve.linear[src[a+1]],blue=curve.linear[src[a+2]];
        for(const {ink,blend,window:[tx,ty,side]} of front){
          if(col<tx||col>=tx+side||row<ty||row>=ty+side)continue;
          const i=4*((row-ty)*side+col-tx),cover=ink[i+3]/255;
          if(!cover)continue;
          const r=curve.linear[ink[i]],g=curve.linear[ink[i+1]],b=curve.linear[ink[i+2]];
          if(blend==='multiply'){
            red*=1+cover*(r-1);green*=1+cover*(g-1);blue*=1+cover*(b-1);
          }else if(blend==='screen'){
            red+=cover*r*(1-red);green+=cover*g*(1-green);blue+=cover*b*(1-blue);
          }else{
            red+=cover*(r-red);green+=cover*(g-green);blue+=cover*(b-blue);
          }
        }
        output[k+3]=sum*255;
        for(let c=0;c<3;c++){
          const overInk=c===0?red:c===1?green:blue;
          const value=overInk*alpha+curve.linear[output[k+c]]*bg;
          output[k+c]=curve.byte[Math.min(65535,Math.round(65535*value/sum))];
        }
        if(!front.length||band)lastMix=out32[k/4];
      }
      ctx.putImageData(patch,left-ox,top-oy);
      if(cache.source.interleaved)composited.push({patch,left,top});
    }
    const rect=([l,t,r,b])=>[l-ox,t-oy,r-l,b-t];
    return moving.map(({painted,dst,empty})=>({original:rect(painted),destination:rect(dst),empty}));
  }
  function readyForRepeat(source){
    return cache?.source===source&&cache.parts.every(p=>p.source.separate||p.back)&&
      source.parts.every(p=>p.front.every(layer=>cache.front.has(layer.id)));
  }
  return {prepare,draw,clear,readyForRepeat};
}
