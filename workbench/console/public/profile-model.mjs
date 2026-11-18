import {Box3,BufferGeometry,Float32BufferAttribute,ExtrudeGeometry,Group,Mesh,MeshStandardMaterial,Vector3} from 'three';
import {SVGLoader} from 'three/addons/loaders/SVGLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {mergeGeometries,mergeVertices,toCreasedNormals} from 'three/addons/utils/BufferGeometryUtils.js';

const defaults={base:0,depth:4,bevel:0,metalness:0,roughness:.48,pitch:0};
function settings(node,owner){
  const values={};
  for(const [key,fallback] of Object.entries(defaults)){
    const text=node.getAttribute('data-'+key)??owner.getAttribute('data-'+key);
    values[key]=text===null?fallback:Number(text);
  }
  values.form=node.getAttribute('data-form')??owner.getAttribute('data-form')??'extrude';
  validate(values);
  return values;
}
function validate({base,depth,bevel,metalness,roughness,form='extrude',pitch=0}){
  if(!['extrude','dome'].includes(form)||!Number.isFinite(pitch))throw Error('请选择有效的轮廓造型并输入俯仰角');
  if(![base,depth,bevel,metalness,roughness].every(Number.isFinite)||depth<=0||bevel<0||(form==='extrude'&&bevel>=depth/2)||
     metalness<0||metalness>1||roughness<0||roughness>1)
    throw Error('厚度须大于零，倒角须小于半厚，金属度和粗糙度须在 0 到 1 之间');
}
export function readProfiles(text){
  const xml=new DOMParser().parseFromString(text,'image/svg+xml');
  if(xml.documentElement.localName!=='svg'||xml.querySelector('parsererror'))throw Error('SVG 轮廓文件无效');
  if(xml.querySelector('use,text,image,mask,clipPath,linearGradient,radialGradient,pattern,script,foreignObject'))
    throw Error('请将文字、实例和裁剪外观展开成实色填充轮廓');
  if([...xml.querySelectorAll('*')].some(node=>[...node.attributes].some(a=>/^on/i.test(a.localName))))
    throw Error('请导出不含事件处理程序的静态 SVG 轮廓');
  const {paths}=new SVGLoader().parse(text),parts=new Map();
  for(const path of paths){
    const {node,style}=path.userData;
    if(style.visibility==='hidden'||style.display==='none'||Number(style.fillOpacity)===0)continue;
    if(style.stroke&&style.stroke!=='none'&&Number(style.strokeWidth)!==0)
      throw Error('请先将 SVG 描边转为填充轮廓');
    if(style.fill==='none')continue;
    const shapes=SVGLoader.createShapes(path);
    if(!shapes.length)continue;
    const owner=node.closest('g[id]')||node;
    const name=owner.id||'轮廓 '+(parts.size+1);
    const color=path.color.getHexString(),key=name+'\n'+color;
    if(!parts.has(key)){
      const label=[...parts.values()].some(p=>p.name===name)?name+' #'+color:name;
      parts.set(key,{name:label,color:path.color.clone(),shapes:[],nodes:[],...settings(node,owner)});
    }
    parts.get(key).shapes.push(...shapes);
    parts.get(key).nodes.push(node);
  }
  if(!parts.size)throw Error('SVG 中没有可挤出的实色填充轮廓');
  return [...parts.values()];
}

export function profileSource(parts){
  for(const part of parts){
    validate(part);
    for(const node of part.nodes){
      for(const key of Object.keys(defaults))node.setAttribute('data-'+key,part[key]);
      node.setAttribute('data-form',part.form);
    }
  }
  return new XMLSerializer().serializeToString(parts[0].nodes[0].ownerDocument);
}

// Pack each solid separately. Both caps and every bevel/wall quad have distinct texels.
function packUV(geo,index,count){
  geo.computeBoundingBox();
  const {min,max}=geo.boundingBox,{position,uv}=geo.attributes;
  const columns=Math.ceil(Math.sqrt(count)),rows=Math.ceil(count/columns);
  const size=Math.max(max.x-min.x,max.y-min.y);
  const side=geo.groups[1];
  if(!size||!geo.groups[0].count||!side?.count)throw Error('存在零面积轮廓，请移除空路径或重叠线段');
  const walls=side.count/6,wallCols=Math.ceil(Math.sqrt(walls*3)),wallRows=Math.ceil(walls/wallCols);
  const corners=[[0,0],[1,0],[0,1],[1,0],[1,1],[0,1]];
  for(let i=0;i<position.count;i++){
    let u,v;
    if(i<side.start){
      const x=(position.getX(i)-min.x)/size,y=(position.getY(i)-min.y)/size;
      // SVG y grows down. GLTFExporter writes UVs unchanged.
      if(geo.attributes.normal.getZ(i)<0){u=.01+.68*x;v=.01+.68*y;}
      else {u=.70+.285*x;v=.01+.285*y;}
    }else{
      const q=Math.floor((i-side.start)/6),[x,y]=corners[(i-side.start)%6];
      u=(q%wallCols+.035+.93*x)/wallCols;
      v=.71+.28*(Math.floor(q/wallCols)+.035+.93*y)/wallRows;
    }
    uv.setXY(i,(index%columns+u)/columns,(Math.floor(index/columns)+v)/rows);
  }
}
// Sweep the outline from pole to pole. Split UVs at the meridian while
// retaining identical normals there. A radial sweep requires a visible centre.
function domeGeometry(shape,part,index,count){
  const ring=shape.getPoints(16).filter((p,i,all)=>i===0||p.distanceToSquared(all[i-1])>1e-14);
  if(ring.length>1&&ring[0].distanceToSquared(ring.at(-1))<1e-14)ring.pop();
  if(shape.holes.length||ring.length<3)throw Error('圆壳需要无孔的闭合实心轮廓');
  const signed=ring.reduce((sum,p,i)=>sum+p.cross(ring[(i+1)%ring.length]),0);
  if(signed<0)ring.reverse();
  const center=ring.reduce((v,p)=>v.add(p),ring[0].clone().set(0,0)).multiplyScalar(1/ring.length);
  const edges=ring.map((p,i)=>ring[(i+1)%ring.length].clone().sub(p));
  if(edges.some((v,i)=>v.cross(center.clone().sub(ring[i]))<=0))throw Error('圆壳轮廓须能从中心连到每条边');
  const lengths=[0];
  for(const edge of edges)lengths.push(lengths.at(-1)+edge.length());
  const tangents=edges.map((v,i)=>v.clone().normalize().add(edges[(i+ring.length-1)%ring.length].clone().normalize()).normalize());
  const position=[],normal=[],uv=[],indices=[];
  const bands=24,n=ring.length;
  const cols=Math.ceil(Math.sqrt(count)),rows=Math.ceil(count/cols);
  for(let j=0;j<=bands;j++){
    const angle=(j/bands-.5)*Math.PI,s=Math.sin(angle),c=j===0||j===bands?0:Math.cos(angle);
    for(let k=0;k<=n;k++){
      const i=k%n,x=ring[i].x-center.x,z=ring[i].y-center.y,t=tangents[i];
      position.push(center.x+c*x,part.base+part.depth*(1+s)/2,center.y+c*z);
      // The surface normal is the cross product of the latitude and outline tangents.
      const outward=new Vector3(part.depth*c*t.y/2,s*(x*t.y-z*t.x),-part.depth*c*t.x/2).normalize();
      normal.push(...outward.toArray());
      uv.push((index%cols+.01+.98*lengths[k]/lengths[n])/cols,(Math.floor(index/cols)+.01+.98*j/bands)/rows);
      if(j<bands&&k<n){
        const a=j*(n+1)+k,b=a+n+1;
        if(j>0)indices.push(a,b,a+1);
        if(j+1<bands)indices.push(a+1,b,b+1);
      }
    }
  }
  const geometry=new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute(position,3));
  geometry.setAttribute('normal',new Float32BufferAttribute(normal,3));
  geometry.setAttribute('uv',new Float32BufferAttribute(uv,2));
  geometry.setIndex(indices);
  return geometry;
}
export function profileScene(parts){
  const scene=new Group();
  for(const part of parts)validate(part);
  for(const part of parts){
    const geometries=part.shapes.map((shape,index)=>{
      if(part.form==='dome')return domeGeometry(shape,part,index,part.shapes.length);
      const b=part.bevel;
      const g=new ExtrudeGeometry(shape,{depth:part.depth-2*b,bevelEnabled:b>0,bevelSize:b,
        bevelThickness:b,bevelSegments:3,curveSegments:12});
      packUV(g,index,part.shapes.length);
      // Keep printed caps planar. Round the grazing highlight across the bevel
      // without welding its UVs or rounding sharp corners of the outline.
      const capCount=g.groups[0].count;
      const flatCaps=g.attributes.normal.array.slice(0,capCount*3);
      toCreasedNormals(g,Math.PI/5);
      g.attributes.normal.array.set(flatCaps);
      if(b>0){
        const pos=g.attributes.position,normals=g.attributes.normal,{min,max}=g.boundingBox;
        for(let i=capCount;i<pos.count;i++){
          if(pos.getZ(i)===min.z)normals.setXYZ(i,0,0,-1);
          if(pos.getZ(i)===max.z)normals.setXYZ(i,0,0,1);
        }
      }
      g.rotateX(Math.PI/2);g.translate(0,part.base+part.depth-b,0);
      return g;
    });
    const merged=mergeGeometries(geometries);
    const geo=mergeVertices(merged);
    geo.computeBoundingBox();
    const center=geo.boundingBox.getCenter(new Vector3());
    geo.translate(-center.x,-center.y,-center.z);
    if(part.pitch)geo.rotateX(part.pitch*Math.PI/180);
    const material=new MeshStandardMaterial({color:part.color,metalness:part.metalness,roughness:part.roughness});
    material.name=part.name;
    const mesh=new Mesh(geo,material);
    mesh.name=part.name;mesh.position.copy(center);scene.add(mesh);
    geometries.forEach(g=>g.dispose());merged.dispose();
  }
  const box=new Box3().setFromObject(scene),center=box.getCenter(new Vector3());
  const scale=4/Math.max(...box.getSize(new Vector3()).toArray());
  for(const mesh of scene.children){
    mesh.position.sub(center).multiplyScalar(scale);mesh.geometry.scale(scale,scale,scale);
  }
  return scene;
}
export async function profileFile(parts,name){
  const scene=profileScene(parts);
  try{
    const bytes=await new GLTFExporter().parseAsync(scene,{binary:true});
    return new File([bytes],name.replace(/\.svg$/i,'.glb'),{type:'model/gltf-binary'});
  }finally{for(const mesh of scene.children){mesh.geometry.dispose();mesh.material.dispose();}}
}
