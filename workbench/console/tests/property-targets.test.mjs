import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePropertyTarget,propertyTargetStatus} from '../public/property-targets.mjs';

test('property targets retain identity and never fall back after deletion or project changes',()=>{
  const doc={id:'one',name:'测试',paint:{layers:[{id:'a',name:'材质 A'}],imageDocuments:{image:{name:'图像',layers:[{id:'pixel',name:'像素层'}]}}}};
  const project={document:doc,layerId:'a',imageContext:{documentId:'image',layerId:'pixel',target:'mask'},scene:{projectId:'one',binding:'bind',activeId:7,inspectObject:id=>id===7?{id:7,label:'机身',binding:'bind'}:null}};
  const object=capturePropertyTarget('object',project),material=capturePropertyTarget('material',project,()=>({layerId:'a',target:'material'})),drawing=capturePropertyTarget('drawing',project);
  assert.equal(propertyTargetStatus('object',project,object).name,'机身');assert.equal(propertyTargetStatus('material',project,material).name,'材质 A');
  assert.equal(propertyTargetStatus('drawing',project,drawing).type,'图层蒙版');
  project.layerId=null;project.imageContext={documentId:'image',layerId:null,target:'pixels'};project.scene.activeId=null;
  assert.equal(propertyTargetStatus('object',project,object).available,true);assert.equal(propertyTargetStatus('material',project,material).available,true);assert.equal(propertyTargetStatus('drawing',project,drawing).available,true);
  doc.paint.layers=[];doc.paint.imageDocuments.image.layers=[];
  assert.match(propertyTargetStatus('material',project,material).reason,/不存在/);assert.match(propertyTargetStatus('drawing',project,drawing).reason,/不存在/);
  project.scene.binding='other';assert.match(propertyTargetStatus('object',project,object).reason,/绑定/);
  project.document={...doc,id:'two'};
  for(const [category,target] of [['object',object],['material',material],['drawing',drawing]])assert.match(propertyTargetStatus(category,project,target).reason,/其他工程/);
});

test('base and image-document targets remain distinct from selected layers',()=>{
  const project={document:{id:'p',name:'工程',paint:{layers:[{id:'a',name:'层'}],materials:{coat:{name:'共享材质'}},imageDocuments:{image:{name:'文档',layers:[]}}}},layerId:'a',imageContext:{documentId:'image',layerId:null,target:'pixels'}};
  const base=capturePropertyTarget('material',project,()=>({layerId:null})),image=capturePropertyTarget('drawing',project);
  assert.equal(propertyTargetStatus('material',project,base).name,'全 UV 底层');assert.equal(propertyTargetStatus('drawing',project,image).name,'文档');
  const material=capturePropertyTarget('material',project,()=>({kind:'resource',resourceId:'coat'}));assert.equal(propertyTargetStatus('material',project,material).name,'共享材质');
  delete project.document.paint.materials.coat;assert.match(propertyTargetStatus('material',project,material).reason,/不存在/);
  assert.match(propertyTargetStatus('material',project,{projectId:'p',target:'material'}).reason,/无效/,'an invalid pin cannot fall back to the base');
});
