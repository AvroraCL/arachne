"""Bind frozen UV channels; preserve source shader inputs for legacy projects."""
from pathlib import Path
import bpy
from blender_fingerprint import sha256_file


def channel_targets(material,bsdf,active):
    tree=material.node_tree
    targets=dict(color=bsdf.inputs['Base Color'],metallic=bsdf.inputs['Metallic'],roughness=bsdf.inputs['Roughness'])
    if 'emission' in active:
        targets['emission']=bsdf.inputs['Emission Color'];bsdf.inputs['Emission Strength'].default_value=1
    if 'alpha' in active:targets['alpha']=bsdf.inputs['Alpha']
    original_normal=bsdf.inputs['Normal'].links[0].from_socket if bsdf.inputs['Normal'].links else None
    normal=original_normal
    if 'normal' in active:
        node=tree.nodes.new('ShaderNodeNormalMap');node.name='Arachne Tangent Normal';node.space='TANGENT'
        node.inputs['Color'].default_value=(.5,.5,1,1)
        targets['normal']=node.inputs['Color'];normal=node.outputs['Normal']
    if 'height' in active:
        node=tree.nodes.new('ShaderNodeBump');node.name='Arachne Height Bump'
        node.inputs['Distance'].default_value=.05;node.inputs['Height'].default_value=.5
        if normal:tree.links.new(normal,node.inputs['Normal'])
        targets['height']=node.inputs['Height'];normal=node.outputs['Normal']
    if normal and ('normal' in active or 'height' in active):tree.links.new(normal,bsdf.inputs['Normal'])
    if 'ao' in active:
        node=tree.nodes.new('ShaderNodeMixRGB');node.name='Arachne AO Multiply';node.blend_type='MULTIPLY'
        node.inputs[0].default_value=1;node.inputs[1].default_value=bsdf.inputs['Base Color'].default_value
        node.inputs[2].default_value=(1,1,1,1)
        if bsdf.inputs['Base Color'].links:tree.links.new(bsdf.inputs['Base Color'].links[0].from_socket,node.inputs[1])
        tree.links.new(node.outputs['Color'],bsdf.inputs['Base Color'])
        targets['color']=node.inputs[1];targets['ao']=node.inputs[2]
    return targets


def apply_channels(material,bsdf,channels,pack=False):
    report={}
    if not channels:return report
    active=[name for name,entry in channels.items() if entry.get('enabled',True)]
    targets=channel_targets(material,bsdf,active)
    for name,entry in channels.items():
        p=Path(entry['file'])
        if sha256_file(p)!=entry['sha256']:raise ValueError('UV fingerprint changed: '+name)
        space='sRGB' if name=='emission' else 'Non-Color'
        applied=name in targets and entry.get('enabled',True)
        if applied:
            im=bpy.data.images.load(str(p),check_existing=False);im.colorspace_settings.name=space
            if pack:im.pack()
            node=material.node_tree.nodes.new('ShaderNodeTexImage');node.name='Arachne_'+name;node.image=im
            material.node_tree.links.new(node.outputs['Color'],targets[name])
        report[name]={'sha256':entry['sha256'],'colorSpace':space,'applied':applied}
    return report
