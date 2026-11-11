const cross=(a,b)=>a.x*b.y-a.y*b.x;
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
function distance(p,a,b){
  const v=sub(b,a),length=v.x*v.x+v.y*v.y,t=length?Math.max(0,Math.min(1,((p.x-a.x)*v.x+(p.y-a.y)*v.y)/length)):0;
  return Math.hypot(p.x-a.x-t*v.x,p.y-a.y-t*v.y);
}
export function polylinesIntersect(first,second,tolerance=0){
  for(let i=1;i<first.length;i++)for(let j=1;j<second.length;j++){
    const a=first[i-1],b=first[i],c=second[j-1],d=second[j],r=sub(b,a),s=sub(d,c),den=cross(r,s),q=sub(c,a);
    if(Math.abs(den)>1e-9){const t=cross(q,s)/den,u=cross(q,r)/den;if(t>=0&&t<=1&&u>=0&&u<=1)return true;}
    if(Math.min(distance(a,c,d),distance(b,c,d),distance(c,a,b),distance(d,a,b))<=tolerance)return true;
  }
  return false;
}

export function closestPolylinePoint(point,points){
  let best=null;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
    const t=length?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)):0;
    const p={x:a.x+t*dx,y:a.y+t*dy},distance=Math.hypot(point.x-p.x,point.y-p.y);
    if(!best||distance<best.distance)best={...p,distance};
  }
  return best;
}
export function polylineCrossing(first,second){
  for(let i=1;i<first.length;i++)for(let j=1;j<second.length;j++){
    const a=first[i-1],r=sub(first[i],a),b=second[j-1],s=sub(second[j],b),den=cross(r,s),q=sub(b,a);
    if(Math.abs(den)<1e-9)continue;
    const t=cross(q,s)/den,u=cross(q,r)/den;
    if(t>=0&&t<=1&&u>=0&&u<=1)return {x:a.x+t*r.x,y:a.y+t*r.y};
  }
  return null;
}
