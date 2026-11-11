"""Generate the original Arachne demo scene and its neutral base texture."""
import sys
from pathlib import Path

import bpy


def box(name, minimum, maximum, material, first_island):
    x, y, z = minimum
    X, Y, Z = maximum
    vertices = [(x, y, z), (X, y, z), (X, Y, z), (x, Y, z),
                (x, y, Z), (X, y, Z), (X, Y, Z), (x, Y, Z)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    uv = mesh.uv_layers.new(name='UVMap')
    for face, island in zip(mesh.polygons, range(first_island, first_island + 6)):
        u, v = (island % 4) * .25, (island // 4) * .25
        for i, (du, dv) in zip(face.loop_indices, [(.02, .02), (.23, .02), (.23, .23), (.02, .23)]):
            uv.data[i].uv = (u + du, v + dv)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)


def main(out):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    # Internal identifier used by the existing paint archive and material code.
    material = bpy.data.materials.new('f_16xl')
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (.18, .22, .27, 1)
    shader.inputs['Roughness'].default_value = .46
    box('Housing', (-2, -1.3, -.5), (2, 1.3, .35), material, 0)
    box('Cover', (.85, .5, .35), (1.55, 1.05, .7), material, 6)
    world = bpy.data.worlds.new('Demo World')
    world.use_nodes = True
    world.node_tree.nodes.get('Background').inputs[0].default_value = (.32, .36, .42, 1)
    scene.world = world
    lamp = bpy.data.lights.new('Key', 'AREA')
    lamp.energy, lamp.size = 850, 6
    light = bpy.data.objects.new('Key', lamp)
    scene.collection.objects.link(light)
    light.location = (0, -2, 5)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / 'demo.blend'), check_existing=False)
    image = bpy.data.images.new('Neutral base', width=32, height=32, alpha=False)
    image.generated_color = (.27, .31, .37, 1)
    image.filepath_raw = str(out / 'base.png')
    image.file_format = 'PNG'
    image.save()


if __name__ == '__main__':
    main(Path(sys.argv[sys.argv.index('--') + 1]).resolve())
