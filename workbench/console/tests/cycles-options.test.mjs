import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cyclesOptions} from '../cycles-options.mjs';
const camera={projection:'perspective',eye:[1,2,3],target:[0,0,0],up:[0,1,0],fov:38,orthoHeight:10};
test('Cycles accepts a finite perspective or orthographic camera and preserves its values',()=>{for(const projection of ['perspective','orthographic']){const result=cyclesOptions({camera:{...camera,projection},samples:128,width:1200,height:800});assert.equal(result.camera.projection,projection);assert.deepEqual(result.camera.eye,[1,2,3]);assert.equal(result.samples,128);}});
test('Cycles rejects degenerate cameras, nonfinite vectors, invalid resolution and texture traversal',()=>{for(const value of [{camera:{...camera,eye:[0,0,0]}},{camera:{...camera,up:[1,2,3]}},{camera:{...camera,eye:[NaN,2,3]}},{width:4097},{samples:0},{samples:4097},{bitDepth:12},{textureJobId:'../other-project'}])assert.throws(()=>cyclesOptions(value));});
test('Cycles defaults do not imply that the current 2D revision is baked',()=>{const result=cyclesOptions();assert.equal(result.textureJobId,null);assert.equal(result.camera,null);assert.equal(result.samples,64);});
test('Cycles keeps the explicit denoising choice and rejects invalid values',()=>{assert.equal(cyclesOptions({denoise:false}).denoise,false);assert.equal(cyclesOptions({denoise:true}).denoise,true);assert.equal(cyclesOptions().denoise,undefined);assert.throws(()=>cyclesOptions({denoise:'false'}),/降噪/);});
test('advanced Cycles controls validate and preserve explicit settings without changing old requests',()=>{
  const advanced={device:'cpu',adaptive:false,noiseThreshold:.035,maxBounces:5,transparent:true};
  const result=cyclesOptions(advanced);for(const [key,value] of Object.entries(advanced))assert.equal(result[key],value);
  for(const key of Object.keys(advanced))assert.equal(cyclesOptions()[key],undefined);
  for(const bad of [{device:'metal'},{adaptive:1},{transparent:'true'},{noiseThreshold:NaN},{noiseThreshold:-1},{noiseThreshold:1.1},{maxBounces:1.1},{maxBounces:65}])assert.throws(()=>cyclesOptions(bad));
});
