# coding: utf-8
"""Read the editable payload from a local Arachne delivery ZIP."""
from pathlib import Path
from zipfile import BadZipFile, ZipFile, ZIP_DEFLATED, ZIP_STORED
import hashlib
import json
import re
import stat
import struct
import sys
import zlib


MANIFEST = 'editable/manifest.json'
DELIVERY = 'delivery-report.json'
PROJECT = 'project-report.json'
PROJECT_FORMAT = 'arachne-pbr-paint-project'
TEXTURE_REPORT = 'projection-report.json'
TEXTURE_NAMES = {f'textures/f_16xl_{channel}.png' for channel in
                 ('BaseColor', 'metallic', 'roughness', 'normal', 'height', 'emission', 'alpha', 'ao')}
LEGACY_TEXTURE_NAMES = {'textures/f_16xl_BaseColor.png', 'textures/f_16xl_metallic.png',
                        'textures/f_16xl_roughness.png'}
REGISTRATION_LIMITS = {'registration/model.glb':128, 'registration/base.png':72,
                       'registration/metadata.json':1, 'registration/registration.json':1}
PRESERVED_SURFACE_LIMITS = {
    'registration/surface/cache/geometry_report.json': 8,
    'registration/surface/cache/resolved_config.json': 8,
    'registration/surface/cache/mapping/surface.npz': 320,
    'registration/surface/cache/mapping/faces.npz': 128,
    'registration/surface/cache/mapping/edges.npz': 64,
    'registration/surface/guides/cameras.json': 8,
    'registration/surface/guides/surfaces.npz': 160,
    **{f'registration/surface/guides/top/{name}.png': 8 for name in ('receiver','protected','silhouette')}
}
MIB = 1024 * 1024
ZIP_END = struct.Struct('<4s4H2LH')
ZIP_END_MARKER = b'PK\x05\x06'
ZIP64_LOCATOR = b'PK\x06\x07'
MAX_ENTRIES = 32768


def require(condition, message='涂装 ZIP 的可编辑清单无效'):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = dict(pairs)
    require(len(result) == len(pairs))
    return result


def check_zip_index(file):
    # The upload and entry limits fit a regular ZIP footer.
    size = file.stat().st_size
    tail_size = min(size, ZIP_END.size + 65535 + 20)
    with file.open('rb') as stream:
        stream.seek(size - tail_size)
        tail = stream.read(tail_size)
    position = tail.rfind(ZIP_END_MARKER)
    require(position >= 0 and position + ZIP_END.size <= len(tail), '涂装 ZIP 文件损坏')
    _, disk, start_disk, disk_count, count, index_size, offset, comment = ZIP_END.unpack_from(tail, position)
    zip64 = position >= 20 and tail[position-20:position-16] == ZIP64_LOCATOR
    require(not zip64 and count <= MAX_ENTRIES and index_size <= 16 * MIB, '涂装 ZIP 目录超出大小限制')
    require(disk == start_disk == 0 and disk_count == count and
            position + ZIP_END.size + comment == len(tail) and
            offset + index_size <= size - tail_size + position, '涂装 ZIP 目录无效')


def read_checked(archive, name, limit, expected=None):
    info = archive.getinfo(name)
    mode = stat.S_IFMT(info.external_attr >> 16)
    require(mode in (0, stat.S_IFREG) and not info.is_dir() and not info.flag_bits & 1,
            '交付包包含无效的文件条目')
    require(0 < info.file_size <= limit, '交付包文件超出导入大小限制')
    data = archive.read(info)
    if expected is not None:
        require(hashlib.sha256(data).hexdigest() == expected, '交付包内容指纹不一致')
    return data


def check_metadata(manifest, report, report_name):
    editable = report['editable']
    geometry = manifest['geometry']
    require(type(manifest['version']) is int and manifest['version'] == 1 and
            manifest['revision'] == report['revision'] and
            editable['manifestPath'] == MANIFEST and geometry == editable['geometry'],
            '涂装包的修订或模型指纹不一致')
    if report_name == PROJECT:
        require(manifest['format'] == report['format'] == PROJECT_FORMAT and
                'previewId' not in manifest and 'uvSha256' not in geometry,
                '可编辑工程副本格式无效')
        return
    require(manifest['format'] == 'arachne-pbr-paint' and manifest['previewId'] == report['previewId'] and
            geometry.get('editedModelSha256', geometry['modelSha256']) == report['uv']['source_sha256'] == report['cycles']['source_sha256'] and
            geometry['uvSha256'] == report['uv']['uv_before'] == report['uv']['uv_after'] ==
            report['cycles']['uv_before'] == report['cycles']['uv_after'],
            '交付包的修订、模型或 UV 指纹不一致')


def check_project_textures(archive, report, hashes):
    bake = report['bake']
    files = bake['files']
    require(set(files) in (TEXTURE_NAMES, LEGACY_TEXTURE_NAMES) and bake['resolution'] == [4096, 4096],
            '工程贴图清单无效')
    projection = json.loads(read_checked(archive, TEXTURE_REPORT, 8 * MIB, hashes[TEXTURE_REPORT]),
                            object_pairs_hook=unique_object)
    require(projection['revision'] == report['revision'] and projection['resolution'] == bake['resolution'] and
            projection['uv_unchanged'] is True and projection['draft'] is False and
            {'textures/' + name: digest for name, digest in projection['files'].items()} == files,
            '工程贴图和预览校验报告不一致')
    for name, digest in files.items():
        require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest) and hashes[name] == digest,
                '工程贴图指纹无效')
        read_checked(archive, name, 72 * MIB, digest)


def unpack_registration(archive, report, output, entries, uv_digest):
    from model_glb import Model
    from PIL import Image

    hashes = report['fileSha256']
    geometry = report['editable']['geometry']
    preserved = set(entries) == set(REGISTRATION_LIMITS) | set(PRESERVED_SURFACE_LIMITS)
    limits = {**REGISTRATION_LIMITS,**PRESERVED_SURFACE_LIMITS} if preserved else REGISTRATION_LIMITS
    require(set(entries) == set(limits) and
            entries['registration/model.glb'] == geometry['modelSha256'],
            '原生交付包的登记文件不一致')
    folder = output / 'registration'
    folder.mkdir()
    for member, limit in limits.items():
        digest = entries[member]
        require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}',digest) and hashes[member] == digest,
                '登记文件指纹无效')
        destination = folder / member.removeprefix('registration/')
        destination.parent.mkdir(parents=True,exist_ok=True)
        destination.write_bytes(read_checked(archive, member, limit*MIB, digest))
    meta = json.loads((folder/'metadata.json').read_bytes(), object_pairs_hook=unique_object)
    require((meta.get('legacySurface') is True) == preserved, '迁移后的原绘制表面缺失')
    if preserved:
        record = json.loads((folder/'surface/cache/geometry_report.json').read_bytes(),object_pairs_hook=unique_object)
        require(record['legacy_uv_sha256'] == meta['legacyUvSha256'] and
                record['uv_before_sha256'] == record['uv_after_sha256'] == meta['uv_before'] and
                record['materials'] == [{'name':meta['material'],'file':'surface'}],
                '迁移后的原绘制表面指纹不一致')
    model = Model(folder/'model.glb')
    require(meta['source_sha256'] == geometry['modelSha256'] and meta['material'] == geometry['material'] and
            meta['uv_unchanged'] is True and meta['uv_before'] == meta['uv_after'] == uv_digest ==
            model.uv_digest() and any(p['label']==meta['material'] and p['uv'] is not None for p in model.primitives),
            '包内登记模型的材质或原 UV 不一致')
    with Image.open(folder/'base.png') as image:
        sizes_ok = all(0<size<=8192 for size in image.size) if preserved else image.size == (4096,4096)
        require(image.format == 'PNG' and sizes_ok, '包内底图格式无效')
        image.verify()


def unpack(file, output):
    check_zip_index(file)
    with ZipFile(file) as archive:
        names = archive.namelist()
        require(len(names) <= MAX_ENTRIES, '涂装 ZIP 目录超出大小限制')
        require(MANIFEST in names, '此 ZIP 缺少可编辑清单，请从新版涂装工作台重新交付')
        require(len(names) == len(set(names)), '交付包包含重名条目')
        reports = [name for name in (PROJECT, DELIVERY) if name in names]
        require(len(reports) == 1, '涂装包缺少有效的校验报告')
        report_name = reports[0]
        report = json.loads(read_checked(archive, report_name, 8 * MIB), object_pairs_hook=unique_object)
        hashes = report['fileSha256']
        digest = hashes[MANIFEST]
        require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest))
        manifest_data = read_checked(archive, MANIFEST, 16 * MIB, digest)
        manifest = json.loads(manifest_data, object_pairs_hook=unique_object)
        check_metadata(manifest, report, report_name)
        if report_name == PROJECT and 'bake' in report:
            check_project_textures(archive, report, hashes)
        if report_name == PROJECT:
            if 'delivery' in report:
                delivery = report['delivery']
                require(delivery['version'] == 1 and 'bake' in report and 'registration' not in report,
                        '原生交付包格式无效')
                if 'registration' in delivery:
                    require(delivery['model']['sourceGlbSha256'] == manifest['geometry']['modelSha256'],
                            '原生交付包的登记模型指纹不一致')
                    unpack_registration(archive, report, output, delivery['registration'], delivery['model']['uvSha256'])
            elif 'registration' in report:
                registration = report['registration']
                require(set(registration) == {'version', 'uvSha256', 'files'} and registration['version'] == 1,
                        '工程副本的登记清单无效')
                unpack_registration(archive, report, output, registration['files'], registration['uvSha256'])
        assets = manifest['paint']['assets']
        require(isinstance(assets, dict) and len(assets) == report['editable']['assetCount'])
        total_size = 0
        for digest, asset in assets.items():
            require(re.fullmatch('[0-9a-f]{64}', digest))
            filename = f'paint-{digest}.png'
            member = f'editable/assets/{filename}'
            require(asset['path'] == f'assets/{filename}' and asset['sha256'] == hashes[member] == digest,
                    '交付包素材名称或指纹不一致')
            total_size += archive.getinfo(member).file_size
            require(total_size <= 512 * MIB, '交付包的可编辑素材总计不能超过 512 MiB')
            data = read_checked(archive, member, 64 * MIB, digest)
            with (output / filename).open('xb') as destination:
                destination.write(data)
        (output / 'manifest.json').write_bytes(manifest_data)


def pack_project(config):
    report = config['report']
    hashes = {}
    expected = config.get('expected',{})
    total_assets = 0
    output = Path(config['out']) / 'project.zip'
    with ZipFile(output, 'x', ZIP_DEFLATED, compresslevel=3) as archive:
        for name, source in config['files'].items():
            data = Path(source).read_bytes()
            digest = hashes[name] = hashlib.sha256(data).hexdigest()
            if name in expected:
                require(digest == expected[name], '打包时交付文件指纹变化')
            if name in report.get('bake', {}).get('files', {}):
                require(digest == report['bake']['files'][name], '打包时贴图指纹变化')
            if name.startswith('editable/assets/'):
                require(0 < len(data) <= 64 * MIB, '工程副本包含超过 64 MiB 的素材')
                total_assets += len(data)
                require(total_assets <= 512 * MIB, '工程副本的可编辑素材总计不能超过 512 MiB')
                require(name == f'editable/assets/paint-{digest}.png', '打包时涂装素材指纹变化')
                archive.writestr(name, data, compress_type=ZIP_STORED)
            else:
                archive.writestr(name, data)
        report['fileSha256'] = hashes
        require(set(expected) <= set(hashes), '交付包缺少文件')
        report_data = json.dumps(report, ensure_ascii=False, indent=2)
        archive.writestr(PROJECT, report_data)
    require(output.stat().st_size <= 1024 * MIB, '涂装 ZIP 超过 1 GiB，无法恢复')
    if config.get('writeReport'):
        (Path(config['out']) / PROJECT).write_text(report_data, encoding='utf-8')


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'pack':
            pack_project(json.loads(Path(sys.argv[2]).read_bytes()))
        elif sys.argv[1] == 'unpack':
            unpack(Path(sys.argv[2]), Path(sys.argv[3]))
        else:
            unpack(Path(sys.argv[1]), Path(sys.argv[2]))
    except (BadZipFile, KeyError, TypeError, AttributeError, RuntimeError, zlib.error):
        sys.exit('涂装交付包损坏或格式无效')
    except (json.JSONDecodeError, UnicodeDecodeError):
        sys.exit('涂装交付包的 JSON 数据无效')
    except ValueError as error:
        sys.exit(str(error))
