import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {recoverProjectTransaction,saveProjectTransaction} from '../project-transaction.mjs';

const entry=new URL('../project-transaction.mjs',import.meta.url).href;
const before={id:'p',revision:3,paint:{layers:[]}};
const after={id:'p',revision:4,paint:{layers:[{id:'stroke'}]}};
const history={undo:[{id:'p',paint:{layers:[]}}],redo:[]};

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'阿拉克涅 保存-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'project.json'),JSON.stringify(before));
  fs.writeFileSync(path.join(dir,'history.json'),JSON.stringify({undo:[],redo:[]}));
  return {dir,read:name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))};
}

function crashSave(dir,name){
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';
    import path from 'node:path';
    import {saveProjectTransaction} from ${JSON.stringify(entry)};
    const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{
      if(path.basename(to)===${JSON.stringify(name)})process.exit(41);
      return rename(from,to);
    };
    saveProjectTransaction(${JSON.stringify(dir)},${JSON.stringify(after)},${JSON.stringify(history)});
  `],{encoding:'utf8'});
  assert.equal(result.status,41,result.stderr);
}

test('project and undo history are recovered together after the process exits between replacements',t=>{
  const {dir,read}=fixture(t);
  crashSave(dir,'project.json');
  assert.deepEqual(read('project.json'),before);
  assert.deepEqual(read('history.json'),history);
  assert.equal(recoverProjectTransaction(dir),true);
  assert.deepEqual(read('project.json'),after);
  assert.deepEqual(read('history.json'),history);
  assert.equal(recoverProjectTransaction(dir),false);
  assert.deepEqual(fs.readdirSync(dir).sort(),['history.json','project.json']);
});

test('a process exit before publishing keeps both previously saved files',t=>{
  const {dir,read}=fixture(t);
  crashSave(dir,'.save-pending.json');
  assert.equal(recoverProjectTransaction(dir),false);
  assert.deepEqual(read('project.json'),before);
  assert.deepEqual(read('history.json'),{undo:[],redo:[]});
  saveProjectTransaction(dir,after,history);
  assert.deepEqual(read('project.json'),after);
  assert.deepEqual(read('history.json'),history);
});

test('recovery refuses a corrupted replacement before changing either destination',t=>{
  const {dir,read}=fixture(t);
  crashSave(dir,'history.json');
  const record=read('.save-pending.json');
  fs.writeFileSync(path.join(dir,record.stage,'project.json'),'{bad}');
  assert.throws(()=>recoverProjectTransaction(dir),{code:'EINVALIDPROJECT',status:422});
  assert.deepEqual(read('project.json'),before);
  assert.deepEqual(read('history.json'),{undo:[],redo:[]});
});
