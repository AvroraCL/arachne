const endpoint='/api/desktop-layout';

export async function connectDesktopWorkspace(window){
  if(!window.arachneDesktop&&!window.webkit?.messageHandlers?.arachne)return null;
  async function request(options){
    const response=await fetch(endpoint,{...options,signal:AbortSignal.timeout(3000)});
    const result=await response.json();
    if(!response.ok)throw Object.assign(Error(result.error||'无法保存本机布局'),{status:response.status});
    return result;
  }

  let revision,initial;
  try{({revision,layout:initial}=await request());}
  catch{return null;}
  if(!Number.isSafeInteger(revision)||revision<0)return null;
  let accepted=initial===null?null:JSON.stringify(initial),queued=null,writing=null,task=null;
  let conflicted=false,report=()=>{};
  async function drain(){
    while(queued!==null&&!conflicted){
      writing=queued;queued=null;
      try{
        const body='{"revision":'+revision+',"layout":'+writing+'}';
        const result=await request({method:'POST',headers:{'Content-Type':'application/json'},body,
          keepalive:new TextEncoder().encode(body).length<60*1024});
        revision=result.revision;accepted=writing;
        report('');
      }catch(error){
        conflicted=error.status===409;
        report(conflicted?'本机布局已在其他窗口更新。重新打开工作台可载入最新布局。':error.message);
      }finally{writing=null;}
    }
  }
  function start(){
    if(!task&&queued!==null&&!conflicted)task=drain().finally(()=>{task=null;start();});
  }
  return {
    initial,
    save(serialized,onError){
      if(conflicted)return;
      report=onError;
      queued=serialized===(writing??accepted)?null:serialized;
      start();
    },
    async flush(){while(task)await task;}
  };
}
