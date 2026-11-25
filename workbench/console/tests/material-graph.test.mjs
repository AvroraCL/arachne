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

test('one tagged texture supplies corrected color, raw channel data and unchanged alpha across cache reuse',()=>{
  const g=defaultMaterialGraph(),asset='e'.repeat(64);
  const color=makeNode('image',0,0,'texture'),raw=makeNode('image',0,0,'packed');
  color.params.asset=raw.params.asset=asset;
  raw.params.colorSpace='linear';
  g.nodes.push(color,raw);
  g.links=g.links.filter(link=>!['color','roughness','alpha'].includes(link.to.port));
  for(const [source,port,channel] of [['texture','color','color'],['packed','value','roughness'],['texture','alpha','alpha']])
    g.links.push({from:{node:source,port},to:{node:'pbr',port:channel}});
  const plan=compileMaterialGraph(g,{[asset]:{}});
  const result=spawnSync(pythonExecutable(),['-c',`
import json,sys,tempfile,hashlib
from pathlib import Path
from io import BytesIO
import numpy as np
from PIL import Image,ImageCms
from material_graph import MaterialGraph,MaterialImages,PreviewImages,prepare_blender_images,decode
from image_color_spaces import profile_bytes
from paint_channels import CHANNELS
plan=json.load(sys.stdin)
node=next(n for n in plan['nodes'] if n['id']=='texture')
asset=node['params']['asset']
with tempfile.TemporaryDirectory() as temp:
    folder=Path(temp);file=folder/'图像 ICC.png'
    original=np.array([[[68,119,170,161],[173,112,38,57]]],dtype=np.uint8)
    Image.fromarray(original).save(file,icc_profile=profile_bytes('rec2020'))
    def proof(space):
        result=ImageCms.profileToProfile(Image.fromarray(original),BytesIO(profile_bytes(space)),ImageCms.createProfile('sRGB'),outputMode='RGBA',renderingIntent=1)
        return np.asarray(result)[0]
    preview=PreviewImages()
    for setting,source in [('auto','rec2020'),('adobe-rgb','adobe-rgb'),('auto','rec2020')]:
        node['params']['colorSpace']=setting
        expected=proof(source)
        for cache in [None,preview]:
            with MaterialImages({asset:file},preview=cache) as images:
                graph=MaterialGraph(plan,{asset:file},images)
                uv=np.array([[.25,.5],[.75,.5],[.5,.5]])
                out=graph.evaluate(np.zeros((3,14)),np.arange(3),2,1,uv)
            linear=decode(expected[:,:3]/255)
            np.testing.assert_allclose(out[:2,CHANNELS['color']],linear,atol=.008)
            np.testing.assert_allclose(out[2,CHANNELS['color']],linear.mean(axis=0),atol=.008)
            np.testing.assert_allclose(out[:2,CHANNELS['alpha']],original[0,:,3]/255)
            np.testing.assert_allclose(out[:2,CHANNELS['roughness']],(original[0,:,:3]/255) @ [.2126,.7152,.0722],atol=1e-6)
    digest=hashlib.sha256(file.read_bytes()).hexdigest()
    entries=[dict(id=k,asset=digest,file=str(file),space='auto') for k in ('first','second')]
    request=folder/'request.json';request.write_text(json.dumps(entries))
    prepare_blender_images(request)
    stages=json.loads((folder/'profiled-images.json').read_text())
    assert stages['first']==stages['second']
    output=Path(stages['first']['file'])
    assert hashlib.sha256(output.read_bytes()).hexdigest()==stages['first']['sha256']
    with Image.open(output) as im:
        np.testing.assert_allclose(np.asarray(im)[0],proof('rec2020'),atol=1)
`],{cwd:new URL('../',import.meta.url),input:JSON.stringify(plan),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('color ramp knots preserve old plans and interpolate linear light across every interval',()=>{
  const graph=defaultMaterialGraph(),ramp=makeNode('ramp',0,0,'ramp'),driver=makeNode('value',0,0,'driver');
  graph.nodes.push(ramp,driver);
  graph.links=graph.links.filter(l=>l.to.port!=='color');
  graph.links.push({from:{node:'ramp',port:'color'},to:{node:'pbr',port:'color'}},
    {from:{node:'driver',port:'value'},to:{node:'ramp',port:'value'}});
  const legacy=compileMaterialGraph(graph);
  ramp.params.stops=[];
  assert.deepEqual(compileMaterialGraph(graph),legacy);
  const stop=(position,color='#ff0000')=>({position,color});
  for(const invalid of [[stop(0)],[stop(1)],[stop(.8),stop(.2)],[stop(.5),stop(.5)],[stop(.4,'#zzzzzz')],null]){
    ramp.params.stops=invalid;assert.throws(()=>compileMaterialGraph(graph),/色标/);
  }
  ramp.params.stops=[stop(.25),stop(.75,'#00ff00')];
  const run=spawnSync(pythonExecutable(),['-c',`
import json,sys,numpy as np
from material_graph import MaterialGraph
plan=json.load(sys.stdin)
ramp=next(n for n in plan['nodes'] if n['id']=='ramp')
driver=next(n for n in plan['nodes'] if n['id']=='driver')
paint=np.zeros((7,14))
points=[-.5,.125,.25,.5,.75,.875,1.5]
expected=[[0,0,0],[.5,0,0],[1,0,0],[.5,.5,0],[0,1,0],[.5,1,.5],[1,1,1]]
for v,rgb in zip(points,expected):
    driver['params']['value']=v
    out=MaterialGraph(plan,{}).evaluate(paint,np.arange(7),7,1)
    np.testing.assert_array_equal(out[:,:3],np.broadcast_to(rgb,(7,3)))
paint[:,4]=points
ramp['inputs']['value']={'node':'paint','port':'roughness'}
# Per-pixel factors arriving from another node use the same stop table.
out=MaterialGraph(plan,{}).evaluate(paint,np.arange(7),7,1)
np.testing.assert_array_equal(out[:,:3],expected)
`],{cwd:new URL('../',import.meta.url),input:JSON.stringify(compileMaterialGraph(graph)),encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
});

test('normalized 2D noise agrees with Cycles samples and remains invariant to tile boundaries',()=>{
  const graph=defaultMaterialGraph(),noise=makeNode('noise',0,0,'texture');
  graph.nodes.push(noise);
  graph.links=graph.links.filter(l=>l.to.port!=='roughness');
  graph.links.push({from:{node:'texture',port:'value'},to:{node:'pbr',port:'roughness'}});
  for(const detail of [-1,15.01]){
    noise.params.detail=detail;
    assert.throws(()=>compileMaterialGraph(graph),/噪声细节/);
  }
  const run=spawnSync(pythonExecutable(),['-c',`
import numpy as np
from material_noise import uv_noise
# Each constant was compared with a CPU Cycles Noise Fac in a pair of
# scene-linear EXR emission renders at identical UV and shader settings.
cases=[[.13,.79,5,2,.5,.47900468],[-.35,.72,2.5,.6,.7,.44861221],
       [.75,-2.32,3,2.25,.33,.4110899],[.74,.28,10.5,0,0,.5956703],
       [.445,.86,-6,2,.5,.5688186],[.01,.015,8,3,1,.5567903]]
for u,v,scale,detail,roughness,expected in cases:
    result=uv_noise(np.array([[u,v]]),scale,detail,roughness)
    np.testing.assert_allclose(result,expected,atol=2e-6,rtol=0)
uv=np.array([c[:2] for c in cases])
scale=np.arange(1,7)
whole=uv_noise(uv,scale,2.3,.8)
np.testing.assert_array_equal(whole,np.concatenate([uv_noise(u[None,:],s,2.3,.8) for u,s in zip(uv,scale)]))
np.testing.assert_array_equal(uv_noise(uv,0,15,1),np.full(6,.5))
`],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
});

test('wave mode, profile, linked scale and phase match fixed Cycles samples',()=>{
  const graph=defaultMaterialGraph(),wave=makeNode('wave',0,0,'wave');
  graph.nodes.push(wave);
  for(const [name,value] of [['profile','square'],['pattern','toString']]){
    const invalid=structuredClone(graph);invalid.nodes.at(-1).params[name]=value;
    assert.throws(()=>compileMaterialGraph(invalid),/波纹/);
  }
  const run=spawnSync(pythonExecutable(),['-c',`
import numpy as np
from material_graph import uv_wave
# Expected shader inputs were independently compared via paired CPU Cycles
# float EXRs for these twelve configurations (linear RGB error below 2e-6).
expected=[[.3928533,.0757643,.8601367],[.6527259,.124147,.5886862],
          [.6644662,.3214835,.3638324],[.7633468,.5113132,.2762169]]
for i,pattern in enumerate(('bands-x','bands-y','diagonal','rings')):
    for j,profile in enumerate(('sine','triangle','saw')):
        uv=np.array([[-.37+i*.11,.23+j*.12]])
        value=uv_wave(uv,-.92+j,.83-i,pattern,profile)
        np.testing.assert_allclose(value,[expected[i][j]],rtol=0,atol=2e-6)
uv=np.array([[.1,.2],[.5,.7],[-.2,.4]])
scale=np.array([2.3,0,-1.5]);phase=np.array([.3,-1.7,2.8])
scalar=[uv_wave(p[None,:],s,h,'rings','triangle')[0] for p,s,h in zip(uv,scale,phase)]
np.testing.assert_array_equal(uv_wave(uv,scale,phase,'rings','triangle'),scalar)
`],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
});
