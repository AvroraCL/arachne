import clipping from 'polygon-clipping';
import {uvRegionLimits} from './uv-selection-region.mjs';

export const uvSelectionModes=Object.freeze(['replace','add','subtract','intersect']);
export const canvasUVRect=Object.freeze([0,0,1,1]);
export const uvCorners=([left,top,right,bottom])=>[[left,top],[right,top],[right,bottom],[left,bottom]];

export function uvBounds(points){
  let left=1,top=1,right=0,bottom=0;
  for(const [x,y] of points){
    left=Math.min(left,x);top=Math.min(top,y);
    right=Math.max(right,x);bottom=Math.max(bottom,y);
  }
  return [left,top,right,bottom];
}

function polygonGeometry(selection){
  return selection.regions||[[selection.polygon||uvCorners(selection.rect)]];
}

export function selectionContours(selection){
  return selection?.regions?.flat()||(selection?.polygon?[selection.polygon]:[]);
}

export function combineUVSelections(previous,next,mode){
  if(mode==='replace'||!previous&&mode==='add')return next;
  if(!previous)return null;
  const first=polygonGeometry(previous),second=polygonGeometry(next);
  const result=mode==='add'?clipping.union(first,second):
    mode==='subtract'?clipping.difference(first,second):clipping.intersection(first,second);
  if(!result.length)return null;
  const regions=result.map(polygon=>polygon.map(ring=>ring.slice(0,-1).map(point=>point.map(n=>Math.min(1,Math.max(0,n))))));
  const rings=regions.flat(),points=rings.flat(),rect=uvBounds(points);
  if(rings.length>uvRegionLimits.rings||points.length>uvRegionLimits.points)throw Error('选区轮廓过于复杂，请减少套索节点或拆分操作');
  if(rect[2]-rect[0]<1/4096||rect[3]-rect[1]<1/4096)return null;
  return {rect,regions};
}

export function offsetUVSelection(selection,[dx,dy]){
  const translate=ring=>ring.map(([x,y])=>[Math.max(0,Math.min(1,x+dx)),Math.max(0,Math.min(1,y+dy))]);
  return {rect:selection.rect.map((n,i)=>Math.max(0,Math.min(1,n+(i%2?dy:dx)))),
    ...(selection.polygon?{polygon:translate(selection.polygon)}:{}),
    ...(selection.regions?{regions:selection.regions.map(polygon=>polygon.map(translate))}:{})};
}
