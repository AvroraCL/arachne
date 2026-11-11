import fs from 'node:fs';
import {sha256File} from './file-fingerprint.mjs';
import path from 'node:path';
import {renderPassChannels} from './public/cycles-render-passes.mjs';

const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
export const pngSizeIs=(bytes,width,height)=>bytes.length>=24&&bytes.subarray(0,8).equals(pngSignature)&&
  bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)===width&&bytes.readUInt32BE(20)===height;

// Inspect the single-part scanline files the renderers write. See the OpenEXR file layout.
export function exrMatches(file,width,height,bitDepth,expected,{compressionType=3}={}){
  const handle=fs.openSync(file,'r');
  try{
    const size=fs.fstatSync(handle).size;
    const header=Buffer.alloc(Math.min(size,1024*1024)),length=fs.readSync(handle,header,0,header.length,0);
    if(length<8||header.readUInt32LE(0)!==20000630||(header.readUInt32LE(4)&~0x400)!==2)return false;
    let i=8;const attrs=new Map();
    const nameAt=(pos,limit)=>{
      const end=header.indexOf(0,pos);
      if(end<pos||end>=limit||end-pos>255)return null;
      return [header.toString('ascii',pos,end),end+1];
    };
    while(i<length&&header[i]!==0){
      const name=nameAt(i,length),type=name&&nameAt(name[1],length);
      if(!type?.[0]||type[1]+4>length||attrs.has(name[0]))return false;
      const count=header.readUInt32LE(type[1]),start=type[1]+4; i=start+count;
      if(i>length)return false;
      attrs.set(name[0],{type:type[0],start,end:i});
    }
    if(i>=length)return false;
    for(const key of ['dataWindow','displayWindow']){
      const box=attrs.get(key);
      if(box?.type!=='box2i'||box.end-box.start!==16)return false;
      const [left,bottom,right,top]=[0,4,8,12].map(offset=>header.readInt32LE(box.start+offset));
      if(left!==0||bottom!==0||right!==width-1||top!==height-1)return false;
    }
    const channel=attrs.get('channels'),compression=attrs.get('compression');
    if(channel?.type!=='chlist'||compression?.type!=='compression'||compression.end-compression.start!==1||header[compression.start]!==compressionType)return false;
    const names=new Set(),pixelType=bitDepth===16?1:bitDepth===32?2:0;
    let pos=channel.start;
    while(pos<channel.end&&header[pos]!==0){
      const entry=nameAt(pos,channel.end);
      if(!entry||entry[1]+16>channel.end||names.has(entry[0])||
        header.readInt32LE(entry[1])!==pixelType||header.readInt32LE(entry[1]+8)!==1||header.readInt32LE(entry[1]+12)!==1)return false;
      names.add(entry[0]);pos=entry[1]+16;
    }
    if(!pixelType||pos!==channel.end-1||header[pos]!==0||names.size!==expected.length||
      !expected.every(name=>names.has(name)))return false;
    const rowsPerChunk=compressionType===3?16:1;
    const chunks=Math.ceil(height/rowsPerChunk),table=i+1,end=table+8*chunks;
    if(end>length||end>=size)return false;
    const rows=new Set(),chunkHeader=Buffer.alloc(8);
    for(let index=0;index<chunks;index++){
      const offset=Number(header.readBigUInt64LE(table+index*8));
      if(!Number.isSafeInteger(offset)||offset<end||offset+8>size||
        fs.readSync(handle,chunkHeader,0,8,offset)!==8)return false;
      const row=chunkHeader.readInt32LE(0),count=chunkHeader.readUInt32LE(4);
      if(row<0||row>=height||row%rowsPerChunk!==0||rows.has(row)||!count||offset+8+count>size||
        compressionType===0&&count!==width*expected.length*bitDepth/8)return false;
      rows.add(row);
    }
    return true;
  }finally{fs.closeSync(handle);}
}

export async function validateCyclesOutput(folder,settings,cycles,region=null,{signal}={}){
  const [width,height]=region?.output||[settings.width,settings.height],effective=cycles.render_effective;
  if(JSON.stringify(cycles.resolution)!==JSON.stringify([width,height]))throw Error('Cycles 输出尺寸与相机边界不一致');
  const fileFormat=settings.fileFormat??'PNG',exr=fileFormat==='OPEN_EXR';
  const mismatch=()=>Error('Cycles 输出格式、尺寸或位深与报告不一致');
  if(effective?.fileFormat!==fileFormat||cycles.output?.file!==(exr?'cycles.exr':'cycles.png')||
    cycles.output?.preview!=='cycles.png'||cycles.output?.previewBitDepth!==(exr?8:effective.bitDepth))throw mismatch();
  const renderSha256=await sha256File(path.join(folder,'cycles.png'),{signal,inspectHead:image=>{
    if(!pngSizeIs(image,width,height)||image[24]!==cycles.output.previewBitDepth||
      (effective.colorMode==='RGBA'&&image[25]!==6))throw mismatch();
  }});
  const result={renderSha256};
  if(exr){
    const file=path.join(folder,'cycles.exr'),channels=effective.colorMode==='RGBA'?['R','G','B','A']:['R','G','B'];
    if(!exrMatches(file,width,height,effective.bitDepth,channels))throw Error('OpenEXR 尺寸、通道或位深与 Cycles 报告不一致');
    result.outputSha256=await sha256File(file,{signal});
  }
  const passes=settings.renderPasses||[],report=cycles.passes;
  if(passes.length){
    const file=path.join(folder,'cycles-passes.exr');
    if(report?.file!=='cycles-passes.exr'||report.bitDepth!==32||typeof report.viewLayer!=='string'||!report.viewLayer||
      JSON.stringify(report.selected)!==JSON.stringify(passes)||!exrMatches(file,width,height,32,renderPassChannels(passes)))
      throw Error('多层 EXR 尺寸、位深或渲染通道不一致');
    result.passesSha256=await sha256File(file,{signal});
  }else if(report)throw Error('Cycles 返回了未请求的渲染通道');
  return result;
}
