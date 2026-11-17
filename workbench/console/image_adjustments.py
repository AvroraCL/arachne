"""Color transforms and compositing math for editable image layers."""
from functools import lru_cache
import numpy as np


def luminosity(rgb):
    return rgb[:,0]*.3+rgb[:,1]*.59+rgb[:,2]*.11


def set_luminosity(rgb, target):
    shifted = rgb+(target-luminosity(rgb))[:,None]
    low, high = shifted.min(axis=1), shifted.max(axis=1)
    below, above = low < 0, high > 1
    if np.any(below):
        y = target[below,None]
        shifted[below] = y+(shifted[below]-y)*y/np.maximum(y-low[below,None],1e-8)
    if np.any(above):
        y = target[above,None]
        shifted[above] = y+(shifted[above]-y)*(1-y)/np.maximum(high[above,None]-y,1e-8)
    return np.clip(shifted,0,1)


def set_saturation(rgb, span, desired):
    return (rgb-rgb.min(axis=1,keepdims=True))*np.divide(desired,span,out=np.zeros_like(span),where=span>0)[:,None]


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
    if mode == 'color':
        return set_luminosity(source,luminosity(base))
    if mode == 'luminosity':
        return set_luminosity(base,luminosity(source))
    if mode in ('hue','saturation'):
        back_span,source_span = np.ptp(base,axis=1),np.ptp(source,axis=1)
        hue = set_saturation(source,source_span,back_span) if mode=='hue' else set_saturation(base,back_span,source_span)
        return set_luminosity(hue,luminosity(base))
    raise ValueError('Unknown image blend mode')


def neutral_adjustment(params):
    kind = params['type']
    if kind == 'brightnessContrast':
        return params['brightness'] == params['contrast'] == 0
    if kind == 'levels':
        return (params['inputBlack'], params['inputWhite'], params['gamma'],
                params['outputBlack'], params['outputWhite']) == (0, 255, 1, 0, 255)
    if kind == 'curves':
        return all(all(x == y for x, y in points) for points in params['points'].values())
    if kind == 'hueSaturation':
        return params['hue'] == params['saturation'] == params['lightness'] == 0
    if kind == 'exposure':
        return params['exposure'] == params['offset'] == 0 and params['gamma'] == 1
    if kind in ('colorBalance','selectiveColor'):
        return all(not any(values.values()) for values in params['tones'].values())
    return False


HUE_CENTERS = {'red':0,'yellow':60,'green':120,'cyan':180,'blue':240,'magenta':300}


def hue_angle(rgb, high, delta):
    red, green, blue = rgb.T
    distance = np.maximum(delta,1e-7)
    hue = np.where(high==red,(green-blue)/distance,
                   np.where(high==green,(blue-red)/distance+2,(red-green)/distance+4))
    return np.mod(hue*60,360)


def _hue_saturation(rgb, params):
    high, low = rgb.max(axis=1), rgb.min(axis=1)
    delta, lightness = high - low, (high + low) * .5
    chromatic = delta > 1e-7
    angle = hue_angle(rgb,high,delta)
    hue = np.mod((angle+params['hue'])/360,1)
    saturation = np.clip(delta / np.maximum(1 - np.abs(2 * lightness - 1), 1e-7), 0, 1)
    strength = params['saturation'] / 100
    saturation += (1 - saturation if strength >= 0 else saturation) * strength
    saturation[~chromatic] = 0
    light = params['lightness'] / 100
    lightness += (1 - lightness if light >= 0 else lightness) * light
    amplitude = saturation * np.minimum(lightness, 1 - lightness)
    position = np.mod(np.array([0, 8, 4], dtype=np.float32) + hue[:, None] * 12, 12)
    shifted = lightness[:, None] - amplitude[:, None] * np.clip(np.minimum(position - 3, 9 - position), -1, 1)
    region = params.get('range','all')
    if region=='all':
        return shifted
    center = HUE_CENTERS.get(region,params.get('center',0))
    angular_distance = np.abs(np.mod(angle-center+180,360)-180)
    width, falloff = params.get('width',30),params.get('falloff',20)
    if falloff:
        weight = np.clip(1-(angular_distance-width)/falloff,0,1)
        weight *= weight*(3-2*weight)
    else:
        weight = angular_distance<=width
    return rgb+(shifted-rgb)*(weight*chromatic)[:,None]


def color_balance(rgb, params):
    light = luminosity(rgb)
    shadows = np.clip(1-2*light,0,1)
    highlights = np.clip(2*light-1,0,1)
    weights = (shadows,1-shadows-highlights,highlights)
    shifts = np.array([[params['tones'][tone][key] for key in ('red','green','blue')]
                       for tone in ('shadows','midtones','highlights')],dtype=np.float32)/200
    shifted = rgb+np.column_stack(weights) @ shifts
    return set_luminosity(shifted,light) if params['preserve'] else shifted


def selective_color(rgb, params):
    high,low = rgb.max(axis=1),rgb.min(axis=1)
    chroma = high-low
    angle = hue_angle(rgb,high,chroma)
    weights = {key:chroma*np.clip(1-np.abs(np.mod(angle-center+180,360)-180)/60,0,1)
               for key,center in HUE_CENTERS.items() if any(params['tones'][key].values())}
    weights.update(white=np.maximum(2*low-1,0),black=np.maximum(1-2*high,0),
                   neutral=np.clip(1-(np.abs(high-.5)+np.abs(low-.5)),0,1))
    process = 1-rgb
    shift = np.zeros_like(rgb)
    for name,weight in weights.items():
        tone = params['tones'][name]
        if not any(tone.values()):
            continue
        cmy = np.array([tone[key] for key in ('cyan','magenta','yellow')],dtype=np.float32)/100
        black = tone['black']/100
        if params['method']=='relative':
            delta = process*(cmy+black)
        else:
            delta = cmy+black
        shift += weight[:,None]*np.clip(delta,-process,rgb)
    return rgb-shift


def gradient_map(rgb, params):
    shades = np.array([list(bytes.fromhex(params[key][1:])) for key in ('shadow','middle','highlight')],dtype=np.float32)/255
    tone = luminosity(rgb)
    if params['reverse']:
        tone = 1-tone
    stops = [0,params['midpoint']/100,1]
    return np.column_stack([np.interp(tone,stops,channel) for channel in shades.T]).astype(np.float32)


@lru_cache(maxsize=128)
def curve_lut(points):
    x, y = np.asarray(points, dtype=np.float64).T
    dx = np.diff(x)
    slope = np.diff(y) / dx
    tangent = np.zeros(len(x))
    tangent[0], tangent[-1] = slope[0], slope[-1]
    for i in range(1, len(x)-1):
        if slope[i-1]*slope[i] > 0:
            a, b = 2*dx[i]+dx[i-1], dx[i]+2*dx[i-1]
            tangent[i] = (a+b)/(a/slope[i-1]+b/slope[i])
    input_values = np.linspace(0, 255, 4096)
    index = np.clip(np.searchsorted(x, input_values, side='right')-1, 0, len(dx)-1)
    h = dx[index]
    t = (input_values-x[index])/h
    t2, t3 = t*t, t*t*t
    output = ((2*t3-3*t2+1)*y[index]+(t3-2*t2+t)*h*tangent[index]+
              (-2*t3+3*t2)*y[index+1]+(t3-t2)*h*tangent[index+1])
    return np.clip(output/255, 0, 1).astype(np.float32)


def apply_curve(values, points):
    if all(x == y for x, y in points):
        return values
    lut = curve_lut(tuple(map(tuple, points)))
    scaled = np.clip(values, 0, 1)*(len(lut)-1)
    left = scaled.astype(np.int32)
    fraction = scaled-left
    return (lut[left] + fraction*(lut[np.minimum(left+1, len(lut)-1)]-lut[left])).astype(np.float32)


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
    elif kind == 'curves':
        curves = params['points']
        master = apply_curve(rgb, curves['rgb'])
        result = np.column_stack([apply_curve(master[:, i], curves[channel])
                                  for i, channel in enumerate(('red', 'green', 'blue'))])
    elif kind == 'hueSaturation':
        result = _hue_saturation(rgb, params)
    elif kind == 'colorBalance':
        result = color_balance(rgb, params)
    elif kind == 'selectiveColor':
        result = selective_color(rgb, params)
    elif kind == 'gradientMap':
        result = gradient_map(rgb, params)
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
