# coding: utf-8
"""Geometry preparation and whole-image diagnostics. Never edits source artwork/UV."""
from pathlib import Path
import sys,json,hashlib,zipfile
import numpy as np
from PIL import Image,ImageFilter,ImageDraw
from image_coverage import coverage_diagnostics,ink_pixels
from material_channels import prepare_channels,sample_scalar,scalar_canvas

cfg=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'));op=sys.argv[1]
out=Path(cfg['out']);out.mkdir(parents=True,exist_ok=True)
def sha(path):
 digest=hashlib.sha256()
 with Path(path).open('rb') as stream:
  while chunk:=stream.read(1024*1024):digest.update(chunk)
 return digest.hexdigest()
def write(name,value):
 (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def image(p):
 im=Image.open(p);im.load()
 if max(im.size)>8192 or min(im.size)<1:raise ValueError('Image dimensions outside supported range')
 return im
def mask(p):return np.array(image(p).convert('RGB')).max(axis=2)>127
if op=='prepare':
 source=cfg['source'];guide=Path(source['bundle'])/'top'
 sil=mask(guide/'silhouette.png');receiver=mask(guide/'receiver.png');protected=mask(guide/'protected.png')
 ys,xs=np.where(sil)
 if not len(xs):raise ValueError('Empty registered silhouette')
 h,w=sil.shape;pad=24;rect=[max(0,int(xs.min())-pad),max(0,int(ys.min())-pad),min(w,int(xs.max())+pad+1),min(h,int(ys.max())+pad+1)]
 if source.get('imageFrame')=='canonical':rect=[0,0,w,h]
 radius=cfg['safetyPixels'];k=radius*2+1
 padded=np.pad((sil&receiver&~protected).astype('int32'),radius,mode='constant')
 integral=np.pad(padded,((1,0),(1,0))).cumsum(0).cumsum(1)
 counts=integral[k:,k:]-integral[:-k,k:]-integral[k:,:-k]+integral[:-k,:-k]
 safe=Image.fromarray((counts==k*k).astype('uint8')*255)
 facing=image(guide/'facing.png').convert('RGB');face=np.array(facing);face[~sil]=0
 guide_image=Image.fromarray(face);guide_image.save(out/'guide-full.png');guide_image.crop(rect).save(out/'guide.png')
 for name in ['silhouette','facing','receiver','protected']:image(guide/(name+'.png')).save(out/(name+'-full.png'));image(guide/(name+'.png')).crop(rect).save(out/(name+'.png'))
 safe.save(out/'safe-full.png');safe.crop(rect).save(out/'safe.png')
 # A separate visible overlay; the guide/raw generation is never cropped to a result mask.
 edge=Image.fromarray(sil.astype('uint8')*255).filter(ImageFilter.FIND_EDGES)
 overlay=Image.new('RGBA',(w,h),(255,255,255,0));overlay.putalpha(edge);overlay.save(out/'outline.png')
 write('frame.json',{'canonicalSize':[w,h],'rect':rect,'guideSize':[rect[2]-rect[0],rect[3]-rect[1]],'safetyPixels':cfg['safetyPixels'],'scope':'示例模型 registered top view only; safety is planning guidance, not semantic detection.'})
elif op=='register':
 raw=image(cfg['image']).convert('RGBA');frame=cfg['frame'];w,h=frame['canonicalSize'];x0,y0,x1,y1=frame['rect']
 scale=min((x1-x0)/raw.width,(y1-y0)/raw.height);rw=max(1,round(raw.width*scale));rh=max(1,round(raw.height*scale));x=x0+((x1-x0)-rw)//2;y=y0+((y1-y0)-rh)//2
 registered=Image.new('RGBA',(w,h));registered.alpha_composite(raw.resize((rw,rh),Image.Resampling.BICUBIC),(x,y));registered.save(out/'registered.png')
 write('registration.json',{'originalSize':list(raw.size),'canonicalSize':[w,h],'scale':scale,'offset':[x,y],'registeredSize':[rw,rh],'method':'complete uniform fit inside frozen guide frame; no crop, nonuniform stretch or silhouette erasure','originalSha256':sha(cfg['image'])})
elif op=='material-check':
 for spec in cfg['material']['surface'].values():scalar_canvas(spec,cfg['material']['registration'],cfg['materialDirectory'])
elif op=='preview':
 source=cfg['source'];cache=Path(source['cacheRun']);bundle=Path(source['bundle']);geo=json.loads((cache/'geometry_report.json').read_text(encoding='utf-8'))
 if not geo.get('uv_unchanged'):raise ValueError('Registered cache did not preserve original UV')
 resolved=json.loads((cache/'resolved_config.json').read_text(encoding='utf-8'));cameras=json.loads((bundle/'cameras.json').read_text(encoding='utf-8'))
 material=next(m for m in geo['materials'] if m['name']==source['material']);vi=geo['view_names'].index('top');view=cameras['views']['top'];options=resolved['designs']['top']
 mapping=np.load(cache/'mapping'/(material['file']+'.npz'));faces=np.load(cache/'mapping/faces.npz')
 base=np.array(image(source['baseImage']).convert('RGB'));owner=mapping['owner'];xyz=mapping['xyz'];protected=mapping['protected'].astype(bool);collision=mapping['collision'].astype(bool)
 if owner.shape!=base.shape[:2]:raise ValueError('Original texture size differs from registered UV cache')
 art=np.array(image(cfg['registered']).convert('RGBA'));ah,aw=art.shape[:2];receiver=mask(bundle/'top/receiver.png');protected_view=mask(bundle/'top/protected.png')
 choices=faces['choice'];valid=(owner>=0)&~protected&~collision
 ids=np.flatnonzero(valid.ravel());ids=ids[choices[owner.ravel()[ids]]==vi]
 result=base.copy();flat=result[::-1].copy().reshape(-1,3);written=np.zeros(owner.size,dtype=bool);center=np.array(cameras['center']);right=np.array(view['right']);up=np.array(view['up']);scores=faces['scores']
 scalar_source,scalar_uv=prepare_channels(cfg.get('material'),(cfg.get('material') or {}).get('registration'),owner.shape,cfg.get('materialDirectory'))
 eligible=0
 for off in range(0,len(ids),200000):
  ix=ids[off:off+200000];p=xyz.reshape(-1,3)[ix]-center;u=p@right/view['span']+.5;v=p@up/view['span']+.5
  if options.get('flip_u'):u=1-u
  if options.get('flip_v'):v=1-v
  ok=np.isfinite(u)&np.isfinite(v)&(u>=0)&(u<=1)&(v>=0)&(v<=1)&(scores[owner.ravel()[ix],vi]>=resolved.get('grazing_cos',.2))
  px=np.clip(u,0,1)*(aw-1);py=(1-np.clip(v,0,1))*(ah-1);xx=px.astype(int);yy=py.astype(int)
  rx=np.clip((u*(receiver.shape[1]-1)).astype(int),0,receiver.shape[1]-1);ry=np.clip(((1-v)*(receiver.shape[0]-1)).astype(int),0,receiver.shape[0]-1)
  ok &= receiver[ry,rx]&~protected_view[ry,rx];eligible+=int(ok.sum())
  xx1=np.minimum(xx+1,aw-1);yy1=np.minimum(yy+1,ah-1);dx=(px-xx)[:,None];dy=(py-yy)[:,None]
  values=(art[yy,xx]*(1-dx)+art[yy,xx1]*dx)*(1-dy)+(art[yy1,xx]*(1-dx)+art[yy1,xx1]*dx)*dy
  ok &= values[:,3]>=254.5
  for name,field in scalar_source.items():scalar_uv[name][ix[ok]]=sample_scalar(field,xx,yy,xx1,yy1,dx,dy)[ok]
  ix=ix[ok];flat[ix]=np.rint(values[ok,:3]).clip(0,255).astype('uint8');written[ix]=True
 result=flat.reshape(base.shape)[::-1];write_mask=written.reshape(owner.shape)[::-1]
 assert np.array_equal(result[~write_mask],base[~write_mask]);assert not written.reshape(owner.shape)[protected].any()
 Image.fromarray(result).save(out/'f_16xl_BaseColor.png');Image.fromarray(write_mask.astype('uint8')*255).save(out/'write-mask.png')
 material_report=None
 if scalar_uv:
  material_report={k:cfg['material'][k] for k in ['id','sha256','rawSha256','bindingFingerprint','styleAssessment','base','surface']}
  material_report['channels']={}
  for name,values in scalar_uv.items():
   result_scalar=values.reshape(owner.shape)[::-1];expected=round(cfg['material']['base'][name]*255)
   assert np.all(result_scalar[~write_mask]==expected)
   filename='f_16xl_'+name+'.png';Image.fromarray(result_scalar).save(out/filename)
   material_report['channels'][name]={'file':filename,'sha256':sha(out/filename),'colorSpace':'Non-Color','baseValue':cfg['material']['base'][name],'unwrittenEqualsBase':True,'writtenTexels':int(write_mask.sum())}
 if not write_mask.any():raise ValueError('No eligible top-view UV pixels; refusing empty preview')
 # Ink spill is a diagnostic heuristic, never an artwork score or semantic safety pass.
 canonical_sil=mask(bundle/'top/silhouette.png');rgb=art[:,:,:3];ink=ink_pixels(art);ink_metric='nonblack'
 if source.get('basecoat'):
  ink=ink_pixels(art,source['basecoat']['rgb']);ink_metric='difference_from_basecoat'
 coverage,coverage_image=coverage_diagnostics(art,receiver,protected_view)
 Image.fromarray(coverage_image).save(out/'coverage-guide.png')
 spill=int((ink&~canonical_sil).sum());total=int(ink.sum())
 write('report.json',{'roundId':cfg['roundId'],'bindingFingerprint':cfg['bindingFingerprint'],'rawSha256':cfg['rawSha256'],'uvColorSha256':sha(out/'f_16xl_BaseColor.png'),'uv_unchanged':True,'source_saved':False,'material':material_report,'basecoat':source.get('basecoat'),'coverage':coverage,'writtenTexels':int(write_mask.sum()),'eligibleTexels':eligible,'protectedTexelsWritten':0,'unwrittenPixelsUnchanged':True,'blockedSharedUvTexels':int(collision.sum()),'inkMetric':ink_metric,'inkThreshold':24,'inkOutsideSilhouettePixels':spill,'inkOutsideFraction':spill/max(total,1),'scope':'Registered 示例模型 top receiver only. All UV collisions conservatively excluded; other pixels preserved.','limitations':['Ink spill uses '+ink_metric+' with RGB threshold 24; not silhouette IoU, text/face completeness or art acceptance.','Face/camera registration is reused from the verified cache; visibility is not an independent per-pixel semantic proof.','No unmarked face/text detection. Adopt only after human comparison of the original, full generated image and 3D result.']})
elif op=='package':
 report=cfg['report'];report['fileSha256']={name:sha(p) for name,p in cfg['files'].items()};write('delivery-report.json',report)
 with zipfile.ZipFile(out/'delivery.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
  for name,p in cfg['files'].items():z.write(p,name,compress_type=zipfile.ZIP_STORED if name.endswith('.exr') else zipfile.ZIP_DEFLATED)
  z.write(out/'delivery-report.json','delivery-report.json')
else:raise ValueError('Unknown image workflow operation')
print(json.dumps({'operation':op,'out':str(out)},ensure_ascii=False),flush=True)
