import test from 'node:test';
import assert from 'node:assert/strict';
import {Vector3} from 'three';
import {checkRenderLighting,presetRenderLights,renderLightingDefaults} from '../public/render-lighting.mjs';
import {projectLightRig} from '../public/path-trace-lighting.mjs';

test('custom render lights retain project coordinates, color and enabled state across both renderers',()=>{
  assert.deepEqual(checkRenderLighting(renderLightingDefaults),renderLightingDefaults);
  const [key,fill]=presetRenderLights('studio');
  const setup=checkRenderLighting({...renderLightingDefaults,preset:'custom',rotation:90,lightStrength:.5,lights:[
    {...key,name:' 主光 ',position:[1,0,2],width:.6,height:.4,color:'#80C0FF'},
    {...fill,enabled:false}
  ]});
  assert.equal(setup.lights[0].name,'主光');
  assert.equal(setup.lights[0].color,'#80c0ff');
  const lights=projectLightRig(setup,new Vector3(3,4,5),2);
  assert.equal(lights.length,1);
  assert.ok(lights[0].position.distanceTo(new Vector3(3,8,3))<1e-8);
  assert.equal(lights[0].intensity,1.4);
  assert.equal(lights[0].width,1.2);
  assert.equal(lights[0].height,.8);
  assert.equal(lights[0].color.getHexString(),'80c0ff');
  assert.throws(()=>checkRenderLighting({...setup,lights:[key,key]}),/区域灯/);
  assert.throws(()=>checkRenderLighting({...setup,lights:[{...key,position:[0,0,0]}]}),/区域灯/);
});
