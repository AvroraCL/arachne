import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCyclesResource} from '../cycles-resource.mjs';

test('formal Cycles work gets the next native slot and cancelled previews do not launch workers',async()=>{
  const resource=createCyclesResource(),events=[];
  const gate=Promise.withResolvers();
  const active=resource.run('preview',async()=>{events.push('active');await gate.promise;events.push('released');});
  const controller=new AbortController();
  const abandoned=resource.run('preview',()=>events.push('obsolete'),{signal:controller.signal});
  const next=resource.run('preview',()=>events.push('preview'));
  const final=resource.run('production',()=>events.push('final'),{onQueued:()=>events.push('waiting')});
  controller.abort();
  await assert.rejects(abandoned,{name:'AbortError',cancelled:true});
  assert.deepEqual(events,['waiting','active']);
  gate.resolve();
  await Promise.all([active,next,final]);
  assert.deepEqual(events,['waiting','active','released','final','preview']);
});

test('a failed native render releases the slot and preserves an already-aborted caller',async()=>{
  const resource=createCyclesResource(),controller=new AbortController();
  const failure=resource.run('production',()=>{throw Error('device lost');});
  const next=resource.run('preview',()=>17);
  controller.abort();
  await assert.rejects(resource.run('production',()=>assert.fail('aborted worker started'),{signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(failure,/device lost/);
  assert.equal(await next,17);
});
