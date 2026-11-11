import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {defaultMaterialGraph,makeNode,makeGraphNode,compileMaterialGraph,compileNodeGraph,resolveGraphSockets} from '../public/material-graph.mjs';
import {defaultBrushGraph,evaluateBrushGraph} from '../public/paint-library.mjs';
import {insertMaterialNode,rerouteMaterialLinks,materialLinkKey,connectMaterialPorts} from '../public/material-graph-edit.mjs';
import {closestPolylinePoint,polylineCrossing} from '../public/node-link-geometry.mjs';
const link=(from,port,to,input)=>({from:{node:from,port},to:{node:to,port:input}});
test('reroutes preserve every channel and surface, infer chain types, reject cycles and incompatible fanout',()=>{
  let graph=defaultMaterialGraph(),serial=0;
  for(const edge of [...graph.links])graph=rerouteMaterialLinks(graph,[{key:materialLinkKey(edge),point:{x:200,y:180}}],{},()=>`r${serial++}`);
  const plan=compileMaterialGraph(graph);assert.equal(plan.nodes.filter(n=>n.type==='reroute').length,9);
  assert.equal(resolveGraphSockets(graph).get('r8').inputs.input,'surface');
  graph=rerouteMaterialLinks(graph,[{key:materialLinkKey(graph.links.find(l=>l.to.node==='r0')),point:{x:100,y:140}}],{},()=>`chain`);
  assert.equal(resolveGraphSockets(graph).get('chain').outputs.output,'color');
  assert.throws(()=>connectMaterialPorts(graph,{node:'r0',port:'output'},{node:'pbr',port:'metallic'}),/类型/);
  assert.throws(()=>connectMaterialPorts(graph,{node:'r0',port:'output'},{node:'chain',port:'input'}),/循环/);
  assert.throws(()=>compileMaterialGraph({...graph,links:graph.links.filter(l=>l.to.node!=='r8')}),/重定向/);
  const before=structuredClone(graph);assert.throws(()=>rerouteMaterialLinks(graph,[{key:'missing',point:{x:0,y:0}}]));assert.deepEqual(graph,before);
});
test('auto insertion uses compatible vacant sockets and preserves branches, with one validated batch',()=>{
  let graph=defaultMaterialGraph();graph.nodes.push(makeNode('math',0,0,'math'));
  const edge=graph.links.find(l=>l.to.port==='roughness');const next=insertMaterialNode(graph,'math',edge);
  assert.equal(next.links.find(l=>l.to.node==='math').to.port,'a');assert.equal(next.links.find(l=>l.to.port==='roughness').from.node,'math');
  assert.deepEqual(next.links.filter(l=>l.to.port==='metallic'),graph.links.filter(l=>l.to.port==='metallic'));
  assert.throws(()=>insertMaterialNode(graph,'math',graph.links[0]),/兼容/);
  assert.throws(()=>insertMaterialNode(next,'math',next.links.find(l=>l.to.node==='math')),/不能/);
  const occupied=connectMaterialPorts(next,{node:'paint',port:'metallic'},{node:'math',port:'b'});
  assert.throws(()=>insertMaterialNode(occupied,'math',occupied.links.find(l=>l.to.port==='height')),/空闲/);
  const reroute=makeNode('reroute',0,0,'r');graph.nodes.push(reroute);assert.ok(insertMaterialNode(graph,'r',graph.links[0]));
});
test('brush scalar and brush-output reroutes survive compilation and evaluate identically',()=>{
  let graph=defaultBrushGraph();graph.nodes.push(makeGraphNode(graph,'value',0,0,'value'));graph.nodes.at(-1).params.value=.3;
  graph=connectMaterialPorts(graph,{node:'value',port:'value'},{node:'brush',port:'opacity'});
  const expected=evaluateBrushGraph(graph);let serial=0;
  graph=rerouteMaterialLinks(graph,graph.links.map(edge=>({key:materialLinkKey(edge),point:{x:100,y:150}})),{},()=>`r${serial++}`);
  assert.deepEqual(evaluateBrushGraph(graph),expected);assert.ok(compileNodeGraph(graph));
});
test('Python evaluates scalar/color/vector/surface reroutes without changing rendered pixels',()=>{
  const original=defaultMaterialGraph();original.nodes.push(makeNode('uv',0,0,'uv'),makeNode('mapping',0,0,'mapping'),makeNode('image',0,0,'image'));
  original.links.push(link('uv','uv','mapping','uv'),link('mapping','uv','image','uv'));
  const edge=original.links.find(l=>l.to.port==='emission');original.links=original.links.filter(l=>l!==edge);original.links.push(link('image','color','pbr','emission'));
  let serial=0;const graph=rerouteMaterialLinks(original,original.links.map(edge=>({key:materialLinkKey(edge),point:{x:100,y:200}})),{},()=>`r${serial++}`);
  const data=JSON.stringify([compileMaterialGraph(original),compileMaterialGraph(graph)]);
  const result=spawnSync(process.env.ARACHNE_PYTHON||'python',['-c',`import json,sys,numpy as np
from material_graph import MaterialGraph
plans=json.loads(sys.argv[1]);pixels=np.random.default_rng(5).random((16,14)).astype(np.float32);indices=np.arange(16)
a,b=[MaterialGraph(p,{}).evaluate(pixels,indices,4,4) for p in plans]
assert np.array_equal(a,b)
`,data],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('wire crossing and closest-point geometry follows the wire, including degenerate segments',()=>{
  assert.deepEqual(polylineCrossing([{x:0,y:0},{x:10,y:10}],[{x:0,y:10},{x:10,y:0}]),{x:5,y:5});
  assert.equal(polylineCrossing([{x:0,y:0},{x:1,y:0}],[{x:0,y:2},{x:1,y:2}]),null);
  assert.deepEqual(closestPolylinePoint({x:5,y:2},[{x:0,y:0},{x:10,y:0}]),{x:5,y:0,distance:2});
});
