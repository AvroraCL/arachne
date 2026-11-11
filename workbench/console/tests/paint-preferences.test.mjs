import test from 'node:test';
import assert from 'node:assert/strict';
import {preferenceKey,preferenceDefaults,brushDefaults,normalizePreferences,normalizeBrush,normalizeSettingsBundle,loadPreferences,saveSettingsBundle} from '../public/paint-preferences.mjs';
import {sceneOptions} from '../public/scene-options.mjs';

const bundle=()=>({version:1,preferences:{...preferenceDefaults},brush:{...brushDefaults},display:sceneOptions()});
const memory=()=>{
  const map=new Map();return {map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
};
test('preferences survive JSON round trips and bad stored values safely use defaults',()=>{
  const storage=memory(),p={...preferenceDefaults,motion:'reduced',startupArea:'material',detailDelay:1500};
  storage.setItem(preferenceKey,JSON.stringify(p));assert.deepEqual(loadPreferences(storage),p);
  for(const raw of ['bad','null','[]','{"autoDetail":"false"}','{"detailDelay":1}']){
    storage.setItem(preferenceKey,raw);assert.deepEqual(loadPreferences(storage),preferenceDefaults);
  }
});
test('import rejects unsupported versions, unknown fields and invalid numeric/boolean values',()=>{
  assert.throws(()=>normalizePreferences({detailDelay:NaN}));assert.throws(()=>normalizePreferences({motion:'random'}));
  assert.throws(()=>normalizeBrush({uvRadius:1}));assert.throws(()=>normalizeBrush({pressure:'false'}));
  assert.throws(()=>normalizeBrush({uvRadius:32.5}));
  for(const raw of [{...bundle(),version:2},{...bundle(),password:'secret'},{...bundle(),display:{exposure:99}},{...bundle(),brush:null}])
    assert.throws(()=>normalizeSettingsBundle(raw));
  assert.deepEqual(normalizeSettingsBundle(JSON.parse(JSON.stringify(bundle()))),bundle());
});
test('saving updates existing brush/display preference formats and preserves unrelated state',()=>{
  const storage=memory();storage.setItem('arachne-paint-colors-v1','colors');storage.setItem('arachne-paint-docks','layout');
  const next=bundle();next.brush.uvRadius=128;next.display.grid=false;
  saveSettingsBundle(storage,next);
  assert.equal(JSON.parse(storage.getItem('arachne-paint-brush-v1'))['brush-uv-radius'],128);
  assert.equal(JSON.parse(storage.getItem('arachne-paint-display')).grid,false);
  assert.equal(storage.getItem('arachne-paint-colors-v1'),'colors');assert.equal(storage.getItem('arachne-paint-docks'),'layout');
});
test('partial storage failure rolls back saved preferences before anything is applied',()=>{
  const storage=memory();for(const key of [preferenceKey,'arachne-paint-brush-v1','arachne-paint-display'])storage.setItem(key,'previous');
  const before=new Map(storage.map),set=storage.setItem;
  storage.setItem=(key,value)=>{if(key==='arachne-paint-display')throw Error('quota');return set(key,value);};
  assert.throws(()=>saveSettingsBundle(storage,bundle()),/无法保存/);assert.deepEqual(storage.map,before);
});
