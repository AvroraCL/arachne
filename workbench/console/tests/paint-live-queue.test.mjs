import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaintLiveQueue} from '../paint-live-queue.mjs';

function fixture(options){
  const workers=[];
  const queue=createPaintLiveQueue(callbacks=>{
    const worker={...callbacks,requests:[],stopped:false,request(id,config){this.requests.push({id,config});},stop(){this.stopped=true;}};
    workers.push(worker);return worker;
  },options);
  return {queue,workers,result(value,error=null){const w=workers.at(-1),request=w.requests.at(-1);w.result(request.id,value,error);}};
}

test('waiting previews cancel before entering the persistent compositor',async()=>{
  const f=fixture(),controller=new AbortController();
  const first=f.queue.submit('first'),stale=f.queue.submit('stale',{signal:controller.signal}),last=f.queue.submit('latest');
  const cancellation=assert.rejects(stale,e=>e.name==='AbortError');controller.abort();await cancellation;
  assert.equal(f.workers.length,1);assert.deepEqual(f.workers[0].requests.map(r=>r.config),['first']);
  f.result('one');assert.equal(await first,'one');assert.deepEqual(f.workers[0].requests.map(r=>r.config),['first','latest']);
  f.result('three');assert.equal(await last,'three');assert.equal(f.queue.pending,0);f.queue.stop();
});

test('active cancellation detaches immediately, keeps the cache warm and releases the next request on reply',async()=>{
  const f=fixture(),controller=new AbortController();
  const first=f.queue.submit('first',{signal:controller.signal}),cancelled=assert.rejects(first,e=>e.name==='AbortError');
  controller.abort();await cancelled;assert.equal(f.queue.pending,0);assert.equal(f.workers[0].stopped,false);
  const last=f.queue.submit('latest');assert.equal(f.workers[0].requests.length,1);
  f.result('discarded');assert.equal(f.workers[0].requests.length,2);f.result('current');assert.equal(await last,'current');assert.equal(f.workers.length,1);f.queue.stop();
});

test('capacity errors do not disturb accepted requests, and cancelled queue slots are reusable',async()=>{
  const f=fixture({limit:2}),controller=new AbortController();
  const first=f.queue.submit('first'),second=f.queue.submit('second',{signal:controller.signal});
  await assert.rejects(f.queue.submit('too-many'),e=>e.status===503);
  const cancelled=assert.rejects(second,e=>e.name==='AbortError');controller.abort();await cancelled;
  const replacement=f.queue.submit('replacement');f.result('1');await first;f.result('2');assert.equal(await replacement,'2');f.queue.stop();
});

test('worker failure releases all requests and old-generation replies cannot complete a retry',async()=>{
  const f=fixture();const first=f.queue.submit('first'),second=f.queue.submit('second');
  const a=assert.rejects(first,/crashed/),b=assert.rejects(second,/crashed/),old=f.workers[0];old.fail(Error('crashed'));await Promise.all([a,b]);
  assert.equal(old.stopped,true);assert.equal(f.queue.pending,0);
  const retry=f.queue.submit('retry');old.result(old.requests[0].id,'stale');assert.equal(f.queue.pending,1);f.result('fresh');assert.equal(await retry,'fresh');f.queue.stop();
});

test('the watchdog still terminates a stuck compositor after its caller cancels',async()=>{
  const f=fixture({timeout:35}),controller=new AbortController(),first=f.queue.submit('first',{signal:controller.signal});
  const cancelled=assert.rejects(first,e=>e.name==='AbortError');controller.abort();await cancelled;
  const next=f.queue.submit('next');await assert.rejects(next,/超时/);assert.equal(f.workers[0].stopped,true);assert.equal(f.queue.pending,0);
  const retry=f.queue.submit('retry');f.result('recovered');assert.equal(await retry,'recovered');f.queue.stop();
});

test('already aborted submissions never create workers and stop releases active/queued promises',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.queue.submit('cancelled',{signal:controller.signal}),e=>e.name==='AbortError');assert.equal(f.workers.length,0);
  const first=f.queue.submit('first'),second=f.queue.submit('second');const a=assert.rejects(first,e=>e.name==='AbortError'),b=assert.rejects(second,e=>e.name==='AbortError');f.queue.stop();await Promise.all([a,b]);assert.equal(f.queue.pending,0);
});
