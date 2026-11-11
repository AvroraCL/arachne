import test from 'node:test';import assert from 'node:assert/strict';
import {outlineBranches,outlineRows} from '../public/scene-outline.mjs';
const items=[{id:1,label:'机体',parentId:null},{id:2,label:'左翼',parentId:1},{id:3,label:'翼尖',parentId:2},{id:4,label:'座舱',parentId:null}];
test('outline uses real parents, keeps sibling order, and folding preserves the source',()=>{
  const original=JSON.stringify(items);assert.deepEqual(outlineRows(items).map(r=>[r.item.id,r.depth,r.hasChildren]),[[1,0,true],[2,1,true],[3,2,false],[4,0,false]]);
  assert.deepEqual(outlineRows(items,{collapsed:[1]}).map(r=>r.item.id),[1,4]);assert.deepEqual(outlineRows(items,{collapsed:[2]}).map(r=>r.item.id),[1,2,4]);assert.equal(JSON.stringify(items),original);
});
test('search retains ancestor paths and temporarily opens folded parents without clearing folding',()=>{
  const collapsed=[1,2],rows=outlineRows(items,{query:' 翼尖 ',collapsed});assert.deepEqual(rows.map(r=>[r.item.id,r.matched,r.expanded]),[[1,false,true],[2,false,true],[3,true,false]]);assert.deepEqual(collapsed,[1,2]);assert.deepEqual(outlineRows(items,{collapsed}).map(r=>r.item.id),[1,4]);assert.deepEqual(outlineRows(items,{query:'missing'}),[]);
});
test('flat scenes, missing parents and case-insensitive full names remain readable',()=>{
  assert.deepEqual(outlineRows([{id:'a',label:'vehicle#FUSE',parentId:'missing'}],{query:'fuse'}).map(r=>[r.item.id,r.depth]),[['a',0]]);assert.deepEqual(outlineRows([]),[]);
});
test('state filters keep ancestor paths and combine with aliases and original names',()=>{
  const renamed=items.map(item=>item.id===3?{...item,label:'翼尖改名',sourceLabel:'vehicle#WINGTIP'}:item);
  const result=outlineRows(renamed,{query:'ＷＩＮＧ',collapsed:[1,2],filterIds:new Set([3,4])});
  assert.deepEqual(result.map(({item,matched,expanded})=>[item.id,matched,expanded]),[[1,false,true],[2,false,true],[3,true,false]]);
  assert.deepEqual(outlineRows(renamed,{query:'左翼',filterIds:new Set([2])}).map(r=>[r.item.id,r.hasChildren]),[[1,true],[2,false]]);
  assert.deepEqual(outlineRows(renamed,{query:'左翼',filterIds:new Set([3])}),[]);
});
test('branch guides end at the last visible sibling after filtering',()=>{
  const guides=rows=>rows.map(({item,ancestorGuides,hasNext})=>[item.id,ancestorGuides,hasNext]);
  assert.deepEqual(guides(outlineRows(items)),[[1,[],true],[2,[true],false],[3,[true,false],false],[4,[],false]]);
  assert.deepEqual(guides(outlineRows(items,{query:'翼尖'})),[[1,[],false],[2,[false],false],[3,[false,false],false]]);
});
test('recursive folding targets only branches in the requested subtree',()=>{
  const nested=[...items,{id:5,label:'仪表',parentId:4}];
  assert.deepEqual([...outlineBranches(nested,1)],[1,2]);
  assert.deepEqual([...outlineBranches(nested,3)],[]);
  assert.deepEqual([...outlineBranches(nested)].sort(),[1,2,4]);
  assert.deepEqual(outlineRows(nested,{collapsed:outlineBranches(nested,1)}).map(row=>row.item.id),[1,4,5]);
});
