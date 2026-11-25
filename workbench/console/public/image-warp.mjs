export const warpModes=[
  ['skew','斜切'],['distort','四角扭曲'],['perspective','透视'],['mesh','网格变形'],['smooth','平滑网格变形']
];
export const quadPoints=[[0,0],[1,0],[1,1],[0,1]];
export const meshPoints=Array.from({length:9},(_,i)=>[(i%3)/2,Math.floor(i/3)/2]);
export const meshTriangles=[
  [0,1,4],[0,4,3],[1,2,5],[1,5,4],[3,4,7],[3,7,6],[4,5,8],[4,8,7]
];
export const warpBase=mode=>mode==='mesh'?meshPoints:quadPoints;
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);

export const smoothMeshSteps=[2,3,4,5];
export const isMeshWarp=warp=>warp?.mode==='mesh'||warp?.mode==='smooth';

export function smoothMesh(u,v,source){
  return {mode:'smooth',u,v,points:v.flatMap(y=>u.map(x=>warpPoint(source,[x,y])))};
}
export function createSmoothMesh(cells,source){
  const knots=Array.from({length:cells+1},(_,i)=>i/cells);
  return smoothMesh(knots,knots,source);
}
function basis(knots,q){
  let i=knots.findIndex(knot=>knot>q)-1;
  i=q>=1?knots.length-2:Math.max(0,i);
  const p=Math.max(0,i-1),next=i+1,n=Math.min(i+2,knots.length-1);
  const width=knots[next]-knots[i],t=(q-knots[i])/width,t2=t*t,t3=t2*t;
  const a=(t3-2*t2+t)*width/(knots[next]-knots[p]),b=(t3-t2)*width/(knots[n]-knots[i]);
  const da=(3*t2-4*t+1)/(knots[next]-knots[p]),db=(3*t2-2*t)/(knots[n]-knots[i]),d=(6*t2-6*t)/width;
  return [[p,i,next,n],[-a,1+2*t3-3*t2-b,3*t2-2*t3+a,b],[-da,d-db,-d+da,db]];
}
function smoothSample(warp,u,v){
  const [cols,x,dx]=basis(warp.u,u),[rows,y,dy]=basis(warp.v,v);
  const point=[0,0],du=[0,0],dv=[0,0];
  for(let j=0;j<4;j++)for(let i=0;i<4;i++){
    const p=warp.points[rows[j]*warp.u.length+cols[i]];
    const weight=x[i]*y[j],wx=dx[i]*y[j],wy=x[i]*dy[j];
    for(let axis=0;axis<2;axis++){point[axis]+=weight*p[axis];du[axis]+=wx*p[axis];dv[axis]+=wy*p[axis];}
  }
  return {point,du,dv,cross:du[0]*dv[1]-dv[0]*du[1]};
}
function validSmoothMesh(warp){
  const knots=values=>Array.isArray(values)&&values.length>=2&&values[0]===0&&values.at(-1)===1&&
    values.slice(1).every((value,i)=>Number.isFinite(value)&&value-values[i]>=1/4096);
  if(Object.keys(warp).length!==4||!knots(warp.u)||!knots(warp.v)||
     warp.points.length!==warp.u.length*warp.v.length)return false;
  // Check the Jacobian throughout every cell, including the common seams.
  const sample=values=>values.slice(1).flatMap((end,i)=>Array.from({length:4},(_,j)=>values[i]+(end-values[i])*j/4)).concat(1);
  for(const v of sample(warp.v))for(const u of sample(warp.u))
    if(smoothSample(warp,u,v).cross<=1e-5)return false;
  return true;
}
function inverseSmooth(warp,[x,y]){
  let u=Math.max(0,Math.min(1,x)),v=Math.max(0,Math.min(1,y));
  for(let iteration=0;iteration<16;iteration++){
    const {point,du,dv,cross}=smoothSample(warp,u,v);
    const ex=x-point[0],ey=y-point[1];
    if(Math.hypot(ex,ey)<1e-9)return [u,v];
    if(cross<=1e-10)break;
    const stepU=(ex*dv[1]-ey*dv[0])/cross,stepV=(du[0]*ey-du[1]*ex)/cross;
    const limit=Math.max(1,Math.abs(stepU)/.125,Math.abs(stepV)/.125);
    u=Math.max(-.125,Math.min(1.125,u+stepU/limit));
    v=Math.max(-.125,Math.min(1.125,v+stepV/limit));
  }
  return null;
}

export function validImageWarp(warp){
  if(!warp||!warpModes.some(([mode])=>warp.mode===mode)||
     !Array.isArray(warp.points)||
     warp.points.some(point=>!Array.isArray(point)||point.length!==2||
       point.some(value=>!Number.isFinite(value)||Math.abs(value)>8)))return false;
  if(warp.mode==='smooth')return validSmoothMesh(warp);
  if(Object.keys(warp).length!==2||warp.points.length!==warpBase(warp.mode).length)return false;
  const triangles=warp.mode==='mesh'?meshTriangles:[[0,1,2],[1,2,3],[2,3,0],[3,0,1]];
  if(!triangles.every(([a,b,c])=>cross(warp.points[a],warp.points[b],warp.points[c])>1e-5))return false;
  if(warp.mode!=='mesh')return true;
  const ring=[0,1,2,5,8,7,6,3].map(index=>warp.points[index]);
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length];
    for(let j=i+2;j<ring.length;j++){
      if(i===0&&j===ring.length-1)continue;
      const c=ring[j],d=ring[(j+1)%ring.length];
      if(cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0&&
         [0,1].every(axis=>Math.max(Math.min(a[axis],b[axis]),Math.min(c[axis],d[axis]))<=
           Math.min(Math.max(a[axis],b[axis]),Math.max(c[axis],d[axis]))))return false;
    }
  }
  return true;
}

export function imagePlacement(layer,assets){
  const dimensions=layer.kind==='shape'?layer.shape:layer.embedded??assets[layer.asset];
  if(!dimensions)return null;
  const ratio=layer.scale/Math.max(dimensions.width,dimensions.height);
  const width=dimensions.width*ratio*layer.stretch[0],height=dimensions.height*ratio*layer.stretch[1];
  const angle=layer.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  return {
    matrix:[width*c,width*s,-height*s,height*c,layer.x-(width*c-height*s)/2,layer.y-(width*s+height*c)/2],
    toCanvas([u,v]){
      const x=(u-.5)*width,y=(v-.5)*height;
      return [layer.x+x*c-y*s,layer.y+x*s+y*c];
    },
    toLayer([x,y]){
      const dx=x-layer.x,dy=y-layer.y;
      return [.5+(dx*c+dy*s)/width,.5+(-dx*s+dy*c)/height];
    }
  };
}

function quadMatrix([a,b,c,d]){
  const ax=b[0]-c[0],ay=b[1]-c[1],bx=d[0]-c[0],by=d[1]-c[1];
  const dx=a[0]-b[0]+c[0]-d[0],dy=a[1]-b[1]+c[1]-d[1];
  const determinant=ax*by-bx*ay;
  const g=(dx*by-bx*dy)/determinant,h=(ax*dy-dx*ay)/determinant;
  return [a,b.map((n,i)=>(1+g)*n-a[i]),d.map((n,i)=>(1+h)*n-a[i]),g,h];
}

function quadPoint(points,u,v){
  const [a,b,d,g,h]=quadMatrix(points);
  return [0,1].map(i=>(a[i]+b[i]*u+d[i]*v)/(1+g*u+h*v));
}

function weights([u,v],[a,b,c]){
  const det=cross(a,b,c),p=[u,v];
  return [cross(p,b,c)/det,cross(a,p,c)/det,cross(a,b,p)/det];
}

const inUnitSquare=point=>point?.every(n=>n>=-1e-9&&n<=1+1e-9);
export function warpPoint(warp,point,inverse=false,allowOutside=false){
  if(!warp)return point;
  if(!inverse&&!allowOutside&&!inUnitSquare(point))return null;
  let result;
  if(warp.mode==='smooth'){
    result=inverse?inverseSmooth(warp,point):smoothSample(warp,...point).point;
  }else if(warp.mode==='mesh'){
    const from=inverse?warp.points:meshPoints,to=inverse?meshPoints:warp.points;
    for(const triangle of meshTriangles){
      const mix=weights(point,triangle.map(i=>from[i]));
      if(mix.every(n=>n>=-1e-9)){
        result=[0,1].map(axis=>triangle.reduce((sum,i,k)=>sum+to[i][axis]*mix[k],0));
        break;
      }
    }
  }else if(inverse){
    const [a,b,d,g,h]=quadMatrix(warp.points),[x,y]=point;
    const c0=b[0]-x*g,c1=b[1]-y*g,d0=d[0]-x*h,d1=d[1]-y*h;
    const det=c0*d1-c1*d0;
    if(Math.abs(det)>1e-10)
      result=[((x-a[0])*d1-(y-a[1])*d0)/det,(c0*(y-a[1])-c1*(x-a[0]))/det];
  }else result=quadPoint(warp.points,...point);
  return !inverse||allowOutside||inUnitSquare(result)?result:null;
}

export function imageQuadTransform(project,width,height){
  const [a,b,d,g,h]=quadMatrix(quadPoints.map(project));
  return [b[0]/width,b[1]/width,0,g/width,d[0]/height,d[1]/height,0,h/height,0,0,1,0,a[0],a[1],0,1];
}

export const identityImageSpace=Object.freeze([1,0,0,1,0,0]);
function toSpace([u,v],[a,b,d,e,x,y]){
  const det=a*e-b*d;
  return [(e*(u-x)-d*(v-y))/det,(-b*(u-x)+a*(v-y))/det];
}
function fromSpace([u,v],[a,b,d,e,x,y]){
  return [a*u+d*v+x,b*u+e*v+y];
}

// A mask edit uses the canvas coordinates at the time it was made.
export function mapImageMaskPoint(layer,edit,point,inverse=false){
  const current=layer.maskTransform??identityImageSpace,authored=edit.maskSpace??identityImageSpace;
  const steps=layer.maskWarpSteps?.slice(edit.maskWarpIndex??0)??[];
  let local=toSpace(point,inverse?current:authored);
  for(const {space,placement,from,to} of inverse?steps.reverse():steps){
    const canvas=fromSpace(local,space);
    const uv=toSpace(canvas,placement);
    const source=warpPoint(inverse?to:from,uv,true);
    const mapped=inUnitSquare(source)&&warpPoint(inverse?from:to,source,false);
    if(mapped)local=toSpace(fromSpace(mapped,placement),space);
  }
  return fromSpace(local,inverse?authored:current);
}

export function warpMesh(points){
  return meshPoints.map(([u,v])=>quadPoint(points,u,v));
}

export function dragWarpPoint(base,index,point){
  const points=base.points.map(value=>[...value]);
  const [dx,dy]=point.map((value,axis)=>value-points[index][axis]);
  if(base.mode==='skew'){
    const axis=Math.abs(dx)>=Math.abs(dy)?0:1;
    const neighbor=axis===0?[1,0,3,2][index]:[3,2,1,0][index];
    points[index][axis]+=axis?dy:dx;
    points[neighbor][axis]+=axis?dy:dx;
  }else if(base.mode==='perspective'){
    const axis=Math.abs(dx)>=Math.abs(dy)?0:1;
    const neighbor=axis===0?[1,0,3,2][index]:[3,2,1,0][index];
    points[index][axis]+=axis?dy:dx;
    points[neighbor][axis]-=axis?dy:dx;
  }else points[index]=point;
  return {...base,points};
}
