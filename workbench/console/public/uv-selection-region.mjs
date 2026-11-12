export const uvShapeFields=Object.freeze(['polygon','regions','feather']);
export const uvRegionLimits=Object.freeze({rings:64,points:2048});
export const maxUVFeather=256;

export function uvShapePayload({polygon,regions,feather}){
  return {...(polygon!==undefined?{polygon}:{}),...(regions!==undefined?{regions}:{}),
    ...(feather!==undefined?{feather}:{})};
}
