"""Convert glTF texture inputs into editable UV0 fill-layer assets."""
import io
import math

import numpy as np
from PIL import Image

from model_glb import index


def decode_srgb(value):
    return np.where(value <= .04045, value / 12.92, ((value + .055) / 1.055) ** 2.4)


def encode_srgb(value):
    value = np.clip(value, 0, 1)
    return np.where(value <= .0031308, value * 12.92, 1.055 * value ** (1 / 2.4) - .055)


def wrapped(indexes, size, mode):
    if mode == 10497:  # REPEAT
        return indexes % size
    if mode == 33648:  # MIRRORED_REPEAT
        positions = indexes % (2 * size)
        return np.minimum(positions, 2 * size - 1 - positions)
    return np.clip(indexes, 0, size - 1)


def texture_image(model, info):
    texture = index(model.scene.get('textures', []), info.get('index'))
    source = texture.get('source', texture.get('extensions', {}).get('EXT_texture_webp', {}).get('source'))
    if source is None:
        raise ValueError('所选材质含有无法读取的压缩贴图。请导出为 PNG／JPEG，或关闭「保留源贴图」')
    image = index(model.scene.get('images', []), source)
    view = index(model.scene.get('bufferViews', []), image.get('bufferView'))
    start, length = view.get('byteOffset', 0), view['byteLength']
    if view.get('buffer', 0) != 0 or start < 0 or length < 1 or start + length > len(model.binary):
        raise ValueError('GLB 内嵌贴图数据越界')
    with Image.open(io.BytesIO(model.binary[start:start + length])) as source:
        if source.format not in ('PNG', 'JPEG', 'WEBP') or max(source.size) > 8192:
            raise ValueError('保留源贴图支持宽高不超过 8192 像素的 PNG、JPEG 或静态 WebP')
        if getattr(source, 'n_frames', 1) != 1:
            raise ValueError('GLB 源贴图须为静态图像')
        return source.convert('RGBA')


def texture_rows(model, info, color):
    transform = info.get('extensions', {}).get('KHR_texture_transform', {})
    if transform.get('texCoord', info.get('texCoord', 0)) != 0:
        raise ValueError('所选材质的源贴图使用其他 UV 通道。请转换到 TEXCOORD_0，或关闭「保留源贴图」')
    offset = transform.get('offset', [0, 0])
    scale = transform.get('scale', [1, 1])
    rotation = transform.get('rotation', 0)
    if (not isinstance(offset, list) or len(offset) != 2 or not isinstance(scale, list) or len(scale) != 2
            or not all(isinstance(x, (int, float)) and math.isfinite(x) and abs(x) < 1e6
                       for x in [*offset, *scale, rotation])):
        raise ValueError('GLB 源贴图的 UV 变换无效')
    image = texture_image(model, info)
    pixels = np.asarray(image)
    width, height = image.size
    identity = offset == [0, 0] and scale == [1, 1] and rotation == 0
    size = (width, height) if identity and max(image.size) <= 4096 else (
        tuple(max(1, round(n * 4096 / max(image.size))) for n in image.size) if identity else (4096, 4096))
    out_w, out_h = size

    def values(row, col):
        selected = pixels[row, col].astype(np.float32) / 255
        if color:
            selected[..., :3] = decode_srgb(selected[..., :3])
        return selected

    texture = index(model.scene['textures'], info['index'])
    sampler = index(model.scene.get('samplers', []), texture['sampler']) if 'sampler' in texture else {}
    wrap_s, wrap_t = sampler.get('wrapS', 10497), sampler.get('wrapT', 10497)
    if wrap_s not in (10497, 33648, 33071) or wrap_t not in (10497, 33648, 33071):
        raise ValueError('GLB 源贴图的采样器无效')
    nearest = sampler.get('magFilter') == 9728
    c, s = math.cos(rotation), math.sin(rotation)
    u = ((np.arange(out_w, dtype=np.float32) + .5) / out_w)[None, :] * scale[0]

    def rows():
        for row in range(0, out_h, 64):
            bottom = min(row + 64, out_h)
            if identity and size == image.size:
                yield row, values(slice(row, bottom), slice(None))
                continue
            v = ((np.arange(row, bottom, dtype=np.float32) + .5) / out_h)[:, None] * scale[1]
            x = (c * u - s * v + offset[0]) * width - .5
            y = (s * u + c * v + offset[1]) * height - .5
            if nearest:
                yield row, values(wrapped(np.floor(y + .5).astype(np.int64), height, wrap_t),
                                  wrapped(np.floor(x + .5).astype(np.int64), width, wrap_s))
                continue
            ix, iy = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
            fx, fy = (x - ix)[..., None], (y - iy)[..., None]
            left, right = wrapped(ix, width, wrap_s), wrapped(ix + 1, width, wrap_s)
            top, low = wrapped(iy, height, wrap_t), wrapped(iy + 1, height, wrap_t)
            yield row, ((values(top, left) * (1 - fx) + values(top, right) * fx) * (1 - fy) +
                        (values(low, left) * (1 - fx) + values(low, right) * fx) * fy)

    return size, rows()


def extract_texture_maps(model, material, out):
    pbr = material.get('pbrMetallicRoughness', {})
    rgba = np.asarray(pbr.get('baseColorFactor', [1, 1, 1, 1]), dtype=np.float32)
    emissive = np.asarray(material.get('emissiveFactor', [0, 0, 0]), dtype=np.float32)
    intensity = material.get('extensions', {}).get('KHR_materials_emissive_strength', {}).get('emissiveStrength', 1)
    # High dynamic range stays on the original GLB material when no authored
    # emission channel overrides it.
    emission = material.get('emissiveTexture') if np.max(emissive) * intensity <= 1 else None
    ao_strength = material.get('occlusionTexture', {}).get('strength', 1)
    normal_scale = material.get('normalTexture', {}).get('scale', 1)

    def normal(value):
        vector = value[..., :3] * 2 - 1
        vector[..., :2] *= normal_scale
        length = np.linalg.norm(vector, axis=2, keepdims=True)
        return np.divide(vector, length, out=np.broadcast_to([0., 0., 1.], vector.shape).copy(),
                         where=length > 1e-8) * .5 + .5

    color_maps = {'color': (3, lambda value: encode_srgb(value[..., :3] * rgba[:3]))}
    if material.get('alphaMode', 'OPAQUE') != 'OPAQUE':
        color_maps['alpha'] = (1, lambda value: value[..., 3] * rgba[3])
    plans = (
        (pbr.get('baseColorTexture'), True, color_maps),
        (pbr.get('metallicRoughnessTexture'), False,
         {'metallic': (1, lambda value: value[..., 2] * pbr.get('metallicFactor', 1)),
          'roughness': (1, lambda value: value[..., 1] * pbr.get('roughnessFactor', 1))}),
        (material.get('normalTexture'), False, {'normal': (3, normal)}),
        (material.get('occlusionTexture'), False, {'ao': (1, lambda value: 1 + ao_strength * (value[..., 0] - 1))}),
        (emission, True, {'emission': (3, lambda value: encode_srgb(value[..., :3] * emissive * intensity))}),
    )
    maps = []
    for info, color, outputs in plans:
        if info is None:
            continue
        (width, height), rows = texture_rows(model, info, color)
        converted = {name: np.empty((height, width, 3) if count == 3 else (height, width), dtype=np.uint8)
                     for name, (count, _) in outputs.items()}
        for start, values in rows:
            for name, (_, convert) in outputs.items():
                field = convert(values)
                if not np.isfinite(field).all():
                    raise ValueError('GLB 源材质贴图含有无效数值')
                converted[name][start:start + len(values)] = np.rint(np.clip(field, 0, 1) * 255).astype(np.uint8)
        out.mkdir(exist_ok=True)
        for name, pixels in converted.items():
            Image.fromarray(pixels).save(out / (name + '.png'), compress_level=3)
            maps.append(name)
    return maps
