import test from 'node:test';import assert from 'node:assert/strict';
import {depthRangeForBounds} from '../public/viewport-depth.mjs';
const bounds={min:{x:-5,y:-2,z:-9},max:{x:5,y:3,z:9}};
const eye={x:0,y:0,z:22},forward={x:0,y:0,z:-1};
function depth24(z,{near:n,far:f}){return Math.round((f/(f-n)-f*n/((f-n)*z))*(2**24-1));}
test('thin nearby surfaces remain distinguishable in a 24-bit perspective buffer',()=>{
 const legacy={near:.001039545824954555,far:2079.09164990911};
 assert.equal(depth24(22-.001,legacy),depth24(22,legacy),'fixture must reproduce the reported precision loss');
 const next=depthRangeForBounds(bounds,eye,forward);
 assert.notEqual(depth24(22-.001,next),depth24(22,next));assert(next.far/next.near<4);
});
test('orbiting, panning and moving far away retain every front-facing bounds corner',()=>{
 for(const eye of [{x:22,y:14,z:18},{x:-18,y:-10,z:-25},{x:0,y:0,z:1000},{x:22,y:10,z:20}]){
  const f={x:-eye.x,y:-eye.y,z:-eye.z},length=Math.hypot(f.x,f.y,f.z),range=depthRangeForBounds(bounds,eye,f);
  for(const x of [-5,5])for(const y of [-2,3])for(const z of [-9,9]){const d=((x-eye.x)*f.x+(y-eye.y)*f.y+(z-eye.z)*f.z)/length;if(d>0){assert(range.near<d);assert(range.far>d);}}
 }
});
test('orthographic clipping stays close to the visible model depth',()=>{
 const range=depthRangeForBounds(bounds,eye,forward,true);assert(range.near<13);assert(range.far>31);assert(range.far-range.near<23);
});
test('inside bounds and extreme scale do not create invalid clipping ranges',()=>{
 for(const scale of [1e-6,1,1e6]){const b={min:{x:-scale,y:-scale,z:-scale},max:{x:scale,y:scale,z:scale}},e={x:0,y:0,z:0};for(const ortho of [false,true]){const r=depthRangeForBounds(b,e,forward,ortho);assert(Number.isFinite(r.near)&&Number.isFinite(r.far));assert(r.far>r.near);assert(ortho?r.near===0:r.near>0);}}
 assert.equal(depthRangeForBounds(bounds,eye,{x:0,y:0,z:0}),null);
});

test('orbit inside an assembly keeps distinct depth values at a close panel joint',()=>{
  const body={min:{x:-.4,y:-.15,z:-.7},max:{x:.4,y:.2,z:.7}};
  const arm={min:{x:1,y:-.2,z:-1.5},max:{x:1.8,y:.35,z:1.4}};
  const all={min:{x:-2,y:-.36,z:-1.5},max:{x:2,y:.36,z:1.5}};
  const eye={x:.65,y:.35,z:-1},forward={x:-.4,y:-.22,z:.65};
  const old=depthRangeForBounds(all,eye,forward);
  const next=depthRangeForBounds(all,eye,forward,false,[body,arm],.7);
  assert.equal(depth24(.75,old),depth24(.75002,old));
  assert.notEqual(depth24(.75,next),depth24(.75002,next));
  assert.equal(next.far,old.far);
  const inside={x:0,y:0,z:0};
  assert.equal(depthRangeForBounds(all,inside,forward,false,[body,arm],.7).near,
    depthRangeForBounds(all,inside,forward).near);
});

test('wide perspective preserves corners near the screen edge',()=>{
  const eye={x:0,y:0,z:0},forward={x:0,y:0,z:1};
  const all={min:{x:-15,y:-2,z:-1},max:{x:15,y:2,z:2}};
  const edge={min:{x:12,y:0,z:1},max:{x:12.1,y:.1,z:1.1}};
  const range=depthRangeForBounds(all,eye,forward,false,[edge],1/Math.hypot(1,13,1));
  assert.ok(range.near<1&&range.far>1.1);
});
