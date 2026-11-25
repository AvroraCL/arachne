"""Document RGB encoding, embedded profiles and 8-bit color-managed boundaries."""
from functools import lru_cache
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

PROFILE_FILES = {'srgb':'sRGB-v4.icc','display-p3':'DisplayP3-v4.icc',
                 'adobe-rgb':'AdobeCompat-v2.icc','prophoto-rgb':'ProPhoto-v4.icc'}
WIDE = PROFILE_FILES.keys() - {'srgb'}


@lru_cache
def profile_bytes(space):
    return (Path(__file__).parent/'public'/'color-profiles'/PROFILE_FILES[space]).read_bytes()


@lru_cache(maxsize=12)
def rgb_transform(source, target):
    source_profile = ImageCms.ImageCmsProfile(BytesIO(source))
    mode = 'L' if source_profile.profile.xcolor_space.strip() == 'GRAY' else 'RGBA'
    return ImageCms.buildTransform(source_profile, BytesIO(target), mode, 'RGBA',
                                   renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)


def convert_image(image, source, target):
    if source == target:
        return image
    transform = rgb_transform(source, target)
    if transform.inputMode == 'L':
        converted = ImageCms.applyTransform(image.getchannel('R'), transform)
        converted.putalpha(image.getchannel('A'))
        return converted
    return ImageCms.applyTransform(image, transform)


def display_pixels(pixels, space):
    if space not in WIDE:
        return pixels
    return np.asarray(convert_image(Image.fromarray(pixels), profile_bytes(space), profile_bytes('srgb')))


def decode(c, space='srgb'):
    if space == 'linear':
        return c
    if space == 'adobe-rgb':
        return np.maximum(c,0)**(563/256)
    if space == 'prophoto-rgb':
        return np.where(c < 1/32, c/16, np.maximum(c,0)**1.8)
    return np.where(c<=.04045,c/12.92,((c+.055)/1.055)**2.4)


def encode(c, space='srgb'):
    if space == 'linear':
        return c
    if space == 'adobe-rgb':
        return np.maximum(c,0)**(256/563)
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
        if space not in WIDE:
            return np.asarray(rgba), 'linear'
        pixels = np.array(rgba)
        lookup = np.rint(encode(np.arange(256)/255)*255).astype(np.uint8)
        pixels[..., :3] = lookup[pixels[..., :3]]
        rgba = Image.fromarray(pixels)
    if source or space in WIDE:
        target = space if space in WIDE else 'srgb'
        rgba = convert_image(rgba, source or profile_bytes('srgb'), profile_bytes(target))
        return np.asarray(rgba), target
    return np.asarray(rgba), 'srgb' if 'srgb' in info else space
