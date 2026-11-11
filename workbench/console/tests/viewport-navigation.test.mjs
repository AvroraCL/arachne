import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {alignedCamera,projectionCamera,movedCamera,navigationCommand,configureNavigation,attachOrbitInput} from '../public/viewport-navigation.mjs';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const pose={eye:[6,5,-12],target:[2,1,3],up:[0,1,0],projection:'perspective',fov:38,orthoHeight:10};
const span=p=>p.projection==='orthographic'?p.orthoHeight:Math.hypot(...p.eye.map((v,i)=>v-p.target[i]))*2*Math.tan(p.fov*Math.PI/360);
const near=(a,b)=>assert(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('direction changes retain panned pivot and visible scale, never frame the entire model',()=>{
 for(const d of [[1,0,0],[0,1,0],[0,0,-1]]){const next=alignedCamera(pose,d,[0,0,-1]);assert.deepEqual(next.target,pose.target);near(span(next),span(pose));assert.equal(next.projection,'orthographic');}
});
test('orthographic wheel zoom survives projection switching and save/reopen camera data',()=>{
 let p=projectionCamera(pose,true);p=movedCamera(p,'zoom',.19);p=JSON.parse(JSON.stringify(p));const height=span(p);
 for(let i=0;i<10;i++){p=projectionCamera(p,false);near(span(p),height);p=projectionCamera(p,true);near(span(p),height);}
});
test('screen pan moves eye and target equally without changing scale or direction',()=>{
 for(const p of [pose,projectionCamera(pose,true)]){const next=movedCamera(p,'pan',[80,-35],800);near(span(next),span(p));p.eye.forEach((v,i)=>near(next.eye[i]-next.target[i],v-p.target[i]));}
});
test('shortcuts use physical numpad keys and preserve application save/open combinations',()=>{
 assert.equal(navigationCommand({code:'Numpad7'}),'top');assert.equal(navigationCommand({code:'Numpad7',ctrlKey:true}),'bottom');
 assert.equal(navigationCommand({code:'Digit7'}),null);assert.equal(navigationCommand({code:'KeyS',ctrlKey:true}),null);assert.equal(navigationCommand({code:'Space',ctrlKey:true}),'maximize');
});

// Exercise real OrbitControls pointer handlers, not a duplicated mouse map.
class Surface extends EventTarget {constructor(){super();this.style={};this.clientHeight=800;this.clientWidth=1000;this.ownerDocument={};}getRootNode(){return this;}setPointerCapture(){}releasePointerCapture(){}focus(){}getBoundingClientRect(){return {left:0,top:0,width:1000,height:800};}}
const pointer=(target,type,attrs)=>{const event=new Event(type,{cancelable:true});Object.assign(event,{clientX:300,clientY:300,pointerType:'mouse',pointerId:1,button:1,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,...attrs});target.dispatchEvent(event);};
test('actual OrbitControls: Shift MMB pans, MMB rotates, Ctrl MMB zooms, LMB leaves camera still',()=>{
 for(const [button,mod,expected] of [[1,{shiftKey:true},'pan'],[1,{},'orbit'],[1,{ctrlKey:true},'zoom'],[0,{},'select'],[0,{altKey:true,shiftKey:true},'pan']]){
  const el=new Surface(),camera=new THREE.PerspectiveCamera(38,1,.1,1000);camera.position.set(5,5,10);
  let controls;attachOrbitInput(el,()=>controls);controls=new OrbitControls(camera,el);configureNavigation(controls);controls.update();
  const eye=camera.position.clone(),target=controls.target.clone(),direction=eye.clone().sub(target).normalize(),distance=eye.distanceTo(target);
  pointer(el,'pointerdown',{button,...mod});pointer(el,'pointermove',{button,clientX:360,clientY:350,...mod});pointer(el,'pointerup',{button,...mod});
  const nextDir=camera.position.clone().sub(controls.target).normalize();
  if(expected==='pan'){near(nextDir.distanceTo(direction),0);near(camera.position.distanceTo(controls.target),distance);assert(controls.target.distanceTo(target)>.01);}
  if(expected==='orbit'){near(controls.target.distanceTo(target),0);assert(nextDir.distanceTo(direction)>.01);}
  if(expected==='zoom'){near(nextDir.distanceTo(direction),0);assert(Math.abs(camera.position.distanceTo(controls.target)-distance)>.01);}
  if(expected==='select'){near(camera.position.distanceTo(eye),0);near(controls.target.distanceTo(target),0);}
  controls.dispose();
 }
});
