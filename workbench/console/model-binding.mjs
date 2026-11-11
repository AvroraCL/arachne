import crypto from 'node:crypto';
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const modelFingerprint=doc=>doc.modeling?.steps?.length?digest(doc.modeling):null;
const invalid=()=>{throw Error('建模命令或模型绑定无效');};
export function nativeModelSteps(glb,steps,topology){
  const meshes=[];
  function visit(id){
    const node=glb.nodes[id];
    if(node.mesh!==undefined)glb.meshes[node.mesh].primitives.forEach((primitive,index)=>
      meshes.push({object:node.name,primitive:node.mesh+':'+index,count:glb.accessors[primitive.attributes.POSITION].count}));
    for(const child of node.children||[])visit(child);
  }
  for(const id of glb.scenes[glb.scene||0].nodes)visit(id);
  return steps.map(step=>{
    const targets=new Map();
    for(const target of step.targets){
      if(target.id!==undefined){
        const node=glb.nodes[target.id];if(node?.mesh===undefined)invalid();
        targets.set(node.name,{object:node.name});
      }else{
        const mesh=meshes[target.mesh],ids=topology?.primitives[mesh?.primitive]?.vertices;
        if(!mesh||!ids||ids.length!==mesh.count)invalid();
        const vertices=target.vertices.map(id=>ids[id]);
        if(vertices.some(id=>!Number.isSafeInteger(id)||id<0))invalid();
        const entry=targets.get(mesh.object)||{object:mesh.object,vertices:[]};
        if(!entry.vertices)invalid();
        for(const id of vertices)entry.vertices.push(id);targets.set(mesh.object,entry);
      }
    }
    return {matrix:step.matrix,targets:[...targets.values()].map(target=>target.vertices?
      {...target,vertices:[...new Set(target.vertices)]}:target)};
  });
}
export function validateModelState(state){
  if(Buffer.byteLength(JSON.stringify(state)||'')>8*1024*1024)invalid();
  if(!state||state.version!==1||!/^[a-f0-9]{32}$/.test(state.binding)||
    !/^[a-f0-9]{64}$/.test(state.modelSha256)||!Array.isArray(state.steps)||state.steps.length>2000||
    !Array.isArray(state.nativeSteps)||state.nativeSteps.length!==state.steps.length)invalid();
  for(let i=0;i<state.steps.length;i++){
    const step=state.steps[i],native=state.nativeSteps[i];
    if(!Array.isArray(step.matrix)||step.matrix.length!==16||step.matrix.some(n=>!Number.isFinite(n)||Math.abs(n)>1e6)||
       step.matrix[3]!==0||step.matrix[7]!==0||step.matrix[11]!==0||step.matrix[15]!==1||
       !Array.isArray(step.targets)||!step.targets.length||step.targets.length>4096||
       !Array.isArray(native.targets)||native.targets.length>4096||!native.targets.length||
       JSON.stringify(native.matrix)!==JSON.stringify(step.matrix))invalid();
    const m=step.matrix,det=m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5]);
    if(Math.abs(det)<1e-10)invalid();
    for(const target of [...step.targets,...native.targets]){
      if(target.vertices!==undefined&&(!Array.isArray(target.vertices)||!target.vertices.length||target.vertices.length>1e6||
         target.vertices.some(n=>!Number.isSafeInteger(n)||n<0)))invalid();
    }
    const selected=new Set();
    for(const target of step.targets){
      const object=target.id!==undefined,key=object?'object:'+target.id:'mesh:'+target.mesh;
      if(selected.has(key)||Object.keys(target).some(key=>!(object?['id']:['mesh','vertices']).includes(key))||
         (object?!Number.isSafeInteger(target.id)||target.id<0:
          !Number.isSafeInteger(target.mesh)||target.mesh<0||!target.vertices)||
         target.vertices&&new Set(target.vertices).size!==target.vertices.length)invalid();
      selected.add(key);
    }
    for(const target of native.targets)if(typeof target.object!=='string'||!target.object||target.object.length>256)invalid();
  }
  return state;
}
