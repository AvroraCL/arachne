// A pinned node target belongs to one project, even if another uses the same ID.
const valid=value=>value===null||!!value&&typeof value==='object'&&!Array.isArray(value)&&
  (value.library==='output'&&value.id==='output'||['materials','brushes'].includes(value.library)&&typeof value.id==='string'&&/^[\w-]{1,100}$/.test(value.id));
const copy=value=>value?{library:value.library,id:value.id,...(typeof value.name==='string'&&value.name.length<=100?{name:value.name}:{})}:null;
export function createShaderTargets(state={}){
  const pins=Object.create(null),saved=state.pinsByProject;
  if(saved&&typeof saved==='object'&&!Array.isArray(saved))for(const [id,value] of Object.entries(saved).slice(-32))if(/^[\w-]{1,100}$/.test(id)&&valid(value))pins[id]=copy(value);
  let legacy=valid(state.pin)&&state.pin?copy(state.pin):null,projectId=null,pin=null;
  function current(doc){
    const id=doc?.id||null;if(projectId!==id){projectId=id;pin=null;if(!id)return pin;
      if(Object.hasOwn(pins,id))pin=copy(pins[id]);else if(legacy){pin=legacy;pins[id]=copy(pin);legacy=null;}}
    const entries=pin&&doc?.paint?.[pin.library],name=entries&&Object.hasOwn(entries,pin.id)?entries[pin.id]?.name:null;if(typeof name==='string'&&name.length<=100&&pin.name!==name){pin.name=name;pins[id]=copy(pin);}
    return pin;
  }
  function set(doc,value){
    current(doc);if(!projectId||!valid(value))throw Error('节点目标无效');pin=copy(value);pins[projectId]=copy(pin);current(doc);
    const keys=Object.keys(pins);if(keys.length>32)delete pins[keys[0]];return pin;
  }
  function snapshot(){return {pinsByProject:structuredClone(pins),...(legacy?{pin:copy(legacy)}:{})};}
  return {current,set,snapshot};
}
