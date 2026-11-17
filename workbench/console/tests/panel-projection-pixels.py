"""Pixel checks at known points of the folded panel; glTF UV0 is top-down here."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def pattern(folder):
    im = Image.new('RGB',(128,128),'#273342')
    pen = ImageDraw.Draw(im)
    for y,color in [(16,'#ed9543'),(80,'#56babd')]:
        pen.rectangle((0,y-12,127,y+22),fill=color)
        for x in [8,72]:
            pen.polygon([(x,y),(x+22,y),(x+22,y-6),(x+35,y+5),(x+22,y+16),(x+22,y+10),(x,y+10)], fill='#faf2d5')
    im.save(folder/'color.png')
    Image.new('RGB',(16,16),(194,128,237)).save(folder/'normal.png')


def ghost_error(frame,tex):
    # Left flat face only. A sample counts when all four bilinear taps read the
    # dark background on the dominant plane and white arrow ink on one side plane.
    row,col=np.mgrid[28:228,28:95]
    x=(((16*col+8.5)/4096)-.5)/.4
    y=(((16*row+7.5)/4096)-.5)/.4
    rx,ry,rz=np.radians([22,-16,35])
    def rotation(axis,angle):
        m=np.eye(3)
        a,b=(axis+1)%3,(axis+2)%3
        m[a,a]=m[b,b]=np.cos(angle)
        m[a,b],m[b,a]=-np.sin(angle),np.sin(angle)
        return m
    rot=rotation(2,rz)@rotation(1,ry)@rotation(0,rx)
    q=np.stack([x,y,np.full(x.shape,.095)],axis=-1)@rot/(2*.57)
    n=np.array([0,0,1])@rot
    def uniform(axis,rgb):
        a,b=(axis+1)%3,(axis+2)%3
        u=.5+np.sign(n[axis])*q[:,:,a]
        v=.5+q[:,:,b]
        ix=np.floor((u%1)*128-.5).astype(int)
        iy=np.floor((1-v%1)*128-.5).astype(int)
        return np.logical_and.reduce([(tex[(iy+j)%128,(ix+i)%128]==rgb).all(axis=2)
                                      for i in (0,1) for j in (0,1)])
    bg=[39,51,66]; arrow=[250,242,213]
    mask=uniform(2,bg)&((uniform(0,arrow)&uniform(1,bg))|(uniform(1,arrow)&uniform(0,bg)))
    return mask.sum(),np.abs(frame[row[mask],col[mask],:3].astype(float)-bg).mean()


def check(folder):
    def live(name):
        return np.fromfile(folder/(name+'.raw'),np.uint8).reshape(256,256,15)
    uv,tri,hard,final = map(live,['uv','tri','hard','final'])
    # Same physical edge, opposite ends of a turned island. 256px rows use
    # the 4K registration's center texel, so mirroring incurs a subpixel offset.
    rows=np.arange(40,216)
    def seam(frame):
        return np.abs(frame[rows,199,:3].astype(float)-frame[255-rows,229,:3]).mean()
    before,after=seam(uv),seam(tri)
    assert before>40 and after<before*.2,(before,after)
    # Compare the colors on the two 45-degree walls with two independent 2D
    # lookups on the known printed pattern, blended in linear light.
    tex=np.array(Image.open(folder/'color.png'))/255
    tex=np.where(tex<=.04045,tex/12.92,((tex+.055)/1.055)**2.4)
    def texel(u,v):
        x,y=(u%1)*128-.5,(1-v%1)*128-.5
        a,b=int(np.floor(x)),int(np.floor(y));fx,fy=x-a,y-b
        return sum(tex[(b+j)%128,(a+i)%128]*(fx if i else 1-fx)*(fy if j else 1-fy)
                   for i in [0,1] for j in [0,1])
    changed=0
    for row in [68,88,115,161,177]:
        for col in [109,118,138,149]:
            x=(((16*col+8.5)/4096)-.5)/.4
            y=(((16*row+7.5)/4096)-.5)/.4
            z=abs(x)-.25
            top=texel(.5+x/2,.5+y/2)
            side=texel(.5+(1 if x<0 else -1)*y/2,.5+(z+.095)/2)
            mixed=(top+side)/2
            expected=np.rint(np.where(mixed<=.0031308,12.92*mixed,1.055*mixed**(1/2.4)-.055)*255)
            np.testing.assert_allclose(tri[row,col,:3],expected,atol=1,rtol=0)
            changed+=int(np.any(hard[row,col,:3]!=tri[row,col,:3]))
    assert changed>0
    # A 180-degree UV-island rotation flips both tangent-space slopes, while
    # the same projected world normal must remain continuous.
    left,right=tri[128,198,6:9],tri[127,229,6:9]
    np.testing.assert_allclose(left[:2].astype(int)+right[:2],255,atol=1,rtol=0)
    assert left[0]>160 and left[2]==right[2]
    # In this fixed browser camera the atlas contact crosses the cyan stripe.
    # Require a seam in the UV control (catches camera drift), then measure the
    # actually rendered tri-planar pixels, including filtered normal shading.
    uv_view=np.asarray(Image.open(folder/'uv-view.png').convert('RGB')).astype(int)
    tri_view=np.asarray(Image.open(folder/'tri-view.png').convert('RGB')).astype(int)
    for x,y in [(619,385),(611,390),(602,395),(593,400)]:
        assert np.abs(uv_view[y,x-7]-uv_view[y,x+7]).max()>80
        assert np.abs(tri_view[y,x-3:x+4]-tri_view[y,x-7]).max()<=2
    # Read the actual 4K PNGs, including empty UV and both sides of the fold.
    count,ghost=ghost_error(final,np.array(Image.open(folder/'color.png')))
    assert count==655 and ghost<5,(count,ghost)
    errors=[]
    for key,cols in [('color',slice(0,3)),('normal',slice(6,9))]:
        im=np.array(Image.open(folder/('baked-'+key+'.png')).convert('RGB'))
        assert im.shape==(4096,4096,3)
        sampled=im[7::16,8::16]
        diff=np.abs(sampled.astype(int)-final[:,:,cols])
        # Other lower layers can sample UV bitmaps at different resolutions.
        inside=np.s_[26:230,26:230]
        assert diff[inside].max()==0,(key,diff[inside].max())
        # The turned island ends at U=.9. Check every padding texel along
        # the straight section, independent of framebuffer origin and lighting.
        for atlas,radius in [(final[:,:,cols],2),(im,32)]:
            size=len(atlas)
            first_empty=int(np.ceil(.9*size-.5))
            edge=atlas[40*size//256:216*size//256,first_empty-1:first_empty]
            gutter=atlas[40*size//256:216*size//256,first_empty:first_empty+radius]
            assert np.all(gutter==edge),key
        errors.append(int(diff[inside].max()))
    print('Wide-blend side arrow on dark background: %d samples, mean RGB error %.2f'%(count,ghost))
    print('UV/tri seam mean RGB difference %.2f / %.2f; folded-wall samples 20; 4K color/normal max difference %s'%
          (before,after,errors))


if __name__=='__main__':
    (pattern if sys.argv[1]=='pattern' else check)(Path(sys.argv[2]))
