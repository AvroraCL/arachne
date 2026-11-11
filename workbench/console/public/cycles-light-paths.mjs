export const cyclesLightPaths=Object.freeze({
  diffuseBounces:{label:'漫反射',default:4,min:0,max:64,step:1},
  glossyBounces:{label:'光泽',default:4,min:0,max:64,step:1},
  transmissionBounces:{label:'透射',default:12,min:0,max:64,step:1},
  volumeBounces:{label:'体积',default:0,min:0,max:64,step:1},
  transparentBounces:{label:'透明',default:8,min:0,max:64,step:1},
  directClamp:{label:'直接光',default:0,min:0,max:10000,step:.01},
  indirectClamp:{label:'间接光',default:10,min:0,max:10000,step:.01},
  glossyFilter:{label:'光泽过滤',default:1,min:0,max:10,step:.01},
  reflectiveCaustics:{label:'反射焦散',default:true},
  refractiveCaustics:{label:'折射焦散',default:true}
});
export const cyclesLightPathDefaults=Object.freeze(Object.fromEntries(Object.entries(cyclesLightPaths).map(([key,field])=>[key,field.default])));

export function checkCyclesLightPaths(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==Object.keys(cyclesLightPaths).length)
    throw Error('Cycles 光线路径设置无效');
  const result={};
  for(const [key,spec] of Object.entries(cyclesLightPaths)){
    const value=input[key],valid=typeof spec.default==='boolean'?typeof value==='boolean':
      typeof value==='number'&&Number.isFinite(value)&&value>=spec.min&&value<=spec.max&&
        (spec.step!==1||Number.isInteger(value));
    if(!Object.hasOwn(input,key)||!valid)throw Error('Cycles 光线路径的'+spec.label+'设置无效');
    result[key]=value;
  }
  return result;
}

export function matchesCyclesLightPaths(expected,actual){
  if(!expected||!actual)return expected===actual;
  return Object.keys(cyclesLightPaths).every(key=>typeof expected[key]==='number'?
    Number.isFinite(actual[key])&&Math.abs(expected[key]-actual[key])<=1e-6*Math.max(1,Math.abs(expected[key])):expected[key]===actual[key]);
}
