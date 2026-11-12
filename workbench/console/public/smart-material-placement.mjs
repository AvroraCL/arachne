import {layerParent,layerLockOwner} from './paint-layer-tree.mjs';

export const smartMaterialDragType='application/x-arachne-smart-material';

export function smartMaterialPlacement(layers,targetId,zone){
  const target=layers.find(layer=>layer.id===targetId);
  if(!target||!['above','below','inside'].includes(zone)||zone==='inside'&&target.kind!=='group')return null;
  const parentId=zone==='inside'?targetId:layerParent(target);
  if(parentId!==null&&layerLockOwner(layers,layers.find(layer=>layer.id===parentId)))return null;
  return {targetId,zone,parentId};
}

export function draggedSmartMaterial(transfer){
  let value;
  try{value=JSON.parse(transfer.getData(smartMaterialDragType));}catch{return null;}
  return value&&typeof value.id==='string'&&/^[\w-]{1,100}$/.test(value.id)&&
    Number.isSafeInteger(value.revision)&&value.revision>=0?value:null;
}
