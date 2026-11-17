"""Rasterize an editable UV text layer to an immutable transparent PNG."""
import json
import math
import sys
import re
import unicodedata
from pathlib import Path

from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageFilter, ImageFont
from fontTools.ttLib import TTFont
import numpy as np


def inspect_font(file):
    with TTFont(file, lazy=True) as font:
        names = font['name']
        family = names.getBestFamilyName()
        style = names.getBestSubFamilyName()
        if not family or not style:
            raise ValueError('字体缺少家族或字形名称')
        weight = font['OS/2'].usWeightClass
        axis = next((axis for axis in font['fvar'].axes if axis.axisTag == 'wght'), None) if 'fvar' in font else None
        weights = {weight: style}
        if axis is not None:
            weight = round(axis.defaultValue)
            weights = {weight: style}
            for instance in font['fvar'].instances:
                if any(instance.coordinates[a.axisTag] != a.defaultValue for a in font['fvar'].axes if a != axis):
                    continue
                label = names.getDebugName(instance.subfamilyNameID)
                if label:
                    weights[round(instance.coordinates['wght'])] = label
            if len(weights) == 1:
                for number in (round(axis.minValue), round(axis.maxValue)):
                    weights.setdefault(number, str(number))
        return {'family': family, 'style': style, 'weight': weight,
                'italic': bool(font['OS/2'].fsSelection & 1 or font['post'].italicAngle),
                'weights': [[number, label] for number, label in sorted(weights.items())]}


def render_legacy_text(style, font_path, output):
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
    return (extra_x+padding,extra_y+padding)


def glyphs(text):
    clusters = []
    for char in text:
        if clusters and unicodedata.category(char).startswith('M'):
            clusters[-1] += char
        else:
            clusters.append(char)
    return clusters


def text_layout(style, fallback_path, primary_path):
    size = style['fontSize']
    fallback = ImageFont.truetype(str(fallback_path), size)
    fallback.set_variation_by_axes([min(900, max(250, style['weight']))])
    if primary_path == fallback_path:
        primary, supported = fallback, None
    else:
        primary = ImageFont.truetype(str(primary_path), size)
        with TTFont(primary_path, lazy=True) as source:
            supported = source.getBestCmap() or {}
            if 'fvar' in source:
                primary.set_variation_by_axes([style['weight'] if axis.axisTag == 'wght' else axis.defaultValue
                                               for axis in source['fvar'].axes])

    private_font = primary_path.name.startswith('font-')
    if private_font:
        missing = sorted({char for char in style['content'] if char != '\n' and ord(char) not in supported
                          and not unicodedata.category(char) == 'Cf' and not 0xFE00 <= ord(char) <= 0xFE0F})
        if missing:
            raise ValueError('所选字体缺少字形：' + ' '.join(missing[:12]))

    def font_for(char):
        return primary if private_font or supported is None or ord(char[0]) in supported else fallback

    tracking = style.get('tracking', 0)

    def measure(line):
        if not line:
            return 0
        if not tracking and all(font_for(char) is font_for(line[0]) for char in line):
            return font_for(line[0]).getlength(line)
        parts = glyphs(line)
        return sum(max(1, font_for(part).getlength(part)+tracking) for part in parts[:-1]) + (
            font_for(parts[-1]).getlength(parts[-1]) if parts else 0)

    width = style.get('box', {}).get('width')
    lines = []
    for paragraph in style['content'].split('\n'):
        if width is None or measure(paragraph) <= width:
            lines.append(paragraph)
            continue
        line = ''
        for token in re.findall(r"[^\S\n]+|[A-Za-z0-9]+(?:[-’'][A-Za-z0-9]+)*|.", paragraph):
            if measure(line+token) <= width:
                line += token
                continue
            if line.strip():
                lines.append(line.rstrip())
            line = ''
            if not token.strip():
                continue
            for part in glyphs(token):
                if line and measure(line+part) > width:
                    lines.append(line)
                    line = ''
                line += part
        lines.append(line.rstrip())

    widths = [measure(line) for line in lines]
    ascent, descent = primary.getmetrics()
    if not private_font:
        ascent = max(ascent, fallback.getmetrics()[0])
        descent = max(descent, fallback.getmetrics()[1])
    leading = style.get('leading') or round(size*1.25)
    width = width or math.ceil(max(widths))
    height = style.get('box', {}).get('height') or ascent+descent+leading*(len(lines)-1)
    align = {'left':0, 'center':.5, 'right':1}[style['align']]
    runs = []
    for index, (line, length) in enumerate(zip(lines, widths)):
        if not line:
            continue
        x = max(0, width-length)*align
        y = ascent+index*leading
        if not tracking and all(font_for(char) is font_for(line[0]) for char in line):
            runs.append((x,y,line,font_for(line[0])))
            continue
        for part in glyphs(line):
            font = font_for(part)
            runs.append((x,y,part,font))
            x += max(1, font.getlength(part)+tracking)
    return width,height,runs


def shadow_mask(mask, offset, blur):
    shifted = Image.new('L',mask.size)
    shifted.paste(mask,offset)
    return shifted.filter(ImageFilter.GaussianBlur(blur))


def gradient_axes(x,y,bounds,angle):
    l,t,r,b = bounds
    angle = math.radians(angle)
    dx,dy = math.cos(angle),math.sin(angle)
    span = max(1,abs(dx)*(r-l)+abs(dy)*(b-t))
    return (x-(l+r-1)/2)*dx/span, (y-(t+b-1)/2)*dy/span


def render_text(style, fallback_path, output, primary_path=None):
    if not any(key in style for key in ('font','tracking','leading','box','effects')):
        return render_legacy_text(style, fallback_path, output)
    width,height,runs = text_layout(style, fallback_path, primary_path or fallback_path)
    effects = style.get('effects', {})
    outline,shadow = effects.get('outline'),effects.get('shadow')
    stroke = outline['width'] if outline else 0
    margin = stroke+2
    left,top,right,bottom = -margin,-margin,width+margin,height+margin
    for x,y,line,font in ([] if 'box' in style else runs):
        l,t,r,b = font.getbbox(line, anchor='ls', stroke_width=stroke)
        left,top,right,bottom = min(left, x+l-2),min(top, y+t-2),max(right, x+r+2),max(bottom, y+b+2)
    box = (0,0,width,height) if 'box' in style else None
    if shadow:
        blur = shadow['blur']*3
        left += min(0, shadow['x']-blur)
        right += max(0, shadow['x']+blur)
        top += min(0, shadow['y']-blur)
        bottom += max(0, shadow['y']+blur)
    left,top = math.floor(left),math.floor(top)
    width,height = max(41,math.ceil(right)-left),max(41,math.ceil(bottom)-top)
    if width>8192 or height>8192 or width*height>16_777_216:
        raise ValueError('文字超出贴图尺寸，请缩小字号、段落框或样式范围')
    size = (width,height)
    def draw_mask(stroke_width=0):
        bounds = (-stroke_width,-stroke_width,box[2]+stroke_width,box[3]+stroke_width) if box else (left,top,right,bottom)
        x0,y0,x1,y1 = map(math.ceil,bounds)
        tile = Image.new('L',(x1-x0,y1-y0))
        draw = ImageDraw.Draw(tile)
        for x,y,line,font in runs:
            if y-font.getmetrics()[0] >= y1:
                break
            draw.text((x-x0,y-y0),line,font=font,anchor='ls',fill=255,stroke_width=stroke_width,stroke_fill=255)
        mask = Image.new('L',size)
        mask.paste(tile,(x0-left,y0-top))
        return mask

    ink = draw_mask()
    if ink.getbbox() is None:
        raise ValueError('文字没有可用字形')

    def colored(mask, value):
        layer = Image.new('RGBA',size,value)
        layer.putalpha(mask)
        return layer

    image = Image.new('RGBA', size)
    outline_mask = ink
    if outline:
        outline_mask = draw_mask(stroke)
    if shadow:
        mask = shadow_mask(outline_mask,(shadow['x'],shadow['y']),shadow['blur'])
        image.alpha_composite(colored(mask.point(lambda n: n*shadow['opacity']/100),shadow['color']))
    if outline:
        image.alpha_composite(colored(ImageChops.subtract(outline_mask,ink),outline['color']))
    gradient = effects.get('gradient')
    if gradient:
        l,t,r,b = ink.getbbox()
        angle = math.radians(gradient['angle'])
        dx,dy = math.cos(angle),math.sin(angle)
        x = np.arange(width,dtype=np.float32)-(l+r-1)/2
        y = np.arange(height,dtype=np.float32)-(t+b-1)/2
        span = max(1,abs(dx)*(r-l)+abs(dy)*(b-t))
        mix = np.clip(.5+(y[:,None]*dy+x[None,:]*dx)/span,0,1)
        colors = np.array([ImageColor.getrgb(gradient[key]) for key in ('start','end')],dtype=np.float32)
        fill = Image.fromarray(np.rint(colors[0]+mix[:,:,None]*(colors[1]-colors[0])).astype(np.uint8)).convert('RGBA')
        fill.putalpha(ink)
    else:
        fill = colored(ink,effects.get('overlay',{}).get('color',style['color']))
    image.alpha_composite(fill)
    image.save(output,'PNG')
    return (-left,-top)


if __name__=='__main__':
    if sys.argv[1] == '--inspect':
        try:
            print(json.dumps(inspect_font(Path(sys.argv[2]))))
        except (OSError, KeyError, ValueError) as error:
            print(str(error), file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    try:
        style = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        origin = render_text(style, Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]) if len(sys.argv)>4 else None)
        print(json.dumps(origin))
    except ValueError as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
