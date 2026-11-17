export const uvShapeFields=Object.freeze(['polygon','regions','feather']);
export const imageSelectionFields=Object.freeze([...uvShapeFields,'coverage']);
export const uvRegionLimits=Object.freeze({rings:64,points:2048});
export const maxUVFeather=256;
export const isSelectionAsset=asset=>asset?.purpose==='selection';
export const validSelectionOutline=outline=>outline?.size===512&&typeof outline.path==='string'&&
  outline.path.length<=4*1024*1024&&/^[M0-9 HV]+$/.test(outline.path);

export function uvShapePayload({polygon,regions,feather,coverage}){
  return {...(polygon!==undefined?{polygon}:{}),...(regions!==undefined?{regions}:{}),
    ...(feather!==undefined?{feather}:{}),...(coverage!==undefined?{coverage}:{})};
}
