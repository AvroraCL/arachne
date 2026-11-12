import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {imageDocumentOperation,validateImageDocuments,surfaceToImageCommand,hasImageLayerMask,imageDocumentLimit} from '../public/image-documents.mjs';
import {imageDocumentInput} from '../paint.mjs';
import {newImageAdjustment,checkImageAdjustment,imageBlendModes} from '../public/image-adjustments.mjs';
const defaults=()=>({layers:[],assets:{}}),options={requireUnlocked:()=>{}},checks={checkStroke:s=>{assert.equal(s.uv,true);assert.ok(s.rect||s.stamps);},checkedUVTransform:t=>assert.ok(t.rect)};
const edit=(paint,action,extra={})=>imageDocumentOperation(paint,{op:'image',documentId:'doc',action,...extra},options);
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
 assert.throws(()=>edit(paint,'stroke',{layerId:'levels',target:'pixels',stroke:{}}),/像素层/);
 assert.equal(new Set(imageBlendModes).size,16);
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
 assert.throws(()=>input({isolatedImageLayer:'missing'}),/图像图层不存在/);
 assert.throws(()=>input({inspectMask:'missing'}),/图像蒙版不存在/);
});
test('independent compositor preserves transparency, mask edits, layer order, linear blending and transform',()=>{
 const script=`import numpy as np
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
from PIL import Image
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
