import {hasMaterialMask,layerChildren,layerLockOwner,layerParent} from './paint-layer-tree.mjs';
import {draggedMaterial,materialDragType,smartMaterialDragType,smartMaterialPlacement} from './smart-material-placement.mjs';

const mime='application/x-arachne-material-layer';
const maskMime='application/x-arachne-material-mask';

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

export function createMaterialLayerDrag({read,selection,canDrag,commit,applyShelfMaterial}){
  let session=null,marker=null,location=null;
  function clearMarker(){
    if(marker){
      marker.ownerDocument.removeEventListener('dragend',clearMarker,true);
      delete marker.dataset.layerDrop;
    }
    marker=null;
    location?.remove();location=null;
  }
  function showShelfDestination(row,drop){
    const header=row.closest('.editor-area')?.querySelector(':scope > .area-header');
    if(!header)return;
    const layers=read().paint.layers,folders=[];
    let folder=layers.find(layer=>layer.id===drop.parentId);
    while(folder){
      folders.unshift(folder.name);
      folder=layers.find(layer=>layer.id===layerParent(folder));
    }
    const target=layers.find(layer=>layer.id===drop.targetId);
    location?.remove();
    const owner=row.ownerDocument;
    location=owner.createElement('output');
    location.className='material-drop-location';
    const path=owner.createElement('span'),names=owner.createElement('bdi'),slot=owner.createElement('span');
    names.textContent=folders.join(' › ')||'图层栈顶层';
    path.append(names);
    slot.textContent=drop.zone==='inside'?'放入文件夹顶部':
      (drop.zone==='above'?'上方':'下方')+' · '+(target?.name||'全 UV 底层');
    location.append(path,slot);header.append(location);
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
  function findShelfDrop(event,row,id){
    if(!applyShelfMaterial||!canDrag())return null;
    const doc=read(),target=doc?.paint.layers.find(layer=>layer.id===id);
    if(doc&&id===null)return smartMaterialPlacement(doc.paint.layers,null,'above');
    return target&&smartMaterialPlacement(doc.paint.layers,id,dropZone(event,row,target));
  }
  function findMaskDrop(event,id){
    const doc=read(),sourceId=session?.mask;
    if(!doc||!sourceId||sourceId===id||!canDrag()||!session.source.isConnected||
       doc.id!==session.origin.id||doc.revision!==session.origin.revision)return null;
    const layers=doc.paint.layers,target=layers.find(layer=>layer.id===id),source=layers.find(layer=>layer.id===sourceId);
    const copy=event.altKey;
    if(!target||!hasMaterialMask(source)||layerLockOwner(layers,target)||!copy&&layerLockOwner(layers,source))return null;
    return {zone:'mask',operation:{op:'transferMask',id,sourceId,copy}};
  }
  function bind(handle,row,id,view){
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
    const mask=view.mask;
    if(mask){
      mask.ondragstart=event=>{
        const doc=read(),layer=doc?.paint.layers.find(item=>item.id===id);
        if(!doc||!hasMaterialMask(layer)||!canDrag()){event.preventDefault();return;}
        cancel();
        session={origin:{id:doc.id,revision:doc.revision},mask:id,source:row};
        row.dataset.dragging='';
        event.dataTransfer.setData(maskMime,id);
        event.dataTransfer.effectAllowed=layerLockOwner(doc.paint.layers,layer)?'copy':'copyMove';
      };
      mask.ondragend=cancel;
    }
    bindTarget(row,id,view);
  }
  function bindTarget(row,id,{openFolder,filterText,revealPlaced},host=row){
    const accepts=event=>host===row||row.contains(event.target)||
      event.target===host&&event.clientY>=row.getBoundingClientRect().bottom;
    host.ondragenter=host.ondragover=event=>{
      if(!accepts(event)){
        if(marker===row)clearMarker();
        return;
      }
      const shelf=event.dataTransfer.types.some(type=>type===materialDragType||type===smartMaterialDragType);
      const drop=shelf?findShelfDrop(event,row,id):event.dataTransfer.types.includes(maskMime)?findMaskDrop(event,id):findDrop(event,row,id);
      const valid=shelf?!!drop:!!drop?.operation;
      if(marker&&(!valid||marker!==row))clearMarker();
      if(!valid)return;
      event.preventDefault();
      event.dataTransfer.dropEffect=shelf||drop.operation?.copy?'copy':'move';
      if(row.dataset.layerDrop!==drop.zone){
        row.dataset.layerDrop=drop.zone;
        if(shelf)showShelfDestination(row,drop);
      }
      if(marker!==row){
        marker=row;
        row.ownerDocument.addEventListener('dragend',clearMarker,true);
      }
      // The disclosure opens the path to a child without releasing the swatch.
      // The folder label remains the ordinary drop-inside target.
      if(shelf&&drop.zone==='inside'&&event.target.closest('button[aria-expanded="false"]:enabled'))
        openFolder?.(id);
    };
    host.ondragleave=event=>{
      if(marker===row&&!host.contains(event.relatedTarget))clearMarker();
    };
    host.ondrop=event=>{
      if(!accepts(event))return;
      const type=event.dataTransfer.types.find(type=>type===materialDragType||type===smartMaterialDragType);
      if(type){
        const placement=findShelfDrop(event,row,id),resource=draggedMaterial(event.dataTransfer,type),doc=read();
        clearMarker();
        if(!placement||!resource||!doc)return;
        event.preventDefault();
        const origin={id:doc.id,revision:doc.revision},query=filterText();
        void applyShelfMaterial(type,resource,placement,origin).then(saved=>{
          if(!saved||read()?.id!==origin.id||filterText()!==query)return;
          if(placement.zone==='inside')openFolder?.(id);
          const [placed]=selection();
          if(placed&&!doc.paint.layers.some(layer=>layer.id===placed))revealPlaced(placed);
        });
        return;
      }
      const drop=event.dataTransfer.types.includes(maskMime)?findMaskDrop(event,id):findDrop(event,row,id);
      if(!drop?.operation)return;
      event.preventDefault();
      const {origin}=session;
      cancel();
      void commit(drop.operation,origin).then(saved=>{
        if(saved&&drop.zone==='inside'&&read()?.id===origin.id)openFolder?.(id);
      });
    };
  }
  return {bind,bindBase:(row,view)=>bindTarget(row,null,view,row.parentElement)};
}
