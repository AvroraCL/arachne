import {layerChildren,layerLockOwner,layerParent,layerTreeOrder} from './paint-layer-tree.mjs';

const layerId=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const locked=()=>Object.assign(Error('图像图层或上级组已锁定'),{status:423});
const byId=(layers,id)=>layers.find(layer=>layer.id===id);
const sameParent=(a,b)=>layerParent(a)===layerParent(b);
export const imageGroupBlend='passThrough';

export function validateImageLayerTree(layers){
  const byKey=new Map(layers.map(layer=>[layer.id,layer]));
  for(const layer of layers){
    let depth=0;
    for(let parent=layerParent(layer);parent!==null;){
      const group=byKey.get(parent);
      if(!layerId(parent)||group?.kind!=='group'||++depth>4)throw Error('图层组归属无效，最多嵌套 4 层');
      parent=layerParent(group);
    }
  }
}

export function imageLayerInsertion(layers,selectedId){
  const selected=byId(layers,selectedId);
  if(!selected)return {};
  if(selected.kind==='group')return {parentId:selected.id};
  const index=layers.indexOf(selected)+1;
  return {parentId:layerParent(selected),index};
}

export function imageStackBase(layers,index){
  const item=layers[index];
  if(!item||item.kind==='group')return null;
  for(let i=index-1;i>=0;i--){
    const layer=layers[i];
    if(!sameParent(layer,item)||layer.clipped)continue;
    return ['adjustment','group'].includes(layer.kind)?null:layer;
  }
  return null;
}

export function followingClips(layers,item){
  const siblings=layerChildren(layers,layerParent(item)),following=[];
  for(let i=siblings.indexOf(item)+1;siblings[i]?.clipped;i++)following.push(siblings[i]);
  return following;
}

export function repairImageClips(layers){
  for(const [index,layer] of layers.entries()){
    if(layer.clipped&&!imageStackBase(layers,index))
      for(const item of [layer,...followingClips(layers,layer)])delete item.clipped;
  }
}

function setParent(layer,parent){
  if(parent===null)delete layer.parentId;
  else layer.parentId=parent;
}

export function imageGroupTarget(layers,parentId){
  if(parentId==null)return null;
  const group=byId(layers,parentId);
  if(!layerId(parentId)||group?.kind!=='group')throw Error('目标图层组不存在');
  if(layerLockOwner(layers,group))throw locked();
  return group;
}

export function groupImageLayers(doc,ids,group){
  const {layers}=doc;
  if(!Array.isArray(ids)||!ids.length||ids.length>layers.length||new Set(ids).size!==ids.length)
    throw Error('请选择要成组的图层');
  const selection=new Set(ids),items=layers.filter(layer=>selection.has(layer.id));
  if(items.length!==ids.length||items.some(layer=>!sameParent(layer,items[0])))
    throw Error('请选择同一层级的图层');
  if(items.some(layer=>layerLockOwner(layers,layer)))throw locked();
  for(const [index,layer] of layers.entries()){
    if(layer.clipped&&selection.has(layer.id)!==selection.has(imageStackBase(layers,index)?.id))
      throw Error('请将剪贴蒙版和对应底层一起成组');
  }
  setParent(group,layerParent(items[0]));
  const index=layers.indexOf(items.at(-1));
  for(const item of items)setParent(item,group.id);
  layers.splice(index+1,0,group);
}

export function ungroupImageLayer(doc,group){
  if(group.kind!=='group')throw Error('请选择图层组');
  const {layers}=doc,children=layerChildren(layers,group.id),ids=new Set(children.map(layer=>layer.id));
  for(const item of children)setParent(item,layerParent(group));
  doc.layers=layers.flatMap(item=>item===group?children:ids.has(item.id)?[]:[item]);
}

export function removeImageLayer(doc,layer){
  const layers=doc.layers,descendants=layer.kind==='group'?layerTreeOrder(layers,layer.id):[];
  if(descendants.some(item=>item.locked))throw locked();
  const clips=layer.clipped?[]:followingClips(layers,layer);
  for(const item of clips)delete item.clipped;
  const remove=new Set([layer,...descendants]);
  doc.layers=layers.filter(item=>!remove.has(item));
}

export function duplicateImageLayer(doc,layer,id){
  const {layers}=doc,descendants=layer.kind==='group'?layerTreeOrder(layers,layer.id):[];
  const ids=new Map([[layer.id,id],...descendants.map(item=>[item.id,crypto.randomUUID()])]);
  const copies=[layer,...descendants].map(item=>{
    const copy=structuredClone(item);
    copy.id=ids.get(item.id);
    if(item===layer)copy.name=copy.name.slice(0,90)+' 副本';
    else copy.parentId=ids.get(layerParent(item));
    return copy;
  });
  const next=layer.clipped?layer:followingClips(layers,layer).at(-1)??layer;
  layers.splice(layers.indexOf(next)+1,0,...copies);
}

export function arrangeImageLayer(doc,layer,{anchorId,placement}){
  const {layers}=doc,anchor=byId(layers,anchorId);
  if(!anchor||!['above','below','inside'].includes(placement)||anchor===layer)throw Error('请选择有效的放置位置');
  const inside=placement==='inside';
  if(inside&&anchor.kind!=='group')throw Error('请选择目标图层组');
  const parent=inside?anchor.id:layerParent(anchor);
  imageGroupTarget(layers,parent);
  if(layer.kind==='group'&&layerTreeOrder(layers,layer.id).includes(anchor))
    throw Error('不能将图层组移入自身');
  layers.splice(layers.indexOf(layer),1);
  setParent(layer,parent);
  const neighbors=layerChildren(layers,parent);
  const after=placement==='above'?anchor:inside?neighbors.at(-1):null;
  const index=after?layers.indexOf(after)+1:layers.indexOf(anchor);
  const target=neighbors[after?neighbors.indexOf(after)+1:inside?0:neighbors.indexOf(anchor)];
  if(layer.kind!=='group'&&target?.clipped&&sameParent(layer,target))layer.clipped=true;
  layers.splice(index,0,layer);
  repairImageClips(layers);
}

export function isolateImageLayer(layers,id){
  const item=byId(layers,id);
  if(!item)return [];
  const root={...item,clipped:false};
  delete root.parentId;
  return [root,...(item.kind==='group'?layerTreeOrder(layers,id):[])];
}

export function imageLayersBefore(layers,item,clippedBase){
  const parent=layerParent(item),group=byId(layers,parent),siblings=layerChildren(layers,parent);
  const previous=siblings.slice(clippedBase?siblings.indexOf(clippedBase):0,siblings.indexOf(item))
    .flatMap(layer=>{
      const root={...layer};
      delete root.parentId;
      return [root,...(layer.kind==='group'?layerTreeOrder(layers,layer.id):[])];
    });
  return !clippedBase&&group?.blend===imageGroupBlend
    ?[...imageLayersBefore(layers,group,null),...previous]:previous;
}
