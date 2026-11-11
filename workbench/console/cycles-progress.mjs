const marker='ARACHNE_CYCLES_PROGRESS ';
const phases=new Set(['source','materials','lighting','camera','device','scene','sample','denoise','composite','write','verify','fallback','complete']);
const devices=new Set(['CPU','METAL','OPTIX','CUDA','HIP','ONEAPI']);

export function parseCyclesProgress(line){
  if(!line.startsWith(marker))return null;
  try{
    const {phase,device,sample,total}=JSON.parse(line.slice(marker.length));
    if(!phases.has(phase)||device!==undefined&&!devices.has(device))return null;
    const reading=phase==='sample';
    if(reading&&(!Number.isSafeInteger(sample)||!Number.isSafeInteger(total)||sample<0||total<1||sample>total))return null;
    return {phase,...(device?{device}:{}),...(reading?{sample,total}:{})};
  }catch{return null;}
}

export function cyclesProgressReader(publish){
  let prior=null;
  return line=>{
    const next=parseCyclesProgress(line);
    if(!next)return;
    const progress={
      ...prior,...next,
      ...(next.phase==='fallback'?{fallback:true,sample:null,total:null}:{}),
    };
    if(prior&&JSON.stringify(prior)===JSON.stringify(progress))return;
    prior=progress;publish(progress);
  };
}
