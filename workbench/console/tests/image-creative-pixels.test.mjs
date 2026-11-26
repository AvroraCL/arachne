import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {pythonExecutable} from '../python-runtime.mjs';
import {writeDisplayRGB,workingHexToLab,labToWorkingHex} from '../public/image-display-rgb.mjs';
import {createSmoothMesh,smoothMesh,validImageWarp,warpPoint} from '../public/image-warp.mjs';

test('local exact preview uses the 4K pixels for paint, low flow, tip grain, erasure and a soft mask',()=>{
  const result=JSON.parse(execFileSync(pythonExecutable(),['-B','-c',`
import tempfile, json, time, sys
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
from image_documents import composite_document, exact_stroke_window

def layer(id,kind,**params):
    return dict(id=id,kind=kind,opacity=1,visible=True,blend='normal',maskEnabled=False,maskBase=1,**params)

with tempfile.TemporaryDirectory() as tmp:
    tip=Path(tmp)/'tip.png'
    image=Image.new('L',(64,64),255)
    ImageDraw.Draw(image).ellipse((3,18,61,47),fill=0)
    image.save(tip)
    assets={'tip':str(tip)}
    box=[1871,1904,256]
    strokes=[
        dict(uv=True,rect=[.43,.43,.56,.53],color='#0a7ead',opacity=.65,erase=False),
        dict(uv=True,radius=.001,hardness=.8,color='#ecbd32',opacity=.7,flow=.16,spacing=.17,erase=False,
             stamps=[[.48,.49,.85],[.493,.502,.36],[.504,.504,.67]],clip=[.47,.484,.506,.52],
             polygon=[[.47,.484],[.5,.49],[.506,.52],[.476,.513]]),
        dict(uv=True,radius=.002,hardness=.75,color='#b6cafa',opacity=.8,flow=.23,spacing=.18,erase=False,
             stamps=[[.47,.5],[.49,.5],[.51,.5]],
             tip=dict(tipAsset='tip',angle=33,roundness=.65,grain=.5,scatter=.24,seed=211)),
        dict(uv=True,radius=.0017,hardness=.35,color='#000000',opacity=.85,erase=True,flow=.28,spacing=.2,
             stamps=[[.46,.494],[.48,.493],[.50,.498]]),
    ]
    mask=dict(uv=True,radius=.008,hardness=.35,opacity=.8,flow=.5,spacing=.2,
              stamps=[[.48,.45],[.49,.49],[.502,.515]],value=0)
    document=dict(colorSpace='srgb',layers=[layer('ink','pixel',strokes=strokes)])
    document['layers'][0].update(maskEnabled=True,maskStrokes=[mask],maskFeather=5.5)
    start=time.perf_counter()
    full=composite_document(document,assets,4096)
    full_ms=(time.perf_counter()-start)*1000
    x,y,size=box
    target=full[y:y+size,x:x+size].copy()
    del full
    assert np.count_nonzero(target[:,:,3])>10000
    start=time.perf_counter()
    draft=exact_stroke_window(document,assets,box,None)
    tile_ms=(time.perf_counter()-start)*1000
    assert np.array_equal(draft,target),np.max(np.abs(draft.astype(int)-target))
    mask_full=composite_document(document,assets,4096,'ink')
    assert np.array_equal(exact_stroke_window(document,assets,box,'ink'),mask_full[y:y+size,x:x+size])
    del mask_full
    start=time.perf_counter()
    low=composite_document(document,assets,1024)
    low_ms=(time.perf_counter()-start)*1000
    enlarged=np.asarray(Image.fromarray(low).resize((4096,4096),Image.Resampling.BILINEAR))
    different=int(np.count_nonzero(np.any(target!=enlarged[y:y+size,x:x+size],axis=-1)))
    assert different>700,different
    print(json.dumps(dict(changed_pixels=different,exact_ms=round(tile_ms,1),low_ms=round(low_ms,1),full_ms=round(full_ms,1))))
`],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,OPENBLAS_NUM_THREADS:'1'}}));
  assert.ok(result.changed_pixels>700);
  console.log(result);
});

test('smooth net is continuous across cell boundaries and keeps invertible local coordinates',()=>{
  const mesh=createSmoothMesh(3);
  mesh.points[5]=[.63,.265];
  mesh.points[6]=[.74,.31];
  assert.ok(validImageWarp(mesh));
  const seam=mesh.u[1],epsilon=1e-5;
  const a=warpPoint(mesh,[seam-epsilon,.39]),b=warpPoint(mesh,[seam,.39]),c=warpPoint(mesh,[seam+epsilon,.39]);
  assert.ok(Math.hypot(...b.map((n,i)=>(c[i]-2*n+a[i])/epsilon))<.001);
  const local=smoothMesh([0,.167,...mesh.u.slice(1)],mesh.v,mesh);
  assert.ok(validImageWarp(local));
  for(const point of [[.257,.389],[.631,.723],[.881,.413]]){
    const roundTrip=warpPoint(local,warpPoint(local,point),true);
    assert.ok(Math.hypot(...roundTrip.map((n,i)=>n-point[i]))<1e-6);
  }
  const folded=structuredClone(local);
  folded.points[5]=[.9,.9];
  assert.equal(validImageWarp(folded),false);
});

test('group outline follows masked union and edge cleaning preserves coverage',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
import numpy as np
from image_documents import composite_document, clean_edge_colors, refine_local_edge

def ink(id,parent,rect,color):
    return dict(id=id,parentId=parent,kind='pixel',visible=True,opacity=1,blend='normal',
                maskEnabled=False,maskBase=1,
                strokes=[dict(rect=rect,uv=True,color=color,opacity=1,erase=False)])

size=256
group=dict(id='root',kind='group',visible=True,opacity=.5,blend='passThrough',
           maskEnabled=True,maskBase=0,
           maskStrokes=[dict(rect=[.22,.25,.6,.75],uv=True,opacity=1,value=1)],
           styles=dict(outline=dict(enabled=True,color='#00ff00',width=80,position='outside')))
document=dict(colorSpace='srgb',layers=[group,
    ink('a','root',[.25,.25,.48,.75],'#0000ff'),ink('b','root',[.44,.25,.75,.75],'#0000ff')])
out=composite_document(document,{},size)
assert list(out[128,120])==[0,0,255,128]
assert list(out[128,157])==[0,255,0,128]
assert out[128,175,3]==0

coverage=np.array([.25,.5,.75],np.float32)
foreground=np.array([.08,.2,.55],np.float32)
pixels=np.column_stack((foreground[None,:]*coverage[:,None]+(1-coverage[:,None]),np.ones(len(coverage))))
cleaned=clean_edge_colors(pixels.copy(),coverage,dict(color='#ffffff',amount=1),lambda ink: np.ones(3))
assert np.allclose(cleaned[:,:3],foreground,atol=1e-6)
assert np.array_equal(cleaned[:,3],pixels[:,3])

actual=np.tile(np.clip((np.arange(size)-110)/32,0,1),(size,1))
pixel=(.15+.7*actual)*255
source=np.dstack((pixel,pixel,pixel,np.full_like(pixel,255))).astype(np.uint8)
coarse=(actual>=.5).astype(np.uint8)*255
edited=refine_local_edge(coarse.copy(),dict(points=[[.50,.30],[.50,.70]],radius=28,amount=20,
    foreground=[.58,.5],background=[.42,.5]),source)
local=np.s_[78:180,110:142]
assert np.abs(edited[local]-actual[local]*255).mean()<np.abs(coarse[local]-actual[local]*255).mean()*.8
assert np.array_equal(edited[:24],coarse[:24])
`],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
});


test('native smooth grid matches the NumPy reference for linked masks and 4K pixels',t=>{
  const outcome=execFileSync(pythonExecutable(),['-B','-c',`
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import numpy as np
from PIL import Image,ImageDraw
from image_documents import composite_document,smooth_warp_map
from paint_kernel import inverse_grid_kernel

if inverse_grid_kernel() is None:
    print('unbuilt')
    raise SystemExit(0)
knots=[0.,.167,.333,.666,1.]
points=[[u,v] for v in knots for u in knots]
points[6]=[.27,.319]
points[7]=[.57,.267]
points[13]=[.695,.69]
grid=dict(mode='smooth',u=knots,v=knots,points=points)
coords=np.random.default_rng(1).uniform(-.17,1.17,(40000,2))
with patch('image_documents.inverse_grid_kernel',return_value=None):
    reference=smooth_warp_map(grid,True)(coords[:,0],coords[:,1])
native=smooth_warp_map(grid,True)(coords[:,0],coords[:,1])
for a,b in zip(reference,native):
    np.testing.assert_array_equal(a,b)

with TemporaryDirectory() as tmp:
    filename=Path(tmp)/'logo.png'
    original=Image.new('RGBA',(256,176))
    ImageDraw.Draw(original).rounded_rectangle((7,10,246,166),12,fill=(42,118,199,185))
    original.save(filename)
    mask=dict(uv=True,rect=[.421,.47,.52,.53],value=0,opacity=.74)
    # This placement and recorded warp are how a linked document mask retains
    # its authored coordinates after the layer is deformed.
    identity=[1,0,0,1,0,0]
    sx=.24
    sy=.24*176/256
    layer=dict(id='logo',kind='image',opacity=.84,visible=True,blend='normal',asset='logo',
        x=.5,y=.5,scale=sx,rotation=0,stretch=[1,1],warp=grid,maskEnabled=True,maskBase=1,
        maskStrokes=[mask],maskWarpSteps=[{'from':None,'to':grid,'space':identity,
            'placement':[sx,0,0,sy,.5-sx/2,.5-sy/2]}])
    doc=dict(colorSpace='srgb',layers=[layer])
    assets={'logo':str(filename)}
    with patch('image_documents.inverse_grid_kernel',return_value=None):
        expected=composite_document(doc,assets,4096)
    actual=composite_document(doc,assets,4096)
    assert actual.tobytes()==expected.tobytes(), 'native warp changed linked-mask output'
    assert actual[1950:2220,1700:2450,3].max()>140
print('native')
`],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,OPENBLAS_NUM_THREADS:'1'}});
  if(outcome.trim()==='unbuilt')t.skip('build the native paint kernel to run parity checks');
  else assert.equal(outcome.trim(),'native');
});

test('native brush coverage is exact for ordered dabs, clipping, grains and custom tip edges',t=>{
  const outcome=execFileSync(pythonExecutable(),['-B','-c',`
from collections import OrderedDict
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import numpy as np
from PIL import Image
from image_documents import ImageSurface
from paint_kernel import brush_coverage_kernel

if brush_coverage_kernel() is None:
    print('unbuilt')
    raise SystemExit(0)
with TemporaryDirectory() as tmp:
    assets={key:str(Path(tmp)/(key+'.png')) for key in ('tip','texture')}
    rng=np.random.default_rng(1900)
    for key in assets:
        Image.fromarray(rng.integers(0,256,size=(37,53),dtype=np.uint8)).save(assets[key])
    stamps=[[.48,.48,.0],[.485,.49,.13],[.51,.51,.97],[.52,.5,.31],[.48,.49,.4]]
    common=dict(uv=True,radius=.006,hardness=.42,opacity=.73,flow=.19,spacing=.22,stamps=stamps,breaks=[4],
        clip=[.47,.475,.525,.53],polygon=[[.47,.48],[.515,.475],[.525,.53],[.48,.53]])
    tip=dict(angle=47,roundness=.63,grain=.71,scatter=.4,seed=2819457)
    modes=[None, 'size', 'both']
    tips=[None,tip,{**tip,'tipAsset':'tip'},{**tip,'tipAsset':'tip','textureAsset':'texture'}]
    def surface(size,window,live):
        value=ImageSurface(size,assets,window)
        value.live=live
        value.strokes=OrderedDict()
        value.brush_prefix=None
        return value
    for size,window,live in [(256,None,False),(512,None,False),(1024,None,False),
                             (256,(1871,1904,256),False),(512,None,True)]:
        for mode in modes:
            for t in tips:
                stroke={**common,'pressureMode':mode}
                if t:
                    stroke['tip']=t
                if live:
                    del stroke['polygon'] # Rectangle clipping alone in the live UV path
                with patch('paint_surface.brush_coverage_kernel',return_value=None):
                    expected=surface(size,window,live).stroke(stroke)
                actual=surface(size,window,live).stroke(stroke)
                for a,b in zip(actual,expected):
                    np.testing.assert_array_equal(a,b)
print('native')
`],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,OPENBLAS_NUM_THREADS:'1'}});
  if(outcome.trim()==='unbuilt')t.skip('build the native paint kernel to run brush parity checks');
  else assert.equal(outcome.trim(),'native');
});

test('sparse feathered brush masks match the full filter at canvas and preview boundaries',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
import numpy as np
from image_documents import ImageSurface, image_mask

identity=[1,0,0,1,0,0]
for size,window in [(256,None),(1024,None),(256,(0,0,256)),(256,(1904,1904,256))]:
    for base,feather in [(0.,1.5),(1.,5.5),(.43,59.75)]:
        if window:
            x,y,side=window
            left,top=x/4096,y/4096
            span=side/4096
        else:
            left,top,span=0,0,1
        x,y=left+.015*span,top+.015*span
        edits=[
            dict(uv=True,radius=.031*span,hardness=.37,opacity=.63,flow=.25,spacing=.21,
                 value=1-base,stamps=[[x,y,.44],[x+.05*span,y+.11*span,.71]]),
            dict(uv=True,rect=[left+.12*span,top+.19*span,left+.205*span,top+.253*span],
                 value=base,opacity=.74),
        ]
        if size==256 and window is None and base==.43:
            edits.append(dict(uv=True,rect=[.97,.97,1.,1.],value=0.,opacity=.5))
        layer=dict(maskBase=base, maskFeather=feather, maskStrokes=edits,maskDensity=.83)
        dense=image_mask({**layer,'maskTransform':identity},ImageSurface(size,window=window))
        sparse=image_mask(layer,ImageSurface(size,window=window))
        ids=np.arange(size*size)
        actual=sparse(ids)
        assert np.any(actual!=np.float32(1-.83*(1-base)))
        np.testing.assert_array_equal(actual,dense(ids))
        # Mask sampling during sparse color compositing may be unordered.
        np.testing.assert_array_equal(sparse(ids[::-53]),dense(ids[::-53]))
`],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,OPENBLAS_NUM_THREADS:'1'}});
});

test('sparse RGBA encoding preserves hidden RGB, faint alpha, rounding and dense tiles',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
import numpy as np
from image_documents import encode, encode_document_pixels
rng=np.random.default_rng(811)
# Cross a compositor tile boundary. RGB at zero alpha and very faint coverage
# must follow the same straight-alpha convention as a full-frame conversion.
for density in (0.,.001,.1,1.):
    pixels=rng.uniform(-.1,1.2,(262149,4)).astype(np.float32)
    pixels[:,3]=rng.random(len(pixels))
    pixels[rng.random(len(pixels))>=density,3]=0
    pixels[::107,3]=1/510
    pixels[::123,3]=.5
    for linear in (False,True):
        rgb=np.divide(pixels[:,:3],pixels[:,3:],
                      out=np.zeros_like(pixels[:,:3]),where=pixels[:,3:]>0)
        if not linear:
            rgb=encode(rgb)
        expected=np.empty(pixels.shape,dtype=np.uint8)
        expected[:,:3]=np.rint(np.clip(rgb,0,1)*255)
        expected[:,3]=np.rint(np.clip(pixels[:,3],0,1)*255)
        np.testing.assert_array_equal(encode_document_pixels(pixels,'linear' if linear else 'srgb'),expected)
    transparent=pixels.copy()
    transparent[:,3]=0
    assert not encode_document_pixels(transparent,'srgb').any()
`],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,OPENBLAS_NUM_THREADS:'1'}});
});

test('raw image preview keeps row order and buffer ownership through pipe and base64 consumers',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
import base64
from io import BytesIO
import gc
from unittest.mock import patch
import numpy as np
from paint_worker import live_pixels
from image_documents import composite_document

for size in (64,256):
    for linear in (False,True):
        doc=dict(colorSpace='linear' if linear else 'srgb',layers=[
            dict(id='ink',kind='pixel',opacity=.74,blend='normal',visible=True,
                 maskEnabled=True,maskBase=1,maskFeather=5.5,
                 maskStrokes=[dict(uv=True,rect=[0,.10,.2,.30],value=0,opacity=.65)],
                 strokes=[
                     dict(uv=True,rect=[0,.05,.3,.25],color='#e7a93d',opacity=.63,erase=False),
                     dict(uv=True,rect=[.5,.7,1.,1.],color='#3d91e7',opacity=.81,erase=False)])])
        for mask in (None,'ink'):
            cfg=dict(imageDocumentId='design',paint=dict(imageDocuments={'design':doc}),assets={},
                     liveResolution=size,imageInspectMask=mask)
            reference=composite_document(doc,{},size,mask).tobytes()
            raw=live_pixels(cfg)
            gc.collect()
            assert len(raw)==size*size*4
            assert raw.contiguous
            stream=BytesIO()
            assert stream.write(raw)==size*size*4
            assert stream.getvalue()==reference
            assert base64.b64decode(base64.b64encode(raw))==reference

# The view itself keeps the contiguous allocation alive after live_pixels
# releases its local array, including crops with strides on both axes.
source=np.arange(17*21*4,dtype=np.uint8).reshape(17,21,4)
pixels=source[::-1,::2]
expected=pixels.tobytes()
with patch('paint_worker.composite_document',return_value=pixels):
    raw=live_pixels(cfg)
del source,pixels
gc.collect()
assert bytes(raw)==expected
`],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,OPENBLAS_NUM_THREADS:'1'}});
});

test('PNG export converts the completed image once while preserving straight alpha and leaving raw numerical maps untouched',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
from io import BytesIO
import numpy as np
from PIL import Image,ImageCms
from image_documents import png_bytes
from image_color_spaces import profile_bytes
rgba=np.array([[[120,80,20,0],[8,121,239,79],[84,89,94,255]]],dtype=np.uint8)
for source,target in [('acescg','display-p3'),('display-p3','srgb'),('srgb','aces2065-1')]:
    image=Image.open(BytesIO(png_bytes(rgba,source,target)))
    if target=='srgb': assert image.info['srgb']==0 and 'icc_profile' not in image.info
    else: assert image.info['icc_profile']==profile_bytes(target)
    expected=ImageCms.profileToProfile(Image.fromarray(rgba),BytesIO(profile_bytes(source)),BytesIO(profile_bytes(target)),
                                       outputMode='RGBA',renderingIntent=1)
    np.testing.assert_array_equal(np.asarray(image),np.asarray(expected))
    np.testing.assert_array_equal(np.asarray(image)[:,:,3],rgba[:,:,3])
    assert not np.array_equal(np.asarray(image)[:,:,:3],rgba[:,:,:3])
raw=Image.open(BytesIO(png_bytes(rgba,'linear','linear')))
np.testing.assert_array_equal(np.asarray(raw),rgba)
assert raw.info['gamma']==1.0 and 'icc_profile' not in raw.info
`],{cwd:new URL('..',import.meta.url)});
});

test('grayscale layers, soft mask, placed P3 and PNG copies keep independent gray and alpha values',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
from io import BytesIO
import numpy as np
from PIL import Image,ImageCms
from image_color_spaces import image_input,profile_bytes,profiled_copy
from image_documents import composite_document,png_bytes
photo=Image.new('RGBA',(1,1),(219,45,72,79))
photo.info['icc_profile']=profile_bytes('display-p3')
for space,gamma in [('gray-g22',2.2),('gray-linear',1.)]:
    source=profile_bytes(space)
    expected=ImageCms.profileToProfile(photo.convert('RGB'),BytesIO(photo.info['icc_profile']),BytesIO(source),
                                      outputMode='L',renderingIntent=1).getpixel((0,0))
    placed,encoding=image_input(photo,space)
    assert encoding==space and placed[0,0].tolist()==[expected]*3+[79]
    stroke=dict(uv=True,rect=[0.,0.,1.,1.],opacity=1.,color='#ff0000',erase=False)
    layer=dict(id='red',kind='pixel',visible=True,opacity=.5,blend='normal',strokes=[stroke],
               maskEnabled=True,maskBase=1,maskStrokes=[dict(uv=True,rect=[0.,0.,1.,1.],value=0.,opacity=.5)])
    doc=dict(colorSpace=space,layers=[layer])
    pixels=composite_document(doc,{},8)
    gray=round(255*.2126**(1/gamma))
    assert pixels[4,4].tolist()==[gray]*3+[64],pixels[4,4]
    assert composite_document(doc,{},8,'red')[4,4].tolist()==[128]*3+[255]
    output=Image.open(BytesIO(png_bytes(pixels,space)))
    assert output.mode=='LA' and output.getpixel((4,4))==(gray,64)
    display=ImageCms.profileToProfile(output.getchannel('L'),BytesIO(source),BytesIO(profile_bytes('srgb')),outputMode='RGB',renderingIntent=1)
    for content in [png_bytes(pixels,space,'srgb'),profiled_copy(pixels,space,profile_bytes('srgb'),'RGB','relative')]:
        result=Image.open(BytesIO(content))
        assert result.getpixel((4,4))==display.getpixel((4,4))+(64,)
`],{cwd:new URL('..',import.meta.url)});
});

test('D50 Lab input and readout agree with LittleCMS across the drawing profiles',()=>{
  const reference=JSON.parse(execFileSync(pythonExecutable(),['-B','-c',`
from io import BytesIO
from PIL import Image,ImageCms
from image_color_spaces import PROFILE_FILES,GRAY_SPACES,profile_bytes
import json
rows=[]
for space in PROFILE_FILES.keys()-GRAY_SPACES:
    profile=ImageCms.ImageCmsProfile(BytesIO(profile_bytes(space)))
    lab=ImageCms.createProfile('LAB')
    # Keep the reference samples inside the 8-bit Lab representation.
    rgb=(73,162,114)
    sample=ImageCms.profileToProfile(Image.new('RGB',(1,1),rgb),profile,lab,outputMode='LAB',renderingIntent=1).getpixel((0,0))
    coords=(140,131,121)
    converted=ImageCms.profileToProfile(Image.new('LAB',(1,1),coords),lab,profile,outputMode='RGB',renderingIntent=1).getpixel((0,0))
    rows.append([space,sample,converted])
print(json.dumps(rows))`],{cwd:new URL('..',import.meta.url)}));
  for(const [space,referenceLab,referenceRGB] of reference){
    const lab=workingHexToLab('#49a272',space);
    const encoded=[lab[0]*255/100,lab[1]+128,lab[2]+128];
    encoded.forEach((n,i)=>assert.ok(Math.abs(n-referenceLab[i])<=1,space+' Lab '+encoded+' vs '+referenceLab));
    assert.deepEqual(labToWorkingHex(lab,space),{hex:'#49a272',clipped:false});
    const {hex,clipped}=labToWorkingHex([140*100/255,3,-7],space);
    assert.equal(clipped,false);
    Buffer.from(hex.slice(1),'hex').forEach((n,i)=>assert.ok(Math.abs(n-referenceRGB[i])<=1,space+' RGB '+hex+' vs '+referenceRGB));
  }
  assert.equal(labToWorkingHex([50,127,-128],'srgb').clipped,true);
});

test('D50 TIFF encodes signed Lab components and composites fractional coverage on linear-light white',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
from io import BytesIO
from pathlib import Path
import numpy as np, tempfile
from PIL import Image,ImageCms,TiffImagePlugin
from material_image_import import convert
from image_color_spaces import profiled_copy,profile_bytes
icc=Path('public/color-profiles/Lab-D50.icc').read_bytes()
raw=np.array([[[27,60,225,0],[202,40,99,128],[54,160,89,255]]],dtype=np.uint8)
im=Image.open(BytesIO(profiled_copy(raw,'linear-srgb',icc,'LAB','relative')))
matte=Image.new('RGB',(3,1));matte.putdata([(255,255,255),(228,147,177),(54,160,89)])
reference=ImageCms.profileToProfile(matte,BytesIO(profile_bytes('linear-srgb')),ImageCms.createProfile('LAB'),outputMode='LAB',renderingIntent=1)
assert im.tag_v2[262]==8 and im.info['icc_profile']==icc and im.tobytes()==reference.tobytes()
with tempfile.TemporaryDirectory() as folder:
    path=Path(folder)/'swatch.tif';out=Path(folder)/'placed.png'
    # A photometric CIELAB TIFF with no explicit white point uses D50.
    unt=Image.frombytes('LAB',im.size,im.tobytes());unt.save(path,format='TIFF')
    item=dict(source=str(path),name=path.name,destination=str(out),workingSpace='gray-g22')
    convert(item)
    target=profile_bytes('gray-g22')
    placed=Image.open(out)
    expected=ImageCms.profileToProfile(im,BytesIO(icc),BytesIO(target),outputMode='L',renderingIntent=1)
    assert placed.mode=='L' and placed.info['icc_profile']==target and placed.tobytes()==expected.tobytes()
`],{cwd:new URL('..',import.meta.url)});
});

test('packaged ACES colorants implement the published AP0 to AP1 matrix',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
import numpy as np
from io import BytesIO
from PIL import ImageCms
from image_color_spaces import profile_bytes
def colorants(space):
    p=ImageCms.ImageCmsProfile(BytesIO(profile_bytes(space))).profile
    return np.array([p.red_colorant[0],p.green_colorant[0],p.blue_colorant[0]]).T
# ACEScg specification TRA_1. ICC XYZ tags are signed 16.16 numbers.
actual=np.linalg.solve(colorants('acescg'),colorants('aces2065-1'))
expected=[[1.4514393161,-.2365107469,-.2149285693],[-.0765537734,1.1762296998,-.0996759264],
          [.0083161484,-.0060324498,.9977163014]]
np.testing.assert_allclose(actual,expected,rtol=0,atol=2e-5)
`],{cwd:new URL('..',import.meta.url)});
});

test('working RGB preserves native samples and alpha while the canvas matches the embedded PNG profile',()=>{
  const samples=JSON.parse(execFileSync(pythonExecutable(),['-B','-c',`
from io import BytesIO
from PIL import Image, ImageCms
import json, numpy as np
from image_documents import composite_document, png_bytes, read_placed_image
from image_color_spaces import decode,profile_bytes
rows=[]
for space in ('display-p3','adobe-rgb','prophoto-rgb','rec709','rec2020','rec2020-g24','dci-p3','acescg','aces2065-1','linear-srgb'):
    # Midtones, near-black transfer curves and out-of-sRGB primaries.
    pixels=np.array([[[68,119,170,161],[4,12,3,39],[145,50,99,255],[0,250,32,128],[253,226,241,192]]],np.uint8)
    data=png_bytes(pixels,space)
    with Image.open(BytesIO(data)) as im:
        assert np.array_equal(np.asarray(im),pixels)
        proof=ImageCms.profileToProfile(im,ImageCms.ImageCmsProfile(BytesIO(im.info['icc_profile'])),
            ImageCms.createProfile('sRGB'),outputMode='RGBA',renderingIntent=1)
        expected=np.asarray(proof)
        wide=np.asarray(ImageCms.profileToProfile(im,ImageCms.ImageCmsProfile(BytesIO(im.info['icc_profile'])),
            ImageCms.ImageCmsProfile(BytesIO(profile_bytes('display-p3'))),outputMode='RGBA',renderingIntent=1))
    # Place the tagged export in an sRGB document, including fractional alpha.
    actual=read_placed_image(BytesIO(data),'srgb')
    normalized=expected.astype(np.float32)/255
    np.testing.assert_allclose(actual[:,:,:3],decode(normalized[:,:,:3])*normalized[:,:,3:],atol=.005)
    np.testing.assert_array_equal(actual[:,:,3],normalized[:,:,3])
    stroke=lambda color: dict(uv=True,rect=[0,0,1,1],color=color,opacity=1,erase=False)
    def layer(key,color,opacity):
        return dict(id=key,kind='pixel',visible=True,opacity=opacity,blend='normal',maskEnabled=False,strokes=[stroke(color)])
    doc=dict(colorSpace=space,layers=[layer('base','#000000',1),layer('light','#ffffff',.5)])
    # Half-light encoded in each document's working space.
    middle={'display-p3':188,'adobe-rgb':186,'prophoto-rgb':174,'rec709':180,'rec2020':180,
            'rec2020-g24':191,'dci-p3':195,'acescg':128,'aces2065-1':128,'linear-srgb':128}[space]
    assert list(composite_document(doc,{},16)[8,8])==[middle,middle,middle,255]
    rows.append([space,pixels.flatten().tolist(),expected.flatten().tolist(),wide.flatten().tolist()])
print(json.dumps(rows))
`],{cwd:new URL('..',import.meta.url),encoding:'utf8'}));
  for(const [space,source,expected,wide] of samples){
    const display=new Uint8ClampedArray(source.length);
    for(const [target,reference] of [['srgb',expected],['display-p3',wide]]){
      writeDisplayRGB(display,source,space,false,target);
      for(let i=0;i<display.length;i++)
        assert.ok(Math.abs(display[i]-reference[i])<=(i%4===3?0:1),space+' to '+target+' '+i+' '+display[i]+' vs '+reference[i]);
    }
  }
});

test('sRGB proof warning marks wide-gamut visible colors and preserves neutral, hidden RGB and soft alpha',()=>{
  const source=Uint8Array.of(0,255,0,77, 255,255,255,255, 72,72,72,128, 0,255,0,0);
  const display=new Uint8ClampedArray(source.length),warning=display.slice();
  writeDisplayRGB(display,source,'display-p3');
  writeDisplayRGB(warning,source,'display-p3',true);
  assert.deepEqual([...warning.slice(0,4)],[255,173,54,77]);
  assert.deepEqual(warning.slice(4),display.slice(4));
  for(const space of ['linear','srgb','linear-srgb','rec709']){
    writeDisplayRGB(display,source,space);
    writeDisplayRGB(warning,source,space,true);
    assert.deepEqual(warning,display);
  }
});

test('a small off-center document thumbnail preserves opaque details and its soft mask at either canvas edge',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
import numpy as np
from image_documents import framed_composite
for x,y in [(13,4065),(4043,0)]:
    rect=lambda left,top,right,bottom:[(x+left)/4096,(y+top)/4096,(x+right)/4096,(y+bottom)/4096]
    layer=dict(id='badge',kind='pixel',opacity=1,visible=True,blend='normal',
               strokes=[dict(uv=True,rect=rect(0,0,53,31),color='#00ff00',opacity=1,erase=False)],
               maskEnabled=True,maskBase=1,maskStrokes=[dict(uv=True,rect=rect(1,0,3,31),value=0,opacity=.5)])
    doc=dict(width=53,height=31,frame=[x,y,53,31],colorSpace='display-p3',layers=[layer])
    image=framed_composite(doc,{},[53,31])
    assert image.shape==(31,53,4)
    assert image[20,1].tolist()==[0,255,0,128] and image[20,3].tolist()==[0,255,0,255]
    mask=framed_composite(doc,{},[53,31],'badge')
    np.testing.assert_array_equal(image[:,:,3],mask[:,:,0])
    assert np.all(mask[:,:,3]==255)
`],{cwd:new URL('..',import.meta.url)});
});

const cmykProfile=process.env.ARACHNE_TEST_CMYK_PROFILE||'/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc';
test('placing TIFF artwork respects its gray sample range, transparency and embedded working profile',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`import tempfile
from pathlib import Path
from PIL import Image
import numpy as np
from image_color_spaces import profile_bytes
from material_image_import import convert
with tempfile.TemporaryDirectory() as folder:
    source=Path(folder)/'原稿.tif'; dest=source.with_suffix('.png')
    args=dict(name=source.name,source=source,destination=dest,workingSpace='display-p3')
    for order in ('<','>'):
        Image.fromarray(np.array([[0,256,16384,32768,49152,65535]],dtype=order+'u2')).save(source)
        convert(args)
        with Image.open(dest) as im:
            assert list(im.getdata())==[0,1,64,128,191,255]
    photo=Image.new('RGBA',(7,3),(238,0,88,97));p3=profile_bytes('display-p3')
    photo.save(source,icc_profile=p3,compression='tiff_deflate');convert(args)
    with Image.open(dest) as im:
        assert im.mode=='RGBA' and im.info['icc_profile']==p3 and im.tobytes()==photo.tobytes()
    photo.save(source,save_all=True,append_images=[photo])
    try: convert(args)
    except ValueError as e: assert '单帧' in str(e)
    else: raise AssertionError('multipage TIFF dropped a page')
    Image.new('CMYK',(1,1)).save(source)
    try: convert(args)
    except ValueError as e: assert '缺少 ICC' in str(e)
    else: raise AssertionError('untagged ink silently assigned a printing condition')
`],{cwd:new URL('..',import.meta.url)});
});
test('a tagged CMYK photo converts directly into the working RGB space while its four ink channels are intact',
  {skip:existsSync(cmykProfile)?false:'requires a local CMYK ICC profile'},()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
from io import BytesIO
from pathlib import Path
import sys,tempfile
from PIL import Image,ImageCms
from image_color_spaces import profile_bytes
from material_image_import import convert
with tempfile.TemporaryDirectory() as folder:
    source=Path(folder)/'inks.jpg'
    colors=Image.new('CMYK',(3,1));colors.putdata([(220,100,0,20),(0,163,207,33),(0,0,0,140)])
    colors.save(source,quality=100,icc_profile=Path(sys.argv[1]).read_bytes())
    for space in ('srgb','display-p3','acescg'):
        target=profile_bytes(space);dest=Path(folder)/'converted.png'
        convert(dict(name='照片.jpeg',source=source,destination=dest,workingSpace=space))
        with Image.open(source) as im:
            proof=ImageCms.profileToProfile(im,BytesIO(im.info['icc_profile']),BytesIO(target),
                outputMode='RGB',renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
        with Image.open(dest) as out:
            assert out.info['icc_profile']==target and out.tobytes()==proof.tobytes()
`,cmykProfile],{cwd:new URL('..',import.meta.url)});
});

test('a press-profile TIFF puts transparency on white in linear light before producing four ink channels',
  {skip:existsSync(cmykProfile)?false:'requires a local CMYK ICC profile'},()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
from io import BytesIO
from pathlib import Path
import sys
import numpy as np
from PIL import Image,ImageCms
from image_color_spaces import profiled_copy,profile_bytes
target=Path(sys.argv[1]).read_bytes()
# Black at 128/255 on white gives sRGB 187. Direct mixing in encoded space would give 127.
rgba=np.array([[[12,39,78,0],[0,0,0,128],[15,155,220,255]]],np.uint8)
paper=Image.fromarray(np.array([[[255,255,255],[187,187,187],[15,155,220]]],np.uint8))
for key,intent in [('perceptual',0),('relative',1)]:
    with Image.open(BytesIO(profiled_copy(rgba,'srgb',target,'CMYK',key))) as actual:
        expected=ImageCms.profileToProfile(paper,BytesIO(profile_bytes('srgb')),BytesIO(target),outputMode='CMYK',renderingIntent=intent)
        assert actual.format=='TIFF' and actual.mode=='CMYK' and actual.size==(3,1)
        assert actual.info['icc_profile']==target and actual.tobytes()==expected.tobytes()
        def proof(options):
            settings={'space':'srgb','paper':False,**options}
            result=Image.open(BytesIO(profiled_copy(rgba,'srgb',target,'CMYK',key,settings)))
            return np.asarray(result)[:,3:,:3]
        for channel in 'CMYK':
            plate=proof({'plate':channel})
            np.testing.assert_array_equal(plate,np.repeat((255-np.asarray(expected.getchannel(channel)))[:,:,None],3,axis=2))
        total=np.asarray(expected,dtype=float).sum(axis=2)*100/255
        for limit in (0,100,400):
            warning=proof({'plate':'limit','inkLimit':limit})
            np.testing.assert_array_equal(np.all(warning==[241,113,46],axis=2),total>limit)
            assert np.all(warning[:,:,0][total<=limit]==warning[:,:,2][total<=limit])
`,cmykProfile],{cwd:new URL('..',import.meta.url)});
});

test('RGB output profile applies both intents to straight color and retains the full alpha byte',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
from io import BytesIO
import numpy as np
from PIL import Image,ImageCms
from image_color_spaces import profile_bytes,profiled_copy
rgba=np.array([[[180,130,55,0],[14,127,251,47],[204,96,64,255]]],np.uint8)
source=profile_bytes('acescg');target=profile_bytes('display-p3')
for key,intent in [('relative',1),('perceptual',0)]:
    with Image.open(BytesIO(profiled_copy(rgba,'acescg',target,'RGB',key))) as actual:
        expected=ImageCms.profileToProfile(Image.fromarray(rgba),BytesIO(source),BytesIO(target),outputMode='RGBA',renderingIntent=intent)
        assert actual.info['icc_profile']==target and actual.tobytes()==expected.tobytes()
        # This output device uses P3 itself. The right-hand proof should display
        # the RGB values delivered to it unchanged, including fully hidden RGB.
        with Image.open(BytesIO(profiled_copy(rgba,'acescg',target,'RGB',key,{'space':'display-p3','paper':False}))) as pair:
            assert pair.size==(6,1) and pair.info['icc_profile']==target
            assert pair.crop((3,0,6,1)).tobytes()==actual.tobytes()
            assert list(pair.getchannel('A').getdata())==[0,47,255]*2
`],{cwd:new URL('..',import.meta.url)});
});

test('framed linked sources and final exports match the full editing grid for odd sizes, soft masks and fractional crops',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
import numpy as np
from image_documents import document_pixels, composite_document, framed_pixels, framed_composite
ink=dict(uv=True,radius=.007,hardness=.65,color='#fb5222',opacity=.74,flow=.4,spacing=.15,erase=False,
    stamps=[[.492,.494],[.496,.498],[.502,.501],[.509,.505]])
mask=dict(uv=True,radius=.004,hardness=.5,opacity=.8,spacing=.2,value=0,stamps=[[.499,.497],[.504,.502]])
layer=dict(id='paint',kind='pixel',visible=True,opacity=.87,blend='normal',maskEnabled=True,maskBase=1,
    strokes=[ink],maskStrokes=[mask],maskFeather=4.5)
doc=dict(width=127,height=53,colorSpace='adobe-rgb',layers=[layer])
reference=composite_document(doc,{},4096)
for frame in [None,[1987.25,2026.75,106.5,69.5]]:
    if frame: doc['frame']=frame
    wanted=framed_pixels(reference,doc)
    assert 0<wanted[:,:,3].max()<255 and len(np.unique(wanted[:,:,3]))>16
    np.testing.assert_array_equal(framed_composite(doc,{},(127,53),resolution=4096),wanted)
    cached=document_pixels(doc,{},4096)
    np.testing.assert_array_equal(cached,wanted)
    assert not isinstance(cached.base,np.ndarray) or cached.base.nbytes<=cached.nbytes
`],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
});
