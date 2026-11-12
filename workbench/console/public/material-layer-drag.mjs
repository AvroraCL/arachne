import {layerChildren,layerLockOwner,layerParent} from './paint-layer-tree.mjs';
import {draggedSmartMaterial,smartMaterialDragType,smartMaterialPlacement} from './smart-material-placement.mjs';

const mime='application/x-arachne-material-layer';

export function materialLayerDrop(layers,ids,targetId,zone){
  const byId=new Map(layers.map(layer=>[layer.id,layer]));
  const selection=new Set(ids),moving=layers.filter(layer=>selection.has(layer.id)),target=byId.get(targetId);
  if(!target||!ids.length||moving.length!==ids.length||selection.has(targetId)||
     moving.some(layer=>layerParent(layer)!==layerParent(moving[0])||layerLockOwner(layers,layer)))return null;

  const inside=zone==='inside';
  if(inside?target.kind!=='group':!['above','below'].includes(zone))return null;
  const parentId=inside?target.id:layerParent(target);
  if(layerLockOwner(layers,byId.get(parentId)))return null;
  for(let parent=target;parent;parent=byId.get(layerParent(parent))){
    if(selection.has(parent.id))return null;
  }

  if(layerParent(moving[0])===parentId){
    const siblings=layerChildren(layers,parentId);
    const remaining=siblings.filter(layer=>!selection.has(layer.id));
    const at=inside?remaining.length:remaining.indexOf(target)+(zone==='above'?1:0);
    remaining.splice(at,0,...moving);
    if(siblings.every((layer,index)=>layer===remaining[index]))return null;
  }
  return {op:'arrange',ids,parentId,...(inside?{}:{anchorId:target.id}),placement:inside?'above':zone};
}

export function createMaterialLayerDrag({read,selection,canDrag,commit,importSmartMaterial}){
  let session=null,marker=null;
  function clearMarker(){
    if(marker)delete marker.dataset.layerDrop;
    marker=null;
  }
  function cancel(){
    if(session)delete session.source.dataset.dragging;
    session=null;
    clearMarker();
  }
  function dropZone(event,row,target){
    const bounds=row.getBoundingClientRect(),position=(event.clientY-bounds.top)/bounds.height;
    return target.kind==='group'&&position>=.25&&position<=.75?'inside':position<.5?'above':'below';
  }
  function findDrop(event,row,id){
    if(!session||!event.dataTransfer.types.includes(mime))return null;
    const doc=read();
    if(!doc||!canDrag()||session.origin.id!==doc.id||session.origin.revision!==doc.revision||!session.source.isConnected){
      cancel();
      return null;
    }
    const target=doc.paint.layers.find(layer=>layer.id===id);
    if(!target)return null;
    const zone=dropZone(event,row,target);
    if(session.last?.id===id&&session.last.zone===zone)return session.last;
    return session.last={id,zone,operation:materialLayerDrop(doc.paint.layers,session.ids,id,zone)};
  }
  function findSmartDrop(event,row,id){
    if(!importSmartMaterial||!canDrag())return null;
    const doc=read(),target=doc?.paint.layers.find(layer=>layer.id===id);
    return target&&smartMaterialPlacement(doc.paint.layers,id,dropZone(event,row,target));
  }
  function bind(handle,row,id,openFolder){
    handle.ondragstart=event=>{
      const doc=read();
      if(!doc||!handle.draggable||!canDrag()){event.preventDefault();return;}
      const active=selection(),ids=active.includes(id)?active:[id];
      const layers=doc.paint.layers;
      if(ids.some(key=>{const layer=layers.find(item=>item.id===key);return !layer||layerLockOwner(layers,layer);})){
        event.preventDefault();
        return;
      }
      cancel();
      session={origin:{id:doc.id,revision:doc.revision},ids,source:row,last:null};
      row.dataset.dragging='';
      event.dataTransfer.setData(mime,id);
      event.dataTransfer.effectAllowed='move';
    };
    handle.ondragend=cancel;
    row.ondragenter=row.ondragover=event=>{
      const smart=event.dataTransfer.types.includes(smartMaterialDragType);
      const drop=smart?findSmartDrop(event,row,id):findDrop(event,row,id);
      const valid=smart?!!drop:!!drop?.operation;
      if(marker&&(!valid||marker!==row))clearMarker();
      if(!valid)return;
      event.preventDefault();
      event.dataTransfer.dropEffect=smart?'copy':'move';
      if(row.dataset.layerDrop!==drop.zone)row.dataset.layerDrop=drop.zone;
      marker=row;
    };
    row.ondragleave=event=>{
      if(marker===row&&!row.contains(event.relatedTarget))clearMarker();
    };
    row.ondrop=event=>{
      if(event.dataTransfer.types.includes(smartMaterialDragType)){
        const placement=findSmartDrop(event,row,id),resource=draggedSmartMaterial(event.dataTransfer),doc=read();
        clearMarker();
        if(!placement||!resource||!doc)return;
        event.preventDefault();
        const origin={id:doc.id,revision:doc.revision};
        void importSmartMaterial(resource,placement,origin).then(saved=>{
          if(saved&&placement.zone==='inside'&&read()?.id===origin.id)openFolder?.(id);
        });
        return;
      }
      const drop=findDrop(event,row,id);
      if(!drop?.operation)return;
      event.preventDefault();
      const {origin}=session;
      cancel();
      void commit(drop.operation,origin).then(saved=>{
        if(saved&&drop.zone==='inside'&&read()?.id===origin.id)openFolder?.(id);
      });
    };
  }
  return {bind};
}
