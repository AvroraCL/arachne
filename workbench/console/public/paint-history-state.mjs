import {imageAdjustments} from './image-adjustments.mjs';
import {hasImageLayerMask} from './image-documents.mjs';

const json=value=>JSON.stringify(value??null);
const count=(layers,key)=>layers.reduce((total,layer)=>total+(layer[key]?.length||0),0);
function content(doc){const next=structuredClone(doc);delete next.revision;delete next.updated;return next;}

function imageStrokeLabel(stroke){
  if(stroke.flood)return '油漆桶';
  if(stroke.clone)return '仿制图章';
  if(stroke.transformUV)return '自由变换';
  if(stroke.clearUV)return stroke.cut?'剪切选区':'清除选区';
  if(stroke.rect)return '填充颜色';
  return stroke.erase?'橡皮擦':'画笔';
}

function imageLayerLabel(previous,layer){
  if(!previous){
    if(layer.adjustment)return '新建'+(imageAdjustments[layer.adjustment.type]?.label||'图层')+'调整';
    return {pixel:'新建像素层',image:layer.text?'新建文字层':'置入图片',gradient:'新建渐变层',shape:'绘制形状',group:'新建图层组'}[layer.kind]||'新建图像层';
  }
  if(!layer)return previous.kind==='group'?'删除图层组':'删除图像层';
  if((layer.strokes?.length||0)>(previous.strokes?.length||0))return imageStrokeLabel(layer.strokes.at(-1));
  if(previous.name!==layer.name)return '重命名图层';
  if(previous.visible!==layer.visible)return layer.visible?'显示图层':'隐藏图层';
  if(previous.locked!==layer.locked)return layer.locked?'锁定图层':'解锁图层';
  if(previous.parentId!==layer.parentId)return '移动图层组归属';
  if(previous.alphaLocked!==layer.alphaLocked)return layer.alphaLocked?'锁定透明像素':'解锁透明像素';
  if(previous.clipped!==layer.clipped)return layer.clipped?'创建剪贴蒙版':'释放剪贴蒙版';
  if(hasImageLayerMask(previous)!==hasImageLayerMask(layer))return hasImageLayerMask(layer)?'添加图层蒙版':'删除图层蒙版';
  if(previous.maskEnabled!==layer.maskEnabled)return layer.maskEnabled?'启用图层蒙版':'停用图层蒙版';
  if(json(previous.maskGradient)!==json(layer.maskGradient))return '编辑渐变蒙版';
  if((layer.maskStrokes?.length||0)>(previous.maskStrokes?.length||0))return '绘制蒙版';
  if(previous.maskBase!==layer.maskBase||json(previous.maskStrokes)!==json(layer.maskStrokes))return '编辑图层蒙版';
  if(json(previous.adjustment)!==json(layer.adjustment))return '调整'+(imageAdjustments[layer.adjustment?.type]?.label||'图层');
  if(json(previous.shape)!==json(layer.shape))return '编辑形状';
  if(json(previous.gradient)!==json(layer.gradient))return '编辑渐变';
  if(json(previous.text)!==json(layer.text))return '编辑文字';
  if(previous.blend!==layer.blend)return '更改混合模式';
  if(previous.opacity!==layer.opacity)return '调整不透明度';
  if(['x','y','rotation','scale'].some(key=>previous[key]!==layer[key])||json(previous.stretch)!==json(layer.stretch))return '自由变换';
  return '修改图像层';
}

function imageDocumentChanges(before,after){
  const result=[];
  for(const id of new Set([...Object.keys(after),...Object.keys(before)])){
    const previous=before[id],image=after[id];
    if(!previous||!image){
      result.push({label:previous?'删除贴图':'新建贴图',detail:(image||previous).name});
      continue;
    }
    if(previous.name!==image.name)result.push({label:'重命名贴图',detail:image.name});
    if(previous.colorSpace!==image.colorSpace)result.push({label:'切换图像颜色空间',detail:image.name});
    const prior=new Map(previous.layers.map(layer=>[layer.id,layer])),next=new Map(image.layers.map(layer=>[layer.id,layer]));
    let changed=false;
    for(const layerId of new Set([...next.keys(),...prior.keys()])){
      const a=prior.get(layerId),b=next.get(layerId);
      if(json(a)===json(b))continue;
      changed=true;
      result.push({label:imageLayerLabel(a,b),detail:[image.name,(b||a).name].join(' · ')});
    }
    if(!changed&&[...prior.keys()].some((key,index)=>image.layers[index]?.id!==key))
      result.push({label:'调整图像图层顺序',detail:image.name});
  }
  return result;
}

export function describePaintChange(before,after){
  const a=before.paint||{},b=after.paint||{},left=a.layers||[],right=b.layers||[];
  const labels=[];
  if(json(before.modeling)!==json(after.modeling))labels.push('模型编辑');
  if(json(a.renderPreset)!==json(b.renderPreset))labels.push(b.renderPreset?'保存工程渲染预设':'移除工程渲染预设');
  if(json(a.renderVisibility)!==json(b.renderVisibility))labels.push('调整物体渲染显隐');
  if(json(a.renderOptics)!==json(b.renderOptics))labels.push('调整相机景深');
  if(json(a.renderRegion)!==json(b.renderRegion))labels.push('调整相机渲染区域');
  if(Object.keys(b.assets||{}).length>Object.keys(a.assets||{}).length)labels.push('导入素材');
  if(json(a.materialGraph)!==json(b.materialGraph)){
    const previous=a.materialGraph?.nodes||[],next=b.materialGraph?.nodes||[];
    labels.push(!a.materialGraph?'启用节点材质':!b.materialGraph?'移除节点材质':next.length>previous.length?'添加材质节点':next.length<previous.length?'删除材质节点':json(a.materialGraph.links)!==json(b.materialGraph.links)?'调整节点连线':json(previous.map(({x,y,...n})=>n))===json(next.map(({x,y,...n})=>n))?'移动材质节点':'修改节点参数');
  }
  for(const [key,name] of [['materials','材质库'],['brushes','笔刷库']])if(json(a[key])!==json(b[key]))labels.push(name+'编辑');
  const images=imageDocumentChanges(a.imageDocuments||{},b.imageDocuments||{});
  labels.push(...new Set(images.map(change=>change.label)));
  if(right.length!==left.length)labels.push(right.length>left.length?'新建图层':'删除图层');
  if(count(left,'strokes')!==count(right,'strokes'))labels.push('绘制记录');
  if(count(left,'maskStrokes')!==count(right,'maskStrokes'))labels.push('蒙版绘制');
  if(json(a.base)!==json(b.base))labels.push('底层材质');
  if(!labels.length&&json(left)!==json(right))labels.push('图层属性或顺序');
  const layerCount=right.filter(layer=>layer.kind!=='group').length,strokes=count(right,'strokes')+count(right,'maskStrokes'),model=after.modeling?.steps?.length||0;
  const detail=images.length?[...new Set(images.map(change=>change.detail))].slice(0,2).join('、'):
    [`${layerCount} 个图层`,...(strokes?[`${strokes} 条绘制记录`]:[]),...(model?[`${model} 项模型编辑`]:[]),...(Object.keys(b.imageDocuments??{}).length?[`${Object.keys(b.imageDocuments).length} 个图像文档`]:[])].join(' · ');
  return {label:labels.slice(0,3).join(' · ')||'工程编辑',detail};
}

export function paintHistoryEntries(current,history){
  function entries(direction){
    const states=history[direction].slice(-50).reverse();
    return states.map((state,index)=>({steps:index+1,...(direction==='undo'?describePaintChange(state,index?states[index-1]:current):describePaintChange(index?states[index-1]:current,state))}));
  }
  return {revision:current.revision,undoCount:history.undo.length,redoCount:history.redo.length,undo:entries('undo'),redo:entries('redo')};
}

export function travelPaintHistory(current,history,direction,steps=1){
  if(!['undo','redo'].includes(direction)||!Number.isInteger(steps)||steps<1||steps>50)throw Error('历史操作需要 1–50 个完整步骤');
  const from=history[direction],to=direction==='undo'?'redo':'undo';
  if(!Array.isArray(from)||!Array.isArray(history[to]))throw Error('历史记录格式无效');
  if(!from.length&&steps===1)return {restored:current,history,changed:false};
  if(steps>from.length)throw Error(`当前只能${direction==='undo'?'撤销':'重做'} ${from.length} 步`);
  const start=from.length-steps,restored=content(from[start]);
  if(restored.id!==current.id)throw Error('历史记录不属于当前工程');
  restored.source=structuredClone(current.source);
  const next={undo:[...history.undo],redo:[...history.redo]};
  next[direction]=from.slice(0,start);
  next[to].push(content(current),...from.slice(start+1).reverse());
  return {restored,history:next,changed:true};
}
