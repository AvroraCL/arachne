# coding: utf-8
"""Disposable Blender export for the browser viewport. Never save the source scene."""
import bpy, sys, json, hashlib, struct
from pathlib import Path

cfg=json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf-8'))
source=Path(cfg['source']);out=Path(cfg['out']);out.mkdir(parents=True,exist_ok=True)
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
source_before=digest(source)
bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False)
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH' and not o.name.lower().startswith(('ground','floor','backdrop'))]
if not meshes:raise ValueError('Source scene contains no model meshes')
def uv_hash():
    h=hashlib.sha256()
    for obj in sorted(meshes,key=lambda o:o.name):
        h.update(obj.name.encode())
        for layer in obj.data.uv_layers:
            h.update(layer.name.encode())
            for loop in layer.data:h.update(struct.pack('<ff',*loop.uv))
    return h.hexdigest()
before=uv_hash();mats={};counts={}
for obj in meshes:
    for slot in obj.material_slots:
        original=slot.material
        name=original.name if original else '(none)'
        counts[name]=counts.get(name,0)+1
        if original:
            original['sourceMaterial'] = name
            original['arachneTarget'] = name == cfg['material']
            mats[name] = original
        else:
            if name not in mats:
                mat = bpy.data.materials.new('Unassigned viewport material')
                mat.use_nodes = True
                mat['sourceMaterial'] = name
                mats[name] = mat
            slot.material = mats[name]
if cfg['material'] not in mats:raise ValueError('Registered target material is absent from source scene')
bpy.ops.object.select_all(action='DESELECT')
for obj in meshes:obj.hide_set(False);obj.select_set(True)
bpy.context.view_layer.objects.active=meshes[0]
bpy.ops.export_scene.gltf(filepath=str(out/'model.glb'),export_format='GLB',use_selection=True,export_extras=True,export_texcoords=True,export_normals=True,export_cameras=False,export_lights=False,export_animations=False,export_apply=False)
after=uv_hash()
if before!=after or digest(source)!=source_before:raise ValueError('Source scene or UV changed')
meta={'source_sha256':source_before,'uv_before':before,'uv_after':after,'uv_unchanged':before==after,'source_saved':False,'mesh_count':len(meshes),'vertex_count':sum(len(o.data.vertices) for o in meshes),'materials':[{'name':n,'target':n==cfg['material'],'objects':counts[n]} for n in mats],'limits':['Viewport uses supported source PBR properties and textures; engine-specific shaders may differ.','Target color uses the original UV texture or a completed bake, not a live planar projection.']}
(out/'metadata.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
print('ARACHNE_VIEWPORT_READY',flush=True)
