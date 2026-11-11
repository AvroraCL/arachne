import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createModelTransform,worldAxes,constraintSegment} from '../public/paint-model-transform.mjs';

const pivot=new THREE.Vector3(),camera=new THREE.OrthographicCamera(-5,5,5,-5,.1,100);camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
const rect={left:0,top:0,width:1000,height:1000};
const localFrame=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2).multiply(worldAxes);
const make=(tool='translate',extra={})=>createModelTransform({tool,pivot,orientation:'global',localFrame,camera,rect,pointer:{clientX:600,clientY:500},...extra});
const key=(session,key,extra={})=>session.key({key,...extra});
const near=(a,b)=>assert.ok(a.distanceTo(new THREE.Vector3(...b))<1e-8,a.toArray().join(','));
const atOrigin=session=>pivot.clone().applyMatrix4(session.result());
const move=(session,x,y,extra={})=>session.move({clientX:x,clientY:y,...extra});

test('modal move follows screen plane, with Shift precision and Ctrl increments',()=>{
  const s=make();move(s,650,475);near(atOrigin(s),[.5,.25,0]);
  move(s,650,475,{shiftKey:true});near(atOrigin(s),[.05,.025,0]);
  move(s,653,473,{ctrlKey:true});near(atOrigin(s),[.5,.3,0]);
  assert.equal(s.describe().tool,'translate');
});

test('axis cycles chosen frame, alternate local frame, then unconstrained without changing defaults',()=>{
  const s=make();key(s,'x');key(s,'2');near(atOrigin(s),[2,0,0]);assert.equal(s.describe().orientation,'global');
  key(s,'x');near(atOrigin(s),[0,0,-2]);assert.equal(s.describe().orientation,'local');
  key(s,'x');assert.equal(s.describe().axis,null);near(atOrigin(s),[2,0,0]);
  const l=make('translate',{orientation:'local'});key(l,'x');key(l,'3');near(atOrigin(l),[0,0,-3]);key(l,'x');near(atOrigin(l),[3,0,0]);
});

test('plane locks and direct component entry preserve excluded axes',()=>{
  const s=make();key(s,'Z',{shiftKey:true});key(s,'2');near(atOrigin(s),[2,0,0]);key(s,'Tab');key(s,'3');near(atOrigin(s),[2,0,-3]);
  assert.equal(s.guide().length,2);assert.ok(s.guide().every(a=>a.axis!=='Z'));
  const yz=make();key(yz,'X',{shiftKey:true});for(const k of ['2','Tab','3'])key(yz,k);near(atOrigin(yz),[0,3,-2]);
  const values=make();for(const k of ['1','Tab','2','Tab','3'])key(values,k);near(atOrigin(values),[1,3,-2]);
  key(values,'Delete');near(atOrigin(values),[0,0,0]);
  key(values,'-');assert.equal(values.result(),null);key(values,'0');key(values,'.');key(values,'5');near(atOrigin(values),[-.5,0,0]);
});

test('scale accepts uniform and constrained numeric factors, mirrors, and rejects singular values',()=>{
  const s=make('scale');key(s,'2');near(new THREE.Vector3(1,2,3).applyMatrix4(s.result()),[2,4,6]);
  key(s,'z');near(new THREE.Vector3(1,2,3).applyMatrix4(s.result()),[1,4,3]);
  key(s,'Delete');key(s,'0');assert.equal(s.result(),null);assert.match(s.describe().error,/缩放/);
  key(s,'Delete');key(s,'-');key(s,'1');near(new THREE.Vector3(1,2,3).applyMatrix4(s.result()),[1,-2,3]);
  const mouse=make('scale');move(mouse,650,500);near(new THREE.Vector3(1,2,3).applyMatrix4(mouse.result()),[1.5,3,4.5]);
});

test('rotation uses selected world/local axes and unwrapped mouse angles',()=>{
  const s=make('rotate');key(s,'x');key(s,'9');key(s,'0');near(new THREE.Vector3(0,1,0).applyMatrix4(s.result()),[0,0,1]);
  key(s,'x');near(new THREE.Vector3(0,1,0).applyMatrix4(s.result()),[1,0,0]);
  const mouse=make('rotate');for(let deg=10;deg<=450;deg+=10){const radians=deg*Math.PI/180;move(mouse,500+100*Math.cos(radians),500+100*Math.sin(radians));}
  near(new THREE.Vector3(1,0,0).applyMatrix4(mouse.result()),[0,-1,0]);assert.match(mouse.describe().label,/450/);
});

test('perspective movement and view-aligned axis fallback remain finite and respect the axis',()=>{
  const perspective=new THREE.PerspectiveCamera(40,1,.1,100);perspective.position.set(3,4,7);perspective.lookAt(0,0,0);perspective.updateMatrixWorld(true);
  const s=make('translate',{camera:perspective});key(s,'y');move(s,630,520);const p=atOrigin(s);assert.ok(p.toArray().every(Number.isFinite));assert.ok(Math.abs(p.x)+Math.abs(p.y)<1e-9);
  const aligned=make();key(aligned,'y');move(aligned,600,450);assert.ok(atOrigin(aligned).toArray().every(Number.isFinite));
});

test('constraint guides clip to both camera types before rendering, including segments crossing the near plane',()=>{
  const perspective=new THREE.PerspectiveCamera(40,1.6,.1,30);perspective.position.set(3,2,5);perspective.lookAt(0,0,0);perspective.updateMatrixWorld(true);
  for(const view of [camera,perspective])for(const direction of [new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,0,1)]){
    const endpoints=constraintSegment(view,pivot,direction);assert.ok(endpoints);
    for(const point of endpoints){const projected=point.clone().project(view);assert.ok(projected.toArray().every(n=>Math.abs(n)<=1.00001));}
    assert.ok(endpoints[0].distanceTo(endpoints[1])>0);
  }
  assert.equal(constraintSegment(camera,new THREE.Vector3(0,20,0),new THREE.Vector3(1,0,0)),null);
});
