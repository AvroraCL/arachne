import {parseGltf,resolveGltfFiles} from './public/gltf-files.mjs';

const padding=Buffer.alloc(3);

function imageMime(data){
  if(data.length>=8&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(data.length>=3&&data[0]===255&&data[1]===216&&data[2]===255)return 'image/jpeg';
  if(data.length>=12&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP')return 'image/webp';
  throw Error('glTF 图像须为 PNG、JPEG 或 WebP');
}

async function bytes(source){
  return typeof source==='string'?Buffer.from(source.slice(source.indexOf(',')+1),'base64'):
    Buffer.from(await source.arrayBuffer());
}

export async function embedGltf(file,attachments,limit){
  const model=parseGltf(await file.text());
  const {buffers,images}=resolveGltfFiles(model,attachments);
  const chunks=[];
  let binLength=0;
  function append(data){
    const offset=binLength,missing=(4-data.length%4)%4;
    binLength+=data.length+missing;
    if(binLength>limit)throw Object.assign(Error('自包含 GLB 超过 128 MiB'),{status:413});
    chunks.push(data);
    if(missing)chunks.push(padding.subarray(0,missing));
    return offset;
  }
  const offsets=[];
  for(const [index,source] of buffers.entries()){
    const expected=model.buffers[index].byteLength,data=await bytes(source);
    if(!Number.isSafeInteger(expected)||expected<=0||data.length!==expected)throw Error('glTF 缓冲区大小与描述不一致');
    offsets.push(append(data));
  }
  for(const view of model.bufferViews){
    const offset=view?.byteOffset??0,length=view?.byteLength,index=view?.buffer;
    if(!Number.isSafeInteger(index)||!model.buffers[index]||!Number.isSafeInteger(offset)||offset<0||
       !Number.isSafeInteger(length)||length<=0||length>model.buffers[index].byteLength-offset)
      throw Error('glTF 缓冲区引用超出范围');
    if(view.extensions?.EXT_meshopt_compression||view.extensions?.KHR_meshopt_compression)
      throw Error('请先解压 glTF 的 Meshopt 网格');
    view.buffer=0;
    view.byteOffset=offsets[index]+offset;
  }
  const embeddedImages=new Map();
  for(const [index,source] of images.entries()){
    if(!source)continue;
    let reference=embeddedImages.get(source);
    if(!reference){
      const data=await bytes(source),mimeType=imageMime(data);
      reference={bufferView:model.bufferViews.length,mimeType};
      model.bufferViews.push({buffer:0,byteOffset:append(data),byteLength:data.length});
      embeddedImages.set(source,reference);
    }
    const image=model.images[index];
    if(image.mimeType&&image.mimeType!==reference.mimeType)throw Error('glTF 图像格式与描述不一致');
    delete image.uri;
    Object.assign(image,reference);
  }
  model.buffers=[{byteLength:binLength}];
  const raw=Buffer.from(JSON.stringify(model)),jsonLength=Math.ceil(raw.length/4)*4;
  const total=28+jsonLength+binLength;
  if(total>limit)throw Object.assign(Error('自包含 GLB 超过 128 MiB'),{status:413});
  const header=Buffer.alloc(20);
  for(const [i,value] of [0x46546c67,2,total,jsonLength,0x4e4f534a].entries())header.writeUInt32LE(value,i*4);
  const bin=Buffer.alloc(8);
  bin.writeUInt32LE(binLength);
  bin.writeUInt32LE(0x004e4942,4);
  return [header,raw,Buffer.alloc(jsonLength-raw.length,0x20),bin,...chunks];
}
