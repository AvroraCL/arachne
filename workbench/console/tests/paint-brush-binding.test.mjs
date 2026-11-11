import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectState} from '../public/project-state.mjs';
import {createBrushBinding} from '../public/paint-brush-binding.mjs';
import {defaultBrushGraph} from '../public/paint-library.mjs';
import {makeGraphNode} from '../public/material-graph.mjs';

function fixture(){
  const project=createProjectState({write(){},travel(){},draft(){},selectLayer(){},selectResource(){}}),graph=radius=>defaultBrushGraph({uvRadius:radius});
  const document={id:'a',revision:1,paint:{brushes:{fine:{name:'fine',graph:graph(70)},other:{name:'other',graph:graph(19)}}}};
  project.publish(document);project.selectedResource({library:'brushes',id:'fine'});
  const painter=()=>{
    let settings={worldRadius:.14,uvRadius:32,hardness:1,opacity:1,pressure:true,mirror:false},stored=structuredClone(settings),editing=false;
    return {getSettings:()=>structuredClone(settings),setSettings(value,{persist=true}={}){settings=structuredClone(value);if(persist)stored=structuredClone(value);},isEditing:()=>editing,edit(value){editing=value;},manual(radius){settings.uvRadius=radius;stored=structuredClone(settings);},stored:()=>structuredClone(stored)};
  };
  return {project,document,graph,painter,origin:{id:'a',revision:1,target:{library:'brushes',id:'fine'}}};
}
test('temporary brush previews restore each editor’s local settings without persisting the draft',()=>{
  const {project,graph,painter,origin}=fixture(),a=painter(),b=painter(),first=createBrushBinding({project,painter:a}),second=createBrushBinding({project,painter:b});
  first.sync();second.sync();a.manual(41);b.manual(28);project.setBrushDraft('shader',origin,graph(90));first.sync();second.sync();
  assert.equal(a.getSettings().uvRadius,90);assert.equal(b.getSettings().uvRadius,90);assert.equal(a.stored().uvRadius,41);assert.equal(b.stored().uvRadius,28);
  project.setBrushDraft('shader',origin,null);first.sync();second.sync();assert.equal(a.getSettings().uvRadius,41);assert.equal(b.getSettings().uvRadius,28);
  first.sync();second.sync();assert.equal(a.getSettings().uvRadius,41);assert.equal(b.getSettings().uvRadius,28);
});
test('a committed or externally changed graph replaces a draft; unrelated revisions restore local values',()=>{
  const {project,document,graph,painter,origin}=fixture(),p=painter(),binding=createBrushBinding({project,painter:p});binding.sync();p.manual(41);
  project.setBrushDraft('shader',origin,graph(90));binding.sync();project.publish({...document,revision:2});binding.sync();assert.equal(p.getSettings().uvRadius,41);
  const nextOrigin={...origin,revision:2};project.setBrushDraft('shader',nextOrigin,graph(92));binding.sync();
  const updated=structuredClone(document);updated.revision=3;updated.paint.brushes.fine.graph=graph(92);project.publish(updated);binding.sync();assert.equal(p.getSettings().uvRadius,92);assert.equal(p.stored().uvRadius,92);
});
test('moving a brush node without changing its output preserves local canvas adjustments',()=>{
  const {project,document,graph,painter,origin}=fixture(),p=painter(),binding=createBrushBinding({project,painter:p});binding.sync();p.manual(41);
  const layout=structuredClone(document);layout.revision=2;layout.paint.brushes.fine.graph.nodes[0].x+=80;project.publish(layout);binding.sync();assert.equal(p.getSettings().uvRadius,41);
  project.setBrushDraft('shader',{...origin,revision:2},graph(90));binding.sync();const next=structuredClone(layout);next.revision=3;next.paint.brushes.fine.graph.nodes[0].y+=30;project.publish(next);binding.sync();assert.equal(p.getSettings().uvRadius,41);
});
test('temporary changes through a connected scalar node update the brush and cancel cleanly',()=>{
  const {project,document,graph,painter,origin}=fixture(),p=painter(),binding=createBrushBinding({project,painter:p}),linked=graph(70),value=makeGraphNode(linked,'value',0,0,'size');
  value.params.value=70;linked.nodes.push(value);linked.links.push({from:{node:'size',port:'value'},to:{node:'brush',port:'uvRadius'}});
  const next=structuredClone(document);next.revision=2;next.paint.brushes.fine.graph=linked;project.publish(next);binding.sync();p.manual(41);
  const preview=structuredClone(linked);preview.nodes.find(node=>node.id==='size').params.value=90;const current={...origin,revision:2};project.setBrushDraft('shader',current,preview);binding.sync();assert.equal(p.getSettings().uvRadius,90);
  project.setBrushDraft('shader',current,null);binding.sync();assert.equal(p.getSettings().uvRadius,41);
});
test('drafts are scoped to their owner, origin and selected brush, including deferred gestures',()=>{
  const {project,document,graph,painter,origin}=fixture(),p=painter(),binding=createBrushBinding({project,painter:p});binding.sync();p.manual(41);
  project.setBrushDraft('one',origin,graph(90));binding.sync();project.setBrushDraft('two',origin,graph(95));binding.sync();
  assert.equal(project.setBrushDraft('one',origin,null),false);assert.equal(p.getSettings().uvRadius,95);
  assert.equal(project.setBrushDraft('two',{...origin,revision:0},null),false);assert.equal(project.brushDraft.owner,'two');
  p.edit(true);project.selectedResource({library:'brushes',id:'other'});binding.sync(true);project.setBrushDraft('two',origin,null);binding.sync();assert.equal(p.getSettings().uvRadius,95);
  p.edit(false);binding.sync();assert.equal(p.getSettings().uvRadius,19);
  assert.equal(project.setBrushDraft('old',{...origin,revision:0},graph(80)),false);project.publish({...document,id:'b',revision:0});assert.equal(project.brushDraft,null);
});
