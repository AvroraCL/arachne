import assert from 'node:assert/strict';
import test from 'node:test';
import {readNodeClipboard,writeNodeClipboard} from '../public/node-clipboard.mjs';

test('quick native copy then paste waits for the latest system clipboard write',async()=>{
  let system='some unrelated text',unblock;
  const calls=[];
  const win={arachneDesktop:{
    async writeNodeClipboard(value){
      calls.push(value);
      if(calls.length===1)await new Promise(resolve=>{unblock=resolve;});
      system=value;
    },
    async readNodeClipboard(){calls.push('read');return system;}
  }};
  const first=writeNodeClipboard(win,'first node selection');
  const second=writeNodeClipboard(win,'second node selection');
  const paste=readNodeClipboard(win);
  assert.deepEqual(calls,['first node selection']);
  unblock();
  await Promise.all([first,second]);
  assert.equal(await paste,'second node selection');
  assert.deepEqual(calls,['first node selection','second node selection','read']);
  system=null;
  assert.equal(await readNodeClipboard(win),null);
});
