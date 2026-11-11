"""Attach a verified paint bake to a registered, self-contained GLB."""
import copy
import hashlib
import io
import json
import struct
import sys
from pathlib import Path

from PIL import Image


JSON = b'JSON'
BIN = b'BIN\0'
SIZE = (4096, 4096)


def checked(file, digest):
    data = Path(file).read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('GLB 导出的模型或贴图指纹变化')
    return data


def read_glb(data):
    if len(data) < 28 or struct.unpack_from('<4sII', data) != (b'glTF', 2, len(data)):
        raise ValueError('登记模型不是有效的 GLB 2.0')
    length, kind = struct.unpack_from('<I4s', data, 12)
    end = 20 + length
    if kind != JSON or length % 4 or end + 8 > len(data):
        raise ValueError('GLB 场景数据无效')
    scene = json.loads(data[20:end])
    binary_size, kind = struct.unpack_from('<I4s', data, end)
    buffers = scene.get('buffers', [])
    if (kind != BIN or end + 8 + binary_size != len(data) or len(buffers) != 1 or
            'uri' in buffers[0] or not binary_size - 3 <= buffers[0]['byteLength'] <= binary_size or
            any('uri' in image for image in scene.get('images', []))):
        raise ValueError('请使用不依赖外部文件的登记 GLB')
    return scene, bytearray(data[end + 8:])


def append_texture(scene, binary, png, name):
    binary.extend(b'\0' * (-len(binary) % 4))
    offset = len(binary)
    binary.extend(png)
    binary.extend(b'\0' * (-len(binary) % 4))
    views = scene['bufferViews']
    views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(png)})
    images = scene.setdefault('images', [])
    images.append({'name': name, 'bufferView': len(views) - 1, 'mimeType': 'image/png'})
    textures = scene.setdefault('textures', [])
    textures.append({'source': len(images) - 1})
    return {'index': len(textures) - 1}


def png_bytes(image):
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


def paint_material(scene, binary, material, maps, active):
    def load(name):
        entry = maps[name]
        return checked(entry['file'], entry['sha256'])

    def channel(name, mode):
        with Image.open(io.BytesIO(load(name))) as source:
            if source.format != 'PNG' or source.size != SIZE:
                raise ValueError('GLB 导出要求当前修订的 4K PNG')
            return source.convert(mode)

    def retained(info, mode):
        if info.get('texCoord',0) != 0 or info.get('extensions',{}).get('KHR_texture_transform'):
            raise ValueError('独立替换通道时，原组合贴图须使用未变换的 TEXCOORD_0')
        texture = scene['textures'][info['index']]
        image = scene['images'][texture['source']]
        view = scene['bufferViews'][image['bufferView']]
        start = view.get('byteOffset',0)
        with Image.open(io.BytesIO(binary[start:start+view['byteLength']])) as source:
            return source.convert(mode).resize(SIZE,Image.Resampling.BILINEAR)

    pbr = material.setdefault('pbrMetallicRoughness', {})
    if 'color' in active or 'alpha' in active:
        original = pbr.get('baseColorTexture')
        factor = list(pbr.get('baseColorFactor', [1, 1, 1, 1]))
        if 'color' in active:
            color = channel('color', 'RGB')
            factor[:3] = [1, 1, 1]
            if 'alpha' not in active and original and material.get('alphaMode','OPAQUE')!='OPAQUE':
                color.putalpha(retained(original,'RGBA').getchannel('A'))
        else:
            color = retained(original,'RGB') if original else Image.new('RGB',SIZE,'white')
        if 'alpha' in active:
            alpha = channel('alpha', 'L')
            if alpha.getextrema()[0] < 255:
                color.putalpha(alpha)
                material['alphaMode'] = 'BLEND'
            else:
                material.pop('alphaMode', None)
            material.pop('alphaCutoff', None)
            factor[3] = 1
        pbr['baseColorTexture'] = append_texture(scene, binary, png_bytes(color), 'Base color')
        pbr['baseColorFactor'] = factor

    roughness, metallic = 'roughness' in active, 'metallic' in active
    if roughness or metallic:
        original = pbr.get('metallicRoughnessTexture')
        preserved = retained(original,'RGB') if original and roughness != metallic else None
        white = Image.new('L', SIZE, 255)
        packed = Image.merge('RGB', (white,
            channel('roughness','L') if roughness else preserved.getchannel('G') if preserved else white,
            channel('metallic','L') if metallic else preserved.getchannel('B') if preserved else white))
        pbr['metallicRoughnessTexture'] = append_texture(scene, binary, png_bytes(packed), 'Metallic roughness')
        if roughness:
            pbr['roughnessFactor'] = 1
        if metallic:
            pbr['metallicFactor'] = 1

    for channel_name, field in (('normal', 'normalTexture'), ('ao', 'occlusionTexture'),
                                ('emission', 'emissiveTexture')):
        if channel_name in active:
            material[field] = append_texture(scene, binary, load(channel_name), channel_name)
    if 'emission' in active:
        material['emissiveFactor'] = [1, 1, 1]
        material.get('extensions',{}).pop('KHR_materials_emissive_strength',None)


def apply_modeling(config, scene, binary):
    import numpy as np
    from model_glb import Model, normalize

    model = Model(config['model']['file'])
    steps = config['modeling']['steps']
    model.edit(steps)

    def vector_accessor(values, bounds=False):
        data = np.asarray(values,dtype='<f4')
        if not np.isfinite(data).all():
            raise ValueError('建模结果包含无效顶点或法线')
        binary.extend(b'\0' * (-len(binary) % 4))
        offset = len(binary)
        binary.extend(data.tobytes())
        views = scene['bufferViews']
        views.append(dict(buffer=0,byteOffset=offset,byteLength=data.nbytes,target=34962))
        entry = dict(bufferView=len(views)-1,componentType=5126,count=len(data),type='VEC3')
        if bounds:
            entry.update(min=data.min(axis=0).tolist(),max=data.max(axis=0).tolist())
        accessors = scene['accessors']
        accessors.append(entry)
        return len(accessors)-1

    changed_nodes = {t['id'] for step in steps for t in step['targets'] if 'id' in t}
    for key in changed_nodes:
        node = scene['nodes'][key]
        for field in ('translation','rotation','scale'):
            node.pop(field,None)
        node['matrix'] = model.nodes[key]['local'].T.reshape(-1).tolist()

    changed_meshes = {t['mesh'] for step in steps for t in step['targets'] if 'mesh' in t}
    clones = {}
    for key in sorted(changed_meshes):
        item = model.primitives[key]
        node_id = item['node']
        mesh_id,primitive_id = map(int,item['key'].split(':'))
        if node_id not in clones:
            clones[node_id] = copy.deepcopy(scene['meshes'][mesh_id])
            scene['nodes'][node_id]['mesh'] = len(scene['meshes'])
            scene['meshes'].append(clones[node_id])
        attributes = clones[node_id]['primitives'][primitive_id]['attributes']
        vertices,indices = item['positions'],item['indices']
        triangle = vertices[indices]
        face = np.cross(triangle[:,1]-triangle[:,0],triangle[:,2]-triangle[:,0])
        normals = np.zeros_like(vertices)
        for corner in range(3):
            np.add.at(normals,indices[:,corner],face)
        unreferenced = np.linalg.norm(normals,axis=1)<1e-20
        normals[unreferenced] = [0,0,1]
        attributes['POSITION'] = vector_accessor(vertices,bounds=True)
        attributes['NORMAL'] = vector_accessor(normalize(normals))
        attributes.pop('TANGENT',None)
    return model.uv_digest()


def main(config):
    model = config['model']
    scene, binary = read_glb(checked(model['file'], model['sha256']))
    expected_uv = model['uvSha256'] if config.get('verifyNativeUV') else None
    modeling = config.get('modeling')
    if modeling and modeling['steps']:
        if modeling['modelSha256'] != model['sha256']:
            raise ValueError('工程建模绑定与登记模型不一致')
        original_uv = apply_modeling(config, scene, binary)
        if expected_uv and original_uv != expected_uv:
            raise ValueError('原 GLB UV 与登记指纹不一致')
        expected_uv = original_uv
    matches = [i for i, material in enumerate(scene.get('materials', []))
               if material.get('name') == config['material']]
    if len(matches) != 1:
        raise ValueError('无法唯一定位登记涂装材质')
    selected = matches[0]
    primitives = [primitive for mesh in scene.get('meshes', []) for primitive in mesh['primitives']
                  if primitive.get('material') == selected]
    if not primitives or any('TEXCOORD_0' not in primitive['attributes'] for primitive in primitives):
        raise ValueError('登记涂装材质缺少原 UV')
    material = scene['materials'][selected]
    paint_material(scene, binary, material, config['maps'], set(config['activeChannels']))
    scene['asset'].setdefault('extras', {})['arachne'] = {
        'revision': config['revision'], 'sourceGlbSha256': model['sha256'], 'uvSha256': model['uvSha256']
    }
    write_glb(config['out'], scene, binary)
    if expected_uv:
        from model_glb import Model
        if Model(config['out']).uv_digest() != expected_uv:
            raise ValueError('GLB 导出改变了原 UV 或拓扑顺序')


def write_glb(file, scene, binary):
    scene['buffers'][0]['byteLength'] = len(binary)
    metadata = json.dumps(scene, ensure_ascii=False, separators=(',', ':')).encode()
    metadata += b' ' * (-len(metadata) % 4)
    length = 28 + len(metadata) + len(binary)
    with Path(file).open('xb') as output:
        output.write(struct.pack('<4sIII4s', b'glTF', 2, length, len(metadata), JSON))
        output.write(metadata)
        output.write(struct.pack('<I4s', len(binary), BIN))
        output.write(binary)


if __name__ == '__main__':
    main(json.loads(Path(sys.argv[1]).read_bytes()))
