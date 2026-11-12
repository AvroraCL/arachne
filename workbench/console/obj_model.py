"""Convert a static Wavefront OBJ and its explicitly selected MTL files to GLB."""
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
import json
import math
import shlex
import sys
import unicodedata

import numpy as np
from PIL import Image, ImageChops

from paint_glb import append_texture, png_bytes, write_glb
from native_worker_lock import watch_parent


def name_key(value):
    return unicodedata.normalize('NFC', value.strip().strip('"').replace('\\', '/').split('/')[-1]).casefold()


def statements(file):
    with file.open('rb') as probe:
        prefix = probe.read(256 * 1024)
    try:
        prefix.decode('utf-8-sig')
        encoding = 'utf-8-sig'
    except UnicodeDecodeError as error:
        encoding = 'utf-8-sig' if error.end == len(prefix) else 'gb18030'
    with file.open(encoding=encoding) as stream:
        continued = ''
        for number, line in enumerate(stream, 1):
            line = continued + line.split('#', 1)[0].strip()
            if len(line) > 65536:
                raise ValueError(f'OBJ／MTL 第 {number} 行过长')
            if line.endswith('\\'):
                continued = line[:-1] + ' '
                continue
            continued = ''
            fields = line.split(None, 1)
            if fields:
                yield number, fields[0], fields[1].strip() if len(fields) > 1 else ''
        if continued:
            raise ValueError('OBJ／MTL 的续行不完整')


def values(text, size):
    numbers = tuple(float(value) for value in text.split())
    if len(numbers) < size or not all(math.isfinite(value) and abs(value) <= 1e12 for value in numbers):
        raise ValueError('坐标或材质数值无效')
    return numbers


def obj_index(value, count):
    index = int(value)
    index = index - 1 if index > 0 else count + index if index < 0 else -1
    if not 0 <= index < count:
        raise ValueError('顶点、UV 或法线编号超出范围')
    return index


def corners(text, counts):
    result = []
    for entry in text.split():
        fields = entry.split('/')
        if len(fields) > 3:
            raise ValueError('面角引用格式无效')
        fields.extend([''] * (3 - len(fields)))
        result.append(tuple(obj_index(field, size) if field or i == 0 else None
                            for i, (field, size) in enumerate(zip(fields, counts))))
    if not 3 <= len(result) <= 256 or len({corner[0] for corner in result}) != len(result):
        raise ValueError('每个面须包含 3–256 个不同顶点')
    if len({corner[1] is None for corner in result}) != 1:
        raise ValueError('同一个面的 UV 引用不完整')
    return result


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def triangulate(points):
    pts = np.asarray(points, dtype=np.float64)
    local = pts - pts[0]
    normal = np.cross(local, np.roll(local, -1, axis=0)).sum(axis=0)
    length = np.linalg.norm(normal)
    extent = np.max(np.abs(local))
    if length <= max(1e-28, extent ** 2 * 1e-12):
        raise ValueError('面退化或自交')
    if len(pts) == 3:
        return [(0, 1, 2)], normal
    plane = np.delete(local, int(np.argmax(np.abs(normal))), axis=1).tolist()
    signed = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(plane, plane[1:] + plane[:1]))
    direction = 1 if signed > 0 else -1
    epsilon = max(1e-28, extent ** 2 * 1e-12)
    remaining = list(range(len(pts)))
    triangles = []
    while len(remaining) > 3:
        for index, middle in enumerate(remaining):
            left, right = remaining[index - 1], remaining[(index + 1) % len(remaining)]
            a, b, c = plane[left], plane[middle], plane[right]
            if direction * cross(a, b, c) <= epsilon:
                continue
            triangle = (left, middle, right)
            if any(all(direction * cross(start, end, plane[other]) >= -epsilon
                       for start, end in ((a, b), (b, c), (c, a)))
                   for other in remaining if other not in triangle):
                continue
            triangles.append(triangle)
            remaining.pop(index)
            break
        else:
            raise ValueError('无法三角化面，请检查自交或重叠边')
    if direction * cross(*(plane[index] for index in remaining)) <= epsilon:
        raise ValueError('三角化产生退化面')
    return [*triangles, tuple(remaining)], normal


@dataclass
class Face:
    vertices: list
    triangles: list
    normal: np.ndarray
    material: str
    smoothing: str


def read_obj(file):
    positions, uv, normals, libraries = [], [], [], []
    objects = [('物体', [])]
    explicit_object = False
    material, smoothing = '默认材质', ''
    triangles = 0
    for number, kind, text in statements(file):
        try:
            if kind == 'v':
                coords = values(text, 3)
                point = coords[:3]
                if len(coords) == 4:
                    if coords[3] == 0:
                        raise ValueError('齐次顶点的 w 不能为零')
                    point = tuple(n / coords[3] for n in point)
                positions.append(point)
            elif kind == 'vt':
                u, v, *_ = values(text, 2)
                uv.append((u, 1 - v))
            elif kind == 'vn':
                normals.append(values(text, 3)[:3])
            elif kind in ('o', 'g') and (kind == 'o' or not explicit_object):
                if kind == 'o':
                    explicit_object = True
                obj = (text[:250] or '物体', [])
                if objects[-1][1]:
                    objects.append(obj)
                else:
                    objects[-1] = obj
            elif kind == 'usemtl':
                material = text.strip('"') or '默认材质'
                if len(material) > 250:
                    raise ValueError('材质名称超过 250 字')
            elif kind == 'mtllib' and text:
                libraries.append(text)
            elif kind == 's':
                smoothing = '' if text.lower() in ('off', '0') else text
            elif kind == 'f':
                vertices = corners(text, (len(positions), len(uv), len(normals)))
                faces, normal = triangulate([positions[index] for index, _, _ in vertices])
                triangles += len(faces)
                if triangles > 1_000_000:
                    raise ValueError('最多支持 100 万个三角形')
                objects[-1][1].append(Face(vertices, faces, normal, material, smoothing))
            if max(len(positions), len(uv), len(normals)) > 3_000_000 or len(objects) > 10_000:
                raise ValueError('OBJ 的顶点、UV、法线或物体数量过多')
        except (ValueError, OverflowError) as error:
            raise ValueError(f'OBJ 第 {number} 行：{error}') from error
    if not triangles:
        raise ValueError('OBJ 中没有网格面')
    return positions, uv, normals, objects, libraries


def read_materials(libraries, files, preserve):
    materials = {}
    for entry in dict.fromkeys(libraries):
        names = [entry] if name_key(entry) in files else shlex.split(entry.replace('\\', '/'))
        for name in names:
            source = files.get(name_key(name))
            if source is None:
                if preserve:
                    raise ValueError(f'缺少 MTL「{name}」，请连同 OBJ 一起选择，或关闭「保留源贴图」')
                continue
            current = None
            for _, kind, text in statements(source):
                if kind == 'newmtl':
                    name = text.strip('"')
                    current = materials.setdefault(name, {})
                elif current is not None:
                    current[kind] = text
    return materials


def load_map(info, files):
    if not info:
        return None
    source = files.get(name_key(info))
    if source is None:
        if info.startswith('-'):
            raise ValueError('MTL 贴图选项暂不能转换，请改用普通图片引用或关闭「保留源贴图」')
        raise ValueError(f'缺少贴图「{info}」，请连同 OBJ 一起选择，或关闭「保留源贴图」')
    with Image.open(source) as image:
        if image.format not in ('PNG', 'JPEG', 'WEBP') or max(image.size) > 8192 or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('MTL 贴图须为宽高不超过 8192 像素的静态 PNG、JPEG 或 WebP')
        return image.convert('RGBA')


def material_data(scene, binary, name, material, files, with_maps):
    def scalar(key, default):
        return float(np.clip(values(material[key], 1)[0], 0, 1)) if key in material else default

    color = np.clip(values(material.get('Kd', '.65 .65 .65'), 3)[:3], 0, 1).tolist()
    opacity = scalar('d', 1 - scalar('Tr', 0))
    specular = max(0, values(material.get('Ns', '6'), 1)[0])
    pbr = dict(baseColorFactor=[*color, opacity], metallicFactor=scalar('Pm', 0),
               roughnessFactor=scalar('Pr', math.sqrt(2 / (2 + specular))))
    result = dict(name=name, pbrMetallicRoughness=pbr)
    if 'Ke' in material:
        result['emissiveFactor'] = np.clip(values(material['Ke'], 3)[:3], 0, 1).tolist()
    if with_maps:
        base = load_map(material.get('map_Kd'), files)
        alpha = load_map(material.get('map_d'), files)
        if alpha is not None:
            if base is None:
                base = Image.new('RGBA', alpha.size, 'white')
            mask = alpha.convert('L').resize(base.size, Image.Resampling.BILINEAR)
            base.putalpha(ImageChops.multiply(base.getchannel('A'), mask))
        if base is not None:
            pbr['baseColorTexture'] = append_texture(scene, binary, png_bytes(base), name + ' · 基础色')
            if base.getchannel('A').getextrema()[0] < 255:
                result['alphaMode'] = 'BLEND'
        normal = load_map(material.get('norm'), files)
        if normal is not None:
            result['normalTexture'] = append_texture(scene, binary, png_bytes(normal.convert('RGB')), name + ' · 法线')
        metal = load_map(material.get('map_Pm'), files)
        rough = load_map(material.get('map_Pr'), files)
        if metal is not None or rough is not None:
            size = tuple(max(dimensions) for dimensions in zip(*(image.size for image in (metal, rough) if image is not None)))
            white = Image.new('L', size, 255)
            packed = Image.merge('RGB', (white, rough.convert('L').resize(size, Image.Resampling.BILINEAR) if rough else white,
                                         metal.convert('L').resize(size, Image.Resampling.BILINEAR) if metal else white))
            pbr['metallicRoughnessTexture'] = append_texture(scene, binary, png_bytes(packed), name + ' · 粗糙度和金属度')
            if metal is not None and 'Pm' not in material:
                pbr['metallicFactor'] = 1
            if rough is not None and 'Pr' not in material:
                pbr['roughnessFactor'] = 1
        emission = load_map(material.get('map_Ke'), files)
        if emission is not None:
            result.setdefault('emissiveFactor', [1, 1, 1])
            result['emissiveTexture'] = append_texture(scene, binary, png_bytes(emission.convert('RGB')), name + ' · 自发光')
    if opacity < 1:
        result['alphaMode'] = 'BLEND'
    return result


def build_glb(config):
    path = Path(config['obj'])
    points, uv, normals, objects, libraries = read_obj(path)
    files = {name_key(item['name']): Path(item['path']) for item in config['attachments']}
    if len(files) != len(config['attachments']):
        raise ValueError('配套文件不能重名')
    preserve = config.get('preserveTextures', True)
    properties = read_materials(libraries, files, preserve)
    axis = config['upAxis']
    if axis not in ('y', 'z'):
        raise ValueError('请选择 OBJ 的竖直轴')
    paintable = {face.material for _, faces in objects for face in faces if face.vertices[0][1] is not None}
    if not paintable:
        raise ValueError('OBJ 没有可用的 UV，请先在建模软件中展开 UV')

    scene = dict(asset={'version': '2.0', 'generator': 'Arachne OBJ Import'}, scene=0,
                 scenes=[{'nodes': []}], nodes=[], meshes=[], materials=[],
                 buffers=[{'byteLength': 0}], bufferViews=[], accessors=[])
    binary = bytearray()
    slots = {}

    def accessor(data, size, indexes=False, extras=None, bounds=False):
        array = np.asarray(data, dtype='<u4' if indexes else '<f4')
        if not np.isfinite(array).all():
            raise ValueError('OBJ 顶点或 UV 超出可表示范围')
        buffer_view = len(scene['bufferViews'])
        scene['bufferViews'].append(dict(buffer=0, byteOffset=len(binary), byteLength=array.nbytes,
                                         target=34963 if indexes else 34962))
        binary.extend(array.tobytes())
        entry = dict(bufferView=buffer_view, componentType=5125 if indexes else 5126, count=len(array),
                     type='SCALAR' if size == 1 else f'VEC{size}')
        if extras:
            entry['extras'] = extras
        if bounds:
            entry.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        scene['accessors'].append(entry)
        return len(scene['accessors']) - 1

    def material_slot(name, has_uv):
        key = (name, has_uv)
        if key not in slots:
            label = name if has_uv or name not in paintable else name + ' · 无 UV'
            slots[key] = len(scene['materials'])
            scene['materials'].append(material_data(scene, binary, label, properties.get(name, {}), files, preserve and has_uv))
        return slots[key]

    def orient(value):
        x, y, z = value
        return (x, z, -y) if axis == 'z' else (x, y, z)

    for name, faces in objects:
        if not faces:
            continue
        smooth = defaultdict(lambda: np.zeros(3))
        for face in faces:
            if face.smoothing:
                for index, _, _ in face.vertices:
                    smooth[index, face.smoothing] += face.normal
        vertices, groups, packed = {}, {}, defaultdict(lambda: ([], []))
        mesh_points, mesh_uv, mesh_normals, vertex_groups = [], [], [], []
        for face_id, face in enumerate(faces):
            has_uv = face.vertices[0][1] is not None
            indexes, face_groups = packed[face.material, has_uv]
            face_groups.extend([len(indexes) // 3] * len(face.triangles))
            references = []
            for v, t, n in face.vertices:
                split_normal = ('normal', n) if n is not None else ('smooth', face.smoothing) if face.smoothing else ('face', face_id)
                key = (v, t, split_normal)
                if key not in vertices:
                    index = vertices[key] = len(mesh_points)
                    mesh_points.append(orient(points[v]))
                    mesh_uv.append(uv[t] if t is not None else (0, 0))
                    value = np.asarray(normals[n]) if n is not None else smooth[v, face.smoothing] if face.smoothing else face.normal
                    length = np.linalg.norm(value)
                    if length < 1e-20:
                        value, length = face.normal, np.linalg.norm(face.normal)
                    mesh_normals.append(orient(value / length))
                    vertex_groups.append(groups.setdefault(v, index))
                references.append(vertices[key])
            indexes.extend(references[index] for triangle in face.triangles for index in triangle)
        attributes = dict(POSITION=accessor(mesh_points, 3, extras={'arachneVertexGroups': vertex_groups}, bounds=True),
                          NORMAL=accessor(mesh_normals, 3))
        uv_index = accessor(mesh_uv, 2)
        primitives = []
        for (label, has_uv), (indices, face_groups) in packed.items():
            primitives.append(dict(attributes={**attributes, **({'TEXCOORD_0': uv_index} if has_uv else {})},
                                   indices=accessor(indices, 1, indexes=True),
                                   material=material_slot(label, has_uv), extras={'arachneFaceGroups': face_groups}))
        scene['scenes'][0]['nodes'].append(len(scene['nodes']))
        scene['nodes'].append(dict(name=name, mesh=len(scene['meshes'])))
        scene['meshes'].append(dict(primitives=primitives))

    chosen = config.get('material')
    if chosen is not None and (chosen, True) not in slots:
        raise ValueError('所选 OBJ 材质没有可用的 UV')
    write_glb(config['out'], scene, binary)
    return slots[chosen, True] if chosen is not None else None


if __name__ == '__main__':
    try:
        config = json.loads(Path(sys.argv[1]).read_bytes())
        watch_parent(config.get('ownerPid'))
        print(json.dumps({'material': build_glb(config)}))
    except (OSError, ValueError, KeyError, TypeError, OverflowError, Image.DecompressionBombError) as error:
        sys.exit(str(error))
