import {layerChildren} from './paint-layer-tree.mjs';

export function imageOpacityPlan(image,layerId){
  if(image?.colorSpace!=='srgb'||image.width!==4096||image.height!==4096||
     image.frame?.some((value,i)=>value!==[0,0,4096,4096][i]))return null;
  const base=layerChildren(image.layers,null).find(layer=>layer.visible&&!layer.clipped);
  const hasEffects=layer=>Object.values(layer.styles??{}).some(effect=>effect.enabled);
  if(!base||base.id!==layerId||base.kind!=='shape'||base.blend!=='normal'||base.maskEnabled||
     base.blendIf||base.warp||base.rotation||base.scale!==1||Math.abs(base.x-.5)>1e-12||Math.abs(base.y-.5)>1e-12||
     base.stretch?.some(value=>value!==1)||hasEffects(base))return null;
  const shape=base.shape;
  if(shape.kind!=='rectangle'||shape.width!==shape.height||shape.width<5||shape.cornerRadius||shape.stroke||!shape.fill)return null;

  const planes=[];
  function collect(parent){
    for(const layer of layerChildren(image.layers,parent)){
      if(layer===base||!layer.visible||!layer.opacity)continue;
      if(layer.clipped||layer.blendIf||layer.embedded)return false;
      if(layer.kind==='group'){
        if(layer.blend!=='passThrough'||layer.opacity!==1||layer.maskEnabled||hasEffects(layer)||!collect(layer.id))return false;
      }else if(layer.kind==='adjustment'){
        if(layer.adjustment.type!=='invert'||layer.blend!=='normal'||layer.edgeDecontaminate)return false;
        planes.push({mode:'invert',ids:[layer.id],opacity:layer.opacity});
      }else if(layer.blend==='normal'){
        if(planes.at(-1)?.mode!=='normal')planes.push({mode:'normal',ids:[]});
        planes.at(-1).ids.push(layer.id);
      }else if(['multiply','screen','overlay'].includes(layer.blend)){
        planes.push({mode:layer.blend,ids:[layer.id]});
      }else return false;
    }
    return true;
  }
  // Keep the prepared textures and shader work bounded for a single control.
  if(!collect(null)||planes.length>8)return null;
  return {fill:shape.fill,planes};
}
