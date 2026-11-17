"""Model-space fill projection. UV masks and document overlays are composed by the caller."""
from pathlib import Path

import numpy as np

from model_glb import Model, normalize
from paint_channels import RGB


def native_face_uv(surface, source):
    # Earlier native surface caches kept triangle IDs. UVs are immutable in modeling edits.
    if source.get('format') != 'glb' or source.get('preservedSurface'):
        raise ValueError('此旧表面缓存缺少法线投影所需的 UV 切线数据，请以原生 GLB 重新登记模型')
    model = Model(source['reviewSource'])
    parts = {}
    for part in model.primitives:
        parts.setdefault(part['node'], []).append(part)
    result = np.zeros((len(surface.objects),3,2),np.float32)
    for node in np.unique(surface.objects):
        faces = np.flatnonzero(surface.objects==node)
        offset = 0
        for part in parts[node]:
            stop = offset+len(part['indices'])
            selected = faces[(surface.polygons[faces]>=offset)&(surface.polygons[faces]<stop)]
            if len(selected):
                coords = part['uv'][part['indices'][surface.polygons[selected]-offset]]
                result[selected] = coords*[1,-1]+[0,1]
            offset = stop
    return result


def projection_geometry(surface, source, normals_needed):
    cached = getattr(surface,'fill_projection_geometry',None)
    if cached is not None and (not normals_needed or cached[2] is not None):
        return cached
    with np.load(Path(source['bundle'])/'surfaces.npz') as data:
        valid = data['uv_valid']
        shading = data['shading_normals'][valid].astype(np.float32)
        uv = (data['uv'][valid] if 'uv' in data else native_face_uv(surface,source)) if normals_needed else None
    edges = surface.target_triangles[:,1:]-surface.target_triangles[:,:1]
    face = np.cross(edges[:,0],edges[:,1])
    dual = face / np.maximum(np.sum(face*face,axis=1,keepdims=True),1e-30)
    gradients = np.stack((np.cross(edges[:,1],dual),np.cross(dual,edges[:,0])),axis=1)
    tangent = handed = None
    if normals_needed:
        du,dv = (uv[:,1:]-uv[:,:1]).transpose(2,0,1)
        det = du[:,0]*dv[:,1]-du[:,1]*dv[:,0]
        tangent = normalize((edges[:,0]*dv[:,1,None]-edges[:,1]*dv[:,0,None])*np.sign(det[:,None]))
        handed = np.where(np.sum(face*surface.normals,axis=1)*det<0,-1.,1.).astype(np.float32)
    surface.fill_projection_geometry = shading,gradients,tangent,handed
    return surface.fill_projection_geometry


def rotation_basis(degrees):
    sx,sy,sz = np.sin(np.radians(degrees))
    cx,cy,cz = np.cos(np.radians(degrees))
    return np.array([[cz*cy,cz*sy*sx-sz*cx,cz*sy*cx+sz*sx],
                     [sz*cy,sz*sy*sx+cz*cx,sz*sy*cx-cz*sx],[-sy,cy*sx,cy*cx]],np.float32)


def projected_channels(surface, geometry, ids, settings, channels, read_plane):
    """Evaluate only contributing axes on this tile; mix light in linear space."""
    shading,gradients,tangents,handed = geometry
    faces = surface.owner[ids]
    points = surface.xyz[ids]
    delta = points-surface.target_triangles[faces,0]
    bary_b,bary_c = np.einsum('nji,ni->jn',gradients[faces],delta)
    corners = shading[faces]
    normal = normalize(corners[:,0]*(1-bary_b-bary_c)[:,None]+corners[:,1]*bary_b[:,None]+corners[:,2]*bary_c[:,None])
    basis = rotation_basis(settings['rotation'])
    coords = ((points-(surface.high+surface.low)*.5) @ basis)/(max(np.max(surface.high-surface.low),1e-12)*settings['scale'])
    n = normal @ basis
    weights = np.abs(n)
    if settings['blend']==0:
        weights = np.eye(3,dtype=np.float32)[np.argmax(weights,axis=1)]
    else:
        weights /= np.maximum(weights.max(axis=1,keepdims=True),1e-12)
        # An oblique plane compresses the pattern along one direction. Fade
        # projections with less than 2/3 of the best projected area, reaching
        # zero at 1/3. Equally facing axes retain the user's full blend.
        confidence = np.clip(3*weights-1,0,1)
        weights **= 1/settings['blend']
        weights *= confidence*confidence*(3-2*confidence)
        weights /= np.maximum(weights.sum(axis=1,keepdims=True),1e-12)
    if 'normal' in channels:
        t = tangents[faces]
        t = normalize(t-normal*np.sum(t*normal,axis=1,keepdims=True)) @ basis
        bitangent = np.cross(n,t)*handed[faces,None]
    values = {key:np.zeros((len(ids),3) if key in RGB else len(ids),np.float32) for key in channels}
    alphas = {}
    for axis in range(3):
        indices = np.flatnonzero(weights[:,axis]>0)
        if not len(indices):
            continue
        a,b = (axis+1)%3,(axis+2)%3
        sign = np.where(n[indices,axis]<0,-1.,1.)
        u = .5+sign*coords[indices,a]
        v = .5+coords[indices,b].astype(np.float64)
        samples = read_plane(indices,u,v)
        weight = weights[indices,axis]
        for key,field in samples.items():
            strength = weight
            if isinstance(field,tuple):
                field,alpha = field
                strength = weight*alpha
                if key not in alphas:
                    alphas[key] = np.zeros(len(ids),np.float32)
                alphas[key][indices] += strength
            field = field.astype(np.float32,copy=False)
            if key=='normal':
                # Plane slopes expressed in the original UV tangent basis. A flat
                # tangent normal stays flat even on angled or mirrored UV islands.
                x,y,z = (field*2-1).T
                x = x*sign
                field = np.column_stack((x*t[indices,a]+y*t[indices,b],
                                         x*bitangent[indices,a]+y*bitangent[indices,b],z))
            values[key][indices] += field*(strength[:,None] if key in RGB else strength)
    for key,alpha in alphas.items():
        divisor = alpha[:,None] if key in RGB else alpha
        np.divide(values[key],divisor,out=values[key],where=divisor>0)
    if 'normal' in channels:
        values['normal'] = normalize(values['normal'])*.5+.5
    return values,alphas


def extend_uv_gutter(owner, allowed, protected, conflict, shape, radius, *buffers):
    """Extend finished texels into unowned UV space for texture filtering.

    Copy a single donor, including its encoded tangent normal; blending donors
    from different UV islands could cancel the tangent-space slope.
    """
    height,width = shape
    empty = ((owner < 0) & ~protected & ~conflict).reshape(shape)
    near = np.zeros(shape,bool)
    near[1:] |= empty[:-1]
    near[:-1] |= empty[1:]
    near[:,1:] |= empty[:,:-1]
    near[:,:-1] |= empty[:,1:]
    frontier = np.flatnonzero(near.ravel() & allowed)
    available = empty.ravel()
    for _ in range(radius):
        if not len(frontier):
            break
        y,x = np.divmod(frontier,width)
        outer = []
        for dy,dx in ((0,1),(0,-1),(1,0),(-1,0),(1,1),(1,-1),(-1,1),(-1,-1)):
            inside = (x+dx>=0)&(x+dx<width)&(y+dy>=0)&(y+dy<height)
            donor = frontier[inside]
            dest = donor+dy*width+dx
            keep = available[dest]
            donor,dest = donor[keep],dest[keep]
            available[dest] = False
            for pixels in buffers:
                pixels[dest] = pixels[donor]
            outer.append(dest)
        frontier = np.concatenate(outer)
