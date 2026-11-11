import test from 'node:test';
import assert from 'node:assert/strict';
import {createGeometryQueue,waitForGeometry} from '../geometry-queue.mjs';
import {showGeometryStatus} from '../public/paint-geometry-status.mjs';

const deferred=()=>Promise.withResolvers();
test('geometry builds run sequentially and failures release the queue',async()=>{
  const queue=createGeometryQueue(),first=deferred(),calls=[];
  const a=queue.submit(async()=>{calls.push('first');await first.promise;throw Error('broken');});
  const error=assert.rejects(a,/broken/);
  const b=queue.submit(async()=>{calls.push('second');return 2;});
  assert.deepEqual(calls,['first']);first.resolve();
  await error;assert.equal(await b,2);assert.deepEqual(calls,['first','second']);
});
test('stopping queued work does not start its Blender process',async()=>{
  const queue=createGeometryQueue(),first=deferred(),controller=new AbortController();let called=false;
  const a=queue.submit(()=>first.promise),b=queue.submit(()=>{called=true;},controller.signal);
  controller.abort();first.resolve();await a;
  await assert.rejects(b,error=>error.cancelled);assert.equal(called,false);
  queue.close();await assert.rejects(queue.submit(()=>{}),error=>error.cancelled);
});
test('a cancelled preview detaches immediately while the shared live build finishes',async()=>{
  const build=deferred(),controller=new AbortController();
  const preview=waitForGeometry(build.promise,controller.signal),live=waitForGeometry(build.promise);
  controller.abort();await assert.rejects(preview,error=>error.cancelled);
  build.resolve('ready');assert.equal(await live,'ready');
  await assert.rejects(waitForGeometry(Promise.resolve('already ready'),controller.signal),error=>error.cancelled);
});
test('geometry status offers retry after failure and hides itself when ready',()=>{
  const nodes=()=>({hidden:false,dataset:{},textContent:'',disabled:false,title:''});
  const elements={status:nodes(),retry:nodes(),log:nodes()};
  showGeometryStatus(elements,{status:'queued'});assert.match(elements.status.textContent,/排队/);assert.equal(elements.retry.hidden,true);
  showGeometryStatus(elements,{status:'running',stage:'计算投影与遮挡'});assert.match(elements.status.textContent,/遮挡/);
  showGeometryStatus(elements,{status:'failed',error:'工具执行失败',logUrl:'/log'});
  assert.equal(elements.status.title,'工具执行失败');assert.equal(elements.retry.hidden,false);assert.equal(elements.log.href,'/log');
  showGeometryStatus(elements,{status:'ready',logUrl:'/log'});assert.equal(elements.status.hidden,true);assert.equal(elements.retry.hidden,true);
});
