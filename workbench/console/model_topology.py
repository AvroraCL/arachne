"""Match Blender vertex and polygon IDs to the existing viewport GLB."""
import hashlib
import json
import struct
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import bpy
import numpy as np


class Glb:
    def __init__(self, path):
        self.data = path.read_bytes()
        magic, version, total = struct.unpack_from('<4sII', self.data)
        if magic != b'glTF' or version != 2 or total != len(self.data):
            raise ValueError('Invalid viewport GLB')
        size, kind = struct.unpack_from('<I4s', self.data, 12)
        if kind != b'JSON':
            raise ValueError('Missing viewport GLB metadata')
        self.binary = 28 + size
        self.doc = json.loads(self.data[20:20+size])

    def accessor(self, index):
        item = self.doc['accessors'][index]
        view = self.doc['bufferViews'][item['bufferView']]
        dtype = np.dtype({5121:'u1',5123:'<u2',5125:'<u4',5126:'<f4'}[item['componentType']])
        size = {'SCALAR':1,'VEC2':2,'VEC3':3}[item['type']]
        if 'sparse' in item or view['buffer'] != 0:
            raise ValueError('Unsupported viewport accessor')
        return np.ndarray((item['count'],size),dtype=dtype,buffer=self.data,
                          offset=self.binary+view.get('byteOffset',0)+item.get('byteOffset',0),
                          strides=(view.get('byteStride',size*dtype.itemsize),dtype.itemsize))


def match_primitive(baseline, annotated, source, annotation):
    if any(item.get('mode',4)!=4 or 'indices' not in item for item in (source,annotation)):
        return None
    a,b = source['attributes'],annotation['attributes']
    if '_ARACHNE_VERTEX' not in b or '_ARACHNE_POLYGON' not in b:
        return None
    original = baseline.accessor(source['indices']).ravel()
    tagged = annotated.accessor(annotation['indices']).ravel()
    if len(original)!=len(tagged) or not len(original) or len(original)%3:
        return None
    # IDs are only transferred when the exact indexed corner sequence agrees.
    for name in ('POSITION','NORMAL','TEXCOORD_0'):
        if (name in a)!=(name in b):
            return None
        if name in a and not np.array_equal(baseline.accessor(a[name])[original],annotated.accessor(b[name])[tagged]):
            return None
    tagged_ids = annotated.accessor(b['_ARACHNE_VERTEX'])[tagged].ravel()
    polygons = annotated.accessor(b['_ARACHNE_POLYGON'])[tagged].reshape(-1,3)
    if not np.all(polygons==polygons[:,0:1]):
        return None
    vertices = np.full(len(baseline.accessor(a['POSITION'])),-1,dtype=np.int32)
    vertices[original] = tagged_ids
    if not np.array_equal(vertices[original],tagged_ids):
        return None
    face_ids = polygons[:,0].astype(np.int32)
    unique_faces = len(np.unique(face_ids))
    result = {'vertices':vertices.tolist()}
    if unique_faces != len(face_ids):
        result['polygons'] = face_ids.tolist()
    return result, len(face_ids), unique_faces


def annotate(source, output):
    bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type=='MESH' and
              not obj.name.lower().startswith(('ground','floor','backdrop'))]
    if not meshes:
        raise ValueError('Source scene contains no model meshes')
    fallback = None
    for obj in meshes:
        for slot in obj.material_slots:
            if slot.material is None:
                if fallback is None:
                    fallback = bpy.data.materials.new('Unassigned viewport material')
                    fallback.use_nodes = True
                slot.material = fallback
    for mesh in {obj.data for obj in meshes}:
        if not mesh.polygons:
            continue
        for name, domain, count in (('_arachne_vertex','POINT',len(mesh.vertices)),
                                    ('_arachne_polygon','FACE',len(mesh.polygons))):
            attribute = mesh.attributes.new(name,'FLOAT',domain)
            attribute.data.foreach_set('value',np.arange(count,dtype=np.float32))
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.export_scene.gltf(filepath=str(output),export_format='GLB',use_selection=True,
                              export_texcoords=True,export_normals=True,export_cameras=False,
                              export_lights=False,export_animations=False,export_apply=False,
                              export_attributes=True)


def main(config):
    source, output = Path(config['source']),Path(config['out'])
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    baseline = Glb(Path(config['baseline']))
    model_hash = hashlib.sha256(baseline.data).hexdigest()
    if config['modelSha256']!=model_hash:
        raise ValueError('Viewport model changed')
    with TemporaryDirectory(prefix='topology-',dir=output.parent) as temp:
        staging = Path(temp)
        annotated_file = staging/'annotated.glb'
        annotate(source,annotated_file)
        annotated = Glb(annotated_file)
        originals, annotations = baseline.doc['meshes'],annotated.doc['meshes']
        if len(originals)!=len(annotations):
            raise ValueError('Viewport mesh order differs from annotated source')
        expected = sum(len(mesh['primitives']) for mesh in originals)
        matched = {}
        triangles = polygons = 0
        for mesh_id,(original,tagged) in enumerate(zip(originals,annotations)):
            a,b = original['primitives'],tagged['primitives']
            if original.get('name')!=tagged.get('name') or len(a)!=len(b):
                continue
            for primitive_id,(primitive,with_ids) in enumerate(zip(a,b)):
                try:
                    pair = match_primitive(baseline,annotated,primitive,with_ids)
                except (KeyError,IndexError,ValueError):
                    pair = None
                if pair:
                    ids, triangle_count, polygon_count = pair
                    matched[f'{mesh_id}:{primitive_id}'] = ids
                    triangles += triangle_count
                    polygons += polygon_count
        if not matched or hashlib.sha256(source.read_bytes()).hexdigest()!=before:
            raise ValueError('No verified topology, or source scene changed')
        result = {'modelSha256':model_hash,'primitives':matched,'expectedPrimitives':expected,
                  'matchedPrimitives':len(matched),'triangles':triangles,'polygons':polygons}
        ready = staging/'topology.json'
        ready.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8')
        ready.replace(output)


if __name__=='__main__':
    main(json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf-8')))
