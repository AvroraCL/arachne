// The pose scale is relative to the fitted square; percentages use original UV pixels.
export const canvasResolution=4096;
export const zoomLimits=[1,1600];
const clamp=(value,low,high)=>Math.min(high,Math.max(low,value));
export const canvasExtent=({width,height})=>Math.max(0,Math.min(width,height));
export function canvasZoomPercent(pose,viewport){
  return canvasExtent(viewport)*pose.scale/canvasResolution*100;
}
export function canvasScale(percent,viewport){
  const extent=canvasExtent(viewport);
  if(!extent||!Number.isFinite(percent))return null;
  return clamp(percent,...zoomLimits)/100*canvasResolution/extent;
}
export function zoomCanvas(pose,viewport,factor,point){
  if(!Number.isFinite(factor)||factor<=0)return {...pose};
  const scale=canvasScale(canvasZoomPercent(pose,viewport)*factor,viewport);
  if(scale===null)return {...pose};
  const ratio=scale/pose.scale;
  const x=(point?.x??viewport.width/2)-viewport.width/2;
  const y=(point?.y??viewport.height/2)-viewport.height/2;
  return {scale,x:x+(pose.x-x)*ratio,y:y+(pose.y-y)*ratio};
}
export function resizeCanvas(pose,previous,next){
  const before=canvasExtent(previous),after=canvasExtent(next);
  return before&&after?{...pose,scale:pose.scale*before/after}:{...pose};
}
