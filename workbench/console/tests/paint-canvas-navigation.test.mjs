import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasZoomPercent,canvasScale,zoomCanvas,resizeCanvas} from '../public/paint-canvas-navigation.mjs';

test('canvas percentages measure original 4K pixels rather than fitted viewport size',()=>{
  const viewport={width:1200,height:512};
  assert.equal(canvasZoomPercent({scale:1},viewport),12.5);
  assert.equal(canvasScale(100,viewport),8);
  assert.equal(canvasZoomPercent({scale:8},viewport),100);
  assert.equal(canvasScale(100,{width:0,height:0}),null);
});
test('zoom preserves the UV coordinate under the cursor, including clamp boundaries',()=>{
  const viewport={width:1200,height:512},point={x:925,y:140},pose={scale:1,x:47,y:-21};
  const coordinate=p=>[(point.x-viewport.width/2-p.x)/p.scale,(point.y-viewport.height/2-p.y)/p.scale];
  for(const factor of [1.25,.8,1e6,1e-6]){
    const result=zoomCanvas(pose,viewport,factor,point);
    coordinate(result).forEach((value,i)=>assert.ok(Math.abs(value-coordinate(pose)[i])<1e-9));
    assert.ok(canvasZoomPercent(result,viewport)>=1&&canvasZoomPercent(result,viewport)<=1600);
  }
  assert.deepEqual(zoomCanvas(pose,viewport,NaN,point),pose);
});
test('resizing a docked viewport keeps a fixed pixel zoom without changing the pan',()=>{
  const before={width:1200,height:512},after={width:400,height:700},pose={scale:8,x:25,y:-40};
  const resized=resizeCanvas(pose,before,after);
  assert.equal(canvasZoomPercent(resized,after),canvasZoomPercent(pose,before));
  assert.equal(resized.x,25);assert.equal(resized.y,-40);
  assert.deepEqual(resizeCanvas(pose,{width:0,height:0},after),pose);
});
