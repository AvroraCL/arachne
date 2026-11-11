"""Write scene-linear auxiliary passes from the same native Cycles render."""
import bpy


PASSES = {
    'depth': ('use_pass_z', 'Depth', 'Depth', 'FLOAT'),
    'normal': ('use_pass_normal', 'Normal', 'Normal', 'VECTOR'),
    'ao': ('use_pass_ambient_occlusion', 'Ambient Occlusion', 'AO', 'RGBA'),
    'diffuse': ('use_pass_diffuse_color', 'Diffuse Color', 'Diffuse', 'RGBA'),
    'specular': ('use_pass_glossy_color', 'Glossy Color', 'Specular', 'RGBA'),
    'emission': ('use_pass_emit', 'Emission', 'Emission', 'RGBA'),
    'environment': ('use_pass_environment', 'Environment', 'Environment', 'RGBA'),
}


def supports_render_passes():
    return ('compositing_node_group' in bpy.types.Scene.bl_rna.properties
            and hasattr(bpy.types.CompositorNodeOutputFile, 'bl_rna')
            and 'file_output_items' in bpy.types.CompositorNodeOutputFile.bl_rna.properties
            and 'use_exr_interleave' in bpy.types.ImageFormatSettings.bl_rna.properties)


def configure_render_passes(scene, selected, directory):
    if not selected:
        return None
    if not supports_render_passes():
        raise RuntimeError('此 Blender 版本不支持工作台的多层 EXR 渲染通道')
    view_layer = bpy.context.view_layer
    for key in selected:
        setattr(view_layer, PASSES[key][0], True)
    group = scene.compositing_node_group if scene.render.use_compositing else None
    created = group is None
    if created:
        group = bpy.data.node_groups.new('Arachne · Render Passes', 'CompositorNodeTree')
        scene.compositing_node_group = group
    scene.render.use_compositing = True
    layers = group.nodes.new('CompositorNodeRLayers')
    layers.layer = view_layer.name
    layers.label = 'Arachne · Render Layers'
    if created:
        group.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        composite = group.nodes.new('NodeGroupOutput')
        composite.location = (315, 130)
        group.links.new(layers.outputs['Image'], composite.inputs['Image'])
    file_output = group.nodes.new('CompositorNodeOutputFile')
    file_output.label = 'Arachne · Linear EXR Passes'
    file_output.location = (315, -65)
    file_output.directory = str(directory)
    file_output.file_name = 'cycles-passes'
    file_output.save_as_render = False
    file_output.use_file_extension = True
    file_output.format.media_type = 'MULTI_LAYER_IMAGE'
    file_output.format.exr_codec = 'ZIP'
    file_output.format.color_depth = '32'
    file_output.format.use_exr_interleave = True
    for output, layer, kind in [('Image', 'Combined', 'RGBA')] + [PASSES[key][1:] for key in selected]:
        socket = layers.outputs.get(output)
        if socket is None or not socket.enabled:
            raise RuntimeError('Cycles 未提供已选渲染通道：' + output)
        file_output.file_output_items.new(kind, layer)
        group.links.new(socket, file_output.inputs[layer])
    return {'file': 'cycles-passes.exr', 'selected': selected, 'viewLayer': view_layer.name, 'bitDepth': 32}
