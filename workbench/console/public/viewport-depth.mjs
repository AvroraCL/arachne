// Pure camera-depth policy shared by the Web viewport and desktop bundle.
// Project bounds onto the viewing direction rather than using a scene-wide far/near ratio.
export function depthRangeForBounds(bounds,eye,forward,orthographic=false){
  const {min,max}=bounds;
  if(![min.x,min.y,min.z,max.x,max.y,max.z,eye.x,eye.y,eye.z,forward.x,forward.y,forward.z].every(Number.isFinite)||min.x>max.x||min.y>max.y||min.z>max.z)return null;
  const length=Math.hypot(forward.x,forward.y,forward.z);
  if(length<Number.EPSILON)return null;
  const fx=forward.x/length,fy=forward.y/length,fz=forward.z/length;
  let nearest=Infinity,farthest=-Infinity;
  for(const x of [min.x,max.x])for(const y of [min.y,max.y])for(const z of [min.z,max.z]){
    const depth=(x-eye.x)*fx+(y-eye.y)*fy+(z-eye.z)*fz;
    nearest=Math.min(nearest,depth);farthest=Math.max(farthest,depth);
  }
  const scale=Math.max(Math.hypot(max.x-min.x,max.y-min.y,max.z-min.z),1e-12);
  const margin=Math.max(scale*.01,(farthest-nearest)*.05);
  // Inside the bounds, a small relative floor keeps perspective projection invertible.
  const near=Math.max(orthographic?0:scale*1e-5,nearest-margin);
  const far=Math.max(near+scale*.001,farthest+margin);
  return {near,far};
}
