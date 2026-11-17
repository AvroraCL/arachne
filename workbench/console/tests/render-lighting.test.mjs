import test from 'node:test';
import assert from 'node:assert/strict';
import {Box3,Vector3} from 'three';
import {checkRenderLighting,presetRenderLights,renderLightingDefaults} from '../public/render-lighting.mjs';
import {projectLightRig,studioGroundVisible,createStudioGround,placeStudioGround} from '../public/path-trace-lighting.mjs';

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

test('studio floor receives lighting below the model and releases transparent film',()=>{
  const source={...renderLightingDefaults,ground:{enabled:true,color:'#564F49'}};
  const settings=checkRenderLighting(source);
  assert.deepEqual(settings.ground,{enabled:true,color:'#564f49'});
  assert.equal(studioGroundVisible(renderLightingDefaults,false),false);
  assert.equal(studioGroundVisible(settings,false),true);
  assert.equal(studioGroundVisible(settings,true),false);
  const bounds=new Box3(new Vector3(2,-1,4),new Vector3(8,3,10)),plane=createStudioGround();
  placeStudioGround(plane,bounds,settings.ground.color);
  assert.equal(plane.material.color.getHexString(),'564f49');
  assert.equal(plane.position.x,5);
  assert.equal(plane.position.z,7);
  assert.ok(plane.position.y<bounds.min.y&&plane.position.y>bounds.min.y-.002);
  assert.throws(()=>checkRenderLighting({...source,ground:{enabled:true,color:'unknown'}}),/地面/);
  plane.geometry.dispose();plane.material.dispose();
});
