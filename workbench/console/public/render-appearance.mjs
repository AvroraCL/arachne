export const renderTransforms={
  AgX:'AgX',Standard:'标准', 'Khronos PBR Neutral':'中性 PBR',Filmic:'Filmic',Raw:'原始'
};
const neutral=['None'],agx=['None','AgX - Medium Low Contrast','AgX - Medium High Contrast'];
export const renderLooks=transform=>transform==='AgX'?agx:neutral;
export const renderAppearanceDefaults=Object.freeze({viewTransform:'AgX',look:'None',exposure:0,gamma:1});
export const renderAppearanceLimits=Object.freeze({exposure:[-8,8],gamma:[.1,5]});

export function checkRenderAppearance(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(renderAppearanceDefaults,key)))
    throw Error('渲染色彩设置无效');
  const {viewTransform,look,exposure,gamma}=value;
  if(typeof viewTransform!=='string'||!Object.hasOwn(renderTransforms,viewTransform)||!renderLooks(viewTransform).includes(look))
    throw Error('渲染色彩变换或对比度无效');
  for(const key of ['exposure','gamma']){
    const n=value[key],[min,max]=renderAppearanceLimits[key];
    if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw Error('渲染色彩数值超出范围');
  }
  return {viewTransform,look,exposure,gamma};
}

export function matchesRenderAppearance(expected,actual){
  return !expected||!!actual&&actual.viewTransform===expected.viewTransform&&actual.look===expected.look&&
    ['exposure','gamma'].every(key=>Number.isFinite(actual[key])&&Math.abs(expected[key]-actual[key])<1e-5);
}
