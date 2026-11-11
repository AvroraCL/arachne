import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectState} from '../public/project-state.mjs';
import {createImageEditorSelection} from '../public/image-editor-selection.mjs';

test('image editors own independent selections while panels follow the active canvas',()=>{
  const shared=createProjectState({write(){},travel(){},draft(){},selectLayer(){},selectResource(){}});
  const documents={a:{layers:[{id:'a1'},{id:'a2'},{id:'a3'}]},b:{layers:[{id:'b1'}]}};
  shared.publish({id:'p1',revision:0,paint:{imageDocuments:documents}});
  let changes=0;const left=createImageEditorSelection(shared,{areaId:'left',onChange:()=>changes++}),right=createImageEditorSelection(shared,{areaId:'right',onChange:()=>changes++});
  const a={documentId:'a',layerId:'a1',target:'pixels'},b={documentId:'b',layerId:'b1',target:'pixels'},mask={documentId:'b',layerId:'b1',target:'mask'};
  left.project.selectImage(a);right.project.selectImage(b);left.activate();assert.deepEqual(shared.imageContext,a);assert.deepEqual(right.project.imageContext,b);
  const third=createImageEditorSelection(shared,{areaId:'third'});assert.deepEqual(third.project.imageContext,a);third.project.selectImage({...a,layerId:'a3'});assert.deepEqual(shared.imageContext,a);third.dispose();
  right.activate();assert.deepEqual(shared.imageContext,b);shared.selectImage(mask);assert.deepEqual(right.project.imageContext,mask);assert.deepEqual(left.project.imageContext,a);
  left.project.selectImage({...a,layerId:'a2'});assert.deepEqual(shared.imageContext,mask);left.activate();assert.equal(shared.imageContext.layerId,'a2');
  shared.publish({id:'p2',revision:0,paint:{imageDocuments:{c:{layers:[{id:'c1'}]}}}});assert.equal(left.project.imageContext,null);left.project.selectImage({documentId:'c',layerId:'c1',target:'pixels'});assert.equal(shared.imageContext.documentId,'c');
  shared.publish({id:'p1',revision:1,paint:{imageDocuments:documents}});assert.equal(left.project.imageContext.layerId,'a2');assert.equal(right.project.imageContext.target,'mask');assert.equal(shared.imageContext.layerId,'a2');
  const copy=left.getState();copy.p1.layerId='changed';assert.equal(left.project.imageContext.layerId,'a2');assert.ok(changes>0);
  left.dispose();assert.equal(shared.imageEditor,null);right.activate();assert.equal(shared.imageContext.target,'mask');right.dispose();assert.equal(shared.listenerCount(),0);
});

test('a canvas activated before project loading publishes its selection when the project arrives',()=>{
  const shared=createProjectState({write(){},travel(){},draft(){},selectLayer(){},selectResource(){}}),view=createImageEditorSelection(shared,{areaId:'main'});
  view.activate();assert.equal(shared.imageEditor,'main');shared.publish({id:'project',revision:0,paint:{}});
  view.project.selectImage({documentId:'image',layerId:'pixel',target:'mask'});assert.deepEqual(shared.imageContext,{documentId:'image',layerId:'pixel',target:'mask'});view.dispose();
});

test('an inactive canvas initializes empty image panels without taking focus from the material workspace',()=>{
  const shared=createProjectState({write(){},travel(){},draft(){},selectLayer(){},selectResource(){}});
  const a={documentId:'a',layerId:'a1',target:'pixels'},b={documentId:'b',layerId:'b1',target:'mask'};
  shared.publish({id:'p1',revision:0,paint:{imageDocuments:{a:{layers:[{id:'a1'}]},b:{layers:[{id:'b1'}]}}}});
  const left=createImageEditorSelection(shared,{areaId:'left',saved:{p1:a}}),right=createImageEditorSelection(shared,{areaId:'right'});
  assert.deepEqual(left.project.imageContext,a);assert.deepEqual(shared.imageContext,a);assert.equal(shared.imageEditor,null);assert.equal(shared.editorDomain,'material');
  right.project.selectImage(b);assert.deepEqual(shared.imageContext,a);assert.deepEqual(right.project.imageContext,b);
  right.activate();assert.deepEqual(shared.imageContext,b);assert.equal(shared.imageEditor,'right');
  left.dispose();right.dispose();

  const empty=createProjectState({write(){},travel(){},draft(){},selectLayer(){},selectResource(){}});empty.publish({id:'p2',revision:0,paint:{imageDocuments:{a:{layers:[{id:'a1'}]}}}});
  const view=createImageEditorSelection(empty,{areaId:'canvas'});view.project.selectImage(a);assert.deepEqual(empty.imageContext,a);assert.equal(empty.editorDomain,'material');view.dispose();
});

test('a stale saved document or layer is not published before the canvas chooses a valid replacement',()=>{
  const shared=createProjectState({write(){},travel(){},draft(){},selectLayer(){},selectResource(){}}),valid={documentId:'b',layerId:'b1',target:'pixels'};
  shared.publish({id:'p',revision:0,paint:{imageDocuments:{b:{layers:[{id:'b1'}]}}}});
  const view=createImageEditorSelection(shared,{areaId:'canvas',saved:{p:{documentId:'missing',layerId:'old',target:'pixels'}}});
  assert.equal(view.project.imageContext.documentId,'missing');assert.equal(shared.imageContext,null);
  view.project.selectImage({documentId:'b',layerId:null,target:'pixels'});assert.equal(shared.imageContext,null);
  view.project.selectImage(valid);assert.deepEqual(shared.imageContext,valid);view.dispose();
});
