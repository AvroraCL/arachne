"""Install audited GLB plus the immutable original projection surface."""
import json
import shutil
import sys
from pathlib import Path

from PIL import Image
from model_glb import Model, checksum
from native_worker_lock import watch_parent


def read(file):
    return json.loads(Path(file).read_bytes())


def write(file, value):
    Path(file).write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')


def verified(source, filename):
    path = Path(filename)
    if checksum(path) != source['files'].get(str(path)):
        raise ValueError(f'旧工程的登记文件缺失或指纹变化：{path.name}')
    return path


def swap_uv(scene, material, channel):
    uv = f'TEXCOORD_{channel}'
    matching = {i for i,m in enumerate(scene['materials'])
                if m.get('extras',{}).get('sourceMaterial',m.get('name')) == material}
    for mesh in scene['meshes']:
        for primitive in mesh['primitives']:
            if primitive.get('material') in matching:
                attrs = primitive['attributes']
                if uv not in attrs or 'TEXCOORD_0' not in attrs:
                    raise ValueError('无法保留原涂装 UV 和材质的纹理坐标')
                attrs[uv],attrs['TEXCOORD_0'] = attrs['TEXCOORD_0'],attrs[uv]

    def remap(value):
        if isinstance(value,dict):
            for key,item in value.items():
                if key.endswith('Texture') and isinstance(item,dict) and 'index' in item:
                    def swap(obj,coord):
                        if coord == 0:
                            obj['texCoord'] = channel
                        elif coord == channel:
                            obj['texCoord'] = 0
                    swap(item,item.get('texCoord',0))
                    transform = item.get('extensions',{}).get('KHR_texture_transform',{})
                    if 'texCoord' in transform:
                        swap(transform,transform['texCoord'])
                else:
                    remap(item)
    for i in matching:
        remap(scene['materials'][i])


def main(config):
    watch_parent(config.get('ownerPid'))
    source, out = config['source'], Path(config['out'])
    incoming = Path(config['input'])
    audit = read(incoming/'migration-audit.json')
    raw = incoming/'model.glb'
    if checksum(raw) != audit['rawGlbSha256']:
        raise ValueError('经过 UV 校验的 GLB 指纹变化')
    base = verified(source, source['baseImage'])
    with Image.open(base) as image:
        if image.format!='PNG' or not all(0<size<=8192 for size in image.size):
            raise ValueError('旧登记工程的底图不是有效 PNG')
        image.verify()
    cache, guides = Path(source['cacheRun']), Path(source['bundle'])
    record = read(verified(source,cache/'geometry_report.json'))
    legacy = audit['legacyUvSha256']
    if record['uv_unchanged'] is not True or legacy!=record['uv_before_sha256'] or legacy!=record['uv_after_sha256']:
        raise ValueError('旧表面缓存与原 UV 指纹不一致')
    stem = next(item['file'] for item in record['materials'] if item['name']==source['material'])
    if not stem or Path(stem).name!=stem:
        raise ValueError('旧表面映射文件名无效')
    settings = read(verified(source,cache/'resolved_config.json'))
    cameras = read(verified(source,guides/'cameras.json'))
    if 'top' not in settings['designs'] or list(settings['designs'])!=record['view_names']:
        raise ValueError('旧表面的投影视角与登记不一致')
    # Keep only render-independent settings. The original paths and .blend
    # reference never enter the native registration or delivery ZIP.
    kept = ('mode','angle_margin','min_projection_cos','grazing_cos',
            'projection_exclude_objects','projection_exclude_regions','projection_exclude_materials','guide')
    options = {key:settings[key] for key in kept if key in settings}
    options['designs'] = {name:{k:bool(view.get(k,False)) for k in ('flip_u','flip_v')}
                          for name,view in settings['designs'].items()}
    options['registered_objects'] = audit['objects']

    model = Model(raw)
    final = out/'model.glb'
    if audit['textureCoordinate']:
        swap_uv(model.scene,source['material'],audit['textureCoordinate'])
        model.save(final)
        model = Model(final)
    else:
        shutil.copyfile(raw,final)
    uv, digest = model.uv_digest(), checksum(final)
    shutil.copyfile(base,out/'base.png')
    save_cache, save_guides = out/'surface/cache', out/'surface/guides'
    (save_cache/'mapping').mkdir(parents=True)
    (save_guides/'top').mkdir(parents=True)
    for old, new in [
        (cache/f'mapping/{stem}.npz',save_cache/'mapping/surface.npz'),
        *[(cache/'mapping'/name,save_cache/'mapping'/name) for name in ('faces.npz','edges.npz')],
        (guides/'surfaces.npz',save_guides/'surfaces.npz'),
        *[(guides/'top'/name,save_guides/'top'/name) for name in ('receiver.png','protected.png','silhouette.png')]
    ]:
        shutil.copyfile(verified(source,old),new)
    record.update(materials=[dict(name=source['material'],file='surface')],legacy_uv_sha256=legacy,
                  uv_before_sha256=uv,uv_after_sha256=uv,engine='migrated-glb')
    record.pop('blender',None)
    write(save_cache/'geometry_report.json',record)
    write(save_cache/'resolved_config.json',options)
    write(save_guides/'cameras.json',cameras)
    write(out/'registration.json',dict(cameras=cameras,settings=options))
    write(out/'topology.json',dict(modelSha256=digest,primitives=model.topology()))
    write(out/'metadata.json',dict(source_sha256=digest,uv_before=uv,uv_after=uv,uv_unchanged=True,
         legacySurface=True,legacyUvSha256=legacy,legacyModelSha256=config['sourceSha256'],
         rawGlbSha256=audit['rawGlbSha256'],verifiedTriangles=audit['verifiedTriangles'],
         render_visibility=audit['render_visibility'],mesh_count=len(model.primitives),
         vertex_count=sum(len(p['positions']) for p in model.primitives),
         material=source['material'],base=config['base']))


if __name__=='__main__':
    try:
        main(read(sys.argv[1]))
    except (ValueError,KeyError,OSError,StopIteration) as error:
        sys.exit(str(error))
