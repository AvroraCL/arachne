import {layerChildren,layerLockOwner,layerParent,layerTreeOrder} from './paint-layer-tree.mjs';
import {followingClips,imageGroupTarget,imageStackBase,validateImageLayerTree} from './image-layer-tree.mjs';

export const imageLayerLimit=64;
const identifier=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const lockError=()=>Object.assign(Error('所选图层、组内图层或剪贴图层已锁定'),{status:423});

// Normalize from the tree's actual stacking order. A group owns its whole
// subtree even if one or more children were individually selected as well.
export function imageBatchSelection(layers,ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>layers.length||!ids.every(identifier)||new Set(ids).size!==ids.length)
    throw Error('请选择有效的图像图层');
  validateImageLayerTree(layers);
  const byId=new Map(layers.map(layer=>[layer.id,layer])),selection=new Set(ids);
  if(ids.some(id=>!byId.has(id)))throw Error('部分所选图层已不存在');
  const ordered=layerTreeOrder(layers);
  const roots=ordered.filter(layer=>{
    if(!selection.has(layer.id))return false;
    for(let parent=layerParent(layer);parent!==null;parent=layerParent(byId.get(parent))){
      if(selection.has(parent))return false;
    }
    return true;
  });
  const affected=roots.flatMap(layer=>[
    layer,...(layer.kind==='group'?layerTreeOrder(layers,layer.id):[])
  ]);
  return {ordered,roots,affected,removed:new Set(affected.map(layer=>layer.id))};
}

function requireUnlocked(layers,items){
  if(items.some(layer=>layerLockOwner(layers,layer)))throw lockError();
}
function clipBases(layers){
  return new Map(layers.flatMap((layer,i)=>layer.clipped?[[layer.id,imageStackBase(layers,i)?.id??null]]:[]));
}
function preservesClipBases(layers,expected){
  const result=clipBases(layers);
  return [...expected].every(([clip,base])=>result.get(clip)===base);
}
function reparent(layer,parentId){
  const moved={...layer};
  if(parentId===null)delete moved.parentId;
  else moved.parentId=parentId;
  return moved;
}

export function planImageLayerMove(layers,ids,{anchorId,placement}){
  const batch=imageBatchSelection(layers,ids);
  requireUnlocked(layers,batch.affected);
  const anchor=layers.find(layer=>layer.id===anchorId);
  if(!anchor||!['above','below','inside'].includes(placement))throw Error('请选择有效的放置位置');
  if(batch.removed.has(anchor.id))throw Error('不能将所选图层放到自身或组内子项');
  const inside=placement==='inside';
  if(inside&&anchor.kind!=='group')throw Error('请选择目标图层组');
  const parentId=inside?anchor.id:layerParent(anchor);
  imageGroupTarget(layers,parentId);
  const remaining=batch.ordered.filter(layer=>!batch.removed.has(layer.id));
  const after=inside?(layerChildren(remaining,parentId).at(-1)??anchor):anchor;
  const index=remaining.indexOf(after)+(placement==='below'?0:1);
  const rootIds=new Set(batch.roots.map(layer=>layer.id));
  remaining.splice(index,0,...batch.affected.map(layer=>rootIds.has(layer.id)?reparent(layer,parentId):layer));
  validateImageLayerTree(remaining);
  const next=layerTreeOrder(remaining);
  if(!preservesClipBases(next,clipBases(batch.ordered)))
    throw Error('此位置会改变剪贴关系。请选择同一剪贴组的底层和图层，或移到剪贴组外。');
  const changed=next.some((layer,i)=>layer.id!==batch.ordered[i].id||layerParent(layer)!==layerParent(batch.ordered[i]));
  return {...batch,layers:next,changed,parentId};
}

export function imageLayerMoveStep(layers,ids,direction){
  const batch=imageBatchSelection(layers,ids),parent=layerParent(batch.roots[0]);
  if(![1,-1].includes(direction))throw Error('请选择图层移动方向');
  requireUnlocked(layers,batch.affected);
  if(batch.roots.some(layer=>layerParent(layer)!==parent))return null;
  const siblings=layerChildren(layers,parent),indices=batch.roots.map(layer=>siblings.indexOf(layer));
  const start=direction>0?Math.max(...indices):Math.min(...indices);
  for(let i=start+direction;i>=0&&i<siblings.length;i+=direction){
    const anchorId=siblings[i].id,placement=direction>0?'above':'below';
    try{
      const plan=planImageLayerMove(layers,ids,{anchorId,placement});
      if(plan.changed)return {anchorId,placement};
    }catch(error){if(error.status===423)throw error;}
  }
  return null;
}

export function planImageLayerDelete(layers,ids){
  const batch=imageBatchSelection(layers,ids);
  requireUnlocked(layers,batch.affected);
  const bases=clipBases(batch.ordered),released=batch.ordered.filter(layer=>
    !batch.removed.has(layer.id)&&batch.removed.has(bases.get(layer.id)));
  requireUnlocked(layers,released);
  const releases=new Set(released.map(layer=>layer.id));
  const kept=batch.ordered.filter(layer=>!batch.removed.has(layer.id)).map(layer=>{
    if(!releases.has(layer.id))return layer;
    const next={...layer};delete next.clipped;return next;
  });
  return {...batch,layers:kept,released};
}

export function checkImageLayerDuplicate(layers,ids){
  const batch=imageBatchSelection(layers,ids);
  // Copying a group keeps the locks on its contents. Directly selecting a
  // locked layer (or a layer within a locked group) is still protected.
  requireUnlocked(layers,batch.roots);
  if(layers.length+batch.affected.length>imageLayerLimit)throw Error('复制后将超过 '+imageLayerLimit+' 个图层');
  return batch;
}

export function duplicateImageLayerBatch(layers,ids,copyIds){
  const batch=checkImageLayerDuplicate(layers,ids);
  const taken=new Set(layers.map(layer=>layer.id));
  if(!Array.isArray(copyIds)||copyIds.length!==batch.roots.length||!copyIds.every(id=>identifier(id)&&!taken.has(id))||
     new Set(copyIds).size!==copyIds.length)throw Error('图层副本编号无效');
  for(const id of copyIds)taken.add(id);
  const cloneIds=new Map(batch.roots.map((layer,i)=>[layer.id,copyIds[i]]));
  for(const layer of batch.affected){
    if(cloneIds.has(layer.id))continue;
    let id;
    do{id=crypto.randomUUID();}while(taken.has(id));
    taken.add(id);cloneIds.set(layer.id,id);
  }
  const rootIds=new Set(batch.roots.map(layer=>layer.id)),bases=clipBases(batch.ordered),after=new Map();
  const usedNames=new Map();
  for(const layer of batch.ordered){
    const parent=layerParent(layer),names=usedNames.get(parent)??new Set();
    names.add(layer.name);usedNames.set(parent,names);
  }
  function copyOf(layer){
    const copy=structuredClone(layer);
    copy.id=cloneIds.get(layer.id);
    if(rootIds.has(layer.id)){
      const names=usedNames.get(layerParent(layer));
      let count=1;
      const nameFor=suffix=>copy.name.slice(0,100-suffix.length).trimEnd()+suffix;
      let name=nameFor(' 副本');
      while(names.has(name))name=nameFor(' 副本 '+(++count));
      names.add(name);copy.name=name;
    }else copy.parentId=cloneIds.get(layerParent(layer));
    return copy;
  }
  for(const root of batch.roots){
    if(root.clipped&&cloneIds.has(bases.get(root.id)))continue;
    const attached=root.clipped?[]:followingClips(batch.ordered,root);
    const anchor=attached.at(-1)??root;
    const owned=[root,...(root.kind==='group'?layerTreeOrder(layers,root.id):[]),
      ...attached.filter(layer=>rootIds.has(layer.id))];
    const copies=after.get(anchor.id)??[];
    copies.push(...owned.map(copyOf));after.set(anchor.id,copies);
  }
  const next=layerTreeOrder(batch.ordered.flatMap(layer=>[layer,...(after.get(layer.id)??[])]));
  const bindings=new Map(bases);
  for(const [clip,base] of bases)if(cloneIds.has(clip))bindings.set(cloneIds.get(clip),cloneIds.get(base)??base);
  if(!preservesClipBases(next,bindings))throw Error('无法复制并保留剪贴关系');
  return next;
}
