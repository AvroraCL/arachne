import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {pythonExecutable} from '../python-runtime.mjs';

test('smooth vertex normals control axis weights, with alpha-correct projected document colors',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
from types import SimpleNamespace
import numpy as np
from fill_projection import projected_channels
points=np.array([[.25,.25,0],[.375,.25,0],[.5,.25,0]],np.float32)
s=SimpleNamespace(owner=np.zeros(3,int),xyz=points,target_triangles=np.array([[[0,0,0],[1,0,0],[0,1,0]]]),
                  low=np.zeros(3),high=np.ones(3))
# X and Z contributions interpolate over one triangle's smooth corner normals.
shading=np.array([[[0,0,1],[1,0,0],[0,0,1]]],np.float32)
gradients=np.array([[[1,0,0],[0,1,0]]],np.float32)
geometry=shading,gradients,None,None
settings=dict(scale=1,rotation=[0,0,0],blend=1)
def read(ids,u,v):
    x_plane=v==0
    pixels=np.where(x_plane[:,None], [1.,0.,0.], [0.,1.,0.])
    return dict(color=(pixels, (~x_plane).astype(float)))
ids=np.arange(3)
# At 3:1 the grazing plane drops out, at 5:3 it contributes with
# smoothstep(.8)=.896 confidence, and at 1:1 both planes contribute equally.
for blend,alpha in [(1,[1,1/(1+.6*.896),.5]),(.5,[1,1/(1+.36*.896),.5])]:
    values,coverage=projected_channels(s,geometry,ids,{**settings,'blend':blend},['color'],read)
    np.testing.assert_allclose(coverage['color'],alpha,atol=1e-6)
    np.testing.assert_array_equal(values['color'],[[0,1,0]]*3)
`],{cwd:new URL('..',import.meta.url)});
});


test('UV gutter copies complete texels and never writes protected, overlapping or occupied atlas cells',()=>{
  execFileSync(pythonExecutable(),['-B','-c',`
from fill_projection import extend_uv_gutter
import numpy as np
shape=(7,11);owner=np.full(shape,-1,int);owner[2:5,2:4]=0;owner[2:5,7:9]=1
owner[3,5]=2
protected=np.zeros(shape,bool);protected[2,5]=True
conflict=np.zeros(shape,bool);conflict[4,5]=True
allowed=(owner>=0)&(owner!=2)
buf=np.zeros((*shape,6),np.uint8);buf[owner==0]=[15,88,232,194,127,236];buf[owner==1]=[220,99,33,61,128,236]
raw=buf.copy()
extend_uv_gutter(owner.ravel(),allowed.ravel(),protected.ravel(),conflict.ravel(),shape,1,buf.reshape(-1,6),raw.reshape(-1,6))
np.testing.assert_array_equal(buf,raw)
np.testing.assert_array_equal(buf[3,4],buf[3,3]);np.testing.assert_array_equal(buf[3,6],buf[3,7])
assert np.all(buf[2:5,5]==0) and np.all(buf[0]==0)
assert np.all(buf[owner==0]==[15,88,232,194,127,236]) and np.all(buf[owner==1]==[220,99,33,61,128,236])
`],{cwd:new URL('..',import.meta.url)});
});
