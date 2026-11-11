// A resource drag carries its originating project and revision across editor instances.
export const assetDragType='application/x-arachne-asset';
const originType='application/x-arachne-asset-origin';
let current=null;
export function startAssetDrag(transfer,{id,projectId,revision}){
  current={id,projectId,revision};
  transfer.setData(assetDragType,id);
  transfer.setData(originType,JSON.stringify({projectId,revision}));
  transfer.effectAllowed='copy';
}
export const currentAssetDrag=()=>current;
export function endAssetDrag(){current=null;}
export const hasAssetDrag=transfer=>!!transfer?.types.includes(assetDragType);
export function readAssetDrag(transfer,doc){
  if(!hasAssetDrag(transfer)||!doc)return null;
  let origin;try{origin=JSON.parse(transfer.getData(originType));}catch{return null;}
  const id=transfer.getData(assetDragType);
  if(!origin||origin.projectId!==doc.id||origin.revision!==doc.revision||!Object.hasOwn(doc.paint.assets,id))return null;
  return {id,projectId:origin.projectId,revision:origin.revision};
}
