"""Apply the same approved Cycles settings to the Blender copy and render."""

LIGHT_PATHS = {
    'diffuseBounces': 'diffuse_bounces',
    'glossyBounces': 'glossy_bounces',
    'transmissionBounces': 'transmission_bounces',
    'volumeBounces': 'volume_bounces',
    'transparentBounces': 'transparent_max_bounces',
    'directClamp': 'sample_clamp_direct',
    'indirectClamp': 'sample_clamp_indirect',
    'glossyFilter': 'blur_glossy',
    'reflectiveCaustics': 'caustics_reflective',
    'refractiveCaustics': 'caustics_refractive',
}


def apply_render_settings(scene, settings, appearance=None):
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = settings['samples']
    scene.cycles.use_denoising = settings.get('denoise', True)
    for key, prop in (('adaptive', 'use_adaptive_sampling'),
                      ('noiseThreshold', 'adaptive_threshold'),
                      ('maxBounces', 'max_bounces')):
        if key in settings:
            setattr(scene.cycles, prop, settings[key])
    if 'lightPaths' in settings:
        for key, prop in LIGHT_PATHS.items():
            setattr(scene.cycles, prop, settings['lightPaths'][key])
    render = scene.render
    image = render.image_settings
    image.file_format = settings.get('fileFormat', 'PNG')
    if 'transparent' in settings:
        render.film_transparent = settings['transparent']
    if render.film_transparent:
        image.color_mode = 'RGBA'
    elif image.file_format == 'OPEN_EXR':
        image.color_mode = 'RGB'
    if 'bitDepth' in settings:
        image.color_depth = str(settings['bitDepth'])
    if image.file_format == 'OPEN_EXR':
        image.exr_codec = 'ZIP'
        image.color_management = 'FOLLOW_SCENE'
    # Exported artwork should not carry the author's local file path or computer name.
    render.use_stamp_filename = False
    render.use_stamp_hostname = False
    if settings.get('device') in ('cpu', 'gpu'):
        scene.cycles.device = settings['device'].upper()
    if appearance:
        view = scene.view_settings
        view.view_transform = appearance['viewTransform']
        view.look = appearance['look']
        view.exposure = appearance['exposure']
        view.gamma = appearance['gamma']


def effective_render_settings(scene):
    view = scene.view_settings
    return {'adaptive': scene.cycles.use_adaptive_sampling,
            'noiseThreshold': scene.cycles.adaptive_threshold,
            'maxBounces': scene.cycles.max_bounces,
            'lightPaths': {key: getattr(scene.cycles, prop) for key, prop in LIGHT_PATHS.items()},
            'transparent': scene.render.film_transparent,
            'colorMode': scene.render.image_settings.color_mode,
            'fileFormat': scene.render.image_settings.file_format,
            'bitDepth': int(scene.render.image_settings.color_depth),
            'colorManagement': {'viewTransform': view.view_transform, 'look': view.look,
                                'exposure': view.exposure, 'gamma': view.gamma,
                                'displayDevice': scene.display_settings.display_device}}
