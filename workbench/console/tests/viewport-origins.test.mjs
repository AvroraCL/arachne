import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createObjectOrigins,objectOriginCenter} from '../public/viewport-origins.mjs';

test('object pivot averages world origins, independent of offset geometry and parent transforms',()=>{
  const parent=new THREE.Group();parent.position.set(3,4,5);parent.rotation.z=Math.PI/2;parent.scale.set(2,3,1);
  const geometry=new THREE.BoxGeometry();geometry.translate(100,200,300);
  const first=new THREE.Mesh(geometry),second=new THREE.Object3D();parent.add(first,second);
  first.position.set(2,0,0);second.position.set(0,2,0);
  assert.ok(objectOriginCenter([first]).distanceTo(new THREE.Vector3(3,8,5))<1e-9);
  assert.ok(objectOriginCenter([first,second,first]).distanceTo(new THREE.Vector3(0,6,5))<1e-9);
  assert.deepEqual(objectOriginCenter([]).toArray(),[0,0,0]);
  geometry.dispose();first.material.dispose();
});

test('origin markers track object motion but ignore vertex edits; active and selected remain separate',()=>{
  const a=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()),b=new THREE.Object3D(),origins=createObjectOrigins();
  a.position.set(1,2,3);b.position.set(4,5,6);origins.setObjects([a,b],b);
  const [selected,active]=origins.group.children,positions=marker=>Array.from(marker.geometry.attributes.position.array);
  assert.deepEqual(positions(selected),[1,2,3]);assert.deepEqual(positions(active),[4,5,6]);
  a.geometry.translate(100,200,300);origins.update();assert.deepEqual(positions(selected),[1,2,3]);
  a.position.x=9;origins.update();assert.deepEqual(positions(selected),[9,2,3]);
  origins.setObjects([a,b],a);assert.deepEqual(positions(selected),[4,5,6]);assert.deepEqual(positions(active),[9,2,3]);
  origins.setObjects([],null);assert.ok(origins.group.children.every(marker=>!marker.visible));
  let disposed=0;for(const marker of origins.group.children){marker.geometry.addEventListener('dispose',()=>disposed++);marker.material.addEventListener('dispose',()=>disposed++);}
  const scene=new THREE.Scene();scene.add(origins.group);origins.dispose();assert.equal(scene.children.length,0);assert.equal(disposed,4);
  a.geometry.dispose();a.material.dispose();
});
