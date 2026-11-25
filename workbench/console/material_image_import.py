"""Normalize explicitly selected material images without altering channel values."""
from io import BytesIO
import json
from pathlib import Path
import sys

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError
from image_color_spaces import profile_bytes, rgb_transform


MIB = 1024 * 1024
FORMATS = {'.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP', '.tga': 'TGA'}


def convert(item):
    name = item['name']
    source = Path(item['source'])
    expected = FORMATS[Path(name.lower()).suffix]
    try:
        with Image.open(source, formats=[expected]) as image:
            if not all(0 < side <= 8192 for side in image.size):
                raise ValueError('宽高不能超过 8192 像素')
            if getattr(image, 'n_frames', 1) != 1:
                raise ValueError('请选择单帧贴图')
            if expected == 'PNG':
                image.verify()
                return source
            orientation = ImageOps.exif_transpose(image)
            mode = 'L' if orientation.mode == 'L' else 'RGBA' if orientation.has_transparency_data else 'RGB'
            profile = orientation.info.get('icc_profile')
            if orientation.mode == 'CMYK' and profile:
                # PNG cannot carry CMYK samples; interpret their profile while they
                # still have four color channels.
                space = item.get('workingSpace', 'srgb')
                target = profile_bytes('srgb' if space == 'linear' else space)
                normalized = ImageCms.profileToProfile(orientation,BytesIO(profile),BytesIO(target),
                    outputMode='RGB',renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
                profile = target
            else:
                if profile and item.get('workingSpace') not in (None, 'linear'):
                    # A placed photo must remain convertible when the document reopens.
                    rgb_transform(profile,profile_bytes(item['workingSpace']))
                normalized = orientation.convert(mode)
            # Preserve the tag without transforming RGB or packed-channel bytes.
            normalized.info.clear()
            destination = Path(item['destination'])
            normalized.save(destination, format='PNG', compress_level=3, icc_profile=profile)
            return destination
    except ImageCms.PyCMSError:
        raise ValueError('图片的 ICC 配置无效或与通道类型不匹配：' + name) from None
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError):
        raise ValueError('无法读取贴图：' + name) from None
    except ValueError as error:
        raise ValueError(str(error) + '：' + name) from None


if __name__ == '__main__':
    try:
        entries = json.loads(Path(sys.argv[1]).read_bytes())
        result = []
        total = 0
        for item in entries:
            file = convert(item)
            size = file.stat().st_size
            total += size
            if size > 64 * MIB or total > 128 * MIB:
                raise ValueError('转换后每张贴图须在 64 MiB 内，整批须在 128 MiB 内')
            result.append(str(file))
        print(json.dumps(result))
    except ValueError as error:
        sys.exit(str(error))
