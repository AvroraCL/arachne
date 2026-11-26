"""Regenerate Arachne's bounded ACES RGB and neutral grayscale ICC profiles."""
import argparse
import ctypes as c
from ctypes.util import find_library
import hashlib
from pathlib import Path
import struct


class Chromaticity(c.Structure):
    _fields_ = [('x',c.c_double),('y',c.c_double),('Y',c.c_double)]


class Primaries(c.Structure):
    _fields_ = [(name,Chromaticity) for name in ('red','green','blue')]


# https://docs.acescentral.com/encodings/acescg/ and /encodings/aces2065-1/
SPACES = {'ACEScg':[(.713,.293),(.165,.830),(.128,.044)],
          'ACES2065-1':[(.73470,.26530),(0.,1.),(.00010,-.07700)]}


def generate(lib, folder, family):
    def bind(name, result, *inputs):
        fn = getattr(lib,name)
        fn.restype,fn.argtypes = result,inputs
        return fn
    ptr,u32 = c.c_void_p,c.c_uint32
    gamma = bind('cmsBuildGamma',ptr,ptr,c.c_double)
    create = bind('cmsCreateRGBProfile',ptr,c.POINTER(Chromaticity),c.POINTER(Primaries),c.POINTER(ptr))
    gray = bind('cmsCreateGrayProfile',ptr,c.POINTER(Chromaticity),ptr)
    mlu = bind('cmsMLUalloc',ptr,ptr,u32)
    string = bind('cmsMLUsetASCII',c.c_int,ptr,c.c_char_p,c.c_char_p,c.c_char_p)
    write = bind('cmsWriteTag',c.c_int,ptr,u32,ptr)
    save = bind('cmsSaveProfileToMem',c.c_int,ptr,ptr,c.POINTER(u32))
    close = bind('cmsCloseProfile',c.c_int,ptr)
    free_curve = bind('cmsFreeToneCurve',None,ptr)
    free_text = bind('cmsMLUfree',None,ptr)
    spaces=[]
    if family in ('all','aces'):
        spaces.extend((name,xy,1.,name+'-linear',name+' - Arachne Linear RGB') for name,xy in SPACES.items())
    if family in ('all','gray'):
        spaces.extend([('Gray Gamma 2.2',None,2.2,'Gray-g22','Arachne Gray Gamma 2.2'),
                       ('Gray Linear',None,1.,'Gray-linear','Arachne Linear Gray')])
    for name,xy,exponent,filename,description in spaces:
        curve=gamma(None,exponent)
        if not curve:
            raise RuntimeError('Tone curve creation failed')
        try:
            if xy:
                white=Chromaticity(.32168,.33767,1.)
                primaries = Primaries(*(Chromaticity(x,y,1.) for x,y in xy))
                profile = create(c.byref(white),c.byref(primaries),(ptr*3)(curve,curve,curve))
            else:
                white=Chromaticity(.3457,.3585,1.)
                profile=gray(c.byref(white),curve)
            if not profile:
                raise RuntimeError('ICC profile creation failed: '+name)
            try:
                for tag,label in [('desc',description),('cprt','Arachne contributors, GPL-3.0-only')]:
                    text = mlu(None,1)
                    try:
                        if not text or not string(text,b'en',b'US',label.encode()) or not write(profile,int.from_bytes(tag.encode(),'big'),text):
                            raise RuntimeError('ICC tag creation failed: '+tag)
                    finally:
                        free_text(text)
                size = u32()
                if not save(profile,None,c.byref(size)):
                    raise RuntimeError('ICC profile serialization failed')
                buf = c.create_string_buffer(size.value)
                if not save(profile,buf,c.byref(size)):
                    raise RuntimeError('ICC profile serialization failed')
                data = bytearray(buf.raw)
                data[24:36] = struct.pack('>6H',2026,1,1,0,0,0)
                data[84:100] = bytes(16)
                digest = data.copy()
                digest[44:48] = digest[64:68] = bytes(4)
                data[84:100] = hashlib.md5(digest).digest()
                (folder/(filename+'.icc')).write_bytes(data)
            finally:
                close(profile)
        finally:
            free_curve(curve)


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lcms',default=find_library('lcms2'),help='Path to the LittleCMS 2 shared library')
    parser.add_argument('--family',choices=['all','aces','gray'],default='all')
    args = parser.parse_args()
    if not args.lcms:
        parser.error('Pass the LittleCMS 2 library path with --lcms')
    generate(c.CDLL(args.lcms),Path(__file__).resolve().parents[1]/'console'/'public'/'color-profiles',args.family)
