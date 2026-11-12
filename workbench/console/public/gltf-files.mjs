const attachmentKey=name=>name.normalize('NFC').toLowerCase();
const embedded=/^data:(?:image\/(?:png|jpeg|webp)|application\/(?:octet-stream|gltf-buffer));base64,[a-z0-9+/]+={0,2}$/i;

export function parseGltf(text){
  let model;
  try{model=JSON.parse(text);}
  catch{throw Error('glTF 场景描述无效');}
  if(model?.asset?.version!=='2.0')throw Error('请选择有效的 glTF 2.0 模型');
  if(!Array.isArray(model.buffers)||!model.buffers.length||!Array.isArray(model.bufferViews)||
     (model.images!==undefined&&!Array.isArray(model.images)))throw Error('glTF 缺少有效的缓冲区或图像列表');
  return model;
}

export function resolveGltfFiles(model,attachments){
  const files=new Map(),referencedPaths=new Map();
  for(const file of attachments){
    const key=attachmentKey(file.name);
    if(files.has(key))throw Error('配套文件中有重名项：'+file.name);
    files.set(key,file);
  }
  function resolve(uri){
    if(typeof uri!=='string'||!uri)throw Error('glTF 引用缺少文件名');
    if(/^data:/i.test(uri)){
      if(!embedded.test(uri))throw Error('glTF 内嵌数据格式无效');
      return uri;
    }
    let parts;
    try{parts=uri.split('/').map(decodeURIComponent);}
    catch{throw Error('glTF 配套文件路径无效');}
    if(parts.some(part=>!part||part==='..'||/[\\/:\u0000-\u001f]/.test(part))||parts.at(-1)==='.'||/[?#]/.test(uri))
      throw Error('glTF 只接受相对于模型的配套文件');
    const key=attachmentKey(parts.at(-1)),relative=attachmentKey(parts.filter(part=>part!=='.').join('/'));
    const previous=referencedPaths.get(key);
    if(previous&&previous!==relative)throw Error('glTF 引用了不同目录下的同名文件：'+parts.at(-1));
    referencedPaths.set(key,relative);
    const file=files.get(key);
    if(!file)throw Error('缺少 glTF 配套文件：'+parts.at(-1));
    return file;
  }
  return {
    buffers:model.buffers.map(buffer=>resolve(buffer?.uri)),
    images:(model.images||[]).map(image=>{
      if(image?.uri!==undefined){
        if(image.bufferView!==undefined)throw Error('glTF 图像只能引用一个数据来源');
        return resolve(image.uri);
      }
      if(!Number.isInteger(image?.bufferView)||!model.bufferViews[image.bufferView])throw Error('glTF 图像引用无效');
      return null;
    })
  };
}
