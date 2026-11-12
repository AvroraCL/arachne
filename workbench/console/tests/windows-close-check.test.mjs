import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {checkRendererClose} from '../release-support/windows/close-check.mjs';

test('an unresponsive renderer cannot stall the Windows close decision',async()=>{
  let resolve,reads=0;
  const result=await checkRendererClose(()=>{
    reads++;
    return new Promise(done=>{resolve=done;});
  },{timeoutMs:35,pollMs:5});
  assert.equal(result,'unresponsive');
  resolve('saving');
  await delay(12);
  assert.equal(reads,1);
});

test('close waits for acknowledged writes and retains unsaved and editing states',async()=>{
  const statuses=['saving','saving','unsaved'];
  assert.equal(await checkRendererClose(()=>statuses.shift(),{timeoutMs:300,pollMs:5}),'unsaved');
  assert.equal(await checkRendererClose(()=>Promise.resolve('editing')),'editing');
  assert.equal(await checkRendererClose(()=>Promise.reject(Error('Renderer exited'))),'unavailable');
});
