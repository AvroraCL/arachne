"""Composite a frozen PBR stack in original UV coordinates."""
from paint_channels import CHANNELS, DEFAULTS, RGB, SRGB, channel_value, material_values as base_material_values, normalize_normals, enabled_base
import base64
import hashlib
import json
import math
import sys
from pathlib import Path
from functools import lru_cache

import numpy as np
from PIL import Image

from paint_surface import Surface, registered_surface
from paint_mask_generators import edge_wear, surface_noise, smooth
from material_graph import MaterialGraph, MaterialImages
from image_documents import document_pixels,composite_document,clipboard_png,png_bytes


def decode(srgb):
    return np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)


def encode(linear):
    return np.where(linear <= .0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - .055)


def color(text):
    return decode(np.array(list(bytes.fromhex(text[1:]))) / 255)


def blend_channel(backdrop, paint, mode):
    if mode == 'multiply':
        return backdrop * paint
    if mode == 'screen':
        return backdrop + paint - backdrop * paint
    if mode == 'overlay':
        return np.where(backdrop <= .5, 2 * backdrop * paint, 1 - 2 * (1 - backdrop) * (1 - paint))
    if mode == 'add':
        return np.minimum(1, backdrop + paint)
    if mode == 'subtract':
        return np.maximum(0, backdrop - paint)
    if mode == 'darken':
        return np.minimum(backdrop, paint)
    if mode == 'lighten':
        return np.maximum(backdrop, paint)
    if mode == 'difference':
        return np.abs(backdrop - paint)
    if mode == 'normalCombine':
        # Whiteout blending preserves the tangent direction of either input
        # when the other is flat.
        base, detail = backdrop * 2 - 1, paint * 2 - 1
        base_xy, detail_xy = base[..., :2], detail[..., :2]
        base_xy = np.where(np.abs(base_xy) <= 1 / 255 + 1e-6, 0, base_xy)
        detail_xy = np.where(np.abs(detail_xy) <= 1 / 255 + 1e-6, 0, detail_xy)
        combined = np.concatenate((base_xy + detail_xy, base[..., 2:] * detail[..., 2:]), axis=-1)
        length = np.linalg.norm(combined, axis=-1, keepdims=True)
        return np.divide(combined, length, out=np.broadcast_to([0., 0., 1.], combined.shape).copy(),
                         where=length > 1e-8) * .5 + .5
    return paint


def sample(field, u, v, repeat=False):
    h, w = field.shape[:2]
    if repeat:
        x, y = np.mod(u,1)*w-.5, np.mod(v,1)*h-.5
        ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
        nx, ny = (ix+1)%w, (iy+1)%h
    else:
        x, y = np.clip(u,0,1)*(w-1), np.clip(v,0,1)*(h-1)
        ix, iy = x.astype(int), y.astype(int)
        nx, ny = np.minimum(ix+1,w-1), np.minimum(iy+1,h-1)
    dx, dy = x - ix, y - iy
    if repeat:
        ix, iy = ix%w, iy%h
    if field.ndim == 3:
        dx, dy = dx[:, None], dy[:, None]
    return (field[iy, ix] * (1-dx) + field[iy, nx] * dx) * (1-dy) + (field[ny, ix] * (1-dx) + field[ny, nx] * dx) * dy


def sample_document(field,u,v,name,repeat=False,linear=False):
    h,w=field.shape[:2]
    x,y=(np.mod(u,1)*w-.5,np.mod(v,1)*h-.5) if repeat else (np.clip(u,0,1)*(w-1),np.clip(v,0,1)*(h-1))
    ix,iy=np.floor(x).astype(int),np.floor(y).astype(int);fx,fy=x-ix,y-iy
    alpha=np.zeros(len(u),dtype=np.float32);premult=np.zeros((len(u),3) if name in RGB else len(u),dtype=np.float32)
    for dx,dy,weight in [(0,0,(1-fx)*(1-fy)),(1,0,fx*(1-fy)),(0,1,(1-fx)*fy),(1,1,fx*fy)]:
        col,row=ix+dx,iy+dy
        col,row=(col%w,row%h) if repeat else (np.clip(col,0,w-1),np.clip(row,0,h-1))
        rgba=field[row,col].astype(np.float32)/255;rgb=rgba[:,:3]
        value=(decode(rgb) if name in SRGB and not linear else rgb) if name in RGB else rgb@np.array([.299,.587,.114],dtype=np.float32)
        a=rgba[:,3]*weight;alpha+=a;premult+=value*(a[:,None] if name in RGB else a)
    denominator=alpha[:,None] if name in RGB else alpha
    return np.divide(premult,denominator,out=np.zeros_like(premult),where=denominator>0),alpha


def coordinates(u, v, layer, shape):
    a = math.radians(layer['rotation'])
    x, y = u-layer['x'], v-layer['y']
    width, height = shape[1], shape[0]
    scale = layer['scale'] / max(width, height)
    sx,sy = layer.get('uvScale',(1,1))
    return ((x*math.cos(a)+y*math.sin(a))/(width*scale*sx)+.5,
            (-x*math.sin(a)+y*math.cos(a))/(height*scale*sy)+.5)


def canvas_decal_bounds(layer, image_shape, shape):
    height, width = shape
    image_height, image_width = image_shape[:2]
    sx, sy = layer.get('uvScale', (1, 1))
    scale = layer['scale'] / (2*max(image_width, image_height))
    half_width = image_width*scale*abs(sx)
    half_height = image_height*scale*abs(sy)
    angle = math.radians(layer['rotation'])
    c, s = abs(math.cos(angle)), abs(math.sin(angle))
    dx, dy = half_width*c + half_height*s, half_width*s + half_height*c
    x, y = layer['x'], 1-layer['y']
    # Round outward. The exact transformed rectangle still rejects its corners.
    return (max(0, math.floor((x-dx)*width-.5)), min(width, math.ceil((x+dx)*width-.5)+1),
            max(0, math.floor((y-dy)*height-.5)), min(height, math.ceil((y+dy)*height-.5)+1))


def canvas_decal_texels(allowed, start, end, width, bounds):
    left, right, bottom, top = bounds
    first, last = max(bottom, start//width), min(top, (end-1)//width+1)
    if first >= last or left >= right:
        return np.empty(0, dtype=np.intp)
    if left == 0 and right == width:
        begin, finish = max(start, first*width), min(end, last*width)
        return np.flatnonzero(allowed[begin:finish]) + begin
    rows, cols = np.nonzero(allowed.reshape(-1,width)[first:last,left:right])
    ids = (rows+first)*width + cols + left
    return ids[(ids>=start)&(ids<end)]


def texture_coords(u, v, tiling):
    if tiling is None:
        return u, v
    angle = math.radians(tiling['rotation'])
    x, y = u-.5, v-.5
    repeat = tiling['repeat']
    return ((x*math.cos(angle)+y*math.sin(angle))*repeat+.5+tiling['offsetX'],
            (-x*math.sin(angle)+y*math.cos(angle))*repeat+.5+tiling['offsetY'])


@lru_cache(maxsize=2)
def geometry(cache, bundle, material, binding, step, surface_only=False):
    cache, bundle = Path(cache), Path(bundle)
    geo = json.loads((cache/'geometry_report.json').read_bytes())
    if not geo.get('uv_unchanged'):
        raise ValueError('登记缓存未通过原 UV 校验')
    stem = next(m['file'] for m in geo['materials'] if m['name'] == material)
    mapping = np.load(cache/'mapping'/f'{stem}.npz')
    registered_owner = mapping['owner']
    if registered_owner.shape != (4096, 4096):
        raise ValueError('首版要求已登记的 4K 示例模型 UV')
    grid = np.s_[step//2::step,step//2::step]
    sampled_owner = registered_owner[grid]
    owner = sampled_owner.ravel()
    shape = sampled_owner.shape
    protected, conflict = (mapping[key][grid].ravel().astype(bool) for key in ('protected','collision'))
    allowed = (owner >= 0) & ~protected & ~conflict
    xyz = mapping['xyz'][grid].reshape(-1,3)
    mapping.close()
    valid = uv = None
    if not surface_only:
        # Only legacy fixed-top decals need a second full UV projection atlas.
        # 3D brush/mask/projector references consume the registered Surface.
        view_index = geo['view_names'].index('top')
        faces = np.load(cache/'mapping/faces.npz')
        cameras = json.loads((bundle/'cameras.json').read_bytes())
        resolved = json.loads((cache/'resolved_config.json').read_bytes())
        view, options = cameras['views']['top'], resolved['designs']['top']
        candidates = np.flatnonzero(allowed)
        candidates = candidates[faces['choice'][owner[candidates]] == view_index]
        scores = faces['scores']
        receiver = np.array(Image.open(bundle/'top/receiver.png').convert('L')) > 127
        protected_view = np.array(Image.open(bundle/'top/protected.png').convert('L')) > 127
        valid = np.zeros(owner.size,dtype=bool)
        uv = np.zeros((owner.size,2),dtype=np.float32)
        for indexes in np.array_split(candidates, max(1, len(candidates)//200000+1)):
            points = xyz[indexes]-np.asarray(cameras['center'])
            u = points@np.asarray(view['right'])/view['span']+.5
            v = points@np.asarray(view['up'])/view['span']+.5
            u = 1-u if options.get('flip_u') else u
            v = v if options.get('flip_v') else 1-v
            finite = np.isfinite(u)&np.isfinite(v)
            indexes,u,v = indexes[finite],u[finite],v[finite]
            x,y = (np.clip(u,0,1)*(receiver.shape[1]-1)).astype(int),(np.clip(v,0,1)*(receiver.shape[0]-1)).astype(int)
            ok = (u>=0)&(u<=1)&(v>=0)&(v<=1)&receiver[y,x]&~protected_view[y,x]
            ok &= scores[owner[indexes],view_index]>=resolved.get('grazing_cos',.2)
            valid[indexes[ok]] = True
            uv[indexes[ok]] = np.column_stack((u[ok],v[ok]))
        faces.close()
    positions, triangle_valid, normals, objects, polygons, protected_faces = registered_surface(
        str(bundle),str(cache/'mapping/faces.npz'),binding)
    surface = Surface(positions,triangle_valid,normals,objects,xyz,owner,allowed,live=step>=8,
        polygons=polygons,protected=protected_faces,edges_path=str(cache/'mapping/edges.npz'),uv_shape=shape)
    return surface, protected, conflict, valid, uv, shape


@lru_cache(maxsize=1)
def picking_atlas(cache, material, binding):
    cache = Path(cache)
    geo = json.loads((cache/'geometry_report.json').read_bytes())
    stem = next(m['file'] for m in geo['materials'] if m['name']==material)
    with np.load(cache/'mapping'/f'{stem}.npz') as data:
        result = np.where(data['owner']>=0,0,3).astype(np.uint8)
        result[data['collision']>0] = 2
        result[data['protected']>0] = 1
    return result


@lru_cache(maxsize=8)
def read_art(file, kind, live):
    with Image.open(file) as im:
        im = im.convert('RGBA' if kind=='decal' else 'RGB' if kind in RGB else 'L')
        if live:
            im.thumbnail((2048,2048),Image.Resampling.BILINEAR)
        raw = np.asarray(im,dtype=np.float32)/255
    if kind=='decal':
        return np.concatenate((decode(raw[:,:,:3])*raw[:,:,3:],raw[:,:,3:]),axis=2)
    return decode(raw) if kind in SRGB else raw


def at_range(ids, start, end):
    return slice(*np.searchsorted(ids,[start,end]))


def mask_values(mask, surface_mask, ids, u, v, base=1):
    initial = sample(mask,u,v) if mask is not None else np.full(len(ids),base,dtype=np.float32)
    if surface_mask is None or not len(ids):
        return initial
    indexes, opacity, value = surface_mask
    span = at_range(indexes,ids[0],ids[-1]+1)
    wanted = indexes[span]
    local = np.searchsorted(ids,wanted)
    match = (local<len(ids))&(ids[np.minimum(local,len(ids)-1)]==wanted)
    selected = local[match]
    initial[selected] = initial[selected]*(1-opacity[span][match])+value[span][match]
    return initial


def mask_effects(coverage, effects, generated, surface, ids):
    eligible = surface.allowed[ids]
    selected = ids[eligible]
    if not len(selected):
        return np.zeros_like(coverage) if generated else coverage
    previous = coverage[eligible]
    for effect in effects:
        kind = effect['kind']
        if kind=='invert':
            value = 1-previous
        elif kind=='levels':
            black,white = effect['black'],effect['white']
            value = np.clip((previous-black)/(white-black),0,1)**(1/effect['gamma'])
        elif kind=='edgeWear':
            value = edge_wear(surface, selected, effect)
        elif kind=='surfaceNoise':
            value = surface_noise(surface, selected, effect)
        else:
            axis = 'xyz'.index(effect['axis'][-1])
            if kind=='height':
                low, high = surface.low[axis], surface.high[axis]
                value = (surface.xyz[selected,axis]-low)/max(1e-6,high-low)
            else:
                value = (surface.normals[surface.owner[selected],axis]+1)*.5
            if effect['axis'].startswith('-'):
                value = 1-value
            value = smooth((value-effect['center'])/effect['feather']+.5)
        if effect.get('blend')=='multiply':
            value *= previous
        previous = previous*(1-effect['opacity'])+value*effect['opacity']
    coverage[eligible] = previous
    if generated:
        coverage[~eligible] = 0
    return coverage


def composite(cfg, step):
    with MaterialImages(cfg['assets']) as material_images:
        return composite_layers(cfg, step, material_images)


def composite_layers(cfg, step, material_images):
    source, paint = cfg['source'], cfg['paint']
    surface, protected, conflict, valid, uv, shape = geometry(
        source['cacheRun'],source['bundle'],source['material'],cfg['bindingFingerprint'],step)
    legacy_top_bindings = {layer.get('surfaceBinding') for layer in paint['layers']
                           if layer['kind']=='decal' and not layer.get('projector') and layer.get('space')!='uv'}
    def reference_geometry(item):
        key = item.get('surfaceBinding')
        if key is None or key == cfg.get('modelFingerprint','original'):
            return surface, valid, uv
        entry = cfg.get('surfaceSources', {}).get(key)
        if entry is None:
            raise ValueError('绘制表面版本尚未准备')
        reference = entry['source']
        resolved = geometry(reference['cacheRun'], reference['bundle'], reference['material'],
                            entry['bindingFingerprint'], step, surface_only=key not in legacy_top_bindings)
        return resolved[0], resolved[3], resolved[4]

    def stroke_sample(stroke):
        reference, _, _ = reference_geometry(stroke)
        ids, opacity = reference.stroke(stroke)
        keep = surface.allowed[ids]
        return ids[keep], opacity[keep]

    inspect = cfg.get('inspectMask')
    isolated = cfg.get('isolatedLayer')
    layers = []
    fill_graphs = {}
    has_generator = False
    folder_visibility = {}
    def art(asset, kind):
        return read_art(cfg['assets'][asset],kind,step>=8)

    for layer in paint['layers']:
        parent_visible = folder_visibility.get(layer.get('parentId'),not isolated)
        visible = layer['id']==isolated or (parent_visible and layer['visible'])
        if layer['kind']=='group':
            folder_visibility[layer['id']] = visible
            continue
        inspection = inspect==layer['id']
        if not inspection and (inspect or not visible or not layer['opacity']):
            continue
        opacity = {name: layer.get('channelOpacity', {}).get(name, 1)
                   for name, enabled in layer['channels'].items() if enabled}
        opacity = {name: value for name, value in opacity.items() if value > 0}
        if not opacity and not inspection:
            continue
        image = art(layer['image'],'decal') if layer['kind']=='decal' else None
        masking = layer.get('maskEnabled',True) or inspection
        mask = art(layer['mask'],'mask') if masking and layer['mask'] else None
        material_id = layer.get('materialId')
        maps = {} if material_id else {name: art(asset_id,name) for name,asset_id in layer.get('maps',{}).items() if name in opacity}
        for name,document_id in layer.get('documentMaps',{}).items():
            if name not in opacity:continue
            maps[name]={'document':document_pixels(paint['imageDocuments'][document_id],cfg['assets'],shape[0]),'colorSpace':paint['imageDocuments'][document_id]['colorSpace']}
        surface_mask = surface.mask(layer.get('maskStrokes',[]),stroke_sample) if masking else None
        effects = [e for e in layer.get('maskEffects',[]) if e['enabled'] and e['opacity']] if masking else []
        mask_base = layer.get('maskBase',1) if masking else 1
        generated = any(e['kind'] in ('height','facing','edgeWear','surfaceNoise') for e in effects)
        has_generator |= generated
        projector = layer.get('projector')
        projection_surface, reference_valid, reference_uv = reference_geometry(layer) if image is not None else (surface,valid,uv)
        projection = projection_surface.project(projector,image.shape) if projector else None
        if projection is not None:
            projected_ids, projected_uv = projection
            keep = surface.allowed[projected_ids]
            projection = projected_ids[keep], projected_uv[keep]
        canvas_bounds = canvas_decal_bounds(layer,image.shape,shape) if layer.get('space')=='uv' else None
        strokes = surface.paint(layer.get('strokes',[]),opacity,color,stroke_sample) if layer['kind']=='paint' and not inspection else None
        if material_id and material_id not in fill_graphs and not inspection:
            fill_graphs[material_id] = MaterialGraph(cfg['fillMaterialPlans'][material_id],cfg['assets'],material_images)
        layers.append((layer,image,mask,maps,opacity,surface_mask,mask_base,effects,generated,projection,canvas_bounds,strokes,reference_valid,reference_uv))
    base = enabled_base(paint)
    graph = MaterialGraph(cfg.get('materialPlan') if not inspect else None,cfg['assets'],material_images)
    combined = np.empty((len(valid),14),dtype=np.uint8)
    if graph.plan and cfg.get('_captureGraphPaint'):
        cfg['_graphPaint'] = np.empty_like(combined)
    written = np.zeros(len(valid),dtype=bool)
    chunk = 32768 if graph.plan or fill_graphs else 200000
    for start in range(0,len(valid),chunk):
        end = min(start+chunk,len(valid))
        base_values = base_material_values(dict(color='#000000',metallic=0,roughness=.5) if inspect else base,color)
        result = np.tile(base_values,(end-start,1))
        for layer,image,mask,maps,opacity,surface_mask,mask_base,effects,generated,projection,canvas_bounds,strokes,reference_valid,reference_uv in layers:
            if projection is not None:
                projected_ids, projected_uv = projection
                span = at_range(projected_ids,start,end)
                ids = projected_ids[span]
                u,v = projected_uv[span].T
            elif image is not None:
                if canvas_bounds is not None:
                    ids = canvas_decal_texels(surface.allowed,start,end,shape[1],canvas_bounds)
                    coords = ((ids%shape[1]+.5)/shape[1],1-(ids//shape[1]+.5)/shape[0])
                else:
                    ids = np.flatnonzero(reference_valid[start:end]&surface.allowed[start:end])+start
                    coords = reference_uv[ids].T
                u,v = coordinates(*coords,layer,image.shape)
                visible = (u>=0)&(u<=1)&(v>=0)&(v<=1)
                ids,u,v = ids[visible],u[visible],v[visible]
            else:
                if strokes is None:
                    ids = np.arange(start,end)
                else:
                    stroke_ids,_ = strokes
                    stroke_span = at_range(stroke_ids,start,end)
                    ids = stroke_ids[stroke_span]
                u = (ids%shape[1])/(shape[1]-1)
                v = 1-(ids//shape[1])/(shape[0]-1)
            selected = ids-start
            uu = (ids%shape[1])/(shape[1]-1)
            vv = 1-(ids//shape[1])/(shape[0]-1)
            mask_u,mask_v = (uu,vv) if projection is not None else (u,v)
            coverage = mask_values(mask,surface_mask,ids,mask_u,mask_v,mask_base)
            if effects:
                coverage = mask_effects(coverage,effects,generated,surface,ids)
            if inspect:
                result[selected,:3] = decode(coverage[:,None])
                continue
            weight = np.full(len(ids),layer['opacity'],dtype=float)
            if image is not None:
                sampled = sample(image,u,v)
                alpha = sampled[:,3]
                rgb = np.divide(sampled[:,:3],alpha[:,None],out=np.zeros_like(sampled[:,:3]),where=alpha[:,None]>0)
                weight *= alpha
            else:
                rgb = color(layer['values']['color'])
            weight *= coverage
            if image is not None or generated and layer['kind']=='fill':
                written[ids[weight>0]] = True
            material = fill_graphs.get(layer.get('materialId'))
            material_values = material.evaluate(result[selected],ids,shape[1],shape[0]) if material else None
            tiling=layer.get('tiling')
            map_u,map_v=texture_coords(u,v,tiling) if maps else (u,v)
            for name,col in CHANNELS.items():
                value = rgb if name=='color' else channel_value(name,layer['values'].get(name,DEFAULTS[name]),color)
                if name not in opacity:
                    continue
                channel_weight = weight * opacity[name]
                backdrop = result[selected,col]
                if strokes is not None:
                    if name not in strokes[1]:
                        continue
                    stroke_alpha,premult = (part[stroke_span] for part in strokes[1][name])
                    value = np.divide(premult,stroke_alpha[:,None],out=np.zeros_like(premult),where=stroke_alpha[:,None]>0)
                    if name not in RGB:
                        value = value[:,0]
                    channel_weight *= stroke_alpha
                    written[ids[channel_weight>0]] = True
                elif material_values is not None:
                    value = material_values[:,col]
                    overlay=maps.get(name)
                    if isinstance(overlay,dict):
                        drawing,alpha=sample_document(overlay['document'],u,v,name,linear=overlay['colorSpace']=='linear')
                        alpha=alpha[:,None] if name in RGB else alpha
                        value=value*(1-alpha)+drawing*alpha
                elif name in maps:
                    texture=maps[name]
                    if isinstance(texture,dict):
                        value,document_alpha=sample_document(texture['document'],map_u,map_v,name,repeat=tiling is not None,linear=texture['colorSpace']=='linear')
                        channel_weight*=document_alpha
                    else:value = sample(texture,map_u,map_v,repeat=tiling is not None)
                blend = layer.get('blend','normal') if name=='color' else layer.get('channelBlend',{}).get(name,'normal')
                if blend!='normal':
                    value = blend_channel(backdrop,value,blend)
                alpha = channel_weight[:,None] if name in RGB else channel_weight
                result[selected,col] = backdrop*(1-alpha)+value*alpha
        if graph.plan:
            if '_graphPaint' in cfg:
                original = result.copy()
                for name in SRGB:
                    part=CHANNELS[name];original[:,part]=encode(np.clip(original[:,part],0,1))
                cfg['_graphPaint'][start:end] = np.rint(np.clip(original,0,1)*255)
            result = graph.evaluate(result,np.arange(start,end),shape[1],shape[0])
        normalize_normals(result)
        for name in SRGB:
            part=CHANNELS[name];result[:,part]=encode(np.clip(result[:,part],0,1))
        combined[start:end] = np.rint(np.clip(result,0,1)*255)
    assert not np.any(written & (protected|conflict|~surface.allowed))
    surface_scope = has_generator or any(layer.get('projector') or layer.get('space')=='uv' or
                                         layer['kind']=='paint' for layer in paint['layers'])
    eligible = surface.allowed if surface_scope or cfg.get('uvGuide') else valid
    return combined.reshape((*shape,14))[::-1], (protected,conflict,written,eligible)


def main(cfg):
    out = Path(cfg['out'])
    draft = cfg.get('draft',False)
    render_view = cfg.get('renderView',False)
    cfg['_captureGraphPaint'] = not render_view or bool(cfg.get('materialPlan'))
    combined, (protected,conflict,written,valid) = composite(cfg,4 if draft else 1)
    shape = combined.shape[:2]
    base = enabled_base(cfg['paint'])
    out.mkdir(parents=True,exist_ok=False)
    names = {('f_16xl_BaseColor.png' if name=='color' else 'f_16xl_'+name+'.png'):combined[:,:,part] for name,part in CHANNELS.items()}
    files = {}
    for name,pixels in names.items():
        Image.fromarray(pixels).save(out/name)
        files[name] = hashlib.sha256((out/name).read_bytes()).hexdigest()
    graph_files = {}
    if '_graphPaint' in cfg:
        original = cfg.pop('_graphPaint').reshape((*shape,14))[::-1]
        for channel,part in CHANNELS.items():
            name = 'node-paint-'+channel+'.png'
            Image.fromarray(original[:,:,part]).save(out/name)
            graph_files[name] = hashlib.sha256((out/name).read_bytes()).hexdigest()
    if not render_view:
        Image.new('RGB',(shape[1],shape[0]),base['color']).save(out/'base.png')
        for name in CHANNELS:
            if name!='color':
                value=base.get(name,DEFAULTS[name])
                Image.new('RGB' if name in RGB else 'L',(shape[1],shape[0]),value if name in RGB else round(value*255)).save(out/f'base-{name}.png')
        status = diagnostic_codes(protected,conflict,written)
        palette = np.array([[0,0,0],[232,92,72],[235,169,60],[63,215,182]],dtype=np.uint8)
        Image.fromarray(palette[status].reshape((*shape,3))[::-1]).save(out/'coverage.png')
    report = {**({'bakeFingerprint':cfg['bakeFingerprint']} if cfg.get('bakeFingerprint') else {}),
              **({'modelFingerprint':cfg['modelFingerprint']} if cfg.get('modelFingerprint') else {}),
              **({'materialFingerprint':cfg['materialFingerprint'],'graphSourceFiles':graph_files} if cfg.get('materialFingerprint') else {}),
              'activeChannels':cfg.get('activeChannels',list(CHANNELS)),
              'revision':cfg['revision'],'bindingFingerprint':cfg['bindingFingerprint'],'files':files,
              'assetFingerprints':list(cfg['assets']),'resolution':list(shape),'draft':draft,'uv_unchanged':True,
              'writtenTexels':int(written.sum()),'eligibleTexels':int(valid.sum()),'protectedTexelsWritten':int((written&protected).sum()),
              'conflictTexelsWritten':int((written&conflict).sum()),'conflictTexels':int(conflict.sum())}
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')


def diagnostic_codes(protected,conflict,written):
    status = np.zeros(len(written),dtype=np.uint8)
    status[protected] = 1
    status[conflict] = 2
    status[written] = 3
    return status


def live_pixels(cfg):
    if cfg.get('imageDocumentId'):
        doc=cfg['paint']['imageDocuments'][cfg['imageDocumentId']]
        if cfg.get('isolatedImageLayer'):doc={**doc,'layers':[l for l in doc['layers'] if l['id']==cfg['isolatedImageLayer']]}
        pixels=composite_document(doc,cfg['assets'],cfg['liveResolution'],cfg.get('imageInspectMask'))
        if cfg.get('clipboardRegion'):
            return clipboard_png(pixels,cfg['clipboardRegion'],doc['colorSpace'])
        if cfg.get('imagePng'):
            return png_bytes(pixels,doc['colorSpace'])
        return pixels.tobytes()
    step = 4096//cfg.get('liveResolution',256)
    pixels,(protected,conflict,written,eligible) = composite(cfg,step)
    codes = diagnostic_codes(protected,conflict,written)
    if cfg.get('uvGuide'):
        codes[eligible] |= 4
    codes = codes.reshape(pixels.shape[:2])[::-1]
    parts=[pixels[:,:,:5],codes[:,:,None]]
    if cfg.get('liveFormat')=='pbr8':parts.append(pixels[:,:,5:])
    return np.concatenate(parts,axis=2).tobytes()


def interactive():
    for line in sys.stdin:
        request = json.loads(line)
        try:
            cfg = request['config']
            if 'pickUv' in cfg:
                source = cfg['source']
                atlas = picking_atlas(source['cacheRun'],source['material'],cfg['bindingFingerprint'])
                u,v = cfg['pickUv']
                height,width = atlas.shape
                data = bytes([atlas[min(height-1,int((1-v)*height)),min(width-1,int(u*width))]])
            else:
                data = live_pixels(cfg)
            reply = {'pixels':base64.b64encode(data).decode('ascii')}
        except Exception as error:
            reply = {'error':str(error)}
        print(json.dumps({'id':request['id'],**reply}),flush=True)


if __name__=='__main__':
    if sys.argv[1]=='--live-detail':
        config = json.loads(sys.stdin.buffer.read())
        try:
            sys.stdout.buffer.write(live_pixels(config))
        except ValueError as error:
            print(str(error), file=sys.stderr)
            sys.exit(1)
    elif sys.argv[1]=='--interactive':
        interactive()
    else:
        main(json.loads(Path(sys.argv[1]).read_bytes()))
