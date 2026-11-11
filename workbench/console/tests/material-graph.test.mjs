import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {compileMaterialGraph,defaultMaterialGraph,makeNode} from '../public/material-graph.mjs';
import {pythonExecutable} from '../python-runtime.mjs';

test('default graph retains eight independent paint channels and compiles only connected nodes',()=>{
  const g=defaultMaterialGraph();g.nodes.push(makeNode('value',0,0,'unused'));
  const plan=compileMaterialGraph(g);
  assert.deepEqual(plan.nodes.map(n=>n.type),['paint','pbr','output']);
  assert.deepEqual(Object.keys(plan.nodes[1].inputs),['color','metallic','roughness','normal','height','emission','alpha','ao']);
  const before=JSON.stringify(plan);g.nodes[0].x=800;
  assert.equal(JSON.stringify(compileMaterialGraph(g)),before,'node layout cannot change material semantics');
});
test('graph rejects cycles, type mismatches, duplicate sockets, missing assets and ambiguous outputs',()=>{
  const invalid=mutate=>{const g=defaultMaterialGraph();mutate(g);assert.throws(()=>compileMaterialGraph(g));};
  invalid(g=>g.links.push(g.links[0]));
  invalid(g=>g.links[0].from.port='metallic');
  invalid(g=>g.nodes.push({...g.nodes[0]}));
  invalid(g=>g.nodes.push(makeNode('output',0,0,'second')));
  invalid(g=>g.nodes.push({...makeNode('image',0,0,'image'),params:{asset:'a'.repeat(64)}}));
  invalid(g=>{g.nodes.push(makeNode('math',0,0,'one'),makeNode('math',0,0,'two'));g.links.push({from:{node:'one',port:'value'},to:{node:'two',port:'a'}},{from:{node:'two',port:'value'},to:{node:'one',port:'a'}});});
  invalid(g=>g.nodes[1].params.metallic=1.1);
  invalid(g=>g.nodes[1].params.roughness=NaN);
  invalid(g=>g.links[0].from.port='constructor');
});

test('image color space defaults preserve old plans and invalid choices cannot enter projects',()=>{
  const graph=defaultMaterialGraph(),asset='b'.repeat(64),image=makeNode('image',0,0,'image');image.params={asset};graph.nodes.push(image);
  graph.links=graph.links.filter(link=>link.to.port!=='color');graph.links.push({from:{node:'image',port:'color'},to:{node:'pbr',port:'color'}});
  const legacy=compileMaterialGraph(graph,{[asset]:{}});
  image.params.colorSpace='srgb';assert.deepEqual(compileMaterialGraph(graph,{[asset]:{}}),legacy);
  image.params.colorSpace='linear';assert.notDeepEqual(compileMaterialGraph(graph,{[asset]:{}}),legacy);
  image.params.colorSpace='unknown';assert.throws(()=>compileMaterialGraph(graph,{[asset]:{}}),/颜色空间/);
});
test('linear-light evaluation, scalar math and image UV mapping agree with typed plans',()=>{
  const g=defaultMaterialGraph();g.nodes.push(makeNode('mix',0,0,'mix'),makeNode('math',0,0,'math'));
  g.nodes.find(n=>n.id==='math').params={operation:'divide',a:.8,b:2};
  g.links=g.links.filter(l=>!['color','roughness'].includes(l.to.port));
  g.links.push({from:{node:'mix',port:'color'},to:{node:'pbr',port:'color'}},{from:{node:'math',port:'value'},to:{node:'pbr',port:'roughness'}});
  const result=spawnSync(pythonExecutable(),['-c',`
import sys,json,tempfile
from pathlib import Path
import numpy as np
from PIL import Image
from material_graph import MaterialGraph
plan=json.load(sys.stdin)
paint=np.tile([.1,.2,.3,.8,.6],(4,1))
result=MaterialGraph(plan,{}).evaluate(paint,np.arange(4),2,2)
assert np.allclose(result[:,:3],.5),result
assert np.allclose(result[:,3],.8)
assert np.allclose(result[:,4],.4)
with tempfile.TemporaryDirectory() as folder:
 file=str(Path(folder)/'source.png')
 Image.fromarray(np.array([[[255,0,0,255],[0,255,0,128]],[[0,0,255,64],[255,255,255,0]]],dtype=np.uint8)).save(file)
 nodes=[dict(id='image',type='image',params=dict(asset='asset'),inputs={}),dict(id='pbr',type='pbr',params=dict(color='#000000',metallic=0,roughness=.5),inputs=dict(color=dict(node='image',port='color'),metallic=dict(node='image',port='alpha'))),dict(id='output',type='output',params={},inputs=dict(surface=dict(node='pbr',port='surface')))]
 out=MaterialGraph(dict(nodes=nodes),dict(asset=file)).evaluate(paint,np.arange(4),2,2)
 assert np.allclose(out[:,:3],[[0,0,1],[1,1,1],[1,0,0],[0,1,0]]),out
 assert np.allclose(out[:,3],[64/255,0,1,128/255]),out
 Image.new('RGBA',(2,2),(128,128,128,128)).save(file)
 nodes[1]['inputs']['metallic']=dict(node='image',port='value')
 srgb=MaterialGraph(dict(nodes=nodes),dict(asset=file)).evaluate(paint,np.arange(4),2,2)
 nodes[0]['params']['colorSpace']='linear'
 linear=MaterialGraph(dict(nodes=nodes),dict(asset=file)).evaluate(paint,np.arange(4),2,2)
 assert np.allclose(linear[:,3],128/255),linear
 assert np.allclose(srgb[:,3],((128/255+.055)/1.055)**2.4),srgb
 assert np.allclose(linear[:,:3],128/255),linear
print('linear PBR, alpha and UV orientation verified')
`],{cwd:new URL('../',import.meta.url),input:JSON.stringify(compileMaterialGraph(g)),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/verified/);
});
