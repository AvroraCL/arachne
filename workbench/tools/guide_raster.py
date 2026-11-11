"""Rasterize a mesh into orthographic guide buffers."""
import numpy as np


def to_display(linear):
    linear = np.clip(linear, 0, 1)
    return np.where(linear <= .0031308, 12.92*linear, 1.055*linear**(1/2.4)-.055)


def raster(points, shading, normals, protected_faces, valid_uv, meta, view, options, res, power, cutoff):
    center = np.asarray(meta['center'], dtype=np.float64)
    right, up, direction = [np.asarray(view[k], dtype=np.float64) for k in ('right', 'up', 'dir')]
    delta = points - center
    u = delta @ right / view['span'] + .5
    v = delta @ up / view['span'] + .5
    if options.get('flip_u', False):
        u = 1-u
    if options.get('flip_v', False):
        v = 1-v
    projected = np.stack([u*(res-1), (1-v)*(res-1)], axis=2)
    depths = delta @ direction
    camera_depth = (np.asarray(view['cam_loc'])-center) @ direction
    if np.any(depths >= camera_depth - 1e-7):
        raise RuntimeError('Camera is not in front of all geometry; move cam_loc farther away')
    depth = np.full((res, res), -np.inf, dtype=np.float64)
    owner = np.full((res, res), -1, dtype=np.int32)
    facing = np.zeros((res, res), dtype=np.float32)
    cosines = normals @ direction
    visible_triangles = np.zeros(len(points), dtype=bool)
    for index, xy in enumerate(projected):
        lo = np.maximum(np.floor(xy.min(axis=0)).astype(int), 0)
        hi = np.minimum(np.ceil(xy.max(axis=0)).astype(int), res-1)
        if np.any(hi < lo):
            continue
        denominator = (xy[1,1]-xy[2,1])*(xy[0,0]-xy[2,0])+(xy[2,0]-xy[1,0])*(xy[0,1]-xy[2,1])
        if abs(denominator) < 1e-12:
            continue
        xx, yy = np.meshgrid(np.arange(lo[0], hi[0]+1), np.arange(lo[1], hi[1]+1))
        a = ((xy[1,1]-xy[2,1])*(xx-xy[2,0])+(xy[2,0]-xy[1,0])*(yy-xy[2,1]))/denominator
        b = ((xy[2,1]-xy[0,1])*(xx-xy[2,0])+(xy[0,0]-xy[2,0])*(yy-xy[2,1]))/denominator
        c = 1-a-b
        inside = (a >= -1e-7) & (b >= -1e-7) & (c >= -1e-7)
        if not inside.any():
            continue
        x, y = xx[inside], yy[inside]
        weights = np.stack([a[inside], b[inside], c[inside]], axis=1)
        z = weights @ depths[index]
        closer = z > depth[y, x] + 1e-9
        if not closer.any():
            continue
        x, y, z, weights = x[closer], y[closer], z[closer], weights[closer]
        normal = weights @ shading[index]
        lengths = np.linalg.norm(normal, axis=1)
        bad = lengths < 1e-10
        normal[bad] = normals[index]
        normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-10)
        # Absolute shading normal is deliberately a display-only facing measure;
        # receiver eligibility uses signed, flat polygon normals like geometry.py.
        face_value = np.abs(normal @ direction)
        depth[y, x] = z
        owner[y, x] = index
        facing[y, x] = to_display(face_value**power)
        if index and index % 25000 == 0:
            print('raster %d/%d' % (index, len(points)), flush=True)
    silhouette = owner >= 0
    indices = owner[silhouette]
    visible_triangles[indices] = True
    protection = np.zeros_like(silhouette)
    receiver = np.zeros_like(silhouette)
    protection[silhouette] = protected_faces[indices]
    receiver[silhouette] = (~protected_faces[indices]) & valid_uv[indices] & (cosines[indices] > 1e-6) & (cosines[indices] >= cutoff)
    display = np.rint(np.clip(facing, 0, 1)*255).astype(np.uint8)
    return {'silhouette': silhouette.astype(np.uint8)*255, 'facing': display,
            'protected': protection.astype(np.uint8)*255, 'receiver': receiver.astype(np.uint8)*255,
            'layout_guide': np.where(receiver, display, 0).astype(np.uint8)}, {
                'owner': owner, 'depth': np.where(silhouette, depth, np.nan).astype(np.float32)}, {
                'covered_pixels': int(silhouette.sum()), 'protected_visible_pixels': int(protection.sum()),
                'receiver_hint_pixels': int(receiver.sum()), 'visible_triangles': int(visible_triangles.sum()),
                'triangles_crossing_frame': int(np.any((projected < 0) | (projected > res-1), axis=(1,2)).sum()),
                'raster_rule': 'integer pixel grid / (resolution-1), first triangle wins equal-depth ties'}
