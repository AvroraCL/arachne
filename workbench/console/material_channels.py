"""Scalar data generation/registration; never infer physical properties from RGB."""
from pathlib import Path
import hashlib
import numpy as np
from PIL import Image

def scalar_canvas(spec, registration, directory):
    w,h=registration['canonicalSize'];rw,rh=registration['registeredSize'];x,y=registration['offset']
    if 'value' in spec:
        value=spec['value']
        if not isinstance(value,(int,float)) or not np.isfinite(value) or not 0<=value<=1:raise ValueError('Invalid scalar')
        return np.full((h,w),value*255,dtype=np.float32)
    p=Path(directory)/spec['file']
    if hashlib.sha256(p.read_bytes()).hexdigest()!=spec['sha256']:raise ValueError('Scalar source hash mismatch')
    with Image.open(p) as im:
        im.load()
        if list(im.size)!=registration['originalSize']:raise ValueError('Scalar map must match the complete original artwork dimensions')
        rgba=np.array(im.convert('RGBA'))
        if np.any(rgba[:,:,3]!=255) or not np.array_equal(rgba[:,:,0],rgba[:,:,1]) or not np.array_equal(rgba[:,:,0],rgba[:,:,2]):raise ValueError('Scalar map must be opaque grayscale, not colored artwork')
        data=np.array(im.convert('L').resize((rw,rh),Image.Resampling.BICUBIC),dtype=np.float32)
    result=np.zeros((h,w),dtype=np.float32);result[y:y+rh,x:x+rw]=data
    return result

def prepare_channels(material,registration,uv_shape,directory):
    if not material:return {},{}
    source={};uv={}
    for name in ('metallic','roughness'):
        value=material['base'][name]
        if not isinstance(value,(int,float)) or not np.isfinite(value) or not 0<=value<=1:raise ValueError('Invalid base scalar')
        source[name]=scalar_canvas(material['surface'][name],registration,directory)
        uv[name]=np.full(uv_shape,round(value*255),dtype=np.uint8).ravel()
    return source,uv

def sample_scalar(art,xx,yy,xx1,yy1,dx,dy):
    dx=dx[:,0];dy=dy[:,0]
    return np.rint((art[yy,xx]*(1-dx)+art[yy,xx1]*dx)*(1-dy)+(art[yy1,xx]*(1-dx)+art[yy1,xx1]*dx)*dy).clip(0,255).astype('uint8')
