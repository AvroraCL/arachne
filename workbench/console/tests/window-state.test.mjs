import assert from 'node:assert/strict';
import test from 'node:test';
import {restoreWindowState} from '../release-support/windows/window-state.mjs';

const primary={x:0,y:0,width:1680,height:1010};
const secondary={x:-1280,y:50,width:1280,height:720};
const displays=[primary,secondary];

test('desktop window restores normal DIP bounds on a secondary monitor',()=>{
  const bounds={x:-1210,y:85,width:1110,height:680};
  assert.deepEqual(restoreWindowState({bounds,maximized:true},displays,primary),{
    bounds,minWidth:900,minHeight:600,maximized:true
  });
});

test('desktop window returns to the primary work area after disconnecting a monitor',()=>{
  const bounds={x:-1260,y:70,width:1250,height:680};
  assert.deepEqual(restoreWindowState({bounds},[primary],primary).bounds,
    {x:215,y:165,width:1250,height:680});
});

test('desktop window clamps to the display work area and survives invalid saved geometry',()=>{
  const small={x:-800,y:0,width:800,height:550};
  assert.deepEqual(restoreWindowState({bounds:{x:-770,y:70,width:700,height:640}},
    [primary,small],primary),{bounds:small,minWidth:800,minHeight:550,maximized:false});
  assert.deepEqual(restoreWindowState({bounds:{x:null,y:10,width:-5,height:10},maximized:true},
    displays,primary),{bounds:{x:120,y:55,width:1440,height:900},minWidth:900,minHeight:600,maximized:false});
});
