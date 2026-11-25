"""Small colored, folded panel with a raised rivet outside the paint material."""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from paint_glb import write_glb


def make_panel(file, turned_tip=False):
    data = bytearray()
    views, accessors = [], []

    def attr(values, color=False):
        array = np.asarray(values, dtype='u1' if color else '<f4')
        views.append(dict(buffer=0, byteOffset=len(data), byteLength=array.nbytes))
        data.extend(array.tobytes())
        data.extend(bytes((-len(data)) % 4))
        entry = dict(bufferView=len(views)-1, componentType=5121 if color else 5126,
                     count=len(array), type='VEC'+str(array.shape[1]))
        if color:
            entry['normalized'] = True
        else:
            entry.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        accessors.append(entry)
        return len(accessors)-1

    def strip(profile, turned=False):
        positions, uv, colors = [], [], []
        for (a,h),(b,k) in zip(profile,profile[1:]):
            for x,y,z in [(a,-1,h),(b,-1,k),(b,1,k),(a,-1,h),(b,1,k),(a,1,h)]:
                positions.append((x,z,-y))
                u,v = .5+.4*x,.5+.4*y
                uv.append((1.68-u,1-v) if turned else (u,v))
                colors.append((220,36,24,255) if a < 0 else (24,180,150,255))
        return dict(attributes=dict(POSITION=attr(positions),TEXCOORD_0=attr(uv),COLOR_0=attr(colors,True)),material=0)

    panel = strip([(-1,0),(-.25,0),(0,-.25),(.25,0),(.7,0)])
    tip = strip([(.7,0),(1,0)],turned_tip)
    rivet = []
    for i in range(16):
        arc = [(math.cos(j*math.tau/16),math.sin(j*math.tau/16)) for j in (i,i+1)]
        p,q = [(-.65+.16*x,.06,-.16*y) for x,y in arc]
        rivet.extend([(-.65,.06,0),p,q])
    cap = dict(attributes=dict(POSITION=attr(rivet)),material=1)
    scene = dict(asset=dict(version='2.0'),scene=0,scenes=[dict(nodes=[0,1,2])],
                 nodes=[dict(mesh=0,name='Panel'),dict(mesh=1,name='Rivet'),dict(mesh=2,name='Tip')],
                 meshes=[dict(primitives=[panel]),dict(primitives=[cap]),dict(primitives=[tip])],
                 materials=[dict(name='Panel'),dict(name='Rivet')],accessors=accessors,
                 bufferViews=views,buffers=[dict(byteLength=len(data))])
    write_glb(file,scene,bytes(data))


def make_high(file):
    # Two inclined patches over the panel and its rotated UV island, without source UVs.
    points = []
    for center in (-.55,.85):
        for x,y in [(-1,-1),(1,-1),(1,1),(-1,-1),(1,1),(-1,1)]:
            dx,dy = .1*x,.12*y
            points.append((center+dx,.12+.4*dx+.3*dy,-dy))
    vertices = np.asarray(points,dtype='<f4')
    scene = dict(asset=dict(version='2.0'),scene=0,scenes=[dict(nodes=[0])],
                 nodes=[dict(mesh=0)],meshes=[dict(primitives=[dict(attributes={'POSITION':0})])],
                 accessors=[dict(bufferView=0,componentType=5126,count=len(vertices),type='VEC3',
                                 min=vertices.min(axis=0).tolist(),max=vertices.max(axis=0).tolist())],
                 bufferViews=[dict(buffer=0,byteLength=vertices.nbytes)],buffers=[dict(byteLength=vertices.nbytes)])
    write_glb(file,scene,vertices.tobytes())


def check(folder):
    ao, curvature, ids = [np.array(Image.open(folder/(key+'.png'))) for key in ('ao','curvature','id')]
    assert ao.shape == curvature.shape == (512,512) and ids.shape == (512,512,4)
    def sample(image,x,y=0):
        return image[int(512*(.5+.4*y)),int(512*(.5+.4*x))]
    report = dict(underRivet=int(sample(ao,-.65)),openPlate=int(sample(ao,.8,.7)),
                  convex=int(sample(curvature,-.25)),concave=int(sample(curvature,0)),
                  flat=int(sample(curvature,.8)),leftId=sample(ids,-.8).tolist(),rightId=sample(ids,.8).tolist())
    print(json.dumps(report),flush=True)
    assert report['underRivet']+100 < report['openPlate'] and report['openPlate'] >= 245
    assert report['convex'] > 165 and report['concave'] < 50 and report['flat'] == 128
    assert report['leftId'] == [220,36,24,255] and report['rightId'] == [24,180,150,255] and ids[0,0,3]==0


if __name__=='__main__':
    if sys.argv[1] in ('create','create-seam'):
        make_panel(Path(sys.argv[2]),sys.argv[1]=='create-seam')
    elif sys.argv[1]=='create-high':
        make_high(Path(sys.argv[2]))
    else:
        check(Path(sys.argv[2]))
