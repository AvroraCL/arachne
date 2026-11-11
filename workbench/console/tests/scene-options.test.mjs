import test from 'node:test';import assert from 'node:assert/strict';import {sceneOptions,SCENE_DEFAULTS,previewCameraKey,previewKeysEqual} from '../public/scene-options.mjs';
test('space settings are independent copies and retain physical preview ranges',()=>{const a=sceneOptions(),b=sceneOptions();a.exposure=1;assert.equal(b.exposure,0);assert.equal(SCENE_DEFAULTS.exposure,0);assert.equal(sceneOptions({background:'transparent',ground:true,samples:128}).samples,128);});
test('invalid scene commands, colors and unbounded render work are rejected',()=>{for(const raw of [{samples:10000},{resolution:2},{rotation:-1},{ground:'true'},{exposure:Infinity},{backgroundColor:'url(secret)'},{backgroundColor:'#123'},{script:'x'},{environment:'unknown'},{bounces:3.5}])assert.throws(()=>sceneOptions(raw));});

test('camera damping tail cannot discard an already rendered matching frame',()=>{
 const camera={projection:'perspective',eye:[5.2842925438731525,19.18257142328832,23.18236326446714],target:[0,1.161364996,1.4080945],up:[0,1,0],fov:38,orthoHeight:20.7909164990911};
 const settled={...camera,eye:[5.284292533973725,19.18257142642801,23.182363264271054]};
 assert.deepEqual(previewCameraKey(camera,10.395),previewCameraKey(settled,10.395));
 const moved={...camera,eye:[5.3,...camera.eye.slice(1)]};assert.notDeepEqual(previewCameraKey(camera,10.395),previewCameraKey(moved,10.395));
 const tiny={...camera,eye:camera.eye.map(n=>n*1e-5),target:camera.target.map(n=>n*1e-5),orthoHeight:camera.orthoHeight*1e-5};const tinyMove={...tiny,eye:tiny.eye.map((n,i)=>n+(i===0?1e-6:0))};assert.notDeepEqual(previewCameraKey(tiny,1e-4),previewCameraKey(tinyMove,1e-4));
});

test('pose matching has no float-bin boundary flicker or unnecessary stale retries',()=>{
 const pose={projection:'perspective',eye:[5.28429249,19,23],target:[0,1,1],up:[0,1,0],fov:38,orthoHeight:20};
 const key=(camera,scene=SCENE_DEFAULTS)=>JSON.stringify({context:'model:uv',size:[1500,860],scene,camera:previewCameraKey(camera,10)});
 assert(previewKeysEqual(key(pose),key({...pose,eye:[5.28429251,19,23]})));
 assert(!previewKeysEqual(key(pose),key({...pose,eye:[5.29,19,23]})));
 assert(!previewKeysEqual(key(pose),key(pose,{...SCENE_DEFAULTS,exposure:1})));
});
