"""Blender-only geometry stage. Runs in a disposable background process."""
import bpy
import bmesh
import hashlib
import json
import re
import struct
import sys
import time
from pathlib import Path
import numpy as np
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
from view_select import choose
from projection_scope import is_protected
from uv_raster import pixel_bounds,sample_coordinates

OUT = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
cfg = json.loads((OUT/'resolved_config.json').read_text(encoding='utf-8'))
meta = json.loads(Path(cfg['camera_file']).read_text(encoding='utf-8'))
names = list(cfg['designs'])
views = [meta['views'][n] for n in names]
center = Vector(meta['center'])
RES = cfg['resolution']
start = time.time()
model = Path(cfg['model'])
if model.suffix.lower() == '.obj':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.obj_import(filepath=str(model))
elif model.suffix.lower() == '.blend':
    bpy.ops.wm.open_mainfile(filepath=str(model), load_ui=False)
else:
    raise RuntimeError('Supported model formats: .obj and .blend')
scene = bpy.context.scene

def uv_digest(objects):
    h = hashlib.sha256()
    for obj in sorted(objects, key=lambda x: x.name):
        h.update(obj.name.encode('utf-8'))
        for layer in obj.data.uv_layers:
            h.update(layer.name.encode('utf-8'))
            for loop in layer.data:
                h.update(struct.pack('<ff', *loop.uv))
    return h.hexdigest()

all_meshes = [o for o in scene.objects if o.type == 'MESH']
include = cfg.get('include_objects')
if include:
    absent = sorted(set(include) - {o.name for o in all_meshes})
    if absent: raise RuntimeError('Missing selected objects: ' + ', '.join(absent))
objects = [o for o in all_meshes if (not include or o.name in include) and not any(x in o.name for x in cfg['exclude_contains'])]
if not objects: raise RuntimeError('No mesh objects selected')
# Excluded objects do not occlude, as in the documented experiment. This is a
# disposable background scene; the input file and current Blender are untouched.
for obj in all_meshes:
    if obj not in objects: bpy.data.objects.remove(obj, do_unlink=True)
uv_before = uv_digest(objects)
faces = []
materials = []
mat_ids = {}
excluded_uv_faces = 0
for oi, obj in enumerate(objects):
    mesh = obj.data
    layer = mesh.uv_layers.active if cfg['uv_layer'] == 'active' else mesh.uv_layers.get(cfg['uv_layer'])
    if layer is None: raise RuntimeError('Object %s has no requested UV layer' % obj.name)
    flip = False
    if cfg['normal_policy'] == 'signed_volume':
        bm = bmesh.new(); bm.from_mesh(mesh)
        try: flip = bm.calc_volume(signed=True) < 0
        finally: bm.free()
    mesh.calc_loop_triangles()
    transform = obj.matrix_world
    normal_transform = transform.to_3x3().inverted().transposed()
    for tri in mesh.loop_triangles:
        uv = np.array([tuple(layer.data[li].uv) for li in tri.loops], dtype=np.float32)
        if not np.isfinite(uv).all() or (uv < 0).any() or (uv > 1).any():
            excluded_uv_faces += 1
            continue
        poly = mesh.polygons[tri.polygon_index]
        mat = obj.material_slots[poly.material_index].material if poly.material_index < len(obj.material_slots) else None
        mn = mat.name if mat else '(none)'
        if mn not in mat_ids:
            mat_ids[mn] = len(materials); materials.append(mn)
        pts = np.array([tuple(transform @ mesh.vertices[vi].co) for vi in tri.vertices], dtype=np.float32)
        normal = (normal_transform @ poly.normal).normalized()
        if flip: normal = -normal
        faces.append((oi, obj, tri.polygon_index, pts, uv, normal, mat_ids[mn]))
if not faces: raise RuntimeError('No valid UV triangles in the 0–1 tile')
print('objects=%d faces=%d out_of_tile_triangles=%d' % (len(objects), len(faces), excluded_uv_faces), flush=True)

# Same-object, geometrically coincident edges only. Never join separate objects.
edge_map = {}
for fi, (oi, obj, pi, pts, uv, norm, mi) in enumerate(faces):
    for a,b in ((0,1),(1,2),(2,0)):
        pa = tuple(np.rint(pts[a].astype(np.float64)*100000).astype(np.int64))
        pb = tuple(np.rint(pts[b].astype(np.float64)*100000).astype(np.int64))
        if pa == pb: continue
        if pa > pb: pa,pb,a,b = pb,pa,b,a
        edge_map.setdefault((oi,pa,pb), []).append((fi, uv[a].copy(), uv[b].copy(), pts[a].copy(), pts[b].copy()))
neighbors = [[] for _ in faces]
pairs = []
nonmanifold = 0
for group in edge_map.values():
    if len(group) != 2:
        if len(group) > 2: nonmanifold += 1
        continue
    a,b = group
    if a[0] == b[0]: continue
    # Avoid joining back-to-back coincident surfaces.
    if faces[a[0]][5].dot(faces[b[0]][5]) < 0: continue
    neighbors[a[0]].append(b[0]); neighbors[b[0]].append(a[0])
    is_seam = faces[a[0]][6] != faces[b[0]][6] or not (np.allclose(a[1],b[1],atol=1e-5) and np.allclose(a[2],b[2],atol=1e-5))
    pairs.append((a,b,is_seam))
del edge_map
print('adjacent_edges=%d nonmanifold_skipped=%d' % (len(pairs),nonmanifold),flush=True)

dg = bpy.context.evaluated_depsgraph_get()
N = len(faces); V = len(names)
projection_excluded=np.zeros(N,dtype=np.uint8)
excluded_names=set(cfg.get('projection_exclude_objects',[]))
excluded_materials=set(cfg.get('projection_exclude_materials',[]))
if excluded_materials-set(materials):raise RuntimeError('Projection exclusion references missing material(s): '+', '.join(sorted(excluded_materials-set(materials))))
region_names={name for r in cfg.get('projection_exclude_regions',[]) for name in r.get('objects',[])}
absent=(excluded_names|region_names)-{o.name for o in objects}
if absent:raise RuntimeError('Projection exclusion references missing object(s): '+', '.join(sorted(absent)))
for fi,(_,obj,poly,pts,uv,norm,mi) in enumerate(faces):
    projection_excluded[fi]=(materials[mi] in excluded_materials) or is_protected(obj.name,pts,excluded_names,cfg.get('projection_exclude_regions',[]))
scores = np.zeros((N,V),dtype=np.float32)
candidates = np.zeros((N,V),dtype=np.uint8)
partial = np.zeros((N,V),dtype=np.uint8)
dirs = [Vector(v['dir']).normalized() for v in views]
EPS = float(cfg.get('ray_epsilon', 1e-4))
def visible(p, obj, poly, d):
    hit = scene.ray_cast(dg, Vector(p) + d*EPS, d)
    return not hit[0] or (hit[4] == obj and hit[3] == poly)
for fi,(oi,obj,poly,pts,uv,norm,mi) in enumerate(faces):
    if projection_excluded[fi]:continue
    c = pts.mean(axis=0)
    for vi,d in enumerate(dirs):
        score = norm.dot(d)
        if score <= 1e-6 or score < cfg.get('min_projection_cos',0): continue
        dv = Vector(c)-center; view=views[vi]
        u = dv.dot(Vector(view['right']))/view['span']+.5
        v = dv.dot(Vector(view['up']))/view['span']+.5
        if not (0 <= u <= 1 and 0 <= v <= 1): continue
        if not visible(c,obj,poly,d): continue
        scores[fi,vi] = score; candidates[fi,vi] = 1
        # Three inset corner samples expose partial-occlusion uncertainty.
        for k in range(3):
            sample = 0.8*pts[k] + 0.1*pts[(k+1)%3] + 0.1*pts[(k+2)%3]
            if not visible(sample,obj,poly,d): partial[fi,vi] = 1; break
    if fi and fi % 25000 == 0: print('visibility %d/%d' % (fi,N),flush=True)
choice = choose(scores,candidates,neighbors,cfg['mode'],cfg['angle_margin'])
print('visible=%d/%d mode=%s' % ((choice>=0).sum(),N,cfg['mode']),flush=True)

data_dir = OUT/'mapping'; data_dir.mkdir()
np.savez_compressed(data_dir/'faces.npz', candidates=candidates, partial=partial, scores=scores, choice=choice, projection_excluded=projection_excluded,
                    centers=np.array([f[3].mean(axis=0) for f in faces],dtype=np.float32),
                    mat=np.array([f[6] for f in faces],dtype=np.int16))
np.savez_compressed(data_dir/'edges.npz', faces=np.array([[a[0],b[0]] for a,b,s in pairs],dtype=np.int32).reshape(-1,2),
                    xyz=np.array([[a[3],a[4]] for a,b,s in pairs],dtype=np.float32).reshape(-1,2,3),
                    uv=np.array([[a[1],a[2],b[1],b[2]] for a,b,s in pairs],dtype=np.float32).reshape(-1,4,2),
                    seam=np.array([s for a,b,s in pairs],dtype=np.uint8))
safe_names = {}
selected_materials = cfg.get('mapping_materials')
if selected_materials is not None and (not selected_materials or set(selected_materials)-set(materials)):
    raise RuntimeError('Requested mapping material is absent')
for mi,material in enumerate(materials):
    if selected_materials is not None and material not in selected_materials:
        continue
    safe = '%02d_' % mi + (re.sub(r'[^A-Za-z0-9_\-]', '_',material) or 'none')
    safe_names[material] = safe
    owner = np.full((RES,RES),-1,dtype=np.int32)
    xyz = np.zeros((RES,RES,3),dtype=np.float32)
    collision = np.zeros((RES,RES),dtype=np.uint8)
    protected = np.zeros((RES,RES),dtype=np.uint8)
    # Optional policy preserves structural overlap diagnostics while selecting
    # the only face-center-visible candidate if it is unambiguous and certain.
    recover = cfg['overlap_policy'] == 'unique_visible'
    if recover:
        visible_owner=np.full((RES,RES),-1,dtype=np.int32)
        visible_xyz=np.zeros((RES,RES,3),dtype=np.float32)
        visible_conflict=np.zeros((RES,RES),dtype=np.uint8)
        visible_uncertain=np.zeros((RES,RES),dtype=np.uint8)
    for fi in (i for i,f in enumerate(faces) if f[6] == mi):
        pts,uv = faces[fi][3],faces[fi][4]
        lo,hi=pixel_bounds(uv,RES)
        if np.any(hi < lo): continue
        den=(uv[1,1]-uv[2,1])*(uv[0,0]-uv[2,0])+(uv[2,0]-uv[1,0])*(uv[0,1]-uv[2,1])
        if abs(den)<1e-12: continue
        xx,yy=np.meshgrid(np.arange(lo[0],hi[0]+1),np.arange(lo[1],hi[1]+1))
        x,y=sample_coordinates(xx,yy,RES)
        a=((uv[1,1]-uv[2,1])*(x-uv[2,0])+(uv[2,0]-uv[1,0])*(y-uv[2,1]))/den
        b=((uv[2,1]-uv[0,1])*(x-uv[2,0])+(uv[0,0]-uv[2,0])*(y-uv[2,1]))/den
        c=1-a-b; inside=(a>=-1e-6)&(b>=-1e-6)&(c>=-1e-6)
        if not inside.any(): continue
        xx=xx[inside]; yy=yy[inside]; p=a[inside,None]*pts[0]+b[inside,None]*pts[1]+c[inside,None]*pts[2]
        if projection_excluded[fi]:protected[yy,xx]=1
        existing=owner[yy,xx]; occupied=existing>=0
        different=occupied & (np.linalg.norm(xyz[yy,xx]-p,axis=1)>1e-4)
        collision[yy[different],xx[different]]=1
        fresh=~occupied
        owner[yy[fresh],xx[fresh]]=fi; xyz[yy[fresh],xx[fresh]]=p[fresh]
        if recover and choice[fi]>=0:
            previous=visible_owner[yy,xx]; had_visible=previous>=0
            disagree=had_visible & (np.linalg.norm(visible_xyz[yy,xx]-p,axis=1)>1e-4)
            visible_conflict[yy[disagree],xx[disagree]]=1
            if partial[fi,choice[fi]]: visible_uncertain[yy,xx]=1
            first=~had_visible
            visible_owner[yy[first],xx[first]]=fi; visible_xyz[yy[first],xx[first]]=p[first]
    if recover:
        # Keep every non-overlap texel bit-identical to the strict baseline.
        valid_visible=(visible_owner>=0)&(collision>0)
        owner[valid_visible]=visible_owner[valid_visible]; xyz[valid_visible]=visible_xyz[valid_visible]
        np.savez_compressed(data_dir/(safe+'.npz'), owner=owner, xyz=xyz, collision=collision, protected=protected,
                            visible_conflict=visible_conflict, visible_uncertain=visible_uncertain)
    else:
        np.savez_compressed(data_dir/(safe+'.npz'), owner=owner, xyz=xyz, collision=collision, protected=protected)
    print('raster',material,'occupied',int((owner>=0).sum()),'overlap',int(collision.sum()),flush=True)

uv_after=uv_digest(objects)
if uv_before != uv_after: raise RuntimeError('UV changed during geometry stage')
report={'blender':bpy.app.version_string,'objects':len(objects),'triangles':N,'out_of_tile_triangles':excluded_uv_faces,
        'min_projection_cos':cfg.get('min_projection_cos',0),'projection_excluded_faces':int(projection_excluded.sum()),
        'projection_excluded_selected_faces':int(((projection_excluded>0)&(choice>=0)).sum()),
        'normal_policy':cfg['normal_policy'],'overlap_policy':cfg['overlap_policy'],'uv_before_sha256':uv_before,'uv_after_sha256':uv_after,
        'uv_unchanged':True,'materials':[{'name':n,'file':s} for n,s in safe_names.items()],
        'view_names':names,'adjacent_edges':len(pairs),'uv_seam_edges':sum(int(x[2]) for x in pairs),
        'nonmanifold_edges_skipped':nonmanifold,'visible_faces':int((choice>=0).sum()),
        'partial_occlusion_candidate_faces':int(partial.any(axis=1).sum()),'seconds':round(time.time()-start,2)}
(OUT/'geometry_report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
print('geometry complete',flush=True)
