const validName=name=>typeof name==='string'&&name.length>0&&name.length<=256&&
  !/[\u0000-\u001f\u007f]/u.test(name)&&!['__proto__','prototype','constructor'].includes(name);

export function checkRenderVisibility(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>4096||
    Object.entries(value).some(([name,visible])=>!validName(name)||typeof visible!=='boolean'))
    throw Error('物体渲染显隐无效');
  return Object.fromEntries(Object.keys(value).sort().map(name=>[name,value[name]]));
}

export function renderObjectVisible(source,overrides,name){
  if(!source||!Object.hasOwn(source,name))return null;
  return Object.hasOwn(overrides||{},name)?overrides[name]:source[name];
}

export function updateRenderVisibility(source,previous,patch){
  const entries=Object.entries(checkRenderVisibility(patch));
  if(!entries.length)throw Error('请选择需要调整渲染显隐的物体');
  const next={...previous};
  for(const [name,visible] of entries){
    if(!source||!Object.hasOwn(source,name))throw Error('工程源场景中找不到渲染物体：'+name);
    if(visible===source[name])delete next[name];else next[name]=visible;
  }
  return checkRenderVisibility(next);
}
