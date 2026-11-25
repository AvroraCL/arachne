import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {pythonExecutable} from '../python-runtime.mjs';

test('projection uses the first front-facing hit within range and the mirrored low mesh authored tangent frame',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
import tempfile
from pathlib import Path
import numpy as np
from model_glb import Model
from normal_projection import HighSurface,authored_frames,low_basis
from model_surface import surface
from paint_glb import write_glb
p=np.array([[-1,0,-1],[0,0,1],[1,0,-1]],dtype='<f4')
tangent=np.tile([0.,0.,1.,-1.],(3,1)).astype('<f4')
layers=[(0,[0,1,0]),(.2,[.6,.8,0]),(.3,[0,-1,0])]
views=[];accessors=[];data=bytearray()
def attr(array):
 a=np.array(array,dtype='<f4')
 views.append(dict(buffer=0,byteOffset=len(data),byteLength=a.nbytes)); data.extend(a.tobytes())
 accessors.append(dict(bufferView=len(views)-1,componentType=5126,count=len(a),type='VEC'+str(a.shape[1])))
 return len(accessors)-1
mesh=[dict(attributes=dict(POSITION=attr(p+[0,y,0]),NORMAL=attr([n]*3),TANGENT=attr(tangent),TEXCOORD_0=attr([[0,0],[.5,1],[1,0]]))) for y,n in layers]
scene=dict(asset=dict(version='2.0'),scene=0,scenes=[dict(nodes=[0])],nodes=[dict(mesh=0,scale=[-1,1,1])],
 meshes=[dict(primitives=mesh)],bufferViews=views,accessors=accessors,buffers=[dict(byteLength=len(data))])
with tempfile.TemporaryDirectory() as d:
 file=Path(d)/'stack.glb';write_glb(file,scene,data);model=Model(file);high=HighSurface(model)
 origins=np.array([[0,0,.4],[0,0,.15],[0,0,-.1]])
 hits,n=high.project(origins,np.tile([0,0,-1.],(3,1)),.6)
 assert hits.tolist()==[True,True,False]
 np.testing.assert_allclose(n[:2],[[-.6,0,.8],[0,0,1]],atol=1e-7)
 assert not high.project(origins[:1],np.array([[0.,0.,-1.]]),.05)[0].any()
 points,normals,_,uv,objects,polygons,_=surface(model)
 frames=authored_frames(file,(),objects,polygons)
 t,b,n=low_basis(points[:1],normals[:1],uv[:1],points[:1].mean(axis=1),frames[:1])
 np.testing.assert_allclose(t,[[0,-1,0]],atol=1e-7)
 np.testing.assert_allclose(b,[[1,0,0]],atol=1e-7)
`],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
});
