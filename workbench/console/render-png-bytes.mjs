import {readFile} from 'node:fs/promises';
import {crc32,deflateSync} from 'node:zlib';

// PNG cHRM uses white, then red/green/blue, in xy coordinates scaled by 100000.
const profiles={
  srgb:{file:'sRGB-v4.icc',xy:[31270,32900,64000,33000,30000,60000,15000,6000],cicp:[1,13,0,1]},
  'display-p3':{file:'DisplayP3-v4.icc',xy:[31270,32900,68000,32000,26500,69000,15000,6000],cicp:[12,13,0,1]},
  'adobe-rgb':{file:'AdobeCompat-v2.icc',xy:[31270,32900,64000,33000,21000,71000,15000,6000]},
  'prophoto-rgb':{file:'ProPhoto-v4.icc',xy:[34570,35850,73470,26530,15960,84040,3660,10]},
  rec2020:{file:'Rec2020-v4.icc',xy:[31270,32900,70800,29200,17000,79700,13100,4600]}
};

function chunk(type,bytes){
  const packed=Buffer.allocUnsafe(12+bytes.length);
  packed.writeUInt32BE(bytes.length);packed.write(type,4,4,'ascii');bytes.copy(packed,8);
  packed.writeUInt32BE(crc32(packed.subarray(4,8+bytes.length)),8+bytes.length);
  return packed;
}

export async function renderPngBytes(scanlines,[width,height],depth,space='srgb'){
  const spec=profiles[space];
  if(!spec)throw Error('未知的 PNG 输出颜色空间');
  const profile=await readFile(new URL('./public/color-profiles/'+spec.file,import.meta.url));
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);
  header[8]=depth;header[9]=6;
  const icc=Buffer.concat([Buffer.from(space+'\0\0','ascii'),deflateSync(profile)]);
  const xy=Buffer.alloc(32);spec.xy.forEach((value,i)=>xy.writeUInt32BE(value,i*4));
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('cHRM',xy),...(spec.cicp?[chunk('cICP',Buffer.from(spec.cicp))]:[]),
    chunk('iCCP',icc),chunk('IDAT',scanlines),chunk('IEND',Buffer.alloc(0))]);
}
