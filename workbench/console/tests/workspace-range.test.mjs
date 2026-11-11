import test from 'node:test';
import assert from 'node:assert/strict';
import {scrubRangeValue} from '../public/workspace-range-input.mjs';
import {numericReadout,rangePercent} from '../public/workspace-range.mjs';

test('range progress handles negative origins, fractions and endpoints',()=>{
  assert.equal(rangePercent(0,-4,4),50);assert.equal(rangePercent(-3,-4,4),12.5);
  assert.equal(rangePercent(.5,0,1),50);assert.equal(rangePercent(.02,.02,.65),0);
  assert.equal(rangePercent(.65,.02,.65),100);assert.equal(rangePercent(50),50);
});
test('invalid or degenerate ranges remain bounded',()=>{
  assert.equal(rangePercent(999,0,100),100);assert.equal(rangePercent(-10,0,100),0);
  for(const [value,min,max] of [[NaN,0,1],[1,1,1],[1,2,1],[1,0,Infinity]])assert.equal(rangePercent(value,min,max),0);
});

test('relative scrubbing is symmetric and Shift applies tenfold precision without jumping',()=>{
  assert.equal(scrubRangeValue(50,24,100),60);
  assert.equal(scrubRangeValue(50,-24,100),40);
  assert.equal(scrubRangeValue(50,24,100,true),51);
  assert.equal(scrubRangeValue(60,0,100,true),60);
  assert.equal(scrubRangeValue(scrubRangeValue(50,24,100),24,100,true),61);
  assert.equal(scrubRangeValue(-2,-30,8),-3);
});

test('numeric labels are compact and retain the sign of small nonzero values',()=>{
  for(const [value,label] of [[NaN,''],[-0,'0'],[.7287683823529412,'0.7288'],[1.2,'1.2'],[-.000005,'-5e-6'],[123456789,'1.2346e+8']]){
    assert.equal(numericReadout(value),label);
  }
});
