import {hasImageStyle} from './image-text-style.mjs';
import {fullBlendRange} from './image-documents.mjs';
import {followingClips,imageGroupBlend,imageStackBase} from './image-layer-tree.mjs';
import {layerChildren,layerLockOwner,layerParent,layerTreeOrder} from './paint-layer-tree.mjs';

export const imageCombineLabels={
  rasterize:'栅格化图层',mergeDown:'向下合并',mergeSelected:'合并所选图层',stampVisible:'盖印可见图层'
};

function backdropDependent(layer,layers){
  if(!layer.visible||!layer.opacity||layer.clipped)return false;
  if(layer.blend===imageGroupBlend&&!hasImageStyle(layer))return layerChildren(layers,layer.id).some(child=>backdropDependent(child,layers));
  return layer.kind==='adjustment'||!['normal',imageGroupBlend].includes(layer.blend)||layer.blendIf?.backdrop.some((n,i)=>n!==fullBlendRange[i]);
}

export function planImageCombine(layers,action,layerIds){
  if(action==='stampVisible'){
    if(!layers.some(layer=>layer.visible&&layer.opacity&&layerParent(layer)===null))
      throw Error('请先显示要盖印的图层');
    return {render:layers,remove:[],name:'盖印可见图层'};
  }
  const selection=new Set(layerIds);
  const selected=layers.filter(layer=>selection.has(layer.id));
  if(!selected.length||selected.length!==selection.size)throw Error('请选择图层');
  const parent=layerParent(selected[0]),siblings=layerChildren(layers,parent);
  if(selected.some(layer=>layerParent(layer)!==parent))throw Error('请选择同一组内的图层');
  if(action==='mergeDown'){
    const below=siblings[siblings.indexOf(selected[0])-1];
    if(selected.length!==1||!below)throw Error('下方没有可合并的图层');
    selection.add(below.id);
  }else if(action!=='mergeSelected')throw Error('图层合并方式无效');
  if(selection.size<2)throw Error('请至少选择两个图层');

  const roots=siblings.filter(layer=>selection.has(layer.id));
  const bottom=siblings.indexOf(roots[0]),top=siblings.indexOf(roots.at(-1));
  const base=roots[0],clips=followingClips(layers,base);
  const visible=layer=>layer.visible&&layer.opacity;
  const detached=layer=>{
    const root={...layer};
    delete root.parentId;
    return root;
  };
  if(!base.clipped&&roots.slice(1).every((layer,i)=>layer===clips[i])){
    if(roots.some(layer=>layerLockOwner(layers,layer)))
      throw Object.assign(Error('所选图层或组中有锁定的图层'),{status:423});
    // Bake just the selected prefix of the clipping stack.
    const source={...detached(base),visible:true,opacity:1,blend:'normal'};
    delete source.blendIf;
    return {render:[source,...roots.slice(1).map(detached)],remove:roots.map(layer=>layer.id),bottom:base.id,name:base.name,parent,
      appearance:{visible:base.visible,opacity:base.opacity,blend:base.blend,...(base.blendIf?{blendIf:base.blendIf}:{})}};
  }

  // A clipping stack acts as a single composited layer.
  for(const sibling of siblings){
    if(!selection.has(sibling.id))continue;
    const root=sibling.clipped?imageStackBase(layers,layers.indexOf(sibling)):sibling;
    if(!root||!selection.has(root.id)||followingClips(layers,root).some(clip=>!selection.has(clip.id)))
      throw Error('请一并选择底层和整组剪贴蒙版');
  }
  if(siblings.slice(bottom,top+1).some(layer=>!selection.has(layer.id)&&visible(layer)))
    throw Error('所选图层之间还有可见图层。请一并选择，或隐藏中间图层后再合并');
  const all=roots.flatMap(layer=>[layer,...(layer.kind==='group'?layerTreeOrder(layers,layer.id):[])]);
  if(all.some(layer=>layerLockOwner(layers,layer)))
    throw Object.assign(Error('所选图层或组中有锁定的图层'),{status:423});
  const group=layers.find(layer=>layer.id===parent);
  if(siblings.slice(0,bottom).some(visible)||group?.blend===imageGroupBlend){
    // Without the lower stack, an adjustment or blend mode cannot be baked
    // to a standalone source-over layer. Isolated groups have their own base.
    if(roots.some(layer=>backdropDependent(layer,layers)))
      throw Error('这些图层依赖下方的颜色。请从底层一起合并，或使用盖印可见图层');
  }
  const rootIds=new Set(roots.map(layer=>layer.id));
  return {
    render:all.map(layer=>rootIds.has(layer.id)?detached(layer):layer),
    remove:all.map(layer=>layer.id),bottom:roots[0].id,
    name:roots[0].name,parent
  };
}
