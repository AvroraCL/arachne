"""Color transforms and compositing math for editable image layers."""
import numpy as np


def blend_rgb(base, source, mode):
    if mode == 'normal':
        return source
    if mode == 'multiply':
        return base * source
    if mode == 'screen':
        return base + source - base * source
    if mode in ('overlay', 'hardLight'):
        pivot = base if mode == 'overlay' else source
        return np.where(pivot <= .5, 2 * base * source, 1 - 2 * (1 - base) * (1 - source))
    if mode == 'softLight':
        curve = np.where(base <= .25, ((16 * base - 12) * base + 4) * base, np.sqrt(np.maximum(base, 0)))
        return np.where(source <= .5, base - (1 - 2 * source) * base * (1 - base),
                        base + (2 * source - 1) * (curve - base))
    if mode == 'darken':
        return np.minimum(base, source)
    if mode == 'lighten':
        return np.maximum(base, source)
    if mode == 'colorDodge':
        return np.where(base <= 0, 0, np.minimum(1, base / np.maximum(1 - source, 1e-8)))
    if mode == 'colorBurn':
        return np.where(base >= 1, 1, 1 - np.minimum(1, (1 - base) / np.maximum(source, 1e-8)))
    if mode == 'linearDodge':
        return np.minimum(1, base + source)
    if mode == 'linearBurn':
        return np.maximum(0, base + source - 1)
    if mode == 'difference':
        return np.abs(base - source)
    if mode == 'exclusion':
        return base + source - 2 * base * source
    if mode == 'subtract':
        return np.maximum(0, base - source)
    if mode == 'divide':
        return np.minimum(1, base / np.maximum(source, 1e-8))
    raise ValueError('Unknown image blend mode')


def neutral_adjustment(params):
    kind = params['type']
    if kind == 'brightnessContrast':
        return params['brightness'] == params['contrast'] == 0
    if kind == 'levels':
        return (params['inputBlack'], params['inputWhite'], params['gamma'],
                params['outputBlack'], params['outputWhite']) == (0, 255, 1, 0, 255)
    if kind == 'hueSaturation':
        return params['hue'] == params['saturation'] == params['lightness'] == 0
    if kind == 'exposure':
        return params['exposure'] == params['offset'] == 0 and params['gamma'] == 1
    return False


def _hue_saturation(rgb, params):
    high, low = rgb.max(axis=1), rgb.min(axis=1)
    delta, lightness = high - low, (high + low) * .5
    chromatic = delta > 1e-7
    red, green, blue = rgb.T
    distance = np.maximum(delta, 1e-7)
    hue = np.where(high == red, (green - blue) / distance,
                   np.where(high == green, (blue - red) / distance + 2, (red - green) / distance + 4))
    hue = np.mod(hue / 6 + params['hue'] / 360, 1)
    saturation = np.clip(delta / np.maximum(1 - np.abs(2 * lightness - 1), 1e-7), 0, 1)
    strength = params['saturation'] / 100
    saturation += (1 - saturation if strength >= 0 else saturation) * strength
    saturation[~chromatic] = 0
    light = params['lightness'] / 100
    lightness += (1 - lightness if light >= 0 else lightness) * light
    amplitude = saturation * np.minimum(lightness, 1 - lightness)
    position = np.mod(np.array([0, 8, 4], dtype=np.float32) + hue[:, None] * 12, 12)
    return lightness[:, None] - amplitude[:, None] * np.clip(np.minimum(position - 3, 9 - position), -1, 1)


def adjust_rgb(rgb, params):
    kind = params['type']
    if kind == 'brightnessContrast':
        contrast = params['contrast'] / 100
        gain = 1 + contrast if contrast <= 0 else 1 / max(1 / 16, 1 - contrast)
        result = (rgb - .5) * gain + .5 + params['brightness'] / 200
    elif kind == 'levels':
        low, high = params['inputBlack'] / 255, params['inputWhite'] / 255
        out_low, out_high = params['outputBlack'] / 255, params['outputWhite'] / 255
        channel = params['channel']
        part = rgb if channel == 'rgb' else rgb[:, ('red', 'green', 'blue').index(channel)]
        adjusted = np.power(np.clip((part - low) / (high - low), 0, 1), 1 / params['gamma'])
        result = rgb.copy()
        part = result if channel == 'rgb' else result[:, ('red', 'green', 'blue').index(channel)]
        part[:] = out_low + adjusted * (out_high - out_low)
    elif kind == 'hueSaturation':
        result = _hue_saturation(rgb, params)
    elif kind == 'exposure':
        result = np.power(np.maximum(0, rgb * (2 ** params['exposure']) + params['offset']), 1 / params['gamma'])
    elif kind == 'blackWhite':
        gray = rgb @ (np.array([params['red'], params['green'], params['blue']], dtype=np.float32) / 100)
        result = np.repeat(gray[:, None], 3, axis=1)
    elif kind == 'invert':
        result = 1 - rgb
    elif kind == 'posterize':
        levels = params['steps'] - 1
        result = np.rint(rgb * levels) / levels
    else:
        raise ValueError('Unknown image adjustment')
    return np.clip(result, 0, 1)
