import {paintChannels} from './paint-channels.mjs';
import {layerParent,layerLockOwner} from './paint-layer-tree.mjs';

export const materialDragType='application/x-arachne-library-material';

export function libraryFill(paint,id,position){
  if(!Object.hasOwn(paint.materials??{},id))throw Error('工程材质不存在');
  return {op:'add',kind:'fill',...position,patch:{
    name:paint.materials[id].name,materialId:id,channels:Object.fromEntries(paintChannels.map(k=>[k,true]))
  }};
}

export function bindMaterialTile(tile,id,read,canEdit){
  tile.draggable=true;
  tile.title=tile.getAttribute('aria-label')+' · 双击在当前层级顶部创建填充层，拖动可指定位置';
  tile.ondragstart=event=>{
    const doc=read();
    if(!doc||!canEdit()||!Object.hasOwn(doc.paint.materials,id)){event.preventDefault();return;}
    event.dataTransfer.setData(materialDragType,JSON.stringify({id,projectId:doc.id,revision:doc.revision}));
    event.dataTransfer.effectAllowed='copy';
  };
}

export function syncFillAction(button,destination,available){
  button.disabled=!available||destination.locked;
  button.textContent=destination.locked?'文件夹已锁定':'创建填充层';
  button.title=destination.description;
}

export const smartMaterialDragType='application/x-arachne-smart-material';

export function smartMaterialPlacement(layers,targetId,zone){
  if(targetId===null&&zone==='above')return {targetId,zone,parentId:null};
  const target=layers.find(layer=>layer.id===targetId);
  if(!target||!['above','below','inside'].includes(zone)||zone==='inside'&&target.kind!=='group')return null;
  const parentId=zone==='inside'?targetId:layerParent(target);
  if(parentId!==null&&layerLockOwner(layers,layers.find(layer=>layer.id===parentId)))return null;
  return {targetId,zone,parentId};
}

export function insertMaterialLayers(layers,copies,placement){
  const target=smartMaterialPlacement(layers,placement?.targetId,placement?.zone);
  if(!target)throw Error('材质的放置位置已变化或被锁定');
  copies[0].parentId=target.parentId;
  let index=0; // Dropping in the blank space places the material below all root layers.
  if(target.zone==='inside')index=layers.length;
  else if(target.targetId!==null)index=layers.findIndex(layer=>layer.id===target.targetId)+(target.zone==='above'?1:0);
  layers.splice(index,0,...copies);
}

export function draggedMaterial(transfer,type){
  let value;
  try{value=JSON.parse(transfer.getData(type));}catch{return null;}
  return value&&typeof value.id==='string'&&/^[\w-]{1,100}$/.test(value.id)&&
    Number.isSafeInteger(value.revision)&&value.revision>=0?value:null;
}
