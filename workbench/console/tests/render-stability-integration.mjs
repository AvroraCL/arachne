import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import {renderPathTrace} from '../path-trace-render.mjs';
import {pythonExecutable} from '../python-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..'),python=pythonExecutable();
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-render-stability-'));
execFileSync(python,[path.join(import.meta.dirname,'render-stability-fixture.py'),dir],{stdio:'inherit'});
const settings={width:128,height:128,samples:4,maxBounces:6,transparent:true,fileFormat:'OPEN_EXR',bitDepth:32,
 device:'auto',camera:{projection:'orthographic',eye:[0,0,4],target:[0,0,0],up:[0,1,0],orthoHeight:2.4}};
const files={'/input/model.glb':path.join(dir,'flat.glb')};
const base={settings,material:'target',channels:[],visibility:{},defaultVisibility:{}};
const origin='https://arachne-color-test.invalid';
const importMap={imports:{three:'/vendor/three/build/three.module.js','three/addons/':'/vendor/three/examples/jsm/',
 'three/examples/jsm/':'/vendor/three/examples/jsm/','three-gpu-pathtracer':'/vendor/three-gpu-pathtracer/build/index.module.js',
 'three-mesh-bvh':'/vendor/three-mesh-bvh/build/index.module.js'}};
const browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--enable-unsafe-swiftshader']});
try{
 const stripes=await renderPathTrace({
  ...base,settings:{...settings,width:384,height:384,samples:6,maxBounces:1,fileFormat:'PNG',bitDepth:8},
  channels:['emission','roughness'],appearance:{viewTransform:'Raw',look:'None',exposure:0,gamma:1}
 },{
  '/input/model.glb':path.join(dir,'model.glb'),'/input/emission.png':path.join(dir,'emission.png'),
  '/input/roughness.png':path.join(dir,'roughness.png')
 },{onSample(){}});
 assert.equal(stripes.textureSampling.reduced,false);
 assert.ok(stripes.textureSampling.layers.some(size=>size.join('x')==='64x64'));
 await fs.writeFile(path.join(dir,'stripes.png'),stripes.png);
 if(process.argv.includes('--budget')){
  const reduced=await renderPathTrace({
   ...base,settings:{...settings,width:2304,height:1536,samples:1,maxBounces:1,device:'cpu',fileFormat:'PNG',bitDepth:8},
   channels:['emission','roughness'],appearance:{viewTransform:'Raw',look:'None',exposure:0,gamma:1}
  },{
   '/input/model.glb':path.join(dir,'model.glb'),'/input/emission.png':path.join(dir,'square-emission.png'),
   '/input/roughness.png':path.join(dir,'square-roughness.png')
  },{onSample(){}});
  assert.equal(reduced.textureSampling.reduced,true,JSON.stringify(reduced.textureSampling));
  assert.ok(reduced.textureSampling.atlas[0]<4096);
  await fs.writeFile(path.join(dir,'reduced.png'),reduced.png);
  console.log('Budget reduced texture to',reduced.textureSampling.atlas);
 }
 const page=await browser.newPage();
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin)return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<script type="importmap">'+JSON.stringify(importMap)+'</script>'});
  if(files[url.pathname])return route.fulfill({path:files[url.pathname]});
  if(url.pathname.startsWith('/vendor/'))return route.fulfill({path:root+'/node_modules/'+url.pathname.slice(8),contentType:'text/javascript'});
  return route.fulfill({path:root+'/public/'+url.pathname.slice(1),contentType:'text/javascript'});
 });
 await page.goto(origin);
 await page.evaluate(async settings=>{
  const T=await import('three'),{GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
  const {createViewportPathTracer}=await import('/viewport-path-tracer.mjs');
  const renderer=new T.WebGLRenderer({alpha:true,preserveDrawingBuffer:true,antialias:false});
  renderer.setSize(settings.width,settings.height,false);
  const root=(await new GLTFLoader().loadAsync('/input/model.glb')).scene;
  const camera=new T.OrthographicCamera(-1.2,1.2,1.2,-1.2,.00001,10);
  camera.position.fromArray(settings.camera.eye);camera.lookAt(...settings.camera.target);camera.updateMatrixWorld();
  const bounds=new T.Box3().setFromObject(root),host=document.createElement('div');
  const trace=createViewportPathTracer({renderer,host,request(){},onStatus(){}});
  globalThis.preview=async (appearance,transparent)=>{
   trace.setOptions({enabled:false});
   trace.setOptions({enabled:true,project:{appearance,transparent},sampling:{maxSamples:settings.samples,denoise:false}});
   for(let i=0;i<1000;i++){
    trace.render(root,camera,bounds,{resolution:1,bounces:6,samples:settings.samples,ground:false},[]);
    if(trace.state().phase==='error')throw Error(trace.state().text);
    if(trace.state().phase==='ready')return renderer.domElement.toDataURL().split(',')[1];
    await new Promise(r=>setTimeout(r,0));
   }
   throw Error('preview timeout');
  };
 },settings);
 const cases=[['default',1,'None',true],['gamma',1.8,'None',true],['low',1.8,'AgX - Medium Low Contrast',true],['high',1.8,'AgX - Medium High Contrast',true],['opaque',1.8,'AgX - Medium High Contrast',false]];
 for(const [name,gamma,look,transparent] of cases){
  const appearance={viewTransform:'AgX',exposure:0,gamma,look};
  const render=await renderPathTrace({...base,settings:{...settings,transparent},appearance},files,{onSample(){}});
  const preview=await page.evaluate(([appearance,transparent])=>globalThis.preview(appearance,transparent),[appearance,transparent]);
  await fs.writeFile(path.join(dir,name+'-png.png'),render.png);
  await fs.writeFile(path.join(dir,name+'-view.png'),Buffer.from(preview,'base64'));
  await fs.writeFile(path.join(dir,name+'.exr'),render.exr);
 }
 for(const [space,bits] of [['lin_ap1_scene',16],['lin_rec2020_scene',32]]){
  const render=await renderPathTrace({...base,settings:{...settings,exrSpace:space,bitDepth:bits},
    appearance:{viewTransform:'AgX',exposure:0,gamma:1,look:'None'}},files,{onSample(){}});
  await fs.writeFile(path.join(dir,space+'.exr'),render.exr);
 }
 console.log(execFileSync(python,['-c',`
from pathlib import Path
import struct, sys
from PIL import Image
import numpy as np
root=Path(sys.argv[1])
def img(file):return np.asarray(Image.open(root/file).convert('RGBA')).astype(int)
assert np.ptp(img('stripes.png')[80:300,40:344,0].mean(0)) > 60, '4K stripes lost contrast'
if (root/'reduced.png').exists():
 reduced=img('reduced.png')[420:1100,600:1450,0]
 assert reduced.max()>20 and reduced.mean()>20
def exr(file,bits=32,space='lin_rec709_scene'):
 data=(root/file).read_bytes()
 at=8;attrs={}
 while data[at]:
  end=data.index(b'\\0',at);name=data[at:end].decode();at=end+1
  at=data.index(b'\\0',at)+1
  size,=struct.unpack_from('<I',data,at)
  attrs[name]=data[at+4:at+4+size];at+=4+size
 assert attrs['colorInteropID'].decode()==space
 xy=struct.unpack('<8f',attrs['chromaticities'])
 assert abs(xy[0]-{'lin_rec709_scene':.64,'lin_ap1_scene':.713,'lin_rec2020_scene':.708}[space])<1e-6
 at+=1
 offset,=struct.unpack_from('<Q',data,at+64*8)
 y,size=struct.unpack_from('<II',data,offset)
 return np.frombuffer(data, dtype='<f'+str(bits//8),count=size//(bits//8),offset=offset+8).reshape(4,128)
for name in ['default','gamma','low','high','opaque']:
 a,b=img(name+'-png.png'),img(name+'-view.png')
 diff=np.abs(a[38:90,38:90]-b[38:90,38:90])
 assert diff.max()<=2,(name,diff.max())
 assert a[0,0,3]==b[0,0,3]==(255 if name=='opaque' else 0)
 if name!='opaque':
  raw=exr(name+'.exr')
  assert np.max(np.abs(raw[:,40:88]-exr('default.exr')[:,40:88])) < .008
  assert np.all(raw[:,0]==0) and np.all(raw[0,40:88]==1)
 print(name,'center pixel',a[64,64].tolist(),'max viewport/PNG channel delta',diff.max())
# The EXR channels in this scanline are A, B, G, R. Compare interior pixels
# to independent OpenColorIO reference transforms with the same camera and lights.
src=exr('default.exr')
for name,bits,matrix in [('lin_ap1_scene',16,[[.6130974,.3395232,.0473795],[.0701937,.9163539,.0134524],[.0206156,.1095698,.8698146]]),
                         ('lin_rec2020_scene',32,[[.6274039,.3292831,.0433131],[.0690973,.9195403,.0113622],[.0163915,.0880134,.8955953]])]:
 target=exr(name+'.exr',bits,name)
 np.testing.assert_array_equal(target[0,40:88],src[0,40:88])
 np.testing.assert_allclose(target[3:0:-1,40:88],np.array(matrix)@src[3:0:-1,40:88],atol=.008,rtol=0)
 assert np.all(target[:,0]==0)
assert not np.array_equal(img('default-png.png'),img('gamma-png.png'))
assert not np.array_equal(img('low-png.png'),img('high-png.png'))
assert np.all(exr('default.exr')[:,0]==0)
`,dir],{encoding:'utf8'}));
}finally{await browser.close();await fs.rm(dir,{recursive:true,force:true});}
