import test from 'node:test';
import assert from 'node:assert/strict';
import {createShaderTargets} from '../public/shader-targets.mjs';

test('node editor pins are independent for each project even when resource IDs match',()=>{
 const targets=createShaderTargets(),a={id:'project-a'},b={id:'project-b'},pin={library:'materials',id:'same'};
 assert.equal(targets.current(a),null);targets.set(a,pin);pin.id='mutated';assert.equal(targets.current(a).id,'same');assert.equal(targets.current(b),null);targets.set(b,{library:'output',id:'output'});
 assert.deepEqual(targets.current(a),{library:'materials',id:'same'});const saved=targets.snapshot(),restored=createShaderTargets(saved);assert.deepEqual(restored.current(b),{library:'output',id:'output'});assert.deepEqual(restored.current(a),{library:'materials',id:'same'});
 saved.pinsByProject['project-a'].id='changed';assert.equal(restored.current(a).id,'same');restored.set(a,null);assert.equal(restored.current(a),null);assert.throws(()=>restored.set(a,{library:'invalid',id:'x'}),/目标/);
});

test('legacy single-project pin migrates once without leaking to the next project',()=>{
 const targets=createShaderTargets({pin:{library:'brushes',id:'brush'}}),savedBeforeLoad=targets.snapshot(),restored=createShaderTargets(savedBeforeLoad);
 assert.deepEqual(restored.current({id:'a'}),{library:'brushes',id:'brush'});assert.equal(restored.current({id:'b'}),null);assert.deepEqual(restored.current({id:'a'}),{library:'brushes',id:'brush'});
});

test('a pinned resource keeps its last name when deleted or renamed',()=>{
 const targets=createShaderTargets(),doc={id:'a',paint:{materials:{metal:{name:'旧名称'}}}};targets.set(doc,{library:'materials',id:'metal'});assert.equal(targets.current(doc).name,'旧名称');doc.paint.materials.metal.name='新名称';assert.equal(targets.current(doc).name,'新名称');delete doc.paint.materials.metal;assert.equal(targets.current(doc).name,'新名称');assert.equal(createShaderTargets(targets.snapshot()).current(doc).name,'新名称');
});
