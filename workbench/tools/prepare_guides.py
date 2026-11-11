"""Blender worker: deterministic orthographic z-buffer and generation guide pack.

Reads raw mesh data in a separate process; never saves a model or modifies UVs.
Pixel coordinates are the exact normalized coordinates used by bake.py, including
independent horizontal/vertical flips (a single flip is a mirror, not a camera roll).
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from projection_scope import is_protected


def uv_digest(objects):
    h = hashlib.sha256()
    for obj in sorted(objects, key=lambda item: item.name):
        h.update(obj.name.encode('utf-8'))
        for layer in obj.data.uv_layers:
            h.update(layer.name.encode('utf-8'))
            for item in layer.data:
                h.update(struct.pack('<ff', *item.uv))
    return h.hexdigest()


def save_png(path, data):
    """Use Blender's image encoder; worker does not require Pillow in Blender."""
    rgb = np.repeat(data[:, :, None], 3, axis=2) if data.ndim == 2 else data
    rgba = np.concatenate([rgb.astype(np.float32)/255, np.ones((*rgb.shape[:2], 1), dtype=np.float32)], axis=2)
    # Blender image buffers start at bottom left. Non-float buffers hold display
    # values directly; save() does not apply scene lighting or view transforms.
    image = bpy.data.images.new(path.stem, width=rgb.shape[1], height=rgb.shape[0], alpha=True, float_buffer=False)
    image.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).ravel())
    image.filepath_raw = str(path)
    image.file_format = 'PNG'
    image.save()
    bpy.data.images.remove(image)


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


def main():
    out = Path(sys.argv[sys.argv.index('--')+1]).resolve()
    cfg = json.loads((out/'resolved_config.json').read_text(encoding='utf-8'))
    meta = json.loads((out/'cameras.json').read_text(encoding='utf-8'))
    if Path(cfg['model']).suffix.lower() == '.obj':
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.wm.obj_import(filepath=cfg['model'])
    else:
        bpy.ops.wm.open_mainfile(filepath=cfg['model'], load_ui=False)
    all_meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    include = cfg.get('include_objects')
    if include and set(include)-{obj.name for obj in all_meshes}:
        raise RuntimeError('Missing included object(s): ' + ', '.join(sorted(set(include)-{o.name for o in all_meshes})))
    objects = [obj for obj in all_meshes if (not include or obj.name in include) and
               not any(word in obj.name for word in cfg['exclude_contains'])]
    if not objects:
        raise RuntimeError('No participating mesh objects')
    excluded = set(cfg['projection_exclude_objects'])
    region_objects = {n for r in cfg['projection_exclude_regions'] for n in r.get('objects', [])}
    missing = (excluded | region_objects)-{o.name for o in objects}
    if missing:
        raise RuntimeError('Protection references missing participating object(s): ' + ', '.join(sorted(missing)))
    excluded_materials=set(cfg.get('projection_exclude_materials',[]))
    material_names={slot.material.name for obj in objects for slot in obj.material_slots if slot.material}
    if excluded_materials-material_names:
        raise RuntimeError('Protection references missing participating material(s): '+', '.join(sorted(excluded_materials-material_names)))
    before = uv_digest(objects)
    positions, shading, normals, protected, uv_valid, object_ids, polygon_ids = [], [], [], [], [], [], []
    for oi, obj in enumerate(objects):
        if any(mod.show_viewport for mod in obj.modifiers) or obj.instance_type != 'NONE':
            raise RuntimeError('Apply geometry modifiers/instances in a separate asset copy first: ' + obj.name)
        mesh = obj.data
        layer = mesh.uv_layers.active if cfg['uv_layer'] == 'active' else mesh.uv_layers.get(cfg['uv_layer'])
        if layer is None:
            raise RuntimeError('Missing UV layer: ' + obj.name)
        mesh.calc_loop_triangles()
        transform = obj.matrix_world
        normal_transform = transform.to_3x3().inverted().transposed()
        flip = False
        if cfg['normal_policy'] == 'signed_volume':
            bm = bmesh.new()
            bm.from_mesh(mesh)
            try:
                flip = bm.calc_volume(signed=True) < 0
            finally:
                bm.free()
        sign = -1 if flip else 1
        vertices = np.asarray([tuple(transform @ vertex.co) for vertex in mesh.vertices], dtype=np.float64)
        vertex_normals = np.asarray([tuple((normal_transform @ vertex.normal).normalized()) for vertex in mesh.vertices], dtype=np.float64)*sign
        for triangle in mesh.loop_triangles:
            poly = mesh.polygons[triangle.polygon_index]
            pts = vertices[list(triangle.vertices)]
            uv = np.asarray([tuple(layer.data[loop].uv) for loop in triangle.loops])
            positions.append(pts)
            shading.append(vertex_normals[list(triangle.vertices)])
            normals.append(tuple((normal_transform @ poly.normal).normalized()*sign))
            mat=obj.material_slots[poly.material_index].material if poly.material_index<len(obj.material_slots) else None
            material_protected=mat is not None and mat.name in excluded_materials
            protected.append(material_protected or is_protected(obj.name, pts, excluded, cfg['projection_exclude_regions']))
            uv_valid.append(bool(np.isfinite(uv).all() and (uv >= 0).all() and (uv <= 1).all()))
            object_ids.append(oi)
            polygon_ids.append(triangle.polygon_index)
    if not positions:
        raise RuntimeError('No triangles')
    positions, shading, normals = [np.asarray(a, dtype=np.float64) for a in (positions, shading, normals)]
    protected, uv_valid = np.asarray(protected, dtype=bool), np.asarray(uv_valid, dtype=bool)
    print('guide geometry objects=%d triangles=%d' % (len(objects), len(positions)), flush=True)
    np.savez_compressed(out/'surfaces.npz', positions=positions, shading_normals=shading,
                        polygon_normals=normals, object_ids=np.asarray(object_ids, dtype=np.int32),
                        polygon_ids=np.asarray(polygon_ids, dtype=np.int32), protected=protected, uv_valid=uv_valid)
    report = {'blender': bpy.app.version_string, 'resolution': cfg['resolution'],
              'objects': [o.name for o in objects], 'triangles': len(positions),
              'protected_triangles': int(protected.sum()), 'invalid_uv_triangles': int((~uv_valid).sum()),
              'facing_formula': 'sRGB(abs(dot(normalized barycentric vertex normal, view.dir)) ** facing_power)',
              'facing_power': cfg['guide']['facing_power'],
              'receiver_formula': 'visible pixel AND valid 0-1 UV AND NOT protected AND polygon_normal.dot(view.dir)>0 AND >=min_projection_cos',
              'limitations': ['Facing is orientation, not intrinsic curvature, lighting, or guaranteed distortion safety.',
                  'Receiver is a pixel-visible hint; transfer uses face-center visibility and may reject additional points.',
                  'Protected mask shows only visible geometry; shared-UV protection and UV conflicts remain transfer-stage checks.',
                  'Vertex-averaged facing is illustrative and can smooth sharp features; flat polygon normals control eligibility.',
                  'Raw meshes only; modifiers/instances are rejected. No cross-run cache reuse is implemented.'], 'views': {}}
    for name, options in cfg['designs'].items():
        target = out / name
        target.mkdir()
        images, buffers, view_report = raster(positions, shading, normals, protected, uv_valid,
            meta, meta['views'][name], options, cfg['resolution'], cfg['guide']['facing_power'], cfg['min_projection_cos'])
        for key, image in images.items():
            save_png(target/(key+'.png'), image)
        np.savez_compressed(target/'raster.npz', **buffers)
        view_report['camera'] = meta['views'][name]
        view_report['flip_u'] = options.get('flip_u', False)
        view_report['flip_v'] = options.get('flip_v', False)
        view_report['warnings'] = []
        if not view_report['covered_pixels']:
            view_report['warnings'].append('No visible pixels; check view and camera span')
        if not view_report['receiver_hint_pixels']:
            view_report['warnings'].append('No eligible visible pixels; check normals and scope')
        if view_report['triangles_crossing_frame']:
            view_report['warnings'].append('Some geometry is outside the image frame')
        report['views'][name] = view_report
        print('saved view', name, view_report['covered_pixels'], 'pixels', flush=True)
    after = uv_digest(objects)
    if before != after:
        raise RuntimeError('UV changed during guide preparation')
    report.update(uv_before_sha256=before, uv_after_sha256=after, uv_unchanged=True)
    (out/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
