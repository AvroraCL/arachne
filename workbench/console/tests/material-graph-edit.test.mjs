import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultMaterialGraph,makeNode} from '../public/material-graph.mjs';
import {connectMaterialPorts,editMaterialLinks,copyMaterialNodes,pasteMaterialNodes,duplicateMaterialNodes,removeMaterialNodes,vacantMaterialPosition,parseMaterialClipboard,materialClipboardPrefix} from '../public/material-graph-edit.mjs';
import {polylinesIntersect} from '../public/node-link-geometry.mjs';
import {defaultBrushGraph,evaluateBrushGraph} from '../public/paint-library.mjs';

test('brush links use the same atomic replacement and preserve the required brush output',()=>{
  const graph=defaultBrushGraph();graph.nodes.push(makeNode('value',0,0,'value'));
  graph.nodes.at(-1).params.value=.3;
  const connected=connectMaterialPorts(graph,{node:'value',port:'value'},{node:'brush',port:'hardness'});
  const link=connected.links.find(l=>l.to.port==='hardness');
  const moved=editMaterialLinks(connected,[link],[{from:link.from,to:{node:'brush',port:'opacity'}}]);
  assert.equal(evaluateBrushGraph(moved).opacity,.3);
  assert.equal(evaluateBrushGraph(moved).hardness,1);
  assert.throws(()=>editMaterialLinks(moved,moved.links.filter(l=>l.to.node==='output')),/输出/);
  assert.equal(connected.links.find(l=>l.to.port==='hardness').from.node,'value');
});

test('link moves and bulk source replacement are atomic, preserve branches and reject invalid output removal',()=>{
  const graph=defaultMaterialGraph();graph.nodes.push(makeNode('value',0,0,'one'),makeNode('value',0,0,'two'));
  let next=connectMaterialPorts(graph,{node:'one',port:'value'},{node:'pbr',port:'metallic'});
  next=connectMaterialPorts(next,{node:'one',port:'value'},{node:'pbr',port:'roughness'});
  const old=structuredClone(next),outgoing=next.links.filter(l=>l.from.node==='one');
  next=editMaterialLinks(next,outgoing,outgoing.map(l=>({from:{node:'two',port:'value'},to:l.to})));
  assert.deepEqual(next.links.filter(l=>l.from.node==='two').map(l=>l.to.port).sort(),['metallic','roughness']);
  assert.deepEqual(old.links.filter(l=>l.from.node==='one'),outgoing);
  const line=next.links.find(l=>l.to.port==='metallic');const moved=editMaterialLinks(next,[line],[{from:line.from,to:{node:'pbr',port:'height'}}]);
  assert.equal(moved.links.some(l=>l.to.port==='metallic'),false);assert.equal(moved.links.find(l=>l.to.port==='height').from.node,'two');
  assert.equal(moved.links.find(l=>l.to.port==='roughness').from.node,'two');
  assert.deepEqual(connectMaterialPorts(next,line.from,line.to),next,'same endpoint keeps stable order and does not become an edit');
  assert.throws(()=>editMaterialLinks(next,next.links,[]),/输出需要连接/);assert.deepEqual(next.links.filter(l=>l.to.node==='output'),graph.links.filter(l=>l.to.node==='output'));
});

test('cut geometry detects crossing, endpoints, collinear runs and screen-space tolerance without false distant cuts',()=>{
  const p=(x,y)=>({x,y});
  assert.equal(polylinesIntersect([p(0,0),p(10,10)],[p(0,10),p(10,0)]),true);
  assert.equal(polylinesIntersect([p(0,0),p(10,0)],[p(10,0),p(20,0)]),true);
  assert.equal(polylinesIntersect([p(0,0),p(10,0)],[p(4,0),p(8,0)]),true);
  assert.equal(polylinesIntersect([p(0,0),p(10,0)],[p(5,1),p(5,3)],2),true);
  assert.equal(polylinesIntersect([p(0,0),p(10,0)],[p(5,3),p(5,6)],2),false);
  assert.equal(polylinesIntersect([p(0,0),p(0,0)],[p(0,0),p(0,10)]),true);
  assert.equal(polylinesIntersect([],[]),false);
});

test('reconnect replaces only one typed input atomically',()=>{
  const graph=defaultMaterialGraph();graph.nodes.push(makeNode('color',0,0,'color'));
  const next=connectMaterialPorts(graph,{node:'color',port:'color'},{node:'pbr',port:'color'});
  assert.equal(next.links.find(link=>link.to.node==='pbr'&&link.to.port==='color').from.node,'color');
  assert.equal(graph.links[0].from.node,'paint');
  assert.throws(()=>connectMaterialPorts(graph,{node:'color',port:'color'},{node:'pbr',port:'roughness'}));
});

test('duplicate remaps internal links, retains incoming dependencies and never hijacks consumers',()=>{
  const graph=defaultMaterialGraph();let serial=0;
  const {graph:next,selection}=duplicateMaterialNodes(graph,['paint','pbr'],{},()=>`copy-${++serial}`);
  assert.deepEqual(selection,['copy-1','copy-2']);
  assert.equal(next.links.filter(link=>link.to.node==='output').length,1);
  assert.equal(next.links.find(link=>link.to.node==='output').from.node,'pbr');
  assert.equal(next.links.filter(link=>link.from.node==='copy-1'&&link.to.node==='copy-2').length,8);
  const onlyPBR=duplicateMaterialNodes(graph,['pbr'],{},()=>`copy-${++serial}`);
  assert.equal(onlyPBR.graph.links.filter(link=>link.to.node===onlyPBR.selection[0]).length,8);
  assert.deepEqual(next.nodes.at(-1).params,graph.nodes[1].params);next.nodes.at(-1).params.roughness=.1;assert.equal(graph.nodes[1].params.roughness,.5);
});

test('clipboard contains just internal links and pasted assets must exist in the target project',()=>{
  const graph=defaultMaterialGraph(),image=makeNode('image',0,0,'image'),asset='a'.repeat(64);image.params.asset=asset;graph.nodes.push(image);
  const fragment=copyMaterialNodes(graph,['pbr','image','output']);assert.equal(fragment.nodes.length,2);assert.deepEqual(fragment.links,[]);
  const parsed=parseMaterialClipboard(materialClipboardPrefix+JSON.stringify(fragment));assert.deepEqual(parsed,fragment);
  assert.throws(()=>pasteMaterialNodes(defaultMaterialGraph(),parsed,{}),/素材/);
  let serial=0;const result=pasteMaterialNodes(defaultMaterialGraph(),parsed,{[asset]:{}},{x:100,y:200},()=>`p-${++serial}`);
  assert.equal(Math.min(...result.graph.nodes.slice(3).map(node=>node.x)),100);
  assert.equal(Math.min(...result.graph.nodes.slice(3).map(node=>node.y)),200);
  assert.throws(()=>parseMaterialClipboard('ordinary clipboard text'));
  assert.throws(()=>removeMaterialNodes(graph,['output']));
  assert.equal(removeMaterialNodes(graph,['image']).nodes.length,3);
});

test('new nodes find vacant snapped positions including variable-height nodes',()=>{
  const nodes=[{id:'one',x:0,y:0},{id:'two',x:260,y:0}];
  const position=vacantMaterialPosition(nodes,{x:20,y:20},{one:600,two:600});
  assert.equal(Math.abs(position.x%20),0);assert.equal(Math.abs(position.y%20),0);
  assert.ok(nodes.every(node=>position.x+248<=node.x||position.x>=node.x+248||position.y+264<=node.y||position.y>=node.y+624));
});
