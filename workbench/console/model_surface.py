"""Register a GLB and rebuild UV, visibility, and guide caches without Blender."""
import json
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

from model_glb import Model, checksum, normalize
from glb_texture_maps import extract_texture_maps
from native_worker_lock import cache_lock, watch_parent
from paint_surface import projector_visibility

sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'tools'))
from guide_raster import raster
from projection_scope import is_protected
from uv_raster import pixel_bounds, sample_coordinates
from view_select import choose


def read(path):
    return json.loads(Path(path).read_bytes())


def save(path, value):
    Path(path).write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')


def stage(label):
    print('ARACHNE_MODEL_STAGE '+json.dumps({'stage':label},ensure_ascii=False),flush=True)


def xyz(points):
    # The paint tools use X-right, Y-back, Z-up world coordinates.
    return points[..., [0,2,1]] * [1,-1,1]


def surface(model):
    points, shading, normals, uv, objects, polygons, materials = [],[],[],[],[],[],[]
    worlds = model.worlds()
    counts = {}
    for primitive in model.primitives:
        key, indices = primitive['node'], primitive['indices']
        world = worlds[key]
        vertices = primitive['positions'] @ world[:3,:3].T + world[:3,3]
        triangles = xyz(vertices[indices])
        normal = normalize(np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0]))
        if np.linalg.det(world[:3,:3]) < 0:
            normal = -normal
        attribute = primitive['normals']
        shade = (np.repeat(normal[:,None,:],3,axis=1) if attribute is None else
                 normalize(xyz(attribute @ np.linalg.inv(world[:3,:3])))[indices])
        coords = primitive['uv']
        coords = (np.full((len(indices),3,2),-1.) if coords is None else
                  coords[indices].astype(float)*[1,-1]+[0,1])
        offset = counts.get(key,0)
        counts[key] = offset+len(indices)
        points.append(triangles)
        shading.append(shade)
        normals.append(normal)
        uv.append(coords)
        objects.extend([key]*len(indices))
        polygons.extend(range(offset,offset+len(indices)))
        materials.extend([primitive['label']]*len(indices))
    return (*[np.concatenate(values) for values in (points,shading,normals,uv)],
            np.asarray(objects,dtype=np.int32),np.asarray(polygons,dtype=np.int32),np.asarray(materials))


def register(config):
    incoming,out = Path(config['input']),Path(config['out'])
    model = Model(incoming,registration=True)
    points,_,normals,uv,_,_,labels = surface(model)
    valid = ((uv>=0)&(uv<=1)).all(axis=(1,2)) & (np.linalg.norm(normals,axis=1)>.5)
    sides = uv[:,1:] - uv[:,:1]
    valid &= np.abs(sides[:,0,0]*sides[:,1,1]-sides[:,0,1]*sides[:,1,0])>1e-12
    eligible = list(dict.fromkeys(labels[valid].tolist()))
    if not eligible:
        raise ValueError('请选择至少有一个材质使用有效 TEXCOORD_0 且 UV 位于 0–1 内的 GLB')
    chosen = config.get('material')
    if chosen is None:
        material = eligible[0]
    else:
        material_index = model.default_material_index if chosen == 'default' else chosen
        materials = model.scene['materials']
        if type(material_index) is not int or not 0 <= material_index < len(materials):
            raise ValueError('所选 GLB 材质不存在')
        material = materials[material_index]['name']
        if material not in eligible:
            raise ValueError('所选材质没有有效 TEXCOORD_0 或 UV 超出 0–1')
    selected = next(p['material'] for p in model.primitives if p['label']==material)
    props = selected.get('pbrMetallicRoughness',{})
    factor = np.clip(np.asarray(props.get('baseColorFactor',[1,1,1,1]),dtype=float),0,1)
    rgb = np.where(factor[:3]<=.0031308,factor[:3]*12.92,1.055*factor[:3]**(1/2.4)-.055)
    color = '#'+''.join(f'{int(v):02x}' for v in np.rint(rgb*255))
    base = dict(color=color,metallic=float(props.get('metallicFactor',1)),roughness=float(props.get('roughnessFactor',1)))
    if not np.isfinite(list(base.values())[1:]).all() or any(not 0<=v<=1 for v in (base['metallic'],base['roughness'])):
        raise ValueError('GLB 基础材质参数无效')
    if factor[3]<1 and selected.get('alphaMode','OPAQUE')!='OPAQUE':
        base['alpha'] = float(factor[3])
    original = out/'model.glb'
    model.save(original)
    digest = checksum(original)
    uv_digest = model.uv_digest()
    texture_output = Path(config['textureOutput']) if config.get('textureOutput') else None
    maps = extract_texture_maps(model, selected, texture_output) if texture_output else []
    save(out/'metadata.json',dict(source_sha256=digest,input_sha256=checksum(incoming),
         uv_before=uv_digest,uv_after=uv_digest,uv_unchanged=True,
         mesh_count=len(model.primitives),vertex_count=sum(len(p['positions']) for p in model.primitives),
         material=material,base=base,**({'importedMaps':maps} if maps else {})))
    save(out/'topology.json',dict(modelSha256=digest,primitives=model.topology()))
    if 'color' in maps:
        with Image.open(texture_output/'color.png') as image:
            image.resize((4096,4096),Image.Resampling.BILINEAR).save(out/'base.png',compress_level=3)
    else:
        Image.new('RGB',(4096,4096),color).save(out/'base.png')
    minimum,maximum = points.min(axis=(0,1)),points.max(axis=(0,1))
    center = (minimum+maximum)/2
    span = max(.001,np.linalg.norm(maximum-minimum)*1.12)
    cameras = dict(center=center.tolist(),views={'top':dict(right=[1,0,0],up=[0,1,0],dir=[0,0,1],
        span=span,cam_loc=(center+[0,0,span*2]).tolist())})
    settings = dict(designs={'top':dict(flip_u=False,flip_v=False)},mode='baseline',angle_margin=.08,
                    min_projection_cos=.2,grazing_cos=.2,projection_exclude_objects=[],
                    projection_exclude_regions=[],projection_exclude_materials=[],guide=dict(facing_power=3))
    save(out/'registration.json',dict(cameras=cameras,settings=settings))


def adjacency(points, uv, normals, objects, labels):
    edges = {}
    quantized = np.rint(points*100000).astype(np.int64)
    for face,triangle in enumerate(quantized):
        for a,b in ((0,1),(1,2),(2,0)):
            left,right = tuple(triangle[a]),tuple(triangle[b])
            if left == right:
                continue
            if left>right:
                left,right,a,b = right,left,b,a
            edges.setdefault((objects[face],left,right),[]).append((face,a,b))
    neighbors = [[] for _ in points]
    pairs,seams = [],[]
    for group in edges.values():
        if len(group)!=2:
            continue
        (a,al,ar),(b,bl,br) = group
        if a==b or normals[a] @ normals[b]<0:
            continue
        pairs.append([a,b])
        seams.append(labels[a]!=labels[b] or not np.allclose(uv[a,[al,ar]],uv[b,[bl,br]],atol=1e-5))
        neighbors[a].append(b)
        neighbors[b].append(a)
    return neighbors,np.asarray(pairs,dtype=np.int32).reshape(-1,2),np.asarray(seams,dtype=np.uint8)


def map_material(file, points, uv, protected_faces, selection, baseline):
    res = 4096
    owner = np.full((res,res),-1,dtype=np.int32)
    xyz_map = np.zeros((res,res,3),dtype=np.float32)
    protected = np.zeros((res,res),dtype=np.uint8)
    collision = np.zeros_like(protected)
    for face in selection:
        a,b,c = uv[face]
        low,high = pixel_bounds(uv[face],res)
        den = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
        if abs(den)<1e-12:
            continue
        for row in range(low[1],high[1]+1,64):
            xx,yy = np.meshgrid(np.arange(low[0],high[0]+1),np.arange(row,min(row+64,high[1]+1)))
            x,y = sample_coordinates(xx,yy,res)
            wa = ((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den
            wb = ((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den
            wc = 1-wa-wb
            inside = (wa>=-1e-6)&(wb>=-1e-6)&(wc>=-1e-6)
            x,y = xx[inside],yy[inside]
            position = np.column_stack((wa[inside],wb[inside],wc[inside])) @ points[face]
            if protected_faces[face]:
                protected[y,x] = 1
            fresh = owner[y,x]<0
            disagree = ~fresh & (np.linalg.norm(xyz_map[y,x]-position,axis=1)>1e-4)
            collision[y[disagree],x[disagree]] = 1
            owner[y[fresh],x[fresh]] = face
            xyz_map[y[fresh],x[fresh]] = position[fresh]
    if baseline is not None:
        with np.load(baseline) as original:
            np.maximum(protected,original['protected'],out=protected)
            np.maximum(collision,original['collision'],out=collision)
    if not (owner>=0).any():
        raise ValueError('目标材质没有可烘焙的 UV 像素')
    np.savez_compressed(file,owner=owner,xyz=xyz_map,collision=collision,protected=protected)


def build(config, out, model):
    source = config['source']
    native = source.get('format')=='glb'
    edited = bool(config['modeling'])
    registered = read(Path(source['reviewSource']).parent/'registration.json') if native else None
    if native:
        cameras,settings = registered['cameras'],registered['settings']
        uv_digest = model.uv_digest()
        if uv_digest!=source['uvSha256']:
            raise ValueError('GLB UV 指纹与登记记录不一致')
    else:
        cameras = read(Path(source['bundle'])/'cameras.json')
        settings = read(Path(source['cacheRun'])/'resolved_config.json')
        uv_digest = read(Path(source['cacheRun'])/'geometry_report.json')['uv_before_sha256']
    baseline = None
    if edited:
        base = Path(source['cacheRun'])
        record = read(base/'geometry_report.json')
        stem = next(m['file'] for m in record['materials'] if m['name']==source['material'])
        baseline = base/'mapping'/f'{stem}.npz'
        model.edit(config['modeling']['steps'])
    points, shading, normals, uv, objects, polygons, labels = surface(model)
    included = settings.get('registered_objects')
    if included is not None:
        selected = {key for key,node in model.nodes.items() if node['name'] in included}
        keep = np.isin(objects,list(selected))
        points,shading,normals,uv,objects,polygons,labels = (value[keep] for value in
             (points,shading,normals,uv,objects,polygons,labels))
    valid = ((uv>=0)&(uv<=1)).all(axis=(1,2))
    protected = np.array([label in settings.get('projection_exclude_materials',[]) or
        is_protected(model.nodes[key]['name'],triangle,settings.get('projection_exclude_objects',[]),
                     settings.get('projection_exclude_regions',[]))
        for key,label,triangle in zip(objects,labels,points)],dtype=bool)
    cache, guides = out/'cache',out/'guides'
    mapping = cache/'mapping'
    mapping.mkdir(parents=True)
    guides.mkdir()
    save(cache/'resolved_config.json',settings)
    save(guides/'cameras.json',cameras)
    np.savez_compressed(guides/'surfaces.npz',positions=points,shading_normals=shading,
        polygon_normals=normals,object_ids=objects,polygon_ids=polygons,protected=protected,uv_valid=valid)
    geometry, norm, tex, ids, names, excludes = (v[valid] for v in (points,normals,uv,objects,labels,protected))
    centers = geometry.astype(np.float32).mean(axis=1)
    neighbors,edges,seams = adjacency(geometry,tex,norm,ids,names)
    np.savez_compressed(mapping/'edges.npz',faces=edges,seam=seams)
    scores = np.zeros((len(geometry),len(settings['designs'])),dtype=np.float32)
    candidates = np.zeros_like(scores,dtype=np.uint8)
    partial = np.zeros_like(candidates)
    stage('计算投影与遮挡')
    for column,(name,options) in enumerate(settings['designs'].items()):
        view = dict(cameras['views'][name])
        # Keep the recorded projection frame, but place its orthographic eye beyond moved geometry.
        direction = np.asarray(view['dir'])
        center = np.asarray(cameras['center'])
        depths = (points-center) @ direction
        if (np.asarray(view['cam_loc'])-center) @ direction <= depths.max()+1e-7:
            view['cam_loc'] = (center+direction*(depths.max()+view['span'])).tolist()
        matrix = np.stack((np.asarray(view['right'])/view['span'],np.asarray(view['up'])/view['span'],direction),axis=1)
        coords = (centers-center) @ matrix
        cosine = norm @ direction
        indexes = np.flatnonzero(~excludes & (cosine>=max(1e-6,settings.get('min_projection_cos',0))) &
                               (np.abs(coords[:,:2])<=.5).all(axis=1))
        occluders = (points-center) @ matrix
        visible = indexes[projector_visibility(occluders,coords[indexes])] if len(indexes) else indexes
        scores[visible,column] = cosine[visible]
        candidates[visible,column] = 1
        if len(visible):
            inset = geometry[visible]*.7+centers[visible,None,:]*.3
            partial[visible,column] = ~projector_visibility(occluders,((inset-center) @ matrix).reshape(-1,3)).reshape(-1,3).all(axis=1)
        images,buffers,_ = raster(points,shading,normals,protected,valid,cameras,view,options,512,
                                  settings.get('guide',{}).get('facing_power',3),settings.get('min_projection_cos',0))
        folder = guides/name
        folder.mkdir()
        for filename,pixels in images.items():
            Image.fromarray(pixels).save(folder/f'{filename}.png')
        np.savez_compressed(folder/'raster.npz',**buffers)
    choices = choose(scores,candidates,neighbors,settings.get('mode','baseline'),settings.get('angle_margin',.08))
    np.savez_compressed(mapping/'faces.npz',centers=centers,projection_excluded=excludes,
                        candidates=candidates,partial=partial,scores=scores,choice=choices)
    stage('栅格化原 UV 并核对保护区')
    map_material(mapping/'surface.npz',geometry,tex,excludes,np.flatnonzero(names==source['material']),baseline)
    save(cache/'geometry_report.json',dict(engine='glb',uv_unchanged=True,uv_before_sha256=uv_digest,
         uv_after_sha256=uv_digest,materials=[dict(name=source['material'],file='surface')],
         view_names=list(settings['designs']),visible_faces=int((choices>=0).sum()),triangles=len(geometry)))


def rebuild(config):
    out = Path(config['out'])
    source = config['source']
    original = Path(source['reviewSource'])
    model_file = Path(config['model'])
    expected = source['files'][str(original)]
    if checksum(original)!=expected or checksum(model_file)!=config['modelSha256']:
        raise ValueError('原模型或登记 GLB 指纹变化')
    model = Model(model_file)
    with tempfile.TemporaryDirectory(prefix='surface-',dir=out) as work:
        work = Path(work)
        build(config,work,model)
        for name in ('cache','guides'):
            shutil.rmtree(out/name,ignore_errors=True)
            (work/name).replace(out/name)
        files = {file.relative_to(out).as_posix():checksum(file) for name in ('cache','guides')
                 for file in sorted((out/name).rglob('*')) if file.is_file()}
        save(work/'report.json',dict(sourceSha256=expected,modelFingerprint=config['modelFingerprint'],
            modelSha256=config['modelSha256'],uvUnchanged=True,files=files))
        (work/'report.json').replace(out/'report.json')


if __name__=='__main__':
    try:
        config = read(sys.argv[2])
        watch_parent(config.get('ownerPid'))
        if sys.argv[1]=='register':
            register(config)
        elif sys.argv[1]=='topology':
            model = Model(config['baseline'])
            if checksum(config['baseline'])!=config['modelSha256']:
                raise ValueError('登记 GLB 指纹变化')
            out = Path(config['out'])
            save(out.with_suffix('.tmp'),dict(modelSha256=config['modelSha256'],primitives=model.topology()))
            out.with_suffix('.tmp').replace(out)
        else:
            with cache_lock(config['out']):
                rebuild(config)
    except (ValueError,KeyError,IndexError,TypeError,RecursionError) as error:
        sys.exit(str(error))
