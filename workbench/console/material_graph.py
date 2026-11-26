"""Evaluate the validated PBR instruction plan in bounded-size linear-light tiles."""
from paint_channels import CHANNELS, DEFAULTS, RGB, SRGB
from collections import OrderedDict
from contextlib import ExitStack
import mmap
import os
import tempfile
import numpy as np
from PIL import Image
from image_color_spaces import convert_image, gray16_to_working_bytes, profile_bytes, png_source_space
from material_noise import uv_noise


def decode(c):
    return np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4)


def uv_wave(uv, scale, phase, pattern, profile):
    # Blender's Wave Texture uses radians, and a small coordinate bias at exact
    # period boundaries. Unconnected vectors in Arachne use the model's UVs.
    coords = np.asarray(uv,dtype=np.float32)*np.asarray(scale,dtype=np.float32).reshape(-1,1)
    u,v = ((coords+1e-6)*.999999).T
    if pattern == 'rings':
        angle = 20*np.hypot(u,v)
    elif pattern == 'diagonal':
        angle = 10*(u+v+1e-6*.999999)
    else:
        angle = 20*(u if pattern=='bands-x' else v)
    angle += np.asarray(phase,dtype=np.float32)
    if profile == 'sine':
        return .5-.5*np.cos(angle)
    cycles = angle/(2*np.pi)
    if profile == 'saw':
        return cycles-np.floor(cycles)
    return 2*np.abs(cycles-np.floor(cycles+.5))


def decode_image(file, mode, max_edge=None, profile=None):
    with Image.open(file) as image:
        source = None
        if profile == 'auto':
            named = png_source_space(image)
            source = profile_bytes(named) if named else image.info.get('icc_profile')
            if not source and image.info.get('gamma') == 1 and 'srgb' not in image.info:
                source = profile_bytes('linear-srgb')
        elif profile:
            source = profile_bytes(profile)
        image = gray16_to_working_bytes(image).convert(mode)
        if source:
            image = convert_image(image,source,profile_bytes('srgb'))
        if max_edge:
            image.thumbnail((max_edge, max_edge), Image.Resampling.BILINEAR)
        return np.asarray(image)


class PreviewImages:
    """Share exact decoded texels between frames of the interactive worker."""
    def __init__(self, budget=96 * 1024 * 1024, max_entries=16):
        self.images = OrderedDict()
        self.used_bytes = 0
        self.budget, self.max_entries = budget, max_entries

    def load(self, file, mode='RGBA', max_edge=None, profile=None):
        file = os.fspath(file)
        version = os.stat(file)
        identity = (file, mode, max_edge, profile)
        signature = (version.st_dev, version.st_ino, version.st_size, version.st_mtime_ns, version.st_ctime_ns)
        entry = self.images.get(identity)
        if entry is not None:
            if entry[0] == signature:
                self.images.move_to_end(identity)
                return entry[1]
            self.used_bytes -= self.images.pop(identity)[1].nbytes
        pixels = decode_image(file, mode, max_edge, profile)
        if pixels.nbytes <= self.budget:
            while self.images and (self.used_bytes + pixels.nbytes > self.budget or len(self.images) >= self.max_entries):
                self.used_bytes -= self.images.popitem(last=False)[1][1].nbytes
            self.images[identity] = signature, pixels
            self.used_bytes += pixels.nbytes
        return pixels


class MaterialImages:
    def __init__(self, assets, memory_limit=256 * 1024 * 1024, preview=None):
        self.assets = assets
        self.images = {}
        self.memory_bytes = 0
        self.memory_limit = memory_limit
        self.preview = preview
        self.spills = None

    def __enter__(self):
        self.spills = ExitStack()
        return self

    def __exit__(self, *error):
        self.images.clear()
        self.memory_bytes = 0
        self.spills.__exit__(*error)
        self.spills = None

    def load(self, asset, mode='RGBA', profile=None):
        key = (asset, mode, profile)
        if key not in self.images:
            file = self.assets[asset]
            pixels = self.preview.load(file, mode, profile=profile) if self.preview is not None else decode_image(file, mode, profile=profile)
            if self.memory_bytes + pixels.nbytes <= self.memory_limit:
                self.images[key] = pixels
                self.memory_bytes += pixels.nbytes
            elif self.spills is not None:
                # Let the OS page large material sets as individual tiles use them.
                file = self.spills.enter_context(tempfile.TemporaryFile())
                file.truncate(pixels.nbytes)
                mapping = self.spills.enter_context(mmap.mmap(file.fileno(), pixels.nbytes))
                stored = np.ndarray(pixels.shape, dtype=np.uint8, buffer=mapping)
                stored[:] = pixels
                self.images[key] = stored
            else:
                raise ValueError('材质图像超过本次合成的内存预算')
        return self.images[key]


class MaterialGraph:
    def __init__(self, plan, assets, image_cache=None):
        self.plan, self.images, self.ramps = plan, {}, {}
        if not plan:
            return
        cache = image_cache if image_cache is not None else MaterialImages(assets)
        for node in plan['nodes']:
            if node['type'] == 'image' and node['params']['asset']:
                asset = node['params']['asset']
                space = node['params'].get('colorSpace','srgb')
                profile = None if space in ('srgb','linear') else space
                self.images[node['id']] = cache.load(asset,profile=profile)
            elif node['type'] == 'ramp' and node['params'].get('stops'):
                p = node['params']
                positions = [0, *(stop['position'] for stop in p['stops']), 1]
                colors = [p['low'], *(stop['color'] for stop in p['stops']), p['high']]
                linear = decode(np.array([list(bytes.fromhex(c[1:])) for c in colors],dtype=np.float32)/255)
                self.ramps[node['id']] = np.array(positions), linear

    def evaluate(self, paint, indices, width, height, uv=None):
        if not self.plan:
            return paint
        if uv is None:
            uv = np.stack(((indices % width + .5) / width, (indices // width + .5) / height), axis=-1)
        values = {}
        def rgb(text):
            return decode(np.array(list(bytes.fromhex(text[1:])), dtype=np.float32) / 255)
        for node in self.plan['nodes']:
            p, kind, links = node['params'], node['type'], node['inputs']
            def get(key, fallback):
                link = links.get(key)
                return values[link['node']][link['port']] if link else fallback
            if kind == 'paint':
                out = {name:paint[:,part] for name,part in CHANNELS.items() if (part.stop if isinstance(part,slice) else part+1)<=paint.shape[1]}
            elif kind == 'color':
                out = dict(color=rgb(p['color']))
            elif kind == 'value':
                out = dict(value=p['value'])
            elif kind == 'reroute':
                fallback = np.zeros((len(indices), 2)) if p['dataType'] == 'vector' else np.zeros(3) if p['dataType'] == 'color' else 0.
                out = dict(output=get('input', fallback))
            elif kind == 'uv':
                out = dict(uv=uv)
            elif kind == 'mapping':
                coords = get('uv', uv) * p['scale']
                angle = p['rotation'] * np.pi / 180
                matrix = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
                out = dict(uv=coords @ matrix.T + [p['x'], p['y']])
            elif kind == 'wave':
                value = uv_wave(get('uv',uv),get('scale',p['scale']),get('phase',p['phase']),p['pattern'],p['profile'])
                out = dict(value=value,color=np.broadcast_to(value[:,None],(len(value),3)))
            elif kind == 'noise':
                out = dict(value=uv_noise(get('uv',uv),get('scale',p['scale']),p['detail'],p['roughness']))
            elif kind == 'image':
                image = self.images.get(node['id'])
                if image is None:
                    out = dict(color=np.zeros(3), alpha=0., value=0.)
                else:
                    coords = get('uv', uv)
                    h, w = image.shape[:2]
                    x, y = coords[:, 0] * w - .5, (1 - coords[:, 1]) * h - .5
                    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
                    fx, fy = (x - ix)[:, None], (y - iy)[:, None]
                    def texel(x,y):
                        result = image[y % h,x % w].astype(np.float32) / 255
                        if p.get('colorSpace','srgb') != 'linear':
                            result[:,:3] = decode(result[:,:3])
                        return result
                    pixels = (texel(ix,iy) * (1-fx) + texel(ix+1,iy) * fx) * (1-fy) + (texel(ix,iy+1) * (1-fx) + texel(ix+1,iy+1) * fx) * fy
                    out = dict(color=pixels[:, :3], alpha=pixels[:, 3], value=pixels[:, :3] @ [.2126, .7152, .0722])
            elif kind == 'separateColor':
                color = get('color', rgb(p['color']))
                out = {name:color[..., i] for i, name in enumerate(('red', 'green', 'blue'))}
            elif kind == 'combineColor':
                parts = np.broadcast_arrays(*(get(name,p[name]) for name in ('red', 'green', 'blue')))
                out = dict(color=np.stack(parts,axis=-1))
            elif kind == 'mix':
                factor = np.clip(get('factor', p['factor']), 0, 1)
                if np.ndim(factor):
                    factor = factor[:, None]
                out = dict(color=get('a', rgb(p['a'])) * (1-factor) + get('b', rgb(p['b'])) * factor)
            elif kind == 'math':
                a, b = get('a', p['a']), get('b', p['b'])
                operation = p['operation']
                if operation == 'divide':
                    a, b = np.broadcast_arrays(a, b)
                    value = np.divide(a, b, out=np.zeros_like(a, dtype=float), where=np.abs(b)>1e-12)
                else:
                    value = {'add':np.add, 'subtract':np.subtract, 'multiply':np.multiply, 'minimum':np.minimum, 'maximum':np.maximum}[operation](a, b)
                out = dict(value=value)
            elif kind == 'ramp':
                factor = np.clip(get('value', p['value']), 0, 1)
                if node['id'] in self.ramps:
                    positions, colors = self.ramps[node['id']]
                    value = np.stack([np.interp(factor,positions,channel) for channel in colors.T],axis=-1)
                else:
                    if np.ndim(factor):
                        factor = factor[:, None]
                    value = rgb(p['low']) * (1-factor) + rgb(p['high']) * factor
                out = dict(color=value)
            elif kind == 'pbr':
                surface = np.empty_like(paint)
                for name,part in CHANNELS.items():
                    if (part.stop if isinstance(part,slice) else part+1)>paint.shape[1]:continue
                    value=p.get(name,DEFAULTS[name])
                    if name in RGB:
                        value=rgb(value) if name in SRGB else np.array(list(bytes.fromhex(value[1:])),dtype=np.float32)/255
                    surface[:,part]=get(name,value)
                out = dict(surface=surface)
            elif kind == 'output':
                return np.clip(np.nan_to_num(get('surface', paint)), 0, 1)
            values[node['id']] = out
        raise ValueError('节点材质缺少输出')


def prepare_blender_images(request):
    """Stage profile-converted PNGs only for the optional Blender graph consumer."""
    import hashlib
    import json
    from pathlib import Path

    prepared, nodes = {}, {}
    for entry in json.loads(request.read_text(encoding='utf8')):
        key = (entry['asset'],entry['space'])
        if key not in prepared:
            with open(entry['file'],'rb') as source:
                if hashlib.file_digest(source,'sha256').hexdigest() != entry['asset']:
                    raise ValueError('材质图像源文件指纹变化')
                source.seek(0)
                pixels = decode_image(source,'RGBA',profile=entry['space'])
            file = request.parent / ('profiled-'+str(len(prepared))+'.png')
            Image.fromarray(pixels).save(file)
            with file.open('rb') as source:
                prepared[key] = {'file':str(file),'sha256':hashlib.file_digest(source,'sha256').hexdigest()}
        nodes[entry['id']] = prepared[key]
    (request.parent/'profiled-images.json').write_text(json.dumps(nodes),encoding='utf8')


if __name__ == '__main__':
    import sys
    from pathlib import Path
    prepare_blender_images(Path(sys.argv[1]))
