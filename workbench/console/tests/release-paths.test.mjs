import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {dataDirectory,checkedRootAliases} from '../release-paths.mjs';
import {APP_VERSION,PACKAGE_VERSION,RELEASE_TAG} from '../public/app-version.mjs';

test('release version agrees across display, package and lockfile',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))),lock=JSON.parse(fs.readFileSync(new URL('../package-lock.json',import.meta.url)));
  assert.equal(pkg.version,PACKAGE_VERSION);assert.equal(lock.version,PACKAGE_VERSION);assert.equal(lock.packages[''].version,PACKAGE_VERSION);assert.equal(RELEASE_TAG,'v'+APP_VERSION);assert.equal(APP_VERSION,'0.0.1.alpha.1');
});
test('external release data requires explicit absolute opt-in without weakening development guard',()=>{
  const root=path.parse(process.cwd()).root,program=path.join(root,'app','console'),projects=path.join(root,'users','项目 资料');
  assert.equal(dataDirectory(program,{}),path.join(program,'data'));
  assert.throws(()=>dataDirectory(program,{ARACHNE_DATA_DIR:projects}));
  assert.throws(()=>dataDirectory(program,{ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_DATA_DIR:'relative'}));
  for(const dir of [root,path.dirname(program),program])assert.throws(()=>dataDirectory(program,{ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_DATA_DIR:dir}));
  assert.equal(dataDirectory(program,{ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_DATA_DIR:projects}),projects);
});
test('saved install aliases are bounded absolute non-root paths',()=>{
  const root=path.parse(process.cwd()).root,alias=path.join(root,'Applications','阿拉克涅.app');
  assert.deepEqual(checkedRootAliases([alias,root,null,12,'relative']),[alias]);
  assert.throws(()=>checkedRootAliases({}));assert.throws(()=>checkedRootAliases(Array(33).fill('/app')));
});
