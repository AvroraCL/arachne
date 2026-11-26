import {decodeComponent,encodeComponent} from './image-display-rgb.mjs';

// Only the pixels below the brush are mutable here. The compositor supplies the
// saved layer, its mask and the composites on either side in linear premultiplied RGBA.
const side=512,area=side*side,grid=4096;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const curves=new Map();
function colorCurve(space){
  if(!curves.has(space))curves.set(space,{
    decode:Float32Array.from({length:256},(_,i)=>space==='linear'?i/255:decodeComponent(i/255,space)),
    encode:Uint8ClampedArray.from({length:65536},(_,i)=>255*(space==='linear'?i/65535:encodeComponent(i/65535,space)))
  });
  return curves.get(space);
}
function sampleTip(tip,x,y){
  const size=Math.max(tip.w,tip.h),u=(x*size+tip.w-1)/2,v=(y*size+tip.h-1)/2;
  const a=Math.floor(u),b=Math.floor(v),fx=u-a,fy=v-b;
  let sum=0;
  for(let j=0;j<2;j++)for(let i=0;i<2;i++){
    if(a+i>=0&&a+i<tip.w&&b+j>=0&&b+j<tip.h)sum+=tip.data[(b+j)*tip.w+a+i]*(i?fx:1-fx)*(j?fy:1-fy);
  }
  return sum;
}

function dabPoints(stroke,visit){
  const points=stroke.stamps,breaks=new Set(stroke.breaks),diameter=2*stroke.radius*grid;
  let length=0;
  for(let i=1;i<points.length;i++)if(!breaks.has(i))length+=Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1])*grid;
  const minimum=Math.max(1,length/clamp(128000000/diameter**2,256,16000));
  const sized=['both','size'].includes(stroke.pressureMode);
  const step=p=>Math.max(minimum,diameter*stroke.spacing*(sized?Math.max(.05,p):1));
  let remaining=0;
  for(let i=0;i<points.length;i++){
    const [x,y,p=1]=points[i];
    if(i===0||breaks.has(i)){visit(x*grid,y*grid,p);remaining=step(p);continue;}
    const [ax,ay,ap=1]=points[i-1],dx=(x-ax)*grid,dy=(y-ay)*grid,d=Math.hypot(dx,dy);
    while(remaining<=d){
      const t=remaining/d,q=ap+(p-ap)*t;
      visit(ax*grid+dx*t,ay*grid+dy*t,q);remaining+=step(q);
    }
    remaining-=d;
  }
}

function weights(stroke,images,box){
  const [x,y,w,h]=box,coverage=new Float32Array(w*h),tip=stroke.tip;
  const custom=images.get('tip:'+tip?.tipAsset),texture=images.get('texture:'+tip?.textureAsset);
  const angle=(tip?.angle??0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  let index=0;
  dabPoints(stroke,(u,v,p)=>{
    index++;
    if(!p)return;
    const radius=stroke.radius*grid*(['size','both'].includes(stroke.pressureMode)?Math.max(.05,p):1);
    if(tip?.scatter){
      let seed=(tip.seed+Math.imul(0x9e3779b9,index))>>>0;
      seed=Math.imul(seed^(seed>>>16),0x7feb352d);seed=Math.imul(seed^(seed>>>15),0x846ca68b);seed=(seed^(seed>>>16))>>>0;
      const angle=(seed&65535)*2*Math.PI/65536,offset=tip.scatter*radius*Math.sqrt((seed>>>16)/65535);
      u+=Math.cos(angle)*offset;v+=Math.sin(angle)*offset;
    }
    const reach=radius*(custom?Math.SQRT2:1),f=stroke.flow*(stroke.pressureMode==='size'?1:p);
    const left=Math.max(x,Math.floor(u-reach)),right=Math.min(x+w,Math.ceil(u+reach));
    const top=Math.max(y,Math.floor(v-reach)),bottom=Math.min(y+h,Math.ceil(v+reach));
    for(let j=top;j<bottom;j++)for(let i=left;i<right;i++){
      const dx=(i+.5-u)/radius,dy=(j+.5-v)/radius;
      const a=c*dx+s*dy,b=(-s*dx+c*dy)/(tip?.roundness??1);
      let alpha=custom?sampleTip(custom,a,b):clamp((1-Math.hypot(a,b))/Math.max(.001,1-stroke.hardness),0,1);
      if(tip?.grain){
        let grain;
        if(texture)grain=1-texture.data[(j%texture.h)*texture.w+i%texture.w];
        else{
          let hash=Math.imul(i>>2,2246822519)^Math.imul((4095-j)>>2,3266489917);
          hash=Math.imul(hash^(hash>>>15),668265263);grain=((hash^(hash>>>13))&255)/255;
        }
        alpha*=1-tip.grain*grain;
      }
      const at=(j-y)*w+i-x;
      coverage[at]+=(1-coverage[at])*alpha*f;
    }
  });
  return coverage;
}

function featherBox(radius){
  const variance=radius*radius/3,half=Math.floor((Math.sqrt(1+12*variance)-1)/2);
  return [half,clamp((2*half+1)*(variance-half*(half+1)/3)/(2*((half+1)**2-variance)),0,1)];
}

// Blur only the change to the raw mask; its previously feathered pixels are already in the tile.
function featherDelta(values,w,h,half,edge){
  let temp=new Float32Array(values.length);
  for(let pass=0;pass<3;pass++)for(const vertical of [true,false]){
    const stride=vertical?w:1,length=vertical?h:w,lines=vertical?w:h;
    for(let line=0;line<lines;line++){
      const start=vertical?line:line*w,at=n=>values[start+stride*clamp(n,0,length-1)];
      let sum=0;for(let k=-half;k<=half;k++)sum+=at(k);
      for(let n=0;n<length;n++){
        temp[start+n*stride]=(sum+edge*(at(n-half-1)+at(n+half+1)))/(2*half+1+2*edge);
        sum+=at(n+half+1)-at(n-half);
      }
    }
    [values,temp]=[temp,values];
  }
  return values;
}

export function renderBrushTile(tile,edits,state,images,commit=false){
  const {layer,space,inspect}=state;
  if(inspect&&!layer.maskEnabled||edits.some(e=>e?.target==='mask')&&!layer.maskEnabled)return;
  let l=grid,t=grid,r=0,b=0;
  const maskEdit=edits.some(edit=>edit.target==='mask'),feather=maskEdit?layer.maskFeather??0:0;
  const [half,edge]=featherBox(feather);
  for(const edit of edits){
    const s=edit?.stroke;
    if(edit?.action!=='stroke'||edit.layerId!==layer.id||!s?.stamps?.length||s.flow===undefined||s.clone||s.rect||s.maskSpace||s.maskWarpIndex||s.coverage||s.regions||s.polygon||s.feather||
       (s.tip?.tipAsset&&!images.get('tip:'+s.tip.tipAsset))||(s.tip?.textureAsset&&s.tip.grain&&!images.get('texture:'+s.tip.textureAsset)))return;
    const reach=grid*s.radius*((s.tip?.tipAsset?Math.SQRT2:1)+(s.tip?.scatter??0))+1+(feather?3*(half+1):0);
    for(const [u,v] of s.stamps){l=Math.min(l,u*grid-reach);r=Math.max(r,u*grid+reach);t=Math.min(t,v*grid-reach);b=Math.max(b,v*grid+reach);}
  }
  l=Math.max(0,Math.floor(l));r=Math.min(grid,Math.ceil(r));t=Math.max(0,Math.floor(t));b=Math.min(grid,Math.ceil(b));
  const w=r-l,h=b-t;
  if(w<=0||h<=0||l<tile.x||t<tile.y||r>tile.x+side||b>tile.y+side)return;
  const box=[l,t,w,h],amounts=edits.map(e=>weights(e.stroke,images,box));
  const curve=colorCurve(space);
  const inks=edits.map(({stroke:s})=>{
    const rgb=s.color?.slice(1).match(/../g).map(v=>curve.decode[parseInt(v,16)]);
    if(rgb&&space.startsWith('gray-'))rgb.fill(.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]);
    return rgb;
  });
  const maskDelta=maskEdit?new Float32Array(w*h):null;
  function weight(n,i,j,k){
    const {clip,opacity}=edits[n].stroke;
    if(clip&&(i+.5<clip[0]*grid||i+.5>=clip[2]*grid||j+.5<clip[1]*grid||j+.5>=clip[3]*grid))return 0;
    return amounts[n][k]*opacity;
  }
  if(maskDelta)for(let j=t,k=0;j<b;j++)for(let i=l;i<r;i++,k++){
    const source=tile.raw?.[(j-tile.y)*side+i-tile.x]??1;
    let v=source;
    for(let n=0;n<edits.length;n++)if(edits[n].target==='mask')v+=(edits[n].stroke.value-v)*weight(n,i,j,k);
    maskDelta[k]=v-source;
  }
  if(feather)featherDelta(maskDelta,w,h,half,edge);
  const pixels=new Uint8ClampedArray(w*h*4);
  for(let j=t,k=0;j<b;j++)for(let i=l;i<r;i++,k++){
    const at=(j-tile.y)*side+i-tile.x,a=at*4,q=k*4;
    const m=1-(layer.maskDensity??1)*(1-clamp((tile.soft?.[at]??tile.raw?.[at]??1)+(maskDelta?.[k]??0),0,1));
    if(inspect&&!commit){pixels[q]=pixels[q+1]=pixels[q+2]=m*255;pixels[q+3]=255;continue;}
    let alpha=tile.active[a+3];const rgb=[tile.active[a],tile.active[a+1],tile.active[a+2]];
    for(let n=0;n<edits.length;n++)if(edits[n].target==='pixels'){
      const f=weight(n,i,j,k),s=edits[n].stroke,locked=layer.alphaLocked||s.preserveAlpha;
      for(let c=0;c<3;c++)rgb[c]=rgb[c]*(1-f)+(s.erase?0:inks[n][c]*f*(locked?alpha:1));
      if(!locked)alpha=alpha*(1-f)+(s.erase?0:f);
    }
    if(commit){
      tile.active[a]=rgb[0];tile.active[a+1]=rgb[1];tile.active[a+2]=rgb[2];tile.active[a+3]=alpha;
      if(maskDelta&&tile.raw){
        const original=tile.raw[at];
        let value=original;
        for(let n=0;n<edits.length;n++)if(edits[n].target==='mask')value+=(edits[n].stroke.value-value)*weight(n,i,j,k);
        if(tile.soft)tile.soft[at]+=maskDelta[k];
        tile.raw[at]=value;
      }
      continue;
    }
    const opacity=layer.opacity*(layer.maskEnabled?m:1),rest=1-alpha*opacity,front=1-(tile.above?.[a+3]??0);
    alpha=(alpha*opacity+(tile.below?.[a+3]??0)*rest)*front+1-front;
    pixels[q+3]=255*alpha;
    for(let c=0;c<3;c++){
      const v=alpha?clamp(((rgb[c]*opacity+(tile.below?.[a+c]??0)*rest)*front+(tile.above?.[a+c]??0))/alpha,0,1):0;
      pixels[q+c]=curve.encode[Math.round(v*65535)];
    }
  }
  return {pixels,box};
}

export function createBrushTiles(read){
  const images=new Map();
  let tile=null,previous=null,key='',loading=null,point=null;
  function loadImage(state,id,isTip){
    const assetKey=(isTip?'tip:':'texture:')+id;
    if(images.has(assetKey))return;
    images.set(assetKey,null);
    const img=new Image();
    img.onload=()=>{
      const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
      const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
      const rgba=ctx.getImageData(0,0,c.width,c.height).data,alpha=isTip&&rgba.some((v,i)=>i%4===3&&v!==255);
      const data=new Float32Array(c.width*c.height);
      for(let i=0;i<data.length;i++){
        const at=i*4,luma=Math.round(.299*rgba[at]+.587*rgba[at+1]+.114*rgba[at+2])/255,a=rgba[at+3]/255;
        data[i]=isTip?(alpha?a:1-luma):1-(1-luma)*a;
      }
      if(images.has(assetKey))images.set(assetKey,{data,w:c.width,h:c.height});
    };
    img.onerror=()=>images.delete(assetKey);
    img.src='/api/projects/'+state.id+'/paint/assets/'+id;
  }
  function prepare(uv){
    if(uv)point=uv;
    const state=read();
    if(!state){loading?.abort();tile=null;previous=null;key='';return;}
    const {layer}=state;
    for(const [id,isTip] of [[state.tip,true],[state.texture,false]])if(id)loadImage(state,id,isTip);
    if(!layer?.visible||!layer.opacity||layer.blend!=='normal')return;
    const pointIn=point??state.center;
    const [x,y]=pointIn.map(v=>clamp(Math.round((v*grid-side/2)/64)*64,0,grid-side));
    const identity=[state.id,state.doc,state.revision,layer.id].join('/');
    if(previous?.key===identity&&Math.abs(previous.x-x)<side/4&&Math.abs(previous.y-y)<side/4)[tile,previous]=[previous,tile];
    if(tile?.key===identity&&Math.abs(tile.x-x)<side/4&&Math.abs(tile.y-y)<side/4)return;
    if(key===identity&&loading&&Math.abs(loading.x-x)<side/4&&Math.abs(loading.y-y)<side/4)return;
    loading?.abort();
    key=identity;
    if(state.empty){
      previous=tile?.key===identity?tile:null;tile={key,x,y,active:new Float32Array(area*4)};
      if(layer.maskEnabled){
        tile.raw=new Float32Array(area).fill(layer.maskBase??1);
        if(layer.maskFeather)tile.soft=tile.raw.slice();
      }
      return;
    }
    const controller=new AbortController();Object.assign(controller,{x,y});loading=controller;
    fetch('/api/projects/'+state.id+'/paint/image-live',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({revision:state.revision,documentId:state.doc,resolution:256,brushTile:{layerId:layer.id,window:[x,y,side]}})})
      .then(async response=>{
        if(response.status===204)return;
        if(!response.ok||response.headers.get('X-Paint-Brush-Tile')!=='1'){
          controller.abort();return;
        }
        const buffer=await response.arrayBuffer();
        if(controller.signal.aborted)return;
        if(!buffer.byteLength){tile={key,x,y};return;}
        const flags=new DataView(buffer).getUint32(0,true);
        let offset=4;
        function plane(channels){const v=new Float32Array(buffer,offset,area*channels);offset+=v.byteLength;return v;}
        previous=tile?.key===identity?tile:null;
        tile={key:identity,x,y,active:plane(4),below:flags&1?plane(4):null,above:flags&2?plane(4):null,raw:flags&4?plane(1):null,soft:flags&8?plane(1):null};
      }).catch(error=>{if(!controller.signal.aborted)console.warn('无法预备局部笔刷像素',error);})
      .finally(()=>{if(loading===controller)loading=null;});
  }
  return {prepare,advance(edit){
    const state=read();
    if(!edit||!tile?.active||!state||tile.key!==[state.id,state.doc,state.revision-1,state.layer?.id].join('/'))return;
    if(renderBrushTile(tile,[edit],state,images,true))tile.key=[state.id,state.doc,state.revision,state.layer.id].join('/');
  },render(edits){
    const state=read();
    if(!state)return;
    for(const edit of edits){
      const tip=edit?.stroke?.tip;
      if(tip?.tipAsset)loadImage(state,tip.tipAsset,true);
      if(tip?.textureAsset)loadImage(state,tip.textureAsset,false);
    }
    const identity=[state.id,state.doc,state.revision,state.layer?.id].join('/');
    for(const candidate of [tile,previous]){
      if(candidate?.active&&candidate.key===identity){
        const patch=renderBrushTile(candidate,edits,state,images);
        if(patch)return {...patch,empty:state.empty};
      }
    }
  },dispose(){loading?.abort();images.clear();tile=null;previous=null;}};
}
