export function createCyclesDevices(request){
  const listeners=new Set();
  let state={status:'idle',value:null},pending=null;
  function publish(next){
    state=next;
    for(const listener of listeners)listener();
  }
  function check(force=false){
    if(pending)return pending;
    if(!force&&state.status!=='idle')return Promise.resolve(state);
    pending=Promise.resolve().then(()=>request(force)).then(value=>{
      publish({status:'checked',value});
    },()=>{
      publish({status:'failed',value:null});
    }).finally(()=>{pending=null;});
    publish({status:'checking',value:state.value});
    return pending;
  }
  return {
    read:()=>state,check,
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
  };
}

export function cyclesDeviceText({status,value}){
  if(status==='idle')return '尚未检测 Cycles 设备';
  if(status==='checking')return '正在检查 Blender 和 Cycles 设备…';
  if(status==='failed')return '设备检查失败，请在渲染属性中重试。';
  if(!value.available)return value.reason;
  if(!value.gpus.length)return 'CPU 可用 · 未检测到兼容 GPU';
  return 'CPU、'+value.gpus.map(gpu=>gpu.backend+' · '+gpu.name).join('；');
}

export function cyclesDeviceBlocked({status,value},device){
  if(status!=='checked')return false;
  return !value.available||device==='gpu'&&!value.gpus.length;
}
