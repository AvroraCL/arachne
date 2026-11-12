import test from 'node:test';
import assert from 'node:assert/strict';
import {imageDocumentOperation,imageLayerDefaults,validateImageDocuments} from '../public/image-documents.mjs';
import {imageBatchSelection,planImageLayerMove,planImageLayerDelete,imageLayerMoveStep} from '../public/image-layer-batch.mjs';
import {imageStackBase} from '../public/image-layer-tree.mjs';

const pixel=(id,patch={})=>({id,kind:'pixel',name:id,...imageLayerDefaults,...patch});
const group=(id,patch={})=>pixel(id,{kind:'group',blend:'passThrough',...patch});
const ids=layers=>layers.map(layer=>layer.id);
const clipBase=(layers,id)=>imageStackBase(layers,layers.findIndex(layer=>layer.id===id))?.id;
function image(layers){
  const paint={layers:[],assets:{},imageDocuments:{doc:{name:'纹理',width:4096,height:4096,colorSpace:'srgb',layers}}};
  return {get layers(){return paint.imageDocuments.doc.layers;},edit(action,change){
    imageDocumentOperation(paint,{op:'image',action,documentId:'doc',...change},{requireUnlocked(){}});
    validateImageDocuments(paint,{checkStroke(){}});
  }};
}

test('move groups and complete clipping runs together while preserving relative order across parents',()=>{
  const layers=[group('folder'),pixel('child',{parentId:'folder'}),pixel('base'),
    pixel('clip',{clipped:true}),pixel('outside'),group('target'),pixel('target-child',{parentId:'target'})];
  const selection=['clip','child','folder','base'];
  assert.deepEqual(ids(imageBatchSelection(layers,selection).roots),['folder','base','clip']);
  const moved=planImageLayerMove(layers,selection,{anchorId:'target',placement:'inside'});
  assert.deepEqual(ids(moved.layers),['outside','target','target-child','folder','child','base','clip']);
  assert.deepEqual(moved.layers.slice(3).map(layer=>layer.parentId),['target','folder','target','target']);
  assert.equal(clipBase(moved.layers,'clip'),'base');
  assert.throws(()=>planImageLayerMove(layers,['folder','child'],{anchorId:'child',placement:'above'}),/自身或组内子项/);
  assert.throws(()=>planImageLayerMove(layers,['base'],{anchorId:'target',placement:'inside'}),/改变剪贴关系/);
  assert.throws(()=>planImageLayerMove(layers,['outside'],{anchorId:'clip',placement:'below'}),/改变剪贴关系/);
  assert.deepEqual(imageLayerMoveStep(layers,['base','clip'],1),{anchorId:'outside',placement:'above'});
  assert.equal(layers[0].parentId,undefined);
});

test('batch copies assign new IDs and preserve masks, references, inherited locks and original clipping',()=>{
  const maskStrokes=[{uv:true,rect:[.2,.2,.5,.5],value:0,opacity:1}];
  const layers=[pixel('base',{maskEnabled:true,maskStrokes}),pixel('clip',{clipped:true}),
    group('folder'),pixel('child',{parentId:'folder',locked:true})];
  const state=image(layers);
  state.edit('duplicateLayers',{layerIds:['child','clip','base','folder'],copyIds:['base-copy','clip-copy','folder-copy']});
  const copy=state.layers.find(layer=>layer.id==='base-copy'),nested=state.layers.find(layer=>layer.parentId==='folder-copy');
  assert.deepEqual(ids(state.layers).slice(0,7),['base','clip','base-copy','clip-copy','folder','child','folder-copy']);
  assert.deepEqual(copy.maskStrokes,maskStrokes);
  assert.notEqual(copy.maskStrokes,maskStrokes);
  assert.equal(clipBase(state.layers,'clip-copy'),'base-copy');
  assert.equal(clipBase(state.layers,'clip'),'base');
  assert.equal(nested.locked,true);
  assert.notEqual(nested.id,'child');
  state.edit('duplicateLayers',{layerIds:['clip'],copyIds:['solo-copy']});
  assert.equal(clipBase(state.layers,'solo-copy'),'base');
  assert.throws(()=>state.edit('duplicateLayers',{layerIds:['base','clip'],copyIds:['base-copy','new']}),/副本编号/);
  assert.throws(()=>state.edit('moveLayers',{layerIds:['folder'],anchorId:'base',placement:'below'}),{status:423});
});

test('batch deletion releases only clips whose base is removed and rejects locked descendants atomically',()=>{
  const layers=[pixel('old'),pixel('base'),pixel('clip',{clipped:true}),pixel('other'),
    pixel('other-clip',{clipped:true}),group('folder'),pixel('child',{parentId:'folder'})];
  const state=image(layers);
  state.edit('removeLayers',{layerIds:['folder','child','base']});
  assert.deepEqual(ids(state.layers),['old','clip','other','other-clip']);
  assert.equal(state.layers[1].clipped,undefined);
  assert.equal(clipBase(state.layers,'other-clip'),'other');
  assert.equal(layers[2].clipped,true);
  assert.throws(()=>planImageLayerDelete(layers.map(layer=>layer.id==='clip'?{...layer,locked:true}:layer),['base']),{status:423});
  assert.throws(()=>planImageLayerDelete(layers.map(layer=>layer.id==='child'?{...layer,locked:true}:layer),['folder']),{status:423});
});
