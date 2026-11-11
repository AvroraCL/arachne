// Each image canvas owns its view selection; panels follow the last active canvas.
export function createImageEditorSelection(shared,{areaId,saved,onChange=()=>{}}){
  const selections=Object.create(null),listeners=new Set();
  if(saved&&typeof saved==='object'&&!Array.isArray(saved))for(const [id,value] of Object.entries(saved).slice(-32)){
    if(/^[\w-]{1,100}$/.test(id)&&value&&typeof value==='object'&&!Array.isArray(value))selections[id]=structuredClone(value);
  }
  let projectId=null,selection=null,disposed=false;
  function publishInitial(){
    if(!selection||shared.imageEditor||shared.imageContext)return false;
    const documents=shared.document?.paint?.imageDocuments,image=documents&&Object.hasOwn(documents,selection.documentId)?documents[selection.documentId]:null;
    if(!Array.isArray(image?.layers)||(image.layers.length?!image.layers.some(layer=>layer.id===selection.layerId):selection.layerId!=null))return false;
    shared.selectImage(selection,areaId);return true;
  }
  function ensure(){
    const id=shared.document?.id||null;if(id===projectId)return;
    projectId=id;selection=id&&Object.hasOwn(selections,id)?structuredClone(selections[id]):id&&shared.imageContext?structuredClone(shared.imageContext):null;
    if(id&&selection&&!Object.hasOwn(selections,id)){selections[id]=structuredClone(selection);onChange();}
    if(id)publishInitial();
  }
  function remember(next){
    selection=next==null?null:structuredClone(next);if(!projectId)return;
    if(selection)selections[projectId]=structuredClone(selection);else delete selections[projectId];
    const keys=Object.keys(selections);if(keys.length>32)delete selections[keys[0]];onChange();
  }
  const emit=event=>{for(const listener of [...listeners])listener(event);};
  const unsubscribe=shared.subscribe(event=>{
    if(disposed)return;const previous=projectId;ensure();
    if(event.kind==='project'&&previous!==projectId&&shared.imageEditor===areaId&&selection)shared.selectImage(selection,areaId);
    if(event.kind==='imageSelection'&&shared.imageEditor===areaId&&event.source!==areaId&&JSON.stringify(selection)!==JSON.stringify(shared.imageContext))remember(shared.imageContext);
    emit(event);
  });
  function select(next,source,{force=false}={}){
    if(disposed)return;ensure();if(!projectId||!force&&JSON.stringify(next)===JSON.stringify(selection))return;
    remember(next);if(shared.imageEditor===areaId)shared.selectImage(selection,areaId,{force});else if(!publishInitial())emit({kind:'imageSelection',source:areaId,force});
  }
  function subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
  const project=new Proxy(shared,{get(target,key){if(key==='imageContext'){ensure();return selection;}if(key==='selectImage')return select;if(key==='subscribe')return subscribe;if(key==='isImageEditorActive')return ()=>!disposed&&shared.imageEditor===areaId&&shared.editorDomain==='image';return Reflect.get(target,key,target);}});
  return {project,activate(){if(disposed)return;ensure();shared.activateImageEditor(areaId,selection);},isActive:()=>!disposed&&shared.imageEditor===areaId,
    getState:()=>structuredClone(selections),dispose(){if(disposed)return;disposed=true;unsubscribe();listeners.clear();shared.releaseImageEditor(areaId);}};
}
