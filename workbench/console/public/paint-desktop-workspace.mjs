const endpoint='/api/desktop-layout';
const serialize=layout=>layout===null?null:JSON.stringify(layout);
const checked=result=>{
  if(!Number.isSafeInteger(result?.revision)||result.revision<0||result.layout===undefined)throw Error('无法读取本机布局修订');
  return result;
};

export function createDesktopWorkspace(initial,request,initialFailure=null){
  let revision=initial?.revision??null,accepted=serialize(initial?.layout??null),desired=accepted;
  let attempt=null,task=null,failure=initialFailure,conflict=false,report=()=>{};
  function notify(){report(failure?.message||'',conflict);}
  async function drain(){
    while(desired!==accepted){
      attempt=desired;
      const body='{"revision":'+revision+',"layout":'+attempt+'}';
      const result=checked(await request({method:'POST',headers:{'Content-Type':'application/json'},body,
        keepalive:new TextEncoder().encode(body).length<60*1024}));
      revision=result.revision;accepted=attempt;attempt=null;
    }
    return true;
  }
  function start(action){
    failure=null;conflict=false;
    task=Promise.resolve().then(action).catch(error=>{
      failure=error;
      conflict=error.status===409;
      return false;
    }).finally(()=>{
      task=null;
      notify();
      if(!failure&&desired!==accepted)start(drain);
    });
    notify();
    return task;
  }
  return {
    initial:initial?.layout??null,
    save(serialized,onError){
      report=onError;desired=serialized;
      if(!task&&!failure&&desired!==accepted)start(drain);
      else notify();
    },
    retry({replace=false}={}){
      if(task)return task;
      if(!failure)return Promise.resolve(true);
      return start(async()=>{
        const current=checked(await request()),remote=serialize(current.layout);
        if(current.revision!==revision&&remote!==attempt&&remote!==accepted&&remote!==desired&&!replace)
          throw Object.assign(Error('另一个窗口保存了布局。请选择保留哪一份。'),{status:409});
        revision=current.revision;accepted=remote;attempt=null;
        return drain();
      });
    },
    useSaved(apply){
      if(task)return task;
      if(!failure)return Promise.resolve(true);
      return start(async()=>{
        const current=checked(await request());
        if(!current.layout)throw Error('本机没有已保存的布局');
        try{apply(current.layout);}
        catch(error){error.status=409;throw error;}
        revision=current.revision;desired=accepted=serialize(current.layout);attempt=null;
        return true;
      });
    },
    async flush(){
      while(task)await task;
      return desired===accepted&&!failure;
    },
    get failure(){return failure;},
    get saving(){return !!task;}
  };
}

export async function connectDesktopWorkspace(window){
  if(!window.arachneDesktop&&!window.webkit?.messageHandlers?.arachne)return null;
  async function request(options){
    let response;
    try{response=await fetch(endpoint,{...options,signal:AbortSignal.timeout(3000)});}
    catch{throw Error('无法连接本机服务。重试时会先核对已保存的布局。');}
    const result=await response.json();
    if(!response.ok)throw Object.assign(Error(result.error||'无法保存本机布局'),{status:response.status});
    return result;
  }
  try{return createDesktopWorkspace(checked(await request()),request);}
  catch(error){return createDesktopWorkspace(null,request,error);}
}
