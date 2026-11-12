import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {pythonExecutable} from '../python-runtime.mjs';

test('mask blending interpolates in grayscale and post-effect paint cannot reveal protected texels',()=>{
  const script=`
from types import SimpleNamespace
from paint_worker import mask_effects, mask_coverage
import json
import numpy as np

surface = SimpleNamespace(allowed=np.array([True, True, False]),
                          low=[0,0,0], high=[1,1,1],
                          xyz=np.array([[0,0,1],[0,0,1],[0,0,1]]))
ids = np.arange(3)
def rounded(result): return result.round(3).astype(float).tolist()
curves = {}
for mode in ('replace','multiply','add','subtract','max','min'):
    result = mask_effects(np.array([.8,.4,.25]), [
        dict(kind='invert', opacity=.5, blend=mode)
    ], False, surface, ids)
    curves[mode] = rounded(result)
height = dict(kind='height', opacity=1, axis='z', center=.5, feather=.1, blend='replace')
strokes = (np.array([0,2]), np.array([1.,1.]), np.array([0.,1.]))
uv = np.zeros(3)
before = mask_coverage((None,strokes,.5,[height],False,True),surface,ids,uv,uv)
after = mask_coverage((None,strokes,.5,[height],True,True),surface,ids,uv,uv)
print(json.dumps(dict(curves=curves,before=rounded(before),after=rounded(after))))
`;
  const result=JSON.parse(execFileSync(pythonExecutable(),['-B','-X','utf8','-c',script],
    {cwd:new URL('..',import.meta.url),encoding:'utf8'}));
  assert.deepEqual(result,{
    curves:{replace:[.5,.5,.25],multiply:[.48,.32,.25],add:[.9,.7,.25],
      subtract:[.7,.2,.25],max:[.8,.5,.25],min:[.5,.4,.25]},
    before:[1,1,0],after:[0,1,0]
  });
});
