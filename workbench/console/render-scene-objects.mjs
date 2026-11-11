import fs from 'node:fs';
import {registeredViewportModel} from './viewport.mjs';
import {checkRenderVisibility} from './public/render-visibility.mjs';

const cache=new Map();

export function renderSceneObjects(doc){
  const {file,sha256,metadata}=registeredViewportModel(doc);
  const key=metadata.source_sha256+':'+sha256;
  if(cache.has(key))return cache.get(key);

  // Read only the GLB header and JSON chunk. Mesh buffers and images stay on disk.
  const fd=fs.openSync(file,'r');
  let gltf;
  try{
    const header=Buffer.alloc(20);
    if(fs.readSync(fd,header)!==20||header.toString('ascii',0,4)!=='glTF'||
      header.readUInt32LE(4)!==2||header.toString('ascii',16,20)!=='JSON')
      throw Error('登记模型的 GLB 格式无效');
    const length=header.readUInt32LE(12);
    if(length>fs.fstatSync(fd).size-header.length)throw Error('登记模型的 GLB 数据不完整');
    const json=Buffer.alloc(length);
    if(fs.readSync(fd,json)!==length)throw Error('登记模型的 GLB 数据不完整');
    gltf=JSON.parse(json.toString('utf8'));
  }finally{fs.closeSync(fd);}
  const visibility=checkRenderVisibility(Object.fromEntries((gltf.nodes||[])
    .filter(node=>node.mesh!==undefined&&node.name)
    .map(node=>[node.name,metadata.render_visibility?.[node.name]!==false])));
  const result={sourceSha256:metadata.source_sha256,visibility};
  cache.set(key,result);
  while(cache.size>8)cache.delete(cache.keys().next().value);
  return result;
}
