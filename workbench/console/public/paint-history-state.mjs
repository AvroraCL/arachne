const json=value=>JSON.stringify(value??null);
const count=(layers,key)=>layers.reduce((total,layer)=>total+(layer[key]?.length||0),0);
function content(doc){const next=structuredClone(doc);delete next.revision;delete next.updated;return next;}

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
  if(json(a.imageDocuments)!==json(b.imageDocuments))labels.push('图像文档编辑');
  if(right.length!==left.length)labels.push(right.length>left.length?'新建图层':'删除图层');
  if(count(left,'strokes')!==count(right,'strokes'))labels.push('绘制记录');
  if(count(left,'maskStrokes')!==count(right,'maskStrokes'))labels.push('蒙版绘制');
  if(json(a.base)!==json(b.base))labels.push('底层材质');
  if(!labels.length&&json(left)!==json(right))labels.push('图层属性或顺序');
  const layerCount=right.filter(layer=>layer.kind!=='group').length,strokes=count(right,'strokes')+count(right,'maskStrokes'),model=after.modeling?.steps?.length||0;
  return {label:labels.join(' · ')||'工程编辑',detail:[`${layerCount} 个图层`,...(strokes?[`${strokes} 条绘制记录`]:[]),...(model?[`${model} 项模型编辑`]:[]),...(Object.keys(b.imageDocuments??{}).length?[`${Object.keys(b.imageDocuments).length} 个图像文档`]:[])].join(' · ')};
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
