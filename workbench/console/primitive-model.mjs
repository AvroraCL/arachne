import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BoxGeometry,CylinderGeometry,PlaneGeometry,SphereGeometry} from 'three';
import {DATA} from './store.mjs';
import {describeGlbRegistration,registerGlb} from './model-registration.mjs';
import {modelTemplates} from './public/model-templates.mjs';

const padding=.02;
const full=[[0,0,1,1]];
const cubeCharts=Array.from({length:6},(_,i)=>[i%3/3,Math.floor(i/3)/2,1/3,1/2]);
const cylinderCharts=[[0,0,1,.56],[0,.56,.5,.44],[.5,.56,.5,.44]];
const geometryTemplates={
  plane:()=>[new PlaneGeometry(2,2).rotateX(-Math.PI/2),full],
  cube:()=>[new BoxGeometry(2,2,2),cubeCharts],
  sphere:()=>[new SphereGeometry(1,48,24),full],
  cylinder:()=>[new CylinderGeometry(.8,.8,2,48),cylinderCharts]
};

export function primitiveGlb(kind){
  if(!Object.hasOwn(geometryTemplates,kind))throw Error('不支持的模型模板');
  const [geometry,charts]=geometryTemplates[kind]();
  const {index,attributes:{position,normal,uv}}=geometry;
  const groups=geometry.groups.length?geometry.groups:[{start:0,count:index.count}];
  groups.forEach(({start,count},group)=>{
    const [x,y,width,height]=charts[group];
    const vertices=new Set();
    for(let i=start;i<start+count;i++)vertices.add(index.getX(i));
    for(const i of vertices)uv.setXY(i,
      x+padding+uv.getX(i)*(width-2*padding),
      y+padding+(1-uv.getY(i))*(height-2*padding));
  });
  geometry.computeBoundingBox();
  const {min,max}=geometry.boundingBox;
  const views=[],accessors=[],parts=[];
  let offset=0;
  function append(attribute,type,component,target,bounds={}){
    const values=attribute.array;
    const bytes=Buffer.alloc(values.byteLength);
    if(component===5126)values.forEach((value,i)=>bytes.writeFloatLE(value,i*4));
    else values.forEach((value,i)=>bytes.writeUInt16LE(value,i*2));
    const paddingBytes=Buffer.alloc((4-bytes.length%4)%4);
    views.push({buffer:0,byteOffset:offset,byteLength:bytes.length,target});
    accessors.push({bufferView:views.length-1,type,componentType:component,count:attribute.count,...bounds});
    parts.push(bytes,paddingBytes);
    offset+=bytes.length+paddingBytes.length;
    return accessors.length-1;
  }
  const attributes={
    POSITION:append(position,'VEC3',5126,34962,{min:min.toArray(),max:max.toArray()}),
    NORMAL:append(normal,'VEC3',5126,34962),
    TEXCOORD_0:append(uv,'VEC2',5126,34962)
  };
  const indices=append(index,'SCALAR',5123,34963);
  const name=modelTemplates[kind],binary=Buffer.concat(parts);
  const description=Buffer.from(JSON.stringify({
    asset:{version:'2.0',generator:'Arachne'},scene:0,scenes:[{nodes:[0]}],nodes:[{name,mesh:0}],
    meshes:[{name,primitives:[{attributes,indices,material:0}]}],
    materials:[{name:'表面材质',doubleSided:kind==='plane',
      pbrMetallicRoughness:{baseColorFactor:[.22,.24,.27,1],metallicFactor:0,roughnessFactor:.48}}],
    bufferViews:views,accessors,buffers:[{byteLength:binary.length}]
  }));
  const metadata=Buffer.concat([description,Buffer.alloc((4-description.length%4)%4,32)]);
  const header=Buffer.alloc(20),chunk=Buffer.alloc(8);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+metadata.length+binary.length,8);
  header.writeUInt32LE(metadata.length,12);header.write('JSON',16);
  chunk.writeUInt32LE(binary.length);chunk.write('BIN',4);
  return Buffer.concat([header,metadata,chunk,binary]);
}

const registrations=new Map();
async function registerPrimitive(kind){
  const glb=primitiveGlb(kind),digest=createHash('sha256').update(glb).digest('hex');
  const id='builtin-'+kind+'-'+digest;
  const folder=path.join(DATA,'model-sources',id);
  try{
    const metadata=JSON.parse(await fs.readFile(path.join(folder,'metadata.json'),'utf8'));
    const document=await describeGlbRegistration(folder,id);
    if(metadata.input_sha256!==digest||metadata.source_sha256!==document.source.files[document.source.reviewSource])
      throw Error('模型模板的登记文件已改变');
    return document;
  }catch(error){
    if(error.code!=='ENOENT')throw error;
  }
  const scratch=await fs.mkdtemp(path.join(DATA,'.primitive-registration-'));
  try{
    const input=path.join(scratch,'model.glb');
    await fs.writeFile(input,glb);
    const staging=await registerGlb(input,scratch);
    const document=await describeGlbRegistration(folder,id,staging);
    await fs.mkdir(path.dirname(folder),{recursive:true});
    await fs.rename(staging,folder);
    return document;
  }finally{await fs.rm(scratch,{recursive:true,force:true});}
}

export function primitiveRegistration(kind){
  if(!registrations.has(kind))
    registrations.set(kind,registerPrimitive(kind).finally(()=>registrations.delete(kind)));
  return registrations.get(kind);
}
