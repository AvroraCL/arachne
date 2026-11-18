"""Project PNG pigment on the original UV of a secondary GLB material."""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from model_glb import Model
from model_surface import material_atlas, surface
from paint_surface import Surface
from paint_worker import sample_document, encode


def project(cfg):
    model = Model(cfg['model'])
    material = next(m for m in model.scene['materials'] if m['name'] == cfg['name'])
    if 'baseColorTexture' in material.get('pbrMetallicRoughness', {}):
        raise ValueError('附属材质标记当前支持纯色底材')
    model.edit(cfg['steps'])
    points, _, normals, uv, objects, _, labels = surface(model)
    selected = labels == cfg['name']
    atlas = material_atlas(points, uv, np.zeros(len(points), dtype=bool), np.flatnonzero(selected))
    owner = atlas['owner'].ravel()
    xyz = atlas['xyz'].reshape(-1,3)
    projector = cfg['projector']
    # Cull distant texels before projection; retain all model triangles as occluders.
    allowed = (owner>=0) & (atlas['collision'].ravel()==0) & (atlas['protected'].ravel()==0)
    radius = projector['size'] + projector['depth']
    for axis,value in enumerate(projector['center']):
        allowed &= np.abs(xyz[:,axis]-value)<=radius
    target = Surface(points, selected, normals, objects, xyz, owner, allowed)
    with Image.open(cfg['image']) as im:
        art = np.asarray(im.convert('RGBA'))
    ids, coords = target.project(projector, art.shape)
    if not len(ids):
        raise ValueError('标记没有命中可见且 UV 独立的材质表面')
    rgba = np.zeros((*atlas['owner'].shape,4),dtype=np.uint8)
    rgb, alpha = sample_document(art,coords[:,0],coords[:,1],'color')
    pixels = np.rint(np.column_stack((encode(rgb),alpha))*255).clip(0,255).astype(np.uint8)
    if not pixels[:,3].any():
        raise ValueError('标记的可见部分全透明')
    rgba.reshape(-1,4)[ids] = pixels
    # Atlas rows are bottom-up UV coordinates; model_surface already converted
    # the glTF texture V coordinate. Convert back to PNG scanlines.
    Image.fromarray(rgba[::-1]).save(cfg['output'],compress_level=3)


if __name__=='__main__':
    try:
        project(json.loads(Path(sys.argv[1]).read_bytes()))
    except (ValueError, KeyError, IndexError) as error:
        sys.exit(str(error))
