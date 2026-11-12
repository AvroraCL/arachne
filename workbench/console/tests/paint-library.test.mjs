import {groupMaterialMaps,mappedLibraryMaterial} from '../public/paint-library-maps.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pythonExecutable} from '../python-runtime.mjs';
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

test('packed maps preserve a single linear texture, support 4K color and normals, and keep separate projects editable',()=>{
  const [packed,color,normal]=['a','b','c'].map(char=>char.repeat(64));
  const assets={
    [packed]:{name:'Panel_ORM.png',width:4096,height:4096},
    [color]:{name:'Panel_BaseColor.png',width:4096,height:4096},
    [normal]:{name:'Panel_Normal.png',width:4096,height:4096}
  };
  const group=groupMaterialMaps(assets)[0];
  assert.equal(group.packed.unreal,packed);
  const graph=mappedLibraryMaterial(group.maps,assets,{packed:{format:'unreal',asset:packed},normalFormat:'directx'});
  const plan=compileLibraryMaterial(graph,assets);
  const pbr=plan.nodes.find(node=>node.type==='pbr');
  assert.deepEqual(pbr.inputs.roughness,{node:'packed-separate',port:'green'});
  assert.deepEqual(pbr.inputs.metallic,{node:'packed-separate',port:'blue'});
  assert.deepEqual(pbr.inputs.ao,{node:'packed-separate',port:'red'});
  assert.deepEqual(pbr.inputs.normal,{node:'normal-combine',port:'color'});
  assert.equal(plan.nodes.filter(node=>node.params.asset===packed).length,1);
  const hdrp=mappedLibraryMaterial({},assets,{packed:{format:'unity',asset:packed}});
  assert.equal(hdrp.links.find(link=>link.to.node==='packed-smoothness-invert').from.port,'alpha');
  const run=spawnSync(pythonExecutable(),['-c',`
import json, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image
from material_graph import MaterialGraph, MaterialImages
from paint_channels import CHANNELS
config=json.load(sys.stdin)
with tempfile.TemporaryDirectory() as directory:
    asset=Path(directory)/'mask.png'
    Image.new('RGBA',(2,2),(51,102,204,153)).save(asset)
    assets={config['asset']: asset}
    cache=MaterialImages(assets)
    a=MaterialGraph(config['plan'],assets,cache)
    b=MaterialGraph(config['plan'],assets,cache)
    assert cache.pixel_count==4 and a.images[config['asset']] is b.images[config['asset']]
    result=a.evaluate(np.zeros((4,14)),np.arange(4),2,2)
    for name,expected in [('metallic',.2),('ao',.4),('roughness',.4)]:
        assert np.allclose(result[:,CHANNELS[name]],expected),result
`],{input:JSON.stringify({asset:packed,plan:compileLibraryMaterial(hdrp,assets)}),
    cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.throws(()=>mappedLibraryMaterial({},assets,{packed:{format:'unity',asset:'missing'}}),/打包贴图/);
});
