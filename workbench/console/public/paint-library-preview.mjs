import {evaluateBrushGraph} from './paint-library.mjs';
import {workspaceIcons} from './workspace-icons.mjs';

export function drawBrushPreview(canvas,settings,tip=null,texture=null){
  canvas.width=200;canvas.height=100;const c=canvas.getContext('2d');c.clearRect(0,0,200,100);
  const r=Math.min(22,Math.max(5,settings.uvRadius/5));
  const spacing=Math.max(2,2*r*(settings.spacing??.18));
  const scatter=r*(settings.scatter??0)/100;
  for(let x=26,index=0;x<=176;x+=spacing,index++){
    const offset=(Math.imul(index+1,2654435761)>>>0)/0x100000000*2-1;
    c.save();c.translate(x,52-Math.sin((x-26)/150*Math.PI)*12+offset*scatter);
    c.rotate((settings.tipAngle??0)*Math.PI/180);c.scale(1,(settings.roundness??100)/100);
    if(tip){
      const scale=2*r/Math.max(tip.width,tip.height),w=tip.width*scale,h=tip.height*scale;
      c.globalAlpha=settings.opacity*(settings.flow??1);
      c.drawImage(tip,-w/2,-h/2,w,h);
    }else{
      const gradient=c.createRadialGradient(0,0,Math.min(.999,settings.hardness)*r,0,0,r);
      gradient.addColorStop(0,`rgba(220,220,220,${settings.opacity*(settings.flow??1)})`);gradient.addColorStop(1,'rgba(220,220,220,0)');
      c.fillStyle=gradient;c.fillRect(-r,-r,r*2,r*2);
    }
    c.restore();
  }
  if(settings.grain){
    const image=c.getImageData(0,0,200,100),depth=settings.grain/100;
    for(let y=0;y<100;y++)for(let x=0;x<200;x++){
      const noise=Math.imul(Math.imul(x,2246822519)^Math.imul(y,3266489917),668265263)>>>0;
      const value=texture?texture.pixels[(y%texture.height)*texture.width+x%texture.width]:(noise>>>12)&255;
      image.data[4*(y*200+x)+3]*=1-depth*value/255;
    }
    c.putImageData(image,0,0);
  }
}

function loadBrushPreview(url,tip){
  const image=new Image();
  return new Promise(resolve=>{
    image.onload=()=>{
      const canvas=document.createElement('canvas'),scale=Math.min(1,96/Math.max(image.naturalWidth,image.naturalHeight));
      canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
      canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      const frame=ctx.getImageData(0,0,canvas.width,canvas.height),rgba=frame.data;
      const transparent=rgba.some((value,i)=>i%4===3&&value<255);
      const pixels=new Uint8ClampedArray(rgba.length/4);
      for(let i=0;i<pixels.length;i++){
        const j=i*4,black=255-(.299*rgba[j]+.587*rgba[j+1]+.114*rgba[j+2]);
        pixels[i]=black*rgba[j+3]/255;
        if(tip){rgba[j]=rgba[j+1]=rgba[j+2]=220;if(!transparent)rgba[j+3]=pixels[i];}
      }
      if(tip)ctx.putImageData(frame,0,0);
      resolve(tip?canvas:{width:canvas.width,height:canvas.height,pixels});
    };
    image.onerror=()=>resolve(null);
    image.src=url;
  });
}


function previewImage(url){
  const image=document.createElement('img');
  image.alt='';image.draggable=false;image.loading='lazy';image.decoding='async';image.src=url;
  return image;
}

export function resourcePreview(kind,item,assetUrl){
  const preview=document.createElement('div');
  preview.className='library-preview';
  if(kind==='images'){
    preview.append(previewImage(assetUrl(item.image||item.id)));
  }else if(kind==='brushes'){
    const canvas=document.createElement('canvas');
    const settings=evaluateBrushGraph(item.graph);
    drawBrushPreview(canvas,settings);preview.append(canvas);
    if(settings.tipAsset||settings.textureAsset&&settings.grain)void Promise.all([
      settings.tipAsset?loadBrushPreview(assetUrl(settings.tipAsset),true):null,
      settings.textureAsset&&settings.grain?loadBrushPreview(assetUrl(settings.textureAsset),false):null
    ]).then(([tip,texture])=>drawBrushPreview(canvas,settings,tip,texture));
  }else if(kind==='smartMaterials'){
    const stack=document.createElement('span');
    stack.className='library-smart-preview';
    stack.style.setProperty('--material-color',item.color||'#808080');
    stack.innerHTML=workspaceIcons.fillLayer;
    preview.append(stack);
  }else{
    const sphere=document.createElement('span');
    sphere.className='library-sphere';
    const nodes=item.graph.nodes;
    const pbr=nodes.find(node=>node.type==='pbr'),color=nodes.find(node=>node.type==='color');
    const links=item.graph.links;
    let from=links.find(link=>link.to.node===pbr?.id&&link.to.port==='color')?.from;
    let texture=null;
    while(from){
      const node=nodes.find(item=>item.id===from.node);
      if(node?.type==='image'&&node.params.asset){texture=node;break;}
      from=node?.type==='reroute'?links.find(link=>link.to.node===node.id)?.from:null;
    }
    sphere.style.setProperty('--material-color',color?.params.color||pbr?.params.color||'#808080');
    if(texture)sphere.append(previewImage(assetUrl(texture.params.asset)));
    preview.append(sphere);
  }
  return preview;
}

export function enableResourceGridKeys(grid){
  grid.addEventListener('keydown',event=>{
    if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.defaultPrevented)return;
    const current=event.target.closest('button.library-tile');
    const key=event.key;
    if(!current||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(key))return;
    const tiles=[...grid.querySelectorAll('button.library-tile:enabled')];
    const index=tiles.indexOf(current);
    if(index<0)return;
    let next;
    if(key==='Home')next=tiles[0];
    else if(key==='End')next=tiles.at(-1);
    else if(key==='ArrowLeft'||key==='ArrowRight')next=tiles[index+(key==='ArrowLeft'?-1:1)];
    else{
      const direction=key==='ArrowUp'?-1:1;
      const origin=current.getBoundingClientRect(),center=origin.x+origin.width/2;
      const candidates=tiles.map(tile=>({tile,rect:tile.getBoundingClientRect()}))
        .filter(({rect})=>(rect.y-origin.y)*direction>2);
      candidates.sort((a,b)=>(a.rect.y-b.rect.y)*direction||
        Math.abs(a.rect.x+a.rect.width/2-center)-Math.abs(b.rect.x+b.rect.width/2-center));
      next=candidates[0]?.tile;
    }
    event.preventDefault();
    next?.focus();
  });
}
