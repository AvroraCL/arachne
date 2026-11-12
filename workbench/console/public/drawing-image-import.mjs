import {clipboardPngSize} from './image-clipboard.mjs';

export const drawingImageTypes='image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
const maxBytes=24*1024*1024,maxSide=8192;
const supportedTypes=new Set(['image/png','image/jpeg','image/webp']);
const pngSignature=[137,80,78,71,13,10,26,10];
const matches=(bytes,offset,signature)=>signature.every((value,index)=>bytes[offset+index]===value);
const ascii=(bytes,offset,length)=>String.fromCharCode(...bytes.subarray(offset,offset+length));
const validSize=([width,height])=>width>0&&height>0&&width<=maxSide&&height<=maxSide;

export function acceptsDrawingImage(file){
  return !!file&&(supportedTypes.has(file.type)||
    (!file.type||file.type==='application/octet-stream')&&/\.(png|jpe?g|webp)$/i.test(file.name));
}

function jpegSize(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let offset=2;
  while(offset+4<=bytes.length&&bytes[offset]===0xff){
    while(bytes[offset]===0xff)offset++;
    const marker=bytes[offset++];
    if(marker===0xda||marker===0xd9||offset+2>bytes.length)break;
    if(marker===1||marker>=0xd0&&marker<=0xd7)continue;
    const length=view.getUint16(offset);
    if(length<2||offset+length>bytes.length)break;
    if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker)&&length>=7)
      return [view.getUint16(offset+5),view.getUint16(offset+3)];
    offset+=length;
  }
  return null;
}

function webpSize(bytes){
  if(bytes.length<25)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),kind=ascii(bytes,12,4);
  if(kind==='VP8X'&&bytes.length>=30){
    if(bytes[20]&2)throw Error('请先将动态 WebP 导出为单帧');
    const u24=offset=>bytes[offset]+bytes[offset+1]*256+bytes[offset+2]*65536;
    return [u24(24)+1,u24(27)+1];
  }
  if(kind==='VP8L'&&bytes[20]===0x2f){
    const bits=view.getUint32(21,true);
    return [(bits&0x3fff)+1,((bits>>>14)&0x3fff)+1];
  }
  if(kind==='VP8 '&&bytes.length>=30&&matches(bytes,23,[0x9d,1,0x2a]))
    return [view.getUint16(26,true)&0x3fff,view.getUint16(28,true)&0x3fff];
  return null;
}

async function decode(file){
  if(typeof createImageBitmap==='function'){
    try{
      const image=await createImageBitmap(file,{imageOrientation:'from-image'});
      return {image,width:image.width,height:image.height,dispose:()=>image.close()};
    }catch{}
  }
  const image=new Image(),url=URL.createObjectURL(file);
  image.src=url;
  try{
    await image.decode();
    return {image,width:image.naturalWidth,height:image.naturalHeight,dispose:()=>URL.revokeObjectURL(url)};
  }catch(error){
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function prepareDrawingImage(file){
  if(!acceptsDrawingImage(file))throw Error('请选择 PNG、JPEG 或 WebP 图片');
  if(file.size>maxBytes)throw Error('图片不能超过 24 MiB');
  const header=new Uint8Array(await file.slice(0,32).arrayBuffer());
  if(matches(header,0,pngSignature))return {file,size:await clipboardPngSize(file)};
  const size=matches(header,0,[0xff,0xd8,0xff])?jpegSize(new Uint8Array(await file.arrayBuffer())):
    ascii(header,0,4)==='RIFF'&&ascii(header,8,4)==='WEBP'?webpSize(header):null;
  if(!size)throw Error('无法读取图片格式或尺寸');
  if(!validSize(size))throw Error('图片宽高不能超过 8192 像素');
  let decoded;
  try{decoded=await decode(file);}
  catch{throw Error('浏览器无法解码这张图片');}
  try{
    const {image,width,height}=decoded,canvas=document.createElement('canvas');
    if(!validSize([width,height]))throw Error('图片宽高不能超过 8192 像素');
    canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{alpha:true,colorSpace:'srgb'});
    if(!context)throw Error('浏览器无法创建图片画布');
    context.drawImage(image,0,0);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    canvas.width=canvas.height=1;
    if(!blob)throw Error('浏览器无法转换图片');
    if(blob.size>maxBytes)throw Error('转换后的 PNG 超过 24 MiB，请缩小图片后导入');
    const name=(file.name.replace(/\.[^.]*$/,'')||'导入图片')+'.png';
    return {file:new File([blob],name,{type:'image/png'}),size:[width,height]};
  }finally{decoded.dispose();}
}
