import {createImageStrokeQueue} from './image-stroke-queue.mjs';
import {createStrokeDraftJournal,unavailableStrokeJournal} from './stroke-draft-journal.mjs';

// All viewports in this workbench share one journal. They may look at the
// model independently, but material strokes advance the same project revision.
export function createMaterialStrokeSave({workspace,project,readLatest,onSettled,onChange,onError,updatePreview}){
  let gestureOwner=null,restoredProject=null,previous=[],previousRevision=null;
  const document=workspace.ownerDocument;
  const recovery=document.createElement('div'),message=document.createElement('output');
  recovery.className='document-save-recovery material-stroke-recovery';recovery.hidden=true;
  message.setAttribute('role','alert');
  const button=(label,action)=>{
    const control=document.createElement('button');control.type='button';control.textContent=label;control.onclick=action;return control;
  };
  const retry=button('重试保存笔触',()=>void retrySave());
  const discard=button('放弃待保存笔触',()=>{
    const id=project.document?.id;
    if(window.confirm('放弃本窗口中待保存的材质笔触？已经写入工程的笔触仍会保留。')&&queue.discard())onSettled(id);
  });
  recovery.append(message,retry,discard);workspace.append(recovery);
  const journal=createStrokeDraftJournal(id=>'arachne-material-stroke-draft:'+id);
  function syncPreview(force=false){
    const origin=project.origin();if(!origin)return;
    const operations=queue.operations(origin);
    if(!operations.length&&!previous.length)return;
    if(!force&&previousRevision===origin.revision&&operations.length===previous.length&&operations.every((item,i)=>item===previous[i]))return;
    previous=operations;previousRevision=origin.revision;
    updatePreview(operations.length>1?operations:operations[0]??null);
  }
  function syncState(){
    recovery.hidden=!queue.failure;
    retry.disabled=discard.disabled=queue.saving||gestureOwner!==null;
    workspace.dataset.pendingMaterialStrokes=String(queue.size);
    if(queue.failure){
      const layer=project.document?.paint.layers.find(item=>item.id===queue.target?.[2]);
      message.textContent=`材质笔触 · ${layer?.name??'原图层'} · ${queue.size} 笔待保存。 ${queue.failure.message}${journal.unavailable?' '+unavailableStrokeJournal:''}`;
    }
    onChange();
  }
  const queue=createImageStrokeQueue({domain:'material',read:()=>project.document,readLatest,
    write:(operation,origin)=>project.commands([operation],origin),
    onPreview:syncPreview,onStateChange:syncState,onError:error=>{if(!queue.failure)onError(error);},
    onDraftChange:journal.write
  });
  function syncProject(){
    const id=project.document?.id;
    if(id&&id!==restoredProject){
      restoredProject=id;
      const draft=journal.read(id);
      if(queue.restore(id,draft))syncState();
    }
    syncPreview();
  }
  const unsubscribe=project.subscribe(event=>{if(event.kind==='project')syncProject();});
  async function retrySave(){
    if(gestureOwner!==null)return false;
    const id=project.document?.id,ok=await queue.retry();
    if(ok)onSettled(id);
    return ok;
  }
  function release(owner,origin=project.origin()){
    if(gestureOwner!==owner)return false;
    gestureOwner=null;queue.preview(null,origin);
    syncState();
    return true;
  }
  return {
    accepts:(owner,origin)=>(gestureOwner===null||gestureOwner===owner)&&queue.accepts(origin),
    preview(owner,operation,origin){
      if(!operation){release(owner,origin);return;}
      if(gestureOwner!==null&&gestureOwner!==owner)return;
      gestureOwner=owner;queue.preview(operation,origin);
    },
    submit(owner,operation,origin){
      if(gestureOwner!==null&&gestureOwner!==owner)return;
      gestureOwner=null;queue.submit(operation,origin);
    },
    release,syncPreview:()=>syncPreview(true),retrySave,flush:()=>queue.flush(),
    get editing(){return gestureOwner!==null;},
    get size(){return queue.size;},get saving(){return queue.saving;},
    status:()=>({pending:queue.size,saving:queue.saving,failure:queue.failure}),
    dispose(){unsubscribe();recovery.remove();delete workspace.dataset.pendingMaterialStrokes;}
  };
}
