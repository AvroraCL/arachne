"""Build the supported editable PBR graph using native Blender shader nodes.

Graph operators remain editable, and the saved Blender copy packs source images.
Delivery's flattened channel images are retained separately for renderer-neutral use.
"""
import math
import bpy
from blender_fingerprint import sha256_file
from blender_material_channels import channel_targets
from paint_channels import CHANNELS, DEFAULTS, RGB, SRGB


def apply_material_graph(material, config):
    if not config:
        return None
    graph, tree = config['graph'], material.node_tree
    original_bsdf = next((node for node in tree.nodes if node.type == 'BSDF_PRINCIPLED'),None)
    for node in tree.nodes:
        if node.type == 'OUTPUT_MATERIAL':
            node.is_active_output = False
    sockets = {}
    def new(kind, source, suffix='', dy=0):
        node = tree.nodes.new(kind)
        node.name = 'Arachne ' + source['id'] + suffix
        node.location = (source['x'], -source['y'] + dy)
        node.width = 210
        return node
    def color(text):
        values = [n/255 for n in bytes.fromhex(text[1:])]
        return tuple(n/12.92 if n <= .04045 else ((n+.055)/1.055)**2.4 for n in values) + (1,)
    def texture(source, file, scalar=False, suffix='', expected=None):
        if expected and sha256_file(file) != expected:
            raise ValueError('Material graph input fingerprint changed')
        node = new('ShaderNodeTexImage', source, suffix)
        node.image = bpy.data.images.load(file, check_existing=False)
        if scalar:
            node.image.colorspace_settings.name = 'Non-Color'
        node.interpolation = 'Linear'
        node.extension = 'REPEAT'
        return node
    def bind(node, inputs, outputs):
        return dict(inputs=inputs, outputs=outputs, node=node)
    source_nodes = {node['id']:node for node in graph['nodes']}
    for instruction in config['plan']['nodes']:
        source = source_nodes[instruction['id']]
        kind, p = source['type'], source['params']
        if kind == 'paint':
            out = {}
            for index, channel in enumerate(config['paint']):
                node = texture(source, config['paint'][channel], channel not in SRGB, '-'+channel,
                               config.get('paintSha256',{}).get(channel))
                node.location.y -= index*270
                node.label = '涂装结果 · ' + channel
                if channel in RGB:
                    out[channel] = node.outputs['Color']
                else:
                    split = new('ShaderNodeSeparateColor',source,'-split-'+channel, -index*270)
                    split.location.x += 230
                    tree.links.new(node.outputs['Color'],split.inputs['Color'])
                    out[channel] = split.outputs['Red']
            sockets[source['id']] = bind(node, {}, out)
            continue
        if kind == 'color':
            node = new('ShaderNodeRGB',source);node.outputs[0].default_value = color(p['color'])
            ports = bind(node, {}, dict(color=node.outputs[0]))
        elif kind == 'value':
            node = new('ShaderNodeValue',source);node.outputs[0].default_value = p['value']
            ports = bind(node, {}, dict(value=node.outputs[0]))
        elif kind == 'reroute':
            node = new('NodeReroute',source)
            ports = bind(node,dict(input=node.inputs[0]),dict(output=node.outputs[0]))
            if 'input' not in instruction['inputs']:
                data_type=instruction['params']['dataType']
                constant=new('ShaderNodeCombineXYZ' if data_type=='vector' else 'ShaderNodeRGB' if data_type=='color' else 'ShaderNodeValue',source,'-default')
                if data_type=='color':constant.outputs[0].default_value=(0,0,0,1)
                elif data_type=='scalar':constant.outputs[0].default_value=0
                tree.links.new(constant.outputs[0],node.inputs[0])
        elif kind == 'uv':
            node = new('ShaderNodeTexCoord',source)
            ports = bind(node, {}, dict(uv=node.outputs['UV']))
        elif kind == 'mapping':
            node = new('ShaderNodeMapping',source);node.vector_type = 'POINT'
            node.inputs['Location'].default_value = (p['x'],p['y'],0)
            node.inputs['Rotation'].default_value = (0,0,math.radians(p['rotation']))
            node.inputs['Scale'].default_value = (p['scale'],p['scale'],1)
            ports = bind(node, dict(uv=node.inputs['Vector']), dict(uv=node.outputs['Vector']))
        elif kind == 'image':
            if p['asset']:
                node = texture(source,config['assets'][p['asset']],p.get('colorSpace','srgb')=='linear',expected=p['asset'])
                bw = new('ShaderNodeRGBToBW',source,'-luminance',-290)
                tree.links.new(node.outputs['Color'],bw.inputs['Color'])
                ports = bind(node,dict(uv=node.inputs['Vector']),dict(color=node.outputs['Color'],alpha=node.outputs['Alpha'],value=bw.outputs[0]))
            else:
                node = new('ShaderNodeRGB',source);node.outputs[0].default_value = (0,0,0,0)
                zero = new('ShaderNodeValue',source,'-empty');zero.outputs[0].default_value = 0
                ports = bind(node,{},dict(color=node.outputs[0],alpha=zero.outputs[0],value=zero.outputs[0]))
        elif kind == 'mix':
            node = new('ShaderNodeMixRGB',source);node.blend_type='MIX';node.use_clamp=False
            node.inputs[0].default_value=p['factor'];node.inputs[1].default_value=color(p['a']);node.inputs[2].default_value=color(p['b'])
            ports=bind(node,dict(factor=node.inputs[0],a=node.inputs[1],b=node.inputs[2]),dict(color=node.outputs[0]))
        elif kind == 'math':
            node=new('ShaderNodeMath',source);node.operation=p['operation'].upper()
            node.inputs[0].default_value=p['a'];node.inputs[1].default_value=p['b']
            ports=bind(node,dict(a=node.inputs[0],b=node.inputs[1]),dict(value=node.outputs[0]))
        elif kind == 'ramp':
            node=new('ShaderNodeValToRGB',source);node.color_ramp.interpolation='LINEAR'
            node.color_ramp.elements[0].color=color(p['low']);node.color_ramp.elements[1].color=color(p['high'])
            node.inputs['Fac'].default_value=p['value']
            ports=bind(node,dict(value=node.inputs['Fac']),dict(color=node.outputs['Color']))
        elif kind == 'pbr':
            node=original_bsdf or new('ShaderNodeBsdfPrincipled',source)
            node.name='Arachne '+source['id'];node.location=(source['x'],-source['y'])
            active=config.get('activeChannels',list(CHANNELS))
            targets=channel_targets(material,node,active)
            for key,target in targets.items():
                for link in list(target.links):tree.links.remove(link)
                value=p.get(key,DEFAULTS[key])
                if key in RGB:
                    value=color(value) if key in SRGB else tuple(n/255 for n in bytes.fromhex(value[1:]))+(1,)
                elif target.type=='RGBA':value=(value,value,value,1)
                target.default_value=value
            ports=bind(node,targets,dict(surface=node.outputs['BSDF']))
        elif kind == 'output':
            node=new('ShaderNodeOutputMaterial',source);node.is_active_output=True
            ports=bind(node,dict(surface=node.inputs['Surface']),{})
        # Unconnected UV sockets use explicit UV, as in the browser evaluator.
        if kind in ('mapping','image') and 'uv' not in instruction['inputs'] and 'uv' in ports['inputs']:
            uv=new('ShaderNodeTexCoord',source,'-default-uv',160)
            tree.links.new(uv.outputs['UV'],ports['inputs']['uv'])
        node.label = {'pbr':'基础 PBR','output':'材质输出','image':'图像纹理','mapping':'映射'}.get(kind,kind)
        sockets[source['id']]=ports
        for port,link in instruction['inputs'].items():
            # Empty image placeholders ignore their UV input intentionally.
            if port in ports['inputs']:
                upstream=sockets[link['node']]
                # Blender replaces reroute sockets when their inferred type changes.
                output=upstream['node'].outputs[0] if upstream['node'].bl_idname=='NodeReroute' else upstream['outputs'][link['port']]
                target=node.inputs[0] if kind=='reroute' else ports['inputs'][port]
                tree.links.new(output,target)
    material['arachne_material_fingerprint']=config['fingerprint']
    return dict(fingerprint=config['fingerprint'],native=True,nodes=len(tree.nodes),links=len(tree.links),paintStack='baked-inputs')
