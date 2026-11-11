import {sceneOptions} from './scene-options.mjs';

export const preferenceKey='arachne-paint-preferences-v1';
export const preferenceDefaults=Object.freeze({density:'compact',motion:'system',startupArea:'last',autoDetail:true,detailDelay:900});
export const brushDefaults=Object.freeze({worldRadius:.22,uvRadius:48,hardness:.75,opacity:1,pressure:true,mirror:false});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function fields(raw,defaults){
  if(!object(raw)||Object.keys(raw).some(key=>!Object.hasOwn(defaults,key)))throw Error('设置包含未知选项');
  return {...defaults,...raw};
}
function number(value,min,max,integer=false){
  if(!Number.isFinite(value)||value<min||value>max||integer&&!Number.isInteger(value))throw Error('设置数值超出范围');
}
export function normalizePreferences(raw={}){
  const p=fields(raw,preferenceDefaults);
  for(const [key,choices] of [['density',['compact','comfortable']],['motion',['system','full','reduced']],
    ['startupArea',['last','modeling','material','drawing']]])if(!choices.includes(p[key]))throw Error('设置选项无效：'+key);
  if(typeof p.autoDetail!=='boolean')throw Error('4K 预览开关无效');
  number(p.detailDelay,300,5000,true);return p;
}
export function normalizeBrush(raw={}){
  const b=fields(raw,brushDefaults);
  for(const [key,min,max,integer] of [['worldRadius',.02,.65],['uvRadius',2,256,true],['hardness',0,1],['opacity',.05,1]])number(b[key],min,max,integer);
  if(typeof b.pressure!=='boolean'||typeof b.mirror!=='boolean')throw Error('画笔开关无效');
  return b;
}
export function normalizeSettingsBundle(raw){
  if(!object(raw)||raw.version!==1||Object.keys(raw).some(k=>!['version','preferences','brush','display'].includes(k))||
     !object(raw.preferences)||!object(raw.brush)||!object(raw.display))throw Error('请选择有效的阿拉克涅设置文件');
  return {version:1,preferences:normalizePreferences(raw.preferences),brush:normalizeBrush(raw.brush),display:sceneOptions(raw.display)};
}
export function loadPreferences(storage){
  try{return normalizePreferences(JSON.parse(storage.getItem(preferenceKey))||{});}catch{return {...preferenceDefaults};}
}
export function applyAppearance(p,root=document.documentElement){
  root.dataset.uiDensity=p.density;root.dataset.motion=p.motion;
}
export function saveSettingsBundle(storage,raw){
  const bundle=normalizeSettingsBundle(raw),b=bundle.brush;
  const values={
    [preferenceKey]:bundle.preferences,
    'arachne-paint-brush-v1':{'brush-radius':b.worldRadius,'brush-uv-radius':b.uvRadius,'brush-hardness':b.hardness,
      'brush-opacity':b.opacity,'brush-uv-pressure':b.pressure,mirrorX:b.mirror},
    'arachne-paint-display':bundle.display
  };
  const before=new Map();
  try{
    for(const key of Object.keys(values))before.set(key,storage.getItem(key));
    for(const [key,value] of Object.entries(values))storage.setItem(key,JSON.stringify(value));
  }catch{
    for(const [key,value] of before)try{if(value===null)storage.removeItem(key);else storage.setItem(key,value);}catch{}
    throw Error('无法保存本机设置，请检查浏览器存储空间');
  }
  return bundle;
}
