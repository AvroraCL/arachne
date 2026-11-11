const text=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/u.test(value);
export function validateObjectNames(names){
  if(names===undefined)return;
  if(!names||typeof names!=='object'||Array.isArray(names)||Object.keys(names).length>10000||Object.entries(names).some(([key,value])=>!text(key)||!text(value)||['__proto__','constructor','prototype'].includes(key)))throw Error('物体名称无效');
}
export function renamedObjects(items,targets,template){
  if(typeof template!=='string'||!template.trim())throw Error('请输入名称');
  const selected=new Set(targets),used=new Set(items.filter(item=>!selected.has(item.id)).map(item=>item.label)),result={};let index=0;
  for(const item of items.filter(item=>selected.has(item.id))){
    const base=template.replaceAll('{name}',item.label).replaceAll('{n}',String(++index)).trim();if(!text(base))throw Error('名称应为 1–200 个字符');
    let name=base,suffix=0;while(used.has(name))name=base+'.'+String(++suffix).padStart(3,'0');used.add(name);result[item.sourceName||item.label]=name;
  }
  validateObjectNames(result);return result;
}
