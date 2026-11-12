export const renderLightingPresets={source:'源场景',studio:'摄影棚',soft:'柔光',daylight:'日光',custom:'自定义'};
export const renderLightingDefaults=Object.freeze({
  preset:'source',lightStrength:1,environmentStrength:1,rotation:0,environmentColor:'#777777'
});
export const renderLightingLimits=Object.freeze({lightStrength:[0,4],environmentStrength:[0,4],rotation:[0,360]});
export const renderLightLimit=8;
export const renderLightRanges=Object.freeze({position:[-12,12],intensity:[0,20],size:[.03,8]});
const profiles={
  studio:{positions:[[1.2,-1,1.7],[-1.1,-.5,.6],[.4,1.4,1]],intensities:[2.8,.8,2],sizes:[.8,1.2,.7]},
  soft:{positions:[[1,-1,2],[-1,-.4,1],[.3,1.5,1.2]],intensities:[2,1.4,1.2],sizes:[1.8,2,1.7]},
  daylight:{positions:[[1,-.8,2.8],[-1,0,1],[0,1,1.4]],intensities:[3.3,.5,1],sizes:[.3,1.5,1]}
};
const lightKeys=['id','name','enabled','position','intensity','width','height','color'];
const hex=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
const inRange=(value,[min,max])=>Number.isFinite(value)&&value>=min&&value<=max;

export function presetRenderLights(preset){
  const profile=profiles[preset]||profiles.studio;
  return profile.positions.map((position,index)=>({
    id:['key','fill','rim'][index],name:['主光','补光','轮廓光'][index],enabled:true,position:[...position],
    intensity:profile.intensities[index],width:profile.sizes[index],height:profile.sizes[index],color:'#ffffff'
  }));
}

function checkRenderLights(lights){
  if(!Array.isArray(lights)||lights.length>renderLightLimit)throw Error('最多可添加 '+renderLightLimit+' 盏区域灯');
  const ids=new Set();
  return lights.map(light=>{
    if(!light||typeof light!=='object'||Array.isArray(light)||Object.keys(light).some(key=>!lightKeys.includes(key)))
      throw Error('区域灯设置无效');
    const {id,name,enabled,position,intensity,width,height,color}=light;
    if(typeof id!=='string'||!/^[-\w]{1,100}$/.test(id)||ids.has(id)||typeof name!=='string'||!name.trim()||
       name.trim().length>60||/[\u0000-\u001f\u007f]/.test(name)||typeof enabled!=='boolean'||!hex(color)||
       !Array.isArray(position)||position.length!==3||!position.every(n=>inRange(n,renderLightRanges.position))||
       Math.hypot(...position)<.01||!inRange(intensity,renderLightRanges.intensity)||
       ![width,height].every(n=>inRange(n,renderLightRanges.size)))throw Error('区域灯名称、位置或强度无效');
    ids.add(id);
    return {id,name:name.trim(),enabled,position:[...position],intensity,width,height,color:color.toLowerCase()};
  });
}

export function checkRenderLighting(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='lights'&&!Object.hasOwn(renderLightingDefaults,key)))
    throw Error('渲染布光设置无效');
  const {preset,lightStrength,environmentStrength,rotation,environmentColor}=value;
  if(typeof preset!=='string'||!Object.hasOwn(renderLightingPresets,preset)||
     !hex(environmentColor))throw Error('布光预设或环境颜色无效');
  for(const [key,[min,max]] of Object.entries(renderLightingLimits)){
    if(typeof value[key]!=='number'||!Number.isFinite(value[key])||value[key]<min||value[key]>max)
      throw Error('布光参数超出范围');
  }
  return {preset,lightStrength,environmentStrength,rotation,environmentColor:environmentColor.toLowerCase(),
    ...(preset==='custom'||value.lights!==undefined?{lights:checkRenderLights(value.lights)}:{})};
}
