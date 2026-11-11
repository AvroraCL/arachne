export const renderLightingPresets={source:'源场景',studio:'摄影棚',soft:'柔光',daylight:'日光'};
export const renderLightingDefaults=Object.freeze({
  preset:'source',lightStrength:1,environmentStrength:1,rotation:0,environmentColor:'#777777'
});
export const renderLightingLimits=Object.freeze({lightStrength:[0,4],environmentStrength:[0,4],rotation:[0,360]});

export function checkRenderLighting(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(renderLightingDefaults,key)))
    throw Error('渲染布光设置无效');
  const {preset,lightStrength,environmentStrength,rotation,environmentColor}=value;
  if(typeof preset!=='string'||!Object.hasOwn(renderLightingPresets,preset)||
     typeof environmentColor!=='string'||!/^#[0-9a-f]{6}$/i.test(environmentColor))throw Error('布光预设或环境颜色无效');
  for(const [key,[min,max]] of Object.entries(renderLightingLimits)){
    if(typeof value[key]!=='number'||!Number.isFinite(value[key])||value[key]<min||value[key]>max)
      throw Error('布光参数超出范围');
  }
  return {preset,lightStrength,environmentStrength,rotation,environmentColor:environmentColor.toLowerCase()};
}
