"""Fit a disposable camera for renders without an explicit viewport camera."""
import bpy
import math
from mathutils import Vector, Matrix
from bpy_extras.object_utils import world_to_camera_view
from camera_framing import orthographic_scale, perspective_distance
from blender_render_optics import apply_render_optics


def model_bounds(scene):
    def visible_collections(layer):
        if layer.exclude or layer.collection.hide_render:
            return set()
        result = set(layer.collection.objects)
        for child in layer.children:
            result.update(visible_collections(child))
        return result

    visible = visible_collections(bpy.context.view_layer.layer_collection)
    objects = [obj for obj in scene.objects if obj in visible and obj.type == 'MESH' and
               not obj.hide_render and not obj.name.lower().startswith(('ground', 'floor', 'backdrop'))]
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points, names = [], []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        if not len(evaluated.data.vertices):
            continue
        points.extend(evaluated.matrix_world @ Vector(point) for point in evaluated.bound_box)
        names.append(obj.name)
    if not points:
        raise ValueError('场景没有可取景的模型表面')
    return points, names


def fit_render_camera(scene, optics=None):
    points, names = model_bounds(scene)
    low = Vector([min(point[i] for point in points) for i in range(3)])
    high = Vector([max(point[i] for point in points) for i in range(3)])
    center, size = (low + high) / 2, max((high - low).length, 1e-5)
    source = scene.camera
    if source:
        orientation = source.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world.to_quaternion()
        data = source.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.copy()
        data.animation_data_clear()
    else:
        orientation = Vector((-1, 1, -.75)).to_track_quat('-Z', 'Y')
        data = bpy.data.cameras.new('ArachneRenderCamera')
    if data.type not in ('ORTHO', 'PERSP'):
        data.type = 'PERSP'
    data.shift_x = data.shift_y = 0
    camera = bpy.data.objects.new('ArachneRenderCamera', data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    inverse = orientation.inverted()
    local = [inverse @ (point - center) for point in points]
    if data.type == 'ORTHO':
        data.ortho_scale = 1
        frame = data.view_frame(scene=scene)
        data.ortho_scale = orthographic_scale(local, max(abs(point.x) for point in frame),
                                             max(abs(point.y) for point in frame))
        distance = max((source.matrix_world.translation - center).length if source else 0, size * 2)
    else:
        frame = data.view_frame(scene=scene)
        distance = perspective_distance(local, max(abs(point.x / point.z) for point in frame),
                                         max(abs(point.y / point.z) for point in frame))
    camera.matrix_world = orientation.to_matrix().to_4x4()
    camera.location = center + orientation @ Vector((0, 0, distance))
    closest = distance - max(point.z for point in local)
    farthest = distance - min(point.z for point in local)
    data.clip_start = max(1e-6, min(closest * .1, size * .01))
    data.clip_end = max(data.clip_start * 10, farthest + size * .1)
    if data.dof.use_dof:
        data.dof.focus_object = None
        data.dof.focus_distance = distance
    optical_state = apply_render_optics(camera, optics, distance)
    bpy.context.view_layer.update()
    projected = [world_to_camera_view(scene, camera, point) for point in points]
    bounds = [[min(point[i] for point in projected), max(point[i] for point in projected)] for i in range(3)]
    inside = all(-1e-5 <= point.x <= 1 + 1e-5 and -1e-5 <= point.y <= 1 + 1e-5 and
                 data.clip_start < point.z < data.clip_end for point in projected)
    if not inside:
        raise ValueError('默认相机未完整包含模型，请调整视角后重试')
    return {'mode':'auto_fit', 'projection':data.type, 'matrixWorld':[list(row) for row in camera.matrix_world],
            'lens':data.lens, 'orthoScale':data.ortho_scale, 'margin':1.08, 'modelObjects':names,
            'ndcBounds':bounds, 'boundsInFrame':inside,
            'scope':'World bounding boxes of render-visible mesh objects; ground/floor/backdrop excluded. Framing only, not occlusion or artwork acceptance.',
            **({'optics': optical_state} if optical_state else {})}


def viewport_camera_transform(requested):
    # Invert the fixed Blender Z-up -> glTF Y-up basis.
    convert = lambda value: Vector((value[0], -value[2], value[1]))
    eye, target, up = (convert(requested[key]) for key in ('eye', 'target', 'up'))
    z = (eye-target).normalized()
    x = up.cross(z).normalized()
    y = z.cross(x).normalized()
    transform = Matrix((x, y, z)).transposed().to_4x4()
    transform.translation = eye
    return transform, (eye - target).length


def configure_render_camera(scene, settings, optics=None, camera=None):
    scene.render.resolution_x = settings['width']
    scene.render.resolution_y = settings['height']
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    requested = settings.get('camera')
    if not requested:
        return fit_render_camera(scene, optics)
    transform, target_distance = viewport_camera_transform(requested)
    if camera is None:
        data = bpy.data.cameras.new('ArachneCyclesCamera')
        camera = bpy.data.objects.new('ArachneCyclesCamera', data)
        scene.collection.objects.link(camera)
    else:
        data = camera.data
    camera.matrix_world = transform
    data.sensor_fit, data.sensor_height = 'VERTICAL', 24
    data.type = 'ORTHO' if requested['projection'] == 'orthographic' else 'PERSP'
    data.lens = 24/(2*math.tan(math.radians(requested['fov'])/2))
    data.ortho_scale = requested['orthoHeight']
    data.clip_start, data.clip_end = .001, 1000000
    scene.camera = camera
    optical_state = apply_render_optics(camera, optics, target_distance)
    bpy.context.view_layer.update()
    return {'mode':'viewport', 'autoFit':False, 'projection':data.type,
            'matrixWorld':[list(row) for row in camera.matrix_world], 'lens':data.lens, 'orthoScale':data.ortho_scale,
            **({'optics': optical_state} if optical_state else {})}
