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

export const renderPngSpaces={srgb:'sRGB','display-p3':'Display P3','adobe-rgb':'Adobe RGB (1998)',
  'prophoto-rgb':'ProPhoto RGB',rec2020:'Rec.2020'};
export function usesPackedPng({fileFormat='PNG',bitDepth,pngSpace='srgb'}){
  return fileFormat==='PNG'&&(bitDepth===16||(pngSpace!=='srgb'&&pngSpace!=='display-p3'));
}
export function fillPngSpaceSelect(select){
  select.replaceChildren(...Object.entries(renderPngSpaces).map(([id,name])=>new Option(name,id)));
}
