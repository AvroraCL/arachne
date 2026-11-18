// Pure camera-depth policy shared by the Web viewport and desktop bundle.
// Project bounds onto the viewing direction rather than using a scene-wide far/near ratio.
export function depthRangeForBounds(bounds,eye,forward,orthographic=false,partBounds=[],cornerCosine=0){
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
  let near=Math.max(orthographic?0:scale*1e-5,nearest-margin);
  if(!orthographic&&cornerCosine>0&&partBounds.length&&farthest>0){
    // Every visible ray has forward depth >= distance * cos(half diagonal FOV).
    // Distance to a containing box underestimates distance to the actual surface.
    // Keep extra room in front for overlays when orbiting between separate parts.
    let closestSquared=Infinity;
    for(const box of partBounds){
      const dx=Math.max(0,box.min.x-eye.x,eye.x-box.max.x);
      const dy=Math.max(0,box.min.y-eye.y,eye.y-box.max.y);
      const dz=Math.max(0,box.min.z-eye.z,eye.z-box.max.z);
      closestSquared=Math.min(closestSquared,dx*dx+dy*dy+dz*dz);
      if(closestSquared===0)break;
    }
    near=Math.max(near,.25*cornerCosine*Math.sqrt(closestSquared));
  }
  const far=Math.max(near+scale*.001,farthest+margin);
  return {near,far};
}
