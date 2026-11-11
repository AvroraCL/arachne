import {nodeTypes,brushNodeTypes,makeNode,compileMaterialGraph,compileBrushGraph} from './material-graph.mjs';

export const libraryKinds=['materials','brushes'];
export function defaultLibraryMaterial(values={color:'#808080',metallic:0,roughness:.5}){
  const pbr=makeNode('pbr',40,40,'pbr');pbr.params={...pbr.params,...values};
  return {version:1,material:'f_16xl',nodes:[pbr,makeNode('output',370,80,'output')],links:[{from:{node:'pbr',port:'surface'},to:{node:'output',port:'surface'}}]};
}
export function defaultBrushGraph(settings={}){
  return {version:1,material:'brush',nodes:[{id:'brush',type:'brush',x:40,y:40,params:{...brushNodeTypes.brush.defaults,...settings}},
    {id:'output',type:'output',x:370,y:80,params:{}}],links:[{from:{node:'brush',port:'brush'},to:{node:'output',port:'brush'}}]};
}
export function compileLibraryMaterial(graph,assets){
  const plan=compileMaterialGraph(graph,assets);
  if(!plan||graph.nodes.some(node=>node.type==='paint'))throw Error('库材质不能引用整份涂装结果');
  return plan;
}
export function evaluateBrushGraph(graph){
  const plan=compileBrushGraph(graph);if(!plan)throw Error('笔刷需要节点图');
  const values=new Map();
  for(const node of plan.nodes){
    const p=node.params,get=key=>{const link=node.inputs[key];return link?values.get(link.node)[link.port]:p[key];};
    if(node.type==='reroute')values.set(node.id,{output:get('input')??0});
    if(node.type==='value')values.set(node.id,{value:p.value});
    if(node.type==='math'){
      const a=get('a'),b=get('b');
      values.set(node.id,{value:{add:()=>a+b,subtract:()=>a-b,multiply:()=>a*b,divide:()=>Math.abs(b)>1e-12?a/b:0,minimum:()=>Math.min(a,b),maximum:()=>Math.max(a,b)}[p.operation]()});
    }
    if(node.type==='brush')values.set(node.id,{brush:Object.fromEntries(Object.keys(p).map(key=>[key,get(key)]))});
    if(node.type==='output'){
      const settings=get('brush');
      for(const [key,min,max] of [['worldRadius',.02,.65],['uvRadius',2,256],['hardness',0,1],['opacity',0,1]])
        if(!Number.isFinite(settings[key])||settings[key]<min||settings[key]>max)throw Error('笔刷 '+key+' 超出范围 '+min+'–'+max);
      return settings;
    }
  }
  throw Error('笔刷缺少输出');
}
const record=o=>o&&typeof o==='object'&&!Array.isArray(o);
export function validateLibraries(paint){
  for(const kind of libraryKinds){
    const entries=paint[kind]??{};
    if(!record(entries)||Object.keys(entries).length>64)throw Error('每个资源库最多 64 项');
    for(const [id,item] of Object.entries(entries)){
      if(!/^[\w-]{1,100}$/.test(id)||!record(item)||Object.keys(item).some(k=>!['name','graph'].includes(k))||
         typeof item.name!=='string'||!item.name.trim()||item.name.length>100)throw Error('资源编号或名称无效');
      if(kind==='materials')compileLibraryMaterial(item.graph,paint.assets);else evaluateBrushGraph(item.graph);
    }
  }
}
export function libraryOperation(paint,o){
  const {library,id,action,patch}=o;
  if(!libraryKinds.includes(library)||typeof id!=='string'||!/^[\w-]{1,100}$/.test(id)||
    Object.keys(o).some(k=>!['op','library','id','action','patch'].includes(k)))throw Error('资源命令无效');
  const entries=paint[library]??={},current=Object.hasOwn(entries,id)?entries[id]:null;
  if(action==='remove'){
    if(!current)throw Error('资源不存在');
    if(library==='materials'&&paint.layers.some(layer=>layer.materialId===id))throw Error('材质仍被填充层引用，请先解除引用');
    delete entries[id];return;
  }
  if(!['create','update'].includes(action)||!record(patch)||Object.keys(patch).some(k=>!['name','graph'].includes(k))||
     (action==='create'?!!current:!current))throw Error('资源已存在或不存在');
  const item={...current,...structuredClone(patch)};
  // Object spread avoids special property setters; maps never use inherited entries.
  paint[library]={...entries,[id]:item};
  validateLibraries(paint);
}
export function libraryNodeTypes(target){return target==='brushes'?brushNodeTypes:Object.fromEntries(Object.entries(nodeTypes).filter(([type])=>type!=='paint'));}
