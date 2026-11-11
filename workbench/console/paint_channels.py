"""Eight-channel storage: encoded tangent normal, linear scalars, sRGB colors."""
import numpy as np

CHANNELS = dict(color=slice(0,3), metallic=3, roughness=4, normal=slice(5,8),
                height=8, emission=slice(9,12), alpha=12, ao=13)
DEFAULTS = dict(color='#262a30', metallic=0, roughness=.46, normal='#8080ff',
                height=.5, emission='#000000', alpha=1, ao=1)
RGB = {'color','normal','emission'}
SRGB = {'color','emission'}

def enabled_base(paint):
    return {name:paint['base'].get(name,DEFAULTS[name]) if paint.get('baseChannels',{}).get(name,True) else DEFAULTS[name]
            for name in CHANNELS}

def channel_value(name, value, decode_color):
    if name in SRGB:
        return decode_color(value)
    if name == 'normal':
        return np.array(list(bytes.fromhex(value[1:])),dtype=np.float32)/255
    return value

def material_values(values, decode_color):
    result=np.empty(14,dtype=np.float32)
    for name,part in CHANNELS.items():
        result[part]=channel_value(name,values.get(name,DEFAULTS[name]),decode_color)
    return result

def normalize_normals(result):
    normal=result[:,5:8]*2-1
    length=np.linalg.norm(normal,axis=1,keepdims=True)
    normal=np.divide(normal,length,out=np.tile([0.,0.,1.],(len(result),1)),where=length>1e-8)
    result[:,5:8]=normal*.5+.5
