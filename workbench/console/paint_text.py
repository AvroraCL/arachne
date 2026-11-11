"""Rasterize an editable UV text layer to an immutable transparent PNG."""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def render_text(style, font_path, output):
    size = style['fontSize']
    font = ImageFont.truetype(str(font_path), size)
    font.set_variation_by_axes([style['weight']])
    options = dict(font=font, spacing=max(2, round(size*.18)), align=style['align'])
    text = style['content']
    measure = ImageDraw.Draw(Image.new('L', (1, 1)))
    left, top, right, bottom = measure.multiline_textbbox((0, 0), text, **options)
    left, top = math.floor(left), math.floor(top)
    right, bottom = math.ceil(right), math.ceil(bottom)
    padding = max(2, round(size*.025))
    width, height = right-left+2*padding, bottom-top+2*padding
    extra_x, extra_y = 0, 0
    if max(width,height)<41:
        extra_x, extra_y = (41-width)//2, (41-height)//2
        width, height = 41, 41
    if width>8192 or height>8192 or width*height>16_777_216:
        raise ValueError('文字超出贴图尺寸，请缩小字号或减少字符')
    image = Image.new('RGBA', (width, height))
    ImageDraw.Draw(image).multiline_text((extra_x+padding-left,extra_y+padding-top), text, fill=style['color'], **options)
    if image.getbbox() is None:
        raise ValueError('文字没有可用字形')
    image.save(output, 'PNG')


if __name__=='__main__':
    try:
        style = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        render_text(style, Path(sys.argv[2]), Path(sys.argv[3]))
    except ValueError as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
