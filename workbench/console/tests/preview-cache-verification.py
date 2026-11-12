from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from material_graph import MaterialImages, PreviewImages
from paint_mask_generators import preview_generator, surface_noise


with TemporaryDirectory(prefix='arachne-preview-cache-') as temp:
    first = Path(temp) / '材质 1.png'
    second = Path(temp) / '材质 2.png'
    Image.new('RGBA', (4, 4), (12, 25, 51, 128)).save(first)
    Image.new('RGBA', (4, 4), (71, 92, 18, 192)).save(second)
    cache = PreviewImages(budget=64)
    with MaterialImages({'image': first}, preview=cache) as material:
        image = material.load('image')
    with MaterialImages({'image': first}, preview=cache) as material:
        assert material.load('image') is image
    assert not image.flags.writeable
    assert tuple(image[0, 0]) == (12, 25, 51, 128)
    cache.load(second)
    assert cache.used_bytes == 64 and len(cache.images) == 1
    assert cache.load(first) is not image
    replacement = first.with_name('替换.png')
    Image.new('RGBA', (4, 4), (31, 17, 125, 64)).save(replacement)
    replacement.replace(first)
    assert tuple(cache.load(first)[0, 0]) == (31, 17, 125, 64)
    reduced = cache.load(first, max_edge=2)
    with Image.open(first) as source:
        source = source.convert('RGBA')
        source.thumbnail((2, 2), Image.Resampling.BILINEAR)
        np.testing.assert_array_equal(reduced, np.asarray(source))
    assert cache.used_bytes <= cache.budget

xyz = np.random.default_rng(123).random((65536, 3), dtype=np.float32)
allowed = np.ones(len(xyz), dtype=bool)
allowed[::7] = False
surface = SimpleNamespace(xyz=xyz, allowed=allowed, high=xyz.max(axis=0), low=xyz.min(axis=0))
eligible = np.flatnonzero(allowed)
effect = dict(kind='surfaceNoise', scale=12, seed=9, threshold=.48, softness=.35, opacity=.7, blend='subtract')
np.testing.assert_array_equal(preview_generator(surface, eligible[:12000], effect),
                              surface_noise(surface, eligible[:12000], effect))
np.testing.assert_array_equal(preview_generator(surface, eligible[-150:], {**effect, 'opacity': .3, 'blend': 'max'}),
                              surface_noise(surface, eligible[-150:], effect))
assert len(surface.preview_generators) == 1, 'Opacity and blend must reuse the underlying generator'
next_effect = {**effect, 'seed': 34}
np.testing.assert_array_equal(preview_generator(surface, eligible[:12000], next_effect),
                              surface_noise(surface, eligible[:12000], next_effect))
assert len(surface.preview_generators) == 2, 'A changed generator parameter requires a new map'
print('PASS bounded preview caches, replaced asset invalidation and exact procedural samples')
