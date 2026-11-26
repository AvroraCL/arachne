import {imageBatchSelection} from './image-layer-batch.mjs';
import {layerLockOwner,layerTreeOrder} from './paint-layer-tree.mjs';
import {imagePlacement,quadPoints} from './image-warp.mjs';

export const layoutKinds=['image','shape','pixel','gradient'];
export const boundsCenter=([left,top,right,bottom])=>[(left+right)/2,(top+bottom)/2];
export function unionImageBounds(bounds){
  return bounds.length?[Math.min(...bounds.map(b=>b[0])),Math.min(...bounds.map(b=>b[1])),
    Math.max(...bounds.map(b=>b[2])),Math.max(...bounds.map(b=>b[3]))]:null;
}
export function layoutPoint([x,y],{pivot:[px,py],offset:[dx,dy],scale,angle}){
  const radians=angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  return [px+dx+scale*((x-px)*c-(y-py)*s),py+dy+scale*((x-px)*s+(y-py)*c)];
}
export function layoutBounds(rect,transform){
  const [x,y,right,bottom]=rect;
  return unionImageBounds([[x,y],[right,y],[right,bottom],[x,bottom]]
    .map(point=>layoutPoint(point,transform)).map(([u,v])=>[u,v,u,v]));
}
export function placedImageBounds(layer,assets){
  if(layer.kind==='gradient'){
    if(!layer.gradient.clip)return [0,0,1,1];
    const [left,top,right,bottom]=layer.gradient.clip;
    const [a,b,d,e,x,y]=layer.gradientTransform??[1,0,0,1,0,0];
    return unionImageBounds([[left,top],[right,top],[right,bottom],[left,bottom]].map(([u,v])=>{
      const px=a*u+d*v+x,py=b*u+e*v+y;
      return [px,py,px,py];
    }));
  }
  if(!['shape','image'].includes(layer.kind))return null;
  const placement=imagePlacement(layer,assets);
  return placement&&unionImageBounds((layer.warp?.points??quadPoints).map(placement.toCanvas).map(([x,y])=>[x,y,x,y]));
}
// Exterior pixels are unchanged when moving independently composited placed layers.
export function layoutDamage(layers,assets,operation){
  if(operation?.action!=='layoutLayers'||layers.some(l=>l.kind==='adjustment'||l.parentId||l.clipped||
      l.kind==='group'||Object.values(l.styles??{}).some(style=>style.enabled)))return null;
  const boxes=[];
  for(const transform of operation.transforms){
    for(const id of transform.layerIds){
      const layer=layers.find(item=>item.id===id);
      if(!layer||!['shape','image'].includes(layer.kind)||layer.warp)return null;
      const bounds=placedImageBounds(layer,assets);
      if(!bounds)return null;
      boxes.push(bounds,layoutBounds(bounds,transform));
    }
  }
  return unionImageBounds(boxes);
}
export function imageLayoutTargets(layers,ids){
  const batch=imageBatchSelection(layers,ids);
  const targets=batch.affected.filter(layer=>layoutKinds.includes(layer.kind));
  if(batch.affected.some(layer=>layerLockOwner(layers,layer)))
    throw Object.assign(Error('所选图层或组内图层已锁定'),{status:423});
  const masks=batch.affected.filter(layer=>layer.maskLinked!==false&&
    (layer.maskEnabled||layer.maskStrokes||layer.maskGradient));
  if(batch.roots.some(layer=>layer.kind==='adjustment'))
    throw Error('请将调整层和素材成组后一起变换，或解除链接后单独移动调整层蒙版');
  if(!targets.length)throw Error('请选择包含素材或渐变的图层。单独移动调整范围时，请解除链接并选中蒙版');
  return {targets,roots:batch.roots,masks};
}
export function rootLayoutBounds(layers,root,boundsFor){
  const items=root.kind==='group'?layerTreeOrder(layers,root.id):[root];
  const bounded=items.filter(layer=>layer.kind!=='gradient'||layer.gradient.clip).map(boundsFor).filter(Boolean);
  // A full-canvas gradient follows its group without forcing the group's
  // transform pivot and alignment bounds to the center of the document.
  return unionImageBounds(bounded.length?bounded:items.map(boundsFor).filter(Boolean));
}
export function alignImageBounds(items,action){
  const axis=action.endsWith('Y')?1:0;
  const edge=action.startsWith('start')?0:action.startsWith('end')?2:null;
  const measure=bounds=>edge===null?boundsCenter(bounds)[axis]:bounds[axis+edge];
  const offsets=new Map();
  if(action.startsWith('space')){
    const sorted=items.toSorted((a,b)=>boundsCenter(a.bounds)[axis]-boundsCenter(b.bounds)[axis]);
    const extent=item=>item.bounds[axis+2]-item.bounds[axis];
    const span=sorted.at(-1).bounds[axis+2]-sorted[0].bounds[axis];
    const gap=(span-sorted.reduce((sum,item)=>sum+extent(item),0))/(sorted.length-1);
    let next=sorted[0].bounds[axis];
    for(const item of sorted){
      offsets.set(item.id,next-item.bounds[axis]);
      next+=extent(item)+gap;
    }
  }else{
    const coordinate=measure(unionImageBounds(items.map(item=>item.bounds)));
    for(const item of items)offsets.set(item.id,coordinate-measure(item.bounds));
  }
  return items.flatMap(({id})=>{
    const delta=offsets.get(id);
    return Math.abs(delta)>1e-8?[{layerIds:[id],pivot:[0,0],offset:axis?[0,delta]:[delta,0],scale:1,angle:0}]:[];
  });
}
