"""Build lossless material output templates from a verified paint bake."""
from pathlib import Path
from shutil import copyfile
from contextlib import ExitStack
import json
import struct
import sys

from PIL import Image, ImageOps, PngImagePlugin


def pack(config):
    size = tuple(config['resolution'])
    sources, files = config['sources'], config['files']
    out = Path(config['out'])
    out.mkdir(parents=True, exist_ok=False)
    for item in files:
        target = out / item['name']
        if 'copy' in item:
            copyfile(sources[item['copy']], target)
            continue
        bands, opened = [], {}
        with ExitStack() as images:
            for expression in item['bands']:
                if isinstance(expression, int):
                    bands.append(Image.new('L', size, expression))
                    continue
                invert = expression.startswith('!')
                channel, _, component = expression.lstrip('!').partition('.')
                if channel not in opened:
                    image = images.enter_context(Image.open(sources[channel]))
                    if image.format != 'PNG' or image.size != size:
                        raise ValueError('贴图输出的源图像尺寸或格式不一致')
                    opened[channel] = image
                band = opened[channel].getchannel(component or 0)
                bands.append(ImageOps.invert(band) if invert else band)
        mode = {3:'RGB',4:'RGBA'}[len(bands)]
        metadata = PngImagePlugin.PngInfo()
        if item['colorSpace'] == 'sRGB':
            metadata.add(b'sRGB', bytes([0]))
        else:
            metadata.add(b'gAMA', struct.pack('>I',100000))
        Image.merge(mode, bands).save(target, format='PNG', pnginfo=metadata, compress_level=3)


if __name__ == '__main__':
    try:
        pack(json.loads(Path(sys.argv[1]).read_bytes()))
    except (OSError, KeyError, ValueError) as error:
        sys.exit(str(error))
