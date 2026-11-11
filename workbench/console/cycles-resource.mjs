const cancelled=()=>Object.assign(Error('渲染任务已取消'),{name:'AbortError',cancelled:true,status:409});

// Blender and 4K compositors share the Mac's unified memory. Formal jobs
// take the next slot ahead of queued previews; cancelling a wait frees it.
export function createCyclesResource(){
  let current=null;
  const queued=[];
  function pump(){
    if(current||!queued.length)return;
    const task=current=queued.shift();
    task.signal?.removeEventListener('abort',task.abort);
    Promise.resolve().then(()=>{
      if(task.signal?.aborted)throw cancelled();
      return task.action();
    }).then(task.resolve,task.reject).finally(()=>{current=null;pump();});
  }
  return {run(kind,action,{signal,onQueued}={}){
    if(signal?.aborted)return Promise.reject(cancelled());
    const priority=kind==='production'?1:0;
    return new Promise((resolve,reject)=>{
      if(current||queued.length)onQueued?.();
      const task={signal,priority,action,resolve,reject,abort:()=>{
        const index=queued.indexOf(task);if(index<0)return;
        queued.splice(index,1);signal.removeEventListener('abort',task.abort);reject(cancelled());
      }};
      signal?.addEventListener('abort',task.abort,{once:true});
      const before=queued.findIndex(item=>item.priority<priority);
      if(before<0)queued.push(task);else queued.splice(before,0,task);
      pump();
    });
  }};
}

export const cyclesResource=createCyclesResource();
