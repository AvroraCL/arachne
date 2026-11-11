import test from 'node:test';
import assert from 'node:assert/strict';
import {Group,Mesh,BufferGeometry,Float32BufferAttribute,Matrix4,Vector3} from 'three';
import {applyModelState} from '../public/paint-model-state.mjs';
import {nativeModelSteps,validateModelState,modelFingerprint} from '../project-model.mjs';

const matrix=new Matrix4().makeTranslation(2,3,4).toArray();
test('material geometry replays object then vertex commands without accumulating on polling',()=>{
  const root=new Group(),node=new Group(),geometry=new BufferGeometry();
  node.userData.modelingObject=7;
  geometry.setAttribute('position',new Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
  const mesh=new Mesh(geometry);node.add(mesh);root.add(node);
  const state={steps:[{targets:[{id:7}],matrix},{targets:[{mesh:0,vertices:[1]}],matrix}]};
  for(let i=0;i<3;i++){
    applyModelState(root,state);
    assert.deepEqual(new Vector3().fromBufferAttribute(geometry.attributes.position,1).applyMatrix4(mesh.matrixWorld).toArray(),[5,6,8]);
  }
  applyModelState(root,null);
  assert.deepEqual(new Vector3().fromBufferAttribute(geometry.attributes.position,1).applyMatrix4(mesh.matrixWorld).toArray(),[1,0,0]);
});
test('server resolves material-split vertices to one native edit and refuses missing topology',()=>{
  const glb={nodes:[{name:'wing',mesh:0}],scenes:[{nodes:[0]}],meshes:[{primitives:[
    {attributes:{POSITION:0}},{attributes:{POSITION:1}}]}],accessors:[{count:3},{count:3}]};
  const steps=[{matrix,targets:[{mesh:0,vertices:[1]},{mesh:1,vertices:[0]}]}];
  const topology={primitives:{'0:0':{vertices:[0,4,5]},'0:1':{vertices:[4,6,7]}}};
  assert.deepEqual(nativeModelSteps(glb,steps,topology)[0].targets,[{object:'wing',vertices:[4]}]);
  assert.throws(()=>nativeModelSteps(glb,steps),/绑定/);
  assert.throws(()=>nativeModelSteps(glb,[{matrix,targets:[{id:2}]}]),/绑定/);
});
test('project geometry fingerprint invalidates on changes and rejects singular transforms',()=>{
  const state={version:1,binding:'a'.repeat(32),modelSha256:'b'.repeat(64),
    steps:[{matrix,targets:[{id:0}]}],nativeSteps:[{matrix:[...matrix],targets:[{object:'wing'}]}]};
  validateModelState(state);
  const old=modelFingerprint({modeling:state});
  const next=structuredClone(state);next.steps[0].matrix[12]++;
  assert.notEqual(modelFingerprint({modeling:next}),old);
  assert.throws(()=>validateModelState(next),/绑定/);
  const singular=structuredClone(state);singular.steps[0].matrix[0]=0;singular.nativeSteps[0].matrix[0]=0;
  assert.throws(()=>validateModelState(singular),/绑定/);
});


test('ambiguous or repeated viewport targets cannot diverge from native geometry',()=>{
  const state={version:1,binding:'a'.repeat(32),modelSha256:'b'.repeat(64),
    steps:[{matrix,targets:[{id:0}]}],nativeSteps:[{matrix:[...matrix],targets:[{object:'wing'}]}]};
  for(const targets of [[{id:0},{id:0}],[{id:0,mesh:0,vertices:[1]}],[{mesh:0,vertices:[1,1]}]]){
    const invalid=structuredClone(state);invalid.steps[0].targets=targets;
    assert.throws(()=>validateModelState(invalid),/绑定/);
  }
});


test('object transforms preserve authored shading normals and undo restores them after vertex edits',()=>{
  const root=new Group(),geometry=new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
  geometry.setAttribute('normal',new Float32BufferAttribute([1,0,0,1,0,0,1,0,0],3));
  const mesh=new Mesh(geometry);mesh.userData.modelingObject=0;root.add(mesh);
  const authored=Array.from(geometry.attributes.normal.array);
  applyModelState(root,{steps:[{matrix,targets:[{id:0}]}]});
  assert.deepEqual(Array.from(geometry.attributes.normal.array),authored);
  applyModelState(root,{steps:[{matrix,targets:[{mesh:0,vertices:[0]}]}]});
  assert.notDeepEqual(Array.from(geometry.attributes.normal.array),authored);
  applyModelState(root,null);
  assert.deepEqual(Array.from(geometry.attributes.normal.array),authored);
});
