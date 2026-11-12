import crypto from 'node:crypto';
import {modelStepForSource} from './public/model-edit-steps.mjs';
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
  const aliasCounts=new Map();
  function aliases(object){
    if(!aliasCounts.has(object)){
      const counts=new Map();
      for(const mesh of meshes){
        if(mesh.object!==object)continue;
        for(const id of topology?.primitives[mesh.primitive]?.vertices??[])counts.set(id,(counts.get(id)||0)+1);
      }
      aliasCounts.set(object,counts);
    }
    return aliasCounts.get(object);
  }
  return steps.map(step=>{
    const coverage=new Map();
    const native=modelStepForSource(step,target=>{
      if(target.id!==undefined){
        const node=glb.nodes[target.id];if(node?.mesh===undefined)invalid();
        return {object:node.name};
      }
      const mesh=meshes[target.mesh],ids=topology?.primitives[mesh?.primitive]?.vertices;
      if(!mesh||!ids||ids.length!==mesh.count)invalid();
      const vertices=target.vertices.map(id=>ids[id]);
      if(step.type==='vertexPositions'){
        if(!coverage.has(mesh.object))coverage.set(mesh.object,new Map());
        const counts=coverage.get(mesh.object);
        for(const id of vertices)counts.set(id,(counts.get(id)||0)+1);
      }
      return {object:mesh.object,vertices};
    });
    for(const [object,counts] of coverage)
      for(const [id,count] of counts)if(count!==aliases(object).get(id))invalid();
    return native;
  });
}
export function validateModelState(state){
  if(Buffer.byteLength(JSON.stringify(state)||'')>8*1024*1024)invalid();
  if(!state||![1,2].includes(state.version)||!/^[a-f0-9]{32}$/.test(state.binding)||
    !/^[a-f0-9]{64}$/.test(state.modelSha256)||!Array.isArray(state.steps)||state.steps.length>2000||
    !Array.isArray(state.nativeSteps)||state.nativeSteps.length!==state.steps.length)invalid();
  for(let i=0;i<state.steps.length;i++){
    const step=state.steps[i],native=state.nativeSteps[i];
    if(!Array.isArray(step?.targets)||!step.targets.length||step.targets.length>4096||
       !Array.isArray(native?.targets)||native.targets.length>4096||!native.targets.length)invalid();
    const positions=step.type==='vertexPositions';
    if(positions){
      if(state.version!==2||native.type!==step.type||step.matrix!==undefined||native.matrix!==undefined)invalid();
    }else{
      const m=step.matrix;
      if(step.type!==undefined||native.type!==undefined||!Array.isArray(m)||m.length!==16||
         m.some(n=>!Number.isFinite(n)||Math.abs(n)>1e6)||m[3]!==0||m[7]!==0||m[11]!==0||m[15]!==1||
         JSON.stringify(native.matrix)!==JSON.stringify(m))invalid();
      const det=m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5]);
      if(Math.abs(det)<1e-10)invalid();
    }
    for(const target of [...step.targets,...native.targets]){
      if(!target||typeof target!=='object')invalid();
      if((positions||target.vertices!==undefined)&&(!Array.isArray(target.vertices)||!target.vertices.length||target.vertices.length>1e6||
         target.vertices.some(n=>!Number.isSafeInteger(n)||n<0)))invalid();
      if(positions&&(!Array.isArray(target.positions)||target.positions.length!==target.vertices.length*3||
         target.positions.some(n=>!Number.isFinite(n)||Math.fround(n)!==n||Math.abs(n)>1e9)))invalid();
      if(!positions&&target.positions!==undefined)invalid();
    }
    const selected=new Set();
    for(const target of step.targets){
      const object=target.id!==undefined,key=object?'object:'+target.id:'mesh:'+target.mesh;
      if(selected.has(key)||Object.keys(target).some(key=>!(object?['id']:positions?['mesh','vertices','positions']:['mesh','vertices']).includes(key))||
         (object?positions||!Number.isSafeInteger(target.id)||target.id<0:
          !Number.isSafeInteger(target.mesh)||target.mesh<0||!target.vertices)||
         target.vertices&&new Set(target.vertices).size!==target.vertices.length)invalid();
      selected.add(key);
    }
    for(const target of native.targets)if(typeof target.object!=='string'||!target.object||target.object.length>256)invalid();
  }
  return state;
}
