import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {appendProjectHistory,listProjectHistory,restoreProjectHistory,storedProjectHistory,pruneHistorySnapshots} from '../project-history-store.mjs';
import {saveProjectTransaction} from '../project-transaction.mjs';
import {paintHistoryEntries,travelPaintHistory} from '../public/paint-history-state.mjs';

function project(revision,opacity=1){
  return {id:'work',name:'历史工程',revision,source:{format:'glb'},paint:{layers:[{id:'fill',kind:'fill',opacity}]}};
}
function testFolder(t){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'阿拉克涅 历史-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  return folder;
}
function publish(folder,doc,index){
  saveProjectTransaction(folder,doc,storedProjectHistory(index));
  pruneHistorySnapshots(folder,index);
}

test('legacy undo/redo history migrates and multi-step travel retains labels and current source',t=>{
  const folder=testFolder(t),current=project(4,.4);
  const legacy={undo:[project(0),project(1,.9),project(2,.75)],redo:[project(5,.5)]};
  fs.writeFileSync(path.join(folder,'history.json'),JSON.stringify(legacy));
  assert.deepEqual(listProjectHistory(folder,current),paintHistoryEntries(current,legacy));
  const expected=travelPaintHistory(current,legacy,'undo',2);
  const undo=restoreProjectHistory(folder,current,'undo',2);
  assert.deepEqual(undo.restored,expected.restored);
  publish(folder,undo.restored,undo.index);
  assert.deepEqual(listProjectHistory(folder,undo.restored),paintHistoryEntries(undo.restored,expected.history));
  const reopened={...undo.restored,source:{format:'glb',cacheRun:'moved source'}};
  const redo=restoreProjectHistory(folder,reopened,'redo',2);
  assert.equal(redo.restored.paint.layers[0].opacity,.4);
  assert.deepEqual(redo.restored.source,reopened.source);
  publish(folder,redo.restored,redo.index);
  const originalChange={...project(6,.66),source:reopened.source};
  const newBranch=appendProjectHistory(folder,redo.restored,originalChange);
  publish(folder,originalChange,newBranch);
  assert.equal(listProjectHistory(folder,originalChange).redoCount,0);
  assert.equal(restoreProjectHistory(folder,originalChange,'redo'),null);
  assert.equal(restoreProjectHistory(folder,originalChange,'undo').restored.paint.layers[0].opacity,.4);
});

test('only the new snapshot and compact history index are written; expired snapshots are pruned',t=>{
  const folder=testFolder(t),snapshotFolder=path.join(folder,'history-snapshots');
  const payload='geometry test value\n'.repeat(5000);
  let current={...project(0),payload};
  for(let revision=1;revision<=52;revision++){
    const next={...project(revision,1-revision/100),payload};
    const index=appendProjectHistory(folder,current,next);
    publish(folder,next,index);
    current=next;
  }
  assert.equal(listProjectHistory(folder,current).undoCount,50);
  assert.equal(fs.readdirSync(snapshotFolder).length,50);
  assert.ok(fs.statSync(path.join(folder,'history.json')).size<10_000);
  assert.equal(restoreProjectHistory(folder,current,'undo',50).restored.paint.layers[0].opacity,.98);
  assert.equal(restoreProjectHistory(folder,current,'undo',50).restored.payload,payload);
});

test('an unreadable snapshot does not modify the saved project or other undo entries',t=>{
  const folder=testFolder(t),before=project(0),after=project(1,.8);
  const index=appendProjectHistory(folder,before,after);
  publish(folder,after,index);
  const stored=JSON.parse(fs.readFileSync(path.join(folder,'history.json'),'utf8'));
  assert.deepEqual(stored.undo,[]);
  assert.deepEqual(stored.redo,[]);
  fs.writeFileSync(path.join(folder,'history-snapshots',index.undo[0].hash+'.json.gz'),'corrupted');
  assert.throws(()=>restoreProjectHistory(folder,after,'undo'),{code:'EINVALIDHISTORY',status:422});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'project.json'),'utf8')),after);
  const later=project(2,.5),updated=appendProjectHistory(folder,after,later);
  publish(folder,later,updated);
  assert.equal(restoreProjectHistory(folder,later,'undo').restored.paint.layers[0].opacity,.8);
});
