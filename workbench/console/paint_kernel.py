"""Load Arachne’s native drawing kernels and borrow NumPy buffers."""
import math
import os
import sys
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def native_paint_library():
    from ctypes import CDLL

    name = {'darwin':'libarachne_paint.dylib', 'win32':'arachne_paint.dll'}.get(sys.platform, 'libarachne_paint.so')
    configured = os.environ.get('ARACHNE_PAINT_KERNEL')
    file = Path(configured).resolve() if configured else Path(__file__).with_name(name)
    if not configured and not file.is_file():
        # A source checkout can run before the optional development build.
        return None

    return CDLL(str(file))


@lru_cache(maxsize=1)
def inverse_grid_kernel():
    from ctypes import c_size_t
    import numpy as np

    library = native_paint_library()
    if library is None:
        return None
    solve = library.arachne_inverse_smooth_grid_v1
    vector = np.ctypeslib.ndpointer(dtype=np.float64, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    cells = np.ctypeslib.ndpointer(dtype=np.float64, ndim=5, flags=('C_CONTIGUOUS','ALIGNED'))
    output = np.ctypeslib.ndpointer(dtype=np.float64, ndim=1, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    flags = np.ctypeslib.ndpointer(dtype=np.bool_, ndim=1, flags=('C_CONTIGUOUS','WRITEABLE'))
    solve.argtypes = [vector,c_size_t,vector,c_size_t,cells,vector,vector,c_size_t,output,output,flags]
    solve.restype = None

    def bind(u_knots,v_knots,coefficients):
        u_knots = np.require(u_knots,np.float64,('C','A'))
        v_knots = np.require(v_knots,np.float64,('C','A'))
        coefficients = np.require(coefficients,np.float64,('C','A'))
        if (u_knots.ndim!=1 or v_knots.ndim!=1 or min(len(u_knots),len(v_knots))<2 or
            coefficients.shape!=(len(v_knots)-1,len(u_knots)-1,4,4,2)):
            raise ValueError('平滑网格系数尺寸无效')

        def project(x,y):
            x = np.require(x,np.float64,('C','A'))
            y = np.require(y,np.float64,('C','A'))
            if x.ndim!=1 or x.shape!=y.shape:
                raise ValueError('变形采样坐标尺寸无效')
            u,v = np.empty_like(x),np.empty_like(y)
            valid = np.empty(x.shape,dtype=np.bool_)
            solve(u_knots,len(u_knots),v_knots,len(v_knots),coefficients,x,y,len(x),u,v,valid)
            return u,v,valid

        return project

    return bind


@lru_cache(maxsize=1)
def brush_coverage_kernel():
    from ctypes import POINTER, Structure, byref, c_double, c_size_t, c_ssize_t
    import numpy as np

    library = native_paint_library()
    if library is None:
        return None

    class Brush(Structure):
        _fields_ = [(name,c_size_t) for name in ('width','height','raster','left','bottom')] + [
            (name,c_ssize_t) for name in ('clip_left','clip_bottom','clip_right','clip_top')] + [
            (name,c_double) for name in ('footprint','softness','flow','roundness','cos','sin','grain')]

    class ImageView(Structure):
        _fields_ = [(name,c_size_t) for name in ('width','height')]

    solve = library.arachne_accumulate_brush_v1
    dabs_pointer = np.ctypeslib.ndpointer(dtype=np.float64,ndim=2,flags=('C_CONTIGUOUS','ALIGNED'))
    image_pointer = np.ctypeslib.ndpointer(dtype=np.float32,ndim=2,flags=('C_CONTIGUOUS','ALIGNED'))
    output = np.ctypeslib.ndpointer(dtype=np.float32,ndim=2,flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    solve.argtypes = [POINTER(Brush),dabs_pointer,c_size_t,POINTER(ImageView),image_pointer,
                      POINTER(ImageView),image_pointer,output]
    solve.restype = None
    empty_image = np.empty((0,0),np.float32)

    def accumulate(weights,dabs,raster,left,bottom,clip,footprint,hardness,flow,tip,custom_tip,texture):
        dabs = np.asarray(list(dabs),dtype=np.float64).reshape(-1,4)
        tip = tip or {}
        radians = math.radians(tip.get('angle',0))
        height,width = weights.shape
        brush = Brush(width,height,raster,left,bottom,*clip,footprint,max(.001,1-hardness),flow,
                      tip.get('roundness',1),math.cos(radians),math.sin(radians),tip.get('grain',0))
        custom_tip = empty_image if custom_tip is None else np.require(custom_tip,np.float32,('C','A'))
        texture = empty_image if texture is None else np.require(texture,np.float32,('C','A'))
        solve(byref(brush),dabs,len(dabs),byref(ImageView(*custom_tip.shape[::-1])),custom_tip,
              byref(ImageView(*texture.shape[::-1])),texture,weights)

    return accumulate
