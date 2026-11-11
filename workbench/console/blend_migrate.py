"""One-shot Blender worker: export and audit a registered legacy paint surface."""
import hashlib
import json
import runpy
import struct
import sys
from pathlib import Path

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from model_topology import Glb


def sorted_triangles(corners):
    # Compare position+UV for each triangle independent of corner order and
    # Blender's splitting of shared vertices across normals and UV seams.
    flat = corners.reshape(-1, 3, 5).copy()
    rows = np.indices(flat.shape[:2])[0]
    flat = flat[rows, np.lexsort(flat.transpose(2,0,1)[::-1])]
    rows = flat.reshape(-1,15)
    return rows[np.lexsort(rows.T[::-1])]


def source_triangles(obj, uv_name, material):
    mesh = obj.data
    layer = mesh.uv_layers.active if uv_name == 'active' else mesh.uv_layers.get(uv_name)
    if layer is None:
        raise ValueError(f'{obj.name}: 找不到已登记的 UV 图层')
    mesh.calc_loop_triangles()
    triangles = []
    for tri in mesh.loop_triangles:
        i = mesh.polygons[tri.polygon_index].material_index
        mat = obj.material_slots[i].material if i < len(obj.material_slots) else None
        if mat is None or mat.name != material:
            continue
        corners = []
        for vi, li in zip(tri.vertices,tri.loops):
            x,y,z = mesh.vertices[vi].co
            u,v = layer.data[li].uv
            corners.append((x,z,-y,u,1.0-v))
        triangles.append(corners)
    return np.asarray(triangles,dtype=np.float32)


def main(config):
    # Reuse the existing exporter so an existing model history can keep its
    # exact node and primitive indices. This invocation never saves the .blend.
    runpy.run_path(str(ROOT/'viewport_export.py'),run_name='__main__')
    out = Path(config['out'])
    settings = config['settings']
    included = settings.get('include_objects') or None
    exclude = settings.get('exclude_contains',[])
    objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    registered = [obj for obj in objects if (not included or obj.name in included) and
                  not any(term in obj.name for term in exclude)]
    legacy = hashlib.sha256()
    for obj in sorted(registered,key=lambda obj:obj.name):
        legacy.update(obj.name.encode())
        for layer in obj.data.uv_layers:
            legacy.update(layer.name.encode())
            for loop in layer.data:
                legacy.update(struct.pack('<ff',*loop.uv))
    if legacy.hexdigest() != config['legacyUV']:
        raise ValueError('旧模型与登记时的原 UV 指纹不一致')

    baseline = out/'model.glb'
    glb = Glb(baseline)
    expected = config.get('baselineSha256')
    if expected and hashlib.sha256(glb.data).hexdigest()!=expected and config.get('baseline'):
        cached = Glb(Path(config['baseline']))
        if hashlib.sha256(cached.data).hexdigest()==expected:
            baseline.write_bytes(cached.data)
            glb = cached
    digest = hashlib.sha256(glb.data).hexdigest()
    if expected and digest != expected:
        raise ValueError('无法确认旧建模记录的网格编号；原工程未修改')

    target = config['material']
    target_ids = {i for i,m in enumerate(glb.doc['materials'])
                  if m.get('extras',{}).get('sourceMaterial',m.get('name')) == target}
    if len(target_ids)!=1:
        raise ValueError('无法唯一定位旧工程的涂装材质')
    nodes = {node['name']:node for node in glb.doc['nodes'] if 'mesh' in node and 'name' in node}
    uv_channels, count = set(),0
    for obj in registered:
        source = source_triangles(obj,settings.get('uv_layer','active'),target)
        if not len(source):
            continue
        if obj.name not in nodes:
            raise ValueError(f'{obj.name}: GLB 缺少已登记的涂装网格')
        primitives = [p for p in glb.doc['meshes'][nodes[obj.name]['mesh']]['primitives']
                      if p.get('material') in target_ids]
        if not primitives:
            raise ValueError(f'{obj.name}: GLB 缺少已登记的涂装材质')
        candidates = set.intersection(*(set(p['attributes']) for p in primitives))
        reference = sorted_triangles(source)
        for name in sorted(candidates):
            if not name.startswith('TEXCOORD_'):
                continue
            values = []
            for primitive in primitives:
                attributes = primitive['attributes']
                index = glb.accessor(primitive['indices']).ravel()
                values.append(np.column_stack((glb.accessor(attributes['POSITION'])[index],
                                                glb.accessor(attributes[name])[index])))
            exported = sorted_triangles(np.concatenate(values))
            if np.array_equal(exported,reference):
                uv_channels.add(int(name.removeprefix('TEXCOORD_')))
                count += len(source)
                break
        else:
            raise ValueError(f'{obj.name}: GLB 顶点或 UV 与旧涂装表面不一致')
    if len(uv_channels)!=1 or not count:
        raise ValueError('旧涂装材质的原 UV 不存在或各物体使用的 UV 通道不一致')
    metadata = json.loads((out/'metadata.json').read_bytes())
    if metadata['source_sha256'] != config['sourceSha256'] or not metadata['uv_unchanged']:
        raise ValueError('旧模型文件在迁移时变化')
    (out/'migration-audit.json').write_text(json.dumps({
        'legacyUvSha256':legacy.hexdigest(),'rawGlbSha256':digest,
        'textureCoordinate':next(iter(uv_channels)),'verifiedTriangles':count,
        'objects':[obj.name for obj in registered],
        'render_visibility':{obj.name: not obj.hide_render for obj in objects if obj.name in nodes}
    },ensure_ascii=False),encoding='utf-8')


if __name__ == '__main__':
    main(json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_bytes()))
