import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDeliveryOptions,deliveryEditorValues,updateDeliveryOptions,captureDeliverySettings,captureRenderPreset,checkRenderPreset,createRenderPreferences,sameDeliveryCamera} from '../public/paint-delivery-options.mjs';
import {cyclesOptions,resolvePaintRenderSettings} from '../cycles-options.mjs';

const camera={projection:'perspective',eye:[12,6,12],target:[0,0,0],up:[0,1,0],fov:38,orthoHeight:20};
const advancedDefaults={device:'auto',adaptive:true,noiseThreshold:.01,maxBounces:12,transparent:false};
test('invalid persisted render preferences use supported defaults',()=>{
  assert.deepEqual(normalizeDeliveryOptions(null),{framing:'auto',size:'960x720',quality:'standard'});
  assert.deepEqual(normalizeDeliveryOptions({framing:'source',size:'4096x4096',quality:999}),normalizeDeliveryOptions({}));
  assert.deepEqual(captureDeliverySettings({framing:'auto',size:'1080x1440',quality:'fast'},camera),
    {width:1080,height:1440,samples:16,textureJobId:null,...advancedDefaults,camera:null});
});
test('approved viewport camera is copied and never selects an old texture job',()=>{
  const view=structuredClone(camera),settings=captureDeliverySettings({framing:'viewport',quality:'high'},view);
  view.eye[0]=99;
  assert.equal(settings.camera.eye[0],12);assert.equal(settings.samples,128);assert.equal(settings.textureJobId,null);
  assert.throws(()=>captureDeliverySettings({framing:'viewport'}),/三维视口/);
});
test('render editor custom values round-trip into the frozen delivery settings',()=>{
  const changed=updateDeliveryOptions({},{width:1024,height:800,samples:24,denoise:false,framing:'viewport'});
  assert.deepEqual(deliveryEditorValues(changed),{framing:'viewport',width:1024,height:800,samples:24,denoise:false,fileFormat:'PNG',bitDepth:null,...advancedDefaults});
  assert.deepEqual(normalizeDeliveryOptions(JSON.parse(JSON.stringify(changed))),changed);
  assert.deepEqual(captureDeliverySettings(changed,camera),{width:1024,height:800,samples:24,textureJobId:null,denoise:false,...advancedDefaults,camera});
  const preset=updateDeliveryOptions(changed,{width:1920,height:1080,samples:64,denoise:true});
  assert.equal(preset.size,'1920x1080');assert.equal(preset.quality,'standard');assert.equal(preset.denoise,undefined);
  for(const patch of [{width:127},{height:4097},{samples:1.5},{bitDepth:'16'},{denoise:'no'},{framing:'other'}])assert.throws(()=>updateDeliveryOptions(changed,patch));
  assert.equal(normalizeDeliveryOptions({size:'custom',width:0,height:100}).size,'960x720');
});
test('4K output and 16-bit PNG are frozen with high sample counts without affecting UV resolution',()=>{
  const preferences=updateDeliveryOptions({},{width:3840,height:2160,samples:2048,bitDepth:16});
  assert.equal(preferences.size,'3840x2160');
  const output=captureDeliverySettings(preferences);
  assert.deepEqual([output.width,output.height,output.samples,output.bitDepth],[3840,2160,2048,16]);
  assert.equal(captureDeliverySettings(updateDeliveryOptions(preferences,{bitDepth:null})).bitDepth,undefined);
});
test('Cycles settings persist and are frozen together; invalid values are rejected',()=>{
  const patch={device:'cpu',adaptive:false,noiseThreshold:.035,maxBounces:5,transparent:true};
  const stored=updateDeliveryOptions({},patch);
  assert.deepEqual(normalizeDeliveryOptions(JSON.parse(JSON.stringify(stored))),stored);
  const output=captureDeliverySettings(stored,null);
  for(const [key,value] of Object.entries(patch))assert.equal(output[key],value);
  const reset=updateDeliveryOptions(stored,advancedDefaults);
  for(const key of Object.keys(advancedDefaults))assert.equal(reset[key],undefined);
  for(const bad of [{device:'metal'},{adaptive:'false'},{noiseThreshold:-.01},{noiseThreshold:NaN},{noiseThreshold:1.1},{maxBounces:65},{maxBounces:1.2},{transparent:'true'}])assert.throws(()=>updateDeliveryOptions(stored,bad));
});
test('OpenEXR precision defaults and invalid format/depth combinations agree across clients',()=>{
  const half=updateDeliveryOptions({bitDepth:8},{fileFormat:'OPEN_EXR'});
  assert.equal(captureDeliverySettings(half).bitDepth,16);
  assert.equal(cyclesOptions({fileFormat:'OPEN_EXR'}).bitDepth,16);
  const full=updateDeliveryOptions(half,{bitDepth:32});
  assert.deepEqual(cyclesOptions(captureDeliverySettings(full)),captureDeliverySettings(full));
  assert.equal(captureDeliverySettings(updateDeliveryOptions(full,{fileFormat:'PNG'})).bitDepth,undefined);
  for(const patch of [{fileFormat:'JPEG'},{fileFormat:'PNG',bitDepth:32},{fileFormat:'OPEN_EXR',bitDepth:8}]){
    assert.throws(()=>cyclesOptions(patch));
    assert.throws(()=>updateDeliveryOptions({},patch));
  }
});
test('saved output settings keep local devices and unsaved edits independent per project',()=>{
  const preset=captureRenderPreset(updateDeliveryOptions({},{width:1920,height:1080,framing:'saved',fileFormat:'OPEN_EXR',bitDepth:32,device:'gpu'}));
  const a={id:'a',paint:{renderPreset:preset,renderCamera:camera}},b={id:'b',paint:{}};
  const state=createRenderPreferences({device:'cpu',size:'960x720'});
  assert.equal(checkRenderPreset(preset).bitDepth,32);
  assert.equal(Object.hasOwn(preset,'device'),false);
  assert.deepEqual([deliveryEditorValues(state.read(a)).width,deliveryEditorValues(state.read(a)).device],[1920,'cpu']);
  state.set(a,updateDeliveryOptions(state.read(a),{width:2048,device:'gpu'}));
  assert.equal(deliveryEditorValues(state.read(a)).width,2048);
  assert.deepEqual([deliveryEditorValues(state.read(b)).width,deliveryEditorValues(state.read(b)).device],[960,'gpu']);
  const changed={...a,paint:{...a.paint,renderPreset:{...preset,width:2560}}};
  assert.equal(deliveryEditorValues(state.read(changed)).width,2560);
  assert.equal(deliveryEditorValues(state.read(a)).width,1920);
  assert.deepEqual(resolvePaintRenderSettings(a.paint,{useProjectPreset:true,settings:{device:'cpu'}}),
    cyclesOptions({...captureDeliverySettings(state.read(a),null,camera),device:'cpu'}));
  assert.throws(()=>resolvePaintRenderSettings(a.paint,{useProjectPreset:true,settings:{width:200}}),/本机渲染设备/);
  assert.throws(()=>checkRenderPreset({...preset,device:'gpu'}));
  assert.throws(()=>captureRenderPreset({framing:'viewport'}),/工程相机/);
});
test('render passes remain independent of image format and bound full-resolution memory',()=>{
  const prefs=updateDeliveryOptions({},{width:3840,height:2160,renderPasses:['normal','depth']});
  const preset=captureRenderPreset(prefs);
  assert.deepEqual(preset.renderPasses,['depth','normal']);
  assert.equal(preset.fileFormat,'PNG');
  assert.deepEqual(checkRenderPreset(preset),preset);
  assert.deepEqual(cyclesOptions(captureDeliverySettings(prefs)).renderPasses,['depth','normal']);
  assert.equal(cyclesOptions({renderPasses:[]}).renderPasses,undefined);
  for(const patch of [{renderPasses:['depth','depth']},{renderPasses:['x']},
    {width:4096,height:4096,renderPasses:['depth','normal','ao','specular','environment']}]){
    assert.throws(()=>updateDeliveryOptions({},patch));
    assert.throws(()=>cyclesOptions(patch));
  }
});
test('camera changes invalidate a reviewed view while numerical jitter does not',()=>{
  const same=structuredClone(camera);same.eye[0]+=1e-8;
  assert.equal(sameDeliveryCamera(camera,same),true);
  same.eye[0]+=.1;assert.equal(sameDeliveryCamera(camera,same),false);
  assert.equal(sameDeliveryCamera(camera,{...camera,projection:'orthographic'}),false);
  assert.equal(sameDeliveryCamera(null,null),true);
});
