"""Bake mesh data in registered UV space; outputs are ordinary project PNGs."""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from model_glb import Model
from paint_mask_generators import edge_wear
from paint_surface import projector_visibility
from paint_worker import geometry
from native_worker_lock import watch_parent


def accessibility(surface):
    # Deterministic, cosine-weighted integration over visible sky directions.
    # All triangles cast shadows, including parts without valid target UVs.
    ids = surface.ids
    span = max(float(np.linalg.norm(surface.high - surface.low)) * 1.01, 1e-12)
    center = (surface.high + surface.low) * .5
    triangles = (surface.positions - center) / span
    points = (surface.xyz[ids] - center) / span
    normals = surface.normals[surface.owner[ids]]
    visible = np.zeros(len(ids), np.float32)
    weights = np.zeros_like(visible)
    count = 32
    for i in range(count):
        z = 1 - 2 * (i + .5) / count
        angle = i * np.pi * (3 - np.sqrt(5))
        radius = np.sqrt(1 - z*z)
        sky = np.array([radius*np.cos(angle), radius*np.sin(angle), z], np.float32)
        right = np.array([-np.sin(angle), np.cos(angle), 0], np.float32)
        basis = np.column_stack((right, np.cross(sky, right), sky))
        weight = np.maximum(normals @ sky, 0)
        facing = np.flatnonzero(weight > 0)
        if len(facing):
            clear = projector_visibility(triangles @ basis, points[facing] @ basis)
            visible[facing] += weight[facing] * clear
            weights[facing] += weight[facing]
    return visible / np.maximum(weights, 1e-8)


def face_colors(surface, source, mode):
    if mode == 'object':
        # Odd multiplier permutes 24-bit keys without palette collisions.
        keys = (surface.objects.astype(np.uint32)+1)*0x79b951
        return np.column_stack([keys >> 16, keys >> 8, keys]).astype(np.uint8)
    if mode == 'material':
        # Only the registered material has writable UVs in this texture set.
        rgb = np.frombuffer(hashlib.sha256(source['material'].encode('utf-8')).digest()[:3], np.uint8)
        return np.broadcast_to(rgb, (len(surface.objects), 3))
    if source.get('format') != 'glb':
        raise ValueError('顶点色 ID 需要原生 GLB 工程')
    model = Model(source['reviewSource'])
    palette = np.zeros((len(surface.objects), 3), np.uint8)
    by_node = {}
    for part in model.primitives:
        by_node.setdefault(part['node'], []).append(part)
    owners = np.unique(surface.owner[surface.ids])
    for node in np.unique(surface.objects[owners]):
        faces = owners[surface.objects[owners] == node]
        local = surface.polygons[faces]
        offset = 0
        for part in by_node[node]:
            stop = offset + len(part['indices'])
            included = (local >= offset) & (local < stop)
            if included.any():
                mesh, primitive = map(int, part['key'].split(':'))
                attributes = model.scene['meshes'][mesh]['primitives'][primitive]['attributes']
                if 'COLOR_0' not in attributes:
                    raise ValueError('目标材质缺少 COLOR_0 顶点色，请改用物体 ID 或材质槽 ID')
                key = attributes['COLOR_0']
                values = model.accessor(key, model.scene['accessors'][key]['type'])
                if values.shape[1] not in (3,4) or len(values) != len(part['positions']):
                    raise ValueError('目标模型的 COLOR_0 顶点色格式无效')
                rgb = np.rint(np.clip(values[:, :3],0,1)*255).astype(np.uint8)
                colors = rgb[part['indices'][local[included]-offset]]
                if (colors != colors[:, :1]).any():
                    raise ValueError('顶点色 ID 要求每个三角面颜色一致，渐变顶点色请改用物体 ID')
                palette[faces[included]] = colors[:,0]
            offset = stop
        if np.any(local >= offset):
            raise ValueError('当前几何与登记模型的面编号不一致')
    return palette


def bake(source, resolution, mode, dest):
    surface, _, _, _, _, shape = geometry(source['cacheRun'], source['bundle'], source['material'],
                                            'mesh-bake', 4096//resolution, surface_only=True)
    ids = surface.ids
    if not len(ids):
        raise ValueError('当前分辨率没有可烘焙的有效 UV 像素')
    palette = face_colors(surface, source, mode)
    id_map = np.zeros((resolution**2,4), np.uint8)
    id_map[ids,:3] = palette[surface.owner[ids]]
    id_map[ids,3] = 255
    Image.fromarray(id_map.reshape((*shape,4))[::-1]).save(dest/'id.png')
    ao = np.full(resolution**2,255,np.uint8)
    ao[ids] = np.rint(accessibility(surface)*255).astype(np.uint8)
    Image.fromarray(ao.reshape(shape)[::-1]).save(dest/'ao.png')
    curvature = np.full(resolution**2,128,np.uint8)
    for start in range(0,len(ids),65536):
        chunk = ids[start:start+65536]
        params = dict(angle=1, width=1, softness=1)
        convex = edge_wear(surface,chunk,{**params,'edge':'convex'}, weight_angle=True)
        concave = edge_wear(surface,chunk,{**params,'edge':'concave'}, weight_angle=True)
        curvature[chunk] = np.rint(128+127*convex-128*concave).astype(np.uint8)
    Image.fromarray(curvature.reshape(shape)[::-1]).save(dest/'curvature.png')


def extract_mask(source, mode, color):
    with Image.open(source) as image:
        if mode == 'id':
            rgba = np.asarray(image.convert('RGBA'))
            selected = np.all(rgba[:,:,:3] == list(bytes.fromhex(color[1:])),axis=2) & (rgba[:,:,3] > 0)
            if not selected.any():
                raise ValueError('所选 ID 在贴图内没有有效像素')
            return Image.fromarray(selected.astype(np.uint8)*255)
        gray = image.convert('L')
        if mode == 'cavity':
            return gray.point([255-v for v in range(256)])
        if mode == 'convex':
            return gray.point([max(0,round((v-128)*255/127)) for v in range(256)])
        return gray.point([max(0,round((128-v)*255/128)) for v in range(256)])


if __name__ == '__main__':
    folder = Path(sys.argv[1])
    config = json.loads((folder/'input.json').read_bytes())
    watch_parent(config['ownerPid'])
    try:
        if 'highModel' in config:
            from normal_projection import normal_map
            source = config['source']
            surface, *_ = geometry(source['cacheRun'], source['bundle'], source['material'],
                                   'mesh-bake', 4096//config['resolution'], surface_only=True)
            report = normal_map(surface,source,config['highModel'],config['front'],config['rear'],folder/'normal.png',config['steps'])
            (folder/'coverage.json').write_text(json.dumps(report),encoding='utf-8')
        elif 'source' in config:
            bake(config['source'],config['resolution'],config['idSource'],folder)
        else:
            extract_mask(config['file'],config['mode'],config.get('color')).save(folder/'mask.png')
    except ValueError as error:
        sys.exit(str(error))
