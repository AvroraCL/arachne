"""Evaluate the validated PBR instruction plan in bounded-size linear-light tiles."""
from paint_channels import CHANNELS, DEFAULTS, RGB, SRGB
import numpy as np
from PIL import Image


def decode(c):
    return np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4)


class MaterialImages:
    def __init__(self, assets):
        self.assets = assets
        self.images = {}
        self.pixel_count = 0

    def load(self, asset):
        if asset not in self.images:
            with Image.open(self.assets[asset]) as image:
                pixels = image.width * image.height
                if self.pixel_count + pixels > 64 * 1024 * 1024:
                    raise ValueError('当前可见材质的图像超过 64 Mi 像素，请缩小素材或隐藏暂时不用的图层')
                self.images[asset] = np.asarray(image.convert('RGBA'))
                self.pixel_count += pixels
        return self.images[asset]


class MaterialGraph:
    def __init__(self, plan, assets, image_cache=None):
        self.plan, self.images = plan, {}
        if not plan:
            return
        cache = image_cache if image_cache is not None else MaterialImages(assets)
        for node in plan['nodes']:
            if node['type'] == 'image' and node['params']['asset']:
                asset = node['params']['asset']
                self.images[asset] = cache.load(asset)

    def evaluate(self, paint, indices, width, height):
        if not self.plan:
            return paint
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
            elif kind == 'image':
                image = self.images.get(p['asset'])
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
                        if p.get('colorSpace','srgb') == 'srgb':
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
                if np.ndim(factor):
                    factor = factor[:, None]
                out = dict(color=rgb(p['low']) * (1-factor) + rgb(p['high']) * factor)
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
