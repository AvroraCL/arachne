import test from 'node:test';import assert from 'node:assert/strict';
import {objectClickSelection as click} from '../public/paint-object-selection.mjs';
test('Shift adds a new active object, reactivates selected peers, then toggles the active one off',()=>{
 let state=click([],null,'a');assert.deepEqual(state,{selected:['a'],active:'a'});
 state=click(state.selected,state.active,'b',true);assert.deepEqual(state,{selected:['a','b'],active:'b'});
 state=click(state.selected,state.active,'a',true);assert.deepEqual(state,{selected:['a','b'],active:'a'});
 state=click(state.selected,state.active,'a',true);assert.deepEqual(state,{selected:['b'],active:'b'});
 state=click(state.selected,state.active,'b',true);assert.deepEqual(state,{selected:[],active:null});
});
test('plain clicks replace selection, never alias previous state and keep object identity',()=>{
 const a={},b={},selected=[a,b],state=click(selected,b,a,true);assert.deepEqual(selected,[a,b]);assert.notEqual(state.selected,selected);assert.equal(state.active,a);
 assert.deepEqual(click(selected,b,a),{selected:[a],active:a});
});
