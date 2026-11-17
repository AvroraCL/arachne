"""Run from workbench/console with PYTHONPATH=. and OPENBLAS_NUM_THREADS=1.

Arguments: scene (brush, mask, stack, stackfast, full, warp, selection,
pipe, pipe-fast, detail-pipe) and action (measure, profile or compare).
"""
import base64
import cProfile
import hashlib
import json
import pstats
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
from image_documents import composite_document, exact_stroke_window, grow_selection, path_selection, smooth_warp_map
from image_raster_tools import connected_area

mode, action = sys.argv[1:3]
tmp=tempfile.TemporaryDirectory()
root=Path(tmp.name)
def layer(id,kind,**changes):
    return dict(dict(id=id,kind=kind,opacity=1,blend='normal',visible=True,maskEnabled=False,maskBase=1),**changes)

tip=Image.new('L',(64,64),255)
ImageDraw.Draw(tip).ellipse((3,18,61,47),fill=0)
tip.save(root/'tip.png')
logo=Image.new('RGBA',(768,512))
draw=ImageDraw.Draw(logo)
draw.polygon([(24,460),(206,58),(414,58),(646,460),(524,460),(436,312),(204,312),(144,460)],fill='#178eb3')
draw.ellipse((530,98,680,248),fill='#fc8e2d')
logo.save(root/'logo.png')
assets={key:str(root/(key+'.png')) for key in ['tip','logo']}
strokes=[]
for i in range(32):
    y=.453+i*.0025
    stamps=[[.455+j*.0018,y+np.sin(j*.32)*.001,.3+j*.018] for j in range(24)]
    stroke=dict(uv=True,radius=(3+i%8)/4096,hardness=.45,opacity=.76,flow=.19,spacing=.18,
                stamps=stamps,color='#1cabd3',erase=i%7==0)
    if i%3==1:stroke['tip']=dict(tipAsset='tip',angle=33,roundness=.65,grain=.5,scatter=.24,seed=211+i)
    strokes.append(stroke)
mask=[dict(uv=True,radius=.009,hardness=.36,opacity=.8,flow=.5,spacing=.2,
    stamps=[[.49,.448+j*.0028] for j in range(37)],value=0)]
ink=layer('ink','pixel',strokes=strokes,maskEnabled=True,maskStrokes=mask,maskFeather=5.5)
doc=dict(colorSpace='srgb',layers=[ink])
knots=[0,.167,.333,.666,1]
points=[[u,v] for v in knots for u in knots]
points[6]=[.27,.319]
points[7]=[.57,.267]
points[13]=[.695,.69]
warp=dict(mode='smooth',u=knots,v=knots,points=points)
art=layer('art','image',asset='logo',x=.51,y=.48,scale=.4,rotation=12,stretch=[1,1],warp=warp,opacity=.82,
          styles=dict(outline=dict(enabled=True,color='#00ff00',width=20,position='outside')))
base=layer('base','pixel',strokes=[dict(uv=True,rect=[.29,.31,.73,.68],opacity=.74,color='#397cab',erase=False)])
clip=layer('clip','pixel',clipped=True,blend='multiply',strokes=[
    dict(uv=True,rect=[.36,.36,.59,.62],opacity=.5,color='#44d471',erase=False)])
group=layer('group','group',opacity=.8,blend='passThrough',styles=dict(shadow=dict(enabled=True,color='#0a0a0a',opacity=55,x=18,y=12,blur=12)))
mult=dict(colorSpace='srgb',layers=[base,clip,group,dict(art,parentId='group'),ink])
window=[1871,1904,256]
def serialize(out):
    if isinstance(out,tuple):return b''.join(a.tobytes() for a in out)
    if isinstance(out,bytes):return out
    return out.tobytes()
if mode=='brush': job=lambda:exact_stroke_window(doc,assets,window,None)
elif mode=='mask': job=lambda:exact_stroke_window(doc,assets,window,'ink')
elif mode=='stack': job=lambda:exact_stroke_window(mult,assets,window,None)
elif mode=='stackfast': job=lambda:composite_document(mult,assets,1024)
elif mode=='full': job=lambda:composite_document(mult,assets)
elif mode=='warp':
    prepared=smooth_warp_map(warp,True)
    ys,xs=np.mgrid[0:160,0:192]/160
    xs=np.ascontiguousarray(xs.ravel());ys=np.ascontiguousarray(ys.ravel())
    job=lambda:prepared(xs,ys)
elif mode=='selection':
    arc=np.linspace(0,2*np.pi,129)[:-1]
    radius=.32+.027*np.cos(13*arc)
    points=list(zip(.5+radius*np.cos(arc),.5+radius*np.sin(arc)))
    def job():
        selected=path_selection(points,4096,24)
        connected=connected_area(selected>120,2048,2048)
        return grow_selection(grow_selection(selected,16,True),12,False),connected
elif mode=='detail-pipe':
    cfg=dict(imageDocumentId='design',paint=dict(imageDocuments={'design':mult}),assets=assets,liveResolution=4096)
    for step in range(5):
        start=time.perf_counter()
        completed=subprocess.run([sys.executable,'-B','paint_worker.py','--live-detail'],
                                 input=json.dumps(cfg).encode(),stdout=subprocess.PIPE,check=True)
        print(step,round((time.perf_counter()-start)*1000,1),len(completed.stdout))
    sys.exit()
elif mode in ('pipe','pipe-fast'):
    cfg=dict(imageDocumentId='design',paint=dict(imageDocuments={'design':mult}),assets=assets,liveResolution=1024)
    if mode=='pipe':
        cfg['imageWindow']=window
    encoded=(json.dumps({'id':1,'config':cfg})+'\n').encode()
    start=time.perf_counter()
    child=subprocess.Popen([sys.executable,'-B','paint_worker.py','--interactive'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
    for step in range(8):
        before=time.perf_counter()
        child.stdin.write(encoded);child.stdin.flush()
        line=child.stdout.readline()
        finished=time.perf_counter()
        reply=json.loads(line)
        assert 'pixels' in reply,reply
        pixels=base64.b64decode(reply['pixels'])
        print(step,round((finished-(start if step==0 else before))*1000,1),round((time.perf_counter()-finished)*1000,1),len(line),len(pixels))
    child.stdin.close();child.wait()
    sys.exit()
else: raise ValueError(mode)
if action=='compare':
    from unittest.mock import patch
    from paint_kernel import inverse_grid_kernel
    if inverse_grid_kernel() is None:
        raise SystemExit('Build or configure the Rust library for paired measurements.')
    with patch('image_documents.inverse_grid_kernel',return_value=None):
        reference = smooth_warp_map(warp,True) if mode=='warp' else None
    samples={'numpy':[], 'rust':[]}
    digest=None
    for backend in ('numpy','rust','rust','numpy')*3:
        measured=job
        with patch('image_documents.inverse_grid_kernel',side_effect=inverse_grid_kernel if backend=='rust' else lambda:None):
            if mode=='warp' and backend=='numpy':
                measured=lambda:reference(xs,ys)
            start=time.perf_counter()
            output=measured()
            samples[backend].append(round((time.perf_counter()-start)*1000,1))
        checksum=hashlib.sha256(serialize(output)).hexdigest()
        if digest is None:
            digest=checksum
        assert digest==checksum
        del output
    print(mode,json.dumps({backend:{'cold':values[0],'warm':values[1:],'median':statistics.median(values[1:])}
                         for backend,values in samples.items()}))
elif action=='profile':
    p=cProfile.Profile()
    p.runcall(job)
    pstats.Stats(p).strip_dirs().sort_stats('cumulative').print_stats(23)
else:
    durations=[]
    for index in range(7 if mode not in ('full','selection') else 5):
        start=time.perf_counter()
        result=job()
        durations.append(round((time.perf_counter()-start)*1000,1))
        if index==0:
            digest=hashlib.sha256(serialize(result)).hexdigest()
        del result
    result=dict(cold=durations[0],warm=durations[1:],median=statistics.median(durations[1:]),hash=digest)
    if sys.platform in ('darwin','linux'):
        import resource
        rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        result['peak_mib']=round(rss/(1048576 if sys.platform=='darwin' else 1024),1)
    print(mode,json.dumps(result))
