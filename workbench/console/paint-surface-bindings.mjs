import {modelFingerprint,validateModelState} from './model-binding.mjs';
import {encodeStrokeBlock,unpackStrokeBlock} from './stroke-compaction.mjs';
import {isStrokeBlock} from './public/stroke-blocks.mjs';

const original='original';
const owns=(map,key)=>Object.hasOwn(map,key);
export const surfaceBindingKey=modeling=>modelFingerprint({modeling})||original;
const spatialStroke=stroke=>stroke.uv!==true&&!stroke.transformUV&&!stroke.clearUV;
const projected=layer=>layer.kind==='decal'&&layer.space!=='uv';

export function validateSurfaceBindings(paint){
  const bindings=paint.surfaceBindings||{};
  if(typeof bindings!=='object'||Array.isArray(bindings)||
     Buffer.byteLength(JSON.stringify(bindings))>6*1024*1024)throw Error('绘制表面版本超出工程限制');
  for(const [key,state] of Object.entries(bindings)){
    if(state===null){if(key!==original&&!/^[a-f0-9]{64}$/.test(key))throw Error('原始绘制表面无效');}
    else{
      validateModelState(state);
      if(key!==surfaceBindingKey(state))throw Error('绘制表面指纹不一致');
    }
  }
  function reference(item,allowed){
    if(item.surfaceBinding===undefined)return;
    if(!allowed||typeof item.surfaceBinding!=='string'||!owns(bindings,item.surfaceBinding))
      throw Error('绘制表面版本不存在或不适用于此内容');
  }
  for(const factors of Object.values(paint.sourceMaterials||{}))if(factors.mark)reference(factors.mark,true);
  for(const layer of paint.layers){
    reference(layer,projected(layer));
    for(const stroke of [...(layer.strokes||[]),...(layer.maskStrokes||[])]){
      if(isStrokeBlock(stroke)){
        for(const key of stroke.bindings??[])reference({surfaceBinding:key},true);
      }else reference(stroke,spatialStroke(stroke));
    }
  }
}

// Geometry changes never change the surface on which existing artwork was
// authored. Re-evaluate its coverage on that surface, then keep it in UV space.
export function pinSurfaceInputs(doc,{reproject=[]}={}){
  const paint=doc.paint;if(!paint)return;
  const current=surfaceBindingKey(doc.modeling),bindings=paint.surfaceBindings||{};
  const used=new Set();
  function pin(item){
    if(item.surfaceBinding===undefined){
      if(!owns(bindings,current))bindings[current]=current===original?null:structuredClone(doc.modeling);
      item.surfaceBinding=current;
    }
    used.add(item.surfaceBinding);
  }
  for(const factors of Object.values(paint.sourceMaterials||{}))if(factors.mark)pin(factors.mark);
  for(const layer of paint.layers){
    if(projected(layer)){
      if(reproject.includes(layer.id))delete layer.surfaceBinding;
      pin(layer);
    }else delete layer.surfaceBinding;
    for(const stroke of [...(layer.strokes||[]),...(layer.maskStrokes||[])]){
      if(isStrokeBlock(stroke)){
        for(const key of stroke.bindings??[])used.add(key);
      }else if(spatialStroke(stroke))pin(stroke);
    }
  }
  if(used.size)paint.surfaceBindings=Object.fromEntries([...used].map(key=>[key,bindings[key]]));
  else delete paint.surfaceBindings;
  validateSurfaceBindings(paint);
}

// The live 'original' key is reusable on the next GLB. Give old projections
// a permanent key before switching source, including stamps in compact blocks.
export function freezeOriginalBinding(paint,sha){
  if(!Object.hasOwn(paint.surfaceBindings||{},original))return;
  const move=item=>{if(item.surfaceBinding===original)item.surfaceBinding=sha;return item;};
  for(const factors of Object.values(paint.sourceMaterials||{}))if(factors.mark)move(factors.mark);
  for(const layer of paint.layers){
    move(layer);
    for(const field of ['strokes','maskStrokes'])if(layer[field])layer[field]=layer[field].map(item=>{
      if(!isStrokeBlock(item)||!item.bindings?.includes(original))return move(item);
      const unpacked=unpackStrokeBlock(item,{mask:field==='maskStrokes',spatial:true});
      return {...encodeStrokeBlock(unpacked.map(move)),...(item.inverted?{inverted:true}:{})};
    });
  }
  delete paint.surfaceBindings.original;
  paint.surfaceBindings[sha]=null;
}
