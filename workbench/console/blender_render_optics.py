"""Set native camera optics without modifying the registered source camera."""
import math


def apply_render_optics(camera, settings, target_distance):
    if not settings:
        return None
    optics = camera.data.dof
    focus = target_distance if settings['focusMode'] == 'target' else settings['focusDistance']
    optics.use_dof = settings['enabled']
    optics.focus_object = None
    optics.focus_distance = focus
    optics.aperture_fstop = settings['fStop']
    optics.aperture_blades = settings['blades']
    optics.aperture_rotation = math.radians(settings['rotation'])
    optics.aperture_ratio = settings['ratio']
    return {'enabled': optics.use_dof, 'focusMode': settings['focusMode'],
            'focusDistance': optics.focus_distance, 'targetDistance': target_distance,
            'fStop': optics.aperture_fstop, 'blades': optics.aperture_blades,
            'rotation': math.degrees(optics.aperture_rotation), 'ratio': optics.aperture_ratio}
