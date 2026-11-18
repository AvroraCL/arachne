import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {SVGLoader} from 'three/addons/loaders/SVGLoader.js';

const V=(x,y,z)=>new T.Vector3(x,y,z);
const tau=2*Math.PI, pow=(x,p)=>Math.sign(x)*Math.abs(x)**p;
const finishes={
  skin:['#777978',.045,.51],lower:['#515555',.035,.55],hatch:['#747776',.045,.47],
  joint:['#25292a',.09,.59],rubber:['#212424',.015,.77],arm:['#696c6b',.055,.48],
  bell:['#3b3e3e',.70,.32],edge:['#515552',.72,.28],prop:['#343638',.045,.42],
  yellow:['#c59b47',.08,.48],inscription:['#c9cbc6',.03,.55],pod:['#383b3c',.32,.39],
  bezel:['#343739',.17,.35],baffle:['#101516',.09,.39],rim:['#262d30',.69,.25],
  glass:['#172929',.50,.095],deep:['#233e3b',.48,.115],
  green:['#6c9380',.12,.28],screw:['#343739',.72,.32]
};
const group=new T.Group(),pieces=new Map();
function add(name,finish,g){
  const key=name+'|'+finish;
  if(!pieces.has(key))pieces.set(key,[]);
  pieces.get(key).push(g);
}
// A UV sheet with smooth vertex normals and a continuous normal across a closed circumference.
function sheet(rows,cols,point,reverse=false,closed=false){
  const xyz=[],uv=[],idx=[];
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    const q=point(j/rows,i/cols);xyz.push(q.x,q.y,q.z);uv.push(i/cols,j/rows);
    if(j<rows&&i<cols){const a=j*(cols+1)+i,b=a+cols+1;
      idx.push(...(reverse?[a,b,a+1,a+1,b,b+1]:[a,a+1,b,a+1,b+1,b]));}
  }
  const g=new T.BufferGeometry();
  g.setAttribute('position',new T.Float32BufferAttribute(xyz,3));
  g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();
  if(closed){const n=g.attributes.normal;for(let j=0;j<=rows;j++){
    const a=j*(cols+1),b=a+cols,v=new T.Vector3().fromBufferAttribute(n,a).add(new T.Vector3().fromBufferAttribute(n,b)).normalize();
    n.setXYZ(a,v.x,v.y,v.z);n.setXYZ(b,v.x,v.y,v.z);
  }}
  return g;
}
function sphere(name,finish,center,size){
  const g=new T.SphereGeometry(1,40,24);g.scale(...size);g.translate(...center);add(name,finish,g);
}
function axial(name,finish,start,end,stations,segments=56){
  const a=V(...start),axis=V(...end).sub(a),w=axis.clone().normalize();
  const u=V(0,1,0);if(Math.abs(u.dot(w))>.98)u.set(1,0,0);
  u.addScaledVector(w,-u.dot(w)).normalize();const v=w.clone().cross(u);
  const sec=k=>stations[Math.round(k*(stations.length-1))];
  add(name,finish,sheet(stations.length-1,segments,(t,s)=>{
    const [along,r]=sec(t),ang=s*tau;
    return a.clone().addScaledVector(axis,along).addScaledVector(u,r*Math.cos(ang)).addScaledVector(v,r*Math.sin(ang));
  },false,true));
}
const barrel=[[0,.001],[0,.90],[.065,1],[.935,1],[1,.90],[1,.001]];
function cyl(name,finish,a,b,r){
  axial(name,finish,a,b,barrel.map(([f,k])=>[f,k*r]));
}
function superPoint(w,h,angle,n){return [w*pow(Math.cos(angle),2/n),h*pow(Math.sin(angle),2/n)];}
// Cross sections vary along the fuselage. Monotone Hermite interpolation preserves each shoulder station.
function section(table,z){
  let k=0;while(k<table.length-2&&z>table[k+1][0])k++;
  const a=table[k],b=table[k+1],dz=b[0]-a[0],t=T.MathUtils.clamp((z-a[0])/dz,0,1);
  return a.slice(1).map((_,i)=>{
    const c=i+1;
    const slope=(l,r)=>(table[r][c]-table[l][c])/(table[r][0]-table[l][0]);
    const grad=i=>{if(!i)return slope(0,1);if(i===table.length-1)return slope(i-1,i);
      const l=slope(i-1,i),r=slope(i,i+1);return l*r<=0?0:2*l*r/(l+r);};
    return (1-t)**2*(1+2*t)*a[c]+t*t*(3-2*t)*b[c]+dz*(t*(1-t)**2*grad(k)-t*t*(1-t)*grad(k+1));
  });
}
// z, shoulder half-width, parting line, crown, belly depth, section exponent
const hull=[[-83,19.8,39,10,9,3.4],[-79,24.6,39.5,13.4,13,3.8],[-64,26.2,40.8,15.4,16,4],
 [-35,28.4,43,15.5,17.6,4],[-8,29.5,45,14.9,18,3.2],[17,32.6,47.3,15,18.5,2.9],
 [34,33.8,49.3,14.3,17.2,2.6],[47,30.8,50.3,12.9,13,2.4],[56,25,50.3,9.4,9,2.3],[60,19,49.5,6,4,2.2]];
function crown(x,z){const [w,y,h,,n]=section(hull,z);return y+h*Math.max(0,1-(Math.abs(x)/w)**n)**(1/n);}
function bodyHalf(upper){
 const s=(z,angle)=>{const [w,y,h,depth,n]=section(hull,z),[x,dy]=superPoint(w,upper?h:depth,angle,n);
 return V(x*(upper?1:.989),y+dy+(upper?.24:-.31),z);};
 const name=upper?'01 · Magnesium-grey upper shell':'02 · Lower equipment tray',mat=upper?'skin':'lower';
 const angle=u=>(u+(upper?0:1))*Math.PI;
 add(name,mat,sheet(76,42,(t,u)=>s(-83+143*t,angle(u))));
 for(const z of [-83,60])add(name,mat,sheet(1,42,(v,u)=>{
  const q=s(z,angle(u));q.y=T.MathUtils.lerp(section(hull,z)[1]+(upper?.24:-.31),q.y,v);return q;
 },z===-83?!upper:upper));
}
bodyHalf(true);bodyHalf(false);
add('Shell · recessed parting line','joint',sheet(60,32,(t,u)=>{
 const z=-83+143*t,[w,y]=section(hull,z),ang=u*tau;return V(w*.994*Math.cos(ang),y+.51*Math.sin(ang),z);
},false,true));
function rounded(w,h,r){
 const sh=new T.Shape(),x=-w/2,y=-h/2;
 sh.moveTo(x+r,y);sh.lineTo(-x-r,y);sh.quadraticCurveTo(-x,y,-x,y+r);sh.lineTo(-x,-y-r);
 sh.quadraticCurveTo(-x,-y,-x-r,-y);sh.lineTo(x+r,-y);sh.quadraticCurveTo(x,-y,x,-y-r);
 sh.lineTo(x,y+r);sh.quadraticCurveTo(x,y,x+r,y);return sh;
}
function extrude(name,finish,shape,depth,bevel,center,rotation=[0,0,0]){
 const g=new T.ExtrudeGeometry(shape,{depth,bevelEnabled:bevel>0,bevelThickness:bevel,bevelSize:bevel,bevelSegments:3,curveSegments:10});
 g.translate(0,0,-depth/2);g.rotateX(rotation[0]);g.rotateY(rotation[1]);g.rotateZ(rotation[2]);g.translate(...center);add(name,finish,g);
}
function inlay(name,finish,x,y,z,w,h,r,thick,rot=[0,0,0]){
 extrude(name,finish,rounded(w,h,r),thick,Math.min(.2,thick*.2),[x,y,z],rot);
}
// Flush removable battery follows the actual crown; the part line narrows at the tail.
function lidPoint(t,u,inner){
 const z=-77+t*70;const w=(19.6+2.3*Math.sin(Math.PI*t))*(inner?.977:1);
 const x=w*(2*u-1),zc=z+(1-(2*u-1)**2)*(t<.5?-1:1)*1.6;
 return V(x,crown(x,zc)+(inner?.59:.38),zc);
}
for(const inner of [false,true])add(inner?'Battery · flush lid':'Battery · gasket',''+(inner?'hatch':'joint'),sheet(40,24,(t,u)=>lidPoint(inner?.009+.982*t:t,u,inner),true));
const rearZ=-83.2;
inlay('Aft outlet · recessed throat','baffle',0,43.1,rearZ,35,7.2,3,.7);
for(let i=-5;i<=5;i++)inlay('Aft outlet · grille vanes','lower',i*2.85,43.15,rearZ-.56,.72,5.9,.34,.8,[0,.2,-.14]);
const buttonY=crown(0,-53);
cyl('Battery · power gasket','joint',[0,buttonY+.52,-53],[0,buttonY+.85,-53],3.1);
cyl('Battery · power switch','hatch',[0,buttonY+.8,-53],[0,buttonY+1.08,-53],2.65);
for(const x of [-3,-1,1,3])inlay('Battery · four light pipes','green',x,crown(x,-45)+.72,-45,.85,1.6,.38,.20,[-Math.PI/2,0,0]);

// A fairing or spar formed from independent elliptical stations on its centreline.
function spar(name,finish,stations,exponent=2.8){
 const axis=V(stations.at(-1)[0]-stations[0][0],0,stations.at(-1)[2]-stations[0][2]).normalize();
 const side=V(axis.z,0,-axis.x);
 const rise=V(...stations.at(-1).slice(0,3)).sub(V(...stations[0].slice(0,3))).normalize().cross(side).normalize();
 const sections=stations.map((s,i)=>[i,...s]);
 function pt(t,u){const [x,y,z,w,h]=section(sections,t*(stations.length-1)),[sw,sh]=superPoint(w,h,u*tau,exponent);return V(x,y,z).addScaledVector(side,sw).addScaledVector(rise,sh);}
 add(name,finish,sheet((stations.length-1)*5,32,pt,false,true));
 for(const end of [0,1])add(name,finish,sheet(1,32,(t,u)=>{
   const p=pt(end,u),c=V(...stations[end?stations.length-1:0].slice(0,3));return c.lerp(p,t);
 },!!end,true));
}
for(const sign of [-1,1]){
 const S=sign<0?'Port':'Starboard';
 const mirror=arr=>arr.map(([x,...v])=>[sign*x,...v]);
 spar(S+' · front folding shoulder','skin',mirror([[23,40,24,9.4,10.4],[30,41,26,11.3,10],[37,41.6,29,8.8,8.2],[43,42,32,6.1,6.4]]));
 for(const [key,cx,cz,y,stations,bladeAngle] of [
 ['Fore',133,67,38,[[37.5,42,29,7.8,7.2],[46,42.2,32.5,7,6.3],[64,40.4,39.5,5.8,4.9],[106,38.8,57.7,4.8,4.0],[125,38.6,65.5,6.2,4.8],[133,38,67,7,5.8]],sign>0?-24:31],
 ['Aft',103,-113,51,[[19,34,-50,8,8.3],[28,36,-56,7.4,7.4],[40,39.6,-66,6.2,5.6],[74,45.5,-91,4.8,4.4],[97,50,-110,5.6,4.8],[103,51,-113,6.5,5.3]],sign>0?135:20]
 ]){
   const n=S+' '+key,x=cx*sign;
   spar(n+' · tapered spar','arm',mirror(stations));
   const [hx,hy,hz]=stations[0];
   cyl(n+' · hinge seal','joint',[hx*sign,hy-3.4,hz],[hx*sign,hy-2.3,hz],8.5);
   cyl(n+' · pivot crown','skin',[hx*sign,hy+3,hz],[hx*sign,hy+5.1,hz],7.15);
   axial(n+' · motor nacelle','arm',[x,y-8,cz],[x,y+5,cz],[[0,.3],[.08,4.1],[.26,6.2],[.62,7.15],[.95,7.3],[1,7.05]]);
   cyl(n+' · isolator','rubber',[x,y+4.9,cz],[x,y+6.2,cz],7.14);
   axial(n+' · motor bell','bell',[x,y+6.1,cz],[x,y+12.2,cz],[[0,7.05],[.14,7.2],[.78,7.05],[.93,6.5],[1,4.2],[1,.01]]);
   cyl(n+' · retention cap','joint',[x,y+12,cz],[x,y+14.2,cz],4.6);
   for(let k=0;k<8;k++){
     let a=tau*k/8;const ax=x+5.4*Math.cos(a),az=cz+5.4*Math.sin(a);
     cyl(n+' · motor cooling ports','baffle',[ax,y+11.68,az],[ax,y+12.1,az],.71);
   }
   if(key==='Fore'){
     spar(n+' · canted landing leg','arm',mirror([[cx,38,cz,6.4,6],[cx-.1,31,cz+1,5.8,6.2],[cx-1.4,18,cz+2.5,3.8,4.7],[cx-3.2,2.5,cz+5.8,1.8,2.5]]),2.5);
     sphere(n+' · elastomer foot','rubber',[x-sign*3.2,1.55,cz+5.8],[1.9,1.55,3.25]);
     inlay(n+' · navigation window','green',x,31.2,cz+6.7,5.9,1.85,.84,.48);
   }
   const turn=bladeAngle*Math.PI/180;
   for(const opposite of [0,Math.PI]){
     const a=turn+opposite;
     const plan=[[0,0,1.75,0],[.09,.2,1.98,.1],[.24,1.4,3.9,1.4],[.43,3.5,5.5,2.1],[.64,4.4,5.0,2.3],[.84,4,3.6,1.9],[.97,3.25,1.75,.9],[1,3.1,.2,.3]];
     function blade(t,u,lower){
       const [sweep,width,rise]=section(plan,t);
       const chord=(u*2-1)*width;
       const along=2+71*t,bend=sweep+chord;
       const height=y+13.6+rise+chord*(.31-.22*t)+(lower?-.35:.24*Math.sin(Math.PI*u));
       return V(x+along*Math.cos(a)-bend*Math.sin(a),height,cz+along*Math.sin(a)+bend*Math.cos(a));
     }
     for(const low of [false,true])for(const tip of [false,true]){
       add(n+(tip?' · safety tip':' · cambered blades'),tip?'yellow':'prop',
         sheet(tip?4:28,6,(t,u)=>blade(tip?.979+.021*t:t*.979,u,low),!low));
     }
     for(const edge of [0,1])add(n+' · blade edges','prop',sheet(32,1,(t,u)=>blade(t,edge,!!u),!!edge));
   }
 }
 spar(S+' · rear landing shoe','lower',mirror([[16,25,-47,4.6,3.4],[17,19,-54,5.1,4.8],[19,7,-64,3,3],[19,2,-67,2.3,1.8]]));
 sphere(S+' · rear contact pad','rubber',[19*sign,1.4,-67],[2.5,1.4,4.2]);
}
// The gimbal cheek turns back into the body. Its open mouth terminates on the
// faceplate rim, leaving clearance behind every recessed optical element.
const podSection=[[35,9,35,9,2],[41,16,34,14,2.1],[48,21.6,31.4,20.4,2.15],[57,24.7,30,23.4,2.23],
 [66,25.3,29.6,24,2.35],[72,24.7,29.7,23.8,2.48],[76,22.8,29.9,22.2,2.63]];
add('Infinity · continuous gimbal casting','pod',sheet(45,80,(t,u)=>{
 const z=35+41*t,[w,y,h,n]=section(podSection,z),[x,dy]=superPoint(w,h,u*tau,n);return V(x,y+dy,z);
},false,true));
sphere('Gimbal · suspended neck','rubber',[0,38,43],[23.2,19,17.7]);
for(const s of [-1,1]){
 const port=s<0?'Port':'Starboard';
 axial(port+' · roll pivot shoulder','lower',[s*19,32.6,57.6],[s*27.7,32.6,57.6],[[0,11],[.20,12.7],[.65,12.8],[.9,11.4],[1,10.8],[1,.03]]);
 cyl(port+' · pivot dust seal','joint',[s*25.6,32.6,57.6],[s*26.4,32.6,57.6],12.15);
 axial(port+' · recessed pivot cover','pod',[s*27.6,32.6,57.6],[s*28.2,32.6,57.6],[[0,9.4],[.6,9.1],[1,7.8],[1,.01]]);
 spar(port+' · suspension cheek','lower',[[s*27,32.6,56.5,3.5,7.5],[s*27,34,48,4.2,9],[s*25,37,40,5,9],[s*22.3,37,31,5.3,8]]);
}
// One recessed optical deck with three bored openings. The casting is hollow
// behind the deck so the pupil can be seen through each convex front element.
// Sweep the rolled outer chin up to a smaller, high-set optical deck.
function frontCross(t,u){
 const a=tau*u,[ox,oy]=superPoint(22.8,22.2,a,2.63),[ix,iy]=superPoint(18.55,17.75,a,4.0);
 return V(T.MathUtils.lerp(ox,ix,t),T.MathUtils.lerp(29.9+oy,31.7+iy,t),76+2.45*Math.sin(t*Math.PI/2));
}
add('Infinity · rolled chin and brow','pod',sheet(12,96,frontCross,false,true));
// The pale overhanging cowl returns into the two cheeks. A dark inner return
// leaves a visible clearance from the independently moving black camera.
function cowl(t,u,inset){
 const a=-.21+u*(Math.PI+.42),w=31-3.75*t-inset,h=23.8+3.4*t-inset;
 return V(w*Math.cos(a),32.6+h*Math.sin(a),43.5+t*(23.5-5*Math.sin(a)));
}
add('Nose · vaulted gimbal fairing','skin',sheet(12,64,(t,u)=>cowl(t,u,0)));
add('Nose · cowl inner return','lower',sheet(12,64,(t,u)=>cowl(t,u,1.55),true));
add('Nose · rolled cowl edge','skin',sheet(8,64,(t,u)=>{
 const p=cowl(1,u,1.55*t);p.z+=.72*Math.sin(t*Math.PI);return p;
 }));
const face=new T.Shape();
for(let i=0;i<96;i++){const [x,y]=superPoint(18.55,17.75,tau*i/96,4.0);if(!i)face.moveTo(x,y+1.7);else face.lineTo(x,y+1.7);}
face.closePath();
const cameras=[['Hasselblad',0,36.1,20.1,15.1,4.4,6.65],['Medium tele',-8.6,21.9,13.9,12.15,4.3,4.92],['Tele',8.6,21.9,13.9,12.15,4.3,5.24]];
for(const [,x,y,w,h,r] of cameras){
 const cut=new T.Path();const pts=rounded(w,h,r).getPoints(14);
 pts.forEach((p,i)=>cut[i?'lineTo':'moveTo'](p.x+x,p.y+y-30));cut.closePath();face.holes.push(cut);
}
extrude('Optics · one-piece recessed face','bezel',face,.55,.12,[0,30,78.42]);
for(const [n,x,y,w,h,r,rad] of cameras){
 // Recess only the main camera seat; its front opening and lens stack stay concentric.
 const inset=n==='Hasselblad'?2.5:0;
 const outline=rounded(w-.05,h-.05,r).getSpacedPoints(80);
 // Front shoulder flows from the squared shade into the circular lens seat.
 add(n+' · bevelled lens shade','baffle',sheet(6,80,(v,u)=>{
   const q=outline[Math.round(u*80)],a=Math.atan2(q.y,q.x),rx=Math.cos(a)*(rad+.42),ry=Math.sin(a)*(rad+.42);
   return V(x+T.MathUtils.lerp(q.x,rx,v),y+T.MathUtils.lerp(q.y,ry,v),78.69-(2.2+inset)*v);
 },true,true));
 for(const [suffix,z0,z1,r0,r1,finish] of [
  ['retaining lip',76.5,76.65,rad+.46,rad+.11,'rim'],['inner barrel',76.65,74.8,rad+.11,rad-.09,'baffle'],
  ['first element seat',74.8,74.7,rad-.09,rad*.79,'deep'],['rear group',74.7,73.1,rad*.79,rad*.64,'baffle']
 ])axial(n+' · '+suffix,finish,[x,y,z0-inset],[x,y,z1-inset],[[0,r0],[1,r1]]);
 // Front glass is a real transmitting lens. A dark pupil and six overlapping
 // iris leaves behind it remain visible at direct incidence.
 sphere(n+' · coated optical glass','glass',[x,y,75.03-inset],[rad*.978,rad*.978,1.63]);
 sphere(n+' · rear optical element','deep',[x+.08,y-.11,73.18-inset],[rad*.77,rad*.77,.64]);
 for(let i=0;i<7;i++){
  const a=tau*i/7,pts=[];
  for(const [angle,radius] of [[a,rad*.78],[a+.72,rad*.78],[a+1.0,rad*.34],[a+.26,rad*.34]])pts.push(new T.Vector2(radius*Math.cos(angle),radius*Math.sin(angle)));
  const sh=new T.Shape(pts);const g=new T.ShapeGeometry(sh);g.translate(x,y,73.91-inset+i*.0007);add(n+' · diaphragm','baffle',g);
 }
}
for(const s of [-1,1]){
 const side=s<0?'Port':'Starboard';
 for(const [tag,x,z,normal,r] of [['forward',25.2,32,V(s*.40,.66,.63).normalize(),4.7],['aft',23.3,-58,V(s*.45,.72,-.44).normalize(),3.75]]){
  const p=V(s*x,crown(x,z)-.55,z),q=(step)=>p.clone().addScaledVector(normal,step).toArray();
  axial(side+' '+tag+' · vision fairing','skin',q(-2.4),q(2.7),[[0,r*1.55],[.32,r*1.50],[.74,r*1.27],[1,r*1.08],[1,r*.97]]);
  axial(side+' '+tag+' · vision bezel','joint',q(2.61),q(2.9),[[0,r*1.08],[1,r*1.03],[1,r*.75]]);
  const g=new T.SphereGeometry(1,36,16);g.scale(r*.84,.95,r*.84);g.applyQuaternion(new T.Quaternion().setFromUnitVectors(V(0,1,0),normal));g.translate(...q(2.77));add(side+' '+tag+' · fisheye','deep',g);
 }
 // Tactile battery releases sit in the sides rather than on top of the pack.
 const w=section(hull,-43)[0];inlay(side+' · pack release well','joint',s*(w-.72),44,-44,12,4.4,1.8,.55,[0,s*Math.PI/2,0]);
 for(let k=-2;k<=2;k++)inlay(side+' · release ribs','lower',s*(w-.31),44,-44+k*1.65,.7,2.6,.31,.25,[0,s*Math.PI/2,0]);
 const vent=V(s*30.5,47,14);
 inlay(side+' · intake recess','joint',vent.x,vent.y,vent.z,15.5,5,2.4,.66,[0,s*Math.PI/2,0]);
 for(let k=-3;k<=3;k++)inlay(side+' · intake ribs','lower',vent.x+s*.32,vent.y,vent.z+k*1.72,.73,4.25,.3,.35,[0,s*Math.PI/2,0]);
}
// True vector lettering converted to closed outlines (no fonts needed at runtime).
function textShapes(asset,name,finish,height,frame){
 const loader=new SVGLoader(),parsed=loader.parse(asset.svg);
 for(const path of parsed.paths)for(const shape of SVGLoader.createShapes(path)){
  const g=new T.ShapeGeometry(shape,4),p=g.attributes.position;
  for(let i=0;i<p.count;i++){
    const x=(p.getX(i)-asset.width/2)*height/asset.units,y=-p.getY(i)*height/asset.units;
    const q=frame(x,y);p.setXYZ(i,q.x,q.y,q.z);
  }
  g.computeVertexNormals();add(name,finish,g);
 }
}
let made=false;
export async function buildMavic(lettering){
 if(made)throw Error('Load a fresh module to rebuild the study');made=true;
 textShapes(lettering.camera,'Optics · maker engraving','inscription',1.24,(x,y)=>V(x,46.35+y,78.85));
 textShapes(lettering.arm,'Starboard · arm print','inscription',2.35,(x,y)=>{
   const t=x*.94;return V(77+t,45.2-t*.051,45.8+t*.41-y);
 });
 for(const [key,solids] of pieces){
   const [name,finish]=key.split('|'),[color,metalness,roughness]=finishes[finish];
   const baked=solids.map((item,i)=>{
     const g=item.index?item.toNonIndexed():item;
     for(const k of Object.keys(g.attributes))if(!['position','normal','uv'].includes(k))g.deleteAttribute(k);
     const uv=g.attributes.uv;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
     for(let k=0;k<uv.count;k++){minX=Math.min(minX,uv.getX(k));minY=Math.min(minY,uv.getY(k));maxX=Math.max(maxX,uv.getX(k));maxY=Math.max(maxY,uv.getY(k));}
     const cols=Math.ceil(Math.sqrt(solids.length)),rows=Math.ceil(solids.length/cols);
     for(let k=0;k<uv.count;k++)uv.setXY(k,(i%cols+.009+.982*(uv.getX(k)-minX)/Math.max(maxX-minX,1e-8))/cols,(Math.floor(i/cols)+.009+.982*(uv.getY(k)-minY)/Math.max(maxY-minY,1e-8))/rows);
     return g;
   });
   const g=mergeGeometries(baked);g.computeBoundingBox();const c=g.boundingBox.getCenter(new T.Vector3());g.translate(-c.x,-c.y,-c.z);g.scale(.0107,.0107,.0107);
   const physical=finish==='glass';
   const mat=physical?new T.MeshPhysicalMaterial({color:'#e1ece5',metalness:0,roughness:.055,transmission:.87,ior:1.57,thickness:.027,clearcoat:1,iridescence:.6,iridescenceIOR:1.38}):new T.MeshStandardMaterial({color,roughness,metalness});
   mat.name=name;mat.side=T.DoubleSide;
   const mesh=new T.Mesh(g,mat);mesh.name=name;mesh.position.copy(c).sub(V(0,34,-8)).multiplyScalar(.0107);group.add(mesh);
   for(const obj of new Set([...baked,...solids]))obj.dispose();
 }
 return new GLTFExporter().parseAsync(group,{binary:true,onlyVisible:true});
}
