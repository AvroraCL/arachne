"""Editable mesh-space masks evaluated on the registered UV samples."""
from collections import OrderedDict
import numpy as np


def smooth(value):
    value = np.clip(value, 0, 1)
    return value * value * (3 - 2 * value)


def extent(surface):
    return max(float(np.max(surface.high - surface.low)), 1e-8)


def crease_angles(surface):
    triangles = surface.target_triangles
    result = np.zeros((len(triangles), 3), dtype=np.float32)
    if not len(triangles):
        return result
    tolerance = extent(surface) * 1e-6
    # Weld coincident corners within each object so an authored UV seam does
    # not create a false edge. Coincident edges on separate objects stay apart.
    quantized = np.rint((triangles - surface.low) / tolerance).astype(np.int64).reshape(-1, 3)
    keys = np.column_stack((np.repeat(surface.objects, 3), quantized))
    vertices = np.unique(keys, axis=0, return_inverse=True)[1].reshape(-1, 3)
    starts, ends = vertices.ravel(), np.roll(vertices, -1, axis=1).ravel()
    low, high = np.minimum(starts, ends), np.maximum(starts, ends)
    order = np.lexsort((high, low))
    ordered_low, ordered_high = low[order], high[order]
    breaks = np.flatnonzero((ordered_low[1:] != ordered_low[:-1]) | (ordered_high[1:] != ordered_high[:-1])) + 1
    groups = np.r_[0, breaks, len(order)]
    pair_starts = groups[:-1][np.diff(groups) == 2]
    first, second = order[pair_starts], order[pair_starts + 1]
    paired = (first // 3 != second // 3) & (low[first] != high[first])
    first, second = first[paired], second[paired]
    for start in range(0, len(first), 100000):
        a, b = first[start:start+100000], second[start:start+100000]
        i, j, ai, bj = a//3, b//3, a%3, b%3
        na, nb = surface.normals[i], surface.normals[j]
        cosine = np.clip(np.einsum('ij,ij->i', na, nb), -1, 1)
        angle = np.degrees(np.arccos(cosine))
        offset_a = np.einsum('ij,ij->i', triangles[j,(bj+2)%3] - triangles[i,ai], na)
        offset_b = np.einsum('ij,ij->i', triangles[i,(ai+2)%3] - triangles[j,bj], nb)
        turn = np.where((offset_a < -tolerance) & (offset_b < -tolerance), angle,
                        np.where((offset_a > tolerance) & (offset_b > tolerance), -angle, 0))
        result[i,ai] = result[j,bj] = turn
    return result


def edge_wear(surface, indexes, effect):
    if not hasattr(surface, 'crease_angles'):
        surface.crease_angles = crease_angles(surface)
    owners, points = surface.owner[indexes], surface.xyz[indexes]
    width = effect['width'] * .01 * extent(surface)
    output = np.zeros(len(indexes), dtype=np.float32)
    for side in range(3):
        angles = surface.crease_angles[owners, side]
        direction = effect['edge']
        angle = np.abs(angles) if direction == 'both' else angles if direction == 'convex' else -angles
        near = np.flatnonzero(angle >= effect['angle'])
        if not len(near):
            continue
        triangles = surface.target_triangles[owners[near]]
        edge = triangles[:, (side+1)%3] - triangles[:, side]
        delta = points[near] - triangles[:, side]
        along = np.clip(np.einsum('ij,ij->i', delta, edge) / np.maximum(1e-30, np.einsum('ij,ij->i',edge,edge)), 0, 1)
        distance = np.linalg.norm(delta - along[:, None]*edge, axis=1)
        value = smooth((1 - distance/width) / effect['softness'])
        output[near] = np.maximum(output[near], value)
    return output


def hash_cell(x, y, z, seed):
    value = x * np.uint32(374761393) ^ y * np.uint32(668265263) ^ z * np.uint32(2246822519) ^ np.uint32(seed)
    value = (value ^ (value >> np.uint32(13))) * np.uint32(1274126177)
    return ((value ^ (value >> np.uint32(16))) >> np.uint32(8)).astype(np.float32) / np.float32(16777215)


def surface_noise(surface, indexes, effect):
    coordinate = (surface.xyz[indexes] - surface.low) * (effect['scale'] / extent(surface))
    cells = np.floor(coordinate)
    x,y,z = cells.T.astype(np.uint32)
    fx,fy,fz = smooth(coordinate - cells).T
    value = np.zeros(len(indexes), dtype=np.float32)
    for dx, wx in ((0,1-fx),(1,fx)):
        for dy, wy in ((0,1-fy),(1,fy)):
            for dz, wz in ((0,1-fz),(1,fz)):
                value += wx*wy*wz*hash_cell(x+dx,y+dy,z+dz,effect['seed'])
    return smooth((value - effect['threshold']) / effect['softness'] + .5)


def preview_generator(surface, indexes, effect):
    kind = effect['kind']
    generate = edge_wear if kind == 'edgeWear' else surface_noise
    # Full-resolution baking stays tiled. Only small interactive surfaces
    # hold generated masks so new brush strokes reuse unchanged effects.
    if surface.allowed.size > 256 * 256:
        return generate(surface, indexes, effect)
    fields = ('edge', 'angle', 'width', 'softness') if kind == 'edgeWear' else ('scale', 'seed', 'threshold', 'softness')
    key = (kind, *(effect[field] for field in fields))
    cache = getattr(surface, 'preview_generators', None)
    if cache is None:
        surface.preview_generators = cache = OrderedDict()
    if key in cache:
        cache.move_to_end(key)
        return cache[key][indexes]
    if len(indexes) < 4096:
        return generate(surface, indexes, effect)
    eligible = np.flatnonzero(surface.allowed)
    values = np.zeros(surface.allowed.size, dtype=np.float32)
    values[eligible] = generate(surface, eligible, effect)
    if len(cache) >= 12:
        cache.popitem(last=False)
    cache[key] = values
    return values[indexes]
