"""Apply project lighting to an opened copy, without saving the registered scene."""
import math
import bpy
from mathutils import Vector
from blender_camera_framing import model_bounds

PROFILES = {
    'studio': (((1.2, -1, 1.7), (-1.1, -.5, .6), (.4, 1.4, 1)), (90, 25, 70), (.8, 1.2, .7)),
    'soft': (((1, -1, 2), (-1, -.4, 1), (.3, 1.5, 1.2)), (65, 45, 40), (1.8, 2, 1.7)),
    'daylight': (((1, -.8, 2.8), (-1, 0, 1), (0, 1, 1.4)), (110, 15, 35), (.3, 1.5, 1)),
}


def linear_color(value):
    channels = [byte / 255 for byte in bytes.fromhex(value[1:])]
    return tuple(channel / 12.92 if channel <= .04045 else ((channel + .055) / 1.055) ** 2.4
                 for channel in channels)


def scale_world(world, gain):
    if world is None:
        return 0
    if not world.use_nodes or world.node_tree is None:
        if gain != 1:
            color = tuple(world.color)
            world.use_nodes = True
            node = next(item for item in world.node_tree.nodes if item.type == 'BACKGROUND')
            node.inputs['Color'].default_value = (*color, 1)
            node.inputs['Strength'].default_value = gain
        return 1
    tree = world.node_tree
    backgrounds = [node for node in tree.nodes if node.type == 'BACKGROUND']
    for node in backgrounds:
        if gain == 1:
            continue
        strength = node.inputs['Strength']
        if not strength.links:
            strength.default_value *= gain
            continue
        source = strength.links[0].from_socket
        multiplier = tree.nodes.new('ShaderNodeMath')
        multiplier.label = '阿拉克涅环境强度'
        multiplier.operation = 'MULTIPLY'
        multiplier.inputs[1].default_value = gain
        tree.links.new(source, multiplier.inputs[0])
        tree.links.new(multiplier.outputs[0], strength)
    return len(backgrounds)


def apply_render_lighting(scene, settings):
    if not settings:
        return None
    mode = settings['preset']
    lights = [obj for obj in scene.objects if obj.type == 'LIGHT']
    gain = settings['lightStrength']
    if mode == 'source':
        seen = set()
        for obj in lights:
            light = obj.data
            identity = light.as_pointer()
            if identity not in seen:
                seen.add(identity)
                light.energy *= gain
        backgrounds = scale_world(scene.world, settings['environmentStrength'])
        lights = [obj for obj in lights if not obj.hide_render]
    else:
        points, _ = model_bounds(scene)
        low = Vector([min(point[axis] for point in points) for axis in range(3)])
        high = Vector([max(point[axis] for point in points) for axis in range(3)])
        center, radius = (low + high) / 2, max((high - low).length / 2, 1e-5)
        for obj in lights:
            obj.hide_render = True
        lights = []
        angle = math.radians(settings['rotation'])
        cosine, sine = math.cos(angle), math.sin(angle)
        positions, powers, sizes = PROFILES[mode]
        for name, (x, y, z), power, size in zip(('Key', 'Fill', 'Rim'), positions, powers, sizes):
            label = 'Arachne Cycles ' + name
            light = bpy.data.lights.new(label, type='AREA')
            obj = bpy.data.objects.new(label, light)
            scene.collection.objects.link(obj)
            obj.location = center + radius * Vector((x * cosine - y * sine, x * sine + y * cosine, z))
            obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
            light.energy = power * radius * radius * gain
            light.shape, light.size = 'DISK', size * radius
            lights.append(obj)
        world = bpy.data.worlds.new('Arachne Cycles World')
        world.use_nodes = True
        tree = world.node_tree
        tree.nodes.clear()
        background = tree.nodes.new('ShaderNodeBackground')
        background.inputs['Color'].default_value = (*linear_color(settings['environmentColor']), 1)
        background.inputs['Strength'].default_value = settings['environmentStrength']
        output = tree.nodes.new('ShaderNodeOutputWorld')
        tree.links.new(background.outputs['Background'], output.inputs['Surface'])
        scene.world = world
        backgrounds = 1
    return {'options': settings, 'worldBackgrounds': backgrounds,
            'lights': [{'name': obj.name, 'type': obj.data.type, 'energy': obj.data.energy}
                       for obj in sorted(lights, key=lambda value: value.name)]}
