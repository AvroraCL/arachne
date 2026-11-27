import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {imageDocumentOperation,validateImageDocuments,surfaceToImageCommand,hasImageLayerMask,imageDocumentLimit,imageClippingBase} from '../public/image-documents.mjs';
import {imageDocumentInput,materialFingerprint} from '../paint.mjs';
import {newImageAdjustment,checkImageAdjustment,imageBlendModes} from '../public/image-adjustments.mjs';
import {mapImageMaskPoint} from '../public/image-warp.mjs';
test('sparse replay keeps opacity, erasing, and transform order across batch flushes',()=>{
 const script=`import numpy as np
from image_documents import ImageSurface, composite_document

def dab(x,y,color,opacity=.55,erase=False):
 return dict(uv=True,stamps=[[x,y],[x+.008,y+.004]],radius=.024,hardness=.6,opacity=opacity,color=color,erase=erase)

strokes=[dab(.15+(i%20)*.035,.16+(i//20)*.07,'#ba5c2b') for i in range(180)]
strokes += [
 dab(.325,.3,'#e2c875',.9,True),
 dict(clearUV=[.25,.2,.45,.42],feather=8),
 dict(transformUV=dict(rect=[.1,.1,.7,.55],offset=[.1,-.08],scale=[.84,.91],angle=12,copy=False,interpolation='linear')),
 dab(.37,.42,'#2381b4',.7),
 {**dab(.39,.44,'#c8b82e',.8),'preserveAlpha':True},
]
layer=dict(id='paint',kind='pixel',visible=True,opacity=.83,blend='normal',maskEnabled=False,strokes=strokes)
doc=dict(colorSpace='srgb',layers=[layer])
baseline=composite_document(doc,{},256)
ImageSurface.paint_batch_size=8
ImageSurface.paint_batch_pixels=0
assert np.array_equal(baseline,composite_document(doc,{},256))
ImageSurface.paint_batch_size=128
ImageSurface.paint_batch_pixels=2000
assert np.array_equal(baseline,composite_document(doc,{},256))
assert baseline[:,:,3].max()>100 and baseline[:,:,3].min()==0
`;
 const result=spawnSync(process.env.ARACHNE_PYTHON||'python',['-B','-c',script],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
const defaults=()=>({layers:[],assets:{}}),options={requireUnlocked:()=>{}},checks={checkStroke:s=>{assert.equal(s.uv,true);assert.ok(s.rect||s.stamps);},checkedUVTransform:t=>assert.ok(t.rect)};
const edit=(paint,action,extra={})=>imageDocumentOperation(paint,{op:'image',documentId:'doc',action,...extra},options);
test('a linked mask follows repeated perspective and mesh edits, retaining the canvas space of newer strokes',()=>{
 const paint=defaults(),layerId='shape';
 const shape={kind:'rectangle',width:1024,height:1024,fill:'#ed6a25',stroke:null,strokeWidth:0,cornerRadius:0};
 const perspective={mode:'perspective',points:[[.22,.04],[.92,.12],[1,1],[0,1]]};
 const mesh={mode:'mesh',points:[[0,0],[.5,0],[1,0],[0,.5],[.72,.61],[1,.5],[0,1],[.5,1],[1,1]]};
 const mark=(rect,value)=>edit(paint,'stroke',{layerId,target:'mask',stroke:{uv:true,rect,opacity:1,value}});
 const update=patch=>edit(paint,'updateLayer',{layerId,patch});
 const source=[.5,.5],gradient={kind:'linear',start:[.32,.32],end:[.67,.68],colors:['#cccccc','#ffffff'],alpha:[1,1]};
 edit(paint,'create');
 edit(paint,'addLayer',{layerId,kind:'shape',patch:{shape,scale:.6,maskGradient:gradient,maskEnabled:true}});
 mark([.46,.46,.54,.54],0);
 update({warp:perspective});
 const layer=paint.imageDocuments.doc.layers[0],firstPoint=mapImageMaskPoint(layer,layer.maskStrokes[0],source);
 assert.ok(Math.hypot(firstPoint[0]-.537615,firstPoint[1]-.477064)<1e-5);
 mark([firstPoint[0]-.012,firstPoint[1]-.012,firstPoint[0]+.012,firstPoint[1]+.012],1);
 update({warp:mesh});
 update({x:.53});
 const first=mapImageMaskPoint(layer,layer.maskStrokes[0],source);
 const second=mapImageMaskPoint(layer,layer.maskStrokes[1],firstPoint);
 assert.ok(Math.hypot(first[0]-.662,first[1]-.566)<1e-8);
 assert.ok(Math.hypot(first[0]-second[0],first[1]-second[1])<1e-8);
 const back=mapImageMaskPoint(layer,layer.maskStrokes[0],first,true);
 assert.ok(Math.hypot(back[0]-.5,back[1]-.5)<1e-8);
 const sampled=[first,mapImageMaskPoint(layer,layer.maskStrokes[0],[.528,.5])];
 const guide=mapImageMaskPoint(layer,layer.maskGradient,gradient.start);
 const beforeReset=structuredClone(paint.imageDocuments.doc);
 update({warp:null});
 const restored=mapImageMaskPoint(layer,layer.maskStrokes[0],source);
 assert.ok(Math.hypot(restored[0]-.53,restored[1]-.5)<1e-8);
 validateImageDocuments(paint,checks);
 const script=`import json, sys
from image_documents import composite_document
before, after, probes, restored, guide = json.load(sys.stdin)
def at(image, point, channel):
 x,y = point
 return int(image[int(y*512),int(x*512),channel])
first = composite_document(before,{},512)
second = composite_document(after,{},512)
assert at(first,probes[0],3)==255 and at(first,probes[1],3)==0
assert at(second,restored,3)==255
mask = composite_document(before,{},512,'shape')
assert abs(at(mask,guide,0)-204)<=1, at(mask,guide,0)
`;
 const result=spawnSync(process.env.ARACHNE_PYTHON||'python',['-B','-c',script],{
   cwd:new URL('../',import.meta.url),encoding:'utf8',input:JSON.stringify([beforeReset,paint.imageDocuments.doc,sampled,restored,guide])
 });
 assert.equal(result.status,0,result.stderr);
});
test('alpha locking is recorded per pixel stroke without restricting independent mask edits',()=>{
 const paint=defaults(),layerId='pixels',stroke={uv:true,rect:[0,0,1,1],opacity:1,color:'#114477',erase:false};
 edit(paint,'create');
 edit(paint,'addLayer',{layerId,kind:'pixel',patch:{alphaLocked:true}});
 edit(paint,'stroke',{layerId,target:'pixels',stroke});
 edit(paint,'stroke',{layerId,target:'mask',stroke:{uv:true,rect:[0,0,1,1],opacity:1,value:.5}});
 assert.throws(()=>edit(paint,'stroke',{layerId,target:'pixels',stroke:{...stroke,erase:true}}),/解锁透明像素/);
 assert.throws(()=>edit(paint,'clear',{layerId,rect:stroke.rect}),/解锁透明像素/);
 edit(paint,'updateLayer',{layerId,patch:{alphaLocked:false}});
 edit(paint,'stroke',{layerId,target:'pixels',stroke});
 const layer=paint.imageDocuments.doc.layers[0];
 assert.deepEqual(layer.strokes.map(item=>item.preserveAlpha),[true,undefined]);
 assert.equal(layer.maskStrokes[0].preserveAlpha,undefined);
 validateImageDocuments(paint,checks);
});
test('clipping groups follow adjacent layers and hidden bases cannot clip against another visible layer',()=>{
 const paint=defaults();
 edit(paint,'create');
 for(const layerId of ['other','base','color','detail'])edit(paint,'addLayer',{layerId,kind:'pixel'});
 assert.throws(()=>edit(paint,'setClipping',{layerId:'other',clipped:true}),/下方的底层/);
 for(const layerId of ['color','detail'])edit(paint,'setClipping',{layerId,clipped:true});
 const layers=paint.imageDocuments.doc.layers;
 assert.equal(imageClippingBase(layers,3).id,'base');
 edit(paint,'addLayer',{layerId:'between',kind:'pixel',index:3});
 assert.equal(layers[3].clipped,true);
 edit(paint,'duplicateLayer',{layerId:'base',patch:{id:'copy'}});
 assert.equal(layers.at(-1).id,'copy');
 edit(paint,'updateLayer',{layerId:'base',patch:{visible:false}});
 validateImageDocuments(paint,checks);
 const doc={id:'clipping',revision:7,paint};
 assert.deepEqual(imageDocumentInput(doc,{documentId:'doc',revision:7}).paint.imageDocuments.doc.layers.map(layer=>layer.id),['other','copy']);
 const isolated=imageDocumentInput(doc,{documentId:'doc',revision:7,isolatedImageLayer:'color'});
 assert.equal(isolated.paint.imageDocuments.doc.layers[0].clipped,false);
 edit(paint,'setClipping',{layerId:'between',clipped:false});
 assert.equal(layers[2].clipped,true);
 assert.equal(layers[3].clipped,undefined);
 assert.equal(layers[4].clipped,undefined);
 edit(paint,'removeLayer',{layerId:'base'});
 assert.equal(layers[1].clipped,undefined);
 validateImageDocuments(paint,checks);
});
test('image adjustments have independent masks and validate exact parameters without altering pixel layers',()=>{
 const paint=defaults();
 edit(paint,'create');
 edit(paint,'addLayer',{layerId:'pixels',kind:'pixel'});
 const levels={...newImageAdjustment('levels'),inputBlack:16,inputWhite:218,gamma:1.25,channel:'blue'};
 edit(paint,'addLayer',{layerId:'levels',kind:'adjustment',patch:{adjustment:levels,blend:'softLight'}});
 validateImageDocuments(paint,checks);
 const [pixels,layer]=paint.imageDocuments.doc.layers;
 assert.deepEqual(layer.adjustment,levels);
 assert.equal(layer.maskEnabled,true);
 assert.equal(layer.maskBase,1);
 assert.equal(pixels.adjustment,undefined);
 assert.throws(()=>checkImageAdjustment({...levels,inputWhite:16}),/黑场/);
 assert.throws(()=>checkImageAdjustment({...levels,invalid:4}),/参数无效/);
 assert.throws(()=>checkImageAdjustment({...levels,gamma:0}),/中间调/);
 const curves=newImageAdjustment('curves');
 curves.points.red.splice(1,0,[128,180]);
 checkImageAdjustment(curves);
 assert.equal(newImageAdjustment('curves').points.red.length,2);
 assert.throws(()=>checkImageAdjustment({...curves,points:{...curves.points,red:[[0,0],[0,1],[255,255]]}}),/控制点/);
 assert.throws(()=>edit(paint,'stroke',{layerId:'levels',target:'pixels',stroke:{}}),/像素层/);
 assert.equal(new Set(imageBlendModes).size,20);
 checkImageAdjustment({type:'hueSaturation',hue:0,saturation:0,lightness:0});
 assert.throws(()=>checkImageAdjustment({...newImageAdjustment('hueSaturation'),width:0}),/范围半宽/);
 const balance=newImageAdjustment('colorBalance');
 balance.tones.midtones.red=25;
 assert.equal(newImageAdjustment('colorBalance').tones.midtones.red,0);
 assert.throws(()=>checkImageAdjustment({...balance,tones:{midtones:balance.tones.midtones}}),/分区参数/);
});
test('image documents and pixel layers are independent of material layers, binding is explicit and deletion protected',()=>{
 const paint=defaults();edit(paint,'create',{patch:{name:'独立贴图'}});edit(paint,'addLayer',{layerId:'pixel',kind:'pixel'});assert.equal(paint.layers.length,0);assert.equal(paint.imageDocuments.doc.layers[0].kind,'pixel');
 edit(paint,'bind',{channel:'roughness',newLayerId:'material'});assert.equal(paint.layers.length,1);assert.deepEqual(paint.layers[0].documentMaps,{roughness:'doc'});assert.equal(paint.layers[0].channels.roughness,true);assert.throws(()=>edit(paint,'remove'),/仍被材质/);
 edit(paint,'stroke',{layerId:'pixel',target:'pixels',stroke:{uv:true,rect:[0,0,1,1],color:'#112233',opacity:1,erase:false}});validateImageDocuments(paint,checks);assert.equal(paint.layers[0].strokes,undefined);assert.equal(paint.imageDocuments.doc.layers[0].strokes.length,1);
 edit(paint,'updateLayer',{layerId:'pixel',patch:{locked:true}});assert.throws(()=>edit(paint,'stroke',{layerId:'pixel',target:'pixels',stroke:{}}),/锁定/);
});
test('document commands cannot smuggle PBR channels, surface stamps or invalid references into RGBA layers',()=>{
 const paint=defaults();edit(paint,'create');edit(paint,'addLayer',{layerId:'pixel',kind:'pixel'});
 for(const stroke of [{uv:true,stamps:[[.5,.5]],radius:.02,color:'#112233',channels:{roughness:true}},{uv:false,stamps:[[0,0,0,0,0,1]],color:'#112233'}]){const next=structuredClone(paint);edit(next,'stroke',{layerId:'pixel',target:'pixels',stroke});assert.throws(()=>validateImageDocuments(next,checks),/二维 RGB/);}
 edit(paint,'bind',{channel:'color',newLayerId:'material'});paint.layers[0].documentMaps.color='missing';assert.throws(()=>validateImageDocuments(paint,checks),/绑定/);
 const wrapped=surfaceToImageCommand({op:'stroke',id:'pixel',target:'material',stroke:{uv:true,values:{color:'#112233',roughness:.8},channels:{color:true},erase:false,rect:[0,0,1,1],opacity:1}},'doc');assert.equal(wrapped.target,'pixels');assert.equal(wrapped.stroke.color,'#112233');assert.equal(wrapped.stroke.values,undefined);assert.equal(wrapped.stroke.channels,undefined);
});
test('duplicated image documents retain editable data without copying their material bindings',()=>{
 const paint=defaults();
 edit(paint,'create',{patch:{name:'独立贴图',colorSpace:'linear'}});
 const gradient={kind:'linear',start:[.2,.5],end:[.8,.5],colors:['#000000','#ffffff'],alpha:[1,1]};
 edit(paint,'addLayer',{layerId:'pixels',kind:'pixel',patch:{maskEnabled:true,maskGradient:gradient}});
 edit(paint,'stroke',{layerId:'pixels',target:'pixels',stroke:{uv:true,rect:[0,0,1,1],color:'#112233',opacity:1}});
 edit(paint,'stroke',{layerId:'pixels',target:'mask',stroke:{uv:true,rect:[.1,.1,.2,.2],value:0,opacity:1}});
 edit(paint,'bind',{channel:'roughness',newLayerId:'material'});
 const original=structuredClone(paint.imageDocuments.doc);
 edit(paint,'duplicate',{newDocumentId:'copy'});
 edit(paint,'duplicate',{newDocumentId:'another'});
 assert.deepEqual(paint.imageDocuments.copy,{...original,name:'独立贴图 副本'});
 assert.equal(paint.imageDocuments.another.name,'独立贴图 副本 2');
 edit(paint,'invertMask',{documentId:'copy',layerId:'pixels'});
 assert.notDeepEqual(paint.imageDocuments.copy.layers,original.layers);
 assert.deepEqual(paint.imageDocuments.doc,original);
 assert.deepEqual(paint.layers[0].documentMaps,{roughness:'doc'});
 assert.throws(()=>edit(paint,'duplicate',{newDocumentId:'copy'}),/编号无效/);
 for(let i=Object.keys(paint.imageDocuments).length;i<imageDocumentLimit;i++)
  edit(paint,'duplicate',{newDocumentId:'copy-'+i});
 assert.throws(()=>edit(paint,'duplicate',{newDocumentId:'overflow'}),/最多包含/);
 validateImageDocuments(paint,checks);
});
test('mask inversion preserves soft brush coverage and deletion resets only the mask',()=>{
 const paint=defaults();edit(paint,'create');edit(paint,'addLayer',{layerId:'pixel',kind:'pixel'});
 const layer=paint.imageDocuments.doc.layers[0],origin={layerId:'pixel'};
 const stroke={uv:true,stamps:[[.25,.75]],radius:.02,opacity:.5,hardness:.25,value:.25};
 edit(paint,'stroke',{...origin,target:'mask',stroke});
 edit(paint,'updateLayer',{...origin,patch:{maskEnabled:false,maskBase:.75}});
 edit(paint,'invertMask',origin);
 assert.equal(layer.maskEnabled,false);
 assert.equal(layer.maskBase,.25);
 assert.deepEqual(layer.maskStrokes,[{...stroke,value:.75}]);
 validateImageDocuments(paint,checks);
 edit(paint,'updateLayer',{...origin,patch:{locked:true}});
 assert.throws(()=>edit(paint,'removeMask',origin),/锁定/);
 edit(paint,'updateLayer',{...origin,patch:{locked:false}});
 edit(paint,'removeMask',origin);
 assert.equal(hasImageLayerMask(layer),false);
 assert.equal(layer.maskBase,1);
 assert.throws(()=>edit(paint,'invertMask',origin),/没有蒙版/);
});
test('masks can be created from a selection and transferred without aliasing the source',()=>{
 const paint=defaults();edit(paint,'create');
 edit(paint,'addLayer',{layerId:'first',kind:'pixel'});edit(paint,'addLayer',{layerId:'second',kind:'pixel'});
 const [first,second]=paint.imageDocuments.doc.layers;
 const rect=[.1,.1,.8,.7],polygon=[[.1,.1],[.8,.1],[.5,.7]];
 edit(paint,'createMask',{layerId:'first',reveal:true,rect,polygon});
 assert.equal(first.maskBase,0);assert.deepEqual(first.maskStrokes,[{uv:true,rect,polygon,opacity:1,value:1}]);
 edit(paint,'createMask',{layerId:'second',reveal:false});
 assert.equal(second.maskBase,0);assert.equal(second.maskStrokes,undefined);
 edit(paint,'updateLayer',{layerId:'first',patch:{locked:true}});
 assert.throws(()=>edit(paint,'transferMask',{layerId:'second',sourceLayerId:'first',copy:false}),/锁定/);
 edit(paint,'transferMask',{layerId:'second',sourceLayerId:'first',copy:true});
 assert.deepEqual(second.maskStrokes,first.maskStrokes);
 edit(paint,'invertMask',{layerId:'second'});
 assert.equal(first.maskStrokes[0].value,1);assert.equal(second.maskStrokes[0].value,0);
 edit(paint,'updateLayer',{layerId:'first',patch:{locked:false}});
 edit(paint,'transferMask',{layerId:'second',sourceLayerId:'first',copy:false});
 assert.equal(hasImageLayerMask(first),false);
 assert.equal(second.maskStrokes[0].value,1);
 validateImageDocuments(paint,checks);
});
test('gradient masks preserve brush strokes and invert the entire mask',()=>{
 const paint=defaults();edit(paint,'create');edit(paint,'addLayer',{layerId:'pixel',kind:'pixel'});
 const layer=paint.imageDocuments.doc.layers[0],origin={layerId:'pixel'};
 const gradient={kind:'linear',start:[.2,.5],end:[.8,.5],colors:['#000000','#cccccc'],alpha:[1,.7]};
 edit(paint,'updateLayer',{...origin,patch:{maskGradient:gradient,maskEnabled:true,maskBase:.6}});
 edit(paint,'stroke',{...origin,target:'mask',stroke:{uv:true,rect:[.1,.1,.2,.2],opacity:.5,value:.2}});
 validateImageDocuments(paint,checks);
 edit(paint,'invertMask',origin);
 assert.deepEqual(layer.maskGradient.colors,['#ffffff','#333333']);
 assert.deepEqual(layer.maskGradient.alpha,[1,.7]);
 assert.equal(layer.maskBase,.4);
 assert.equal(layer.maskStrokes[0].value,.8);
 const doc={id:'gradient-mask',revision:3,paint},isolated=imageDocumentInput(doc,{revision:3,documentId:'doc',inspectMask:'pixel'});
 assert.deepEqual(isolated.paint.imageDocuments.doc.layers[0].maskGradient,layer.maskGradient);
 edit(paint,'updateLayer',{...origin,patch:{maskGradient:null}});
 assert.equal(layer.maskGradient,undefined);
 assert.equal(layer.maskStrokes.length,1);
});
test('editable gradient layers validate endpoints and insertion without changing pixel layers',()=>{
 const paint=defaults();edit(paint,'create');edit(paint,'addLayer',{layerId:'pixel',kind:'pixel'});
 const gradient={kind:'linear',start:[.2,.5],end:[.8,.5],colors:['#d08022','#2d63c0'],alpha:[1,0],clip:[.15,.15,.85,.85]};
 edit(paint,'addLayer',{layerId:'ramp',kind:'gradient',index:0,patch:{gradient}});
 validateImageDocuments(paint,checks);
 assert.deepEqual(paint.imageDocuments.doc.layers.map(layer=>layer.id),['ramp','pixel']);
 const updated={...gradient,kind:'radial',alpha:[0,1]};
 edit(paint,'updateLayer',{layerId:'ramp',patch:{gradient:updated}});
 validateImageDocuments(paint,checks);
 assert.deepEqual(paint.imageDocuments.doc.layers[0].gradient,updated);
 assert.throws(()=>edit(paint,'stroke',{layerId:'ramp',target:'pixels',stroke:{}}),/像素层/);
 const doc={id:'rgba-gradient',revision:3,paint};
 const invalid={op:'image',action:'updateLayer',documentId:'doc',layerId:'ramp',patch:{gradient:{...updated,end:updated.start}}};
 assert.throws(()=>imageDocumentInput(doc,{revision:3,documentId:'doc',operation:invalid}),/渐变方向/);
 assert.deepEqual(paint.imageDocuments.doc.layers[0].gradient,updated);
});
test('RGBA live input includes only the layers and assets required for the requested pixels',()=>{
 const paint=defaults(),visibleAsset='1'.repeat(64),hiddenAsset='2'.repeat(64),otherAsset='3'.repeat(64);
 for(const id of [visibleAsset,hiddenAsset,otherAsset])paint.assets[id]={file:'paint-'+id+'.png'};
 edit(paint,'create');
 edit(paint,'addLayer',{layerId:'pixel',kind:'pixel'});
 edit(paint,'addLayer',{layerId:'photo',kind:'image',patch:{asset:visibleAsset,maskEnabled:true,maskBase:.25}});
 edit(paint,'addLayer',{layerId:'hidden',kind:'image',patch:{asset:hiddenAsset,visible:false}});
 edit(paint,'addLayer',{layerId:'transparent',kind:'image',patch:{asset:otherAsset,opacity:0}});
 paint.imageDocuments.other={...paint.imageDocuments.doc,layers:[{...paint.imageDocuments.doc.layers[1],asset:otherAsset}]};
 const doc={id:'rgba-preview-project',revision:3,paint},input=(patch={})=>imageDocumentInput(doc,{documentId:'doc',revision:3,...patch});
 const composite=input();
 assert.deepEqual(Object.keys(composite.paint.imageDocuments),['doc']);
 assert.deepEqual(composite.paint.imageDocuments.doc.layers.map(layer=>layer.id),['pixel','photo']);
 assert.deepEqual(Object.keys(composite.assets),[visibleAsset]);
 assert.equal(composite.source,undefined);
 const thumbnail=input({resolution:64,isolatedImageLayer:'pixel'});
 assert.deepEqual(thumbnail.paint.imageDocuments.doc.layers.map(layer=>layer.id),['pixel']);
 assert.deepEqual(thumbnail.assets,{});
 const mask=input({resolution:64,isolatedImageLayer:'photo',inspectMask:'photo'});
 assert.deepEqual(mask.paint.imageDocuments.doc.layers,[{id:'photo',maskBase:.25,maskStrokes:undefined}]);
 assert.deepEqual(mask.assets,{});
 const window=[0,0,256],movePlane={ids:['hidden','photo'],plane:'content'};
 const lifted=input({window,movePlane}),behind=input({window,movePlane:{...movePlane,plane:'background'}});
 assert.deepEqual(lifted.paint.imageDocuments.doc.layers.map(l=>[l.id,l.maskBase]),[['photo',.25]]);
 assert.deepEqual(Object.keys(lifted.assets),[visibleAsset]);
 assert.deepEqual(behind.paint.imageDocuments.doc.layers.map(l=>l.id),['pixel']);
 assert.deepEqual(behind.assets,{});
 // Even when the selection is passed top first, the underlay ends at the
 // lowest selected layer. A visible stationary layer above it must be excluded.
 paint.imageDocuments.doc.layers.find(l=>l.id==='transparent').opacity=1;
 const under=input({window,movePlane:{...movePlane,plane:'underlay'}});
 assert.deepEqual(under.paint.imageDocuments.doc.layers.map(l=>l.id),['pixel']);
 assert.deepEqual(under.assets,{});
 assert.throws(()=>input({window,movePlane:{ids:['photo','missing'],plane:'content'}}),/移动图层预览选择无效/);
 assert.throws(()=>input({isolatedImageLayer:'missing'}),/图像图层不存在/);
 assert.throws(()=>input({inspectMask:'missing'}),/图像蒙版不存在/);
});
test('image folders preserve sibling order, clipping ownership, nested masks and inherited locks',()=>{
 const paint=defaults();edit(paint,'create');
 for(const layerId of ['base','clip','other'])edit(paint,'addLayer',{layerId,kind:'pixel'});
 edit(paint,'setClipping',{layerId:'clip',clipped:true});
 assert.throws(()=>edit(paint,'groupLayers',{layerId:'folder',layerIds:['clip']}),/对应底层一起成组/);
 edit(paint,'groupLayers',{layerId:'folder',layerIds:['base','clip']});
 edit(paint,'createMask',{layerId:'folder',reveal:false});
 edit(paint,'addLayer',{layerId:'nested',kind:'group',parentId:'folder'});
 edit(paint,'moveLayer',{layerId:'other',anchorId:'nested',placement:'inside'});
 assert.throws(()=>edit(paint,'moveLayer',{layerId:'folder',anchorId:'nested',placement:'inside'}),/移入自身/);
 edit(paint,'updateLayer',{layerId:'folder',patch:{locked:true,visible:false}});
 assert.throws(()=>edit(paint,'updateLayer',{layerId:'other',patch:{opacity:.5}}),/上级组已锁定/);
 const doc={id:'image-folders',revision:1,paint};
 assert.deepEqual(imageDocumentInput(doc,{documentId:'doc',revision:1}).paint.imageDocuments.doc.layers,[]);
 edit(paint,'updateLayer',{layerId:'folder',patch:{locked:false,visible:true}});
 edit(paint,'duplicateLayer',{layerId:'folder',patch:{id:'duplicate'}});
 validateImageDocuments(paint,checks);
 const layers=paint.imageDocuments.doc.layers,copy=layers.find(layer=>layer.id==='duplicate');
 assert.equal(copy.maskBase,0);
 const nested=layers.find(layer=>layer.parentId==='duplicate'&&layer.kind==='group');
 assert.ok(nested&&nested.id!=='nested'&&layers.some(layer=>layer.parentId===nested.id&&layer.id!=='other'));
 const isolated=imageDocumentInput(doc,{documentId:'doc',revision:1,isolatedImageLayer:'other'});
 assert.equal(isolated.paint.imageDocuments.doc.layers[0].parentId,undefined);
 edit(paint,'ungroupLayer',{layerId:'folder'});
 assert.equal(paint.imageDocuments.doc.layers.find(layer=>layer.id==='nested').parentId,undefined);
 validateImageDocuments(paint,checks);
});
test('independent compositor preserves transparency, mask edits, layer order, linear blending and transform',()=>{
 const script=`import numpy as np
from PIL import Image
from image_documents import composite_document,png_bytes
from paint_worker import sample_document
field=np.array([[[255,0,0,255],[0,0,0,0]]],dtype=np.uint8);v,a=sample_document(field,np.array([.5]),np.array([.5]),'color');assert np.allclose(v,[1,0,0]) and np.allclose(a,.5)
gray=np.full((1,1,4),128,dtype=np.uint8);gray[:,:,3]=255;v,a=sample_document(gray,np.array([.5]),np.array([.5]),'color',linear=True);assert np.allclose(v,128/255)
base=dict(id='p',kind='pixel',name='pixel',visible=True,locked=False,opacity=1,blend='normal',maskEnabled=True,maskBase=1,strokes=[dict(uv=True,rect=[.1,.1,.9,.9],color='#ff0000',opacity=1,erase=False)],maskStrokes=[dict(uv=True,rect=[.1,.1,.4,.9],value=0,opacity=1)])
doc=dict(name='doc',width=4096,height=4096,colorSpace='srgb',layers=[base]);p=composite_document(doc,{},64)
assert p[32,16,3]==0 and list(p[32,32])==[255,0,0,255] and p[0,0,3]==0
blue={**base,'id':'b','maskEnabled':False,'maskStrokes':[],'opacity':.5,'strokes':[dict(uv=True,rect=[0,0,1,1],color='#0000ff',opacity=1,erase=False)]};doc['layers'].append(blue);p=composite_document(doc,{},64)
assert np.max(np.abs(p[32,32,:3].astype(int)-[188,0,188]))<=1 and p[32,32,3]==255
assert list(p[0,0,:3])==[0,0,255] and abs(int(p[0,0,3])-128)<=1
base['maskEnabled']=False;base['strokes'].append(dict(transformUV=dict(rect=[0,0,1,1],offset=[.5,0],scale=[1,1],angle=0,copy=False,interpolation='nearest')));doc['layers']=[base];p=composite_document(doc,{},64)
assert p[32,16,3]==0 and p[32,48,3]==255
gradient=dict(kind='linear',start=[.25,.5],end=[.75,.5],colors=['#ff0000','#0000ff'],alpha=[1,0],clip=[.1,.1,.9,.9])
layer=dict(id='gradient',kind='gradient',visible=True,opacity=1,blend='normal',maskEnabled=False,gradient=gradient)
doc['layers']=[layer];p=composite_document(doc,{},64)
assert list(p[32,12])==[255,0,0,255] and p[32,52,3]==0 and p[0,12,3]==0
assert list(p[32,31,:3])==[255,0,0] and abs(int(p[32,31,3])-131)<=1
layer['gradientTransform']=[1,0,0,1,.125,.0625]
shifted=composite_document(doc,{},64)
assert np.array_equal(p[:-4,:-8],shifted[4:,8:])
assert not shifted[:4,:,3].any() and not shifted[:,:8,3].any()
layer['gradientTransform']=[1,0,0,1,2,0]
assert not composite_document(doc,{},64).any()
unclipped={k:v for k,v in gradient.items() if k!='clip'}
layer['gradient']=unclipped
assert composite_document(doc,{},64)[:,:,3].min()==255
layer['gradient']=gradient
del layer['gradientTransform']
from pathlib import Path
from tempfile import TemporaryDirectory
with TemporaryDirectory() as root:
 selection=Path(root)/'selection.png'
 coverage=np.zeros((4096,4096),dtype=np.uint8)
 coverage[1024:3072,1024:2048]=128
 coverage[1024:3072,2048:3072]=255
 Image.fromarray(coverage).save(selection)
 layer['gradient']={**gradient,'clip':[.25,.25,.75,.75],'coverage':'soft','alpha':[1,1]}
 assets={'soft':str(selection)}
 before=composite_document(doc,assets,64)
 assert before[25,22,3]==128 and before[25,42,3]==255
 layer['gradientTransform']=[0,1,-1,0,1,0]
 rotated=composite_document(doc,assets,64)
 assert np.array_equal(rotated,np.rot90(before,-1))
 layer['gradient']=gradient
 del layer['gradientTransform']
gradient.update(kind='radial',start=[.5,.5],end=[.75,.5],alpha=[1,1],polygon=[[.1,.1],[.9,.1],[.1,.9]])
q=composite_document(doc,{},64)
assert q[32,31,3]==0 and q[30,30,0]>q[30,30,2]
assert list(q[9,12])==[0,0,255,255]
mask=dict(kind='linear',start=[.25,.5],end=[.75,.5],colors=['#000000','#ffffff'],alpha=[1,1])
layer['maskGradient']=mask;layer['maskBase']=1;layer['maskEnabled']=True
layer['maskStrokes']=[dict(uv=True,rect=[.4,.4,.6,.6],value=0,opacity=1)]
q=composite_document(doc,{},64,inspect_mask='gradient')
assert list(q[32,8])==[0,0,0,255] and list(q[32,55])==[255,255,255,255]
assert q[32,32,0]==0 and abs(int(q[8,32,0])-131)<=1
bottom={**base,'strokes':[dict(uv=True,rect=[0,0,1,1],color='#ff0000',opacity=1,erase=False)]}
folder=dict(id='folder',kind='group',visible=True,opacity=1,blend='passThrough',maskEnabled=False,maskBase=1)
invert=dict(id='invert',kind='adjustment',parentId='folder',visible=True,opacity=1,blend='normal',maskEnabled=False,adjustment={'type':'invert'})
doc['layers']=[bottom,invert,folder]
assert list(composite_document(doc,{},64)[32,32])==[0,255,255,255]
folder['blend']='normal'
assert list(composite_document(doc,{},64)[32,32])==[255,0,0,255]
folder.update(blend='passThrough',opacity=.5,maskEnabled=True,maskStrokes=[dict(uv=True,rect=[0,0,.5,1],value=0,opacity=1)])
grouped=composite_document(doc,{},64)
assert list(grouped[32,16])==[255,0,0,255] and list(grouped[32,48])==[188,188,188,255]
from io import BytesIO
for color_space,key,value in [('linear','gamma',1),('srgb','srgb',0)]:
 with Image.open(BytesIO(png_bytes(p,color_space))) as encoded:
  assert encoded.info[key] == value
  assert np.array_equal(np.asarray(encoded),p)
import tempfile
from pathlib import Path
with tempfile.TemporaryDirectory() as folder:
 file=Path(folder)/'asset.png';Image.new('RGBA',(32,16),(0,220,40,180)).save(file)
 image=dict(id='image',kind='image',name='asset',visible=True,locked=False,opacity=1,blend='normal',maskEnabled=False,maskBase=1,asset='png',x=.5,y=.5,scale=1,rotation=0,stretch=[1,1])
 doc['layers']=[image];p=composite_document(doc,{'png':str(file)},512)
 assert p.shape==(512,512,4) and p[128,256,3]==180 and p[384,256,3]==0
`;const result=spawnSync(process.env.ARACHNE_PYTHON||'python',['-c',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});

test('canvas anchors retain the selected source edge; nonuniform resize keeps path and selection coordinates',()=>{
 for(let anchor=0;anchor<9;anchor++){
   const paint=defaults();
   edit(paint,'create',{patch:{width:512,height:1024}});
   const doc=paint.imageDocuments.doc;
   const region={name:'页边',rect:[.46,.42,.51,.52]};
   const path={id:'cutline',name:'裁线',geometry:{closed:false,anchors:[{point:[.48,.45]},{point:[.51,.52]}]}};
   edit(paint,'saveSelection',{patch:region});edit(paint,'savePath',{patch:path});
   edit(paint,'resizeCanvas',{patch:{width:612,height:984,anchor}});
   assert.deepEqual(doc.frame,[1792-50*(anchor%3),1536+20*Math.floor(anchor/3),612,984]);
   const frame=[...doc.frame];
   edit(paint,'resizeImage',{patch:{width:700,height:77}});
   assert.deepEqual(doc.frame,frame);
   assert.deepEqual([doc.width,doc.height],[700,77]);
   assert.deepEqual(doc.selections,[region]);assert.deepEqual(doc.paths,[path]);
   assert.throws(()=>edit(paint,'cropCanvas',{patch:{width:700,height:77,left:5,top:0}}));
   assert.deepEqual(doc.frame,frame);
 }
});

test('inverting a coverage selection on a banner only selects visible document pixels',()=>{
 const script=`import json, struct
from io import BytesIO
import numpy as np
from PIL import Image
from image_documents import image_selection_sample
doc=dict(width=2048,height=512,colorSpace='srgb',layers=[])
out=image_selection_sample(doc,{},dict(source='refine',operation='invert',previous=dict(rect=[.375,.46875,.5,.5])),64)
offset=4+struct.unpack('>I',out[:4])[0]
mask=np.asarray(Image.open(BytesIO(out[offset:])))
expected=np.zeros((64,64),dtype=np.uint8)
expected[28:36,16:48]=255
expected[30:32,24:32]=0
assert np.array_equal(mask,expected)`;
 const result=spawnSync(process.env.ARACHNE_PYTHON||'python',['-B','-c',script],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});

test('nested embedded edits invalidate a bound material and referenced sources survive removal attempts',()=>{
 const paint=defaults();
 edit(paint,'create',{patch:{width:512,height:128}});
 edit(paint,'addLayer',{layerId:'ink',kind:'pixel'});
 edit(paint,'embedLayer',{layerId:'ink',newDocumentId:'inner'});
 edit(paint,'embedLayer',{layerId:'ink',newDocumentId:'outer'});
 edit(paint,'bind',{channel:'color',newLayerId:'banner'});
 const project={revision:1,paint};
 const original=materialFingerprint(project);
 edit(paint,'updateLayer',{documentId:'inner',layerId:'ink',patch:{opacity:.375}});
 assert.notEqual(materialFingerprint(project),original);
 const config=imageDocumentInput(project,{revision:1,documentId:'doc'});
 assert.deepEqual(Object.keys(config.embeddedDocuments),['inner','outer']);
 assert.equal(config.embeddedDocuments.inner.layers[0].opacity,.375);
 assert.throws(()=>edit(paint,'remove',{documentId:'inner'}),/仍被内嵌实例引用/);
 validateImageDocuments(paint,checks);
 const invalid=structuredClone(paint);
 invalid.imageDocuments.outer.layers[0].embedded.documentId='doc';
 assert.throws(()=>validateImageDocuments(invalid,checks),/循环引用/);
 delete paint.imageDocuments.inner;
 assert.throws(()=>validateImageDocuments(paint,checks),/找不到内嵌对象源稿/);
});
