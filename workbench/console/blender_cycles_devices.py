"""Cycles device discovery shared by render workers and the workbench probe."""
import json
import sys

import bpy


def backends():
    if sys.platform == 'darwin':
        return ('METAL',)
    return ('OPTIX', 'CUDA', 'HIP', 'ONEAPI')


def cycles_preferences():
    if not bpy.app.build_options.cycles:
        return None
    addon = bpy.context.preferences.addons.get('cycles')
    return addon.preferences if addon is not None else None


def devices_for_backend(preferences, backend):
    try:
        preferences.compute_device_type = backend
        preferences.refresh_devices()
        return [device for device in preferences.devices if device.type == backend]
    except (TypeError, ValueError, RuntimeError):
        return []


def choose_cycles_device(scene, requested):
    if requested != 'cpu':
        preferences = cycles_preferences()
        if preferences is not None:
            for backend in backends():
                devices = devices_for_backend(preferences, backend)
                if not devices:
                    continue
                for device in preferences.devices:
                    device.use = device.type == backend
                scene.cycles.device = 'GPU'
                return backend, [device.name for device in devices]
        if requested == 'gpu':
            raise RuntimeError('没有可用的 Cycles GPU 设备，请在渲染属性中选择自动或 CPU')
    scene.cycles.device = 'CPU'
    return 'CPU', []


if __name__ == '__main__':
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from blender_render_passes import supports_render_passes
    preferences = cycles_preferences()
    gpus = [] if preferences is None else [
        {'backend': backend, 'name': device.name}
        for backend in backends()
        for device in devices_for_backend(preferences, backend)
    ]
    print('ARACHNE_CYCLES_DEVICES ' + json.dumps({
        'version': bpy.app.version_string,
        'available': preferences is not None,
        'renderPasses': supports_render_passes(),
        'gpus': gpus,
    }), flush=True)
