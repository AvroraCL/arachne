"""Normalize explicitly selected material images without altering channel values."""
from io import BytesIO
import json
from pathlib import Path
import sys

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError
from image_color_spaces import GRAY_SPACES, PROFILE_FILES, png_source_space, profile_bytes, rgb_transform


MIB = 1024 * 1024
FORMATS = {'.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP', '.tga': 'TGA',
           '.tif':'TIFF', '.tiff':'TIFF'}


def matching_rgb_space(profile):
    # Equivalent vendor profiles often have different descriptions and bytes.
    # Compare matrix colorants and the entire 8-bit transfer ramps; always use
    # the source ICC itself for the subsequent pixel conversion.
    if not profile.profile.is_matrix_shaper or profile.profile.xcolor_space.strip()!='RGB':
        return None
    import numpy as np
    def colorants(p):
        return np.array([getattr(p.profile,c+'_colorant')[0] for c in ('red','green','blue')])
    source=colorants(profile)
    codes=np.arange(256,dtype=np.uint8)
    ramp=np.zeros((4,256,3),dtype=np.uint8)
    for i in range(3):ramp[i,:,i]=codes
    ramp[3]=codes[:,None]
    test=Image.fromarray(ramp)
    for key in PROFILE_FILES.keys()-GRAY_SPACES:
        target=ImageCms.ImageCmsProfile(BytesIO(profile_bytes(key)))
        if np.max(np.abs(colorants(target)-source))>.0008:
            continue
        result=ImageCms.profileToProfile(test,profile,target,outputMode='RGB',renderingIntent=1)
        if np.max(np.abs(np.asarray(result,dtype=np.int16)-ramp))<=1:
            return key
    return None


def open_document_image(image, item):
    # A file opens at its oriented pixel dimensions in a single project revision.
    if max(image.size)>4096:
        raise ValueError('绘制文档宽高须在 4096 像素以内，可先缩小图片或置入现有图像')
    assigned=item.get('sourceSpace') or item.get('profileFile')
    named=png_source_space(image) if not assigned and item['openWorkingSpace']!='linear' else None
    oriented=ImageOps.exif_transpose(image)
    embedded=oriented.info.get('icc_profile')
    if named:
        embedded=profile_bytes(named)
    if item.get('sourceSpace'):
        embedded=profile_bytes(item['sourceSpace'])
    elif item.get('profileFile'):
        embedded=Path(item['profileFile']).read_bytes()
    known=next((key for key in PROFILE_FILES if embedded==profile_bytes(key)),None) if embedded else None
    mode=oriented.mode
    gray=mode in ('1','L','LA') or mode.startswith('I;16')
    # A gray PNG may use an RGB cICP transfer; its three equal values are
    # interpreted in the declared RGB space just like a neutral RGB pixel.
    if named and gray:
        gray=False
    if embedded:
        profile=ImageCms.ImageCmsProfile(BytesIO(embedded))
        description=ImageCms.getProfileDescription(profile).strip()[:100]
        family=profile.profile.xcolor_space.strip()
        if family!=('CMYK' if mode=='CMYK' else 'Lab' if mode=='LAB' else 'GRAY' if gray else 'RGB'):
            raise ValueError(('指定的源' if assigned else '嵌入的')+' ICC 与图片通道不匹配')
        if assigned:
            description='指定 · '+description
        elif named:
            description='PNG cICP · '+description
        source_space=known or matching_rgb_space(profile) or ('gray-g22' if gray else 'prophoto-rgb')
    elif mode=='CMYK':
        raise ValueError('CMYK 图片缺少印刷 ICC，请在源配置中指定此图片使用的印刷配置')
    elif mode=='LAB':
        white=image.tag_v2.get(318) if hasattr(image,'tag_v2') else None
        if white and (abs(float(white[0])-.3457)>.001 or abs(float(white[1])-.3585)>.001):
            raise ValueError('此 Lab 图片使用其他白点，请先嵌入 ICC')
        embedded=(Path(__file__).parent/'public/color-profiles/Lab-D50.icc').read_bytes()
        source_space,description='prophoto-rgb','Lab D50'
    else:
        linear=oriented.info.get('gamma')==1 and 'srgb' not in oriented.info
        source_space=('gray-linear' if linear else 'gray-g22') if gray else ('linear-srgb' if linear else 'srgb')
        description=('无 ICC · '+{'gray-g22':'灰度 Gamma 2.2','gray-linear':'线性灰度','linear-srgb':'线性 RGB','srgb':'sRGB'}[source_space])
    target=source_space if item['openWorkingSpace']=='auto' else item['openWorkingSpace']
    if mode.startswith('I;16'):
        import numpy as np
        reduced=np.asarray(oriented,dtype=np.uint32)
        oriented=Image.fromarray(((reduced+128)//257).astype(np.uint8))
    elif mode in ('I','F'):
        raise ValueError('此图像使用整数或浮点通道，请先导出为 8 位或 16 位图像')
    rgba=oriented.convert('RGBA') if mode not in ('LAB','CMYK') else None
    if target=='linear':
        if rgba is None:
            raise ValueError('CMYK 和 Lab 文件须选择颜色工作空间')
        output=rgba
    else:
        input_image=oriented if mode in ('LAB','CMYK') else (rgba.getchannel('R') if gray else rgba.convert('RGB'))
        destination=profile_bytes(target)
        source=embedded or profile_bytes(source_space)
        output_mode='L' if target in GRAY_SPACES else 'RGB'
        output=(input_image if source==destination and input_image.mode==output_mode else
                ImageCms.profileToProfile(input_image,BytesIO(source),BytesIO(destination),outputMode=output_mode,
                                          renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC))
        if rgba is not None:
            output.putalpha(rgba.getchannel('A'))
    output.info.clear()
    output.save(item['destination'],format='PNG',compress_level=3,
                icc_profile=None if target=='linear' else profile_bytes(target))
    Path(item['documentInfo']).write_text(json.dumps({'colorSpace':target,'sourceProfile':description}),encoding='utf8')
    return Path(item['destination'])


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
            if 'openWorkingSpace' in item:
                return open_document_image(image,item)
            if expected == 'PNG':
                image.verify()
                return source
            orientation = ImageOps.exif_transpose(image)
            profile = orientation.info.get('icc_profile')
            if expected=='TIFF' and orientation.mode=='CMYK' and not profile:
                raise ValueError('CMYK TIFF 缺少 ICC 配置，请在原软件中嵌入印刷配置再置入')
            if orientation.mode=='LAB' and not profile:
                white=orientation.tag_v2.get(318) if hasattr(orientation,'tag_v2') else image.tag_v2.get(318)
                if white and (abs(float(white[0])-.3457)>.001 or abs(float(white[1])-.3585)>.001):
                    raise ValueError('此 Lab TIFF 指定了其他白点，请先嵌入对应的 ICC 配置')
                profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('LAB')).tobytes()
            if orientation.mode in ('LAB','CMYK') and profile:
                # Interpret the original channels before converting into a PNG-supported mode.
                space = item.get('workingSpace', 'srgb')
                target = profile_bytes('srgb' if space == 'linear' else space)
                normalized = ImageCms.profileToProfile(orientation,BytesIO(profile),BytesIO(target),
                    outputMode='L' if space in GRAY_SPACES else 'RGB',renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)
                profile = target
            else:
                if profile and item.get('workingSpace') not in (None, 'linear'):
                    # A placed photo must remain convertible when the document reopens.
                    rgb_transform(profile,profile_bytes(item['workingSpace']))
                if orientation.mode.startswith('I;16'):
                    import numpy as np
                    normalized=Image.new('L',orientation.size)
                    for top in range(0,orientation.height,256):
                        box=(0,top,orientation.width,min(top+256,orientation.height))
                        values=np.asarray(orientation.crop(box),dtype=np.uint32)
                        normalized.paste(Image.fromarray(((values+128)//257).astype(np.uint8)),(0,top))
                elif orientation.mode in ('I','F'):
                    raise ValueError('请先将整数或浮点 TIFF 转为 8 位或 16 位图像')
                else:
                    mode='L' if orientation.mode=='L' else 'RGBA' if orientation.has_transparency_data else 'RGB'
                    normalized=orientation.convert(mode)
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
