# coding: utf-8
"""Render a frozen UV-color input with Cycles; no geometry/design writes."""
from pathlib import Path
import bpy, sys, json, os

sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_fingerprint import sha256_file, uv_fingerprint
from blender_material_channels import apply_channels
from blender_material_graph import apply_material_graph
from blender_camera_framing import configure_render_camera
from blender_render_settings import apply_render_settings, effective_render_settings
from blender_cycles_devices import choose_cycles_device
from blender_cycles_progress import CyclesProgress
from blender_render_lighting import apply_render_lighting
from blender_render_passes import configure_render_passes
from blender_render_visibility import apply_render_visibility
from blender_render_region import apply_render_region
from native_worker_lock import watch_parent
watch_parent(int(os.environ['ARACHNE_NATIVE_PARENT_PID']) if 'ARACHNE_NATIVE_PARENT_PID' in os.environ else None)
cfg=json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf-8'))
progress=CyclesProgress(cfg.get('progress',False));progress.emit('source')
out=Path(cfg['out']);out.mkdir(parents=True,exist_ok=False)
source=cfg['source']['reviewSource'];source_hash=sha256_file(source)
if cfg.get('sourceSha256',source_hash)!=source_hash:raise ValueError('Frozen scene fingerprint changed')
if sha256_file(cfg['color'])!=cfg['texture']['sha256']:raise ValueError('Frozen UV texture fingerprint changed')
bpy.ops.wm.open_mainfile(filepath=source,load_ui=False)
scene=bpy.context.scene
if cfg.get('renderLighting'):progress.emit('lighting')
lighting=apply_render_lighting(scene,cfg.get('renderLighting'))
hidden_objects=cfg.get('hiddenObjects',[])
render_visibility=apply_render_visibility(scene,cfg.get('renderVisibility'),hidden_objects)
before=uv_fingerprint(scene);progress.emit('materials')
material=bpy.data.materials.get(cfg['source']['material'])
if material is None or not material.use_nodes:raise ValueError('Registered material has no shader graph')
bsdf=next((n for n in material.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
if bsdf is None:raise ValueError('Registered material has no Principled BSDF')
tex=material.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(cfg['color'],check_existing=False)
material.node_tree.links.new(tex.outputs['Color'],bsdf.inputs['Base Color'])
channel_report=apply_channels(material,bsdf,cfg.get('channels'))
node_material=apply_material_graph(material,cfg.get('nodeMaterial'))
settings=cfg['settings'];apply_render_settings(scene,settings,cfg.get('renderAppearance'))
scene.render.resolution_x=settings['width'];scene.render.resolution_y=settings['height'];scene.render.resolution_percentage=100
scene.render.pixel_aspect_x=scene.render.pixel_aspect_y=1
file_format=scene.render.image_settings.file_format
output_name='cycles.exr' if file_format=='OPEN_EXR' else 'cycles.png'
scene.render.filepath=str(out/output_name)
progress.emit('camera');camera_settings=settings.get('camera')
framing=configure_render_camera(scene,settings,cfg.get('renderOptics'))
if scene.camera is None:raise ValueError('No source or requested render camera')
region=apply_render_region(scene,cfg.get('renderRegion'))
passes=configure_render_passes(scene,settings.get('renderPasses'),out)
requested_device=settings.get('device','auto');fallback=None
device,devices=choose_cycles_device(scene,requested_device)
progress.emit('device',device=device)
print('CYCLES_DEVICE '+device+' '+','.join(devices),flush=True)
with progress.collect():
    progress.emit('scene')
    try:bpy.ops.render.render(write_still=True)
    except Exception as e:
        if device=='CPU' or requested_device=='gpu':raise
        fallback=str(e);device='CPU';devices=[];scene.cycles.device='CPU'
        progress.emit('fallback',device=device)
        bpy.ops.render.render(write_still=True)
progress.emit('verify')
effective=effective_render_settings(scene)
if file_format=='OPEN_EXR':
    # Save the same render buffer with the scene's display transform for the UI.
    image=scene.render.image_settings
    image.file_format='PNG'
    image.color_depth='8'
    image.color_mode=effective['colorMode']
    image.color_management='FOLLOW_SCENE'
    bpy.data.images['Render Result'].save_render(str(out/'cycles.png'),scene=scene)
after=uv_fingerprint(scene)
if after!=before or sha256_file(source)!=source_hash:raise ValueError('Source scene or UV changed')
report={'channels':channel_report,'engine':scene.render.engine,'samples':scene.cycles.samples,'denoising':scene.cycles.use_denoising,'frame_resolution':[scene.render.resolution_x,scene.render.resolution_y],'resolution':region['output'] if region else [scene.render.resolution_x,scene.render.resolution_y],'device':device,'devices':devices,'gpu_fallback':fallback,'requested_device':requested_device,'render_effective':effective,'output':{'file':output_name,'preview':'cycles.png','previewBitDepth':8 if file_format=='OPEN_EXR' else effective['bitDepth']},'camera':camera_settings,'camera_framing':framing,'texture':cfg['texture'],'document_revision':cfg['revision'],'source_sha256':source_hash,'uv_before':before,'uv_after':after,'uv_unchanged':before==after,'source_saved':False,'scope':('Render the baked paint revision and its registered model.' if cfg['texture']['kind']=='paint' else 'Render existing frozen UV texture. Unbaked 2D edits are not included; this is not design/geometry acceptance.'),'display':'Full source-scene materials and lighting; realtime wireframe/unlit/solo toggles do not change the Cycles render.'}
if passes:report['passes']=passes
if region:report['render_region']=region
if render_visibility:report['render_visibility']=render_visibility
if node_material:report['nodeMaterial']=node_material
if lighting:report['lighting']=lighting
if 'hiddenObjects' in cfg:report['hidden_objects']=hidden_objects
(out/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
progress.emit('complete');print('ARACHNE_CYCLES_COMPLETE',flush=True)
