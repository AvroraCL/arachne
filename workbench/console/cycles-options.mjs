import {cyclesLimits,cyclesFormats} from './public/cycles-limits.mjs';
import {captureDeliverySettings,renderPresetPreferences} from './public/paint-delivery-options.mjs';
import {checkCyclesLightPaths} from './public/cycles-light-paths.mjs';
import {checkCyclesRenderPasses} from './public/cycles-render-passes.mjs';

export function cyclesOptions(raw={},{minDimension=cyclesLimits.minDimension}={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Cycles 参数无效');
  const n=(value,fallback,min,max)=>{const x=value===undefined?fallback:value;if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max)throw Error('Cycles 数值参数超出范围');return x;};
  const {maxDimension,maxSamples}=cyclesLimits;
  const width=n(raw.width,1200,minDimension,maxDimension),height=n(raw.height,900,minDimension,maxDimension),samples=n(raw.samples,64,1,maxSamples);
  if(![width,height,samples].every(Number.isInteger))throw Error('Cycles 分辨率与采样必须为整数');
  if(raw.denoise!==undefined&&typeof raw.denoise!=='boolean')throw Error('Cycles 降噪开关无效');
  if(raw.device!==undefined&&!['auto','cpu','gpu'].includes(raw.device))throw Error('Cycles 渲染设备无效');
  const format=raw.fileFormat===undefined?'PNG':raw.fileFormat;
  if(typeof format!=='string'||!Object.hasOwn(cyclesFormats,format))throw Error('Cycles 输出格式无效');
  if(raw.bitDepth!==undefined&&!cyclesFormats[format].depths.includes(raw.bitDepth))throw Error('位深与 Cycles 输出格式不匹配');
  for(const key of ['adaptive','transparent'])if(raw[key]!==undefined&&typeof raw[key]!=='boolean')throw Error('Cycles 开关无效');
  if(raw.noiseThreshold!==undefined)n(raw.noiseThreshold,0,0,1);
  if(raw.maxBounces!==undefined&&!Number.isInteger(n(raw.maxBounces,12,0,64)))throw Error('Cycles 光线反弹次数必须为整数');
  const lightPaths=raw.lightPaths===undefined?undefined:checkCyclesLightPaths(raw.lightPaths);
  const renderPasses=raw.renderPasses===undefined?[]:checkCyclesRenderPasses(raw.renderPasses,width,height);
  const textureJobId=raw.textureJobId??null;if(textureJobId!==null&&(typeof textureJobId!=='string'||!/^[-\w]{1,100}$/.test(textureJobId)))throw Error('贴图任务编号无效');
  let camera=null;
  if(raw.camera!==undefined&&raw.camera!==null){
    const c=raw.camera;if(!['perspective','orthographic'].includes(c.projection))throw Error('相机投影无效');
    const vec=v=>{if(!Array.isArray(v)||v.length!==3||!v.every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=1e6))throw Error('相机向量无效');return [...v];};
    const eye=vec(c.eye),target=vec(c.target),up=vec(c.up),d=eye.map((x,i)=>x-target[i]);
    const length=v=>Math.hypot(...v),cross=[d[1]*up[2]-d[2]*up[1],d[2]*up[0]-d[0]*up[2],d[0]*up[1]-d[1]*up[0]];
    if(length(d)<1e-5||length(up)<1e-5||length(cross)/(length(d)*length(up))<1e-5)throw Error('相机方向或上方向退化');
    camera={projection:c.projection,eye,target,up,fov:n(c.fov,38,5,120),orthoHeight:n(c.orthoHeight,10,.00001,1e6)};
  }
  return {width,height,samples,textureJobId,camera,...Object.fromEntries(['denoise','device','adaptive','noiseThreshold','maxBounces','transparent','fileFormat','bitDepth'].filter(key=>raw[key]!==undefined).map(key=>[key,raw[key]])),
    ...(lightPaths?{lightPaths}:{}),
    ...(renderPasses.length?{renderPasses}:{}),
    ...(format==='OPEN_EXR'&&raw.bitDepth===undefined?{bitDepth:16}:{})};
}

export function resolvePaintRenderSettings(paint,{settings,useProjectCamera,useProjectPreset}){
  if([useProjectCamera,useProjectPreset].some(value=>value!==undefined&&typeof value!=='boolean'))
    throw Error('工程渲染选项无效');
  if(useProjectPreset){
    if(!paint.renderPreset)throw Error('请先保存工程渲染预设');
    if(settings!==undefined&&(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(key=>key!=='device')))
      throw Error('使用工程渲染预设时只可指定本机渲染设备');
    const preferences=renderPresetPreferences(paint.renderPreset,settings?.device??'auto');
    return cyclesOptions(captureDeliverySettings(useProjectCamera?{...preferences,framing:'saved'}:preferences,null,paint.renderCamera));
  }
  if(!useProjectCamera)return settings;
  if(settings?.camera!=null)throw Error('工程渲染相机和指定相机只能选择一个');
  if(!paint.renderCamera)throw Error('请先保存工程的渲染相机');
  return {...cyclesOptions(settings??{}),camera:paint.renderCamera};
}
