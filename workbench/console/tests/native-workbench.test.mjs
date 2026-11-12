import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeWorkbench,notifyNativeProject} from '../public/native-workbench.mjs';

function fixture(flush){
  const calls=[],controls=new Map();let modal=false,focused=null,state='ready';
  for(const id of ['new','open-projects','open-paint-import','open-glb-migration','open-command-picker','open-workspace-layouts','open-delivery','undo','redo'])
    controls.set(id,{disabled:false,hidden:false,click(){calls.push(id);}});
  const document={get activeElement(){return focused;},querySelector:()=>modal?{}:null,getElementById:id=>controls.get(id),execCommand:name=>(calls.push('text-'+name),true)};
  const bridge=createNativeWorkbench({window:{},document,status:()=>({state}),flush});
  return {bridge,calls,controls,focus:value=>focused=value,modal:value=>modal=value,state:value=>state=value};
}

test('native menu invokes only known, enabled workbench commands and respects dialogs',()=>{
  const f=fixture();
  assert.equal(f.bridge.command('newProject'),true);assert.equal(f.bridge.command('importArchive'),true);
  assert.deepEqual(f.calls,['new','open-paint-import']);
  f.controls.get('open-delivery').disabled=true;assert.equal(f.bridge.command('export'),false);
  f.modal(true);assert.equal(f.bridge.command('openProject'),false);assert.equal(f.bridge.command('save'),false);
  assert.equal(f.bridge.command("unknown');danger()"),false);assert.deepEqual(f.calls,['new','open-paint-import']);
});
test('native command search and migration use the same UI availability',()=>{
  const f=fixture();
  f.controls.get('open-glb-migration').hidden=true;
  assert.equal(f.bridge.command('migrateModel'),false);
  assert.equal(f.bridge.command('searchCommands'),true);
  f.controls.get('open-glb-migration').hidden=false;
  assert.equal(f.bridge.command('migrateModel'),true);
  assert.equal(f.bridge.command('workspaceLayouts'),true);
  assert.deepEqual(f.calls,['open-command-picker','open-glb-migration','open-workspace-layouts']);
});
test('undo targets focused text first, otherwise uses the shared project history',()=>{
  const f=fixture();assert.equal(f.bridge.command('undo'),true);assert.equal(f.bridge.command('redo'),true);
  f.focus({matches:()=>true});assert.equal(f.bridge.command('undo'),true);
  assert.deepEqual(f.calls,['undo','redo','text-undo']);
});
test('saving and quit commit a valid focused field and retain the actual state',()=>{
  const f=fixture(),field={matches:()=>true,validity:{valid:true},blur(){f.calls.push('blur');f.state('saving');}};
  f.focus(field);assert.equal(f.bridge.command('save'),true);assert.equal(f.bridge.prepareToClose().state,'saving');
  assert.deepEqual(f.calls,['blur','blur']);
  field.validity.valid=false;f.state('ready');assert.deepEqual(f.bridge.prepareToClose(),{state:'editing'});
  f.modal(true);f.state('editing');assert.deepEqual(f.bridge.prepareToClose(),{state:'editing'});
});
test('project notification is optional and sends only the project identity',()=>{
  const messages=[];notifyNativeProject({},null);notifyNativeProject({}, {id:'p'});
  notifyNativeProject({webkit:{messageHandlers:{arachne:{postMessage:value=>messages.push(value)}}}},{id:'p-1',name:'测试'});
  assert.deepEqual(messages,[{type:'project',id:'p-1',name:'测试'}]);
});

test('native shutdown waits for the last workspace save and preserves editing guards',async()=>{
  let finish,started=false;
  const f=fixture(()=>{started=true;return new Promise(resolve=>{finish=resolve;});});
  f.state('editing');
  assert.deepEqual(await f.bridge.prepareToCloseAsync(),{state:'editing'});
  assert.equal(started,false);
  f.state('ready');
  let returned=false;
  const result=f.bridge.prepareToCloseAsync().then(value=>{returned=true;return value;});
  assert.equal(started,true);assert.equal(returned,false);
  finish();
  assert.deepEqual(await result,{state:'ready'});
});
