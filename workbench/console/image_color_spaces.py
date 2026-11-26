"""Document color encoding, embedded profiles and 8-bit color-managed boundaries."""
from functools import lru_cache
from io import BytesIO
from pathlib import Path
import struct

import numpy as np
from PIL import Image, ImageCms

PROFILE_FILES = {'srgb':'sRGB-v4.icc','gray-g22':'Gray-g22.icc','gray-linear':'Gray-linear.icc','display-p3':'DisplayP3-v4.icc',
                 'adobe-rgb':'AdobeCompat-v2.icc','prophoto-rgb':'ProPhoto-v4.icc',
                 'eci-rgb-v2':'eciRGB-v2.icc','rec709-g24':'Rec709-g24.icc','linear-prophoto-rgb':'ROMM-linear.icc',
                 'rec709':'Rec709-v4.icc','rec2020':'Rec2020-v4.icc',
                 'rec2020-g24':'Rec2020-g24-v4.icc','dci-p3':'DCI-P3-v4.icc',
                 'linear-p3':'P3-D65-linear.icc','linear-rec2020':'Rec2020-linear.icc','linear-adobe-rgb':'AdobeRGB-linear.icc',
                 'acescg':'ACEScg-linear.icc','aces2065-1':'ACES2065-1-linear.icc','linear-srgb':'scRGB-v2.icc'}
# Inverse OETF coefficients (a, b) from the packaged BT.709/BT.2020 ICC rTRC tags.
VIDEO_TRC = {'rec709':(0.909912109375,0.090087890625),
             'rec2020':(0.90966796875,0.09033203125)}
POWER_TRC = {'adobe-rgb':563/256,'dci-p3':2.6,'rec2020-g24':2.4,'rec709-g24':2.4}
GRAY_SPACES = {'gray-g22', 'gray-linear'}
LINEAR_RGB = {'linear','linear-srgb','linear-p3','linear-rec2020','linear-adobe-rgb','linear-prophoto-rgb','acescg','aces2065-1'}
PROFILED_SPACES = PROFILE_FILES.keys() - {'srgb'}


# PNG third edition, full-range RGB cICP (H.273 primaries, transfer).
_PNG_SPACES = {(1,13):'srgb', (12,13):'display-p3', (1,8):'linear-srgb',
               (12,8):'linear-p3', (9,8):'linear-rec2020', (1,1):'rec709',
               (9,14):'rec2020', (9,15):'rec2020'}


def png_source_space(image):
    """Read before Pillow consumes IDAT; this Pillow discards public cICP."""
    if image.format != 'PNG' or image.fp is None:
        return None
    stream = image.fp
    original = stream.tell()
    try:
        stream.seek(8)
        while True:
            header = stream.read(8)
            if len(header) != 8:
                return None
            size, kind = struct.unpack('>I4s', header)
            if kind in (b'IDAT', b'IEND'):
                return None
            if kind == b'cICP':
                if size != 4:
                    return None
                codes = stream.read(4)
                if len(codes) != 4:
                    return None
                primaries, transfer, matrix, full = codes
                if matrix == 0 and full == 1:
                    space = _PNG_SPACES.get((primaries, transfer))
                    if space:
                        return space
                if image.info.get('icc_profile') or 'srgb' in image.info:
                    return None
                if transfer in (16,18):
                    curve = 'PQ' if transfer == 16 else 'HLG'
                    raise ValueError('此 PNG 使用 HDR '+curve+'，请先转为 SDR，或用数据模式读取原始通道')
                raise ValueError('PNG cICP 颜色编码暂不支持，请指定对应的源配置或转为全范围 RGB')
            stream.seek(size + 4, 1)
    finally:
        stream.seek(original)


@lru_cache
def profile_bytes(space):
    return (Path(__file__).parent/'public'/'color-profiles'/PROFILE_FILES[space]).read_bytes()


@lru_cache(maxsize=12)
def rgb_transform(source, target):
    source_profile = ImageCms.ImageCmsProfile(BytesIO(source))
    target_profile = ImageCms.ImageCmsProfile(BytesIO(target))
    output_mode = 'L' if target_profile.profile.xcolor_space.strip() == 'GRAY' else 'RGBA'
    mode = 'L' if source_profile.profile.xcolor_space.strip() == 'GRAY' else 'RGBA'
    return ImageCms.buildTransform(source_profile, target_profile, mode, output_mode,
                                   renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)


def convert_image(image, source, target):
    if source == target:
        return image
    transform = rgb_transform(source, target)
    converted = ImageCms.applyTransform(image.getchannel('R') if transform.inputMode == 'L' else image, transform)
    if converted.mode == 'L':
        return Image.merge('RGBA', (converted, converted, converted, image.getchannel('A')))
    if transform.inputMode == 'L':
        converted.putalpha(image.getchannel('A'))
    return converted


def display_pixels(pixels, space):
    if space not in PROFILED_SPACES:
        return pixels
    return np.asarray(convert_image(Image.fromarray(pixels), profile_bytes(space), profile_bytes('srgb')))


def neutral_light(c):
    if np.ndim(c) and c.shape[-1] == 3:
        gray = c[...,0]*.2126 + c[...,1]*.7152 + c[...,2]*.0722
        return np.broadcast_to(gray[...,None],c.shape)
    return c


def decode(c, space='srgb'):
    if space in GRAY_SPACES:
        return neutral_light(np.maximum(c,0)**2.2 if space=='gray-g22' else c)
    if space in LINEAR_RGB:
        return c
    if space in POWER_TRC:
        return np.maximum(c,0)**POWER_TRC[space]
    if space in VIDEO_TRC:
        a,b = VIDEO_TRC[space]
        return np.where(c < .081, c/4.5, np.maximum(a*c+b,0)**(1/.45))
    if space == 'eci-rgb-v2':
        return np.where(c <= .08, c*(2700/24389), ((c+.16)/1.16)**3)
    if space == 'prophoto-rgb':
        return np.where(c < 1/32, c/16, np.maximum(c,0)**1.8)
    return np.where(c<=.04045,c/12.92,((c+.055)/1.055)**2.4)


def encode(c, space='srgb'):
    if space in GRAY_SPACES:
        gray=neutral_light(c)
        return np.maximum(gray,0)**(1/2.2) if space=='gray-g22' else gray
    if space in LINEAR_RGB:
        return c
    if space in POWER_TRC:
        return np.maximum(c,0)**(1/POWER_TRC[space])
    if space in VIDEO_TRC:
        a,b = VIDEO_TRC[space]
        return np.where(c < .018, c*4.5, (np.maximum(c,0)**.45-b)/a)
    if space == 'eci-rgb-v2':
        return np.where(c <= (6/29)**3, c*(24389/2700), 1.16*np.cbrt(c)-.16)
    if space == 'prophoto-rgb':
        return np.where(c < 1/512, c*16, np.maximum(c,0)**(1/1.8))
    return np.where(c<=.0031308,c*12.92,1.055*np.maximum(c,0)**(1/2.4)-.055)


def gray16_to_working_bytes(image):
    """Reduce full-range unsigned gray before Pillow's RGBA conversion clips it."""
    if not image.mode.startswith('I;16'):
        return image
    transparent=image.info.get('transparency')
    output=Image.new('LA' if transparent is not None else 'L',image.size)
    for top in range(0,image.height,256):
        box=(0,top,image.width,min(top+256,image.height))
        values=np.asarray(image.crop(box),dtype=np.uint32)
        strip=Image.fromarray(((values+128)//257).astype(np.uint8))
        if transparent is not None:
            # tRNS specifies the original 16-bit sample, before quantization.
            strip.putalpha(Image.fromarray(np.where(values==transparent,0,255).astype(np.uint8)))
        output.paste(strip,(0,top))
    return output


def image_input(image, space, box=None, authored=False):
    """Return straight RGBA bytes and their transfer function. Untagged photos assume sRGB."""
    info = image.info
    named = png_source_space(image) if space != 'linear' and not authored else None
    source = profile_bytes(named) if named else info.get('icc_profile')
    rgba = gray16_to_working_bytes(image.crop(box) if box else image).convert('RGBA')
    if space == 'linear':
        return np.asarray(rgba), 'srgb' if 'srgb' in info else 'linear'
    if authored and not source:
        return np.asarray(rgba), space
    if not source and info.get('gamma') == 1 and 'srgb' not in info:
        if space not in PROFILED_SPACES:
            return np.asarray(rgba), 'linear'
        source = profile_bytes('linear-srgb')
    if source or space in PROFILED_SPACES:
        target = space if space in PROFILED_SPACES else 'srgb'
        rgba = convert_image(rgba, source or profile_bytes('srgb'), profile_bytes(target))
        return np.asarray(rgba), target
    return np.asarray(rgba), 'srgb' if 'srgb' in info else space


_intents = {'perceptual': ImageCms.Intent.PERCEPTUAL, 'relative': ImageCms.Intent.RELATIVE_COLORIMETRIC,
            'saturation': ImageCms.Intent.SATURATION, 'absolute': ImageCms.Intent.ABSOLUTE_COLORIMETRIC}


def profiled_copy(pixels, space, target, mode, intent, proof=None, black_point=False):
    """Convert the composited document once; CMYK output represents ink on white paper."""
    image = Image.fromarray(pixels)
    rgb = image.convert('RGB')
    opaque_output = mode in ('CMYK','LAB')
    if opaque_output and image.getchannel('A').getextrema()[0] < 255:
        # Blend onto paper in the document's linear working light, in strips.
        for top in range(0,pixels.shape[0],128):
            strip = pixels[top:top+128]
            alpha = strip[:,:,3:4].astype(np.float32)/255
            if np.all(alpha == 1):
                continue
            color = decode(strip[:,:,:3].astype(np.float32)/255,space)
            paper = encode(color*alpha+1-alpha,space)
            rgb.paste(Image.fromarray(np.rint(np.clip(paper,0,1)*255).astype(np.uint8)),(0,top))
    try:
        input_image = rgb.getchannel('R') if space in GRAY_SPACES else rgb
        converted = ImageCms.profileToProfile(input_image,BytesIO(profile_bytes(space)),BytesIO(target),
            outputMode={'RGB':'RGB','GRAY':'L','CMYK':'CMYK','LAB':'LAB'}[mode],
            renderingIntent=_intents[intent], flags=ImageCms.Flags.BLACKPOINTCOMPENSATION if black_point else 0)
        if proof and 'point' in proof:
            return bytes(converted.getpixel((0,0)))
        if proof:
            display=profile_bytes(proof['space'])
            # Display exactly the device codes used in the exported file, including
            # its quantization. Absolute colorimetry retains the target paper white.
            plate = proof.get('plate')
            if plate in ('C','M','Y','K'):
                right = converted.getchannel(plate).point(lambda ink:255-ink).convert('RGB')
            else:
                right=ImageCms.profileToProfile(converted,BytesIO(target),BytesIO(display),outputMode='RGB',
                    renderingIntent=ImageCms.Intent.ABSOLUTE_COLORIMETRIC if proof['paper'] else ImageCms.Intent.RELATIVE_COLORIMETRIC)
                if plate == 'limit':
                    total = np.asarray(converted).sum(axis=2,dtype=np.uint16)
                    over = Image.fromarray(total > proof['inkLimit']*255/100)
                    right = right.convert('L').convert('RGB')
                    right.paste((241,113,46),(0,0,*right.size),over)
            left=convert_image(rgb.convert('RGBA'),profile_bytes(space),display)
            if not opaque_output:
                alpha=image.getchannel('A')
                left.putalpha(alpha)
                right.putalpha(alpha)
            pair=Image.new('RGBA',(image.width*2,image.height))
            pair.paste(left,(0,0))
            pair.paste(right,(image.width,0))
            out=BytesIO()
            pair.save(out,format='PNG',compress_level=3,icc_profile=display)
            return out.getvalue()
    except (ImageCms.PyCMSError, OSError) as error:
        message='此 ICC 缺少校样所需的颜色转换，可直接尝试导出副本' if proof else 'ICC 配置不支持所选输出转换，请使用有效的目标设备配置'
        raise ValueError(message) from error
    out = BytesIO()
    if opaque_output:
        converted.save(out,format='TIFF',compression='tiff_deflate',icc_profile=target)
    else:
        converted.putalpha(image.getchannel('A'))
        converted.save(out,format='PNG',compress_level=3,icc_profile=target)
    return out.getvalue()
