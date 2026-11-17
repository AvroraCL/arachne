import {cyclesLimits} from './cycles-limits.mjs';

export const viewportSamplingDefaults=Object.freeze({
  maxSamples:24,adaptive:false,noiseThreshold:.1,minSamples:0,denoise:true,denoiseStart:8
});

const sampleCount=value=>Number.isInteger(value)&&value<=cyclesLimits.maxSamples;
const validators={
  maxSamples:value=>sampleCount(value)&&value>=0,
  adaptive:value=>typeof value==='boolean',
  noiseThreshold:value=>Number.isFinite(value)&&value>=0&&value<=1,
  minSamples:value=>sampleCount(value)&&value>=0,
  denoise:value=>typeof value==='boolean',
  denoiseStart:value=>sampleCount(value)&&value>=1
};

export function viewportSamplingOptions(raw){
  const values={...raw,maxSamples:raw?.maxSamples??raw?.detailSamples};
  // Early versions saved a legacy Cycles flag that had no effect on the viewport.
  if(raw?.maxSamples===undefined&&raw?.minSamples===undefined)delete values.adaptive;
  return Object.fromEntries(Object.entries(validators).map(([key,valid])=>[
    key,valid(values[key])?values[key]:viewportSamplingDefaults[key]
  ]));
}

export function viewportConvergence({adaptive,noiseThreshold,minSamples,maxSamples}){
  if(!adaptive)return null;
  const threshold=noiseThreshold||Math.min(.1,1/Math.sqrt(maxSamples||256));
  const minimum=minSamples||Math.max(8,Math.min(64,Math.ceil(1/Math.sqrt(threshold))));
  return {threshold,minimum:Math.max(3,minimum)};
}

export function updateViewportSampling(current,patch){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.entries(patch).some(([key,value])=>!Object.hasOwn(validators,key)||!validators[key](value)))
    throw Error('视口采样设置无效');
  return {...current,...patch};
}
