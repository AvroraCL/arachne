"""Independent RGBA document compositor; shares only the UV raster/transform kernel.

No geometry, protection atlas or PBR layer state is used to edit a document.
"""
from io import BytesIO
from contextlib import contextmanager
from tempfile import TemporaryFile
import math
import gzip
import hashlib
import json
import struct
from collections import OrderedDict
from itertools import groupby
import numpy as np
from PIL import Image, ImageDraw, PngImagePlugin, ImageFilter
from paint_surface import Surface, iter_strokes
from image_adjustments import adjust_rgb, blend_rgb, neutral_adjustment
from paint_text import shadow_mask, gradient_axes
from paint_kernel import inverse_grid_kernel
from image_filters import alpha_bounds, blur_gaussian, gaussian_box
from image_raster_tools import flood_layer, clone_layer, connected_area, healing_inputs


from image_color_spaces import (GRAY_SPACES, PROFILED_SPACES, convert_image, decode, encode, image_input, profile_bytes)


class ImageSurface(Surface):
    # Amortize expansion of the sparse pixel arrays when replaying many small
    # strokes. Large fills still flush promptly to bound the sampled pixels.
    paint_batch_size = 128
    paint_batch_pixels = 1024 * 1024

    def __init__(self,size,assets=None,window=None):
        self.uv_shape=(size,size)
        self.window=window
        if window:
            x,y,side=window
            self.uv_window=(4096,x,4096-y-side)
        self.nominal_size=4096 if window else size
        self.allowed=np.ones(size*size,dtype=bool)
        self.live=False
        self.uv_selection_cache=None
        self.assets=assets or {}
        self.selection_image=None
        self.brush_images={}

    def _uv_pixel_rect(self, rect):
        if not self.window:
            return super()._uv_pixel_rect(rect)
        size = self.uv_shape[0]
        raster,x,y = self.uv_window
        left,top,right,bottom = rect
        col0,col1 = (min(size,max(0,math.ceil(edge*raster-.5)-x)) for edge in (left,right))
        row0,row1 = (min(size,max(0,raster-math.ceil(edge*raster-.5)-y)) for edge in (bottom,top))
        return row0,row1,col0,col1

    def _texel_uv(self, ids):
        if not self.window:
            return super()._texel_uv(ids)
        size = self.uv_shape[0]
        raster,x,y = self.uv_window
        return (ids%size+x+.5)/raster, 1-(ids//size+y+.5)/raster

    def brush_image(self,key,tip):
        cache_key = key,tip
        if cache_key not in self.brush_images:
            with Image.open(self.assets[key]) as image:
                luminance = np.asarray(image.convert('L'),dtype=np.float32)/255
                alpha = np.asarray(image.convert('RGBA').getchannel('A'),dtype=np.float32)/255
            if tip:
                coverage = alpha if (alpha<1).any() else 1-luminance
            else:
                coverage = 1-(1-luminance)*alpha
            if len(self.brush_images) >= 8:
                self.brush_images.pop(next(iter(self.brush_images)))
            self.brush_images[cache_key] = coverage
        return self.brush_images[cache_key]

    def stroke_at(self, stroke, ids):
        if 'rect' in stroke:
            weight = self._selection_weights(ids, stroke['rect'], stroke)
            return ids[weight>0], weight[weight>0]*stroke['opacity']
        affected, weight = self.stroke(stroke)
        pos = np.searchsorted(affected, ids[0])
        if pos<len(affected) and affected[pos]==ids[0]:
            return affected[pos:pos+1], weight[pos:pos+1]
        return affected[:0], weight[:0]

    def _selection_bytes(self,rect,shape):
        if 'coverage' not in shape:
            return super()._selection_bytes(rect,shape)
        source=shape['coverage']
        if self.selection_image is None or self.selection_image[0]!=source:
            with Image.open(self.assets[source]) as image:
                if image.mode!='L' or image.size!=(4096,4096):
                    raise ValueError('选区覆盖图格式无效')
                size=self.uv_shape[0]
                if self.window:
                    x,y,side = self.window
                    image=image.crop((x,y,x+side,y+side))
                elif size!=4096:
                    image=image.resize((size,size),Image.Resampling.BOX)
                self.selection_image=source,np.asarray(image)[::-1]
        y0,y1,x0,x1=self._uv_pixel_rect(rect)
        return self.selection_image[1][y0:y1,x0:x1]


def converted(stroke):
    if 'transformUV' in stroke or 'clearUV' in stroke:
        return stroke
    return {**{k:v for k,v in stroke.items() if k!='color'},'channels':{'color':True},'values':{'color':stroke['color']}}


IDENTITY_MASK = (1,0,0,1,0,0)


def to_space(u,v,space):
    a,b,d,e,x,y = space
    determinant = a*e-b*d
    return (e*(u-x)-d*(v-y))/determinant,(-b*(u-x)+a*(v-y))/determinant


def from_space(u,v,space):
    a,b,d,e,x,y = space
    return a*u+d*v+x,b*u+e*v+y


def sparse_mask(mask, ids):
    affected,alpha,value = mask
    index = np.searchsorted(affected,ids)
    index = np.minimum(index,len(affected)-1)
    keep = affected[index]==ids
    return alpha[index]*keep,value[index]*keep


def transformed_mask(mask, ids, surface, coords):
    size = surface.uv_shape[0]
    u,v = coords
    x,y = u*size-.5,(1-v)*size-.5
    left,top = np.floor(x).astype(int),np.floor(y).astype(int)
    fx,fy = x-left,y-top
    alpha,value = (np.zeros(len(ids),dtype=np.float32) for _ in range(2))
    for row,wy in ((top,1-fy),(top+1,fy)):
        for col,wx in ((left,1-fx),(left+1,fx)):
            keep = (row>=0)&(row<size)&(col>=0)&(col<size)
            a,b = sparse_mask(mask,row[keep]*size+col[keep])
            alpha[keep] += a*wx[keep]*wy[keep]
            value[keep] += b*wx[keep]*wy[keep]
    return alpha,value


def mask_values(layer,masks,ids,surface,mapping,gradient_space):
    base=layer.get('maskBase',1)
    result=np.full(len(ids),base,dtype=np.float32)
    gradient=layer.get('maskGradient')
    if gradient is not None:
        lookup=ids
        coords=mapping(ids,gradient_space)
        if coords is not None:
            u,v=coords
            size=surface.uv_shape[0]
            lookup=np.floor((1-v)*size).astype(int)*size+np.floor(u*size).astype(int)
            inside=(u>=0)&(u<1)&(v>0)&(v<=1)
            lookup=np.where(inside,lookup,-1)
        clip=gradient.get('clip')
        coverage = None if clip is None else surface._selection_weights(lookup,clip,gradient)
        valid = slice(None) if coverage is None else coverage>0
        t=gradient_amount(surface,gradient,ids[valid],None if coords is None else tuple(axis[valid] for axis in coords))
        first,last=(int(ink[1:3],16)/255 for ink in gradient['colors'])
        a,b=gradient['alpha']
        values=(1-t)*(first*a+base*(1-a))+t*(last*b+base*(1-b))
        result[valid]=values if coverage is None else base+(values-base)*coverage[valid]
    if len(ids):
        for authored,mask in masks:
            coords=mapping(ids,authored)
            if coords is None:
                affected,alpha,value=mask
                index=np.minimum(np.searchsorted(affected,ids),len(affected)-1)
                keep=affected[index]==ids
                at=index[keep]
                result[keep]=result[keep]*(1-alpha[at])+value[at]
            else:
                alpha,value=transformed_mask(mask,ids,surface,coords)
                result=result*(1-alpha)+value
    return result


def feather_stroke_mask(mask, size, base, half, edge):
    affected, alpha, value = mask
    padding = 3 * (half + 1)
    row0 = max(0, affected[0] // size - padding)
    row1 = min(size, affected[-1] // size + padding + 1)
    col0, col1 = size, 0
    for start in range(0, len(affected), 131072):
        cols = affected[start:start+131072] % size
        col0 = min(col0, cols.min())
        col1 = max(col1, cols.max()+1)
    col0, col1 = max(0, col0-padding), min(size, col1+padding)

    # Each box pass travels half + 1 pixels along each axis. Outside the
    # padded bounds the mask stays at its original constant coverage.
    tile = np.full((row1-row0, col1-col0, 1), base, dtype=np.float32)
    for start in range(0, len(affected), 131072):
        span = slice(start, start+131072)
        rows, cols = np.divmod(affected[span], size)
        tile[rows-row0, cols-col0, 0] = np.float32(base)*(1-alpha[span])+value[span]
    blur_gaussian(tile, half, edge)
    if tile.shape[:2] == (size, size):
        return tile.ravel().__getitem__

    def sample(ids):
        rows, cols = np.divmod(ids, size)
        inside = (rows>=row0)&(rows<row1)&(cols>=col0)&(cols<col1)
        values = np.full(len(ids), base, dtype=np.float32)
        values[inside] = tile[rows[inside]-row0, cols[inside]-col0, 0]
        return values

    return sample


def image_mask(layer, surface):
    density = layer.get('maskDensity', 1)
    if not density:
        return None
    strokes = layer.get('maskStrokes', [])
    current=tuple(layer.get('maskTransform',IDENTITY_MASK))
    steps=[(step['space'],step['placement'],warp_map(step['to'],True),warp_map(step['from'],False))
           for step in layer.get('maskWarpSteps',[])]
    def space_of(edit):
        return tuple(edit.get('maskSpace',IDENTITY_MASK)),edit.get('maskWarpIndex',0)
    def mapping(ids,authored):
        space,index=authored
        if not len(ids) or index==len(steps) and current==space:
            return None
        u,v=to_space(*surface._texel_uv(ids),current)
        for frame,placement,inverse,forward in reversed(steps[index:]):
            x,y=to_space(*from_space(u,v,frame),placement)
            x,y,inside=inverse(x,y)
            inside &= (x>=-1e-9)&(x<=1+1e-9)&(y>=-1e-9)&(y<=1+1e-9)
            if np.any(inside):
                x,y,valid=forward(x[inside],y[inside])
                indices=np.flatnonzero(inside)[valid]
                u[indices],v[indices]=to_space(*from_space(x[valid],y[valid],placement),frame)
        return from_space(u,v,space)
    gradient_space=space_of(layer.get('maskGradient') or {})
    transformed = 'maskTransform' in layer or bool(steps)
    if transformed:
        groups=((space,surface.mask(list(group))) for space,group in
                groupby(iter_strokes(strokes),key=space_of))
        masks=[(space,mask) for space,mask in groups if mask is not None and len(mask[0])]
    else:
        mask=surface.mask(strokes)
        masks=[((IDENTITY_MASK,0),mask)] if mask is not None and len(mask[0]) else []
    feather = layer.get('maskFeather', 0)
    size = surface.uv_shape[0]
    if feather and (masks or layer.get('maskGradient')):
        half, edge = gaussian_box(feather*surface.nominal_size/4096)
        if not transformed and not layer.get('maskGradient'):
            sample = feather_stroke_mask(masks[0][1], size, layer.get('maskBase', 1), half, edge)
        else:
            values = np.empty(size*size, dtype=np.float32)
            for start in range(0, len(values), 131072):
                ids = np.arange(start, min(start+131072, len(values)))
                values[ids] = mask_values(layer, masks, ids, surface, mapping, gradient_space)
            blur_gaussian(values.reshape(size,size,1), half, edge)
            sample = values.__getitem__
    elif masks or layer.get('maskGradient') or layer.get('maskBase', 1) != 1:
        def sample(ids):
            return mask_values(layer, masks, ids, surface, mapping, gradient_space)
    else:
        return None
    return sample if density == 1 else lambda ids: 1-density*(1-sample(ids))


QUAD = ((0,0),(1,0),(1,1),(0,1))
MESH = tuple((i%3/2,i//3/2) for i in range(9))
MESH_TRIANGLES = ((0,1,4),(0,4,3),(1,2,5),(1,5,4),(3,4,7),(3,7,6),(4,5,8),(4,8,7))


def smooth_warp_map(warp, inverse):
    u_knots,v_knots = (np.asarray(warp[key]) for key in ('u','v'))
    points = np.asarray(warp['points']).reshape(len(v_knots),len(u_knots),2)
    if np.array_equal(points[:,:,0],np.broadcast_to(u_knots,points.shape[:2])) and\
       np.array_equal(points[:,:,1],np.broadcast_to(v_knots[:,None],points.shape[:2])):
        return warp_map(None,inverse)

    def basis(knots):
        i = np.arange(len(knots)-1)
        p,n = np.maximum(0,i-1),np.minimum(i+2,len(knots)-1)
        width = np.diff(knots)
        a = width[:,None]/(knots[i+1]-knots[p])[:,None]*np.array([0,1,-2,1])
        b = width[:,None]/(knots[n]-knots[i])[:,None]*np.array([0,0,-1,1])
        return np.stack((p,i,i+1,n),axis=-1),np.stack((-a,[1,0,-3,2]-b,[0,0,3,-2]+a,b),axis=-1)

    cols,x = basis(u_knots)
    rows,y = basis(v_knots)
    vertices = points[rows[:,None,:,None],cols[None,:,None,:]]
    coefficients = np.einsum('ikm,jln,ijmnd->ijkld',y,x,vertices,optimize=True)
    if inverse and (native := inverse_grid_kernel()) is not None:
        return native(u_knots,v_knots,coefficients)
    widths,heights = np.diff(u_knots),np.diff(v_knots)

    def evaluate(u,v):
        i = np.clip(np.searchsorted(u_knots,u,side='right')-1,0,len(widths)-1)
        j = np.clip(np.searchsorted(v_knots,v,side='right')-1,0,len(heights)-1)
        w,h = widths[i,None],heights[j,None]
        x = (u[:,None]-u_knots[i,None])/w
        y = (v[:,None]-v_knots[j,None])/h
        a,b,c,d = (coefficients[j,i,:,power] for power in range(4))
        t = x[:,None]
        rows = a+t*(b+t*(c+t*d))
        slope = b+t*(2*c+t*(3*d))
        result,du,dv = rows[:,0].copy(),slope[:,0].copy(),rows[:,1].copy()
        result += y*(rows[:,1]+y*(rows[:,2]+y*rows[:,3]))
        du += y*(slope[:,1]+y*(slope[:,2]+y*slope[:,3]))
        dv += y*(2*rows[:,2]+y*(3*rows[:,3]))
        return result,du/w,dv/h

    def project(x,y):
        if not inverse:
            point,_,_ = evaluate(x,y)
            return *point.T,np.ones(len(x),dtype=bool)
        u,v = np.clip(x,0,1),np.clip(y,0,1)
        pending = np.arange(len(x))
        good = np.zeros(len(x),dtype=bool)
        for _ in range(16):
            point,du,dv = evaluate(u[pending],v[pending])
            ex,ey = x[pending]-point[:,0],y[pending]-point[:,1]
            done = np.hypot(ex,ey)<1e-8
            good[pending[done]] = True
            determinant = du[:,0]*dv[:,1]-dv[:,0]*du[:,1]
            move = ~done&(determinant>1e-10)
            if not np.any(move):
                break
            pending = pending[move]
            step_u = (ex*dv[:,1]-ey*dv[:,0])[move]/determinant[move]
            step_v = (du[:,0]*ey-du[:,1]*ex)[move]/determinant[move]
            limit = np.maximum(1,np.maximum(abs(step_u),abs(step_v))/.125)
            u[pending] = np.clip(u[pending]+step_u/limit,-.125,1.125)
            v[pending] = np.clip(v[pending]+step_v/limit,-.125,1.125)
        return u,v,good
    return project


def warp_map(warp,inverse):
    """Map between normalized source coordinates and the deformed layer."""
    if warp is None:
        return lambda u,v: (u,v,np.ones(len(u),dtype=bool))
    if warp['mode'] == 'smooth':
        return smooth_warp_map(warp,inverse)
    points = np.asarray(warp['points'], dtype=np.float64)
    if warp['mode'] != 'mesh':
        rows, values = [], []
        for (x,y),(u,v) in zip(QUAD,points):
            rows.extend(([x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]))
            values.extend((u,v))
        matrix = np.append(np.linalg.solve(rows,values),1).reshape(3,3)
        if inverse:
            matrix = np.linalg.inv(matrix)
        def project(u,v):
            denom = matrix[2,0]*u+matrix[2,1]*v+matrix[2,2]
            good = np.abs(denom)>1e-10
            x = np.divide(matrix[0,0]*u+matrix[0,1]*v+matrix[0,2],denom,
                          out=np.full_like(u,-10),where=good)
            y = np.divide(matrix[1,0]*u+matrix[1,1]*v+matrix[1,2],denom,
                          out=np.full_like(v,-10),where=good)
            return x,y,good
        return project

    source = np.asarray(MESH)
    domain,target = (points,source) if inverse else (source,points)
    triangles = []
    for a,b,c in MESH_TRIANGLES:
        first = domain[a]
        inv = np.linalg.inv(np.column_stack((domain[b]-first,domain[c]-first)))
        triangles.append((first,inv,target[a],target[b]-target[a],target[c]-target[a]))
    def project(u,v):
        x,y = np.full_like(u,-10),np.full_like(v,-10)
        found = np.zeros(len(u),dtype=bool)
        for (px,py),inv,base,du,dv in triangles:
            a = inv[0,0]*(u-px)+inv[0,1]*(v-py)
            b = inv[1,0]*(u-px)+inv[1,1]*(v-py)
            keep = ~found & (a>=-1e-9) & (b>=-1e-9) & (a+b<=1+1e-9)
            x[keep] = base[0]+a[keep]*du[0]+b[keep]*dv[0]
            y[keep] = base[1]+a[keep]*du[1]+b[keep]*dv[1]
            found |= keep
        return x,y,found
    return project


def warp_tiles(surface,layer,width,height):
    warp = layer['warp']
    points = np.asarray(warp['points'])-.5
    if warp['mode']=='smooth':
        # Cubic Bézier derivative bounds enclose the continuous grid, including
        # overshoot between the control points.
        u,v = (np.asarray(warp[key]) for key in ('u','v'))
        domain = points.reshape(len(v),len(u),2)
        def controls(rows,knots):
            i = np.arange(len(knots)-1)
            before,after = np.maximum(0,i-1),np.minimum(i+2,len(knots)-1)
            scale = np.diff(knots)/3
            first,last = rows[i],rows[i+1]
            left = (scale/(knots[i+1]-knots[before])).reshape((-1,)+(1,)*(rows.ndim-1))
            right = (scale/(knots[after]-knots[i])).reshape((-1,)+(1,)*(rows.ndim-1))
            return np.stack((first,first+(last-rows[before])*left,last-(rows[after]-first)*right,last),axis=1)
        points = controls(controls(domain.transpose(1,0,2),u).transpose(2,0,1,3),v).reshape(-1,2)
    ratio = layer['scale']/max(width,height)
    w,h = np.array([width,height])*ratio*layer['stretch']
    angle = np.radians(layer['rotation'])
    c,s = np.cos(angle),np.sin(angle)
    cx,cy = layer['x'],layer['y']
    x,y = points[:,0]*w,points[:,1]*h
    x,y = cx+x*c-y*s,cy+x*s+y*c
    size = surface.uv_shape[0]
    bounds = np.clip((x.min()-1/size,y.min()-1/size,x.max()+1/size,y.max()+1/size),0,1)
    row0,row1,col0,col1 = surface._uv_pixel_rect(bounds)
    columns = np.arange(col0,col1)
    budget = 32768 if warp['mode']=='smooth' else 131072
    stride = max(1,budget//max(1,len(columns)))
    inverse = warp_map(warp,True)
    for start in range(row0,row1,stride):
        rows = np.arange(start,min(start+stride,row1))
        ids = (rows[:,None]*size+columns).ravel()
        u,v = surface._texel_uv(ids)
        u,v = u-cx,v-cy
        x,y,valid = inverse(.5+(c*u+s*v)/w,.5+(-s*u+c*v)/h)
        valid &= (x>=0)&(x<=1)&(y>=0)&(y<=1)
        if np.any(valid):
            yield ids[valid],x[valid],y[valid]


def warped_image_tiles(surface, layer, raw):
    height,width = raw.shape[:2]
    for ids,u,v in warp_tiles(surface,layer,width,height):
        x,y = np.clip(u*width-.5,0,width-1),np.clip(v*height-.5,0,height-1)
        x0,y0 = x.astype(int),y.astype(int)
        x1,y1 = np.minimum(x0+1,width-1),np.minimum(y0+1,height-1)
        fx,fy = (x-x0)[:,None],(y-y0)[:,None]
        pixels = (raw[y0,x0]*(1-fx)+raw[y0,x1]*fx)*(1-fy)+(raw[y1,x0]*(1-fx)+raw[y1,x1]*fx)*fy
        keep = pixels[:,3]>0
        yield ids[keep],pixels[keep].astype(np.float32)


def read_placed_image(file, space, authored=False):
    with Image.open(file) as im:
        pixels, transfer = image_input(im, space, authored=authored)
    raw = pixels.astype(np.float32)/255
    raw[..., :3] = decode(raw[..., :3], transfer)*raw[..., 3:]
    return raw


def placed_layer_pixels(layer, assets, space):
    source = layer.get('embedded')
    if source:
        return assets[(source['documentId'],source['width'],source['height'],space)]
    return read_placed_image(assets[layer['asset']],space,authored=bool(layer.get('text')))


def embedded_image_assets(layers, documents, files, space='srgb'):
    if not any(layer.get('embedded') for layer in layers):
        return files
    assets = dict(files)
    def resolve(layers, target):
        for layer in layers:
            source = layer.get('embedded')
            if not source:
                continue
            key = (source['documentId'],source['width'],source['height'],target)
            if key in assets:
                continue
            child = documents[key[0]]
            child_space = child['colorSpace']
            resolve(child['layers'],child_space)
            image = Image.fromarray(document_pixels(child,assets,4096))
            if image.size != key[1:3]:
                image = image.resize(key[1:3],Image.Resampling.BICUBIC)
            transfer = child_space
            if child_space != target and (child_space in PROFILED_SPACES or target in PROFILED_SPACES):
                source_profile = 'linear-srgb' if child_space == 'linear' else child_space
                transfer = 'linear-srgb' if target == 'linear' else target
                image = convert_image(image,profile_bytes(source_profile),profile_bytes(transfer))
            raw = np.asarray(image,dtype=np.float32)/255
            raw[..., :3] = decode(raw[..., :3],transfer)*raw[..., 3:]
            assets[key] = raw
    resolve(layers,space)
    return assets


def image_pixels(layer,assets,size,space,sample=None,window=None,raw=None):
    if raw is None:
        raw = placed_layer_pixels(layer,assets,space)
    h,w=raw.shape[:2]
    raster=4096 if window else size
    if window:
        left,top,width,*height = window
        extent = (width,height[0] if height else width)
    else:
        extent = (size,size)
    if w == h == raster and layer['rotation'] == 0 and layer['scale'] == 1 and tuple(layer['stretch']) == (1,1) and layer['x'] == layer['y'] == .5:
        if sample is not None:
            y,x = divmod(sample,size)
            return raw[size-1-y,x].reshape(1,4)
        if window:
            raw=raw[top:top+extent[1],left:left+extent[0]]
        return raw[::-1].reshape(-1,4)
    angle=np.radians(layer['rotation']);c,s=np.cos(angle),np.sin(angle)
    k=max(w,h)/raster/layer['scale'];sx,sy=layer['stretch'];cx,cy=layer['x']*raster,layer['y']*raster
    affine=(c*k/sx,s*k/sx,w/2-(c*cx+s*cy)*k/sx,-s*k/sy,c*k/sy,h/2-(-s*cx+c*cy)*k/sy)
    if sample is not None:
        row,x = divmod(sample,size)
        y = size-1-row
        a,b,c,d,e,f = affine
        affine = (a,b,c+a*x+b*y,d,e,f+d*x+e*y)
        extent = (1,1)
    if window:
        a,b,c,d,e,f = affine
        affine = (a,b,c+a*left+b*top,d,e,f+d*left+e*top)
    return np.stack([np.asarray(Image.fromarray(raw[:,:,i]).transform(extent,Image.Transform.AFFINE,affine,resample=Image.Resampling.BILINEAR)) for i in range(4)],axis=-1)[::-1].reshape(-1,4)


def raster_pixels(file, size, space, window=None):
    with Image.open(file) as image:
        box = None
        if window:
            x,y,side = window
            box = (x,y,x+side,y+side)
        pixels, transfer = image_input(image,space,box)
    def premultiply(values):
        result = values.astype(np.float32) / 255
        result[..., :3] = decode(result[..., :3],transfer)
        result[..., :3] *= result[..., 3:]
        return result
    step = len(pixels) // size
    if step == 1:
        return premultiply(pixels[::-1]).reshape(-1, 4)
    # At each lower preview resolution, bilinear sampling of the full-canvas
    # raster touches only the four pixels around each output texel center.
    center = np.arange(size) * step + step // 2
    result = np.zeros((size, size, 4), dtype=np.float32)
    for rows in (center-1, center):
        for columns in (center-1, center):
            result += premultiply(pixels[rows[:, None], columns]) * .25
    return result[::-1].reshape(-1, 4)


def repair_pixels(file, space):
    with Image.open(file) as image:
        pixels, transfer = image_input(image,space)
    return pixels, decode(np.arange(256,dtype=np.float32)/255,transfer)



def gradient_amount(surface,gradient,ids,coords=None):
    x, y = gradient['start']
    dx, dy = np.asarray(gradient['end']) - (x, y)
    length_squared = dx*dx + dy*dy
    u, v = surface._texel_uv(ids) if coords is None else coords
    if gradient['kind'] == 'radial':
        t = np.sqrt(((u-x)**2 + (v-y)**2)/length_squared)
    else:
        t = ((u-x)*dx + (v-y)*dy)/length_squared
    return np.clip(t,0,1).astype(np.float32)


def gradient_tiles(surface, gradient, color, transform=None):
    size = surface.uv_shape[0]
    first, last = (np.r_[color(ink)*alpha, alpha].astype(np.float32)
                   for ink, alpha in zip(gradient['colors'], gradient['alpha']))
    rect = gradient.get('clip', (0, 0, 1, 1))
    shaped = 'polygon' in gradient or 'regions' in gradient or 'coverage' in gradient or gradient.get('feather')
    if transform is None:
        row0, row1, col0, col1 = surface._selection_bounds(rect, gradient)
    else:
        a,b,d,e,x,y = transform
        determinant = a*e-b*d
        row0,row1,col0,col1 = 0,size,0,size
        if 'clip' in gradient:
            low,high,left,right = surface._selection_bounds(rect, gradient)
            u,v = np.meshgrid([(left-.5)/size,(right+.5)/size],[1-(high+.5)/size,1-(low-.5)/size])
            mapped_x,mapped_y = a*u+d*v+x,b*u+e*v+y
            row0,row1 = max(0,math.floor((1-mapped_y.max())*size)),min(size,math.ceil((1-mapped_y.min())*size))
            col0,col1 = max(0,math.floor(mapped_x.min()*size)),min(size,math.ceil(mapped_x.max()*size))
    if row0>=row1 or col0>=col1:
        return
    selection = None
    if transform is not None and 'clip' in gradient:
        # Work in the authored selection once, then sample its coverage from
        # the destination. Soft edges stay editable after a layout transform.
        y0,y1,x0,x1 = surface._selection_bounds(rect, gradient)
        tile = surface._feathered_selection(rect,gradient) if gradient.get('feather') else surface._selection_bytes(rect,gradient)
        selection = (y0,y1,x0,x1,tile)
    cols = np.arange(col0, col1)
    rows_per_tile = max(1, 131072 // max(1, len(cols)))
    for start in range(row0, row1, rows_per_tile):
        rows = np.arange(start, min(start+rows_per_tile, row1))
        ids = (rows[:, None]*size + cols).ravel()
        weight = 1
        coords = None
        if transform is not None:
            u,v = surface._texel_uv(ids)
            dx,dy = u-x,v-y
            u,v = coords = ((e*dx-d*dy)/determinant,(-b*dx+a*dy)/determinant)
            if selection is not None:
                y0,y1,x0,x1,tile = selection
                px,py = u*size-.5,(1-v)*size-.5
                left,top = np.floor(px).astype(int),np.floor(py).astype(int)
                fx,fy = px-left,py-top
                coverage = np.zeros(len(ids),dtype=np.float32)
                for row,wy in ((top,1-fy),(top+1,fy)):
                    for col,wx in ((left,1-fx),(left+1,fx)):
                        valid = (row>=y0)&(row<y1)&(col>=x0)&(col<x1)
                        coverage[valid] += tile[row[valid]-y0,col[valid]-x0]*wy[valid]*wx[valid]/255
                keep = coverage>0
                ids,coords,weight = ids[keep],(u[keep],v[keep]),coverage[keep,None]
        elif shaped:
            coverage = surface._selection_weights(ids, rect, gradient)
            keep = coverage>0
            ids = ids[keep]
            weight = coverage[keep, None]
        t = gradient_amount(surface,gradient,ids,coords)[:, None]
        yield ids, (first + (last-first)*t)*weight


def shape_tiles(surface, layer, color):
    shape = layer['shape']
    fill, stroke = shape['fill'], shape['stroke']
    stroke_width = shape['strokeWidth'] if stroke else 0
    if fill is None and not stroke_width:
        return
    width, height = shape['width'], shape['height']
    half_width, half_height = width/2, height/2
    scale = layer['scale']/max(width, height)
    stretch_x, stretch_y = layer['stretch']
    a, b = half_width*scale*abs(stretch_x), half_height*scale*abs(stretch_y)
    angle = np.radians(layer['rotation'])
    c, s = np.cos(angle), np.sin(angle)
    size = surface.uv_shape[0]
    horizontal = abs(c)*a+abs(s)*b+1/surface.nominal_size
    vertical = abs(s)*a+abs(c)*b+1/surface.nominal_size
    cx, cy = layer['x'], layer['y']
    bounds = (max(0, cx-horizontal), max(0, cy-vertical), min(1, cx+horizontal), min(1, cy+vertical))
    row0, row1, col0, col1 = surface._uv_pixel_rect(bounds)
    columns = np.arange(col0, col1)
    rows_per_tile = max(1, 131072//max(1, len(columns)))
    aa = max(.001, 1/(surface.nominal_size*scale*min(abs(stretch_x), abs(stretch_y))))
    radius = min(shape['cornerRadius'], half_width, half_height)
    fill_color = color(fill) if fill else np.zeros(3, dtype=np.float32)
    stroke_color = color(stroke) if stroke_width else np.zeros(3, dtype=np.float32)
    def affine_tiles():
        for start in range(row0,row1,rows_per_tile):
            rows = np.arange(start,min(start+rows_per_tile,row1))
            ids = (rows[:,None]*size+columns).ravel()
            u,v = surface._texel_uv(ids)
            u,v = u-cx,v-cy
            yield ids,(c*u+s*v)/(scale*stretch_x),(-s*u+c*v)/(scale*stretch_y)
    coordinates = ((ids,(u-.5)*width,(v-.5)*height) for ids,u,v in warp_tiles(surface,layer,width,height)) if layer.get('warp') else affine_tiles()
    for ids,x,y in coordinates:
        if shape['kind']=='rectangle':
            x, y = np.abs(x)-half_width+radius, np.abs(y)-half_height+radius
            distance = np.minimum(np.maximum(x, y), 0)+np.hypot(np.maximum(x, 0), np.maximum(y, 0))-radius
        else:
            u, v = x/half_width, y/half_height
            distance = (u*u+v*v-1)/np.maximum(2*np.hypot(u/half_width, v/half_height), 1e-8)
        outer = np.clip(.5-distance/aa, 0, 1).astype(np.float32)
        inner = np.clip(.5-(distance+stroke_width)/aa, 0, 1).astype(np.float32) if stroke_width else outer
        outline = outer-inner
        interior = inner if fill is not None else 0
        alpha = outline+interior
        keep = alpha > 0
        premult = fill_color*np.asarray(interior)[..., None]+stroke_color*outline[:, None]
        yield ids[keep], np.column_stack((premult[keep], alpha[keep]))


def apply_adjustment(result, layer, surface, space, clipped=False):
    params, mode = layer['adjustment'], layer['blend']
    if params['type'] in ('gaussianBlur', 'unsharpMask'):
        apply_spatial_filter(result, layer, surface, space, clipped)
        return
    if mode == 'normal' and neutral_adjustment(params):
        return
    mask = image_mask(layer, surface) if layer['maskEnabled'] else None
    for start in range(0, len(result), 131072):
        tile = result[start:start+131072]
        ids = np.flatnonzero(tile[:, 3] > 0) + start
        if not len(ids):
            continue
        back = result[ids]
        alpha = back[:, 3:]
        base = back[:, :3] / alpha
        encoded = space != 'linear' and params['type'] != 'exposure'
        adjusted = adjust_rgb(encode(base,space) if encoded else base, params)
        if encoded:
            adjusted = decode(adjusted,space)
        mixed = blend_rgb(base, adjusted, mode) * alpha
        opacity = layer['opacity']
        if mask is not None:
            coverage = mask(ids)
            if layer.get('edgeDecontaminate'):
                pixels = clean_edge_colors(pixels.copy(),coverage,layer['edgeDecontaminate'],color)
            opacity = opacity * coverage[:,None]
        result[ids, :3] = back[:, :3] + (mixed - back[:, :3]) * opacity


def sharpen_tile(back, blurred, params, space, mode):
    alpha, blurred_alpha = back[:, :, 3:], blurred[:, :, 3:]
    base = np.divide(back[:, :, :3], alpha, out=np.zeros_like(back[:, :, :3]), where=alpha > 0)
    low = np.divide(blurred[:, :, :3], blurred_alpha, out=base.copy(), where=blurred_alpha > 0)
    signal, smooth = encode(base,space), encode(low,space)
    detail = signal - smooth
    if params['threshold']:
        detail *= np.max(np.abs(detail), axis=2, keepdims=True) >= params['threshold'] / 255
    sharpened = np.clip(signal + detail * (params['amount'] / 100), 0, 1)
    color = decode(sharpened,space)
    blurred[:, :, :3] = blend_rgb(base, color, mode) * alpha if mode != 'normal' else color * alpha
    blurred[:, :, 3:] = alpha


def apply_spatial_filter(result, layer, surface, space, clipped):
    params = layer['adjustment']
    sharpen = params['type'] == 'unsharpMask'
    height, width = surface.uv_shape
    radius = params['radius'] * width / 4096
    if radius <= 0 or sharpen and (params['amount'] == 0 or params['threshold'] == 255):
        return
    half, edge = gaussian_box(radius)
    canvas = result.reshape(height, width, 4)
    bounds = alpha_bounds(canvas[:, :, 3], 3 * (half + 1))
    if bounds is None:
        return
    top, bottom, left, right = bounds
    source = canvas[top:bottom, left:right]
    opacity, mode = layer['opacity'], layer['blend']
    mask = image_mask(layer, surface) if layer['maskEnabled'] else None
    columns = np.arange(left, right)
    with composite_buffer(source, 1) as filtered:
        filtered[:] = source
        blur_gaussian(filtered, half, edge)
        for start in range(0, len(source), 32):
            back = source[start:start + 32]
            pixels = filtered[start:start + 32]
            amount = opacity
            if mask is not None:
                rows = np.arange(top + start, top + start + len(back))
                ids = (rows[:, None] * width + columns).ravel()
                amount = opacity * mask(ids).reshape(*back.shape[:2], 1)
            if sharpen:
                sharpen_tile(back, pixels, params, space, mode)
            elif clipped or mode != 'normal':
                back_alpha, alpha = back[:, :, 3:], pixels[:, :, 3:]
                base = np.divide(back[:, :, :3], back_alpha, out=np.zeros_like(back[:, :, :3]), where=back_alpha > 0)
                color = np.divide(pixels[:, :, :3], alpha, out=base.copy(), where=alpha > 0)
                if mode != 'normal':
                    color += back_alpha * (blend_rgb(base, color, mode) - color)
                if clipped:
                    alpha[:] = back_alpha
                pixels[:, :, :3] = color * alpha
            back += (pixels - back) * amount


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


def point_tiles(tiles, sample):
    for ids, pixels in tiles:
        if len(ids) and ids[0] <= sample <= ids[-1]:
            pos = np.searchsorted(ids, sample)
            if ids[pos] == sample:
                yield ids[pos:pos+1], pixels[pos:pos+1]
                return


def tone_coverage(pixels, stops, space):
    if stops == [0,0,255,255]:
        return 1
    alpha = pixels[:,3:]
    rgb = np.divide(pixels[:,:3],alpha,out=np.zeros_like(pixels[:,:3]),where=alpha>0)
    if space != 'linear':
        rgb = encode(rgb,space)
    gray = (.2126*rgb[:,0]+.7152*rgb[:,1]+.0722*rgb[:,2])*255
    low,full_low,full_high,high = stops
    dark = np.clip((gray-low)/(full_low-low),0,1) if full_low>low else gray>=low
    light = np.clip((high-gray)/(high-full_high),0,1) if high>full_high else gray<=high
    return np.minimum(dark,light)[:,None]


def composite_tile(result, ids, pixels, opacity, mode, clipped=False, blend_if=None, space='srgb', sample=None):
    if not len(ids):
        return
    back = result[ids]
    back_alpha = back[:, 3:]
    if blend_if:
        source = tone_coverage(pixels,blend_if['source'],space)
        backdrop = tone_coverage(back,blend_if['backdrop'],space)
        opacity = opacity * source * (1-back_alpha+back_alpha*backdrop)
    source_alpha = pixels[:, 3:]*opacity
    coverage = None
    if sample is not None and ids[0] <= sample <= ids[-1]:
        pos = np.searchsorted(ids, sample)
        if ids[pos] == sample:
            coverage = float(source_alpha[pos,0])
    if clipped or mode != 'normal':
        source = np.divide(pixels[:, :3], pixels[:, 3:], out=np.zeros_like(pixels[:, :3]), where=pixels[:, 3:]>0)
        base = np.divide(back[:, :3], back_alpha, out=np.zeros_like(back[:, :3]), where=back_alpha>0)
        mixed = blend_rgb(base, source, mode)
        if clipped:
            result[ids, :3] = back[:, :3] + (mixed*back_alpha-back[:, :3])*source_alpha
            return coverage
        premult = source_alpha*((1-back_alpha)*source+back_alpha*mixed)
    else:
        premult = pixels[:, :3]*opacity
    result[ids, :3] = back[:, :3]*(1-source_alpha)+premult
    result[ids, 3:] = source_alpha+back_alpha*(1-source_alpha)
    return coverage


def styled_tiles(buffer, surface, styles, color):
    size = surface.uv_shape[0]
    active = {key:value for key,value in styles.items() if value['enabled']}
    outline, shadow = active.get('outline'), active.get('shadow')
    scale = surface.nominal_size/4096
    width = outline['width']*scale if outline else 0
    padding = math.ceil(width + (max(abs(shadow['x']),abs(shadow['y']))+3*shadow['blur'])*scale) if shadow else math.ceil(width)
    alpha = buffer[:,3].reshape(size,size)
    bounds = alpha_bounds(alpha,0)
    if bounds is None:
        return
    top,bottom,left,right = bounds
    y0,y1 = max(0,top-padding),min(size,bottom+padding)
    x0,x1 = max(0,left-padding),min(size,right+padding)
    crop = alpha[y0:y1,x0:x1]
    # Keep morphology in 8-bit mask space. Layer content remains premultiplied
    # float, including subpixel alpha at opaque and antialiased edges.
    mask = np.rint(crop*255).astype(np.uint8)
    inner,outer = (width,0) if outline and outline['position']=='inside' else (0,width)
    if outline and outline['position']=='center':
        inner = outer = width/2
    def edge(radius,expand):
        steps = int(radius)
        near = grow_selection(mask,steps,expand) if steps else mask
        fraction = radius-steps
        if not fraction:
            return near
        far = grow_selection(mask,steps+1,expand)
        return np.rint(near*(1-fraction)+far*fraction).astype(np.uint8)
    eroded = edge(inner,False) if inner else None
    expanded = edge(outer,True) if outer else None
    shade = None
    if shadow:
        shade = np.asarray(shadow_mask(Image.fromarray(expanded if expanded is not None else mask),
                          (round(shadow['x']*scale),-round(shadow['y']*scale)),shadow['blur']*scale))
    tint = color(active['overlay']['color']) if 'overlay' in active else None
    edge_color = color(outline['color']) if outline else None
    shade_color = color(shadow['color']) if shadow else None
    xs = np.arange(x0,x1)
    gradient = active.get('gradient')
    if gradient:
        gx,gy = gradient_axes(xs,np.arange(-y0,-y1,-1),(left,1-bottom,right,1-top),gradient['angle'])
        start,end = color(gradient['start']),color(gradient['end'])
    for start_y in range(y0,y1,max(1,131072//len(xs))):
        end_y = min(y1,start_y+max(1,131072//len(xs)))
        ids = np.arange(start_y,end_y)[:,None]*size+xs
        pixels = buffer[ids]
        a = pixels[:,:,3]
        region = slice(start_y-y0,end_y-y0)
        if gradient:
            mix = np.clip(.5+gy[region,None]+gx[None,:],0,1)
            pixels[:,:,:3] = (start+mix[:,:,None]*(end-start))*a[:,:,None]
        elif tint is not None:
            pixels[:,:,:3] = tint*a[:,:,None]
        if eroded is not None:
            delta = np.clip((mask[region].astype(np.float32)-eroded[region])/255,0,a)
            amount = np.divide(delta,a,out=np.zeros_like(delta),where=a>0)
            pixels[:,:,:3] += edge_color*delta[:,:,None]-pixels[:,:,:3]*amount[:,:,None]
        if expanded is not None:
            delta = np.minimum((expanded[region].astype(np.float32)-mask[region])/255,1-a)
            pixels[:,:,:3] += delta[:,:,None]*edge_color
            a += delta
        if shade is not None:
            delta = shade[region]*(shadow['opacity']/25500)*(1-a)
            pixels[:,:,:3] += delta[:,:,None]*shade_color
            a += delta
        keep = a > 0
        if keep.any():
            yield ids[keep],pixels[keep]


def clean_edge_colors(pixels, coverage, treatment, color):
    coverage = coverage[:,None]
    weight = np.clip((coverage-.02)/.12,0,1)*(coverage<.999)*treatment['amount']
    alpha = pixels[:,3:]
    background = color(treatment['color'])
    cleaned = np.clip((pixels[:,:3]-alpha*background*(1-coverage))/np.maximum(.02,coverage),0,alpha)
    pixels[:,:3] += (cleaned-pixels[:,:3])*weight
    return pixels


def composite_layer(result, layer, surface, assets, space, color, clipped=False, group_base=False, pick=None):
    if not layer['visible'] or not layer['opacity']:
        return
    if layer['kind']=='adjustment':
        apply_adjustment(result, layer, surface, space, clipped)
        return
    styles = layer.get('styles',{})
    styled = any(value['enabled'] for value in styles.values())
    if layer['kind']=='pixel':
        snapshots = {}
        def raster_edit(ids, paint, stroke):
            if 'clone' in stroke:
                spec = stroke['clone']
                repair = bool(spec.get('kind'))
                sources = [(spec[key],repair) if spec.get(key) else None for key in ('asset','backdrop')]
                for key in list(snapshots):
                    if key not in sources:
                        del snapshots[key]
                for key in sources:
                    if key and key not in snapshots:
                        file = assets[key[0]]
                        snapshots[key] = repair_pixels(file,space) if repair else raster_pixels(file,surface.uv_shape[0],space)
                source,backdrop = (snapshots.get(key) for key in sources)
                healing = healing_inputs(surface,stroke,source,backdrop) if repair else None
                return clone_layer(surface, ids, paint, stroke, source, healing)
            return flood_layer(surface, ids, paint, stroke, color, None if space=='linear' else lambda rgb: encode(rgb,space))
        strokes = layer.get('strokes', [])
        backing = None
        sampler = None
        if pick and pick[2] and not styled and not layer.get('raster'):
            strokes = list(iter_strokes(strokes))
            if not any('transformUV' in stroke or 'flood' in stroke or 'clone' in stroke for stroke in strokes):
                sample_ids = np.array([pick[0]], dtype=np.int32)
                sampler = lambda stroke: surface.stroke_at(stroke,sample_ids)
        if layer.get('raster'):
            backing = raster_pixels(assets[layer['raster']], surface.uv_shape[0], space, surface.window)
        if backing is not None and not strokes:
            ranges = image_tiles(backing)
        else:
            initial = None
            if backing is not None:
                ids = np.flatnonzero(backing[:, 3]).astype(np.int32)
                initial = ids, {'color': (backing[ids, 3], backing[ids, :3])}
                del backing
            ids, paint = surface.paint(strokes, {'color':True}, color, sampler=sampler, raster_edit=raster_edit,
                                       convert=converted, initial=initial)
            if 'color' not in paint:
                return
            alpha, premult = paint['color']
            ranges = pixel_tiles(ids, alpha, premult)
    elif layer['kind']=='gradient':
        ranges = gradient_tiles(surface, layer['gradient'], color, layer.get('gradientTransform'))
    elif layer['kind']=='shape':
        ranges = shape_tiles(surface, layer, color)
    elif layer.get('warp'):
        ranges = warped_image_tiles(surface,layer,placed_layer_pixels(layer,assets,space))
    elif pick and pick[2] and not styled:
        ranges = [(np.array([pick[0]]),image_pixels(layer,assets,surface.uv_shape[0],space,pick[0]))]
    else:
        ranges = image_tiles(image_pixels(layer, assets, surface.uv_shape[0], space, window=surface.window))
    mask = image_mask(layer, surface) if layer['maskEnabled'] else None
    treatment = layer.get('edgeDecontaminate')
    if styled:
        with composite_buffer(result, 1) as buffer:
            for ids,pixels in ranges:
                coverage = mask(ids) if mask is not None else None
                if coverage is not None and treatment:
                    pixels = clean_edge_colors(pixels.copy(),coverage,treatment,color)
                buffer[ids] = pixels if coverage is None else pixels*coverage[:,None]
            tiles = styled_tiles(buffer,surface,styles,color)
            blend_image_tiles(result,layer,tiles,None,space,clipped,group_base,pick)
    else:
        blend_image_tiles(result,layer,ranges,mask,space,clipped,group_base,pick,color)


def blend_image_tiles(result, layer, ranges, mask, space, clipped=False, group_base=False, pick=None, color=None):
    if pick and pick[2]:
        ranges = point_tiles(ranges, pick[0])
    for ids, pixels in ranges:
        if clipped:
            keep = result[ids, 3] > 0
            ids, pixels = ids[keep], pixels[keep]
        opacity = 1 if group_base else layer['opacity']
        if mask is not None:
            coverage = mask(ids)
            if layer.get('edgeDecontaminate'):
                pixels = clean_edge_colors(pixels.copy(),coverage,layer['edgeDecontaminate'],color)
            opacity = opacity * coverage[:,None]
        coverage = composite_tile(result, ids, pixels, opacity, 'normal' if group_base else layer['blend'], clipped,
                                  None if group_base else layer.get('blendIf'), space, pick[0] if pick else None)
        if coverage:
            pick[1].append((layer['id'],coverage))


@contextmanager
def composite_buffer(result, depth):
    # A single temporary 4K buffer stays in memory. Nested groups and clipping
    # stacks use OS-paged scratch files so deep edits don't multiply peak RAM.
    if depth and result.nbytes >= 128 * 1024 * 1024:
        with TemporaryFile() as file:
            buffer = np.memmap(file, dtype=result.dtype, mode='w+', shape=result.shape)
            try:
                yield buffer
            finally:
                buffer._mmap.close()
    else:
        yield np.zeros_like(result)


def composite_stack(result, children, surface, assets, space, color, parent=None, depth=0, pick=None):
    layers = children.get(parent, [])
    index = 0
    while index < len(layers):
        base = layers[index]
        end = index + 1
        while end < len(layers) and layers[end].get('clipped', False):
            end += 1
        clips = [layer for layer in layers[index+1:end] if layer['visible'] and layer['opacity']]
        index = end
        if base.get('clipped', False) or not base['visible'] or not base['opacity']:
            continue
        if base['kind'] == 'group':
            opacity = base['opacity']
            mask = image_mask(base, surface) if base['maskEnabled'] else None
            styles = base.get('styles',{})
            styled = any(value['enabled'] for value in styles.values())
            pass_through = base['blend'] == 'passThrough' and not styled
            if pass_through and opacity == 1 and mask is None:
                composite_stack(result, children, surface, assets, space, color, base['id'], depth, pick)
                continue
            group_pick = (pick[0],[],pick[2] and not styled) if pick else None
            with composite_buffer(result, depth) as buffer:
                if pass_through:
                    buffer[:] = result
                composite_stack(buffer, children, surface, assets, space, color, base['id'], depth + 1, group_pick)
                if pass_through:
                    spans = (np.arange(start, min(start + 131072, len(result))) for start in range(0,len(result),131072))
                    if pick and pick[2]:
                        spans = (np.array([pick[0]]),)
                    for ids in spans:
                        amount = opacity if mask is None else opacity * mask(ids)[:, None]
                        result[ids] += (buffer[ids] - result[ids]) * amount
                else:
                    mode = 'normal' if base['blend']=='passThrough' else base['blend']
                    if styled and mask is not None:
                        for ids,pixels in image_tiles(buffer):
                            buffer[ids] = pixels*mask(ids)[:,None]
                    tiles = styled_tiles(buffer,surface,styles,color) if styled else image_tiles(buffer)
                    if pick and pick[2]:
                        tiles = point_tiles(tiles, pick[0])
                    for ids, pixels in tiles:
                        amount = opacity if styled or mask is None else opacity * mask(ids)[:, None]
                        composite_tile(result, ids, pixels, amount, mode)
            if group_pick and group_pick[1]:
                weight = opacity if mask is None else opacity * mask(np.array([pick[0]]))[0]
                pick[1].extend((key,alpha*weight) for key,alpha in group_pick[1])
            continue
        if not clips or base['kind'] == 'adjustment':
            composite_layer(result, base, surface, assets, space, color, pick=pick)
            continue
        clip_pick = (pick[0],[],pick[2]) if pick else None
        with composite_buffer(result, depth) as buffer:
            composite_layer(buffer, base, surface, assets, space, color, group_base=True, pick=clip_pick)
            for layer in clips:
                composite_layer(buffer, layer, surface, assets, space, color, clipped=True, pick=clip_pick)
            tiles = image_tiles(buffer)
            if pick and pick[2]:
                tiles = point_tiles(tiles, pick[0])
            for ids, pixels in tiles:
                coverage = composite_tile(result, ids, pixels, base['opacity'], base['blend'],
                                          blend_if=base.get('blendIf'),space=space,sample=pick[0] if pick else None)
                if coverage:
                    pick[1].append((base['id'],coverage))
                    pick[1].extend((key,alpha*coverage) for key,alpha in clip_pick[1] if key!=base['id'])


def document_stack(layers):
    children = {}
    for layer in layers:
        children.setdefault(layer.get('parentId'), []).append(layer)
    return children


def stroke_window_padding(document):
    # Operations that sample the rest of the document still use the ordinary
    # preview. A window shares the 4K brush and blend math for everything else.
    padding = 0
    for layer in document['layers']:
        active = {key:effect for key,effect in layer.get('styles',{}).items() if effect['enabled']}
        if layer.get('maskTransform') or layer.get('maskWarpSteps') or layer.get('gradientTransform') or 'gradient' in active:
            return None
        if layer.get('kind') == 'adjustment' and layer['adjustment']['type'] in ('gaussianBlur','unsharpMask'):
            return None
        if layer.get('gradient',{}).get('feather') or layer.get('maskGradient',{}).get('feather'):
            return None
        for key in ('strokes','maskStrokes'):
            for stroke in iter_strokes(layer.get(key) or []):
                if stroke.get('feather') or 'clone' in stroke or 'flood' in stroke:
                    return None
                if 'transformUV' in stroke:
                    t = stroke['transformUV']
                    if (key!='strokes' or t['scale']!=[1,1] or t['angle'] or t.get('coverage') or t.get('feather')):
                        return None
                    # Replay prior moves with enough source pixels for inverse sampling.
                    padding += math.ceil(max(map(abs,t['offset']))*4096)+1
        padding += active.get('outline',{}).get('width',0)
        if 'shadow' in active:
            shadow = active['shadow']
            padding += max(abs(shadow['x']),abs(shadow['y']))+3*shadow['blur']+2
        if layer.get('maskFeather'):
            half,_ = gaussian_box(layer['maskFeather'])
            padding += 3*(half+1)
    return padding


def exact_stroke_window(document,assets,window,inspect_mask):
    padding = stroke_window_padding(document)
    if padding is None:
        return None
    x,y,side = window
    wide = side+2*padding
    if wide>2048:
        return None
    left,top = (max(0,min(4096-wide,k-padding)) for k in (x,y))
    pixels = composite_document(document,assets,wide,inspect_mask,window=(left,top,wide))
    return pixels[y-top:y-top+side,x-left:x-left+side]


def brush_tile(document, assets, tile):
    """Prepare the active layer and its neighbours once, in linear premultiplied RGBA."""
    x,y,side = tile['window']
    layers = document['layers']
    active = next((i for i,l in enumerate(layers) if l['id']==tile['layerId']), None)
    if active is None:
        return b''
    layer = layers[active]
    if (layer['kind'] in ('group','adjustment') or layer['blend']!='normal' or layer.get('blendIf')
            or any(e['enabled'] for e in layer.get('styles',{}).values()) or layer.get('edgeDecontaminate')
            or any(l.get('parentId') or l.get('clipped') for l in layers)
            or any(l['blend']!='normal' or l.get('blendIf') or l['kind']=='adjustment' for l in layers[active+1:])):
        return b''
    padding = stroke_window_padding(document)
    if padding is None or side+2*padding>1024:
        return b''
    size = side+2*padding
    left,top = (max(0,min(4096-size,k-padding)) for k in (x,y))
    surface = ImageSurface(size,assets,(left,top,size))
    space = document['colorSpace']
    def color(text):
        return decode(np.array(list(bytes.fromhex(text[1:])),dtype=np.float32)/255,space)
    def crop(values):
        return np.ascontiguousarray(values.reshape(size,size,-1)[::-1][y-top:y-top+side,x-left:x-left+side],dtype='<f4')
    def flatten(items):
        out = np.zeros((size*size,4),dtype=np.float32)
        composite_stack(out,document_stack(items),surface,assets,space,color)
        return crop(out)
    planes = [flatten([{**layer,'maskEnabled':False,'opacity':1}])]
    flags = 0
    for flag,items in [(1,layers[:active]),(2,layers[active+1:])]:
        if items:
            flags |= flag
            planes.append(flatten(items))
    if layer.get('maskEnabled'):
        flags |= 4
        ids = np.arange(size*size)
        raw = image_mask({**layer,'maskDensity':1,'maskFeather':0},surface)
        values = raw(ids) if raw else np.ones(size*size,dtype=np.float32)
        planes.append(crop(values))
        if layer.get('maskFeather'):
            flags |= 8
            blurred = values.reshape(size,size,1).copy()
            blur_gaussian(blurred,*gaussian_box(layer['maskFeather']))
            planes.append(crop(blurred))
    return gzip.compress(struct.pack('<I',flags)+b''.join(p.tobytes() for p in planes),compresslevel=1)


def composite_document(document,assets,size=4096,inspect_mask=None,alpha_only=False,window=None):
    surface=ImageSurface(size,assets,window)
    layers=document['layers']
    if inspect_mask:
        layer=next((item for item in layers if item['id']==inspect_mask),None)
        if alpha_only:
            return np.full((size,size),float(layer is not None),np.float32)
        # Mask coverage is data. Quantize it once, independent of the document's color profile.
        pixels=np.full((size*size,4),255 if layer is not None else 0,np.uint8)
        mask=image_mask(layer,surface) if layer is not None else None
        if mask is not None:
            for start in range(0,len(pixels),131072):
                ids=np.arange(start,min(start+131072,len(pixels)))
                pixels[start:start+len(ids),:3]=np.rint(np.clip(mask(ids),0,1)*255).astype(np.uint8)[:,None]
        return pixels.reshape(size,size,4)[::-1]
    result=np.zeros((size*size,4),dtype=np.float32)
    space=document['colorSpace']
    def color(text):
        c=np.array(list(bytes.fromhex(text[1:])),dtype=np.float32)/255
        return decode(c,space)
    composite_stack(result,document_stack(layers),surface,assets,space,color)
    if alpha_only:
        return result[:,3].reshape(size,size)[::-1].copy()
    return encode_document_pixels(result,space).reshape(size,size,4)[::-1]


def encode_document_pixels(result,space):
    # Transparent pixels have zero straight RGB. Limit color conversion to
    # occupied pixels, keeping the same tiles and float32 rounding.
    out = np.zeros((len(result),4),dtype=np.uint8)
    for start in range(0,len(result),131072):
        part = result[start:start+131072]
        active = np.flatnonzero(part[:,3]>0)
        if not len(active):
            continue
        if len(active)==len(part):
            active = slice(None)
        pixels = part[active]
        rgb = pixels[:,:3]/pixels[:,3:]
        if space != 'linear':
            rgb = encode(rgb,space)
        tile = out[start:start+len(part)]
        tile[active,:3] = np.rint(np.clip(rgb,0,1)*255)
        tile[active,3] = np.rint(np.clip(pixels[:,3],0,1)*255)
    return out


def layout_probe(document, assets, size, probe):
    surface = ImageSurface(size,assets)
    space = document['colorSpace']
    result = np.zeros((size*size,4), dtype=np.float32)
    by_id = {layer['id']: layer for layer in document['layers']}
    def color(text):
        values = np.array(list(bytes.fromhex(text[1:])), dtype=np.float32)/255
        return decode(values,space)
    point = probe.get('point')
    if point is not None:
        x, y = (min(size-1, int(n*size)) for n in point)
        contributions = []
        local = not any(layer.get('adjustment',{}).get('type') in ('gaussianBlur','unsharpMask')
                        for layer in document['layers'])
        composite_stack(result, document_stack(document['layers']), surface, assets, space, color,
                        pick=((size-1-y)*size+x,contributions,local))
        return {'hit': next((key for key,alpha in reversed(contributions) if alpha > 1/255), None)}
    def layer_bounds(layer, surface, result):
        size = surface.uv_shape[0]
        result.fill(0)
        composite_layer(result, layer, surface, assets, space, color)
        alpha = result[:,3].reshape(size,size)[::-1]
        rows = np.flatnonzero(np.any(alpha > 1/255, axis=1))
        if not len(rows):
            return None
        cols = np.flatnonzero(np.any(alpha > 1/255, axis=0))
        return [int(cols[0])/size, int(rows[0])/size, int(cols[-1]+1)/size, int(rows[-1]+1)/size]
    bounds = {}
    detail_surface = detail_result = None
    for key in probe['layerIds']:
        layer = {**by_id[key], 'visible': True, 'blend': 'normal', 'opacity': 1, 'maskEnabled': False}
        bounds[key] = layer_bounds(layer, surface, result)
        if bounds[key] is None:
            if detail_surface is None:
                detail_surface = ImageSurface(1024, assets)
                detail_result = np.empty((1024*1024,4), dtype=np.float32)
            bounds[key] = layer_bounds(layer, detail_surface, detail_result)
    return {'bounds': bounds}


def clipboard_png(pixels, region, color_space, assets=None):
    height, width = pixels.shape[:2]
    surface = ImageSurface(width,assets)
    rect = region['rect']
    row0, row1, col0, col1 = surface._selection_bounds(rect, region)
    cropped = pixels[height-row1:height-row0, col0:col1].copy()
    if region.get('feather') or 'coverage' in region:
        coverage = (surface._feathered_selection(rect, region) if region.get('feather') else surface._selection_bytes(rect,region))[::-1]
        cropped[:, :, 3] = (cropped[:, :, 3].astype(np.uint16)*coverage+127)//255
        cropped[cropped[:, :, 3] == 0] = 0
    elif 'polygon' in region or 'regions' in region:
        cropped[~surface._selection_tile(rect, region)[::-1]] = 0
    if not cropped.size or not cropped[:, :, 3].any():
        raise ValueError('选区内没有可复制的像素')
    return png_bytes(cropped, color_space)


def selection_pixels(surface, shape):
    size = surface.uv_shape[0]
    pixels = np.zeros((size,size), dtype=np.uint8)
    if shape is not None:
        rect = shape['rect']
        y0,y1,x0,x1 = surface._selection_bounds(rect,shape)
        tile = surface._feathered_selection(rect,shape) if shape.get('feather') else surface._selection_bytes(rect,shape)
        pixels[size-y1:size-y0,x0:x1] = tile[::-1]
    return pixels


def selection_outline(pixels):
    size = len(pixels)
    ys = np.flatnonzero(np.any(pixels,axis=1))
    if not len(ys):
        return None
    xs = np.flatnonzero(np.any(pixels,axis=0))
    # Marching ants are a display proxy. The stored coverage keeps all 4K values.
    steps = 512
    proxy = np.asarray(Image.fromarray(pixels).resize((steps,steps),Image.Resampling.BOX))
    selected = proxy >= min(128,max(1,int(proxy.max())//2))
    if not selected.any():
        selected[min(steps-1,ys[0]*steps//size),min(steps-1,xs[0]*steps//size)] = True
    edges = []
    for axis,command in [(0,'H'),(1,'V')]:
        grid = selected if axis==0 else selected.T
        borders = np.diff(np.pad(grid,((1,1),(0,0))),axis=0)
        for line,row in enumerate(borders):
            corners = np.flatnonzero(np.diff(row,prepend=False,append=False))
            for start,end in zip(corners[::2],corners[1::2]):
                x,y = (start,line) if axis==0 else (line,start)
                edges.append(f'M{x} {y}{command}{end}')
    return {'rect':[xs[0]/size,ys[0]/size,(xs[-1]+1)/size,(ys[-1]+1)/size],
            'outline':{'size':steps,'path':''.join(edges)}}


def grow_selection(pixels, radius, expand):
    combine = np.maximum if expand else np.minimum
    for axis in (0,1):
        lines = np.moveaxis(pixels,axis,0)
        padded = np.pad(lines,((radius,radius),(0,0)),mode='edge')
        length = 2*radius+1
        base,span = padded,1
        while span*2 <= length:
            base = combine(base[:-span],base[span:])
            span *= 2
        count = len(lines)
        pixels = np.moveaxis(combine(base[:count],base[length-span:length-span+count]),0,axis)
    return pixels


def combine_selection_pixels(base, sampled, operation):
    if operation=='add':
        return np.maximum(base,sampled)
    if operation=='subtract':
        return np.minimum(base,255-sampled)
    return np.minimum(base,sampled)


def path_selection(vertices, size, feather):
    # Supersample the curved boundary in strips to keep the 4K mask's edges
    # independent of the editor zoom and bound the temporary allocation.
    scale = 4
    points = [(x*size*scale,y*size*scale) for x,y in vertices]
    result = np.zeros((size,size),dtype=np.uint8)
    top = max(0,math.floor(min(y for _,y in points)/scale))
    bottom = min(size,math.ceil(max(y for _,y in points)/scale))
    for start in range(top,bottom,128):
        height = min(128,bottom-start)
        tile = Image.new('L',(size*scale,height*scale))
        ImageDraw.Draw(tile).polygon([(x,y-start*scale) for x,y in points],fill=255)
        result[start:start+height] = np.asarray(tile.resize((size,height),Image.Resampling.BOX))
    if feather:
        return np.asarray(Image.fromarray(result).filter(ImageFilter.GaussianBlur(feather)))
    return result


def edge_pixels(document,assets,size):
    layer = document['layers'][0]
    if layer['kind']=='image' and not layer.get('warp') and size==4096:
        space = document['colorSpace']
        raw = placed_layer_pixels(layer,assets,space)
        def render(x,y,w,h):
            pixels = image_pixels(layer,assets,size,space,window=(x,y,w,h),raw=raw)
            return encode_document_pixels(pixels,space).reshape(h,w,4)[::-1]
        return render
    rgba = composite_document(document,assets,size)
    return lambda x,y,w,h: rgba[y:y+h,x:x+w]


def refine_local_edge(pixels, edge, rgba=None):
    size = len(pixels)
    points = np.asarray(edge['points'])*size
    radius,amount = edge['radius'],edge['amount']
    margin = radius+max(abs(amount),4)+8
    x0,y0 = np.maximum(0,np.floor(points.min(axis=0)-margin)).astype(int)
    x1,y1 = np.minimum(size,np.ceil(points.max(axis=0)+margin)).astype(int)
    crop = pixels[y0:y1,x0:x1]
    stencil = Image.new('L',(x1-x0,y1-y0))
    draw = ImageDraw.Draw(stencil)
    local = [(x-x0,y-y0) for x,y in points]
    if len(local)>1:
        draw.line(local,fill=255,width=max(1,round(radius*1.6)),joint='curve')
    for x,y in local:
        r = radius*.8
        draw.ellipse((x-r,y-r,x+r,y+r),fill=255)
    weight = np.asarray(stencil.filter(ImageFilter.GaussianBlur(radius*.12))).astype(np.float32)/255
    target = (grow_selection(crop,abs(amount),amount>0) if amount else
              np.asarray(Image.fromarray(crop).filter(ImageFilter.GaussianBlur(3))))
    if rgba is not None:
        read = rgba if callable(rgba) else lambda x,y,w,h: rgba[y:y+h,x:x+w]
        tile = read(x0,y0,x1-x0,y1-y0)
        image = tile[:,:,:3].astype(np.float32)/255
        alpha = tile[:,:,3]
        original = crop.astype(np.float32)/255
        def reference(key,eligible):
            if key in edge:
                x,y = np.minimum(size-1,(np.asarray(edge[key])*size).astype(int))
                pixel = read(x,y,1,1)[0,0]
                if pixel[3]:
                    return pixel[:3].astype(np.float32)/255
            samples = image[(weight>.05)&(alpha>0)&eligible][::4]
            return np.median(samples,axis=0) if len(samples) else None
        foreground = reference('foreground',original>.90)
        background = reference('background',original<.10)
        if foreground is None or background is None:
            raise ValueError('请在原图取样前景和背景，再拖动需要细化的边缘')
        reach = max(2,abs(amount))
        interior = max(1,reach//3)
        eroded = grow_selection(crop,interior,False)
        dilated = grow_selection(crop,interior,True)
        blur = gaussian_box(max(3,reach*.65))

        def local_reference(known, sample, anchored):
            weights = known.astype(np.float32)
            values = np.empty((*weights.shape,4),dtype=np.float32)
            values[:,:,:3] = image*weights[:,:,None]
            values[:,:,3] = weights
            blur_gaussian(values,*blur)
            prior = .045 if anchored else .015
            return (values[:,:,:3]+sample*prior)/(values[:,:,3:]+prior),values[:,:,3]

        fg,fg_support = local_reference((eroded>240)&(alpha>0),foreground,'foreground' in edge)
        bg,bg_support = local_reference((dilated<15)&(alpha>0),background,'background' in edge)
        axis = fg-bg
        norm = np.sum(axis*axis,axis=2)
        difference = image-bg
        blend = np.clip(np.sum(difference*axis,axis=2)/np.maximum(norm,1e-6),0,1)
        residual = np.linalg.norm(difference-blend[:,:,None]*axis,axis=2)
        band = grow_selection(crop,reach,True).astype(np.float32)-grow_selection(crop,reach,False)
        supported = np.clip(np.minimum(fg_support,bg_support)*18,0,1)
        contrast = np.clip((np.sqrt(norm)-.05)/.15,0,1)
        confidence = np.clip(1-residual/(.07+np.sqrt(norm)*.2),0,1)*supported*contrast
        # Estimate coverage from the original mixtures only within the swept
        # edge band. Model disagreement leaves the original alpha alone.
        weight *= (band/255)*confidence*(alpha>0)
        target = blend*255
    crop[:] = np.rint(crop+(target.astype(np.float32)-crop)*weight).astype(np.uint8)
    return pixels


def document_frame(document):
    width,height=document.get('width',4096),document.get('height',4096)
    return document.get('frame',[(4096-width)//2,(4096-height)//2,width,height])


def clear_outside_frame(pixels,document):
    x,y,w,h=document_frame(document)
    if (x,y,w,h)==(0,0,4096,4096):
        return pixels
    scale=pixels.shape[0]/4096
    left,top,right,bottom=(max(0,min(pixels.shape[0],math.ceil(edge*scale-.5))) for edge in (x,y,x+w,y+h))
    if not pixels.flags.writeable:
        pixels=pixels.copy()
    pixels[:top]=0
    pixels[bottom:]=0
    pixels[:,:left]=0
    pixels[:,right:]=0
    return pixels


def image_selection_sample(document,assets,options,size):
    surface = ImageSurface(size,assets)
    source,operation = options['source'],options['operation']
    previous = options.get('previous')
    if source=='path':
        pixels = path_selection(options['vertices'],size,options.get('feather',0))
        if operation!='replace':
            pixels = combine_selection_pixels(selection_pixels(surface,previous),pixels,operation)
    elif source=='refine':
        pixels = selection_pixels(surface,previous)
        if operation=='invert':
            pixels = 255-pixels
        elif operation in ('expand','contract'):
            pixels = grow_selection(pixels,options['pixels'],operation=='expand')
        elif operation=='smooth':
            filtered = Image.fromarray(pixels).filter(ImageFilter.BoxBlur(options['pixels']))
            pixels = np.clip((np.asarray(filtered).astype(np.int16)-96)*4,0,255).astype(np.uint8)
        elif operation=='localEdge':
            edge = options['edge']
            rgba = edge_pixels(document,assets,size) if 'layerId' in edge else None
            pixels = refine_local_edge(pixels,edge,rgba)
        elif operation=='reshape':
            spec = options['transform']
            sx,sy = spec['scale']
            cx,cy = (n*size for n in spec['pivot'])
            dx,dy = (n*size for n in spec['offset'])
            angle = np.radians(spec['angle'])
            c,s = np.cos(angle),np.sin(angle)
            a,b,d,e = c/sx,s/sx,-s/sy,c/sy
            matrix = (a,b,cx-a*(cx+dx)-b*(cy+dy),d,e,cy-d*(cx+dx)-e*(cy+dy))
            pixels = np.asarray(Image.fromarray(pixels).transform((size,size),Image.Transform.AFFINE,matrix,Image.Resampling.BILINEAR))
        elif operation in ('add','subtract','intersect'):
            sampled = selection_pixels(surface,options['candidate'])
            pixels = combine_selection_pixels(pixels,sampled,operation)
    elif source=='visibleAlpha':
        spec=options['alphaInput']
        ancestors=spec['ancestors']
        if any(not group['visible'] or not group['opacity'] for group in ancestors):
            pixels=np.zeros((size,size),dtype=np.uint8)
        else:
            alpha=composite_document(document,assets,size,alpha_only=True)
            if 'base' in spec:
                alpha*=composite_document({**document,'layers':spec['base']},assets,size,alpha_only=True)
            for group in ancestors:
                alpha*=group['opacity']
                mask=image_mask(group,surface) if group['maskEnabled'] else None
                if mask is not None:
                    flat=alpha[::-1]
                    for row in range(0,size,32):
                        stop=min(row+32,size)
                        ids=np.arange(row*size,stop*size)
                        flat[row:stop]*=mask(ids).reshape(stop-row,size)
            pixels=np.rint(np.clip(alpha,0,1)*255).astype(np.uint8)
        if operation!='replace':
            pixels=combine_selection_pixels(selection_pixels(surface,previous),pixels,operation)
    else:
        rgba = composite_document(document,assets,size,options.get('maskId'))
        if source in ('alpha','mask'):
            pixels = rgba[:,:,0 if source=='mask' else 3].copy()
        elif source=='colorRange':
            x,y = (min(size-1,int(n*size)) for n in options['point'])
            seed = rgba[y,x,:3].astype(np.int16)
            fuzziness = options['tolerance']
            pixels = np.zeros((size,size),dtype=np.uint8)
            if rgba[y,x,3]:
                # Process scanline blocks to keep scratch memory bounded at 4K.
                for start in range(0,size,128):
                    tile = rgba[start:start+128]
                    distance = np.max(np.abs(tile[:,:,:3].astype(np.int16)-seed),axis=2)
                    weight = np.maximum(0,1-distance/fuzziness) if fuzziness else distance==0
                    pixels[start:start+128] = np.rint(weight*tile[:,:,3]).astype(np.uint8)
        else:
            x,y = (min(size-1,int(n*size)) for n in options['point'])
            seed = rgba[y,x].astype(np.int16)
            matching = np.ones((size,size),dtype=bool)
            for index,value in enumerate(seed):
                low,high = max(0,value-options['tolerance']),min(255,value+options['tolerance'])
                matching &= (rgba[:,:,index]>=low)&(rgba[:,:,index]<=high)
            if options['contiguous']:
                matching = connected_area(clear_outside_frame(matching,document),y,x)
            pixels = matching.astype(np.uint8)*255
        del rgba
        if operation!='replace':
            base = selection_pixels(surface,previous)
            if source=='colorRange' and operation=='subtract':
                pixels = base-np.minimum(base,pixels)
            else:
                pixels = combine_selection_pixels(base,pixels,operation)
    pixels = clear_outside_frame(pixels,document)
    outline = selection_outline(pixels)
    metadata = json.dumps(outline,separators=(',',':')).encode()
    return struct.pack('>I',len(metadata))+metadata+(png_bytes(pixels) if outline is not None else b'')


def image_edge_view(document,assets,size,options):
    view = options['view']
    def preview(pixels, space=None):
        return png_bytes(framed_pixels(pixels, document, limit=size), space)
    if view == 'coverage':
        # Compute feather and asset masks on their authored grid before reducing for display.
        mask = selection_pixels(ImageSurface(4096,assets), options.get('selection'))
        alpha = framed_pixels(mask,document,limit=size)
        result = np.empty((*alpha.shape,4), dtype=np.uint8)
        result[:,:,:3] = (209,42,49)
        result[:,:,3] = np.rint(alpha*.58)
        return png_bytes(result)
    if view == 'original':
        return preview(composite_document(document,assets,size),document['colorSpace'])
    surface = ImageSurface(size,assets)
    mask = selection_pixels(surface,options['selection']) if options.get('selection') else np.full((size,size),255,np.uint8)
    if view == 'mask':
        return preview(mask)
    rgba = Image.fromarray(composite_document(document,assets,size))
    coverage = Image.fromarray(mask)
    if view == 'overlay':
        from PIL import ImageChops
        space=document['colorSpace']
        if space in GRAY_SPACES:
            rgba=convert_image(rgba,profile_bytes(space),profile_bytes('srgb'))
            space='srgb'
        red = Image.new('RGBA',rgba.size,(209,42,49,255))
        red.putalpha(ImageChops.invert(coverage).point(lambda n: n*.58))
        rgba.alpha_composite(red)
        return preview(np.asarray(rgba),space)
    from PIL import ImageChops
    rgba.putalpha(ImageChops.multiply(rgba.getchannel('A'),coverage))
    background = Image.new('RGBA',rgba.size,'black' if view=='black' else 'white')
    background.alpha_composite(rgba)
    return preview(np.asarray(background),document['colorSpace'])


def png_bytes(pixels, color_space=None, output_space=None):
    image = Image.fromarray(pixels)
    if output_space and output_space!=color_space:
        image = convert_image(image,profile_bytes(color_space),profile_bytes(output_space))
        color_space = output_space
    if color_space in GRAY_SPACES:
        image = Image.merge('LA',(image.getchannel('R'),image.getchannel('A')))
    metadata = PngImagePlugin.PngInfo()
    if color_space == 'srgb':
        metadata.add(b'sRGB', bytes([0]))
    elif color_space == 'linear':
        metadata.add(b'gAMA', struct.pack('>I', 100000))
    out = BytesIO()
    image.save(out, format='PNG', pnginfo=metadata, icc_profile=profile_bytes(color_space) if color_space in PROFILED_SPACES else None, compress_level=3)
    return out.getvalue()


def framed_pixels(pixels, document, limit=None, target=None, window=None):
    width, height = document.get('width',4096), document.get('height',4096)
    x,y,w,h = document_frame(document)
    if limit is not None:
        scale = min(1,limit/max(width,height))
        width,height = max(1,round(width*scale)),max(1,round(height*scale))
    if target is not None:
        width,height=target
    factor = 1 if window else pixels.shape[0]/4096
    ox,oy = window[:2] if window else (0,0)
    box = [max(0,x*factor-ox),max(0,y*factor-oy),
           min(pixels.shape[1],(x+w)*factor-ox),min(pixels.shape[0],(y+h)*factor-oy)]
    if all(value.is_integer() for value in map(float,box)):
        left,top,right,bottom=map(int,box)
        cropped=pixels[top:bottom,left:right]
        if (right-left,bottom-top)==(width,height):
            return cropped
        return np.asarray(Image.fromarray(cropped).resize((width,height),Image.Resampling.BICUBIC))
    image=Image.fromarray(pixels)
    return np.asarray(image.resize((width,height),Image.Resampling.BICUBIC,box=tuple(box)))


def document_pixel(document, assets, point):
    """Sample the export pixel, including the current canvas crop and resampling."""
    x,y = point
    left,top,w,h = document_frame(document)
    size = (document.get('width',4096),document.get('height',4096))
    if (w,h)==size and float(left).is_integer() and float(top).is_integer():
        pixels = exact_stroke_window(document,assets,(int(left)+x,int(top)+y,1),None)
        if pixels is not None:
            return pixels
    return framed_composite(document,assets,size,resolution=4096)[y:y+1,x:x+1]


def framed_composite(document, assets, target, inspect_mask=None, resolution=None):
    x,y,w,h = document_frame(document)
    if resolution is None:
        resolution = min(4096,max(1,math.ceil(4096*max(target[0]/w,target[1]/h))))
    # Fractional boxes must use the same resampling origin as the final document.
    aligned = all(float(v).is_integer() for v in (x,y,w,h))
    left,top = math.floor(x),math.floor(y)
    side = max(math.ceil(x+w)-left,math.ceil(y+h)-top)
    # The exact brush window already accounts for stroke/filter neighborhoods.
    # Use it when the local tile costs less than sampling the whole editing grid.
    if aligned and side <= min(2048,resolution):
        window = (min(left,4096-side),min(top,4096-side),side)
        pixels = exact_stroke_window(document,assets,window,inspect_mask)
        if pixels is not None:
            return framed_pixels(pixels,document,target=target,window=window)
    return framed_pixels(composite_document(document,assets,resolution,inspect_mask),document,target=target)


_cache=OrderedDict()
def document_pixels(document,assets,size):
    # A parent can have the same layer records while its source pixels change.
    shared=any(layer.get('embedded') for layer in document['layers'])
    key=None if shared else hashlib.sha256(json.dumps([document,size],sort_keys=True).encode()).hexdigest()
    if key not in _cache:
        width,height = document.get('width',4096),document.get('height',4096)
        frame = document_frame(document)
        scale = min(1,size/max(width,height))
        resolution = 4096 if scale==1 else min(4096,max(1,math.ceil(4096*scale*max(width/frame[2],height/frame[3]))))
        if resolution==4096:
            target=max(1,round(width*scale)),max(1,round(height*scale))
            pixels=framed_composite(document,assets,target,resolution=resolution)
        else:
            pixels=framed_pixels(composite_document(document,assets,resolution),document,size)
        if shared:
            return pixels
        # A crop may still own its entire editing grid through a NumPy view.
        if isinstance(pixels.base,np.ndarray) and pixels.base.nbytes>pixels.nbytes:
            pixels=pixels.copy()
        _cache[key]=pixels
        while len(_cache)>1:_cache.popitem(last=False)
    return _cache[key]
