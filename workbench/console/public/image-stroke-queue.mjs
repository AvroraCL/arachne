export const imageStrokeQueueLimit=16;

const identity=(origin,operation)=>[origin.id,operation.documentId,operation.layerId,operation.target];
const contextIdentity=origin=>[origin.id,origin.documentId,origin.layerId,origin.target];
const same=(a,b)=>a?.length===b.length&&b.every((value,index)=>a[index]===value);

export function createImageStrokeQueue({read,write,onPreview,onStateChange,onError}){
  let target=null,firstRevision=null,expected=null,active=null,writing=false,draining=null;
  const pending=[];
  function reset(){
    target=null;firstRevision=null;expected=null;
  }
  function accepts(origin){
    return pending.length<imageStrokeQueueLimit&&(!target||same(target,contextIdentity(origin)));
  }
  function prepare(operation,origin){
    const doc=read(),key=identity(origin,operation);
    if(!doc||doc.id!==origin.id)return false;
    if(!target){
      if(doc.revision!==origin.revision)return false;
      target=key;firstRevision=expected=origin.revision;
    }
    return same(target,key)&&origin.revision>=firstRevision&&origin.revision<=doc.revision&&
      (doc.revision===expected||writing&&doc.revision===expected+1);
  }
  function operations(origin){
    if(!target||!same(target,contextIdentity(origin)))return [];
    const start=origin.revision===expected?0:writing&&origin.revision===expected+1?1:null;
    return start===null?[]:[...pending.slice(start),...(active?[active]:[])];
  }
  function preview(operation,origin){
    if(!operation){
      active=null;
      if(!pending.length)reset();
    }else if(prepare(operation,origin))active=operation;
    else return;
    onPreview();
  }
  async function save(){
    while(pending.length){
      const [id]=target,doc=read();
      if(doc?.id!==id||doc.revision!==expected)throw Error('工程修订已变化，后续笔触尚未保存');
      writing=true;
      const result=await write(pending[0],{id,revision:expected});
      if(result?.id!==id||result.revision!==expected+1)throw Error('笔触保存结果无效');
      pending.shift();
      expected=result.revision;
      writing=false;
      onPreview();
    }
    return true;
  }
  function submit(operation,origin){
    if(pending.length>=imageStrokeQueueLimit||!prepare(operation,origin)){
      preview(null,origin);
      onError(Error('当前笔触未保存，请等前面的笔触保存后重试'));
      return;
    }
    active=null;
    pending.push(operation);
    if(!draining){
      draining=Promise.resolve().then(save).catch(error=>{
        pending.length=0;active=null;writing=false;reset();
        onError(error);
        return false;
      }).finally(()=>{
        draining=null;
        if(!active)reset();
        onPreview();onStateChange();
      });
    }
    onPreview();onStateChange();
  }
  return {accepts,operations,preview,submit,flush:()=>draining||Promise.resolve(true),
    get size(){return pending.length;},
    get saving(){return !!draining;}}
}
