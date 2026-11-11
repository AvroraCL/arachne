"""Host one native Cycles viewport in a private macOS Blender process."""
import ctypes as ct
import json
from math import isclose
import os
from pathlib import Path
import sys
import time
import traceback
from uuid import uuid4

import bpy
import cycles
import gpu
import numpy as np
from bpy_extras.view3d_utils import location_3d_to_region_2d

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_camera_framing import configure_render_camera, viewport_camera_transform
from blender_cycles_devices import choose_cycles_device
from blender_fingerprint import sha256_file
from blender_material_channels import apply_channels
from blender_material_graph import apply_material_graph
from blender_render_lighting import apply_render_lighting
from blender_render_settings import apply_render_settings
from native_worker_lock import watch_parent


def hide_worker_window():
    # This only touches AppKit windows owned by the disposable Blender process.
    objc = ct.CDLL('/usr/lib/libobjc.A.dylib')
    objc.objc_getClass.argtypes = (ct.c_char_p,)
    objc.objc_getClass.restype = ct.c_void_p
    objc.sel_registerName.argtypes = (ct.c_char_p,)
    objc.sel_registerName.restype = ct.c_void_p

    def message(obj, name, result=ct.c_void_p, *args):
        signature = ct.CFUNCTYPE(result, ct.c_void_p, ct.c_void_p, *(type(arg) for arg in args))
        return signature(('objc_msgSend', objc))(obj, objc.sel_registerName(name.encode()), *args)

    app = message(objc.objc_getClass(b'NSApplication'), 'sharedApplication')
    message(app, 'setActivationPolicy:', ct.c_bool, ct.c_long(1))
    windows = message(app, 'windows')
    for index in range(message(windows, 'count', ct.c_ulong)):
        window = message(windows, 'objectAtIndex:', ct.c_void_p, ct.c_ulong(index))
        message(window, 'setIgnoresMouseEvents:', None, ct.c_bool(True))
        message(window, 'setAlphaValue:', None, ct.c_double(0.0))


class Viewport:
    def __init__(self, folder):
        self.folder = folder
        self.command = folder / 'command.json'
        self.timestamp = None
        self.area = self.camera = self.image = None
        self.source = self.revision = self.options = self.settings = None
        self.scene_setup = None
        self.original_material = self.material = None
        self.imported_images = []
        self.base_visibility = {}
        self.hidden = None
        self.sequence = self.number = 0
        self.device = None
        self.paused = True
        self.last_capture = self.published_sequence = 0
        self.last_pixels = None
        self.skip_draw = 0
        self.fit_border = True
        self.debug = os.environ.get('ARACHNE_CYCLES_DEBUG') == '1'
        self.window_hidden = False
        self.native_session = self.session_id = None

    def emit(self, kind, **values):
        print('ARACHNE_CYCLES_VIEW ' + json.dumps({'kind': kind, **values}), flush=True)

    def open_source(self, cfg):
        source = cfg['source']['reviewSource']
        if sha256_file(source) != cfg['sourceHash']:
            raise ValueError('源场景指纹已变化')
        if self.debug:
            print('Opening verified Blender scene', flush=True)
        bpy.ops.wm.open_mainfile(filepath=source, load_ui=False)
        if self.debug:
            print('Scene loaded', flush=True)
        window = bpy.context.window_manager.windows[0]
        self.area = max((area for area in window.screen.areas if area.type == 'VIEW_3D'),
                        key=lambda area: area.width * area.height)
        space = self.area.spaces.active
        space.overlay.show_overlays = False
        space.show_gizmo = False
        space.shading.use_scene_world_render = True
        space.shading.use_scene_lights_render = True
        self.original_material = bpy.data.materials.get(cfg['source']['material'])
        if self.original_material is None or not self.original_material.use_nodes:
            raise ValueError('登记材质缺少着色器')
        self.material = self.original_material
        self.imported_images = []
        self.camera = self.image = self.revision = self.options = self.settings = self.hidden = self.device = None
        self.base_visibility = {obj.name: obj.hide_get() or obj.hide_render for obj in window.scene.objects}
        self.source = source
        self.fit_border = True
        install_draw_hook()

    def material_update(self, cfg):
        if sha256_file(cfg['color']) != cfg['texture']['sha256']:
            raise ValueError('贴图指纹已变化')
        images = set(bpy.data.images)
        material = self.original_material.copy()
        bsdf = next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
        image = bpy.data.images.load(cfg['color'], check_existing=False)
        texture = material.node_tree.nodes.new('ShaderNodeTexImage')
        texture.image = image
        material.node_tree.links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
        apply_channels(material, bsdf, cfg['channels'])
        apply_material_graph(material, cfg.get('nodeMaterial'))
        self.material.user_remap(material)
        if self.material != self.original_material:
            bpy.data.materials.remove(self.material)
        self.material = material
        for image in self.imported_images:
            if not image.users:
                bpy.data.images.remove(image)
        self.imported_images = list(set(bpy.data.images) - images)

    def update(self, cmd):
        cfg = cmd['config']
        scene_setup = (cfg['source']['reviewSource'], cfg.get('renderLighting'), cfg.get('renderAppearance'))
        changed_scene = self.scene_setup != scene_setup
        if changed_scene:
            self.open_source(cfg)
            self.scene_setup = scene_setup
        window = bpy.context.window_manager.windows[0]
        region = next(region for region in self.area.regions if region.type == 'WINDOW')
        with bpy.context.temp_override(window=window, area=self.area, region=region):
            if changed_scene:
                apply_render_lighting(window.scene, cfg.get('renderLighting'))
            self.update_scene(window.scene, cmd, cfg)

    def update_scene(self, scene, cmd, cfg):
        settings = cmd['settings']
        changed_revision = self.revision != cmd['revision']
        if changed_revision or self.options != cmd['quality']:
            self.material_update(cfg)
            self.revision = cmd['revision']
            self.options = cmd['quality']
            self.hidden = None
        hidden = cmd['hiddenObjects']
        if self.hidden != hidden:
            override = cfg.get('renderVisibility') or {}
            excluded = set(hidden)
            for obj in scene.objects:
                if obj.name in self.base_visibility:
                    obj.hide_set(obj.hide_render if obj.type == 'LIGHT' else
                                 not override.get(obj.name, not self.base_visibility[obj.name]) or obj.name in excluded)
            self.hidden = hidden
        camera = settings['camera']
        shape = (settings['width'], settings['height'])
        previous = self.settings or {}
        previous_camera = previous.get('camera')
        changed_shape = shape != (previous.get('width'), previous.get('height'))
        reconfigure_camera = (self.camera is None or changed_revision or changed_shape or
                              previous_camera is None or
                              camera['projection'] != previous_camera['projection'] or
                              camera['fov'] != previous_camera['fov'])
        changed_camera = reconfigure_camera or camera != previous_camera
        fixed = {key: value for key, value in settings.items() if key not in ('camera', 'width', 'height')}
        prior = {key: value for key, value in previous.items() if key not in ('camera', 'width', 'height')}
        if fixed != prior:
            apply_render_settings(scene, settings, cfg.get('renderAppearance'))
            scene.cycles.preview_samples = settings['samples']
            scene.cycles.use_preview_denoising = settings.get('denoise', True)
            if scene.cycles.use_preview_denoising:
                # Let Cycles display early samples before running viewport denoising.
                scene.cycles.preview_denoising_start_sample = min(4, settings['samples'])
            if 'adaptive' in settings:
                scene.cycles.use_preview_adaptive_sampling = settings['adaptive']
            if 'noiseThreshold' in settings:
                scene.cycles.preview_adaptive_threshold = settings['noiseThreshold']
            if not self.device or settings.get('device') != previous.get('device'):
                self.device, _ = choose_cycles_device(scene, settings.get('device', 'auto'))
            # This image receives the same display transform Blender applies to the viewport.
            scene.render.image_settings.color_mode = 'RGBA'
            # Frame PNGs travel over loopback; favor encoding speed over file size.
            scene.render.image_settings.compression = 5
        if reconfigure_camera:
            configure_render_camera(scene, settings, cfg.get('renderOptics'), camera=self.camera)
            self.camera = scene.camera
        elif changed_camera:
            self.update_camera_pose(camera, previous_camera, cfg.get('renderOptics'))
        space = self.area.spaces.active
        if space.use_local_camera:
            space.use_local_camera = False
        if space.region_3d.view_perspective != 'CAMERA':
            space.region_3d.view_perspective = 'CAMERA'
        if changed_shape:
            space.region_3d.view_camera_offset = (0, 0)
            space.region_3d.view_camera_zoom = 0
            self.fit_border = True
        self.settings = settings
        if space.shading.type != 'RENDERED':
            space.shading.type = 'RENDERED'
        self.paused = cmd['paused']
        if scene.cycles.preview_pause != self.paused:
            scene.cycles.preview_pause = self.paused
        self.sequence = cmd['sequence']
        self.skip_draw = int(changed_camera or fixed != prior)
        self.area.tag_redraw()
        self.emit('applied', sequence=self.sequence, revision=self.revision)

    def update_camera_pose(self, camera, previous, optics):
        # Render and lens properties tag the scene for evaluation. Only change
        # the inputs affected by navigation so Cycles can reset directly to the new pose.
        if any(camera[key] != previous[key] for key in ('eye', 'target', 'up')):
            transform, distance = viewport_camera_transform(camera)
            self.camera.matrix_world = transform
            if optics and optics['enabled'] and optics['focusMode'] == 'target':
                dof = self.camera.data.dof
                if not isclose(dof.focus_distance, distance, rel_tol=1e-6, abs_tol=1e-6):
                    dof.focus_distance = distance
        if camera['projection'] == 'orthographic' and camera['orthoHeight'] != previous['orthoHeight']:
            self.camera.data.ortho_scale = camera['orthoHeight']

    def tick(self):
        try:
            timestamp = self.command.stat().st_mtime_ns
        except FileNotFoundError:
            return .03
        if timestamp == self.timestamp:
            return .025 if self.paused else .016
        self.timestamp = timestamp
        if self.debug:
            print('Viewport command received', flush=True)
        try:
            self.update(json.loads(self.command.read_text(encoding='utf-8')))
        except Exception as error:
            traceback.print_exc()
            self.emit('error', message=str(error))
            os._exit(1)
        return .025 if self.paused else .016

    def capture(self, context, session):
        if context.area != self.area or self.paused or self.sequence <= 0:
            return
        if not self.window_hidden:
            self.window_hidden = True
            bpy.app.timers.register(hide_worker_window, first_interval=.01)
        if self.skip_draw:
            self.skip_draw -= 1
            self.defer_redraw(first_frame=True)
            return
        first_frame = self.published_sequence != self.sequence
        now = time.monotonic()
        if not first_frame and now - self.last_capture < .075:
            # Ensure a redraw after a fast final sample that arrived between captures.
            self.defer_redraw()
            return
        self.last_capture = now
        fb = gpu.state.active_framebuffer_get()
        x, y, width, height = fb.viewport_get()
        region, rv = context.region, context.region_data
        corners = [location_3d_to_region_2d(region, rv, self.camera.matrix_world @ p)
                   for p in self.camera.data.view_frame(scene=context.scene)]
        if any(corner is None for corner in corners):
            return
        xs, ys = zip(*corners)
        left, right = min(xs), max(xs)
        bottom, top = min(ys), max(ys)
        if self.fit_border:
            scale = min(region.width / (right - left), region.height / (top - bottom)) * .98
            rv.view_camera_zoom = max(-30, min(550, (2 ** .5 * scale ** .5 - 2 ** .5) * 50))
            self.fit_border = False
            self.skip_draw = 1
            self.defer_redraw(first_frame=True)
            return
        left, right = round(left * width / region.width), round(right * width / region.width)
        bottom, top = round(bottom * height / region.height), round(top * height / region.height)
        left, right = max(0, left), min(width, right)
        bottom, top = max(0, bottom), min(height, top)
        width, height = right - left, top - bottom
        if min(width, height) < 16:
            return
        buffer = fb.read_color(x + left, y + bottom, width, height, 4, 0, 'FLOAT')
        buffer.dimensions = width * height * 4
        pixels = np.asarray(buffer, dtype=np.float32)
        if not np.any(pixels):
            return
        key = (self.revision, hash(pixels.tobytes()))
        if key == self.last_pixels:
            return
        self.last_pixels = key
        if self.image is None:
            self.image = bpy.data.images.new('Arachne Viewport Frame', width=width, height=height, alpha=True, float_buffer=True)
        elif tuple(self.image.size) != (width, height):
            self.image.scale(width, height)
        self.image.pixels.foreach_set(pixels)
        self.number += 1
        file = self.folder / f'frame-{self.number}.png'
        self.image.save_render(str(file), scene=context.scene)
        self.published_sequence = self.sequence
        if self.number > 8:
            (self.folder / f'frame-{self.number - 8}.png').unlink(missing_ok=True)
        if self.native_session != session:
            self.native_session, self.session_id = session, uuid4().hex
        self.emit('frame', sequence=self.sequence, revision=self.revision, number=self.number,
                  width=width, height=height, device=self.device, quality=self.options, session=self.session_id)

    redraw_pending = first_redraw_pending = False

    def defer_redraw(self, first_frame=False):
        # A pending sample redraw must not delay a redraw after the camera changes.
        if first_frame:
            if not self.first_redraw_pending:
                self.first_redraw_pending = True
                bpy.app.timers.register(self.redraw_first, first_interval=.016)
        elif not self.redraw_pending and not self.first_redraw_pending:
            self.redraw_pending = True
            bpy.app.timers.register(self.redraw, first_interval=.08)

    def redraw_first(self):
        self.first_redraw_pending = False
        if self.area is not None and not self.paused:
            self.area.tag_redraw()

    def redraw(self):
        self.redraw_pending = False
        if self.area is not None and not self.paused:
            self.area.tag_redraw()


folder = Path(sys.argv[sys.argv.index('--') + 1])
watch_parent(int(os.environ['ARACHNE_NATIVE_PARENT_PID']))
viewport = Viewport(folder)


def install_draw_hook():
    native_draw = cycles.CyclesRender.view_draw
    if getattr(native_draw, 'arachne', False):
        return

    def draw(self, context, depsgraph):
        native_draw(self, context, depsgraph)
        try:
            viewport.capture(context, str(self.session))
        except Exception as error:
            traceback.print_exc()
            viewport.emit('error', message=str(error))
            os._exit(1)

    draw.arachne = True
    cycles.CyclesRender.view_draw = draw


def boot():
    bpy.context.preferences.view.show_splash = False
    if viewport.debug:
        print('Worker initialized', bpy.app.version_string, flush=True)
    viewport.tick()
    bpy.app.timers.register(viewport.tick, first_interval=.03, persistent=True)


boot()
