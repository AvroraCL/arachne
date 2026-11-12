import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {createPersonalLibrary} from '../personal-library-store.mjs';
import {defaultLibraryMaterial,defaultBrushGraph,validateLibraries} from '../public/paint-library.mjs';
import {makeGraphNode} from '../public/material-graph.mjs';
import {newMaskEffect} from '../public/paint-mask-effects.mjs';
import {validateProjectPaint} from '../paint.mjs';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'arachne-personal-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const docs=new Map(['a','b'].map(id=>[id,{id,revision:0,workflowType:'pbr_paint',paint:{base:{color:'#888888',metallic:0,roughness:.5},layers:[],assets:{},materials:{},brushes:{}}}]));
  const args={root:path.join(root,'personal-library'),validatePaint:validateProjectPaint,readProject:id=>{if(!docs.has(id))throw Error('missing project');return structuredClone(docs.get(id));},projectFolder:id=>path.join(root,'projects',id),commitProject:(id,revision,fn)=>{const doc=docs.get(id);if(doc.revision!==revision)throw Error('stale');const next=fn(structuredClone(doc));validateLibraries(next.paint);next.revision++;docs.set(id,next);return structuredClone(next);}};
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ioAAAAASUVORK5CYII=','base64'),id=crypto.createHash('sha256').update(bytes).digest('hex'),asset={id,sha256:id,name:'蒙版.png',width:1,height:1,file:'paint-'+id+'.png'};
  docs.get('a').paint.assets[id]=asset;fs.mkdirSync(path.join(args.projectFolder('a'),'assets'),{recursive:true});fs.writeFileSync(path.join(args.projectFolder('a'),'assets',asset.file),bytes);
  const graph=defaultLibraryMaterial();const image=makeGraphNode(graph,'image',0,0,'image');image.params.asset=id;graph.nodes.push(image);graph.links.push({from:{node:'image',port:'color'},to:{node:'pbr',port:'color'}});docs.get('a').paint.materials.coat={name:'通用涂料',graph};docs.get('a').paint.brushes.round={name:'通用笔刷',graph:defaultBrushGraph()};
  return {root,args,docs,asset,bytes,library:createPersonalLibrary(args)};
}
test('personal material includes images, survives project deletion/restart, and imports an editable independent copy',t=>{
  const {args,docs,asset,bytes,library}=fixture(t),before=structuredClone(docs.get('a'));
  const saved=library.save({projectId:'a',projectRevision:0,revision:0,kind:'materials',resourceId:'coat'});assert.deepEqual(docs.get('a'),before);assert.equal(saved.state.revision,1);assert.equal(Object.keys(saved.item.assets).length,1);
  docs.delete('a');fs.rmSync(args.projectFolder('a'),{recursive:true});const reopened=createPersonalLibrary(args);assert.deepEqual(fs.readFileSync(reopened.assetFile(saved.item.id,asset.id)),bytes);
  const imported=reopened.importResource({projectId:'b',projectRevision:0,revision:1,id:saved.item.id});assert.equal(imported.document.revision,1);assert.notEqual(imported.resource.id,'coat');assert.deepEqual(imported.document.paint.materials[imported.resource.id].graph,saved.item.graph);assert.deepEqual(fs.readFileSync(path.join(args.projectFolder('b'),'assets',asset.file)),bytes);
  reopened.rename({revision:1,id:saved.item.id,name:'新版个人涂料'});assert.equal(docs.get('b').paint.materials[imported.resource.id].name,'通用涂料');reopened.remove({revision:2,id:saved.item.id});assert.equal(Object.keys(reopened.read().items).length,0);assert.ok(fs.existsSync(path.join(args.projectFolder('b'),'assets',asset.file)));
});
test('brushes and grayscale/transparent PNGs can be reused across projects without sharing graph objects',t=>{
  const {library,docs,asset}=fixture(t);let saved=library.save({projectId:'a',projectRevision:0,revision:0,kind:'brushes',resourceId:'round'});const brush=library.importResource({projectId:'b',projectRevision:0,revision:1,id:saved.item.id});docs.get('b').paint.brushes[brush.resource.id].graph.nodes[0].params.uvRadius=99;assert.notEqual(library.read().items[saved.item.id].graph.nodes[0].params.uvRadius,99);
  saved=library.save({projectId:'a',projectRevision:0,revision:1,kind:'images',resourceId:asset.id});library.rename({revision:2,id:saved.item.id,name:'新版蒙版.png'});const image=library.importResource({projectId:'b',projectRevision:1,revision:3,id:saved.item.id});assert.equal(image.resource.id,asset.id);assert.equal(image.document.paint.assets[asset.id].sha256,asset.sha256);assert.equal(image.document.paint.assets[asset.id].name,'新版蒙版.png');
});
test('stale clients, broken dependencies, corruption and unsafe paths never change either index or project revision',t=>{
  const {library,docs,args,asset}=fixture(t);const before=structuredClone(docs.get('b'));
  assert.throws(()=>library.save({projectId:'a',projectRevision:3,revision:0,kind:'materials',resourceId:'coat'}),e=>e.status===409);assert.equal(library.read().revision,0);
  const saved=library.save({projectId:'a',projectRevision:0,revision:0,kind:'materials',resourceId:'coat'});
  assert.throws(()=>library.remove({revision:0,id:saved.item.id}),e=>e.status===409);assert.throws(()=>library.importResource({projectId:'b',projectRevision:9,revision:1,id:saved.item.id}),e=>e.status===409);assert.throws(()=>library.assetFile('../bad',asset.id));assert.throws(()=>library.rename({revision:1,id:saved.item.id,name:''}));
  fs.writeFileSync(library.assetFile(saved.item.id,asset.id),'corrupt');assert.throws(()=>library.importResource({projectId:'b',projectRevision:0,revision:1,id:saved.item.id}),/指纹/);assert.deepEqual(docs.get('b'),before);assert.equal(library.read().revision,1);
  docs.get('a').paint.materials.coat.graph.nodes.find(n=>n.type==='image').params.asset='missing';assert.throws(()=>library.save({projectId:'a',projectRevision:0,revision:1,kind:'materials',resourceId:'coat'}));assert.equal(library.read().revision,1);assert.equal(fs.existsSync(args.projectFolder('b')),false);
});

test('personal resource metadata is versioned, normalized and separate from the saved graph',t=>{
  const {library,args}=fixture(t);
  const {item}=library.save({projectId:'a',projectRevision:0,revision:0,kind:'materials',resourceId:'coat'});
  const updated=library.update({revision:1,id:item.id,patch:{favorite:true,tags:[' Metal ','ＭＥＴＡＬ','涂层']}});
  assert.deepEqual(updated.items[item.id].tags,['Metal','涂层']);
  assert.equal(updated.items[item.id].favorite,true);
  assert.deepEqual(updated.items[item.id].graph,item.graph);
  assert.deepEqual(updated.items[item.id].assets,item.assets);
  assert.deepEqual(createPersonalLibrary(args).read(),updated);
  assert.throws(()=>library.update({revision:1,id:item.id,patch:{favorite:false}}),failure=>failure.status===409);
  assert.throws(()=>library.update({revision:2,id:item.id,patch:{graph:{}}}),/属性无效/);
  assert.throws(()=>library.update({revision:2,id:item.id,patch:{tags:['无效,标签']}}),/标签须/);
  assert.equal(library.update({revision:2,id:item.id,patch:{favorite:true}}).revision,2);
  const cleared=library.update({revision:2,id:item.id,patch:{favorite:false,tags:[]}});
  assert.equal(cleared.items[item.id].favorite,undefined);
  assert.equal(cleared.items[item.id].tags,undefined);
});

test('smart material restores nested layers, maps and editable resources independently of the source project',t=>{
  const {args,docs,asset,bytes,library}=fixture(t);
  const paint=docs.get('a').paint;
  const layer={kind:'fill',visible:true,opacity:1,x:.5,y:.5,scale:1,rotation:0,
    channels:{color:true,metallic:true,roughness:true},values:{color:'#697080',metallic:.5,roughness:.3},mask:null};
  paint.layers.push(
    {id:'root',kind:'group',name:'磨损钢',visible:true},
    {...layer,id:'coat',parentId:'root',name:'钢底',materialId:'coat',documentMaps:{color:'drawing'}},
    {id:'details',kind:'group',parentId:'root',name:'表面细节',visible:true},
    {...layer,id:'wear',parentId:'details',name:'磨边',mask:asset.id,maskEffects:[newMaskEffect('edgeWear')]}
  );
  paint.imageDocuments={drawing:{name:'图案',width:4096,height:4096,colorSpace:'srgb',layers:[]}};
  const before=structuredClone(paint);
  const saved=library.save({projectId:'a',projectRevision:0,revision:0,kind:'smartMaterials',resourceId:'root'});
  assert.equal(saved.item.layerCount,3);
  assert.deepEqual(paint,before);
  assert.deepEqual(Object.keys(saved.item.assets),[asset.id]);
  assert.equal(saved.item.graph,undefined);
  assert.match(saved.item.presetSha256,/^[a-f0-9]{64}$/);
  paint.layers[3].maskStrokes=[{uv:false}];
  assert.throws(()=>library.save({projectId:'a',projectRevision:0,revision:1,kind:'smartMaterials',resourceId:'root'}),/磨边.*绑定原模型/);
  docs.delete('a');fs.rmSync(args.projectFolder('a'),{recursive:true});
  const reopened=createPersonalLibrary(args);
  const imported=reopened.importResource({projectId:'b',projectRevision:0,revision:1,id:saved.item.id});
  const [group,coat,details,wear]=imported.document.paint.layers;
  assert.equal(imported.resource.id,group.id);
  assert.notEqual(group.id,'root');
  assert.equal(coat.parentId,group.id);
  assert.equal(details.parentId,group.id);
  assert.equal(wear.parentId,details.id);
  assert.equal(wear.mask,asset.id);
  assert.equal(wear.maskEffects[0].kind,'edgeWear');
  assert.notEqual(coat.materialId,'coat');
  assert.notEqual(coat.documentMaps.color,'drawing');
  assert.deepEqual(imported.document.paint.imageDocuments[coat.documentMaps.color],before.imageDocuments.drawing);
  assert.deepEqual(fs.readFileSync(path.join(args.projectFolder('b'),'assets',asset.file)),bytes);
  const target=docs.get('b');
  target.paint.layers[3].maskEffects[0].width=7;
  const again=reopened.importResource({projectId:'b',projectRevision:1,revision:1,id:saved.item.id});
  assert.equal(again.document.paint.layers[3].maskEffects[0].width,7);
  assert.equal(again.document.paint.layers[7].maskEffects[0].width,newMaskEffect('edgeWear').width);
  assert.equal(new Set(Object.values(again.document.paint.imageDocuments).map(doc=>doc.name)).size,2);
});
