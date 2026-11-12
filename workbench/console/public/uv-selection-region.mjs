export const uvShapeFields=Object.freeze(['polygon','regions']);
export const uvRegionLimits=Object.freeze({rings:64,points:2048});

export function uvShapePayload({polygon,regions}){
  return {...(polygon!==undefined?{polygon}:{}),...(regions!==undefined?{regions}:{})};
}
