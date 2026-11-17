"""Profile stroke replay, or write the same fixture for browser timing.

Run from workbench/console with PYTHONPATH=. OPENBLAS_NUM_THREADS=1.
With a directory argument, write the fixture files and stop.
"""
from collections import defaultdict
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import hashlib
import json
import math
import sys
import time

from PIL import Image, ImageDraw
import image_documents
from image_documents import composite_document, exact_stroke_window
from paint_kernel import native_paint_library
from paint_surface import Surface, drawing_brush_stamps


def fixture(root):
    tip = Image.new('L',(64,64),255)
    ImageDraw.Draw(tip).ellipse((3,18,61,47),fill=0)
    tip.save(root/'tip.png')
    serial = 0

    def replay(stroke, repeat):
        nonlocal serial
        paths = []
        for n in range(repeat):
            value = deepcopy(stroke)
            value['stamps'] = [[x,y+n*.00014,p] for x,y,p in value['stamps']]
            value['hardness'] = .43+serial*.00001
            serial += 1
            paths.append(value)
        return paths

    strokes = []
    for n in range(32):
        y = .453+n*.0025
        curve = [[.455+j*.0018,y+math.sin(j*.32)*.001,.3+j*.018] for j in range(24)]
        stroke = dict(uv=True,radius=(3+n%8)/4096,opacity=.76,flow=.19,spacing=.18,
                      pressureMode='both',stamps=curve,color='#1cabd3',erase=n%7==0)
        if n%3==1:
            stroke['tip'] = dict(tipAsset='tip',angle=33,roundness=.65,grain=.5,scatter=.24,seed=211+n)
        strokes.append(stroke)
    history = [value for n in range(2) for stroke in strokes for value in replay(stroke,1+n)[-1:]]
    mask = dict(uv=True,radius=.009,opacity=.8,flow=.5,spacing=.2,
                stamps=[[.49,.448+j*.0028,1] for j in range(37)],value=0)
    return dict(history=history,masks=replay(mask,24),draft=replay(strokes[4],1)[0],
                maskDraft=replay(mask,1)[0],window=[1871,1904,256])


def measure(root):
    example = fixture(root)
    layer = dict(id='ink',kind='pixel',opacity=1,blend='normal',visible=True,
                 maskEnabled=True,maskBase=1,maskFeather=5.5,
                 strokes=[*example['history'],example['draft']],
                 maskStrokes=[*example['masks'],example['maskDraft']])
    document = dict(colorSpace='srgb',layers=[layer])
    assets = {'tip':str(root/'tip.png')}
    draft = {example[key]['hardness'] for key in ('draft','maskDraft')}
    stroke = Surface._uv_stroke
    paint = Surface._paint_strokes

    def measure_one(target):
        times = defaultdict(float)

        def coverage(surface,value,key):
            start = time.perf_counter()
            output = stroke(surface,value,key)
            label = 'current_coverage' if value.get('hardness') in draft else 'historical_coverage'
            times[label] += (time.perf_counter()-start)*1000
            return output

        def compose(*args):
            start = time.perf_counter()
            output = paint(*args)
            times['paint_blend'] += (time.perf_counter()-start)*1000
            return output

        with patch.object(Surface,'_uv_stroke',coverage),patch.object(Surface,'_paint_strokes',compose):
            start = time.perf_counter()
            out = exact_stroke_window(document,assets,example['window'],target)
            times['total'] = (time.perf_counter()-start)*1000
        times['sha256'] = hashlib.sha256(out.tobytes()).hexdigest()
        return dict(times)

    print('dabs',sum(len(list(drawing_brush_stamps(s))) for key in ('strokes','maskStrokes') for s in layer[key]))
    for target in (None,'ink'):
        print('mask' if target else 'local',json.dumps([measure_one(target) for _ in range(6)]))
    library = native_paint_library()
    print('kernel',library._name if library is not None else 'NumPy')
    full,encoded = [],[]
    encode_pixels = image_documents.encode_document_pixels

    def encode_timed(*args):
        begin = time.perf_counter()
        pixels = encode_pixels(*args)
        encoded.append((time.perf_counter()-begin)*1000)
        return pixels

    for _ in range(5):
        start = time.perf_counter()
        with patch.object(image_documents,'encode_document_pixels',encode_timed):
            pixels = composite_document(document,assets,4096)
        full.append((time.perf_counter()-start)*1000)
        digest = hashlib.sha256(pixels.tobytes()).hexdigest()
        del pixels
    print('full',json.dumps(full),digest)
    print('fullEncode',json.dumps(encoded))
    if sys.platform in ('darwin','linux'):
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        print('peakMiB',peak/(1048576 if sys.platform=='darwin' else 1024))


if __name__=='__main__':
    if len(sys.argv)>1:
        root = Path(sys.argv[1])
        (root/'brush-fixture.json').write_text(json.dumps(fixture(root)),encoding='utf-8')
    else:
        with TemporaryDirectory() as temp:
            measure(Path(temp))
