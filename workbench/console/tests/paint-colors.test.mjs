import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaintColors,maskGray,grayColor,normalizePaintHex,paintHsv,paintHex} from '../public/paint-colors.mjs';
import {maskThumbnailKey,layerThumbnailKey} from '../public/paint-mask-thumbnails.mjs';

test('foreground/background swap and reset stay independent between paint and mask',()=>{
  const colors=createPaintColors();colors.set('paint','foreground','#EE3300');colors.set('paint','background','#0033ff');
  colors.swap();assert.deepEqual(colors.pair(),{foreground:'#0033ff',background:'#ee3300'});
  colors.swap('mask');assert.equal(colors.pair('mask').foreground,'#ffffff');
  colors.reset('mask');assert.deepEqual(colors.pair('mask'),{foreground:'#000000',background:'#ffffff'});
  assert.equal(colors.pair().foreground,'#0033ff');
  colors.reset();assert.equal(colors.pair().foreground,'#000000');
});

test('paint thumbnails follow actual strokes and masks while ignoring names, visibility and downstream shaders',async()=>{
  const layer={id:'layer',kind:'paint',values:{color:'#ff0000'},opacity:1,strokes:[],maskStrokes:[]};
  const doc={id:'project',source:{files:{model:'fingerprint'}},paint:{layers:[layer],base:{color:'#ffffff'}}};
  const key=await layerThumbnailKey(doc,layer);
  assert.equal(await layerThumbnailKey(doc,{...layer,name:'renamed',visible:false,locked:true,parentId:'folder'}),key);
  assert.equal(await layerThumbnailKey({...doc,paint:{...doc.paint,base:{color:'#000000'},materialGraph:{nodes:[]}}},layer),key);
  assert.notEqual(await layerThumbnailKey(doc,{...layer,strokes:[{values:{color:'#0000ff'}}]}),key);
  assert.notEqual(await layerThumbnailKey(doc,{...layer,maskEnabled:false}),key);
  assert.notEqual(await layerThumbnailKey(doc,{...layer,opacity:.5}),key);
  assert.notEqual(await layerThumbnailKey({...doc,modeling:{steps:[{matrix:[1]}]}},layer),key);
});
test('mask colors use gray values; saved preferences normalize without sharing mutable state',()=>{
  assert.equal(maskGray('#000000'),0);assert.equal(maskGray('#ffffff'),1);assert.equal(grayColor('#ff0000'),'#363636');
  const colors=createPaintColors({paint:{foreground:'bad',background:'#ABCDEF'},mask:{foreground:'#ff0000'}});
  assert.equal(colors.pair().foreground,'#000000');assert.equal(colors.pair().background,'#abcdef');
  assert.equal(colors.pair('mask').foreground,'#363636');
  const copy=colors.snapshot();copy.paint.foreground='#ffffff';assert.equal(colors.pair().foreground,'#000000');
  assert.throws(()=>colors.set('paint','foreground','red'));
});
test('color picker preserves exact RGB through HSV conversion and accepts shorthand HEX',()=>{
  assert.equal(normalizePaintHex(' #AbC '),'#aabbcc');
  assert.equal(normalizePaintHex('cc33a0'),'#cc33a0');
  assert.equal(normalizePaintHex('orange'),null);
  for(const hex of ['#000000','#ffffff','#ff0000','#00ff00','#0000ff','#53c7af','#c49100','#b017b0','#010101'])
    assert.equal(paintHex(paintHsv(hex)),hex);
  assert.equal(paintHex({h:360,s:1,v:1}),'#ff0000');
});
test('mask thumbnail caches ignore paint color/opacity but invalidate changed masks and geometry',async()=>{
  const layer={id:'layer',kind:'paint',mask:null,maskBase:1,maskStrokes:[],values:{color:'#ff0000'},opacity:1};
  const doc={id:'project',source:{files:{model:'fingerprint'}},paint:{layers:[layer]}};
  const key=await maskThumbnailKey(doc,layer);
  assert.equal(await maskThumbnailKey(doc,{...layer,values:{color:'#000000'},opacity:.5,maskEnabled:false}),key);
  assert.notEqual(await maskThumbnailKey(doc,{...layer,maskStrokes:[{value:0,uv:true,stamps:[[.5,.5]]}]}),key);
  assert.notEqual(await maskThumbnailKey({...doc,modeling:{steps:[{matrix:[1]}]}},layer),key);
  assert.notEqual(await maskThumbnailKey(doc,{...layer,maskEffects:[{kind:'invert',enabled:true,opacity:1}]}),key);
});
