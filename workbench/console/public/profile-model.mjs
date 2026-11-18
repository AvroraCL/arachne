import {Box3,ExtrudeGeometry,Group,Mesh,MeshStandardMaterial,Vector3} from 'three';
import {SVGLoader} from 'three/addons/loaders/SVGLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {mergeGeometries,mergeVertices,toCreasedNormals} from 'three/addons/utils/BufferGeometryUtils.js';

const defaults={base:0,depth:4,bevel:0,metalness:0,roughness:.48};
function settings(node,owner){
  const values={};
  for(const [key,fallback] of Object.entries(defaults)){
    const text=node.getAttribute('data-'+key)??owner.getAttribute('data-'+key);
    values[key]=text===null?fallback:Number(text);
  }
  validate(values);
  return values;
}
function validate({base,depth,bevel,metalness,roughness}){
  if(![base,depth,bevel,metalness,roughness].every(Number.isFinite)||depth<=0||bevel<0||bevel>=depth/2||
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
    for(const node of part.nodes)for(const key of Object.keys(defaults))node.setAttribute('data-'+key,part[key]);
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
export function profileScene(parts){
  const scene=new Group();
  for(const part of parts)validate(part);
  for(const part of parts){
    const geometries=part.shapes.map((shape,index)=>{
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
