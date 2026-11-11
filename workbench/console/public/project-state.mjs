// Shared authoritative project and change notifications. Editor view state lives elsewhere.
export function createProjectState({write,travel,draft,selectLayer,selectResource}){
  let imageContext=null,imageEditor=null,editorDomain='material';
  let doc=null,layerId=null,resource=null,frame=null,scene=null,previewStatus=null,brushDraft=null,nodeDraft=null,epoch=0;
  let pending=Promise.resolve();
  const enqueue=task=>{const result=pending.then(task);pending=result.catch(()=>{});return result;};
  const listeners=new Set();
  const emit=(kind,source,details={})=>{for(const listener of [...listeners])listener({kind,source,...details});};
  function document(next){
    if(!next)return;
    if(doc?.id!==next.id){epoch++;imageContext=null;editorDomain='material';layerId=null;resource=null;frame=null;scene=null;previewStatus=null;}
    else if(next.revision<doc.revision)return;
    const clearDraft=brushDraft&&(brushDraft.origin.id!==next.id||brushDraft.origin.revision!==next.revision);
    if(clearDraft)brushDraft=null;
    const clearNode=nodeDraft&&(nodeDraft.origin.id!==next.id||nodeDraft.origin.revision!==next.revision);
    if(clearNode)nodeDraft=null;
    const changed=doc!==next;doc=next;if(clearNode)draft(null);if(changed||clearDraft)emit('project');
  }
  return {
    get imageContext(){return imageContext;},get imageEditor(){return imageEditor;},get editorDomain(){return editorDomain;},
    setEditorDomain(next){if(!['image','material'].includes(next)||next===editorDomain)return;editorDomain=next;emit('editorDomain');},
    selectImage(next,source,{force=false}={}){if(!force&&JSON.stringify(next)===JSON.stringify(imageContext))return;imageContext=next;emit('imageSelection',source,{force});},
    activateImageEditor(id,selection){imageEditor=id;this.selectImage(selection,id);},
    releaseImageEditor(id){if(imageEditor===id)imageEditor=null;},
    get document(){return doc;},get layerId(){return layerId;},get resource(){return resource;},get frame(){return frame;},get scene(){return scene;},get previewStatus(){return previewStatus;},get brushDraft(){return brushDraft;},
    origin:()=>doc?{id:doc.id,revision:doc.revision}:null,
    publish:document,
    notifyView(source){emit('view',source);},
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    publishFrame(next){if(next?.request.id!==doc?.id||next.request.revision!==doc.revision)return;frame=next;emit('frame');},
    publishPreviewStatus(next){previewStatus=next;emit('preview');},
    publishScene(next){scene=next;emit('scene');},
    selectedLayer(id,source,{force=false}={}){if(!force&&layerId===id)return;layerId=id;emit('selection',source,{force});},
    selectedResource(next,source,{force=false}={}){if(!force&&JSON.stringify(resource)===JSON.stringify(next))return;resource=next;emit('resource',source,{force});},
    selectLayer(id,source){this.setEditorDomain('material');selectLayer(id);layerId=id;emit('selection',source,{force:true});},
    selectResource(next,source){selectResource(next);resource=next;emit('resource',source,{force:true});},
    setBrushDraft(owner,origin,graph){
      if(!graph){if(brushDraft?.owner!==owner||origin&&JSON.stringify(brushDraft.origin)!==JSON.stringify(origin))return false;brushDraft=null;emit('brushDraft',owner);return true;}
      const target=origin?.target;if(!doc||origin.id!==doc.id||origin.revision!==doc.revision||target?.library!=='brushes'||!Object.hasOwn(doc.paint.brushes||{},target.id))return false;
      brushDraft={owner,origin:structuredClone(origin),graph:structuredClone(graph)};emit('brushDraft',owner);return true;
    },
    setNodeDraft(owner,origin,operation){
      if(!operation){if(nodeDraft?.owner!==owner||origin&&JSON.stringify(nodeDraft.origin)!==JSON.stringify(origin))return false;nodeDraft=null;draft(null);return true;}
      const target=origin?.target,valid=target?target.library==='materials'&&operation.op==='library'&&operation.library==='materials'&&operation.id===target.id&&Object.hasOwn(doc?.paint.materials||{},target.id):operation.op==='shader';
      if(!doc||!origin||origin.id!==doc.id||origin.revision!==doc.revision||!valid)return false;
      nodeDraft={owner,origin:structuredClone(origin)};draft(operation);return true;
    },
    acceptExternalDraft(operation){if(operation)nodeDraft=null;return !!operation||!nodeDraft;},
    async commands(operations,origin){
      origin??=this.origin();if(!origin||origin.id!==doc?.id||origin.revision!==doc.revision)throw Error('工程修订已变化，请重新编辑');
      return enqueue(async()=>{if(origin.id!==doc?.id||origin.revision!==doc.revision)throw Error('工程修订已变化，请重新编辑');const generation=epoch,result=await write(operations,origin);
      if(result===false)throw Error('工程修改未保存');if(generation===epoch&&result?.id===doc.id)document(result);return result;});
    },
    async travel(direction){const origin=this.origin();return enqueue(async()=>{if(!origin||origin.id!==doc?.id)throw Error('工程已切换，撤销未执行');const result=await travel(direction,{...origin,revision:doc.revision});if(result?.id===doc?.id)document(result);return result;});},
    draft(operation){if(operation)nodeDraft=null;if(operation||!nodeDraft)draft(operation);},
    listenerCount:()=>listeners.size
  };
}
