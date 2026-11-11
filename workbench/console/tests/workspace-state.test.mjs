import test from 'node:test';import assert from 'node:assert/strict';
import {area,split,leaves,validateLayout,workspacePreset,splitArea,changeEditor,joinAreas,joinable,adjacentAreas,swapAreas,areaRects,migrateLayerEditors} from '../public/workspace-state.mjs';
import {createProjectState} from '../public/project-state.mjs';import {createEditorRegistry} from '../public/editor-registry.mjs';
test('workspace presets are layouts only and every area can switch independently',()=>{
  for(const name of ['modeling','material','drawing']){const tree=workspacePreset(name);validateLayout(tree);for(const a of leaves(tree)){const changed=changeEditor(tree,a.id,'console');assert.equal(leaves(changed).find(n=>n.id===a.id).editor,'console');assert.equal(leaves(tree).find(n=>n.id===a.id).editor,a.editor);}}
});
test('split preserves editor views without aliasing; merge works across original tree branches',()=>{
  const a=area('viewport','a',{camera:{eye:[1,2,3]}}),tree=splitArea(a,'a','x',.5,'b');
  tree.second.states.viewport.camera.eye[0]=9;assert.equal(tree.first.states.viewport.camera.eye[0],1);
  let quadrants=split('x',split('y',area('shader','tl'),area('viewport','bl')),split('y',area('properties','tr'),area('layers','br')));
  assert.ok(joinable(quadrants,'tl').some(n=>n.id==='tr'));const original=JSON.stringify(quadrants),merged=joinAreas(quadrants,'tl','tr');
  assert.equal(leaves(merged).length,3);const top=areaRects(merged).find(r=>r.area.id==='tl');assert.equal(top.w,1);assert.equal(top.h,.5);assert.equal(JSON.stringify(quadrants),original);
  assert.throws(()=>joinAreas(quadrants,'tl','br'),/相邻/);
});
test('area swaps keep editor identity and state while moving into existing rectangles',()=>{
  const view=area('viewport','view',{camera:{eye:[1,2,3]}}),nodes=area('shader','nodes',{zoom:.63});
  const tree=split('x',view,split('y',nodes,area('scene','outline'),.4),.65);
  assert.deepEqual(joinable(tree,'view'),[]);
  assert.deepEqual(adjacentAreas(tree,'view'),[{id:'nodes',direction:'right'},{id:'outline',direction:'right'}]);
  const swapped=validateLayout(swapAreas(tree,'view','nodes'));
  assert.equal(swapped.first,nodes);assert.equal(swapped.second.first,view);
  assert.equal(swapped.id,tree.id);assert.equal(swapped.ratio,tree.ratio);assert.equal(swapped.second.ratio,tree.second.ratio);
  assert.deepEqual(swapAreas(swapped,'view','nodes'),tree);
  assert.throws(()=>swapAreas(tree,'view','missing'),/编辑器区域/);
});
test('corrupt saved trees and excessive splits are rejected',()=>{
  assert.throws(()=>validateLayout(split('z',area('viewport','a'),area('shader','b'))));assert.throws(()=>validateLayout(split('x',area('viewport','a'),area('shader','a'))));
  assert.throws(()=>validateLayout(area('unknown','a')));assert.throws(()=>validateLayout(split('x',area('viewport','a'),area('shader','b'),NaN)));
});
test('shared project keeps monotonic revisions, guarded commands and disposable subscriptions',async()=>{
  let writes=0,changes=0;const state=createProjectState({write:async(ops,o)=>{writes++;return {id:o.id,revision:o.revision+1,paint:{}};},travel:async()=>({id:'a',revision:4,paint:{}}),draft(){},selectLayer(){},selectResource(){}}),off=state.subscribe(()=>changes++);
  state.publish({id:'a',revision:2,paint:{}});state.publish({id:'a',revision:1,paint:{}});assert.equal(state.document.revision,2);
  await assert.rejects(state.commands([{}],{id:'a',revision:1}),/修订/);assert.equal(writes,0);
  await state.commands([{}]);assert.equal(state.document.revision,3);state.selectLayer('layer');state.selectResource({library:'materials',id:'mat'});assert.equal(state.layerId,'layer');assert.equal(state.resource.id,'mat');
  off();const before=changes;state.publish({id:'a',revision:4,paint:{}});assert.equal(changes,before);assert.equal(state.listenerCount(),0);
});
test('explicit resource reselection emits once while ordinary synchronization remains quiet',()=>{
  const state=createProjectState({write(){},travel(){},draft(){},selectLayer(){},selectResource(){}}),events=[];
  state.subscribe(event=>{if(event.kind==='resource')events.push(event.kind);});state.publish({id:'a',revision:0,paint:{}});
  const brush={library:'brushes',id:'fine'};state.selectedResource(brush);state.selectedResource({...brush});assert.equal(events.length,1);
  state.selectedResource({...brush},undefined,{force:true});assert.equal(events.length,2);assert.deepEqual(state.resource,brush);
});
test('explicitly reselecting a material or image target notifies contextual editors',()=>{
  const state=createProjectState({write(){},travel(){},draft(){},selectLayer(){},selectResource(){}}),events=[];
  state.subscribe(event=>{if(['selection','imageSelection'].includes(event.kind))events.push(event);});
  state.selectedLayer('layer');state.selectedLayer('layer');state.selectedLayer('layer',undefined,{force:true});
  const image={documentId:'image',layerId:'pixel',target:'mask'};
  state.selectImage(image);state.selectImage({...image});state.selectImage({...image},undefined,{force:true});
  assert.deepEqual(events.map(event=>[event.kind,event.force]),[['selection',false],['selection',true],['imageSelection',false],['imageSelection',true]]);
});
test('node previews are scoped to their editor and revision without clearing newer drawing drafts',()=>{
  const previews=[],state=createProjectState({write(){},travel(){},draft:op=>previews.push(op),selectLayer(){},selectResource(){}});
  state.publish({id:'p',revision:1,paint:{materials:{mat:{}}}});const origin={id:'p',revision:1,target:{library:'materials',id:'mat'}},first={op:'library',library:'materials',id:'mat',action:'update',patch:{graph:{value:1}}},second={...first,patch:{graph:{value:2}}};
  assert.equal(state.setNodeDraft('left',origin,first),true);assert.equal(state.setNodeDraft('right',origin,second),true);assert.equal(state.setNodeDraft('left',origin,null),false);state.draft(null);assert.deepEqual(previews.at(-1),second);
  state.draft({op:'stroke',id:'layer'});assert.equal(state.setNodeDraft('right',origin,null),false);assert.equal(previews.at(-1).op,'stroke');
  assert.equal(state.setNodeDraft('left',origin,first),true);assert.equal(state.acceptExternalDraft(null),false);assert.equal(state.acceptExternalDraft({op:'base'}),true);assert.equal(state.setNodeDraft('left',origin,null),false);
  assert.equal(state.setNodeDraft('left',origin,first),true);state.publish({id:'p',revision:2,paint:{materials:{mat:{}}}});assert.equal(previews.at(-1),null);assert.equal(state.setNodeDraft('left',origin,first),false);
  const output={id:'p',revision:2};assert.equal(state.setNodeDraft('left',output,{op:'shader',graph:{}}),true);state.publish({id:'other',revision:0,paint:{materials:{}}});assert.equal(previews.at(-1),null);
});
test('editor registry creates independent instances and disposes each exactly once',()=>{
  const registry=createEditorRegistry();let disposed=0;registry.register('x',ctx=>({value:ctx.value,dispose:()=>disposed++}));const a=registry.create('x',{value:1}),b=registry.create('x',{value:2});assert.equal(registry.size,2);assert.notEqual(a,b);a.dispose();a.dispose();assert.equal(disposed,1);registry.dispose();assert.equal(disposed,2);assert.equal(registry.size,0);assert.throws(()=>registry.create('missing',{}));
});

test('queued edits reject stale origins and queued undo never travels into another project',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),writes=[];const state=createProjectState({write:async(ops,o)=>{writes.push(o);await gate;return {id:o.id,revision:o.revision+1,paint:{}};},travel:async(_,o)=>({id:o.id,revision:o.revision+1,paint:{}}),draft(){},selectLayer(){},selectResource(){}});
  state.publish({id:'a',revision:0,paint:{}});const first=state.commands([{}]),second=state.commands([{}]),undo=state.travel('undo');const rejected=assert.rejects(second,/修订/);release();await first;await rejected;await undo;assert.equal(writes.length,1);assert.equal(state.document.revision,2);
  const queued=state.travel('undo');state.publish({id:'b',revision:0,paint:{}});await assert.rejects(queued,/切换/);assert.equal(state.document.id,'b');assert.equal(state.document.revision,0);
});


test('material and image panels have fixed editor identities and safe one-time layout migration',()=>{
  const drawing=workspacePreset('drawing'),material=workspacePreset('material');
  assert.equal(leaves(drawing).find(a=>a.id==='side-top').editor,'imageLayers');
  assert.equal(leaves(drawing).find(a=>a.id==='side-bottom').editor,'imageProperties');
  assert.equal(leaves(material).find(a=>a.id==='side-top').editor,'layers');
  assert.equal(leaves(material).find(a=>a.id==='side-bottom').editor,'properties');
  const legacy=split('y',area('layers','top',{domainScope:'auto',scroll:17}),area('properties','bottom',{domainScope:'material',sections:{material:true}}),.27,'custom');
  const saved=structuredClone(legacy),upgraded=migrateLayerEditors(legacy,'drawing');
  assert.equal(upgraded.first.editor,'imageLayers');assert.equal(upgraded.second.editor,'properties');assert.equal(upgraded.ratio,.27);
  assert.equal(upgraded.first.states.imageLayers.scroll,17);assert.equal(upgraded.first.states.layers.domainScope,undefined);assert.deepEqual(legacy,saved);
  assert.equal(migrateLayerEditors(area('layers','pinned',{domainScope:'image'}),'material').editor,'imageLayers');
  const state=createProjectState({write(){},travel(){},draft(){},selectLayer(){},selectResource(){}});
  state.publish({id:'project',revision:0,paint:{}});state.selectLayer('material-layer');state.selectImage({documentId:'document',layerId:'pixel-layer',target:'mask'});
  state.setEditorDomain('material');state.setEditorDomain('image');assert.equal(state.layerId,'material-layer');assert.equal(state.imageContext.layerId,'pixel-layer');assert.equal(state.document.revision,0);
});
