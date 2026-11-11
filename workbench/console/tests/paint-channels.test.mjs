import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {paintChannels,channelDefaults,effectiveValues,effectiveBaseValues,activePaintChannels,renderChannel} from '../public/paint-channels.mjs';
import {defaultMaterialGraph,compileMaterialGraph} from '../public/material-graph.mjs';

test('new channel defaults are neutral and legacy documents are not mutated',()=>{
  const base={color:'#445566',metallic:.2,roughness:.6},paint={base,layers:[]};
  assert.deepEqual(activePaintChannels(paint),paintChannels.slice(0,3));
  assert.equal(effectiveValues(base).normal,'#8080ff');assert.equal(effectiveValues(base).alpha,1);assert.equal(effectiveValues(base).ao,1);assert.equal(effectiveValues(base).emission,'#000000');
  assert.equal(Object.keys(base).length,3);paint.layers.push({channels:{height:true}});assert.ok(activePaintChannels(paint).includes('height'));
});
test('base switches suppress only the base contribution and preserve authored values',()=>{
  const paint={base:{...channelDefaults,height:.83,alpha:.2},baseChannels:{height:false,alpha:false,normal:false},layers:[]};
  assert.equal(effectiveBaseValues(paint).height,.5);assert.equal(effectiveBaseValues(paint).alpha,1);
  assert.equal(paint.base.height,.83);assert.ok(!activePaintChannels(paint).includes('normal'));
  paint.layers.push({channels:{normal:true}});assert.ok(activePaintChannels(paint).includes('normal'));
  paint.baseChannels.height=true;assert.equal(effectiveBaseValues(paint).height,.83);
});
test('versioned live display preserves RGB/scalar types and supplies defaults for legacy frames',()=>{
  const p=Uint8Array.from([10,20,30,40,50,7,100,128,245,160,5,15,25,70,190]);
  assert.deepEqual([...renderChannel(p,1,'normal')],[100,128,245,255]);
  assert.deepEqual([...renderChannel(p,1,'emission')],[5,15,25,255]);
  assert.deepEqual([...renderChannel(p,1,'alpha')],[70,70,70,255]);
  assert.deepEqual([...renderChannel(p.slice(0,6),1,'normal')],[128,128,255,255]);
});
test('channel strips match full-frame decoding, including the last partial strip',()=>{
  const size=5;
  for(const stride of [6,15]){
    const pixels=Uint8Array.from({length:size*size*stride},(_,i)=>i%251);
    for(const channel of paintChannels){
      const full=renderChannel(pixels,size,channel);
      const strip=new Uint8ClampedArray(size*2*4);
      for(let y=0;y<size;y+=2){
        strip.fill(13);
        renderChannel(pixels,size,channel,strip,y*size);
        const rowBytes=size*4,start=y*rowBytes,end=Math.min(full.length,start+strip.length);
        assert.deepEqual(strip.subarray(0,end-start),full.subarray(start,end));
        assert.ok(strip.subarray(end-start).every(value=>value===13),'unused rows are outside the last write');
      }
    }
  }
});
test('legacy PBR graph parameters remain accepted and new scalar values stay bounded',()=>{
  const graph=defaultMaterialGraph();graph.nodes[1].params={color:'#445566',metallic:0,roughness:.5};
  assert.ok(compileMaterialGraph(graph));
  for(const key of ['height','alpha','ao']){graph.nodes[1].params[key]=1.1;assert.throws(()=>compileMaterialGraph(graph));delete graph.nodes[1].params[key];}
  graph.nodes[1].params.normal='#8080ff';graph.nodes[1].params.emission='#123456';assert.ok(compileMaterialGraph(graph));
});
test('Python graph preserves encoded normals, decodes emissive sRGB, and composes all new stroke channels',()=>{
  const script=`import numpy as np
from paint_channels import material_values,normalize_normals,enabled_base
b=dict(base=dict(height=.83,alpha=.2),baseChannels=dict(height=False,alpha=False));assert enabled_base(b)['height']==.5 and enabled_base(b)['alpha']==1 and b['base']['height']==.83
from material_graph import MaterialGraph,decode
v=material_values(dict(normal='#a080f0',emission='#808080',height=.8,alpha=.3,ao=.4),lambda s:decode(np.array(list(bytes.fromhex(s[1:])))/255))
assert np.allclose(v[5:8],np.array([160,128,240])/255)
assert .21<v[9]<.22 and v[12]==np.float32(.3)
p=np.tile(v,(2,1));normalize_normals(p);assert np.allclose(np.linalg.norm(p[:,5:8]*2-1,axis=1),1)
from paint_surface import Surface
surface=object.__new__(Surface)
stroke=dict(channels=dict(height=True,normal=True,emission=True,alpha=True,ao=True),values=dict(normal='#8080ff',emission='#808080',height=.8,alpha=.3,ao=.4),erase=False)
ids,paint=surface._paint_strokes([stroke],stroke['channels'],lambda s:decode(np.array(list(bytes.fromhex(s[1:])))/255),np.empty(0,dtype=np.int32),{},lambda s:(np.array([0],dtype=np.int32),np.array([.5])))
assert paint['normal'][1].shape==(1,3) and paint['emission'][1].shape==(1,3)
assert np.allclose(paint['alpha'][1],.15) and np.allclose(paint['height'][1],.4)
`;
  const result=spawnSync(process.env.ARACHNE_PYTHON||'python',['-c',script],{cwd:new URL('../',import.meta.url),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
