"""Project high-poly GLB shading normals onto the registered low mesh's UV atlas."""
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from model_glb import Model, normalize
from model_surface import world_triangle_frames, xyz


@dataclass
class Bounds:
    low: np.ndarray
    high: np.ndarray
    children: tuple
    faces: np.ndarray | None


class HighSurface:
    def __init__(self, model):
        frames = []
        worlds = model.worlds()
        for primitive in model.primitives:
            frames.append(world_triangle_frames(primitive,worlds[primitive['node']]))
        if not frames:
            raise ValueError('高模中没有三角面')
        points = np.concatenate([part[0] for part in frames])
        self.shading = np.concatenate([part[2] for part in frames]).astype(np.float32)
        self.v0 = np.ascontiguousarray(points[:,0])
        self.e1 = points[:,1]-points[:,0]
        self.e2 = points[:,2]-points[:,0]
        lower,upper = points.min(axis=1),points.max(axis=1)
        centers = (lower+upper)*.5
        del points,frames
        def build(ids):
            low,high = lower[ids].min(axis=0),upper[ids].max(axis=0)
            if len(ids)<=8:
                return Bounds(low,high,(),ids)
            spread = np.ptp(centers[ids],axis=0)
            half = len(ids)//2
            order = np.argpartition(centers[ids,np.argmax(spread)],half)
            return Bounds(low,high,(build(ids[order[:half]]),build(ids[order[half:]])),None)
        self.root = build(np.arange(len(self.v0)))

    def project(self, origins, directions, distance):
        """First front-facing surface along each finite ray from outside the low mesh."""
        parallel = directions==0
        inverse = np.divide(1.,directions,out=np.zeros_like(directions),where=~parallel)
        best = np.full(len(origins),distance,dtype=float)
        faces = np.full(len(origins),-1,dtype=np.intp)
        normals = np.zeros_like(origins)
        stack = [(self.root,np.arange(len(origins)))]
        while stack:
            node,ids = stack.pop()
            origin,inv,flat = origins[ids],inverse[ids],parallel[ids]
            a,b = (node.low-origin)*inv,(node.high-origin)*inv
            entry = np.maximum(0,np.where(flat,-np.inf,np.minimum(a,b)).max(axis=1))
            exit_at = np.minimum(best[ids],np.where(flat,np.inf,np.maximum(a,b)).min(axis=1))
            covered = (entry<=exit_at)&~(flat&((origin<node.low)|(origin>node.high))).any(axis=1)
            ids = ids[covered]
            if not len(ids):
                continue
            if node.children:
                stack.extend((child,ids) for child in node.children)
                continue
            direction,origin = directions[ids],origins[ids]
            for face in node.faces:
                e1,e2 = self.e1[face],self.e2[face]
                h = np.cross(direction,e2)
                det = h @ e1
                # The interpolated authored normal determines facing, including mirrored nodes.
                usable = det!=0
                if not usable.any():
                    continue
                reciprocal = np.divide(1.,det,out=np.zeros_like(det),where=usable)
                s = origin-self.v0[face]
                u = np.einsum('ij,ij->i',s,h)*reciprocal
                q = np.cross(s,e1)
                v = np.einsum('ij,ij->i',direction,q)*reciprocal
                t = (q @ e2)*reciprocal
                take = usable&(u>=-1e-8)&(v>=-1e-8)&(u+v<=1+1e-8)&(t>=0)&(t<=best[ids])
                if not take.any():
                    continue
                n0,n1,n2 = self.shading[face]
                normal = n0+u[take,None]*(n1-n0)+v[take,None]*(n2-n0)
                front = np.einsum('ij,ij->i',normal,direction[take])<0
                chosen = ids[take][front]
                best[chosen] = t[take][front]
                normals[chosen] = normal[front]
                faces[chosen] = face
        return faces>=0, normalize(normals)


def authored_frames(model_file, steps, objects, polygons):
    """Align explicit glTF tangents to the low cache's node and polygon IDs."""
    model = Model(model_file)
    if not any('TANGENT' in primitive['attributes'] for mesh in model.scene['meshes'] for primitive in mesh['primitives']):
        return None
    if steps:
        model.edit(steps)
    worlds = model.worlds()
    frames = np.zeros((len(objects),3,4),dtype=np.float32)
    offsets = {}
    for part in model.primitives:
        node,indices = part['node'],part['indices']
        mesh,prim = map(int,part['key'].split(':'))
        attribute = model.scene['meshes'][mesh]['primitives'][prim]['attributes'].get('TANGENT')
        start = offsets.get(node,0)
        offsets[node] = start+len(indices)
        if attribute is None:
            continue
        ids = np.flatnonzero((objects==node)&(polygons>=start)&(polygons<offsets[node]))
        if not len(ids):
            continue
        tangents = model.accessor(attribute,'VEC4')
        if len(tangents)!=len(part['positions']) or not np.isin(tangents[:,3],[-1,1]).all():
            raise ValueError('低模 TANGENT 与顶点或手性不一致')
        linear = worlds[node][:3,:3]
        corners = indices[polygons[ids]-start]
        frames[ids,:,:3] = normalize(xyz(tangents[:,:3] @ linear.T))[corners]
        frames[ids,:,3] = tangents[corners,3]*np.sign(np.linalg.det(linear))
    return frames


def low_basis(triangles, corner_normals, atlas_uv, positions, frames=None):
    e1,e2 = triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0]
    cross = np.cross(e1,e2)
    area = np.einsum('ij,ij->i',cross,cross)
    delta = positions-triangles[:,0]
    u = np.einsum('ij,ij->i',np.cross(delta,e2),cross)/area
    v = np.einsum('ij,ij->i',np.cross(e1,delta),cross)/area
    n0,n1,n2 = corner_normals.transpose(1,0,2)
    normal = normalize(n0+u[:,None]*(n1-n0)+v[:,None]*(n2-n0))
    # GLB viewport textures use the original top-down V; atlas caches store bottom-up V.
    du1,dv1 = (atlas_uv[:,1]-atlas_uv[:,0]).T
    du2,dv2 = (atlas_uv[:,2]-atlas_uv[:,0]).T
    det = du2*dv1-du1*dv2
    tangent = (e2*dv1[:,None]-e1*dv2[:,None])*np.sign(det)[:,None]
    tangent = normalize(tangent-normal*np.einsum('ij,ij->i',normal,tangent)[:,None])
    raw_bitangent = (e2*du1[:,None]-e1*du2[:,None])*np.sign(det)[:,None]
    bitangent = np.cross(normal,tangent)
    handed = np.sign(np.einsum('ij,ij->i',bitangent,raw_bitangent))
    if frames is not None:
        explicit = frames[:,0,3]!=0
        d = frames[explicit,:,:3]
        interpolated = d[:,0]+u[explicit,None]*(d[:,1]-d[:,0])+v[explicit,None]*(d[:,2]-d[:,0])
        n = normal[explicit]
        tangent[explicit] = normalize(interpolated-n*np.einsum('ij,ij->i',n,interpolated)[:,None])
        bitangent[explicit] = np.cross(n,tangent[explicit])
        handed[explicit] = frames[explicit,0,3]
    return tangent,bitangent*handed[:,None],normal


def normal_map(surface, source, high_file, front, rear, out, steps=()):
    high = HighSurface(Model(high_file))
    with np.load(Path(source['bundle'])/'surfaces.npz') as cache:
        valid = cache['uv_valid'].astype(bool)
        shading,uv = cache['shading_normals'][valid],cache['uv'][valid]
        frames = (authored_frames(source['reviewSource'],steps,cache['object_ids'][valid],cache['polygon_ids'][valid])
                  if source.get('format')=='glb' else None)
    pixels = np.empty((*surface.uv_shape,3),dtype=np.uint8)
    pixels[:] = [128,128,255]
    canvas = pixels.reshape(-1,3)
    hits = 0
    for start in range(0,len(surface.ids),16384):
        ids = surface.ids[start:start+16384]
        owner = surface.owner[ids]
        xyz = surface.xyz[ids].astype(float)
        tangent,bitangent,normal = low_basis(surface.target_triangles[owner].astype(float),shading[owner],uv[owner],xyz,
                                              frames[owner] if frames is not None else None)
        found,detail = high.project(xyz+normal*front,-normal,front+rear)
        if found.any():
            projected = np.stack([np.einsum('ij,ij->i',detail[found],axis[found]) for axis in (tangent,bitangent,normal)],axis=-1)
            canvas[ids[found]] = np.rint(np.clip(normalize(projected)*.5+.5,0,1)*255).astype(np.uint8)
            hits += int(found.sum())
    if not hits:
        raise ValueError('没有命中高模，请检查两个模型的坐标与投射距离')
    Image.fromarray(pixels[::-1]).save(out)
    return dict(hits=hits,valid=len(surface.ids))
