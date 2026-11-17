const unit=n=>Number.isFinite(n)&&n>=0&&n<=1;
const pair=(values,check)=>Array.isArray(values)&&values.length===2&&values.every(check);
export const maxPathAnchors=256;

export function validPenPath(path){
  return !!path&&typeof path==='object'&&!Array.isArray(path)&&
    Object.keys(path).every(key=>['closed','anchors'].includes(key))&&typeof path.closed==='boolean'&&
    Array.isArray(path.anchors)&&path.anchors.length>0&&path.anchors.length<=maxPathAnchors&&
    (!path.closed||path.anchors.length>=2)&&path.anchors.every(anchor=>
      anchor&&Object.keys(anchor).every(key=>['point','incoming','outgoing'].includes(key))&&pair(anchor.point,unit)&&
      ['incoming','outgoing'].every(key=>anchor[key]===undefined||pair(anchor[key],n=>Number.isFinite(n)&&Math.abs(n)<=2)));
}

export const penHandle=(anchor,key)=>anchor[key]?.map((n,i)=>n+anchor.point[i])??anchor.point;

export function penSegments(path){
  const {anchors,closed}=path;
  return Array.from({length:anchors.length-(closed?0:1)},(_,i)=>{
    const a=anchors[i],b=anchors[(i+1)%anchors.length];
    return [a.point,penHandle(a,'outgoing'),penHandle(b,'incoming'),b.point];
  });
}

const middle=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export function flattenPenPath(path){
  const vertices=[path.anchors[0].point];
  function split(a,b,c,d,depth){
    const dx=d[0]-a[0],dy=d[1]-a[1],chord=Math.hypot(dx,dy);
    const excess=distance(a,b)+distance(b,c)+distance(c,d)-chord;
    const error=chord?Math.max(Math.abs(dx*(b[1]-a[1])-dy*(b[0]-a[0])),Math.abs(dx*(c[1]-a[1])-dy*(c[0]-a[0])))/chord:excess;
    if(depth===14||Math.max(error,excess)<=.2/4096){vertices.push(d);return;}
    const ab=middle(a,b),bc=middle(b,c),cd=middle(c,d);
    const abc=middle(ab,bc),bcd=middle(bc,cd),point=middle(abc,bcd);
    split(a,ab,abc,point,depth+1);split(point,bcd,cd,d,depth+1);
  }
  for(const segment of penSegments(path))split(...segment,0);
  return vertices;
}
