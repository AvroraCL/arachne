import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {pythonExecutable} from '../python-runtime.mjs';

test('mesh generators find convex and concave edges, keep UV seams continuous and skip protected texels',()=>{
  const script=String.raw`
from types import SimpleNamespace
import numpy as np
from paint_mask_generators import crease_angles,edge_wear,surface_noise
from paint_worker import mask_effects
tris = np.array([[[0,0,0],[1,0,0],[0,1,0]],[[1,0,0],[0,0,0],[0,0,-1]]],dtype=np.float32)
surface = SimpleNamespace(target_triangles=tris,normals=np.array([[0,0,1],[0,-1,0]],dtype=np.float32),
                          low=tris.min(axis=(0,1)),high=tris.max(axis=(0,1)),objects=np.array([0,0]),
                          owner=np.array([0,1,0,1,0]),allowed=np.array([1,1,1,0,1],dtype=bool),
                          xyz=np.array([[.4,0,0],[.4,0,0],[.4,.3,0],[.4,0,0],[.4,.06,0]],dtype=np.float32))
np.testing.assert_array_equal(crease_angles(surface),[[90,0,0],[90,0,0]])
surface.objects[1] = 1
assert not crease_angles(surface).any()
surface.objects[1] = 0
edge=dict(kind='edgeWear',edge='convex',angle=30,width=10,softness=.75,blend='multiply',opacity=1)
assert np.array_equal(edge_wear(surface,np.arange(5),edge)[:3],[1,1,0])
assert np.array_equal(mask_effects(np.full(4,.6,dtype=np.float32),[edge],True,surface,np.arange(4)),
                      np.array([.6,.6,0,0],dtype=np.float32))
tris[1,2,2]=1
surface.normals[1,1]=1
np.testing.assert_array_equal(crease_angles(surface),[[-90,0,0],[-90,0,0]])
noise=dict(kind='surfaceNoise',scale=18,threshold=.45,softness=.7,seed=10)
values=surface_noise(surface,np.arange(5),noise)
assert values[0]==values[1] and np.array_equal(values,surface_noise(surface,np.arange(5),noise))
assert not np.array_equal(values,surface_noise(surface,np.arange(5),{**noise,'seed':12}))
`;
  const result=spawnSync(pythonExecutable(),['-X','utf8','-c',script],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
