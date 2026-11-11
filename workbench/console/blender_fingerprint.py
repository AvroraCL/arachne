"""Bounded-memory source checks shared by the native render and blend export."""
from array import array
from hashlib import sha256
import sys


def sha256_file(file):
    digest = sha256()
    buffer = bytearray(1024 * 1024)
    view = memoryview(buffer)
    with open(file, 'rb') as source:
        while size := source.readinto(buffer):
            digest.update(view[:size])
    return digest.hexdigest()


def uv_fingerprint(scene):
    digest = sha256()
    for obj in sorted((item for item in scene.objects if item.type == 'MESH'), key=lambda item: item.name):
        digest.update(obj.name.encode('utf-8'))
        for layer in obj.data.uv_layers:
            digest.update(layer.name.encode('utf-8'))
            uv = getattr(layer, 'uv', None)
            values, property_name = (uv, 'vector') if uv is not None else (layer.data, 'uv')
            if len(values):
                coords = array('f', [0.0]) * (2 * len(values))
                values.foreach_get(property_name, coords)
                # The previous implementation hashed one struct.pack('<ff') per corner.
                if sys.byteorder != 'little':
                    coords.byteswap()
                digest.update(coords)
    return digest.hexdigest()
