"""Write single-part ZIP scanline EXR from saved document pixels, in strips."""
import struct
import zlib

import numpy as np
from image_color_spaces import decode


def attribute(name, kind, value):
    return name.encode()+b'\0'+kind.encode()+b'\0'+struct.pack('<I',len(value))+value


def zip_block(raw):
    # OpenEXR ZIP separates even/odd bytes and differences adjacent bytes.
    data=np.frombuffer(raw,dtype=np.uint8)
    packed=np.concatenate((data[::2],data[1::2]))
    packed[1:]=packed[1:]-packed[:-1]+128
    compressed=zlib.compress(packed,4)
    return compressed if len(compressed)<len(raw) else raw


def write_document_exr(destination, pixels, source_space, settings):
    height,width=pixels.shape[:2]
    bits=settings['bitDepth']
    dtype='<f2' if bits==16 else '<f4'
    channels=b''.join(name+b'\0'+struct.pack('<i4xii',1 if bits==16 else 2,1,1) for name in (b'A',b'B',b'G',b'R'))+b'\0'
    box=struct.pack('<4i',0,0,width-1,height-1)
    header=b''.join((
        struct.pack('<II',20000630,2),attribute('channels','chlist',channels),
        attribute('compression','compression',b'\x03'),attribute('dataWindow','box2i',box),attribute('displayWindow','box2i',box),
        attribute('lineOrder','lineOrder',b'\0'),attribute('pixelAspectRatio','float',struct.pack('<f',1)),
        attribute('screenWindowCenter','v2f',struct.pack('<ff',0,0)),attribute('screenWindowWidth','float',struct.pack('<f',1)),
        attribute('chromaticities','chromaticities',struct.pack('<8f',*settings['primaries'])),
        attribute('colorInteropID','string',settings['space'].encode()),b'\0'))
    offsets=[]
    matrix=np.asarray(settings['matrix'],dtype=np.float32).reshape(3,3)
    lut=decode(np.arange(256,dtype=np.float32)[:,None]/255,source_space).reshape(-1)
    with open(destination,'wb') as f:
        f.write(header)
        f.write(bytes(8*((height+15)//16)))
        for top in range(0,height,16):
            block=pixels[top:top+16]
            linear=lut[block[:,:,:3]] @ matrix.T
            alpha=block[:,:,3].astype(np.float32)/255
            linear*=alpha[:,:,None]
            planes=np.empty((len(block),4,width),dtype=dtype)
            planes[:,0]=alpha
            planes[:,1:]=linear[:,:,::-1].transpose(0,2,1)
            content=zip_block(planes.tobytes())
            offsets.append(f.tell())
            f.write(struct.pack('<iI',top,len(content)))
            f.write(content)
        f.seek(len(header))
        f.write(struct.pack('<'+'Q'*len(offsets),*offsets))
