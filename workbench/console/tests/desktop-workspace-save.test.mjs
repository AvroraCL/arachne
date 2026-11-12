import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopWorkspace} from '../public/paint-desktop-workspace.mjs';

test('a lost layout response is reconciled before publishing a newer local layout',async()=>{
  let stored={revision:1,layout:{name:'original'}},writes=0;
  const workspace=createDesktopWorkspace(stored,async options=>{
    if(!options)return stored;
    const {revision,layout}=JSON.parse(options.body);
    assert.equal(revision,stored.revision);
    stored={revision:revision+1,layout};
    if(++writes===1)throw Error('response lost');
    return stored;
  });
  workspace.save('{"name":"first"}',()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  workspace.save('{"name":"current"}',()=>{});
  assert.equal(await workspace.flush(),false);
  assert.equal(writes,1);
  assert.equal(await workspace.retry(),true);
  assert.deepEqual(stored,{revision:3,layout:{name:'current'}});
  assert.equal(await workspace.flush(),true);
});

test('a different saved layout is preserved until the user explicitly replaces it',async()=>{
  let stored={revision:2,layout:{name:'external'}},writes=0;
  const workspace=createDesktopWorkspace({revision:1,layout:{name:'original'}},async options=>{
    if(!options)return stored;
    writes++;
    const {revision,layout}=JSON.parse(options.body);
    if(revision!==stored.revision)throw Object.assign(Error('conflict'),{status:409});
    return stored={revision:revision+1,layout};
  });
  workspace.save('{"name":"current"}',()=>{});
  assert.equal(await workspace.flush(),false);
  assert.equal(await workspace.retry(),false);
  assert.equal(writes,1);
  assert.deepEqual(stored,{revision:2,layout:{name:'external'}});
  assert.equal(await workspace.retry({replace:true}),true);
  assert.deepEqual(stored,{revision:3,layout:{name:'current'}});
});

test('accepting an externally saved layout discards only the local change and sends no write',async()=>{
  const remote={revision:4,layout:{name:'external'}};
  let writes=0,applied;
  const workspace=createDesktopWorkspace({revision:3,layout:{name:'original'}},async options=>{
    if(!options)return remote;
    writes++;
    throw Object.assign(Error('conflict'),{status:409});
  });
  workspace.save('{"name":"local"}',()=>{});
  assert.equal(await workspace.flush(),false);
  assert.equal(await workspace.useSaved(layout=>{applied=layout;}),true);
  assert.deepEqual(applied,remote.layout);
  assert.equal(await workspace.flush(),true);
  assert.equal(writes,1);
});
