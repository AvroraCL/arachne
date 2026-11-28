"""Raster operations that sample the active pixel layer at the time of the edit."""
import numpy as np
from paint_kernel import connected_area_kernel


def rgba_bytes(alpha, premult, encode):
    rgb = np.divide(premult, alpha[:, None], out=np.zeros_like(premult), where=alpha[:, None]>0)
    if encode:
        rgb = encode(rgb)
    return np.rint(np.clip(np.column_stack((rgb, alpha)), 0, 1)*255).astype(np.int16)


def connected_area(matching, row, column):
    if not matching[row, column]:
        return np.zeros_like(matching)
    if matching.all():
        return matching
    if (native := connected_area_kernel()) is not None:
        return native(matching,row,column)
    reached = np.zeros_like(matching)
    run_cache = {}
    todo = []

    def visit(y, left, right):
        if y not in run_cache:
            edges = np.flatnonzero(np.diff(matching[y], prepend=False, append=False))
            run_cache[y] = edges[::2], edges[1::2]
        starts, ends = run_cache[y]
        first = np.searchsorted(ends, left, side='right')
        stop = np.searchsorted(starts, right)
        for start, end in zip(starts[first:stop], ends[first:stop]):
            if not reached[y, start]:
                reached[y, start:end] = True
                todo.append((y, start, end))

    visit(row, column, column+1)
    while todo:
        y, left, right = todo.pop()
        if y > 0:
            visit(y-1, left, right)
        if y+1 < len(matching):
            visit(y+1, left, right)
    return reached


def flood_layer(surface, affected, paint, stroke, color, encode):
    flood = stroke['flood']
    height, width = surface.uv_shape
    u, v = flood['point']
    column = min(width-1, int(u*width))
    row = height-1-min(height-1, int(v*height))
    seed = row*width+column
    rect = stroke.get('clip', (0, 0, 1, 1))
    row0, row1, col0, col1 = surface._selection_bounds(rect, stroke)
    if not (row0<=row<row1 and col0<=column<col1):
        return affected, paint
    tolerance = flood['tolerance']
    sample = np.zeros(4, dtype=np.int16)
    alpha, premult = paint.get('color', (None, None))
    index = np.searchsorted(affected, seed)
    if alpha is not None and index < len(affected) and affected[index] == seed:
        sample = rgba_bytes(alpha[index:index+1], premult[index:index+1], encode)[0]
    width_tile = col1-col0
    matching = np.full((row1-row0, width_tile), np.max(np.abs(sample))<=tolerance, dtype=bool)
    if alpha is not None:
        first, last = np.searchsorted(affected, [row0*width, row1*width])
        for start in range(first, last, 131072):
            stop = min(start+131072, last)
            rows, columns = np.divmod(affected[start:stop], width)
            valid = (columns>=col0)&(columns<col1)
            colors = rgba_bytes(alpha[start:stop][valid], premult[start:stop][valid], encode)
            matching[rows[valid]-row0, columns[valid]-col0] = (np.abs(colors-sample)<=tolerance).all(axis=1)
    soft = None
    if stroke.get('feather'):
        soft = surface._feathered_selection(rect, stroke)
    elif 'coverage' in stroke:
        soft = surface._selection_bytes(rect, stroke)
    if soft is not None:
        matching &= soft > 0
    elif 'polygon' in stroke or 'regions' in stroke:
        matching &= surface._selection_tile(rect, stroke)
    if flood['contiguous']:
        matching = connected_area(matching, row-row0, column-col0)
    flat = np.flatnonzero(matching)
    rows, columns = np.divmod(flat, width_tile)
    ids = ((rows+row0)*width+columns+col0).astype(np.int32)
    weights = np.full(len(ids), stroke['opacity'], dtype=np.float32)
    if soft is not None:
        weights *= soft[rows, columns]/255
    return surface._paint_strokes([(stroke, ids, weights)], {'color':True}, color, affected, paint)


def clone_layer(surface, affected, paint, stroke, source=None, healing=None):
    if source is None and (not len(affected) or 'color' not in paint):
        return affected, paint
    if stroke.get('preserveAlpha') and not len(affected):
        return affected, paint
    ids, brush = surface.stroke(stroke)
    dx, dy = stroke['clone']['offset']
    visible = paint['color'][0] > 0 if source is None else None
    samples = []
    # Sample the entire stroke before writing any pixel. When source and
    # destination overlap, the brush cannot pick up its own new pixels.
    for start in range(0, len(ids), 131072):
        end = start+131072
        batch, coverage = ids[start:end], brush[start:end]
        u, v = surface._texel_uv(batch)
        if healing is not None:
            alpha, premult = healing(u,v)
        elif source is None:
            _, sampled = surface._sample_uv_paint(u+dx, v+dy, affected, visible, paint)
            alpha, premult = sampled['color']
        else:
            alpha, premult = sample_clone_source(surface, source, u+dx, v+dy)
        keep = alpha > 0
        if np.any(keep):
            weight = coverage[keep]
            samples.append((batch[keep], alpha[keep]*weight, premult[keep]*weight[:, None]))
    if not samples:
        return affected, paint
    preserve = stroke.get('preserveAlpha')
    if not preserve:
        affected, paint = surface._expand_paint(affected, paint, np.concatenate([tile[0] for tile in samples]))
    if 'color' not in paint:
        paint['color'] = (np.zeros(len(affected), dtype=np.float32), np.zeros((len(affected), 3), dtype=np.float32))
    alpha, premult = paint['color']
    for targets, opacity, color in samples:
        index = np.searchsorted(affected, targets)
        if preserve:
            index = np.minimum(len(affected)-1, index)
            keep = affected[index] == targets
            index, opacity, color = index[keep], opacity[keep], color[keep]
            premult[index] = premult[index]*(1-opacity[:, None])+color*alpha[index, None]
        else:
            premult[index] = premult[index]*(1-opacity[:, None])+color
            alpha[index] = alpha[index]*(1-opacity)+opacity
    return affected, paint


def sample_bilinear(height, width, pixels, u, v):
    x, y = u*width-.5, (1-v)*height-.5
    left, top = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x-left, y-top
    result = np.zeros((len(u), 4), dtype=np.float32)
    for col, wx in ((left, 1-fx), (left+1, fx)):
        for row, wy in ((top, 1-fy), (top+1, fy)):
            valid = (col>=0)&(col<width)&(row>=0)&(row<height)
            result[valid] += pixels(row[valid],col[valid]) * (wx[valid]*wy[valid])[:, None]
    return result[:, 3], result[:, :3]


def sample_clone_source(surface, source, u, v):
    height,width = surface.uv_shape
    return sample_bilinear(height,width,lambda row,col:source[row*width+col],u,v)


def sample_repair_source(source,u,v):
    pixels,decode = source
    height,width = pixels.shape[:2]

    def premultiply(row,col):
        hits = pixels[row,col]
        alpha = hits[:,3].astype(np.float32)/255
        return np.column_stack((decode[hits[:,:3]]*alpha[:,None],alpha))

    return sample_bilinear(height,width,premultiply,u,1-v)


def healing_inputs(surface, stroke, source, backdrop):
    kind = stroke['clone']['kind']
    radius = stroke['radius']
    if kind == 'heal':
        stamps = np.array([stamp[:2] for stamp in stroke['stamps']])
        dx,dy = stroke['clone']['offset']
        phase = np.linspace(0, 2*np.pi, 24, endpoint=False)
        ring = np.column_stack((np.cos(phase),np.sin(phase)))*radius*1.5
        center = np.mean(stamps,axis=0)
        u,v = (center+ring).T
        sampled_alpha,sampled = sample_repair_source(source,u+dx,v+dy)
        target_alpha,target = sample_repair_source(backdrop,u,v)
        valid = (sampled_alpha>.1)&(target_alpha>.1)
        correction = np.median(target[valid]/target_alpha[valid,None]-sampled[valid]/sampled_alpha[valid,None],axis=0) if valid.any() else np.zeros(3)

        def heal(u,v):
            alpha,premult = sample_repair_source(source,u+dx,v+dy)
            target_alpha,_ = sample_repair_source(backdrop,u,v)
            rgb = np.divide(premult,alpha[:,None],out=np.zeros_like(premult),where=alpha[:,None]>0)
            # Restore local tone while preserving the sampled detail.
            weight = np.minimum(alpha,target_alpha)
            return weight,np.clip(rgb+correction,0,1)*weight[:,None]
        return heal

    # Find clean pixels on opposite sides of the stroke. Prefer the pair with
    # similar color, which follows existing stripes and edges where possible.
    ids,_ = surface.stroke({key:value for key,value in stroke.items() if key not in ('clip','coverage','regions','polygon','feather')})
    height,width = surface.uv_shape
    occupied = np.zeros((height,width),dtype=bool)
    occupied.flat[ids] = True
    pixels,decode = source
    source_h,source_w = pixels.shape[:2]

    def nearby(u,v,dx,dy):
        color = np.zeros((len(u),3),dtype=np.float32)
        reach = np.zeros(len(u),dtype=np.float32)
        for step in (1,1.5,2.25,3.5,5):
            x,y = u+dx*step,v+dy*step
            col,row = np.floor(x*width).astype(int),np.floor((1-y)*height).astype(int)
            indices = np.flatnonzero((reach==0)&(col>=0)&(col<width)&(row>=0)&(row<height))
            indices = indices[~occupied[row[indices],col[indices]]]
            hits = pixels[np.floor(y[indices]*source_h).astype(int).clip(0,source_h-1),
                          np.floor(x[indices]*source_w).astype(int).clip(0,source_w-1)]
            visible = hits[:,3]>=26
            indices = indices[visible]
            color[indices] = decode[hits[visible,:3]]
            reach[indices] = step
            if np.all(reach>0):
                break
        return color,reach

    def spot(u,v):
        alpha,_ = sample_repair_source(source,u,v)
        score = np.full(len(u),np.inf,dtype=np.float32)
        result = np.zeros((len(u),3),dtype=np.float32)
        for x,y in ((1,0),(0,1),(.707,.707),(.707,-.707)):
            c,d = nearby(u,v,x*radius,y*radius)
            e,f = nearby(u,v,-x*radius,-y*radius)
            good = (d>0)&(f>0)
            cost = np.linalg.norm(c-e,axis=1)+.012*(d+f)
            keep = good&(cost<score)
            score[keep] = cost[keep]
            result[keep] = (c[keep]*f[keep,None]+e[keep]*d[keep,None])/(d[keep]+f[keep])[:,None]
        weight = alpha*np.isfinite(score)
        return weight,result*weight[:,None]
    return spot
