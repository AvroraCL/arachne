import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {EXRExporter} from 'three/addons/exporters/EXRExporter.js';
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js';
import {prepareExrPixels,taggedExr} from '../public/render-exr-color.mjs';

test('a half or full float EXR retains negative light, highlights and associated alpha with readable color metadata',async()=>{
  for(const type of [THREE.FloatType,THREE.HalfFloatType]){
    const buffer=new Float32Array([4,2,1,.5, -1,-1,-1,1, 1,2,3,0, .18,.18,.18,1]);
    prepareExrPixels(buffer,true,'lin_ap1_scene');
    const tex=new THREE.DataTexture(buffer,2,2,THREE.RGBAFormat,THREE.FloatType);
    const encoded=await new EXRExporter().parse(tex,{compression:0,type});tex.dispose();
    const file=await taggedExr(encoded,2,'lin_ap1_scene').arrayBuffer();
    const decoded=new EXRLoader().setDataType(THREE.FloatType).parse(file);
    assert.deepEqual([decoded.width,decoded.height],[2,2]);
    assert.ok(Math.abs(decoded.header.chromaticities.redX-.713)<1e-6);
    assert.equal(decoded.header.colorInteropID,'lin_ap1_scene');
    const expected=[1.5894077,1.0634675,.5857083,.5, -1,-1,-1,1, 0,0,0,0, .18,.18,.18,1];
    for(let i=0;i<expected.length;i++){
      assert.ok(Math.abs(decoded.data[i]-expected[i])<=(type===THREE.HalfFloatType?.001:1e-6),
        i+': '+decoded.data[i]+' vs '+expected[i]);
    }
  }
});
