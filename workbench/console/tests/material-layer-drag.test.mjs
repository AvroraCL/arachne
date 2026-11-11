import assert from 'node:assert/strict';
import test from 'node:test';
import {materialLayerDrop} from '../public/material-layer-drag.mjs';

const layers=[
  {id:'bottom',kind:'fill'},{id:'middle',kind:'fill'},
  {id:'folder',kind:'group'},{id:'child',kind:'paint',parentId:'folder'},
  {id:'nested',kind:'group',parentId:'folder'},
  {id:'locked',kind:'group',locked:true},{id:'inherited',kind:'paint',parentId:'locked'}
];

test('material drag computes a single sibling reorder or parent change in paint order',()=>{
  assert.deepEqual(materialLayerDrop(layers,['bottom','middle'],'folder','inside'),
    {op:'arrange',ids:['bottom','middle'],parentId:'folder',placement:'above'});
  assert.deepEqual(materialLayerDrop(layers,['child'],'bottom','below'),
    {op:'arrange',ids:['child'],parentId:null,anchorId:'bottom',placement:'below'});
  assert.equal(materialLayerDrop(layers,['bottom','middle'],'folder','below'),null,'unchanged order needs no revision');
});

test('material drag rejects locked branches, mixed parents and descendant cycles',()=>{
  assert.equal(materialLayerDrop(layers,['inherited'],'folder','inside'),null);
  assert.equal(materialLayerDrop(layers,['middle'],'locked','inside'),null);
  assert.equal(materialLayerDrop(layers,['middle'],'inherited','above'),null);
  assert.equal(materialLayerDrop(layers,['middle','child'],'folder','inside'),null);
  assert.equal(materialLayerDrop(layers,['folder'],'nested','inside'),null);
  assert.equal(materialLayerDrop(layers,['folder'],'child','above'),null);
});
