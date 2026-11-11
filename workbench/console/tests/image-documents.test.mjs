import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {imageDocumentOperation,validateImageDocuments,surfaceToImageCommand} from '../public/image-documents.mjs';
import {imageDocumentInput} from '../paint.mjs';
const defaults=()=>({layers:[],assets:{}}),options={requireUnlocked:()=>{}},checks={checkStroke:s=>{assert.equal(s.uv,true);assert.ok(s.rect||s.stamps);},checkedUVTransform:t=>assert.ok(t.rect)};
const edit=(paint,action,extra={})=>imageDocumentOperation(paint,{op:'image',documentId:'doc',action,...extra},options);
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
from image_documents import composite_document
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
from PIL import Image
import tempfile
from pathlib import Path
with tempfile.TemporaryDirectory() as folder:
 file=Path(folder)/'asset.png';Image.new('RGBA',(32,16),(0,220,40,180)).save(file)
 image=dict(id='image',kind='image',name='asset',visible=True,locked=False,opacity=1,blend='normal',maskEnabled=False,maskBase=1,asset='png',x=.5,y=.5,scale=1,rotation=0,stretch=[1,1])
 doc['layers']=[image];p=composite_document(doc,{'png':str(file)},512)
 assert p.shape==(512,512,4) and p[128,256,3]==180 and p[384,256,3]==0
`;const result=spawnSync(process.env.ARACHNE_PYTHON||'python',['-c',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
