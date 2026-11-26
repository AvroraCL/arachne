import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {installedProfileCatalog} from '../installed-color-profiles.mjs';

test('the local profile selector distinguishes equal filenames, skips unusable files and reads the selected ICC',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-installed-icc-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const user=path.join(root,'个人 色样'),system=path.join(root,'system'),sub=path.join(user,'印刷');
  await Promise.all([fs.mkdir(sub,{recursive:true}),fs.mkdir(system)]);
  const bundled=new URL('../public/color-profiles/',import.meta.url);
  const p3=await fs.readFile(new URL('DisplayP3-v4.icc',bundled)),gray=await fs.readFile(new URL('Gray-g22.icc',bundled));
  await Promise.all([fs.writeFile(path.join(sub,'测试.icm'),p3),fs.writeFile(path.join(system,'测试.icm'),gray),
    fs.writeFile(path.join(sub,'broken.icc'),Buffer.alloc(12)),fs.writeFile(path.join(sub,'ignored.txt'),p3)]);
  const linkProfile=Buffer.from(p3);linkProfile.write('link',12);
  await fs.writeFile(path.join(sub,'link.icc'),linkProfile);
  const catalog=installedProfileCatalog([['个人',user],['系统',system],['缺失',path.join(root,'absent')]]);
  const entries=await catalog.list();
  assert.equal(entries.length,2);
  const first=entries.find(entry=>entry.group==='个人'),second=entries.find(entry=>entry.group==='系统');
  assert.equal(first.mode,'RGB');assert.equal(second.mode,'GRAY');assert.notEqual(first.id,second.id);
  assert.equal(path.isAbsolute(first.name),false);
  assert.deepEqual(await catalog.read(first.id),p3);assert.deepEqual(await catalog.read(second.id),gray);
  await assert.rejects(catalog.read(path.join(sub,'测试.icm')),/重新打开/);
  await fs.writeFile(path.join(sub,'测试.icm'),'corrupt');
  await assert.rejects(catalog.read(first.id),/已变更/);
  assert.deepEqual(await catalog.list(),[second]);
});
