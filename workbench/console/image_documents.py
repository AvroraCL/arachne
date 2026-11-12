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
        valid = slice(None) if clip is None else surface._selection_contains(ids,clip,gradient)
        t=gradient_amount(surface,gradient,ids[valid])
        first,last=(int(ink[1:3],16)/255 for ink in gradient['colors'])
        a,b=gradient['alpha']
        result[valid]=(1-t)*(first*a+base*(1-a))+t*(last*b+base*(1-b))
    if mask is not None and len(mask[0]) and len(ids):
        affected,alpha,value=mask
        i=np.searchsorted(affected,ids);found=(i<len(affected))&(affected[np.minimum(i,len(affected)-1)]==ids)
        at=i[found];result[found]=result[found]*(1-alpha[at])+value[at]
    return result


def image_pixels(layer,assets,size,linear):
    with Image.open(assets[layer['asset']]) as im:
        raw=np.asarray(im.convert('RGBA'),dtype=np.float32)/255
    h,w=raw.shape[:2]
    if not linear:raw[:,:,:3]=decode(raw[:,:,:3])
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
    shaped = 'polygon' in gradient or 'regions' in gradient
    row0, row1, col0, col1 = surface._uv_pixel_rect(rect)
    cols = np.arange(col0, col1)
    rows_per_tile = max(1, 131072 // max(1, len(cols)))
    for start in range(row0, row1, rows_per_tile):
        rows = np.arange(start, min(start+rows_per_tile, row1))
        ids = (rows[:, None]*size + cols).ravel()
        if shaped:
            ids = ids[surface._selection_contains(ids, rect, gradient)]
        t = gradient_amount(surface,gradient,ids)[:, None]
        yield ids, first + (last-first)*t


def composite_document(document,assets,size=4096,inspect_mask=None):
    surface=ImageSurface(size);result=np.zeros((size*size,4),dtype=np.float32)
    linear=document['colorSpace']=='linear'
    def color(text):
        c=np.array(list(bytes.fromhex(text[1:])),dtype=np.float32)/255
        return c if linear else decode(c)
    for layer in document['layers']:
        if inspect_mask:
            if layer['id']==inspect_mask:
                mask=surface.mask(layer.get('maskStrokes',[]))
                for start in range(0,len(result),131072):
                    ids=np.arange(start,min(start+131072,len(result)))
                    value=mask_values(layer,mask,ids,surface)
                    result[ids,:3]=value[:,None] if linear else decode(value[:,None]);result[ids,3]=1
                break
            continue
        if not layer['visible'] or not layer['opacity']:continue
        if layer['kind']=='pixel':
            ids,paint=surface.paint([converted(s) for s in layer.get('strokes',[])],{'color':True},color)
            if 'color' not in paint:continue
            alpha,premult=paint['color'];pixels=np.column_stack((premult,alpha));ranges=[(ids,pixels)]
        elif layer['kind']=='gradient':
            ranges=gradient_tiles(surface,layer['gradient'],color)
        else:
            image_data=image_pixels(layer,assets,size,linear)
            ranges=((np.arange(start,min(start+131072,len(result))),image_data[start:start+131072]) for start in range(0,len(result),131072))
        # Mask samples are sparse and sorted, just like the reusable UV brush kernel.
        mask=surface.mask(layer.get('maskStrokes',[])) if layer['maskEnabled'] else None
        for ids,pixels in ranges:
            opacity=np.full(len(ids),layer['opacity'],dtype=np.float32)
            if layer['maskEnabled']:
                opacity*=mask_values(layer,mask,ids,surface)
            src_alpha=np.clip(pixels[:,3]*opacity,0,1);back=result[ids];back_alpha=back[:,3]
            src=np.divide(pixels[:,:3],pixels[:,3:],out=np.zeros_like(pixels[:,:3]),where=pixels[:,3:]>0)
            base=np.divide(back[:,:3],back[:,3:],out=np.zeros_like(back[:,:3]),where=back[:,3:]>0)
            mode=layer['blend']
            mixed=base*src if mode=='multiply' else base+src-base*src if mode=='screen' else np.where(base<=.5,2*base*src,1-2*(1-base)*(1-src)) if mode=='overlay' else src
            result[ids,:3]=back[:,:3]*(1-src_alpha[:,None])+src_alpha[:,None]*((1-back_alpha[:,None])*src+back_alpha[:,None]*mixed)
            result[ids,3]=src_alpha+back_alpha*(1-src_alpha)
    # Encode in tiles to keep the 4K working set bounded.
    out=np.empty((len(result),4),dtype=np.uint8)
    for start in range(0,len(result),131072):
        part=result[start:start+131072];rgb=np.divide(part[:,:3],part[:,3:],out=np.zeros_like(part[:,:3]),where=part[:,3:]>0)
        if not linear:rgb=encode(rgb)
        out[start:start+len(part),:3]=np.rint(np.clip(rgb,0,1)*255)
        out[start:start+len(part),3]=np.rint(np.clip(part[:,3],0,1)*255)
    return out.reshape(size,size,4)[::-1]


def clipboard_png(pixels, region):
    height, width = pixels.shape[:2]
    surface = ImageSurface(width)
    rect = region['rect']
    row0, row1, col0, col1 = surface._uv_pixel_rect(rect)
    cropped = pixels[height-row1:height-row0, col0:col1].copy()
    if 'polygon' in region or 'regions' in region:
        cropped[~surface._selection_tile(rect, region)[::-1]] = 0
    if not cropped.size or not cropped[:, :, 3].any():
        raise ValueError('选区内没有可复制的像素')
    return png_bytes(cropped)


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
