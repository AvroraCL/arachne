import path from 'node:path';

export function dataDirectory(root,env=process.env){
  const external=env.ARACHNE_ALLOW_EXTERNAL_DATA==='1',configured=env.ARACHNE_DATA_DIR;
  if(external&&(!configured||!path.isAbsolute(configured)))throw Error('独立数据目录必须使用绝对路径');
  const data=path.resolve(configured||path.join(root,'data'));
  if(data===path.parse(data).root||data===root||root.startsWith(data+path.sep))throw Error('数据目录不能覆盖程序目录');
  if(!data.startsWith(root+path.sep)&&!external)throw Error('数据目录必须位于工作台目录内');
  return data;
}

export function checkedRootAliases(values){
  if(!Array.isArray(values)||values.length>32)throw Error('安装路径记录无效');
  return values.filter(value=>typeof value==='string'&&path.isAbsolute(value)&&value!==path.parse(value).root);
}
