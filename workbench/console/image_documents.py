"""Independent RGBA document compositor; shares only the UV raster/transform kernel.

No geometry, protection atlas or PBR layer state is used to edit a document.
"""
from io import BytesIO
import hashlib
import json
import struct
from collections import OrderedDict
import numpy as np
from PIL import Image, PngImagePlugin
from paint_surface import Surface
from image_adjustments import adjust_rgb, blend_rgb, neutral_adjustment
from image_raster_tools import flood_layer


def decode(c):
    return np.where(c<=.04045,c/12.92,((c+.055)/1.055)**2.4)


def encode(c):
    return np.where(c<=.0031308,c*12.92,1.055*np.maximum(c,0)**(1/2.4)-.055)


class ImageSurface(Surface):
    def __init__(self,size):
        self.uv_shape=(size,size)
        self.allowed=np.ones(size*size,dtype=bool)
        self.live=False
        self.uv_selection_cache=None


def converted(stroke):
    if 'transformUV' in stroke or 'clearUV' in stroke:
        return stroke
    return {**{k:v for k,v in stroke.items() if k!='color'},'channels':{'color':True},'values':{'color':stroke['color']}}


def mask_values(layer,mask,ids,surface):
    base=layer.get('maskBase',1)
    result=np.full(len(ids),base,dtype=np.float32)
    gradient=layer.get('maskGradient')
    if gradient is not None:
        clip=gradient.get('clip')
        coverage = None if clip is None else surface._selection_weights(ids,clip,gradient)
        valid = slice(None) if coverage is None else coverage>0
        t=gradient_amount(surface,gradient,ids[valid])
        first,last=(int(ink[1:3],16)/255 for ink in gradient['colors'])
        a,b=gradient['alpha']
        values=(1-t)*(first*a+base*(1-a))+t*(last*b+base*(1-b))
        result[valid]=values if coverage is None else base+(values-base)*coverage[valid]
    if mask is not None and len(mask[0]) and len(ids):
        affected,alpha,value=mask
        i=np.searchsorted(affected,ids);found=(i<len(affected))&(affected[np.minimum(i,len(affected)-1)]==ids)
        at=i[found];result[found]=result[found]*(1-alpha[at])+value[at]
    return result


def image_pixels(layer,assets,size,linear):
    with Image.open(assets[layer['asset']]) as im:
        raw=np.asarray(im.convert('RGBA'),dtype=np.float32)/255
        source_linear=im.info.get('gamma') == 1 and 'srgb' not in im.info
        source_srgb='srgb' in im.info
    h,w=raw.shape[:2]
    if not source_linear and (not linear or source_srgb):raw[:,:,:3]=decode(raw[:,:,:3])
    raw[:,:,:3]*=raw[:,:,3:]
    angle=np.radians(layer['rotation']);c,s=np.cos(angle),np.sin(angle)
    k=max(w,h)/size/layer['scale'];sx,sy=layer['stretch'];cx,cy=layer['x']*size,layer['y']*size
    affine=(c*k/sx,s*k/sx,w/2-(c*cx+s*cy)*k/sx,-s*k/sy,c*k/sy,h/2-(-s*cx+c*cy)*k/sy)
    return np.stack([np.asarray(Image.fromarray(raw[:,:,i]).transform((size,size),Image.Transform.AFFINE,affine,resample=Image.Resampling.BILINEAR)) for i in range(4)],axis=-1)[::-1].reshape(-1,4)


def gradient_amount(surface,gradient,ids):
    x, y = gradient['start']
    dx, dy = np.asarray(gradient['end']) - (x, y)
    length_squared = dx*dx + dy*dy
    u, v = surface._texel_uv(ids)
    if gradient['kind'] == 'radial':
        t = np.sqrt(((u-x)**2 + (v-y)**2)/length_squared)
    else:
        t = ((u-x)*dx + (v-y)*dy)/length_squared
    return np.clip(t,0,1).astype(np.float32)


def gradient_tiles(surface, gradient, color):
    size = surface.uv_shape[0]
    first, last = (np.r_[color(ink)*alpha, alpha].astype(np.float32)
                   for ink, alpha in zip(gradient['colors'], gradient['alpha']))
    rect = gradient.get('clip', (0, 0, 1, 1))
    shaped = 'polygon' in gradient or 'regions' in gradient or gradient.get('feather')
    row0, row1, col0, col1 = surface._selection_bounds(rect, gradient)
    cols = np.arange(col0, col1)
    rows_per_tile = max(1, 131072 // max(1, len(cols)))
    for start in range(row0, row1, rows_per_tile):
        rows = np.arange(start, min(start+rows_per_tile, row1))
        ids = (rows[:, None]*size + cols).ravel()
        weight = 1
        if shaped:
            coverage = surface._selection_weights(ids, rect, gradient)
            keep = coverage>0
            ids = ids[keep]
            weight = coverage[keep, None]
        t = gradient_amount(surface,gradient,ids)[:, None]
        yield ids, (first + (last-first)*t)*weight


def apply_adjustment(result, layer, surface, linear):
    params, mode = layer['adjustment'], layer['blend']
    if mode == 'normal' and neutral_adjustment(params):
        return
    masked = layer['maskEnabled']
    mask = surface.mask(layer.get('maskStrokes', [])) if masked else None
    for start in range(0, len(result), 131072):
        tile = result[start:start+131072]
        ids = np.flatnonzero(tile[:, 3] > 0) + start
        if not len(ids):
            continue
        back = result[ids]
        alpha = back[:, 3:]
        base = back[:, :3] / alpha
        encoded = not linear and params['type'] != 'exposure'
        adjusted = adjust_rgb(encode(base) if encoded else base, params)
        if encoded:
            adjusted = decode(adjusted)
        mixed = blend_rgb(base, adjusted, mode) * alpha
        opacity = layer['opacity']
        if masked:
            opacity = opacity * mask_values(layer, mask, ids, surface)[:, None]
        result[ids, :3] = back[:, :3] + (mixed - back[:, :3]) * opacity


def image_tiles(pixels):
    for start in range(0, len(pixels), 131072):
        tile = pixels[start:start+131072]
        active = np.flatnonzero(tile[:, 3] > 0)
        if len(active):
            yield active + start, tile[active]


def pixel_tiles(ids, alpha, premult):
    for start in range(0, len(ids), 131072):
        span = slice(start, start+131072)
        yield ids[span], np.column_stack((premult[span], alpha[span]))


def composite_tile(result, ids, pixels, opacity, mode, clipped=False):
    if not len(ids):
        return
    source_alpha = pixels[:, 3:]*opacity
    back = result[ids]
    back_alpha = back[:, 3:]
    if clipped or mode != 'normal':
        source = np.divide(pixels[:, :3], pixels[:, 3:], out=np.zeros_like(pixels[:, :3]), where=pixels[:, 3:]>0)
        base = np.divide(back[:, :3], back_alpha, out=np.zeros_like(back[:, :3]), where=back_alpha>0)
        mixed = blend_rgb(base, source, mode)
        if clipped:
            result[ids, :3] = back[:, :3] + (mixed*back_alpha-back[:, :3])*source_alpha
            return
        premult = source_alpha*((1-back_alpha)*source+back_alpha*mixed)
    else:
        premult = pixels[:, :3]*opacity
    result[ids, :3] = back[:, :3]*(1-source_alpha)+premult
    result[ids, 3:] = source_alpha+back_alpha*(1-source_alpha)


def composite_layer(result, layer, surface, assets, linear, color, clipped=False, group_base=False):
    if not layer['visible'] or not layer['opacity']:
        return
    if layer['kind']=='adjustment':
        apply_adjustment(result, layer, surface, linear)
        return
    if layer['kind']=='pixel':
        ids, paint = surface.paint([converted(s) for s in layer.get('strokes', [])], {'color':True}, color,
                                  raster_edit=lambda ids,paint,stroke:flood_layer(surface,ids,paint,stroke,color,None if linear else encode))
        if 'color' not in paint:
            return
        alpha, premult = paint['color']
        ranges = pixel_tiles(ids, alpha, premult)
    elif layer['kind']=='gradient':
        ranges = gradient_tiles(surface, layer['gradient'], color)
    else:
        ranges = image_tiles(image_pixels(layer, assets, surface.uv_shape[0], linear))
    mask = surface.mask(layer.get('maskStrokes', [])) if layer['maskEnabled'] else None
    for ids, pixels in ranges:
        if clipped:
            keep = result[ids, 3] > 0
            ids, pixels = ids[keep], pixels[keep]
        opacity = 1 if group_base else layer['opacity']
        if layer['maskEnabled']:
            opacity = opacity * mask_values(layer, mask, ids, surface)[:, None]
        composite_tile(result, ids, pixels, opacity, 'normal' if group_base else layer['blend'], clipped)


def composite_document(document,assets,size=4096,inspect_mask=None):
    surface=ImageSurface(size);result=np.zeros((size*size,4),dtype=np.float32)
    linear=document['colorSpace']=='linear'
    def color(text):
        c=np.array(list(bytes.fromhex(text[1:])),dtype=np.float32)/255
        return c if linear else decode(c)
    layers = document['layers']
    if inspect_mask:
        for layer in layers:
            if layer['id'] == inspect_mask:
                mask = surface.mask(layer.get('maskStrokes', []))
                for start in range(0, len(result), 131072):
                    ids = np.arange(start, min(start+131072, len(result)))
                    value = mask_values(layer, mask, ids, surface)
                    result[ids, :3] = value[:, None] if linear else decode(value[:, None])
                    result[ids, 3] = 1
                break
    else:
        index = 0
        while index < len(layers):
            base = layers[index]
            end = index+1
            while end < len(layers) and layers[end].get('clipped', False):
                end += 1
            clips = [layer for layer in layers[index+1:end] if layer['visible'] and layer['opacity']]
            index = end
            if base.get('clipped', False) or not base['visible'] or not base['opacity']:
                continue
            if not clips or base['kind'] == 'adjustment':
                composite_layer(result, base, surface, assets, linear, color)
                continue
            group = np.zeros_like(result)
            composite_layer(group, base, surface, assets, linear, color, group_base=True)
            for layer in clips:
                composite_layer(group, layer, surface, assets, linear, color, clipped=True)
            for ids, pixels in image_tiles(group):
                composite_tile(result, ids, pixels, base['opacity'], base['blend'])
            del group
    # Encode in tiles to keep the 4K working set bounded.
    out=np.empty((len(result),4),dtype=np.uint8)
    for start in range(0,len(result),131072):
        part=result[start:start+131072];rgb=np.divide(part[:,:3],part[:,3:],out=np.zeros_like(part[:,:3]),where=part[:,3:]>0)
        if not linear:rgb=encode(rgb)
        out[start:start+len(part),:3]=np.rint(np.clip(rgb,0,1)*255)
        out[start:start+len(part),3]=np.rint(np.clip(part[:,3],0,1)*255)
    return out.reshape(size,size,4)[::-1]


def clipboard_png(pixels, region, color_space):
    height, width = pixels.shape[:2]
    surface = ImageSurface(width)
    rect = region['rect']
    row0, row1, col0, col1 = surface._selection_bounds(rect, region)
    cropped = pixels[height-row1:height-row0, col0:col1].copy()
    if region.get('feather'):
        coverage = surface._feathered_selection(rect, region)[::-1]
        cropped[:, :, 3] = (cropped[:, :, 3].astype(np.uint16)*coverage+127)//255
        cropped[cropped[:, :, 3] == 0] = 0
    elif 'polygon' in region or 'regions' in region:
        cropped[~surface._selection_tile(rect, region)[::-1]] = 0
    if not cropped.size or not cropped[:, :, 3].any():
        raise ValueError('选区内没有可复制的像素')
    return png_bytes(cropped, color_space)


def png_bytes(pixels, color_space=None):
    metadata = PngImagePlugin.PngInfo()
    if color_space == 'srgb':
        metadata.add(b'sRGB', bytes([0]))
    elif color_space == 'linear':
        metadata.add(b'gAMA', struct.pack('>I', 100000))
    out = BytesIO()
    Image.fromarray(pixels).save(out, format='PNG', pnginfo=metadata, compress_level=3)
    return out.getvalue()


_cache=OrderedDict()
def document_pixels(document,assets,size):
    key=hashlib.sha256(json.dumps([document,size],sort_keys=True).encode()).hexdigest()
    if key not in _cache:
        _cache[key]=composite_document(document,assets,size)
        while len(_cache)>1:_cache.popitem(last=False)
    return _cache[key]
