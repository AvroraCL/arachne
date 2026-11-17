import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {pythonExecutable} from '../python-runtime.mjs';
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
        np.testing.assert_array_equal(encode_document_pixels(pixels,linear),expected)
    transparent=pixels.copy()
    transparent[:,3]=0
    assert not encode_document_pixels(transparent,False).any()
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
