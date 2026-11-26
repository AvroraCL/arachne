// The document upload budget also applies to a profile attached to an export.
export const outputProfileLimit=24*1024*1024;

export function outputProfileMode(header,length){
  if(length>outputProfileLimit)throw Error('ICC 配置不能超过 24 MiB');
  if(header.length<128||length<132)throw Error('ICC 文件头不完整');
  const signature=start=>String.fromCharCode(...header.subarray(start,start+4));
  const declared=new DataView(header.buffer,header.byteOffset,header.byteLength).getUint32(0);
  if(signature(36)!=='acsp'||declared!==length)throw Error('ICC 文件标识或长度无效');
  const mode=signature(16).trim().toUpperCase();
  if(!['RGB','GRAY','CMYK','LAB'].includes(mode)||!['XYZ ','Lab '].includes(signature(20)))
    throw Error('请选择可用于 RGB、灰度、Lab 或 CMYK 输出的设备配置');
  return mode;
}
