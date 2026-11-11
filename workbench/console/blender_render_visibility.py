"""Discover registered mesh render flags and apply frozen overrides to a disposable scene."""
import hashlib
import json
import sys
from pathlib import Path

import bpy


def apply_render_visibility(scene, overrides, hidden=()):
    for name, visible in (overrides or {}).items():
        obj = scene.objects.get(name)
        if obj is None or obj.type != 'MESH':
            raise ValueError('当前场景找不到需要调整渲染显隐的物体：' + name)
        obj.hide_render = not visible
    for name in hidden:
        obj = scene.objects.get(name)
        if obj is None:
            raise ValueError('当前场景找不到需要隐藏的物体：' + name)
        obj.hide_render = True
    return {name: not scene.objects[name].hide_render for name in (overrides or {})}


def digest(file):
    sha = hashlib.sha256()
    with Path(file).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            sha.update(chunk)
    return sha.hexdigest()


if __name__ == '__main__':
    source, expected = sys.argv[sys.argv.index('--') + 1:]
    if digest(source) != expected:
        raise ValueError('登记的 Blender 源场景已变化')
    bpy.ops.wm.open_mainfile(filepath=source, load_ui=False)
    visible = {obj.name: not obj.hide_render for obj in bpy.context.scene.objects
               if obj.type == 'MESH' and not obj.name.lower().startswith(('ground', 'floor', 'backdrop'))}
    if not visible or digest(source) != expected:
        raise ValueError('无法核对登记源场景的渲染物体')
    print('ARACHNE_RENDER_OBJECTS ' + json.dumps({'sourceSha256': expected, 'visibility': visible}), flush=True)
