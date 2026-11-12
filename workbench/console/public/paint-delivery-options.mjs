import {cyclesLimits,cyclesFormats} from './cycles-limits.mjs';
import {checkCyclesLightPaths} from './cycles-light-paths.mjs';
import {checkCyclesRenderPasses} from './cycles-render-passes.mjs';

export const deliverySizes={
  '960x720':[960,720], '1440x1080':[1440,1080], '1920x1080':[1920,1080], '1080x1440':[1080,1440],
  '3840x2160':[3840,2160], '2160x3840':[2160,3840]
};
export const deliveryQuality={fast:16,standard:64,high:128};
const defaultOptions={framing:'auto',size:'960x720',quality:'standard'};
const renderDefaults={device:'auto',adaptive:true,noiseThreshold:.01,maxBounces:12,transparent:false};
const choice=(value,options,fallback)=>typeof value==='string'&&Object.hasOwn(options,value)?value:fallback;
const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
const threshold=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
const dimension=value=>integer(value,cyclesLimits.minDimension,cyclesLimits.maxDimension);
const sampleCount=value=>integer(value,1,cyclesLimits.maxSamples);

export function normalizeDeliveryOptions(raw){
  raw=raw&&typeof raw==='object'?raw:{};
  const customSize=raw.size==='custom'&&dimension(raw.width)&&dimension(raw.height);
  const customQuality=raw.quality==='custom'&&sampleCount(raw.samples);
  const fileFormat=choice(raw.fileFormat,cyclesFormats,'PNG'),exr=fileFormat==='OPEN_EXR';
  let lightPaths;try{if(raw.lightPaths!=null)lightPaths=checkCyclesLightPaths(raw.lightPaths);}catch{}
  const [width,height]=customSize?[raw.width,raw.height]:deliverySizes[choice(raw.size,deliverySizes,defaultOptions.size)];
  let renderPasses=[];try{if(raw.renderPasses!=null)renderPasses=checkCyclesRenderPasses(raw.renderPasses,width,height);}catch{}
  return {framing:choice(raw.framing,{auto:1,viewport:1,saved:1},defaultOptions.framing),
    size:customSize?'custom':choice(raw.size,deliverySizes,defaultOptions.size),
    quality:customQuality?'custom':choice(raw.quality,deliveryQuality,defaultOptions.quality),
    ...(customSize?{width:raw.width,height:raw.height}:{}),
    ...(customQuality?{samples:raw.samples}:{}),...(raw.denoise===false?{denoise:false}:{}),
    ...(['cpu','gpu'].includes(raw.device)?{device:raw.device}:{}),
    ...(raw.adaptive===false?{adaptive:false}:{}),
    ...(threshold(raw.noiseThreshold)&&raw.noiseThreshold!==renderDefaults.noiseThreshold?{noiseThreshold:raw.noiseThreshold}:{}),
    ...(integer(raw.maxBounces,0,64)&&raw.maxBounces!==renderDefaults.maxBounces?{maxBounces:raw.maxBounces}:{}),
    ...(raw.transparent===true?{transparent:true}:{}),...(lightPaths?{lightPaths}:{}),
    ...(renderPasses.length?{renderPasses}:{}),...(exr?{fileFormat}:{}),
    ...(cyclesFormats[fileFormat].depths.includes(raw.bitDepth)?{bitDepth:raw.bitDepth}:exr?{bitDepth:16}:{})};
}

export function deliveryEditorValues(preferences){
  const options=normalizeDeliveryOptions(preferences);
  const [width,height]=options.size==='custom'?[options.width,options.height]:deliverySizes[options.size];
  return {framing:options.framing,width,height,samples:options.quality==='custom'?options.samples:deliveryQuality[options.quality],denoise:options.denoise!==false,
    device:options.device??renderDefaults.device,adaptive:options.adaptive??renderDefaults.adaptive,noiseThreshold:options.noiseThreshold??renderDefaults.noiseThreshold,
    maxBounces:options.maxBounces??renderDefaults.maxBounces,transparent:options.transparent??renderDefaults.transparent,
    fileFormat:options.fileFormat??'PNG',bitDepth:options.bitDepth??null,...(options.lightPaths?{lightPaths:options.lightPaths}:{}),
    ...(options.renderPasses?{renderPasses:options.renderPasses}:{})};
}

export function updateDeliveryOptions(preferences,patch){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['framing','width','height','samples','denoise','device','adaptive','noiseThreshold','maxBounces','transparent','fileFormat','bitDepth','lightPaths','renderPasses'].includes(key)))throw Error('渲染设置无效');
  const value={...deliveryEditorValues(preferences),...patch};
  if(value.lightPaths!==undefined&&value.lightPaths!==null)checkCyclesLightPaths(value.lightPaths);
  if(!Object.hasOwn(cyclesFormats,value.fileFormat))throw Error('渲染输出格式无效');
  const depths=cyclesFormats[value.fileFormat].depths;
  if(Object.hasOwn(patch,'fileFormat')&&!Object.hasOwn(patch,'bitDepth')&&!depths.includes(value.bitDepth))
    value.bitDepth=value.fileFormat==='OPEN_EXR'?16:null;
  if(!['auto','viewport','saved'].includes(value.framing)||!dimension(value.width)||!dimension(value.height)||!sampleCount(value.samples)||typeof value.denoise!=='boolean'||!['auto','cpu','gpu'].includes(value.device)||typeof value.adaptive!=='boolean'||!threshold(value.noiseThreshold)||!integer(value.maxBounces,0,64)||typeof value.transparent!=='boolean'||!(value.fileFormat==='PNG'&&value.bitDepth===null)&&!depths.includes(value.bitDepth))throw Error('请输入有效的渲染设置');
  if(value.renderPasses!==undefined)checkCyclesRenderPasses(value.renderPasses,value.width,value.height);
  const size=Object.entries(deliverySizes).find(([,v])=>v[0]===value.width&&v[1]===value.height)?.[0]||'custom';
  const quality=Object.entries(deliveryQuality).find(([,v])=>v===value.samples)?.[0]||'custom';
  return normalizeDeliveryOptions({...value,size,quality});
}

export function captureDeliverySettings(preferences,camera,savedCamera){
  const options=deliveryEditorValues(preferences),{width,height,samples}=options;
  if(options.framing==='viewport'&&!camera)throw Error('请先打开三维视口，再使用当前视角');
  if(options.framing==='saved'&&!savedCamera)throw Error('请先保存工程的渲染相机');
  return {width,height,samples,textureJobId:null,...(!options.denoise?{denoise:false}:{}),
    ...(options.fileFormat==='OPEN_EXR'?{fileFormat:options.fileFormat}:{}),
    ...(options.bitDepth===null?{}:{bitDepth:options.bitDepth}),
    ...(options.lightPaths?{lightPaths:options.lightPaths}:{}),
    ...(options.renderPasses?{renderPasses:options.renderPasses}:{}),
    device:options.device,adaptive:options.adaptive,noiseThreshold:options.noiseThreshold,maxBounces:options.maxBounces,transparent:options.transparent,
    camera:options.framing==='auto'?null:structuredClone(options.framing==='saved'?savedCamera:camera)};
}

const presetFields=['framing','width','height','samples','denoise','adaptive','noiseThreshold','maxBounces','transparent','fileFormat','bitDepth'];
export function captureRenderPreset(preferences){
  const value=deliveryEditorValues(preferences);
  if(value.framing==='viewport')throw Error('请先保存当前视角为工程相机');
  return {version:1,...Object.fromEntries(presetFields.map(key=>[key,value[key]])),
    ...(value.lightPaths?{lightPaths:value.lightPaths}:{}),...(value.renderPasses?{renderPasses:value.renderPasses}:{})};
}

export function checkRenderPreset(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||
    Object.keys(value).length!==presetFields.length+1+['lightPaths','renderPasses'].filter(key=>Object.hasOwn(value,key)).length||
    !presetFields.every(key=>Object.hasOwn(value,key))||Object.hasOwn(value,'lightPaths')&&!value.lightPaths||
    !['auto','saved'].includes(value.framing))throw Error('工程渲染预设无效');
  const {version,...patch}=value;
  return captureRenderPreset(updateDeliveryOptions({},patch));
}

export function renderPresetPreferences(value,device='auto'){
  const {version,...patch}=checkRenderPreset(value);
  return updateDeliveryOptions({},{...patch,device});
}

export function createRenderPreferences(initial){
  let local=normalizeDeliveryOptions(initial);
  const drafts=new Map();
  function read(doc){
    const preset=doc?.paint.renderPreset;
    if(!preset)return local;
    const draft=drafts.get(doc.id);
    const base=JSON.stringify(preset);
    if(draft?.base===base)return {...draft.options,device:local.device};
    if(draft)drafts.delete(doc.id);
    return renderPresetPreferences(preset,local.device??'auto');
  }
  return {
    read,local:()=>local,
    setLocal(value){local=normalizeDeliveryOptions(value);},
    set(doc,value){
      const options=normalizeDeliveryOptions(value),preset=doc?.paint.renderPreset;
      if(!preset){local=options;return;}
      drafts.set(doc.id,{base:JSON.stringify(preset),options});
      local=normalizeDeliveryOptions({...local,device:options.device});
    },
    reset(doc){if(doc)drafts.delete(doc.id);}
  };
}

export const renderBookmarkLimit=24;

export function sameDeliveryCamera(a,b){
  if(!a||!b)return a===b;
  if(a.projection!==b.projection)return false;
  const close=(x,y)=>Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=1e-6*Math.max(1,Math.abs(x),Math.abs(y));
  return ['eye','target','up'].every(key=>Array.isArray(a[key])&&Array.isArray(b[key])&&
    a[key].length===3&&b[key].length===3&&a[key].every((value,i)=>close(value,b[key][i])))&&
    ['fov','orthoHeight'].every(key=>close(a[key],b[key]));
}
