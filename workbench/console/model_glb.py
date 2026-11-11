"""Read the static triangle geometry used by the viewport and UV workers."""
import hashlib
import math
from pathlib import Path

import numpy as np

from paint_glb import read_glb, write_glb

TYPES = {5120:'i1',5121:'u1',5122:'<i2',5123:'<u2',5125:'<u4',5126:'<f4'}


def checksum(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def names(items, prefix):
    used = set()
    for index, item in enumerate(items):
        value = item.get('name')
        value = ''.join(c for c in value if ord(c) >= 32 and ord(c) != 127).strip()[:220] if isinstance(value,str) else ''
        base = value if value and value not in ('constructor','prototype','__proto__') else f'{prefix} {index+1}'
        value = base
        counter = 1
        while value in used:
            counter += 1
            value = f'{base} ({counter})'
        used.add(value)
        item['name'] = value
        if prefix == '材质':
            item.setdefault('extras', {})['sourceMaterial'] = value


def normalize(vector):
    return vector / np.maximum(np.linalg.norm(vector,axis=-1,keepdims=True),1e-20)


def rotation_matrix(x,y,z,w):
    return np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                     [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                     [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])


def local_trs(matrix):
    # The viewport decomposes each edited local matrix to position, rotation and scale.
    # This also handles the shear produced by world-space rotation under a scaled parent.
    basis = matrix[:3,:3]
    scale = np.linalg.norm(basis,axis=0)
    if np.linalg.det(basis)<0:
        scale[0] = -scale[0]
    r = basis/scale
    trace = np.trace(r)
    if trace>0:
        size = 2*math.sqrt(trace+1)
        quaternion = [(r[2,1]-r[1,2])/size,(r[0,2]-r[2,0])/size,(r[1,0]-r[0,1])/size,size/4]
    else:
        diagonal = r.diagonal()
        i = 2-int(np.argmax(diagonal[::-1]))
        j,k = (i+1)%3,(i+2)%3
        size = 2*math.sqrt(1+diagonal[i]-diagonal[j]-diagonal[k])
        quaternion = [0,0,0,(r[k,j]-r[j,k])/size]
        quaternion[i],quaternion[j],quaternion[k] = size/4,(r[j,i]+r[i,j])/size,(r[k,i]+r[i,k])/size
    result = matrix.copy()
    result[:3,:3] = rotation_matrix(*quaternion)*scale
    return result


def transform(node):
    if 'matrix' in node:
        result = np.asarray(node['matrix'],dtype=float).reshape(4,4).T
    else:
        x,y,z,w = normalize(np.array(node.get('rotation',[0,0,0,1]),dtype=float))
        result = np.eye(4)
        result[:3,:3] = rotation_matrix(x,y,z,w)*node.get('scale',[1,1,1])
        result[:3,3] = node.get('translation',[0,0,0])
    if not np.isfinite(result).all() or not np.allclose(result[3],[0,0,0,1]) or abs(np.linalg.det(result[:3,:3])) < 1e-18:
        raise ValueError('GLB 物体变换无效')
    return result


def index(items, key):
    if type(key) is not int or not 0 <= key < len(items):
        raise ValueError('GLB 引用超出范围')
    return items[key]


class Model:
    def __init__(self, file, registration=False):
        self.scene,self.binary = read_glb(Path(file).read_bytes())
        scene = self.scene
        if scene.get('skins') or any(node.get('extensions',{}).get('EXT_mesh_gpu_instancing') for node in scene['nodes']):
            raise ValueError('请先将骨骼或 GPU 实例转换成静态网格')
        unsupported = set(scene.get('extensionsRequired',[])) & {
            'KHR_draco_mesh_compression','EXT_meshopt_compression','KHR_texture_basisu'
        }
        if unsupported:
            raise ValueError('请导出未使用 Draco、Meshopt 或 KTX2 压缩的 GLB')
        if registration:
            names(scene['nodes'],'物体')
            names(scene.setdefault('materials',[]),'材质')
            if not scene['materials'] or any('material' not in p for mesh in scene['meshes'] for p in mesh['primitives']):
                fallback = len(scene['materials'])
                scene['materials'].append({})
                names(scene['materials'],'材质')
                for mesh in scene['meshes']:
                    for primitive in mesh['primitives']:
                        primitive.setdefault('material',fallback)
        self.nodes,self.primitives = {},[]
        self.accessors = {}
        self.triangle_count = 0
        self.root_ids = index(scene['scenes'],scene.get('scene',0))['nodes']
        for node in self.root_ids:
            self.visit(node,None)
        if not self.primitives:
            raise ValueError('GLB 中没有可登记的三角网格')

    def accessor(self, key, kind):
        if (key,kind) in self.accessors:
            return self.accessors[key,kind]
        entry = index(self.scene['accessors'],key)
        if entry['type'] != kind or 'sparse' in entry:
            raise ValueError('GLB 顶点数据格式无效或使用了稀疏访问器')
        view = index(self.scene['bufferViews'],entry['bufferView'])
        if view.get('buffer',0) != 0 or view.get('extensions',{}).get('EXT_meshopt_compression'):
            raise ValueError('请使用内嵌未压缩的 GLB 网格')
        dtype = np.dtype(TYPES[entry['componentType']])
        columns = {'SCALAR':1,'VEC2':2,'VEC3':3}[kind]
        item_size = dtype.itemsize*columns
        stride = view.get('byteStride',item_size)
        start = view.get('byteOffset',0)
        offset,count = entry.get('byteOffset',0),entry['count']
        end = offset+(count-1)*stride+item_size
        if (not 0 < count <= 3_000_000 or start < 0 or offset < 0 or stride < item_size or
                end > view['byteLength'] or start+end > len(self.binary)):
            raise ValueError('GLB 顶点数据越界')
        values = np.ndarray((count,columns),dtype=dtype,buffer=self.binary,
                            offset=start+offset,strides=(stride,dtype.itemsize)).copy()
        if entry.get('normalized') and dtype.kind in 'iu':
            values = np.maximum(values.astype(float)/np.iinfo(dtype).max,-1)
        if not np.isfinite(values).all():
            raise ValueError('GLB 顶点数据包含无效数值')
        self.accessors[key,kind] = values
        return values

    def visit(self, key, parent):
        if key in self.nodes or len(self.nodes) >= 10000:
            raise ValueError('GLB 场景层级存在循环、重复节点或过多节点')
        node = index(self.scene['nodes'],key)
        self.nodes[key] = dict(parent=parent, local=transform(node), name=node.get('name') or f'Node {key}')
        if 'mesh' in node:
            mesh_id = node['mesh']
            mesh = index(self.scene['meshes'],mesh_id)
            for primitive_id, primitive in enumerate(mesh['primitives']):
                if primitive.get('mode',4) != 4 or primitive.get('targets') or primitive.get('extensions',{}).get('KHR_draco_mesh_compression'):
                    raise ValueError('GLB 只支持静态三角网格')
                attributes = primitive['attributes']
                position_accessor = attributes['POSITION']
                if index(self.scene['accessors'],position_accessor)['componentType']!=5126:
                    raise ValueError('请将量化顶点位置转换为浮点数后再导入')
                positions = self.accessor(position_accessor,'VEC3')
                raw = self.accessor(primitive['indices'],'SCALAR').ravel() if 'indices' in primitive else np.arange(len(positions))
                if raw.dtype.kind not in 'iu' or len(raw)%3 or raw.min()<0 or raw.max()>=len(positions):
                    raise ValueError('GLB 三角形索引无效')
                self.triangle_count += len(raw)//3
                if self.triangle_count > 1_000_000:
                    raise ValueError('GLB 场景最多支持 100 万个三角形')
                uv = self.accessor(attributes['TEXCOORD_0'],'VEC2') if 'TEXCOORD_0' in attributes else None
                normals = self.accessor(attributes['NORMAL'],'VEC3') if 'NORMAL' in attributes else None
                if any(values is not None and len(values)!=len(positions) for values in (uv,normals)):
                    raise ValueError('GLB 顶点、法线或 UV 数量不一致')
                mat = primitive.get('material')
                material = index(self.scene['materials'],mat) if mat is not None else {}
                label = material.get('extras',{}).get('sourceMaterial') or material.get('name','(none)')
                self.primitives.append(dict(node=key,key=f'{mesh_id}:{primitive_id}',positions=positions.astype(float),
                    indices=raw.reshape(-1,3),uv=uv,normals=normals,label=label,material=material,
                    position_accessor=position_accessor))
        for child in node.get('children',[]):
            self.visit(child,key)

    def uv_digest(self):
        digest = hashlib.sha256()
        for primitive in self.primitives:
            digest.update(np.asarray([primitive['node']],dtype='<u4').tobytes())
            digest.update(primitive['indices'].astype('<u4').tobytes())
            if primitive['uv'] is not None:
                digest.update(primitive['uv'].astype('<f4').tobytes())
        return digest.hexdigest()

    def topology(self):
        entries,starts,polygon,vertex = {},{},0,0
        for primitive in self.primitives:
            key = primitive['key']
            if key in entries:
                continue
            mesh = key.split(':')[0]
            accessor = (mesh,primitive['position_accessor'])
            count,faces = len(primitive['positions']),len(primitive['indices'])
            if accessor not in starts:
                starts[accessor] = vertex
                vertex += count
            start = starts[accessor]
            entries[key] = dict(vertices=list(range(start,start+count)),polygons=list(range(polygon,polygon+faces)))
            polygon += faces
        return entries

    def worlds(self):
        world = {}
        for key,node in self.nodes.items():
            world[key] = world[node['parent']] @ node['local'] if node['parent'] is not None else node['local']
        return world

    def edit(self, steps):
        for step in steps:
            delta = np.asarray(step['matrix'],dtype=float).reshape(4,4).T
            worlds = self.worlds()
            for target in step['targets']:
                if 'id' in target:
                    key = target['id']
                    node = self.nodes[key]
                    parent = worlds.get(node['parent'],np.eye(4))
                    node['local'] = local_trs(np.linalg.solve(parent,delta @ worlds[key]))
                else:
                    primitive = self.primitives[target['mesh']]
                    positions = primitive['positions']
                    ids = target['vertices']
                    world = worlds[primitive['node']]
                    matrix = np.linalg.solve(world,delta @ world)
                    positions[ids] = (positions[ids] @ matrix[:3,:3].T + matrix[:3,3]).astype(np.float32)
                    primitive['normals'] = None

    def save(self, file):
        write_glb(file,self.scene,self.binary)
