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
  if(url.pathname==='/input/signal-red.glb')return route.fulfill({path:path.join(dir,'signal-red.glb')});
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
  document.body.append(renderer.domElement);
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
  globalThis.startRedPreview=async (project)=>{
   trace.setOptions({enabled:false});
   const red=(await new GLTFLoader().loadAsync('/input/signal-red.glb')).scene;
   const {watchViewportColor}=await import('/viewport-display-color.mjs');
   const color=watchViewportColor(renderer,'auto',space=>{host.dataset.displayColorSpace=space;});
   const options={enabled:true,project,sampling:{maxSamples:settings.samples,denoise:false}};
   const viewport={resolution:1,bounces:6,samples:settings.samples,ground:false};
   trace.setOptions(options);
   for(let i=0;i<1000;i++){
    trace.render(red,camera,bounds,viewport,[]);
    if(trace.state().phase==='ready')break;
    if(trace.state().phase==='error')throw Error(trace.state().text);
    await new Promise(r=>setTimeout(r,0));
   }
   if(trace.state().phase!=='ready')throw Error('signal red preview timeout');
   trace.setOptions({...options,paused:true});
   globalThis.previewStudioSwatch=preference=>{
    color.setPreference(preference);
    const scene=new T.Scene(),hex='#cc3355';
    scene.background=new T.Color(hex);
    renderer.render(scene,camera);
    const gl=renderer.getContext(),background=new Uint8Array(4);
    gl.readPixels(64,64,1,1,gl.RGBA,gl.UNSIGNED_BYTE,background);
    const c=document.createElement('canvas'),ctx=c.getContext('2d',{colorSpace:gl.drawingBufferColorSpace});
    ctx.fillStyle=hex;ctx.fillRect(0,0,1,1);
    return {background:[...background],expected:[...ctx.getImageData(0,0,1,1,{colorSpace:gl.drawingBufferColorSpace}).data]};
   };
   globalThis.redSnapshot=preference=>{
    color.setPreference(preference);
    trace.render(red,camera,bounds,viewport,[],false);
    const gl=renderer.getContext(),pixel=new Uint8Array(4);
    gl.readPixels(64,64,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    const c=document.createElement('canvas');c.width=c.height=128;
    const ctx=c.getContext('2d',{colorSpace:'display-p3'});
    ctx.drawImage(renderer.domElement,0,0);
    return {space:host.dataset.displayColorSpace,buffer:gl.drawingBufferColorSpace,
      phase:trace.state().phase,samples:host.dataset.renderSamples,pixel:[...pixel],
      p3:[...ctx.getImageData(64,64,1,1,{colorSpace:'display-p3'}).data]};
   };
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
 const redFiles={'/input/model.glb':path.join(dir,'signal-red.glb')};
 const signalRed={...base,appearance:{viewTransform:'Raw',look:'None',exposure:0,gamma:1},
   lighting:{preset:'custom',rotation:0,lights:[],lightStrength:0,environmentStrength:0,environmentColor:'#000000'}};
 for(const pngSpace of ['srgb','display-p3']){
   const render=await renderPathTrace({...signalRed,settings:{...settings,fileFormat:'PNG',bitDepth:8,pngSpace}},redFiles,{onSample(){}});
   await fs.writeFile(path.join(dir,'red-'+pngSpace+'.png'),render.png);
 }
 // Hold the scene and display look constant. Changing the delivery profile
 // should only re-encode the image, including with nondefault gamma/contrast.
 for(const pngSpace of ['srgb','display-p3','prophoto-rgb','rec709','rec709-g24']){
   const render=await renderPathTrace({...signalRed,
     appearance:{...signalRed.appearance,gamma:1.8,look:'AgX - Medium High Contrast'},
     settings:{...settings,samples:1,maxBounces:1,fileFormat:'PNG',bitDepth:8,pngSpace}},files,{onSample(){}});
   await fs.writeFile(path.join(dir,'look-'+pngSpace+'.png'),render.png);
 }
 const monitor=await page.context().newCDPSession(page);
 const setMonitor=async gamut=>{
   await monitor.send('Emulation.setEmulatedMedia',{features:[{name:'color-gamut',value:gamut}]});
   await page.waitForFunction(wide=>matchMedia('(color-gamut: p3)').matches===wide,gamut==='p3');
 };
 await setMonitor('p3');
 await page.evaluate(project=>globalThis.startRedPreview(project),{appearance:signalRed.appearance,lighting:signalRed.lighting,transparent:true});
 const native=await page.evaluate(()=>globalThis.redSnapshot('auto'));
 const proof=await page.evaluate(()=>globalThis.redSnapshot('srgb'));
 await setMonitor('srgb');const ordinary=await page.evaluate(()=>globalThis.redSnapshot('auto'));
 await setMonitor('p3');const restored=await page.evaluate(()=>globalThis.redSnapshot('auto'));
 assert.deepEqual(restored,native);
 assert.deepEqual(ordinary,proof);
 for(const item of [native,proof]){
   assert.equal(item.space,item.buffer);assert.equal(item.phase,'paused');assert.equal(+item.samples,settings.samples);
 }
 assert.equal(native.space,'display-p3');assert.equal(proof.space,'srgb');
 assert.ok(native.p3[0]>proof.p3[0]+8,JSON.stringify({native,proof}));
 for(const preference of ['auto','srgb']){
   const {background,expected}=await page.evaluate(pref=>globalThis.previewStudioSwatch(pref),preference);
   assert.ok(background.every((v,i)=>Math.abs(v-expected[i])<=1),JSON.stringify({preference,background,expected}));
 }
 await fs.writeFile(path.join(dir,'red-preview.json'),JSON.stringify({native,proof}));
 console.log('Paused display switch',native,proof);
 await monitor.detach();
 const redLinear=await renderPathTrace({...signalRed,settings},redFiles,{onSample(){}});
 await fs.writeFile(path.join(dir,'red.exr'),redLinear.exr);
 const rampFiles={'/input/model.glb':path.join(dir,'ramp.glb'),'/input/emission.png':path.join(dir,'ramp.png')};
 const ramp={...signalRed,channels:['emission'],settings:{...settings,width:960,height:128,samples:1,maxBounces:1,
     fileFormat:'PNG',bitDepth:16,camera:{...settings.camera,orthoHeight:.3}}};
 const sixteen=await renderPathTrace(ramp,rampFiles,{onSample(){}});
 await fs.writeFile(path.join(dir,'ramp16.png'),sixteen.png);
 for(const [space,depth] of [['display-p3',16],['adobe-rgb',8],['prophoto-rgb',16],['rec2020',16]]){
   const render=await renderPathTrace({...signalRed,settings:{...settings,fileFormat:'PNG',bitDepth:depth,pngSpace:space}},redFiles,{onSample(){}});
   await fs.writeFile(path.join(dir,space+'-'+depth+'.png'),render.png);
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
from PIL import ImageCms
from io import BytesIO
reference=img('look-srgb.png')
for space in ['display-p3','prophoto-rgb','rec709','rec709-g24']:
 tagged=Image.open(root/('look-'+space+'.png'))
 converted=ImageCms.profileToProfile(tagged,BytesIO(tagged.info['icc_profile']),ImageCms.createProfile('sRGB'),outputMode='RGBA',renderingIntent=1)
 delta=np.abs(reference[40:88,40:88]-np.asarray(converted)[40:88,40:88]).max()
 assert delta<=2,(space,delta)
 print('Same display look in',space,'max channel delta',delta)
wide=Image.open(root/'red-display-p3.png')
tag=ImageCms.ImageCmsProfile(BytesIO(wide.info['icc_profile']))
assert 'P3' in ImageCms.getProfileDescription(tag) and wide.size==(128,128)
linear=exr('red.exr')[[3,2,1],64];assert linear[0]>1.05
p3=np.array([[.822462,.177538,0],[.033194,.966806,0],[.017083,.072397,.91052]])@linear
encoded=lambda v:np.rint(np.clip(np.where(v<=.0031308,12.92*v,1.055*v**(1/2.4)-.055),0,1)*255).astype(int)
got=np.array(wide.getpixel((64,64))[:3]);assert np.max(np.abs(got-encoded(p3)))<=2,(linear,p3,got)
small=Image.open(root/'red-srgb.png')
clipped=ImageCms.profileToProfile(small,ImageCms.createProfile('sRGB'),tag,outputMode='RGBA').getpixel((64,64))
import json
monitor=json.loads((root/'red-preview.json').read_text())
for report,image in [(monitor['native'],wide),(monitor['proof'],small)]:
 assert np.max(np.abs(np.array(report['pixel'])-image.getpixel((64,64))))<=1,(report,image.getpixel((64,64)))
assert got[0]>int(clipped[0])+8 and wide.getpixel((0,0))[3]==small.getpixel((0,0))[3]==0
print('Display P3 PNG',got,'from scene linear',linear,'vs clipped sRGB converted to P3',clipped)
# Read the PNG samples at their declared precision. Pillow exposes RGB PNG
# as eight-bit tuples; the scanline decode below retains every low byte.
def samples(file):
 import zlib
 frame=(root/file).read_bytes();offset=8;compressed=[]
 while offset<len(frame):
  n,=struct.unpack_from('>I',frame,offset);kind=frame[offset+4:offset+8];payload=frame[offset+8:offset+8+n]
  assert zlib.crc32(kind+payload)==struct.unpack_from('>I',frame,offset+8+n)[0]
  if kind==b'IHDR': w,h,depth,mode,_,_,interlace=struct.unpack('>IIBBBBB',payload);assert mode==6 and not interlace
  if kind==b'IDAT': compressed.append(payload)
  offset+=12+n
 raw=np.frombuffer(zlib.decompress(b''.join(compressed)),dtype=np.uint8).reshape(h,-1)
 assert np.all(raw[:,0]==1)
 bpp=depth//8*4
 unfiltered=np.cumsum(raw[:,1:].reshape(h,w,bpp),axis=1,dtype=np.uint8)
 return unfiltered.view('>u2' if depth==16 else 'u1').reshape(h,w,4)
ramp=samples('ramp16.png')
r=ramp[64,:,0]
assert len(np.unique(r))>256 and np.count_nonzero(r%257)>256,(len(np.unique(r)),np.count_nonzero(r%257))
assert np.all(ramp[64,150:-150,3]==65535)
print('16-bit PNG ramp, unique levels on one scanline',len(np.unique(r)),'of',len(r))
for name,depth in [('display-p3',16),('adobe-rgb',8),('prophoto-rgb',16),('rec2020',16)]:
 filename=name+'-'+str(depth)+'.png';out=samples(filename)
 tagged=Image.open(root/filename);profile=ImageCms.ImageCmsProfile(BytesIO(tagged.info['icc_profile']))
 assert profile.profile.xcolor_space.strip()=='RGB' and out[0,0,3]==0
 # Map the in-gamut P3 result into the selected ICC to independently check
 # chromatic adaptation, transfer curve and the direction of the matrix.
 ref=ImageCms.profileToProfile(wide,tag,profile,outputMode='RGBA',renderingIntent=1).getpixel((64,64))
 actual=out[64,64].astype(float)/(257 if depth==16 else 1)
 assert np.max(np.abs(np.array(ref,dtype=float)-actual))<3,(name,actual,ref)
 print(name,depth,'encoded signal red',out[64,64].tolist())
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
