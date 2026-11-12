"""Raster operations that sample the active pixel layer at the time of the edit."""
import numpy as np


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
    if stroke.get('feather'):
        matching &= surface._feathered_selection(rect, stroke)>0
    elif 'polygon' in stroke or 'regions' in stroke:
        matching &= surface._selection_tile(rect, stroke)
    if flood['contiguous']:
        matching = connected_area(matching, row-row0, column-col0)
    flat = np.flatnonzero(matching)
    rows, columns = np.divmod(flat, width_tile)
    ids = ((rows+row0)*width+columns+col0).astype(np.int32)
    weights = np.full(len(ids), stroke['opacity'], dtype=np.float32)
    if stroke.get('feather'):
        weights *= surface._feathered_selection(rect, stroke)[rows, columns]/255
    return surface._paint_strokes([stroke], {'color':True}, color, affected, paint, lambda _:(ids, weights))


def clone_layer(surface, affected, paint, stroke):
    if not len(affected) or 'color' not in paint:
        return affected, paint
    ids, brush = surface.stroke(stroke)
    dx, dy = stroke['clone']['offset']
    visible = paint['color'][0] > 0
    samples = []
    # Sample the entire stroke before writing any pixel. When source and
    # destination overlap, the brush cannot pick up its own new pixels.
    for start in range(0, len(ids), 131072):
        end = start+131072
        batch, coverage = ids[start:end], brush[start:end]
        u, v = surface._texel_uv(batch)
        _, sampled = surface._sample_uv_paint(u+dx, v+dy, affected, visible, paint)
        alpha, premult = sampled['color']
        keep = alpha > 0
        if np.any(keep):
            weight = coverage[keep]
            samples.append((batch[keep], alpha[keep]*weight, premult[keep]*weight[:, None]))
    if not samples:
        return affected, paint
    preserve = stroke.get('preserveAlpha')
    if not preserve:
        affected, paint = surface._expand_paint(affected, paint, np.concatenate([tile[0] for tile in samples]))
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
