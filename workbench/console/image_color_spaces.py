"""Document color encoding, embedded profiles and 8-bit color-managed boundaries."""
from functools import lru_cache
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

PROFILE_FILES = {'srgb':'sRGB-v4.icc','gray-g22':'Gray-g22.icc','gray-linear':'Gray-linear.icc','display-p3':'DisplayP3-v4.icc',
                 'adobe-rgb':'AdobeCompat-v2.icc','prophoto-rgb':'ProPhoto-v4.icc',
                 'rec709':'Rec709-v4.icc','rec2020':'Rec2020-v4.icc',
                 'rec2020-g24':'Rec2020-g24-v4.icc','dci-p3':'DCI-P3-v4.icc',
                 'acescg':'ACEScg-linear.icc','aces2065-1':'ACES2065-1-linear.icc','linear-srgb':'scRGB-v2.icc'}
# Inverse OETF coefficients (a, b) from the packaged BT.709/BT.2020 ICC rTRC tags.
VIDEO_TRC = {'rec709':(0.909912109375,0.090087890625),
             'rec2020':(0.90966796875,0.09033203125)}
POWER_TRC = {'adobe-rgb':563/256,'dci-p3':2.6,'rec2020-g24':2.4}
GRAY_SPACES = {'gray-g22', 'gray-linear'}
PROFILED_SPACES = PROFILE_FILES.keys() - {'srgb'}


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
    if space in ('linear','linear-srgb','acescg','aces2065-1'):
        return c
    if space in POWER_TRC:
        return np.maximum(c,0)**POWER_TRC[space]
    if space in VIDEO_TRC:
        a,b = VIDEO_TRC[space]
        return np.where(c < .081, c/4.5, np.maximum(a*c+b,0)**(1/.45))
    if space == 'prophoto-rgb':
        return np.where(c < 1/32, c/16, np.maximum(c,0)**1.8)
    return np.where(c<=.04045,c/12.92,((c+.055)/1.055)**2.4)


def encode(c, space='srgb'):
    if space in GRAY_SPACES:
        gray=neutral_light(c)
        return np.maximum(gray,0)**(1/2.2) if space=='gray-g22' else gray
    if space in ('linear','linear-srgb','acescg','aces2065-1'):
        return c
    if space in POWER_TRC:
        return np.maximum(c,0)**(1/POWER_TRC[space])
    if space in VIDEO_TRC:
        a,b = VIDEO_TRC[space]
        return np.where(c < .018, c*4.5, (np.maximum(c,0)**.45-b)/a)
    if space == 'prophoto-rgb':
        return np.where(c < 1/512, c*16, np.maximum(c,0)**(1/1.8))
    return np.where(c<=.0031308,c*12.92,1.055*np.maximum(c,0)**(1/2.4)-.055)


def image_input(image, space, box=None, authored=False):
    """Return straight RGBA bytes and their transfer function. Untagged photos assume sRGB."""
    info = image.info
    rgba = (image.crop(box) if box else image).convert('RGBA')
    source = info.get('icc_profile')
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


def profiled_copy(pixels, space, target, mode, intent, proof=None):
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
            renderingIntent=ImageCms.Intent.PERCEPTUAL if intent=='perceptual' else ImageCms.Intent.RELATIVE_COLORIMETRIC)
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
