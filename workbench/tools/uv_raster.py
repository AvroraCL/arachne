"""UV texel-center coordinates matching image texture sampling in the renderer."""
import numpy as np

def pixel_bounds(uv,resolution):
    lo=np.maximum(np.floor(uv.min(axis=0)*resolution-.5).astype(int),0)
    hi=np.minimum(np.ceil(uv.max(axis=0)*resolution-.5).astype(int),resolution-1)
    return lo,hi

def sample_coordinates(xx,yy,resolution):
    return (xx+.5)/resolution,(yy+.5)/resolution
