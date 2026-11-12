"""Surface operations on the registered mesh and original UV samples."""
from paint_channels import RGB, DEFAULTS, channel_value
import math
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path

import numpy as np


@lru_cache(maxsize=2)
def registered_surface(bundle, faces_path, binding):
    with np.load(Path(bundle)/'surfaces.npz') as archive:
        positions = archive['positions'].astype(np.float32)
        valid = archive['uv_valid']
        normals = archive['polygon_normals'][valid].astype(np.float32)
        objects = archive['object_ids'][valid]
        polygons = archive['polygon_ids'][valid]
    with np.load(faces_path) as faces:
        centers = faces['centers']
        protected = faces['projection_excluded'].astype(bool)
    if valid.sum() != len(centers) or not np.allclose(positions[valid].mean(axis=1), centers, atol=2e-5):
        raise ValueError('三维表面与原 UV 登记的三角形不一致')
    return positions, valid, normals, objects, polygons, protected


@lru_cache(maxsize=4)
def face_components(edges_path, count, island):
    with np.load(edges_path) as archive:
        edges = archive['faces']
        if island:
            edges = edges[archive['seam']==0]
    parents = list(range(count))

    def root(face):
        while parents[face]!=face:
            parents[face] = parents[parents[face]]
            face = parents[face]
        return face

    for a,b in edges.tolist():
        parents[root(a)] = root(b)
    return np.fromiter((root(i) for i in range(count)),dtype=np.int32,count=count)


def face_bin_index(low, high, bins):
    spans = np.maximum(high-low+1,0)
    counts = spans.prod(axis=1)
    nonempty = np.flatnonzero(counts)
    if not len(nonempty):
        return np.empty(0,dtype=np.intp),np.zeros(bins*bins+1,dtype=np.intp)
    faces = np.repeat(nonempty,counts[nonempty])
    offsets = np.r_[0,np.cumsum(counts[nonempty][:-1])]
    local = np.arange(len(faces))-np.repeat(offsets,counts[nonempty])
    face_x = local % spans[faces,0]+low[faces,0]
    face_y = local // spans[faces,0]+low[faces,1]
    face_bins = face_y*bins+face_x
    face_order = np.argsort(face_bins,kind='stable')
    return faces[face_order],np.searchsorted(face_bins[face_order],np.arange(bins*bins+1))


def projector_visibility(triangles, coords):
    """Find orthographic occluders at the original UV sample positions.

    Partition the projector plane into bins to find possible occluders.
    Barycentric tests use the sample ray, not the center of the bin.
    """
    bins = 64 if len(coords)>500000 else 32
    low = np.maximum(np.floor((triangles[:,:,:2].min(axis=1)+.5)*bins).astype(int),0)
    high = np.minimum(np.floor((triangles[:,:,:2].max(axis=1)+.5)*bins).astype(int),bins-1)
    faces,face_offsets = face_bin_index(low,high,bins)
    if not len(faces):
        return np.ones(len(coords),dtype=bool)
    xy = np.clip(np.floor((coords[:,:2]+.5)*bins).astype(int),0,bins-1)
    sample_bins = xy[:,1]*bins+xy[:,0]
    sample_order = np.argsort(sample_bins)
    sample_offsets = np.searchsorted(sample_bins[sample_order],np.arange(bins*bins+1))
    visible = np.ones(len(coords),dtype=bool)

    for cell in np.flatnonzero(np.diff(sample_offsets)):
        candidates = faces[face_offsets[cell]:face_offsets[cell+1]]
        samples = sample_order[sample_offsets[cell]:sample_offsets[cell+1]]
        a,b,c = triangles[candidates].transpose(1,0,2)
        den = (b[:,1]-c[:,1])*(a[:,0]-c[:,0])+(c[:,0]-b[:,0])*(a[:,1]-c[:,1])
        valid = np.abs(den)>1e-12
        a,b,c,den = a[valid],b[valid],c[valid],den[valid]
        if not len(den):
            continue
        chunk = max(1,120000//len(den))
        for start in range(0,len(samples),chunk):
            ids = samples[start:start+chunk]
            x,y,z = coords[ids].T[:,:,None]
            dx,dy = x-c[:,0],y-c[:,1]
            wa = ((b[:,1]-c[:,1])*dx+(c[:,0]-b[:,0])*dy)/den
            wb = ((c[:,1]-a[:,1])*dx+(a[:,0]-c[:,0])*dy)/den
            wc = 1-wa-wb
            depth = wa*a[:,2]+wb*b[:,2]+wc*c[:,2]
            blocked = (wa>=-1e-6)&(wb>=-1e-6)&(wc>=-1e-6)&(depth>z+.0002)
            visible[ids] = ~blocked.any(axis=1)
    return visible


class Surface:
    def __init__(self, positions, valid, normals, objects, xyz, owner, allowed, live=False, *,
                 polygons=None, protected=None, edges_path=None, uv_shape=None):
        self.positions = positions
        self.low = positions.min(axis=(0,1))
        self.high = positions.max(axis=(0,1))
        self.target_triangles = positions[valid]
        self.normals = normals
        self.objects = objects
        self.polygons = polygons
        self.protected = protected
        self.edges_path = edges_path
        self.xyz = xyz
        self.owner = owner
        self.allowed = allowed
        self.uv_shape = uv_shape
        index_dtype = np.int32 if owner.size <= np.iinfo(np.int32).max else np.intp
        self.ids = np.flatnonzero(allowed).astype(index_dtype, copy=False)
        self.live = live
        self.order = None
        self.bounds = None
        self.hit_index = None
        self.projections = OrderedDict()
        self.strokes = OrderedDict()
        self.brush_prefix = None
        self.uv_selection_cache = None

    def project(self, projector, image_shape):
        if not self.live:
            return self._project(projector,image_shape)
        key = (tuple(projector['center']),tuple(projector['normal']),tuple(projector['up']),
               projector['size'],projector['depth'],projector['rotation'],tuple(image_shape[:2]))
        if key not in self.projections:
            self.projections[key] = self._project(projector,image_shape)
            if len(self.projections)>12:
                self.projections.popitem(last=False)
        else:
            self.projections.move_to_end(key)
        return self.projections[key]

    def _project(self, projector, image_shape):
        center = np.asarray(projector['center'], dtype=np.float32)
        normal = np.asarray(projector['normal'], dtype=np.float32)
        up = np.asarray(projector['up'], dtype=np.float32)
        normal /= np.linalg.norm(normal)
        right = np.cross(up, normal)
        right /= np.linalg.norm(right)
        up = np.cross(normal, right)
        angle = math.radians(projector['rotation'])
        right, up = right*math.cos(angle)+up*math.sin(angle), up*math.cos(angle)-right*math.sin(angle)
        height, width = image_shape[:2]
        extent = projector['size'] * np.array([width,height],dtype=np.float32) / max(width,height)
        basis = np.stack([right/extent[0],-up/extent[1],normal],axis=1)
        ids = self.ids[np.einsum('ij,j->i',self.normals[self.owner[self.ids]],normal)>.15]
        coords = (self.xyz[ids]-center) @ basis
        inside = (np.abs(coords[:,:2])<=.5).all(axis=1)&(np.abs(coords[:,2])<=projector['depth'])
        ids, coords = ids[inside], coords[inside]
        if not len(ids):
            return ids, coords[:,:2]
        triangles = (self.positions-center) @ basis
        visible = projector_visibility(triangles,coords)
        return ids[visible], coords[visible,:2]+.5

    def stroke(self, stroke):
        if 'rect' in stroke:
            return self._rect_stroke(stroke)
        if stroke.get('uv'):
            key = ('uv', stroke['radius'], stroke['hardness'], stroke['opacity'],
                   tuple(stroke.get('clip', ())), self._selection_key(stroke),
                   tuple(map(tuple, stroke['stamps'])))
            return self._uv_stroke(stroke, key)
        if not self.live:
            return self._region(stroke) if 'region' in stroke else self._stroke(stroke)
        key = (stroke['region'],tuple(stroke['hit']),stroke['opacity']) if 'region' in stroke else (
            stroke['radius'],stroke['hardness'],stroke['opacity'],stroke.get('mirrorX',False),tuple(map(tuple,stroke['stamps'])))
        if key not in self.strokes:
            self.strokes[key] = self._region(stroke) if 'region' in stroke else self._stroke(stroke,key)
            if len(self.strokes)>128:
                self.strokes.popitem(last=False)
        else:
            self.strokes.move_to_end(key)
        return self.strokes[key]

    def _uv_pixel_rect(self, rect):
        height, width = self.uv_shape
        left, top, right, bottom = rect
        min_col,max_col = (math.ceil(edge*width-.5) for edge in (left,right))
        min_row,max_row = (height-math.ceil(edge*height-.5) for edge in (bottom,top))
        return min_row,max_row,min_col,max_col

    @staticmethod
    def _selection_key(shape):
        regions = shape.get('regions')
        if regions is None:
            polygon = shape.get('polygon')
            regions = [[polygon]] if polygon is not None else []
        return tuple(tuple(tuple(map(tuple, ring)) for ring in region) for region in regions)

    def _selection_tile(self, rect, shape):
        regions = self._selection_key(shape)
        key = tuple(rect),regions
        if self.uv_selection_cache is not None and self.uv_selection_cache[0] == key:
            return self.uv_selection_cache[1]
        height,width = self.uv_shape
        row0,row1,col0,col1 = self._uv_pixel_rect(rect)
        mask = np.full((row1-row0,col1-col0), not regions, dtype=bool)
        # Each polygon uses even-odd fill for its outer contour and holes.
        # Multiple polygons contribute to the same selection.
        for region in regions:
            rings = [np.asarray(ring) for ring in region]
            x,y = np.concatenate(rings).T
            next_x,next_y = np.concatenate([np.roll(ring,-1,axis=0) for ring in rings]).T
            first_row = max(row0, height-math.ceil(y.max()*height-.5))
            last_row = min(row1, height-math.ceil(y.min()*height-.5))
            for row in range(first_row,last_row):
                v = 1-(row+.5)/height
                crossed = (y>v)!=(next_y>v)
                xs = x[crossed]+(v-y[crossed])*(next_x[crossed]-x[crossed])/(next_y[crossed]-y[crossed])
                columns = np.clip(np.ceil(np.sort(xs)*width-.5).astype(int),col0,col1)-col0
                for left,right in zip(columns[::2],columns[1::2]):
                    mask[row-row0,left:right] = True
        self.uv_selection_cache = key,mask
        return mask

    def _selection_contains(self, ids, rect, shape):
        if 'polygon' not in shape and 'regions' not in shape:
            return self._inside_uv(*self._texel_uv(ids),rect)
        width = self.uv_shape[1]
        row0,row1,col0,col1 = self._uv_pixel_rect(rect)
        rows,cols = np.divmod(ids,width)
        in_tile = (rows>=row0)&(rows<row1)&(cols>=col0)&(cols<col1)
        mask = self._selection_tile(rect,shape)
        result = in_tile.copy()
        result[in_tile] = mask[rows[in_tile]-row0,cols[in_tile]-col0]
        return result

    def _rect_stroke(self, stroke):
        height, width = self.uv_shape
        min_row,max_row,min_col,max_col = self._uv_pixel_rect(stroke['rect'])
        tile = self.allowed.reshape(height,width)[min_row:max_row,min_col:max_col]
        if 'polygon' in stroke or 'regions' in stroke:
            tile = tile & self._selection_tile(stroke['rect'],stroke)
        rows, cols = np.nonzero(tile)
        ids = ((rows+min_row)*width+cols+min_col).astype(np.int32)
        return ids,np.full(len(ids),stroke['opacity'],dtype=np.float32)

    def _uv_stroke(self, stroke, key):
        if self.live and key in self.strokes:
            self.strokes.move_to_end(key)
            return self.strokes[key]
        height, width = self.uv_shape
        radius = stroke['radius']
        weights = None
        stamps = stroke['stamps']
        if self.live and self.brush_prefix is not None:
            previous, known = self.brush_prefix
            count = len(previous[-1])
            if key[:-1] == previous[:-1] and key[-1][:count] == previous[-1]:
                stamps, weights = stamps[count:], known.copy()
        min_row,max_row,min_col,max_col = self._uv_pixel_rect(stroke.get('clip', (0,0,1,1)))
        row_origin,col_origin = 0,0
        if not self.live:
            # A 4K brush normally touches a small part of the atlas. Only
            # allocate that tile; live previews retain a reusable full buffer.
            points = np.array([stamp[:2] for stamp in stamps])
            low_x,low_y = points.min(axis=0)
            high_x,high_y = points.max(axis=0)
            min_col = max(min_col,math.floor((low_x-radius)*width))
            max_col = min(max_col,math.ceil((high_x+radius)*width))
            min_row = max(min_row,math.floor((1-high_y-radius)*height))
            max_row = min(max_row,math.ceil((1-low_y+radius)*height))
            if min_col>=max_col or min_row>=max_row:
                return np.empty(0,dtype=np.int32),np.empty(0,dtype=np.float32)
            row_origin,col_origin = min_row,min_col
            weights = np.zeros((max_row-min_row,max_col-min_col),dtype=np.float32)
        elif weights is None:
            weights = np.zeros((height,width),dtype=np.float32)
        for stamp in stamps:
            u,y = stamp[:2]
            pressure = stamp[2] if len(stamp)==3 else 1
            if pressure==0:
                continue
            v = 1-y
            left, right = max(min_col, math.floor((u-radius)*width)), min(max_col, math.ceil((u+radius)*width))
            bottom, top = max(min_row, math.floor((v-radius)*height)), min(max_row, math.ceil((v+radius)*height))
            if left>=right or bottom>=top:
                continue
            xs = (np.arange(left,right,dtype=np.float32)+.5)/width-u
            ys = (np.arange(bottom,top,dtype=np.float32)+.5)/height-v
            distance = np.hypot(xs,ys[:,None])/radius
            alpha = np.clip((1-distance)/max(.001,1-stroke['hardness']),0,1)*(stroke['opacity']*pressure)
            tile = weights[bottom-row_origin:top-row_origin,left-col_origin:right-col_origin]
            np.maximum(tile,alpha,out=tile)
        flat = weights.ravel()
        shaped = 'polygon' in stroke or 'regions' in stroke
        if self.live:
            ids = np.flatnonzero((flat>0) & self.allowed).astype(np.int32)
            if shaped:
                ids = ids[self._selection_contains(ids,stroke['clip'],stroke)]
            result = ids,flat[ids]
            self.brush_prefix = key, weights
            self.strokes[key] = result
            if len(self.strokes)>128:
                self.strokes.popitem(last=False)
            return result
        local = np.flatnonzero(flat>0)
        rows,cols = np.divmod(local,weights.shape[1])
        ids = (rows+row_origin)*width+cols+col_origin
        eligible = self.allowed[ids]
        if shaped:
            eligible &= self._selection_contains(ids,stroke['clip'],stroke)
        return ids[eligible].astype(np.int32),flat[local[eligible]]

    def _prepare_hit_bounds(self):
        triangles = self.target_triangles
        low,high = self.bounds = triangles.min(axis=1),triangles.max(axis=1)
        if len(triangles)<1024:
            return
        origin = low.min(axis=0)
        span = high.max(axis=0)-origin
        axes = np.argsort(span)[-2:]
        origin,span = origin[axes],span[axes]
        for bins in (64,32,16,8):
            factor = bins/np.maximum(span,1e-8)
            lo = np.clip(np.floor((low[:,axes]-origin)*factor).astype(int),0,bins-1)
            hi = np.clip(np.floor((high[:,axes]-origin)*factor).astype(int),0,bins-1)
            if (hi-lo+1).prod(axis=1).sum()<=8*len(triangles):
                faces,offsets = face_bin_index(lo,hi,bins)
                self.hit_index = axes,origin,factor,bins,faces,offsets
                break

    def _hit_candidates(self, low, high):
        axes,origin,factor,bins,faces,offsets = self.hit_index
        x0,y0 = np.clip(np.floor((low[axes]-origin)*factor).astype(int),0,bins-1)
        x1,y1 = np.clip(np.floor((high[axes]-origin)*factor).astype(int),0,bins-1)
        cells = [faces[offsets[row*bins+x0]:offsets[row*bins+x1+1]] for row in range(y0,y1+1)]
        # Stable face order preserves the original tie-break at coincident faces.
        return cells[0] if x0==x1 and y0==y1 else np.unique(np.concatenate(cells))

    def hit_face(self, point, normal, tolerance=.0005):
        triangles = self.target_triangles
        if self.bounds is None:
            self._prepare_hit_bounds()
        lo,hi = self.bounds
        low,high = point-tolerance,point+tolerance
        if self.hit_index is None:
            ids = np.flatnonzero(((lo<=high)&(hi>=low)).all(axis=1))
        else:
            ids = self._hit_candidates(low,high)
            ids = ids[((lo[ids]<=high)&(hi[ids]>=low)).all(axis=1)]
        if not len(ids):
            return None
        a,b,c = triangles[ids].transpose(1,0,2)
        x,y,p = b-a,c-a,point-a
        cross = np.cross(x,y)
        squared = np.einsum('ij,ij->i',cross,cross)
        valid = squared>1e-20
        denominator = np.where(valid,squared,1)
        u = np.einsum('ij,ij->i',np.cross(p,y),cross)/denominator
        v = np.einsum('ij,ij->i',np.cross(x,p),cross)/denominator
        distance = np.abs(np.einsum('ij,ij->i',p,cross))/np.sqrt(denominator)
        facing = self.normals[ids] @ normal
        valid &= (u>=-.01)&(v>=-.01)&(u+v<=1.01)&(distance<tolerance)&(facing>.6)
        if not valid.any():
            return None
        return ids[valid][np.argmin(distance[valid]+(1-facing[valid])*.0005)]

    def _region(self, stroke):
        point,normal = np.asarray(stroke['hit'],dtype=np.float32).reshape(2,3)
        face = self.hit_face(point,normal/np.linalg.norm(normal))
        if face is None or self.protected[face]:
            return np.empty(0,dtype=np.int32),np.empty(0,dtype=np.float32)
        region = stroke['region']
        owners = self.owner[self.ids]
        if region=='triangle':
            match = owners==face
        elif region=='polygon':
            match = (self.objects[owners]==self.objects[face])&(self.polygons[owners]==self.polygons[face])
        else:
            labels = face_components(self.edges_path,len(self.objects),region=='island')
            match = labels[owners]==labels[face]
        ids = self.ids[match].astype(np.int32)
        return ids,np.full(len(ids),stroke['opacity'],dtype=np.float32)

    def _brush_hits(self, stroke, stamps):
        reflection = np.array([-1,1,1],dtype=np.float32)
        tolerance = min(.02,stroke['radius']*.15)
        for stamp in stamps:
            pressure = stamp[6] if len(stamp)==7 else 1
            if pressure==0:
                continue
            point = np.asarray(stamp[:3],dtype=np.float32)
            normal = np.asarray(stamp[3:6],dtype=np.float32)
            normal /= np.linalg.norm(normal)
            hit = self.hit_face(point,normal)
            if hit is None:
                continue
            yield point,normal,hit,pressure
            if not stroke.get('mirrorX') or (abs(point[0])<.0005 and abs(normal[0])<.001):
                continue
            point,normal = point*reflection,normal*reflection
            hit = self.hit_face(point,normal,tolerance)
            if hit is None or (self.protected is not None and self.protected[hit]):
                continue
            a,b,c = self.target_triangles[hit]
            plane = np.cross(b-a,c-a)
            plane /= np.linalg.norm(plane)
            yield point-np.dot(point-a,plane)*plane,normal,hit,pressure

    def _stroke(self, stroke, key=None):
        if self.order is None:
            self.order = self.ids[np.argsort(self.xyz[self.ids,0])]
            self.x = self.xyz[self.order,0]
        stamps, weights = stroke['stamps'], {}
        if key is not None and self.brush_prefix is not None:
            previous, known_weights = self.brush_prefix
            count = len(previous[-1])
            if key[:-1]==previous[:-1] and key[-1][:count]==previous[-1]:
                stamps, weights = stamps[count:], known_weights.copy()
        radius = stroke['radius']
        for point,normal,hit,pressure in self._brush_hits(stroke,stamps):
            hit_object = self.objects[hit]
            lo,hi = np.searchsorted(self.x,[point[0]-radius,point[0]+radius])
            ids = self.order[lo:hi]
            offsets = self.xyz[ids]-point
            in_box = (np.abs(offsets[:,1:])<radius).all(axis=1)
            ids, offsets = ids[in_box], offsets[in_box]
            distance = np.linalg.norm(offsets,axis=1)/radius
            keep = (distance<1)&(np.abs(offsets @ normal)<radius*.43)
            ids, distance = ids[keep], distance[keep]
            face = self.owner[ids]
            keep = (self.normals[face] @ normal > .25)&(self.objects[face]==hit_object)
            alpha = np.clip((1-distance[keep])/max(.001,1-stroke['hardness']),0,1)*(stroke['opacity']*pressure)
            for i,a in zip(ids[keep],alpha):
                weights[i] = max(weights.get(i,0),a)
        if key is not None:
            self.brush_prefix = key,weights
        return np.fromiter(weights.keys(),dtype=np.int32), np.fromiter(weights.values(),dtype=np.float32)

    def paint(self, strokes, channels, color, sampler=None):
        affected = np.empty(0,dtype=np.int32)
        paint = {}
        batch = []
        for stroke in strokes:
            transform = stroke.get('transformUV')
            clear = stroke.get('clearUV')
            if transform is None and clear is None:
                batch.append(stroke)
                continue
            affected, paint = self._paint_strokes(batch, channels, color, affected, paint, sampler)
            if clear is not None:
                selected = self._selection_contains(affected,clear,stroke)
                keep = ~selected
                affected, paint = self._subset_paint(affected, paint, keep)
            else:
                affected, paint = self._transform_paint(affected, paint, transform)
            batch = []
        return self._paint_strokes(batch, channels, color, affected, paint, sampler)

    def _expand_paint(self, affected, paint, extra):
        if not len(affected):
            return extra, paint
        combined = np.union1d(affected, extra)
        if len(combined) == len(affected):
            return affected, paint
        indices = np.searchsorted(combined, affected)
        expanded = {}
        for name,(alpha,value) in paint.items():
            a = np.zeros(len(combined),dtype=np.float32)
            v = np.zeros((len(combined),value.shape[1]),dtype=np.float32)
            a[indices],v[indices] = alpha,value
            expanded[name] = a,v
        return combined, expanded

    def _paint_strokes(self, strokes, channels, color, affected, paint, sampler=None):
        # Each channel has its own stroke opacity and premultiplied value.
        if not strokes:
            return affected,paint
        samples = [(stroke,*(sampler or self.stroke)(stroke)) for stroke in strokes]
        extra = np.unique(np.concatenate([ids for _,ids,_ in samples]))
        affected,paint = self._expand_paint(affected,paint,extra)
        for stroke, ids, opacity in samples:
            if not len(ids):
                continue
            ids = np.searchsorted(affected,ids)
            for name, enabled in stroke['channels'].items():
                if not enabled or name not in channels:
                    continue
                count = 3 if name in RGB else 1
                if name not in paint:
                    paint[name] = (np.zeros(len(affected),dtype=np.float32),
                                   np.zeros((len(affected),count),dtype=np.float32))
                alpha, premult = paint[name]
                premult[ids] *= 1-opacity[:,None]
                alpha[ids] *= 1-opacity
                if not stroke['erase']:
                    value = channel_value(name,stroke['values'].get(name,DEFAULTS[name]),color)
                    premult[ids] += opacity[:,None]*value
                    alpha[ids] += opacity
        return affected,paint

    def _texel_uv(self, ids):
        height,width = self.uv_shape
        return (ids%width+.5)/width, 1-(ids//width+.5)/height

    @staticmethod
    def _inside_uv(x, y, rect):
        left,top,right,bottom = rect
        return (x>=left)&(x<right)&(y>=top)&(y<bottom)

    @staticmethod
    def _subset_paint(ids, paint, keep):
        return ids[keep],{name:(alpha[keep],value[keep]) for name,(alpha,value) in paint.items()}

    def _transform_paint(self, affected, paint, transform):
        if not len(affected) or not paint:
            return affected,paint
        height,width = self.uv_shape
        left,top,right,bottom = transform['rect']
        cx,cy = (left+right)/2,(top+bottom)/2
        sx,sy = transform['scale']
        dx,dy = transform['offset']
        angle = math.radians(transform['angle'])
        c,s = math.cos(angle),math.sin(angle)
        x, y = self._texel_uv(affected)
        inside = self._selection_contains(affected,transform['rect'],transform)
        ink = np.logical_or.reduce([alpha>0 for alpha,_ in paint.values()])
        selected = inside & ink
        if not np.any(selected):
            return affected,paint

        # Limit inverse sampling to the transformed bounds of the selected pixels.
        linear = transform.get('interpolation') == 'linear'
        pad = 1 if linear else .5
        ax,bx = x[selected].min()-pad/width,x[selected].max()+pad/width
        ay,by = y[selected].min()-pad/height,y[selected].max()+pad/height
        corners = [((u-cx)*sx*c-(v-cy)*sy*s+cx+dx,(u-cx)*sx*s+(v-cy)*sy*c+cy+dy)
                   for u in (ax,bx) for v in (ay,by)]
        cols,rows = zip(*corners)
        x0,x1 = max(0,math.floor(min(cols)*width)),min(width,math.ceil(max(cols)*width))
        y0,y1 = max(0,math.floor((1-max(rows))*height)),min(height,math.ceil((1-min(rows))*height))
        tiles = []
        for row in range(y0,y1,64):
            ids = (np.arange(row,min(row+64,y1))[:,None]*width+np.arange(x0,x1)).ravel()
            ids = ids[self.allowed[ids]]
            u,v = (ids%width+.5)/width-cx-dx,1-(ids//width+.5)/height-cy-dy
            src_x,src_y = (u*c+v*s)/sx+cx,(-u*s+v*c)/sy+cy
            if linear:
                present,incoming = self._sample_uv_paint(src_x,src_y,affected,selected,paint)
                if np.any(present):
                    tiles.append((ids[present],{name:(a[present],v[present]) for name,(a,v) in incoming.items()}))
            else:
                keep = (src_x>=left)&(src_x<right)&(src_y>=top)&(src_y<bottom)
                src = np.minimum(height-1,((1-src_y[keep])*height).astype(int))*width+(src_x[keep]*width).astype(int)
                index = np.minimum(len(affected)-1,np.searchsorted(affected,src))
                found = (affected[index]==src)&selected[index]
                if np.any(found):
                    lookup = index[found]
                    tiles.append((ids[keep][found],{name:(a[lookup],v[lookup]) for name,(a,v) in paint.items()}))
        dest = np.concatenate([ids for ids,_ in tiles]).astype(np.int32) if tiles else np.empty(0,dtype=np.int32)
        combined,paint = self._expand_paint(affected,paint,dest)
        removed = np.searchsorted(combined,affected[selected]) if not transform.get('copy') else []
        for name,(alpha,value) in paint.items():
            alpha[removed],value[removed] = 0,0
            for ids,tile in tiles:
                dst = np.searchsorted(combined,ids)
                incoming_alpha,incoming_value = tile[name]
                value[dst] = value[dst]*(1-incoming_alpha[:,None])+incoming_value
                alpha[dst] = alpha[dst]*(1-incoming_alpha)+incoming_alpha
        used = np.logical_or.reduce([alpha>0 for alpha,_ in paint.values()])
        return self._subset_paint(combined, paint, used)

    def _sample_uv_paint(self, u, v, affected, selected, paint):
        # Interpolate premultiplied material values against transparent pixels
        # beyond the selection, so rotations cannot pull colors across the cut.
        height,width = self.uv_shape
        x,y = u*width-.5,(1-v)*height-.5
        left,bottom = np.floor(x).astype(int),np.floor(y).astype(int)
        fx,fy = x-left,y-bottom
        samples = {name:(np.zeros(len(u),dtype=np.float32),
                         np.zeros((len(u),value.shape[1]),dtype=np.float32))
                   for name,(_,value) in paint.items()}
        present = np.zeros(len(u),dtype=bool)
        for col,wx in ((left,1-fx),(left+1,fx)):
            for row,wy in ((bottom,1-fy),(bottom+1,fy)):
                weight = wx*wy
                valid = np.flatnonzero((weight>1e-6)&(col>=0)&(col<width)&(row>=0)&(row<height))
                ids = row[valid]*width+col[valid]
                lookup = np.minimum(len(affected)-1,np.searchsorted(affected,ids))
                found = (affected[lookup]==ids)&selected[lookup]
                target,source = valid[found],lookup[found]
                contribution = weight[target].astype(np.float32)
                present[target] = True
                for name,(alpha,value) in paint.items():
                    a,premult = samples[name]
                    a[target] += alpha[source]*contribution
                    premult[target] += value[source]*contribution[:,None]
        return present,samples

    def mask(self, strokes, sampler=None):
        if not strokes:
            return None
        if any('region' in stroke for stroke in strokes):
            alpha = np.zeros(len(self.owner),dtype=np.float32)
            value = np.zeros_like(alpha)
            for stroke in strokes:
                ids,opacity = (sampler or self.stroke)(stroke)
                value[ids] = value[ids]*(1-opacity)+stroke['value']*opacity
                alpha[ids] = alpha[ids]*(1-opacity)+opacity
            affected = np.flatnonzero(alpha).astype(np.int32)
            return affected,alpha[affected],value[affected]
        samples = [(stroke,*(sampler or self.stroke)(stroke)) for stroke in strokes]
        affected = np.unique(np.concatenate([ids for _,ids,_ in samples]))
        alpha = np.zeros(len(affected),dtype=np.float32)
        value = np.zeros_like(alpha)
        for stroke, ids, opacity in samples:
            ids = np.searchsorted(affected,ids)
            value[ids] = value[ids]*(1-opacity)+stroke['value']*opacity
            alpha[ids] = alpha[ids]*(1-opacity)+opacity
        return affected,alpha,value
