import {setTimeout as delay} from 'node:timers/promises';

const states=new Set(['ready','saving','editing','error','unsaved','jobs']);

// The renderer may never settle executeJavaScript. Keep one deadline for the
// whole check, and stop polling if a late reply arrives after that deadline.
export async function checkRendererClose(read,{timeoutMs=4000,pollMs=100}={}){
  const deadline=performance.now()+timeoutMs;
  let stopped=false,timer;
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve('unresponsive'),timeoutMs);});
  async function poll(){
    try{
      while(!stopped){
        const status=await read();
        if(stopped)return 'unresponsive';
        if(status!=='saving')return states.has(status)?status:'unavailable';
        if(deadline-performance.now()<=pollMs)return 'saving';
        await delay(pollMs);
      }
    }catch{return 'unavailable';}
    return 'unresponsive';
  }
  try{return await Promise.race([poll(),timeout]);}
  finally{stopped=true;clearTimeout(timer);}
}
