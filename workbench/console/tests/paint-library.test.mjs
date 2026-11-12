import {groupMaterialMaps,mappedLibraryMaterial} from '../public/paint-library-maps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultLibraryMaterial,defaultBrushGraph,compileLibraryMaterial,evaluateBrushGraph,validateLibraries,libraryOperation} from '../public/paint-library.mjs';
import {makeGraphNode,compileMaterialGraph} from '../public/material-graph.mjs';
import {connectMaterialPorts,duplicateMaterialNodes,pasteMaterialNodes,copyMaterialNodes} from '../public/material-graph-edit.mjs';

test('library material is independent from paint and accepts real PBR image graphs',()=>{
  const graph=defaultLibraryMaterial({color:'#2488bb',metallic:.7,roughness:.2});
  const plan=compileLibraryMaterial(graph,{});assert.deepEqual(plan.nodes.map(n=>n.type),['pbr','output']);
  graph.nodes.push(makeGraphNode(graph,'paint'));assert.throws(()=>compileLibraryMaterial(graph,{}),/涂装结果/);
});
test('brush scalar graph evaluates settings and rejects cycles, wrong sockets and out-of-range results',()=>{
  const graph=defaultBrushGraph();graph.nodes.push(makeGraphNode(graph,'value',0,0,'size'),makeGraphNode(graph,'math',0,0,'half'));
  graph.nodes.find(n=>n.id==='size').params.value=96;graph.nodes.find(n=>n.id==='half').params={operation:'multiply',a:1,b:.5};
  const connected=connectMaterialPorts(connectMaterialPorts(graph,{node:'size',port:'value'},{node:'half',port:'a'}),{node:'half',port:'value'},{node:'brush',port:'uvRadius'});
  assert.equal(evaluateBrushGraph(connected).uvRadius,48);assert.equal(evaluateBrushGraph(connected).pressure,true);
  assert.throws(()=>compileMaterialGraph(connected));
  const invalid=structuredClone(connected);invalid.nodes.find(n=>n.id==='size').params.value=900;assert.throws(()=>evaluateBrushGraph(invalid),/范围/);
  assert.throws(()=>connectMaterialPorts(graph,{node:'brush',port:'brush'},{node:'half',port:'a'}));
  assert.throws(()=>connectMaterialPorts(connected,{node:'half',port:'value'},{node:'half',port:'b'}),/循环/);
  const duplicate=duplicateMaterialNodes(connected,['size','half'],{},()=>crypto.randomUUID());assert.equal(duplicate.graph.nodes.length,6);
  assert.throws(()=>pasteMaterialNodes(defaultLibraryMaterial(),copyMaterialNodes(graph,['brush'])));
});
test('resources validate missing graphs, protect referenced deletion and avoid inherited IDs',()=>{
  const paint={assets:{},layers:[]};validateLibraries(paint);
  libraryOperation(paint,{op:'library',library:'materials',id:'metal',action:'create',patch:{name:'Metal',graph:defaultLibraryMaterial()}});
  paint.layers.push({materialId:'metal'});assert.throws(()=>libraryOperation(paint,{op:'library',library:'materials',id:'metal',action:'remove'}),/引用/);
  paint.layers=[];libraryOperation(paint,{op:'library',library:'materials',id:'metal',action:'remove'});assert.equal(Object.keys(paint.materials).length,0);
  assert.throws(()=>libraryOperation(paint,{op:'library',library:'brushes',id:'constructor',action:'update',patch:{name:'x'}}));
  assert.throws(()=>libraryOperation(paint,{op:'library',library:'brushes',id:'bad',action:'create',patch:{name:'Invalid'}}));
  assert.throws(()=>validateLibraries({materials:[],assets:{}}));
});

test('PBR map grouping keeps distinct names and asks for ambiguous channels',()=>{
  const assets={
    a:{name:'Panel_BaseColor.png'},b:{name:'Panel Roughness 4K.png'},c:{name:'Panel_NormalGL.png'},
    d:{name:'Panel_Roughness_8K.png'},e:{name:'Other_AO.png'},f:{name:'Panel_NormalDX.png'}
  };
  const panel=groupMaterialMaps(assets).find(group=>group.name==='Panel');
  assert.deepEqual(panel.maps,{color:'a',roughness:null,normal:'c'});
  assert.deepEqual(groupMaterialMaps(assets).find(group=>group.name==='Other').maps,{ao:'e'});
  const stored=Object.fromEntries(Object.entries(assets).map(([id,asset])=>[id.repeat(64),asset]));
  const graph=mappedLibraryMaterial({color:'a'.repeat(64),roughness:'b'.repeat(64),normal:'c'.repeat(64),alpha:'e'.repeat(64)},stored,{alphaOutput:'alpha'});
  assert.deepEqual(graph.nodes.filter(node=>node.type==='image').map(({id,params})=>[id,params.colorSpace]),[
    ['map-color','srgb'],['map-roughness','linear'],['map-normal','linear'],['map-alpha','linear']
  ]);
  assert.equal(graph.links.find(link=>link.to.port==='alpha').from.port,'alpha');
  assert.equal(graph.links.find(link=>link.to.port==='roughness').from.port,'value');
  assert.throws(()=>mappedLibraryMaterial({},assets),/至少选择/);
  assert.throws(()=>mappedLibraryMaterial({color:'missing'},assets),/不存在/);
});
