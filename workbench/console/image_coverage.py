"""Read-only image coverage observations, not semantic or aesthetic acceptance."""
import numpy as np

def ink_pixels(art, basecoat=None):
 rgb=art[:,:,:3]
 ink=(np.abs(rgb.astype('int16')-np.array(basecoat)).max(axis=2)>24) if basecoat is not None else (rgb.max(axis=2)>24)
 return ink&(art[:,:,3]>0)

def coverage_diagnostics(art, receiver, protected):
 if art.ndim != 3 or art.shape[2] != 4 or art.shape[:2] != receiver.shape or receiver.shape != protected.shape:
  raise ValueError('Coverage masks must match the registered RGBA image')
 scope=receiver.astype(bool)&~protected.astype(bool)
 transparent=scope&(art[:,:,3]<254.5)
 dark=scope&~transparent&(art[:,:,:3].max(axis=2)<=24)
 stats={'receiverPixels':int(scope.sum()),'transparentPixels':int(transparent.sum()),'darkPixels':int(dark.sum()),'alphaThreshold':254.5,'darkThreshold':24,'scope':'Registered view receiver excluding protected pixels. Dark pixels may be intentional artwork; this is not semantic coverage or UV visibility.'}
 preview=np.full((*scope.shape,3),22,dtype=np.uint8)
 preview[scope]=180;preview[dark]=64;preview[protected.astype(bool)]=110
 y,x=np.indices(scope.shape);stripe=((x+y)//8)%2==0
 preview[transparent&stripe]=255;preview[transparent&~stripe]=30
 return stats,preview
