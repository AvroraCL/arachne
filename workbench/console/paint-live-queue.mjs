export const paintAbortError=()=>Object.assign(Error('实时预览已取消'),{name:'AbortError'});

// One warm compositor, with a cancellable bounded queue in front of its stdin.
// Detaching an active caller keeps its cache warm; cancelled waiting requests
// are never sent to Python. Every failure releases both callers and timers.
export function createPaintLiveQueue(createWorker,{limit=4,timeout=15000}={}){
  const pending=new Map(),queue=[];
  let worker=null,active=null,sequence=0,generation=0;
  function cleanup(task){clearTimeout(task.timer);task.signal?.removeEventListener('abort',task.abort);pending.delete(task.id);}
  function settle(task,error,value){
    cleanup(task);
    const resolve=task.resolve,reject=task.reject;task.resolve=task.reject=null;
    if(error)reject?.(error);else resolve?.(value);
  }
  function fail(error){
    const previous=worker;worker=null;generation++;
    const tasks=new Set([...pending.values(),...(active?[active]:[])]);
    active=null;queue.length=0;
    for(const task of tasks)settle(task,error);
    previous?.stop();
  }
  function pump(){
    if(active||!queue.length)return;
    if(!worker){
      const token=++generation;
      try{
        worker=createWorker({
          result(id,value,error){
            if(token!==generation||active?.id!==id)return;
            const task=active;active=null;settle(task,error,value);pump();
          },
          fail(error){if(token===generation)fail(error);}
        });
      }catch(error){fail(error);return;}
    }
    const task=active=queue.shift();
    try{worker.request(task.id,task.config);task.config=null;}
    catch(error){fail(error);}
  }
  return {
    submit(config,{signal}={}){
      if(signal?.aborted)return Promise.reject(paintAbortError());
      if(pending.size>=limit)return Promise.reject(Object.assign(Error('实时合成忙，请稍后重试'),{status:503}));
      const task={id:++sequence,config,signal};
      const result=new Promise((resolve,reject)=>Object.assign(task,{resolve,reject}));
      task.abort=()=>{
        if(active===task){
          // The worker must finish this one message before accepting another.
          // Keep the watchdog alive even after the HTTP caller has detached.
          signal?.removeEventListener('abort',task.abort);pending.delete(task.id);
          task.reject?.(paintAbortError());task.resolve=task.reject=null;
        }else{
          const index=queue.indexOf(task);if(index>=0)queue.splice(index,1);
          task.config=null;settle(task,paintAbortError());
        }
      };
      task.timer=setTimeout(()=>{
        const error=Error('实时合成超时');
        if(active===task)fail(error);
        else{const index=queue.indexOf(task);if(index>=0)queue.splice(index,1);task.config=null;settle(task,error);}
      },timeout);
      signal?.addEventListener('abort',task.abort,{once:true});pending.set(task.id,task);queue.push(task);pump();
      return result;
    },
    stop(error=paintAbortError()){fail(error);},
    get pending(){return pending.size;}
  };
}
