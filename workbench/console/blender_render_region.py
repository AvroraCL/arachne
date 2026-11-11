"""Apply pixel-aligned render regions to the configured Cycles camera frame."""
import math


def apply_render_region(scene, region):
    render = scene.render
    render.use_border = region is not None
    render.use_crop_to_border = bool(region and region['crop'])
    if not region:
        return None
    if not render.use_crop_to_border:
        render.image_settings.color_mode = 'RGBA'
    width, height = render.resolution_x, render.resolution_y
    x0, y0, x1, y1 = region['pixels']
    if region['frame'] != [width, height] or not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ValueError('渲染区域与相机画面不一致')

    # Keep normalized values just inside their pixel bins so Blender's
    # float precision cannot move a boundary one pixel at odd resolutions.
    def border(pixel, extent):
        return pixel / extent if pixel in (0, extent) else (pixel + .25) / extent

    render.border_min_x = border(x0, width)
    render.border_max_x = border(x1, width)
    render.border_min_y = border(height - y1, height)
    render.border_max_y = border(height - y0, height)
    left = math.floor(render.border_min_x * width)
    right = math.floor(render.border_max_x * width)
    top = height - math.floor(render.border_max_y * height)
    bottom = height - math.floor(render.border_min_y * height)
    crop = render.use_crop_to_border
    actual = {'frame': [width, height], 'pixels': [left, top, right, bottom], 'crop': crop,
              'output': [right - left, bottom - top] if crop else [width, height]}
    if actual != region:
        raise ValueError('Blender 渲染边界无法对齐到请求的像素')
    return actual
