import test from 'node:test';
import assert from 'node:assert/strict';
import {BufferGeometry,Float32BufferAttribute,Matrix4,Vector3,Quaternion,Euler,Object3D} from 'three';
import {numericModelDelta,modelOrientation} from '../public/paint-modeling.mjs';
import {primitiveTopology,mergePrimitiveAliases} from '../public/paint-model-topology.mjs';
import {edgeInMarquee,faceCenterInMarquee,meshInMarquee,projectMarqueeVertices,vertexInMarquee}
  from '../public/paint-model-marquee.mjs';

const pivot=new Vector3(2,4,-3);
const verify=(actual,expected)=>assert.ok(actual.distanceTo(expected)<1e-9,actual.toArray().join(','));

test('numeric Blender world translation maps the three axes into the viewport',()=>{
  const matrix=numericModelDelta('translate',[1,2,3],pivot);
  verify(pivot.clone().applyMatrix4(matrix),pivot.clone().add(new Vector3(1,3,-2)));
});

test('numeric Blender world rotation and scale preserve the selected pivot',()=>{
  const offset=pivot.clone().add(new Vector3(1,2,-3));
  const rotation=numericModelDelta('rotate',[0,0,90],pivot);
  verify(pivot.clone().applyMatrix4(rotation),pivot);
  verify(pivot.clone().add(new Vector3(1,0,0)).applyMatrix4(rotation),pivot.clone().add(new Vector3(0,0,-1)));
  const scale=numericModelDelta('scale',[2,3,4],pivot);
  verify(pivot.clone().applyMatrix4(scale),pivot);
  verify(offset.applyMatrix4(scale),pivot.clone().add(new Vector3(2,8,-9)));
});

test('numeric modeling rejects non-finite, singular and out-of-range inputs',()=>{
  for(const [tool,values] of [['scale',[1,0,1]],['translate',[Infinity,0,0]],['rotate',[0,0,36001]]]){
    assert.throws(()=>numericModelDelta(tool,values,pivot),/变换数值/);
  }
});

test('local frame follows the active object including its parent, while global keeps Blender world axes',()=>{
  const parent=new Object3D(),object=new Object3D();parent.add(object);
  const conversion=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-Math.PI/2);
  const yaw=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),Math.PI/2);
  parent.quaternion.copy(conversion).multiply(yaw).multiply(conversion.clone().invert());
  object.scale.set(2,3,4);object.position.set(9,8,7);
  const local=modelOrientation(object,'local'),global=modelOrientation(object,'global');
  verify(new Vector3(1,0,0).applyQuaternion(local),new Vector3(0,0,-1));
  verify(new Vector3(0,1,0).applyQuaternion(local),new Vector3(-1,0,0));
  verify(new Vector3(0,0,1).applyQuaternion(local),new Vector3(0,1,0));
  verify(new Vector3(1,0,0).applyQuaternion(global),new Vector3(1,0,0));
  assert.ok(Math.abs(local.length()-1)<1e-12);
});

test('local numeric move, rotate and scale use the same rotated basis and preserve their pivot',()=>{
  const object=new Object3D();object.rotation.y=Math.PI/2;
  const frame=modelOrientation(object,'local'),x=new Vector3(1,0,0).applyQuaternion(frame),y=new Vector3(0,1,0).applyQuaternion(frame),z=new Vector3(0,0,1).applyQuaternion(frame);
  verify(pivot.clone().applyMatrix4(numericModelDelta('translate',[2,0,0],pivot,frame)),pivot.clone().addScaledVector(x,2));
  verify(pivot.clone().add(y).applyMatrix4(numericModelDelta('rotate',[90,0,0],pivot,frame)),pivot.clone().add(z));
  verify(pivot.clone().add(x).add(y).applyMatrix4(numericModelDelta('scale',[2,1,1],pivot,frame)),pivot.clone().addScaledVector(x,2).add(y));
  for(const tool of ['rotate','scale'])verify(pivot.clone().applyMatrix4(numericModelDelta(tool,tool==='rotate'?[20,30,40]:[2,3,4],pivot,frame)),pivot);
  const other=new Object3D();other.quaternion.setFromEuler(new Euler(.3,.6,.7));
  assert.ok(modelOrientation(other,'local').angleTo(frame)>.1);
  assert.ok(modelOrientation(null,'local').angleTo(modelOrientation(object,'global'))<1e-8);
});


test('original quads select both triangles while their diagonal stays out of the edge set',()=>{
  const geometry=new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute([0,0,0,1,0,0,1,1,0,0,1,0],3));
  geometry.setIndex([0,1,2,0,2,3]);
  const topology=primitiveTopology(geometry,{vertices:[5,6,7,8],polygons:[21,21]});
  const face=topology.faces.get(21);
  assert.deepEqual(face.triangles,[0,1,2,0,2,3]);
  assert.deepEqual(face.edges,[[0,1],[1,2],[2,3],[3,0]]);
  assert.deepEqual(topology.edgeIndices,[0,1,1,2,2,3,3,0]);
});

test('native vertex aliases span material primitives but keep distinct coincident vertices',()=>{
  const meshA=new BufferGeometry(),meshB=new BufferGeometry();
  const positions=[0,0,0,1,0,0,0,0,0];
  meshA.setAttribute('position',new Float32BufferAttribute(positions,3));
  meshB.setAttribute('position',new Float32BufferAttribute(positions,3));
  const aliases=mergePrimitiveAliases([
    {mesh:meshA,topology:primitiveTopology(meshA,{vertices:[5,6,9]})},
    {mesh:meshB,topology:primitiveTopology(meshB,{vertices:[5,7,5]})}
  ]);
  assert.deepEqual(aliases.get(5),[{mesh:meshA,indices:[0]},{mesh:meshB,indices:[0,2]}]);
  assert.deepEqual(aliases.get(9),[{mesh:meshA,indices:[2]}]);
});

test('model marquee intersects projected edges and filled triangles without selecting clipped vertices',()=>{
  const geometry=new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute([-1,-1,0,1,-1,0,0,1,0,0,0,2],3));
  geometry.setIndex([0,1,2]);
  const points=projectMarqueeVertices(geometry.attributes.position,new Matrix4());
  const middle=[-.1,-.1,.1,.1];
  assert.equal(vertexInMarquee(points,3,middle),false);
  assert.equal(edgeInMarquee(points,0,2,middle),false);
  assert.equal(edgeInMarquee(points,0,1,[-.1,-1,.1,-.95]),true);
  assert.equal(faceCenterInMarquee(points,[0,1,2],[-.2,-.5,.2,-.2]),true);
  assert.equal(meshInMarquee(points,geometry,middle),true);
  assert.equal(meshInMarquee(points,geometry,[.8,.8,.95,.95]),false);
});
