# coding: utf-8
from pathlib import Path
import bpy,sys,json,os
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_fingerprint import sha256_file, uv_fingerprint
from blender_material_channels import apply_channels
from blender_material_graph import apply_material_graph
from blender_camera_framing import configure_render_camera
from blender_render_settings import apply_render_settings, effective_render_settings
from blender_render_lighting import apply_render_lighting
from blender_render_passes import configure_render_passes
from blender_render_visibility import apply_render_visibility
from blender_render_region import apply_render_region
from native_worker_lock import watch_parent
watch_parent(int(os.environ['ARACHNE_NATIVE_PARENT_PID']) if 'ARACHNE_NATIVE_PARENT_PID' in os.environ else None)
cfg=json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf-8'));out=Path(cfg['out']);source=Path(cfg['source']['reviewSource']);source_sha=sha256_file(source)
bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False)
before=uv_fingerprint(bpy.context.scene);m=bpy.data.materials.get(cfg['source']['material'])
if not m or not m.use_nodes:raise ValueError('Registered material unavailable')
bsdf=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED');tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(cfg['color'],check_existing=False);tex.image.pack();m.node_tree.links.new(tex.outputs['Color'],bsdf.inputs['Base Color'])
channel_report=apply_channels(m,bsdf,cfg.get('channels'),pack=True)
node_material=apply_material_graph(m,cfg.get('nodeMaterial'))
framing=None
passes=None
region=None
lighting=apply_render_lighting(bpy.context.scene,cfg.get('renderLighting'))
render_visibility=apply_render_visibility(bpy.context.scene,cfg.get('renderVisibility'))
if cfg.get('settings'):
 settings=cfg['settings'];scene=bpy.context.scene
 framing=configure_render_camera(scene,settings,cfg.get('renderOptics'))
 apply_render_settings(scene,settings,cfg.get('renderAppearance'))
 region=apply_render_region(scene,cfg.get('renderRegion'))
 passes=configure_render_passes(scene,settings.get('renderPasses'),'//')
 scene.render.filepath='//render.exr' if scene.render.image_settings.file_format=='OPEN_EXR' else '//render.png'
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=str(out/'preview.blend'))
after=uv_fingerprint(bpy.context.scene);assert before==after and sha256_file(source)==source_sha
(out/'blend-validation.json').write_text(json.dumps({**({'camera_framing':framing,'render_settings':cfg['settings'],'render_effective':effective_render_settings(scene)} if framing else {}),**({'nodeMaterial':node_material} if node_material else {}),**({'passes':passes} if passes else {}),**({'render_region':region} if region else {}),**({'render_visibility':render_visibility} if render_visibility else {}),**({'lighting':lighting} if lighting else {}),'channels':channel_report,'roundId':cfg['roundId'],'uv_before':before,'uv_after':after,'uv_unchanged':before==after,'source_sha256':source_sha,'source_saved':False}),encoding='utf-8')
print('IMAGE_WORKFLOW_BLEND_COMPLETE',flush=True)
