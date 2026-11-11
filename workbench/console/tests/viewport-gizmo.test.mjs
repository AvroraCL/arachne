import test from 'node:test';
import assert from 'node:assert/strict';
import {orderAxisItems} from '../public/viewport-gizmo.mjs';
test('symmetric axes keep a deterministic SVG order despite floating-point camera drift',()=>{
  const items=[{order:0,depth:.6246950475544243},{order:1,depth:.6246950475544244},{order:2,depth:-.6246950475544243}];
  const first=orderAxisItems(items).map(item=>item.order);
  const next=items.map(item=>({...item,depth:item.depth+(item.order===0?1e-14:-1e-14)}));
  assert.deepEqual(orderAxisItems(next).map(item=>item.order),first);assert.deepEqual(first,[2,0,1]);
  assert.deepEqual(orderAxisItems([{order:0,depth:.8},{order:1,depth:-.2}]).map(item=>item.order),[1,0]);
});
