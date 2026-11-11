"""Conservative fitting of model bounds in camera-local coordinates."""
import math


def _check(points, half_width, half_height, margin):
    if not points or not all(len(point) == 3 and all(math.isfinite(value) for value in point) for point in points):
        raise ValueError('模型取景边界无效')
    if not all(math.isfinite(value) and value > 0 for value in (half_width, half_height, margin)) or margin < 1:
        raise ValueError('相机取景参数无效')


def orthographic_scale(points, half_width, half_height, margin=1.08):
    """Frame half extents are measured at ortho_scale=1 for the output aspect."""
    _check(points, half_width, half_height, margin)
    return max(1e-6, margin * max(max(abs(x) / half_width, abs(y) / half_height) for x, y, _ in points))


def perspective_distance(points, tan_horizontal, tan_vertical, margin=1.08):
    """The camera is on local +Z, looking at the bounds center along -Z."""
    _check(points, tan_horizontal, tan_vertical, margin)
    extent = max(max(point[i] for point in points) - min(point[i] for point in points) for i in range(3))
    padding = max(1e-5, extent * .01)
    return max(max(z + margin * abs(x) / tan_horizontal, z + margin * abs(y) / tan_vertical,
                   z + padding) for x, y, z in points)
