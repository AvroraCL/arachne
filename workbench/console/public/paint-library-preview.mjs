import {evaluateBrushGraph} from './paint-library.mjs';
import {workspaceIcons} from './workspace-icons.mjs';

export function drawBrushPreview(canvas,settings){
  canvas.width=200;canvas.height=100;const c=canvas.getContext('2d');c.clearRect(0,0,200,100);
  const r=Math.min(22,Math.max(5,settings.uvRadius/5));
  for(let x=26;x<=176;x+=Math.max(2,r*.3)){
    c.save();c.translate(x,52-Math.sin((x-26)/150*Math.PI)*12);
    const gradient=c.createRadialGradient(0,0,Math.min(.999,settings.hardness)*r,0,0,r);
    gradient.addColorStop(0,`rgba(220,220,220,${settings.opacity})`);gradient.addColorStop(1,'rgba(220,220,220,0)');
    c.fillStyle=gradient;c.fillRect(-r,-r,r*2,r*2);c.restore();
  }
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
    drawBrushPreview(canvas,evaluateBrushGraph(item.graph));preview.append(canvas);
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
