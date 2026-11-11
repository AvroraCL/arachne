import {cyclesViewportLimits} from './cycles-limits.mjs';

export const viewportSamplingDefaults=Object.freeze({
  draftSamples:8,detailSamples:24,adaptive:true,noiseThreshold:.01,denoise:true
});

const validators={
  draftSamples:value=>Number.isInteger(value)&&value>=1&&value<=cyclesViewportLimits.draft.samples,
  detailSamples:value=>Number.isInteger(value)&&value>=1&&value<=cyclesViewportLimits.detail.samples,
  adaptive:value=>typeof value==='boolean',
  noiseThreshold:value=>Number.isFinite(value)&&value>=0&&value<=1,
  denoise:value=>typeof value==='boolean'
};

export function viewportSamplingOptions(raw){
  return Object.fromEntries(Object.entries(validators).map(([key,valid])=>[
    key,valid(raw?.[key])?raw[key]:viewportSamplingDefaults[key]
  ]));
}

export function updateViewportSampling(current,patch){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.entries(patch).some(([key,value])=>!Object.hasOwn(validators,key)||!validators[key](value)))
    throw Error('视口采样设置无效');
  return {...current,...patch};
}
