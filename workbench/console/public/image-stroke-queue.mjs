export const imageStrokeQueueLimit=16;
export const strokeReceiptLimit=64;

const same=(a,b)=>a?.length===b.length&&b.every((value,index)=>a[index]===value);
const receipt=(doc,entry)=>entry&&doc?.strokeSaveReceipts?.find(item=>item.id===entry.requestId);
const requestIdPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const networkFailure=error=>error instanceof TypeError||['AbortError','TimeoutError'].includes(error?.name);

// A receipt can identify a single stroke from either editor. The same
// identity also constrains which drafts may be composited in one live frame.
export function strokeTarget(op){
  if(!op?.stroke||typeof op.stroke!=='object'||Array.isArray(op.stroke))return null;
  if(op.op==='image'&&op.action==='stroke'&&typeof op.documentId==='string'&&typeof op.layerId==='string'&&['pixels','mask'].includes(op.target))
    return ['image',op.documentId,op.layerId,op.target];
  if(op.op==='stroke'&&typeof op.id==='string'&&['material','mask'].includes(op.target))
    return ['material','surface',op.id,op.target];
  return null;
}

export function createImageStrokeQueue({read,readLatest,write,onPreview,onStateChange,onError,onDraftChange=()=>{},
    domain='image',allowRebase=domain==='image'}){
  const identity=origin=>[origin.id,domain==='material'?'surface':origin.documentId,origin.layerId,origin.target];
  const operationKey=(id,op)=>{
    const key=strokeTarget(op);
    return key?.[0]===domain?[id,...key.slice(1)]:null;
  };
  let target=null,expected=null,active=null,task=null,failure=null,canRebase=false;
  const pending=[];
  function reset(){
    target=null;expected=null;failure=null;canRebase=false;
  }
  function notify(){onPreview();onStateChange();}
  function draftChanged(){onDraftChange(target?.[0],pending.length?{target,expected,pending}:null);}
  function restore(id,draft){
    if(task||active||pending.length||draft?.target?.length!==4||draft.target[0]!==id||
       !draft.target.every(value=>typeof value==='string')||
       !Number.isSafeInteger(draft.expected)||draft.expected<0||!Array.isArray(draft.pending)||
       !draft.pending.length||draft.pending.length>imageStrokeQueueLimit)return false;
    const ids=new Set();
    for(const entry of draft.pending){
      const op=entry?.operation;
      if(!requestIdPattern.test(entry?.requestId)||ids.has(entry.requestId)||typeof entry.attempted!=='boolean'||
         !same(operationKey(id,op),draft.target))return false;
      ids.add(entry.requestId);
    }
    target=draft.target;expected=draft.expected;pending.push(...draft.pending);
    failure=Error('从此窗口恢复了待保存笔触。重试时会先核对工程修订。');
    return true;
  }
  function accepts(origin){
    return !failure&&pending.length<imageStrokeQueueLimit&&(!target||same(target,identity(origin)));
  }
  function prepare(operation,origin){
    const key=operationKey(origin.id,operation),doc=read();
    if(!key||doc?.id!==origin.id||target&&!same(target,key))return false;
    if(!target){target=key;expected=origin.revision;}
    return true;
  }
  function operations(origin){
    if(!target||origin.id!==target[0]||(origin.layerId!==undefined&&!same(target,identity(origin))))return [];
    const saved=receipt(read(),pending[0]);
    const start=origin.revision===expected?0:saved?.revision===origin.revision&&saved.revision===expected+1?1:null;
    return start===null?[]:[...pending.slice(start).map(entry=>entry.operation),...(active?[active]:[])];
  }
  function preview(operation,origin){
    if(!operation){
      active=null;
      if(!pending.length&&!task)reset();
    }else if(prepare(operation,origin))active=operation;
    else return;
    onPreview();
  }
  async function save(){
    while(pending.length){
      const [id]=target,doc=read(),entry=pending[0];
      if(doc?.id!==id||doc.revision!==expected)throw Error('工程修订已变化，后续笔触尚未保存');
      entry.attempted=true;
      draftChanged();
      const result=await write(entry.operation,{id,revision:expected,strokeRequestId:entry.requestId});
      if(result?.id!==id||receipt(result,entry)?.revision!==expected+1)throw Error('无法确认笔触是否已写入');
      pending.shift();
      expected++;
      draftChanged();
      notify();
    }
    return true;
  }
  function start(action){
    failure=null;canRebase=false;
    task=Promise.resolve().then(action).catch(error=>{
      failure=networkFailure(error)?Error('无法连接本机服务。重试时会先核对工程修订。'):error;
      onError(failure);
      return false;
    }).finally(()=>{
      task=null;
      if(!pending.length&&!active)reset();
      notify();
    });
    notify();
    return task;
  }
  function submit(operation,origin){
    if(pending.length>=imageStrokeQueueLimit||!prepare(operation,origin)){
      preview(null,origin);
      onError(Error('当前笔触未保存，请等前面的笔触保存后重试'));
      return;
    }
    active=null;
    pending.push({operation,requestId:crypto.randomUUID(),attempted:false});
    draftChanged();
    if(!task&&!failure)start(save);
    else notify();
  }
  function retry({rebase=false}={}){
    if(task)return task;
    if(!pending.length)return Promise.resolve(true);
    // Retry the local checkpoint even when the service remains unavailable.
    draftChanged();
    return start(async()=>{
      const [id]=target,latest=await readLatest(id);
      if(latest?.id!==id||!Number.isSafeInteger(latest.revision)||latest.revision<expected)throw Error('无法核对工程的最新修订');
      const entry=pending[0],saved=receipt(latest,entry);
      if(saved){
        if(saved.revision!==expected+1)throw Error('笔触保存记录与预期修订不一致');
        pending.shift();
        expected=saved.revision;
        draftChanged();
        notify();
      }
      if(!pending.length)return true;
      if(latest.revision!==expected){
        // Model-space points cannot safely move to another revision's
        // surface: the target object or its transform may have changed.
        if(!allowRebase)throw Error(`当前工程为 r${latest.revision}，材质笔触基于 r${expected}，无法确认表面仍一致。`);
        // One revision can write at most one receipt. An older, attempted
        // request may have fallen out of the receipt window.
        canRebase=!pending[0].attempted||latest.revision-expected<=strokeReceiptLimit;
        if(!rebase||!canRebase)throw Error(canRebase?
          `当前工程为 r${latest.revision}，待保存笔触基于 r${expected}。`:'修订间隔过大，无法确认原笔触是否写入。');
        expected=latest.revision;
        draftChanged();
      }
      return save();
    });
  }
  function discard(){
    if(task||!failure)return false;
    pending.length=0;active=null;draftChanged();reset();notify();return true;
  }
  return {accepts,operations,preview,submit,retry,discard,restore,flush:()=>task||Promise.resolve(!pending.length),
    get size(){return pending.length;},get saving(){return !!task;},get failure(){return failure;},get canRebase(){return canRebase;},
    get target(){return target?.slice()??null;}};
}
