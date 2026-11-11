"""Apply a frozen project's modeling commands to a disposable native scene.

Original scene, UVs and camera registration are never overwritten. Projection
maps and occlusion are recomputed; moving shared-UV surfaces may create conflicts.
"""
import hashlib
import json
import runpy
import shutil
import struct
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix
sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_worker_lock import cache_lock, watch_parent


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def uv_hash():
    result = hashlib.sha256()
    for obj in sorted((o for o in bpy.context.scene.objects if o.type == 'MESH'), key=lambda o: o.name):
        result.update(obj.name.encode())
        for layer in obj.data.uv_layers:
            result.update(layer.name.encode())
            for loop in layer.data:
                result.update(struct.pack('<ff', *loop.uv))
    return result.hexdigest()


def apply_steps(steps):
    # glTF Y-up world to the original Blender Z-up world.
    basis = Matrix.Rotation(-3.141592653589793 / 2, 4, 'X')
    inverse = basis.inverted()
    for step in steps:
        values = step['matrix']
        delta = inverse @ Matrix([values[i::4] for i in range(4)]) @ basis
        targets = []
        vertices = {}
        for target in step['targets']:
            obj = bpy.data.objects.get(target['object'])
            if obj is None or obj.type != 'MESH':
                raise ValueError('建模命令引用了不存在的原模型物体')
            if 'vertices' in target:
                entry = vertices.setdefault(obj.name, (obj, set(), obj.matrix_world.copy()))
                entry[1].update(target['vertices'])
            else:
                targets.append((obj, obj.matrix_world.copy()))
        for obj, ids, world in vertices.values():
            if not ids or min(ids) < 0 or max(ids) >= len(obj.data.vertices):
                raise ValueError('建模命令顶点超出原拓扑范围')
            # Linked mesh objects must not inadvertently receive another object's edit.
            if obj.data.users > 1:
                obj.data = obj.data.copy()
            local = world.inverted() @ delta @ world
            for index in ids:
                obj.data.vertices[index].co = local @ obj.data.vertices[index].co
            obj.data.update()
        for obj, world in targets:
            obj.matrix_world = delta @ world
        bpy.context.view_layer.update()


def main(config):
    source = config['source']
    out = Path(config['out'])
    original = Path(source['reviewSource'])
    before = sha(original)
    if before != source['files'][str(original)]:
        raise ValueError('原模型指纹变化')
    (out / 'report.json').unlink(missing_ok=True)
    # A previous failed build is retried only inside its dedicated cache folder.
    for name in ('cache', 'guides'):
        shutil.rmtree(out / name, ignore_errors=True)
    print('ARACHNE_MODEL_STAGE '+json.dumps({'stage':'保存模型副本'},ensure_ascii=False),flush=True)
    bpy.ops.wm.open_mainfile(filepath=str(original), load_ui=False)
    uv_before = uv_hash()
    apply_steps(config['modeling']['nativeSteps'])
    if uv_hash() != uv_before:
        raise ValueError('建模过程改变了原 UV')
    bpy.ops.wm.save_as_mainfile(filepath=str(out / 'model.blend'), check_existing=False)
    tools = Path(__file__).resolve().parent.parent / 'tools'
    sys.path.insert(0, str(tools))
    participating = [obj.name for obj in bpy.context.scene.objects if obj.type == 'MESH' and
                     not obj.name.lower().startswith(('ground', 'floor', 'backdrop'))]
    for name, folder, script in (('cache', source['cacheRun'], 'geometry.py'),
                                 ('guides', source['bundle'], 'prepare_guides.py')):
        target = out / name
        target.mkdir()
        settings = json.loads((Path(folder) / 'resolved_config.json').read_bytes())
        settings.update(model=str(out / 'model.blend'), camera_file=str(Path(source['bundle']) / 'cameras.json'),
                        include_objects=participating)
        if name == 'cache':
            settings['mapping_materials'] = [source['material']]
        (target / 'resolved_config.json').write_text(json.dumps(settings), encoding='utf-8')
        shutil.copyfile(Path(source['bundle']) / 'cameras.json', target / 'cameras.json')
        sys.argv = ['blender', '--', str(target)]
        print('ARACHNE_MODEL_STAGE '+json.dumps({'stage':'计算投影与遮挡' if name=='cache' else '更新视图引导'},ensure_ascii=False),flush=True)
        runpy.run_path(str(tools / script), run_name='__main__')
    print('ARACHNE_MODEL_STAGE '+json.dumps({'stage':'校验原 UV 与保护区'},ensure_ascii=False),flush=True)
    baseline = json.loads((Path(source['cacheRun']) / 'geometry_report.json').read_bytes())
    rebuilt = json.loads((out / 'cache/geometry_report.json').read_bytes())
    if baseline['uv_before_sha256'] != rebuilt['uv_before_sha256']:
        raise ValueError('重建映射与登记模型的原 UV 不一致')
    # Protection already registered in UV space stays protected when a user
    # moves it out of an original world-space exclusion box. New exclusions
    # and newly separated shared UVs are added by the rebuilt mapping.
    def target_map(report, folder):
        stem = next(item['file'] for item in report['materials'] if item['name'] == source['material'])
        return Path(folder) / 'mapping' / (stem + '.npz')
    file = target_map(rebuilt, out / 'cache')
    with np.load(file) as archive:
        mapping = {key: archive[key] for key in archive.files}
    with np.load(target_map(baseline, source['cacheRun'])) as archive:
        for key in ('protected', 'collision'):
            mapping[key] = np.maximum(mapping[key], archive[key])
    np.savez_compressed(file, **mapping)
    if sha(original) != before:
        raise ValueError('原模型发生变化')
    files = {str(file.relative_to(out)): sha(file) for file in sorted(out.rglob('*'))
             if file.is_file() and file.name not in ('input.json', 'build.log', 'report.json', '.build.lock') and not file.name.endswith('.blend1')}
    # Include the guide report too (its basename also happens to be report.json).
    files['guides/report.json'] = sha(out / 'guides/report.json')
    report = dict(sourceSha256=before, modelFingerprint=config['modelFingerprint'],
                  modelSha256=sha(out / 'model.blend'), uvUnchanged=True, uvSha256=uv_before, files=files)
    temporary = out / 'report.json.tmp'
    temporary.write_text(json.dumps(report), encoding='utf-8')
    temporary.replace(out / 'report.json')


def cached(config):
    out = Path(config['out'])
    try:
        report = json.loads((out / 'report.json').read_bytes())
        original = config['source']['reviewSource']
        return (report['modelFingerprint'] == config['modelFingerprint'] and report['uvUnchanged'] is True
                and report['sourceSha256'] == config['source']['files'][original] == sha(original)
                and bool(report['files']) and all(sha(out / name) == value for name, value in report['files'].items()))
    except (OSError, ValueError, KeyError, TypeError):
        return False


if __name__ == '__main__':
    config = json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_bytes())
    watch_parent(config.get('ownerPid'))
    with cache_lock(config['out'], lambda: print('ARACHNE_MODEL_STAGE '+json.dumps(
            {'stage':'等待上次模型任务释放表面'},ensure_ascii=False),flush=True)):
        if not cached(config):
            main(config)
