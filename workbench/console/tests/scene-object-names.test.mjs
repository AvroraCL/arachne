import test from 'node:test';import assert from 'node:assert/strict';
import {renamedObjects,validateObjectNames} from '../public/scene-object-names.mjs';
test('batch names use stable source identity, deterministic numbering and unique names',()=>{
 const items=[{id:1,label:'左翼',sourceName:'wing_l'},{id:2,label:'右翼',sourceName:'wing_r'},{id:3,label:'机翼_1'}];
 assert.deepEqual(renamedObjects(items,[2,1],'机翼_{n}'),{wing_l:'机翼_1.001',wing_r:'机翼_2'});
 assert.deepEqual(renamedObjects(items,[1],'{name}_新'),{wing_l:'左翼_新'});assert.equal(items[0].label,'左翼');
});
test('invalid imported and authored object names are rejected',()=>{
 for(const value of [null,[],{'x':''},{'x':'a\nb'},JSON.parse('{"__proto__":"x"}')])assert.throws(()=>validateObjectNames(value));
 assert.throws(()=>renamedObjects([{id:1,label:'A'}],[1],' '));validateObjectNames(undefined);validateObjectNames({'original':'新名称'});
});
