import test from 'node:test';
import assert from 'node:assert/strict';
import {projectionIsCurrent} from '../public/paint-surface-state.mjs';
import {encodeStrokeBlock,unpackStrokeBlock} from '../stroke-compaction.mjs';
import {freezeOriginalBinding,pinSurfaceInputs,surfaceBindingKey,validateSurfaceBindings} from '../paint-surface-bindings.mjs';

const modeling=distance=>{
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,distance,0,0,1];
  return {version:1,binding:'a'.repeat(32),modelSha256:'b'.repeat(64),
    steps:[{matrix,targets:[{id:0}]}],nativeSteps:[{matrix:[...matrix],targets:[{object:'wing'}]}]};
};
const brush=()=>({stamps:[[0,0,0,0,0,1]]});
test('old strokes, regional masks and decals keep their authored surface when geometry changes',()=>{
  const stroke=brush(),uv={uv:true,stamps:[[.5,.5]]},mask={region:'triangle',hit:[0,0,0,0,0,1]};
  const decal={id:'number',kind:'decal'},layer={kind:'paint',strokes:[stroke,uv],maskStrokes:[mask]};
  const doc={paint:{layers:[layer,decal]}};
  pinSurfaceInputs(doc);
  assert.equal(stroke.surfaceBinding,'original');assert.equal(mask.surfaceBinding,'original');
  assert.equal(decal.surfaceBinding,'original');assert.equal(uv.surfaceBinding,undefined);
  doc.modeling=modeling(1);pinSurfaceInputs(doc);
  assert.equal(stroke.surfaceBinding,'original');
  const added=brush();layer.strokes.push(added);pinSurfaceInputs(doc);
  const key=surfaceBindingKey(doc.modeling);
  assert.equal(added.surfaceBinding,key);
  const frozen=structuredClone(doc.paint.surfaceBindings[key]);
  doc.modeling.steps[0].matrix[12]=2;
  assert.deepEqual(doc.paint.surfaceBindings[key],frozen);
});
test('explicit decal repositioning reprojects only that decal and unused snapshots are removed',()=>{
  const decal={id:'number',kind:'decal'},doc={modeling:modeling(1),paint:{layers:[decal]}};
  pinSurfaceInputs(doc);const old=decal.surfaceBinding;
  doc.modeling=modeling(2);pinSurfaceInputs(doc,{reproject:['number']});
  assert.notEqual(decal.surfaceBinding,old);assert.equal(doc.paint.surfaceBindings[old],undefined);
  decal.space='uv';pinSurfaceInputs(doc);
  assert.equal(decal.surfaceBinding,undefined);assert.equal(doc.paint.surfaceBindings,undefined);
});
test('missing, altered or inappropriate surface references fail validation',()=>{
  const doc={modeling:modeling(1),paint:{layers:[{kind:'paint',strokes:[brush()]}]}};
  pinSurfaceInputs(doc);const key=surfaceBindingKey(doc.modeling);
  const invalid=structuredClone(doc.paint);delete invalid.surfaceBindings[key];
  assert.throws(()=>validateSurfaceBindings(invalid),/不存在/);
  const altered=structuredClone(doc.paint);altered.surfaceBindings[key].steps[0].matrix[12]=12;
  assert.throws(()=>validateSurfaceBindings(altered),/绑定|指纹/);
  const uv=structuredClone(doc.paint);uv.layers[0].strokes[0].uv=true;
  assert.throws(()=>validateSurfaceBindings(uv),/不适用/);
});


test('a retained decal hides its old world-space gizmo until repositioned on current geometry',()=>{
  const layer={id:'number',kind:'decal'},doc={modeling:modeling(1),paint:{layers:[layer]}};
  pinSurfaceInputs(doc);assert.equal(projectionIsCurrent(doc,layer),true);
  const moved=structuredClone(doc);moved.modeling=modeling(2);
  assert.equal(projectionIsCurrent(moved,moved.paint.layers[0]),false);
  pinSurfaceInputs(moved,{reproject:['number']});
  const committed=structuredClone(moved);
  assert.equal(projectionIsCurrent(committed,committed.paint.layers[0]),true);
});

test('replacing a GLB separates old original-space marks and compact brush blocks from new placements',()=>{
  const oldSha='c'.repeat(64),layer={kind:'decal',id:'old'},mark={image:'calibration'};
  const stroke={radius:.12,hardness:1,opacity:1,value:1,stamps:[[0,0,0,0,0,1]],surfaceBinding:'original'};
  const masks={kind:'paint',maskStrokes:[encodeStrokeBlock([stroke])]};
  const doc={paint:{layers:[layer,masks],sourceMaterials:{cover:{mark}}}};
  pinSurfaceInputs(doc);
  freezeOriginalBinding(doc.paint,oldSha);
  const fresh={kind:'decal',id:'new'};doc.paint.layers.push(fresh);
  pinSurfaceInputs(doc);validateSurfaceBindings(doc.paint);
  assert.equal(fresh.surfaceBinding,'original');
  assert.equal(mark.surfaceBinding,oldSha);
  assert.equal(layer.surfaceBinding,oldSha);
  assert.equal(projectionIsCurrent(doc,layer),false);
  assert.deepEqual(unpackStrokeBlock(masks.maskStrokes[0],{mask:true,spatial:true}),[{...stroke,surfaceBinding:oldSha}]);
});
