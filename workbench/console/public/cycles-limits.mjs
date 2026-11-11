export const cyclesLimits=Object.freeze({minDimension:128,maxDimension:4096,maxSamples:4096});
export const minCyclesViewportDimension=16;
export const cyclesViewportLimits=Object.freeze({
  draft:Object.freeze({size:1024,pixels:960,samples:16}),
  detail:Object.freeze({size:4096,pixels:1536,samples:32})
});
export const cyclesFormats=Object.freeze({
  PNG:Object.freeze({label:'PNG',extension:'png',depths:Object.freeze([8,16])}),
  OPEN_EXR:Object.freeze({label:'OpenEXR',extension:'exr',depths:Object.freeze([16,32])})
});
