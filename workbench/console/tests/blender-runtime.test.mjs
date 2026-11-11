import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {blenderExecutable} from '../blender-runtime.mjs';

test('Windows honors the Blender override and can fall back to PATH',()=>{
  assert.equal(blenderExecutable({ARACHNE_BLENDER:'D:\\Blender 便携版\\blender.exe'},'win32'),
    'D:\\Blender 便携版\\blender.exe');
  assert.equal(blenderExecutable({},'win32'),'blender.exe');
});

test('Windows finds the newest installed Blender with an executable',t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'Arachne 工作台 '));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const programFiles=path.join(folder,'Program Files');
  const localAppData=path.join(folder,'Local AppData');
  const foundation=path.join(programFiles,'Blender Foundation');
  function install(root,name){
    const file=path.join(root,name,'blender.exe');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,'');
    return file;
  }
  const old=install(foundation,'Blender 5.2');
  const latest=install(foundation,'Blender 5.10');
  fs.mkdirSync(path.join(foundation,'Blender 6.0'),{recursive:true});
  fs.writeFileSync(path.join(foundation,'Blender 7.0'),'');
  const user=install(path.join(localAppData,'Programs','Blender Foundation'),'Blender 5.3');
  const env={ProgramFiles:programFiles,LOCALAPPDATA:localAppData};
  assert.equal(blenderExecutable(env,'win32'),latest);
  fs.unlinkSync(latest);
  assert.equal(blenderExecutable(env,'win32'),old);
  fs.unlinkSync(old);
  assert.equal(blenderExecutable(env,'win32'),user);
});
