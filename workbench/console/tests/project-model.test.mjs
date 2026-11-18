import test from 'node:test';
import assert from 'node:assert/strict';
import {Group,Mesh,BufferGeometry,Float32BufferAttribute,Matrix4,Vector3,Box3,Color,Path,Shape,Raycaster} from 'three';
import {applyModelState} from '../public/paint-model-state.mjs';
import {nativeModelSteps,validateModelState,modelFingerprint} from '../project-model.mjs';
import {primitiveTopology} from '../public/paint-model-topology.mjs';
import {smoothSelectedVertices} from '../public/mesh-smoothing.mjs';

import {profileScene} from '../public/profile-model.mjs';

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

test('smoothing follows authored polygon boundaries and preserves open edges and locked axes',()=>{
  const geometry=new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute([0,0,0,2,0,0,2,2,0,0,2,0],3));
  geometry.setIndex([0,1,2,0,2,3]);
  const topology=primitiveTopology(geometry,{vertices:[0,1,2,3],polygons:[0,0]});
  const options={factor:.5,iterations:1,axes:[true,false,false]};
  const primitives=[{geometry,topology}],selected=new Set([0]);
  assert.equal(smoothSelectedVertices(primitives,selected,{...options,keepBoundary:true}).size,0);
  assert.deepEqual(smoothSelectedVertices(primitives,selected,options).get(0).toArray(),[.5,0,0]);
  assert.deepEqual(smoothSelectedVertices(primitives,selected,{...options,iterations:2}).get(0).toArray(),[.75,0,0]);
  assert.throws(()=>smoothSelectedVertices(primitives,new Set([0,1,2,3]),{...options,factor:1,axes:[true,true,true]}),/折叠/);
});

test('native smoothing positions cannot separate UV seam aliases and replay from the saved baseline',()=>{
  const glb={nodes:[{name:'wing',mesh:0}],scenes:[{nodes:[0]}],meshes:[{primitives:[
    {attributes:{POSITION:0}},{attributes:{POSITION:1}}]}],accessors:[{count:3},{count:3}]};
  const topology={primitives:{'0:0':{vertices:[0,4,5]},'0:1':{vertices:[4,6,7]}}};
  const step={type:'vertexPositions',targets:[{mesh:0,vertices:[1],positions:[.5,1,2]},
    {mesh:1,vertices:[0],positions:[.5,1,2]}]};
  const state={version:2,binding:'a'.repeat(32),modelSha256:'b'.repeat(64),steps:[step],
    nativeSteps:nativeModelSteps(glb,[step],topology)};
  assert.deepEqual(state.nativeSteps[0].targets,[{object:'wing',vertices:[4],positions:[.5,1,2]}]);
  assert.equal(validateModelState(state),state);
  assert.throws(()=>validateModelState({...state,version:1}),/绑定/);
  const missing=structuredClone(step);missing.targets.pop();
  assert.throws(()=>nativeModelSteps(glb,[missing],topology),/绑定/);
  const mismatched=structuredClone(step);mismatched.targets[1].positions[0]=.25;
  assert.throws(()=>nativeModelSteps(glb,[mismatched],topology),/接缝/);
  const root=new Group();
  for(let i=0;i<2;i++){
    const geometry=new BufferGeometry();
    geometry.setAttribute('position',new Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
    root.add(new Mesh(geometry));
  }
  for(let i=0;i<2;i++){
    applyModelState(root,state);
    assert.deepEqual(new Vector3().fromBufferAttribute(root.children[0].geometry.attributes.position,1).toArray(),[.5,1,2]);
    assert.deepEqual(new Vector3().fromBufferAttribute(root.children[1].geometry.attributes.position,0).toArray(),[.5,1,2]);
  }
  applyModelState(root,null);
  assert.deepEqual(new Vector3().fromBufferAttribute(root.children[0].geometry.attributes.position,1).toArray(),[1,0,0]);
});

test('extruded plates keep a true hole, distinct UV islands and a selectable local pivot',()=>{
  function square(Type,x,y,half){
    const shape=new Type();
    shape.moveTo(x-half,y-half);shape.lineTo(x+half,y-half);
    shape.lineTo(x+half,y+half);shape.lineTo(x-half,y+half);shape.closePath();
    return shape;
  }
  const plate=square(Shape,0,0,10);plate.holes.push(square(Path,0,0,3));
  const post=square(Shape,14,0,2);
  const finish={color:new Color('#f16c32'),metalness:.25,roughness:.35,bevel:0,depth:2,base:0};
  const model=profileScene([{...finish,name:'Plate',shapes:[plate]},{...finish,name:'Post',shapes:[post],base:3}]);
  model.updateMatrixWorld(true);
  const [mesh,riser]=model.children;
  const top=new Box3().setFromObject(mesh).max.y;
  assert.ok(new Box3().setFromObject(riser).min.y>top);
  assert.equal(mesh.material.roughness,.35);
  const hit=(x,from,dy)=>new Raycaster(new Vector3(mesh.position.x+x,from,mesh.position.z),
    new Vector3(0,dy,0)).intersectObject(mesh)[0];
  assert.equal(hit(0,3,-1),undefined);
  const front=hit(1,3,-1),back=hit(1,-3,1);
  assert.ok(front.uv.x<.70&&back.uv.x>=.70);
  assert.ok(Math.abs(mesh.geometry.boundingBox.getCenter(new Vector3()).length())<1e-6);
  for(const part of model.children){
    const uv=part.geometry.attributes.uv;
    assert.ok(uv.array.every(v=>v>0&&v<1));
  }
  assert.throws(()=>profileScene([{...finish,shapes:[post],bevel:1}]),/倒角/);
});

test('a curved profile shares shading normals across the UV cuts while the cap stays flat',()=>{
  const disc=new Shape();
  disc.absarc(0,0,10,0,Math.PI*2,false);
  const [part]=profileScene([{name:'Round cap',color:new Color('white'),base:0,depth:4,
    bevel:0,metalness:.75,roughness:.25,shapes:[disc]}]).children;
  const {position,normal}=part.geometry.attributes;
  const sideNormals=new Map();
  let seams=0,flat=0;
  for(let i=0;i<position.count;i++){
    const n=new Vector3().fromBufferAttribute(normal,i);
    if(Math.abs(n.y)>.9){assert.equal(Math.abs(n.y),1);flat++;continue;}
    const key=new Vector3().fromBufferAttribute(position,i).toArray().map(v=>v.toFixed(5)).join(',');
    if(sideNormals.has(key)){assert.ok(n.distanceTo(sideNormals.get(key))<1e-5);seams++;}
    sideNormals.set(key,n);
  }
  assert.ok(flat>0&&seams>3);
});
