const cancelled=()=>Object.assign(Error('任务已取消'),{cancelled:true,status:409});

// A cancelled preview stops waiting for the shared surface build. Other
// consumers (the live viewport or another project) can still use its result.
export function waitForGeometry(promise,signal){
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(cancelled());
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(cancelled());};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}

export function createGeometryQueue(){
  const pending=[];
  let active=false,closed=false;
  async function drain(){
    if(active)return;
    active=true;
    try{
      while(pending.length){
        const item=pending.shift();
        item.signal?.removeEventListener('abort',item.abort);
        if(item.signal?.aborted){item.reject(cancelled());continue;}
        try{item.resolve(await item.run());}catch(error){item.reject(error);}
      }
    }finally{active=false;}
  }
  return {
    submit(run,signal,{priority=0}={}){
      if(closed||signal?.aborted)return Promise.reject(cancelled());
      const result=new Promise((resolve,reject)=>{
        const next={run,resolve,reject,signal,priority},before=pending.findIndex(item=>item.priority<priority);
        next.abort=()=>{
          const index=pending.indexOf(next);if(index<0)return;
          pending.splice(index,1);signal.removeEventListener('abort',next.abort);reject(cancelled());
        };
        signal?.addEventListener('abort',next.abort,{once:true});
        if(before===-1)pending.push(next);else pending.splice(before,0,next);
      });
      void drain();
      return result;
    },
    close(){closed=true;for(const item of pending.splice(0)){item.signal?.removeEventListener('abort',item.abort);item.reject(cancelled());}}
  };
}
