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


@lru_cache(maxsize=1)
def connected_area_kernel():
    from ctypes import c_size_t
    import numpy as np

    solve = getattr(native_paint_library(), 'arachne_connected_area_v1', None)
    if solve is None:
        return None
    mask = np.ctypeslib.ndpointer(dtype=np.bool_, ndim=2, flags=('C_CONTIGUOUS','ALIGNED'))
    output = np.ctypeslib.ndpointer(dtype=np.bool_, ndim=2, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    solve.argtypes = [mask,c_size_t,c_size_t,c_size_t,c_size_t,output]
    solve.restype = None

    def fill(matching, row, column):
        height, width = matching.shape
        if not (0 <= row < height and 0 <= column < width):
            raise IndexError('连续选区的起点超出图像')
        matching = np.ascontiguousarray(matching, dtype=np.bool_)
        reached = np.zeros((height,width),dtype=np.bool_)
        solve(matching,width,height,row,column,reached)
        return reached

    return fill


@lru_cache(maxsize=1)
def gaussian_blur_kernel():
    from ctypes import c_double, c_size_t
    import numpy as np

    solve = getattr(native_paint_library(), 'arachne_gaussian_blur_v1', None)
    if solve is None:
        return None
    pixels = np.ctypeslib.ndpointer(dtype=np.float32, ndim=3, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    solve.argtypes = [pixels,c_size_t,c_size_t,c_size_t,c_size_t,c_double]
    solve.restype = None

    def blur(image, half, edge):
        solve(image,*image.shape,half,edge)

    return blur


@lru_cache(maxsize=1)
def composite_tile_kernel():
    from ctypes import POINTER, c_bool, c_float, c_size_t, c_uint8
    import numpy as np

    solve = getattr(native_paint_library(), 'arachne_composite_tile_v1', None)
    if solve is None:
        return None
    target = np.ctypeslib.ndpointer(dtype=np.float32, ndim=2, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    source = np.ctypeslib.ndpointer(dtype=np.float32, ndim=2, flags=('C_CONTIGUOUS','ALIGNED'))
    indices = np.ctypeslib.ndpointer(dtype=np.intp, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    weights = POINTER(c_float)
    solve.argtypes = [target,c_size_t,indices,source,c_size_t,c_float,weights,c_uint8,c_bool]
    solve.restype = None

    modes = {'normal':0,'multiply':1,'screen':2,'overlay':3}

    def composite(result, ids, pixels, opacity, mode, clipped):
        operation = modes.get(mode)
        if operation is None:
            return False
        if not (result.dtype==pixels.dtype==np.float32 and result.flags.carray and
                result.shape[1:]==(4,) and pixels.shape==(len(ids),4)):
            return False
        if isinstance(opacity, np.ndarray):
            if opacity.shape!=(len(ids),1) or opacity.dtype!=np.float32:
                return False
            mask = np.require(opacity,requirements=('C','A'))
            pointer,scalar = mask.ctypes.data_as(weights),0.0
        elif type(opacity) in (int,float,np.float32):
            pointer,scalar = None,opacity
        else:
            return False
        ids = np.require(ids,np.intp,('C','A'))
        pixels = np.require(pixels,requirements=('C','A'))
        solve(result,len(result),ids,pixels,len(ids),scalar,pointer,operation,clipped)
        return True

    return composite


@lru_cache(maxsize=1)
def pixel_lower_bounds_kernel():
    from ctypes import c_size_t
    import numpy as np

    solve = getattr(native_paint_library(), 'arachne_pixel_lower_bounds_v1', None)
    if solve is None:
        return None
    ids = np.ctypeslib.ndpointer(dtype=np.int32, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    slots = np.ctypeslib.ndpointer(dtype=np.intp, ndim=1, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    solve.argtypes = [ids,c_size_t,ids,c_size_t,slots]
    solve.restype = None

    def lookup(table, queries):
        indices = np.empty(len(queries),dtype=np.intp)
        solve(table,len(table),queries,len(queries),indices)
        return indices

    return lookup


@lru_cache(maxsize=1)
def pixel_union_kernel():
    from ctypes import POINTER, Structure, c_int32, c_size_t
    import numpy as np

    library = native_paint_library()
    mark = getattr(library, 'arachne_mark_pixel_union_v1', None)
    if mark is None:
        return None
    collect = library.arachne_read_pixel_union_v1
    ids = POINTER(c_int32)

    class PixelBatch(Structure):
        _fields_ = [('ids', ids), ('length', c_size_t)]

    bitmap_pointer = np.ctypeslib.ndpointer(dtype=np.uint64, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    output_pointer = np.ctypeslib.ndpointer(dtype=np.int32, ndim=1, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    mark.argtypes = [POINTER(PixelBatch),c_size_t,bitmap_pointer,c_size_t]
    mark.restype = c_size_t
    collect.argtypes = [bitmap_pointer,c_size_t,output_pointer,c_size_t]
    collect.restype = None

    def union(parts, pixels):
        bitmap = np.zeros((pixels+63)//64,dtype=np.uint64)
        batches = (PixelBatch*len(parts))(*(PixelBatch(part.ctypes.data_as(ids),len(part)) for part in parts))
        count = mark(batches,len(batches),bitmap,len(bitmap))
        output = np.empty(count,dtype=np.int32)
        collect(bitmap,len(bitmap),output,count)
        return output

    return union


@lru_cache(maxsize=1)
def srgb_encoding_kernel():
    from ctypes import c_size_t
    import numpy as np
    from image_color_spaces import encode

    solve = getattr(native_paint_library(), 'arachne_encode_srgb_v1', None)
    if solve is None:
        return None

    def quantize(linear):
        return np.rint(np.clip(encode(linear,'srgb'),0,1)*255).astype(np.uint8)

    # Search the actual float32 conversion boundaries. A discretized gamma
    # curve alone would round colors differently at bin edges.
    codes = quantize(np.arange(4097,dtype=np.float32)/4096)
    low = np.zeros(255,dtype=np.uint32)
    high = np.full_like(low,np.float32(1).view(np.uint32))
    desired = np.arange(1,256,dtype=np.uint8)
    while np.any(low<high):
        mid = (low+high)//2
        below = quantize(mid.view(np.float32))<desired
        low = np.where(below,mid+1,low)
        high = np.where(below,high,mid)
    boundaries = np.concatenate((low.view(np.float32),np.array([np.inf],dtype=np.float32)))

    pixels = np.ctypeslib.ndpointer(dtype=np.float32, ndim=2, flags=('C_CONTIGUOUS','ALIGNED'))
    table = np.ctypeslib.ndpointer(dtype=np.uint8, shape=(4097,), flags=('C_CONTIGUOUS','ALIGNED'))
    edges = np.ctypeslib.ndpointer(dtype=np.float32, shape=(256,), flags=('C_CONTIGUOUS','ALIGNED'))
    output = np.ctypeslib.ndpointer(dtype=np.uint8, ndim=2, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    solve.argtypes = [pixels,c_size_t,table,edges,output]
    solve.restype = None

    def pack(source):
        packed = np.empty(source.shape,dtype=np.uint8)
        solve(source,len(source),codes,boundaries,packed)
        return packed

    return pack


@lru_cache(maxsize=1)
def rgba_decoding_kernel():
    from ctypes import c_bool, c_size_t
    import numpy as np
    from image_color_spaces import decode

    solve = getattr(native_paint_library(), 'arachne_decode_rgba_v1', None)
    if solve is None:
        return None

    pixels = np.ctypeslib.ndpointer(dtype=np.uint8, ndim=3, flags=('C_CONTIGUOUS','ALIGNED'))
    table = np.ctypeslib.ndpointer(dtype=np.float32, shape=(256,), flags=('C_CONTIGUOUS','ALIGNED'))
    output = np.ctypeslib.ndpointer(dtype=np.float32, ndim=3, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    solve.argtypes = [pixels,c_size_t,c_size_t,table,table,c_bool,output]
    solve.restype = None
    alpha = np.arange(256,dtype=np.float32)/255

    @lru_cache
    def color_table(space):
        return np.ascontiguousarray(decode(alpha,space),dtype=np.float32)

    def unpack(pixels, space):
        height,width,_ = pixels.shape
        reversed_rows = pixels.strides[0] < 0
        source = np.ascontiguousarray(pixels[::-1] if reversed_rows else pixels)
        result = np.empty((height,width,4),dtype=np.float32)
        solve(source,width,height,color_table(space),alpha,reversed_rows,result)
        return result

    return unpack


@lru_cache(maxsize=1)
def bilinear_sampling_kernel():
    from ctypes import c_size_t
    import numpy as np

    solve = getattr(native_paint_library(), 'arachne_sample_bilinear_v1', None)
    if solve is None:
        return None
    image = np.ctypeslib.ndpointer(dtype=np.float32, ndim=3, flags=('C_CONTIGUOUS','ALIGNED'))
    coordinates = np.ctypeslib.ndpointer(dtype=np.float64, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    pixels = np.ctypeslib.ndpointer(dtype=np.float32, ndim=2, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    flags = np.ctypeslib.ndpointer(dtype=np.bool_, ndim=1, flags=('C_CONTIGUOUS','WRITEABLE'))
    solve.argtypes = [image,c_size_t,c_size_t,coordinates,coordinates,c_size_t,pixels,flags]
    solve.restype = None

    def bind(raw):
        height,width,_ = raw.shape
        source = np.require(raw,np.float32,('C','A'))
        def sample(u,v):
            u = np.require(u,np.float64,('C','A'))
            v = np.require(v,np.float64,('C','A'))
            result = np.empty((len(u),4),dtype=np.float32)
            occupied = np.empty(len(u),dtype=np.bool_)
            solve(source,width,height,u,v,len(u),result,occupied)
            return result,occupied
        return sample

    return bind


@lru_cache(maxsize=1)
def paint_selection_sampling_kernel():
    from ctypes import POINTER, Structure, byref, c_float, c_size_t
    import numpy as np

    solve = getattr(native_paint_library(), 'arachne_sample_paint_selection_v1', None)
    if solve is None:
        return None

    floats = POINTER(c_float)

    class Frame(Structure):
        _fields_ = [(field,c_size_t) for field in
                    ('width','height','raster_width','raster_height','left','bottom')]

    class Plane(Structure):
        _fields_ = [('alpha',floats),('pixels',floats),('components',c_size_t),
                    ('out_alpha',floats),('out_pixels',floats)]

    ids = np.ctypeslib.ndpointer(dtype=np.int32, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    coord = np.ctypeslib.ndpointer(dtype=np.float64, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    flags = np.ctypeslib.ndpointer(dtype=np.bool_, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    solve.argtypes = [POINTER(Frame),ids,flags,floats,c_size_t,coord,coord,c_size_t,
                      POINTER(Plane),c_size_t,flags]
    solve.restype = None

    def bind(bounds, affected, selected, paint, coverage):
        if affected.dtype!=np.int32 or any(a.dtype!=np.float32 or p.dtype!=np.float32 for a,p in paint.values()):
            return None
        frame = Frame(*bounds)
        affected = np.require(affected,requirements=('C','A'))
        selected = np.require(selected,requirements=('C','A'))
        weights = None if coverage is None else np.require(coverage,np.float32,('C','A')).ctypes.data_as(floats)
        source = {name:(np.require(a,requirements=('C','A')),np.require(p,requirements=('C','A')))
                  for name,(a,p) in paint.items()}

        def sample(u, v):
            u = np.require(u,np.float64,('C','A'))
            v = np.require(v,np.float64,('C','A'))
            occupied = np.empty(len(u),dtype=np.bool_)
            result = {}
            planes = (Plane*len(source))()
            for index,(name,(alpha,pixels)) in enumerate(source.items()):
                components = pixels.shape[1]
                out_alpha = np.empty(len(u),dtype=np.float32)
                out_pixels = np.empty((len(u),components),dtype=np.float32)
                result[name] = out_alpha,out_pixels
                planes[index] = Plane(alpha.ctypes.data_as(floats),pixels.ctypes.data_as(floats),components,
                                      out_alpha.ctypes.data_as(floats),out_pixels.ctypes.data_as(floats))
            solve(byref(frame),affected,selected,weights,len(affected),u,v,len(u),planes,len(source),occupied)
            return occupied,result

        return sample

    return bind


@lru_cache(maxsize=1)
def apply_paint_channel_kernel():
    from ctypes import c_bool, c_size_t
    import numpy as np

    solve = getattr(native_paint_library(), 'arachne_apply_paint_channel_v1', None)
    if solve is None:
        return None

    vector = np.ctypeslib.ndpointer(dtype=np.float32, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    alpha_data = np.ctypeslib.ndpointer(dtype=np.float32, ndim=1, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    channel_data = np.ctypeslib.ndpointer(dtype=np.float32, ndim=2, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    indices = np.ctypeslib.ndpointer(dtype=np.intp, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    solve.argtypes = [alpha_data,channel_data,c_size_t,c_size_t,indices,vector,c_size_t,vector,c_bool,c_bool]
    solve.restype = None
    erased = np.zeros(3,dtype=np.float32)

    def apply(alpha,channel,slots,coverage,value,erase=False,lock_alpha=False):
        if len(slots)<512 or coverage.dtype!=np.float32 or not coverage.flags.carray:
            return False
        if not erase and isinstance(value,np.ndarray) and value.dtype!=np.float32:
            return False
        channels = channel.shape[1]
        ink = erased if erase else np.asarray(value,dtype=np.float32).reshape(channels)
        slots = np.require(slots,np.intp,('C','A'))
        solve(alpha,channel,len(alpha),channels,slots,coverage,len(slots),ink,erase,lock_alpha)
        return True

    return apply


@lru_cache(maxsize=1)
def affine_sampling_kernel():
    from ctypes import c_double, c_size_t
    import numpy as np
    from platform import machine
    from sys import platform

    # Pillow's native affine round-off can change coverage at an image edge.
    # Use the fused kernel on the arm64 macOS runtime verified against Pillow.
    if platform != 'darwin' or machine() != 'arm64':
        return None

    solve = getattr(native_paint_library(), 'arachne_sample_affine_v1', None)
    if solve is None:
        return None

    image = np.ctypeslib.ndpointer(dtype=np.float32, ndim=3, flags=('C_CONTIGUOUS','ALIGNED'))
    output = np.ctypeslib.ndpointer(dtype=np.float32, ndim=2, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    coefficients = c_double*6
    solve.argtypes = [image,c_size_t,c_size_t,coefficients,c_size_t,c_size_t,c_size_t,c_size_t,output]
    solve.restype = None

    def sample(raw, extent, affine, bottom_start=0, rows=None):
        height,width,_ = raw.shape
        out_width,out_height = extent
        source = np.require(raw,np.float32,('C','A'))
        rows = out_height if rows is None else rows
        result = np.empty((out_width*rows,4),dtype=np.float32)
        solve(source,width,height,coefficients(*affine),out_width,out_height,bottom_start,rows,result)
        return result

    return sample


@lru_cache(maxsize=1)
def alpha_bounds_kernel():
    from ctypes import c_bool, c_size_t, c_void_p
    import numpy as np

    solve = getattr(native_paint_library(),'arachne_alpha_bounds_v1',None)
    if solve is None:
        return None
    bounds = c_size_t*4
    solve.argtypes = [c_void_p,c_size_t,c_size_t,c_size_t,c_size_t,c_bool,bounds]
    solve.restype = None

    def find(alpha):
        height,width = alpha.shape
        row,pixel = alpha.strides
        step = alpha.itemsize
        flipped = row<0
        origin = alpha[::-1] if flipped else alpha
        output = bounds()
        solve(origin.ctypes.data,height,width,abs(row)//step,pixel//step,alpha.dtype==np.uint8,output)
        top,bottom,left,right = output
        if flipped and bottom:
            top,bottom = height-bottom,height-top
        return top,bottom,left,right

    return find


@lru_cache(maxsize=1)
def sparse_mask_kernels():
    from ctypes import c_size_t
    import numpy as np

    library = native_paint_library()
    apply = getattr(library,'arachne_apply_sparse_mask_v1',None)
    if apply is None:
        return None
    sample = library.arachne_sample_sparse_mask_v1
    ids = np.ctypeslib.ndpointer(dtype=np.int32, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    values = np.ctypeslib.ndpointer(dtype=np.float32, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    output = np.ctypeslib.ndpointer(dtype=np.float32, ndim=1, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    coord = np.ctypeslib.ndpointer(dtype=np.float64, ndim=1, flags=('C_CONTIGUOUS','ALIGNED'))
    apply.argtypes = [ids,values,values,c_size_t,ids,output,c_size_t]
    apply.restype = None
    sample.argtypes = [ids,values,values,c_size_t,c_size_t,c_size_t,c_size_t,c_size_t,coord,coord,c_size_t,output,output]
    sample.restype = None

    def parameters(mask):
        affected,alpha,value = mask
        return (np.require(affected,np.int32,('C','A')),np.require(alpha,np.float32,('C','A')),
                np.require(value,np.float32,('C','A')),len(affected))

    def blend(mask,queries,result):
        # Pixel IDs come from the 4K editing atlas.
        queries = np.require(queries,np.int32,('C','A'))
        apply(*parameters(mask),queries,result,len(queries))

    def transformed(mask,size,raster,left,bottom,u,v):
        u = np.require(u,np.float64,('C','A'))
        v = np.require(v,np.float64,('C','A'))
        alpha = np.empty(len(u),dtype=np.float32)
        value = np.empty(len(u),dtype=np.float32)
        sample(*parameters(mask),size,raster,left,bottom,u,v,len(u),alpha,value)
        return alpha,value

    return blend,transformed


@lru_cache(maxsize=1)
def affine_shape_kernel():
    from ctypes import POINTER, Structure, byref, c_bool, c_double, c_float, c_size_t
    import numpy as np

    solve = getattr(native_paint_library(),'arachne_raster_shape_v1',None)
    if solve is None:
        return None

    class Shape(Structure):
        _fields_ = [(name,c_size_t) for name in ('raster','tile','left','bottom')] + [
            (name,c_double) for name in ('cos','sin','cx','cy','scale_x','scale_y','half_width',
                                       'half_height','radius','antialias','stroke_width')] + [
            ('fill',c_float*3),('stroke',c_float*3),('filled',c_bool),('rectangle',c_bool)]

    ids = np.ctypeslib.ndpointer(dtype=np.intp, ndim=1, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    rgba = np.ctypeslib.ndpointer(dtype=np.float32, ndim=2, flags=('C_CONTIGUOUS','ALIGNED','WRITEABLE'))
    solve.argtypes = [POINTER(Shape),c_size_t,c_size_t,c_size_t,c_size_t,ids,rgba]
    solve.restype = c_size_t

    def bind(frame, parameters, fill, stroke, filled, rectangle):
        shape = Shape(*frame,*parameters,(c_float*3)(*fill),(c_float*3)(*stroke),filled,rectangle)
        def rasterize(row_start,row_end,col_start,col_end):
            length = (row_end-row_start)*(col_end-col_start)
            index = np.empty(length,dtype=np.intp)
            pixels = np.empty((length,4),dtype=np.float32)
            count = solve(byref(shape),row_start,row_end,col_start,col_end,index,pixels)
            return index[:count],pixels[:count]
        return rasterize

    return bind


def require_native_paint():
    """Verify the bundled library before an installer is published."""
    from platform import machine
    from sys import platform
    kernels = (
        inverse_grid_kernel, brush_coverage_kernel, connected_area_kernel,
        gaussian_blur_kernel, composite_tile_kernel, pixel_lower_bounds_kernel,
        pixel_union_kernel, srgb_encoding_kernel, rgba_decoding_kernel, bilinear_sampling_kernel,
        apply_paint_channel_kernel, paint_selection_sampling_kernel, alpha_bounds_kernel, sparse_mask_kernels,
        affine_shape_kernel,
    )
    if platform == 'darwin' and machine() == 'arm64':
        kernels += (affine_sampling_kernel,)
    for kernel in kernels:
        if kernel() is None:
            raise RuntimeError(f'缺少绘制原生内核：{kernel.__name__}')
