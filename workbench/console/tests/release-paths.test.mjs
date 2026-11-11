import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {dataDirectory,checkedRootAliases} from '../release-paths.mjs';
import {APP_VERSION,PACKAGE_VERSION,RELEASE_TAG} from '../public/app-version.mjs';

test('release version agrees across display, package and lockfile',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))),lock=JSON.parse(fs.readFileSync(new URL('../package-lock.json',import.meta.url)));
  assert.equal(pkg.version,PACKAGE_VERSION);assert.equal(lock.version,PACKAGE_VERSION);assert.equal(lock.packages[''].version,PACKAGE_VERSION);assert.equal(RELEASE_TAG,'v'+APP_VERSION);assert.equal(APP_VERSION,'0.0.1.alpha.1');
});
test('external release data requires explicit absolute opt-in without weakening development guard',()=>{
  assert.equal(dataDirectory('/app/console',{}),'/app/console/data');
  assert.throws(()=>dataDirectory('/app/console',{ARACHNE_DATA_DIR:'/users/projects'}));
  assert.throws(()=>dataDirectory('/app/console',{ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_DATA_DIR:'relative'}));
  for(const dir of ['/','/app','/app/console'])assert.throws(()=>dataDirectory('/app/console',{ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_DATA_DIR:dir}));
  assert.equal(dataDirectory('/app/console',{ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_DATA_DIR:'/users/projects'}),'/users/projects');
});
test('saved install aliases are bounded absolute non-root paths',()=>{
  assert.deepEqual(checkedRootAliases(['/Applications/阿拉克涅.app','/',null,12,'relative']),['/Applications/阿拉克涅.app']);
  assert.throws(()=>checkedRootAliases({}));assert.throws(()=>checkedRootAliases(Array(33).fill('/app')));
});
