import {paintChannels,legacyChannels,channelSpecs,channelDefaults} from './paint-channels.mjs';
// Data-only, typed PBR graph. Shared by browser, command validation and workers.
const scalar={value:'scalar'}, color={color:'color'};
export const nodeTypes={
  reroute:{name:'重定向',inputs:{input:'any'},outputs:{output:'any'},defaults:{}},
  paint:{name:'涂装结果',inputs:{},outputs:Object.fromEntries(paintChannels.map(k=>[k,channelSpecs[k].type==='color'?'color':'scalar'])),defaults:{}},
  color:{name:'颜色',inputs:{},outputs:color,defaults:{color:'#808080'}},
  value:{name:'数值',inputs:{},outputs:scalar,defaults:{value:.5}},
  uv:{name:'UV 坐标',inputs:{},outputs:{uv:'vector'},defaults:{}},
  mapping:{name:'映射',inputs:{uv:'vector'},outputs:{uv:'vector'},defaults:{x:0,y:0,scale:1,rotation:0}},
  image:{name:'图像纹理',inputs:{uv:'vector'},outputs:{color:'color',alpha:'scalar',value:'scalar'},defaults:{asset:'',colorSpace:'srgb'}},
  mix:{name:'混合颜色',inputs:{a:'color',b:'color',factor:'scalar'},outputs:color,defaults:{a:'#000000',b:'#ffffff',factor:.5}},
  math:{name:'数学',inputs:{a:'scalar',b:'scalar'},outputs:scalar,defaults:{operation:'multiply',a:1,b:.5}},
  ramp:{name:'颜色渐变',inputs:scalar,outputs:color,defaults:{low:'#000000',high:'#ffffff',value:.5}},
  pbr:{name:'基础 PBR',inputs:Object.fromEntries(paintChannels.map(k=>[k,channelSpecs[k].type==='color'?'color':'scalar'])),outputs:{surface:'surface'},defaults:{...channelDefaults,color:'#808080',roughness:.5}},
  output:{name:'材质输出',inputs:{surface:'surface'},outputs:{},defaults:{}}
};
export const portNames={input:'输入',output:'输出',...Object.fromEntries(paintChannels.map(k=>[k,channelSpecs[k].name])),color:'颜色',metallic:'金属度',roughness:'粗糙度',value:'数值',uv:'UV',a:'A',b:'B',factor:'系数',alpha:'透明度',surface:'表面'};
export function makeNode(type,x=40,y=40,id=globalThis.crypto.randomUUID()){
  if(!Object.hasOwn(nodeTypes,type))throw Error('不支持的材质节点');
  return {id,type,x,y,params:{...nodeTypes[type].defaults}};
}
export function defaultMaterialGraph(){
  const nodes=[makeNode('paint',40,90,'paint'),makeNode('pbr',360,60,'pbr'),makeNode('output',680,80,'output')];
  return {version:1,material:'f_16xl',nodes,links:[...paintChannels.map(port=>({from:{node:'paint',port},to:{node:'pbr',port}})),{from:{node:'pbr',port:'surface'},to:{node:'output',port:'surface'}}]};
}
const record=o=>o&&typeof o==='object'&&!Array.isArray(o);
const exact=(o,keys)=>record(o)&&Object.keys(o).every(k=>keys.includes(k));
const hex=s=>typeof s==='string'&&/^#[a-f\d]{6}$/i.test(s);
const number=n=>Number.isFinite(n)&&Math.abs(n)<=10000;
export function compileMaterialGraph(graph,assets={}){return compileGraph(graph,assets,nodeTypes,'f_16xl');}
export function compileBrushGraph(graph){return compileGraph(graph,{},brushNodeTypes,'brush');}
function compileGraph(graph,assets,nodeTypes,domain){
  if(graph==null)return null;
  if(!exact(graph,['version','material','nodes','links'])||graph.version!==1||graph.material!==domain||
     !Array.isArray(graph.nodes)||graph.nodes.length<2||graph.nodes.length>48||!Array.isArray(graph.links)||graph.links.length>128)
    throw Error('节点材质格式无效（最多 48 个节点）');
  const nodes=new Map();
  for(const node of graph.nodes){
    const spec=Object.hasOwn(nodeTypes,node?.type)?nodeTypes[node.type]:null;
    if(!exact(node,['id','type','x','y','params'])||!spec||typeof node.id!=='string'||! /^[\w-]{1,100}$/.test(node.id)||nodes.has(node.id)||!number(node.x)||!number(node.y)||!exact(node.params,Object.keys(spec.defaults))||Object.keys(spec.defaults).some(key=>key!=='colorSpace'&&!(node.type==='pbr'&&paintChannels.includes(key)&&!legacyChannels.includes(key))&&!Object.hasOwn(node.params,key)))
      throw Error('节点编号或参数无效');
    for(const [key,value] of Object.entries(node.params)){
      if(key==='asset'){
        if(value!==''&&(!/^[a-f\d]{64}$/.test(value)||!Object.hasOwn(assets,value)))throw Error('节点图像素材不存在');
      }else if(key==='colorSpace'){
        if(!['srgb','linear'].includes(value))throw Error('图像颜色空间无效');
      }else if(key==='operation'){
        if(!['add','subtract','multiply','divide','minimum','maximum'].includes(value))throw Error('数学运算无效');
      }else if(domain==='brush'&&node.type==='brush'&&['worldRadius','uvRadius','hardness','opacity'].includes(key)){
        const [min,max]={worldRadius:[.02,.65],uvRadius:[2,256],hardness:[0,1],opacity:[0,1]}[key];
        if(!Number.isFinite(value)||value<min||value>max)throw Error('笔刷参数超出范围');
      }else if(typeof spec.defaults[key]==='boolean'){
        if(typeof value!=='boolean')throw Error('笔刷开关无效');
      }else if(typeof spec.defaults[key]==='string'){
        if(!hex(value))throw Error('节点颜色无效');
      }else if(!number(value)||(['factor','metallic','roughness','height','alpha','ao'].includes(key)&&(value<0||value>1))||key==='scale'&&Math.abs(value)<.001)
        throw Error('节点数值无效');
    }
    nodes.set(node.id,node);
  }
  const outputs=graph.nodes.filter(n=>n.type==='output');
  if(outputs.length!==1)throw Error(domain==='brush'?'节点笔刷需要一个笔刷输出':'节点材质需要一个材质输出');
  const specs=resolveGraphSockets(graph);
  const incoming=new Map(graph.nodes.map(n=>[n.id,{}]));
  for(const link of graph.links){
    if(!exact(link,['from','to'])||![link.from,link.to].every(p=>exact(p,['node','port'])))throw Error('节点连线无效');
    const source=nodes.get(link.from.node),target=nodes.get(link.to.node);
    const from=source&&Object.hasOwn(specs.get(source.id).outputs,link.from.port)&&specs.get(source.id).outputs[link.from.port],to=target&&Object.hasOwn(specs.get(target.id).inputs,link.to.port)&&specs.get(target.id).inputs[link.to.port];
    if(!from||!to||from!==to||incoming.get(target.id)[link.to.port])throw Error('节点插口类型不匹配或输入重复');
    incoming.get(target.id)[link.to.port]={...link.from};
  }
  // Check even disconnected nodes. No hidden cyclic subgraphs in saved projects.
  const order=[],visited=new Set(),active=new Set();
  function visit(id){
    if(active.has(id))throw Error('节点连线形成循环');
    if(visited.has(id))return;
    active.add(id);for(const p of Object.values(incoming.get(id)))visit(p.node);
    active.delete(id);visited.add(id);order.push(id);
  }
  for(const id of nodes.keys())visit(id);
  if(!incoming.get(outputs[0].id)[domain==='brush'?'brush':'surface'])throw Error(domain==='brush'?'笔刷输出需要连接笔刷参数':'材质输出需要连接基础 PBR');
  for(const node of nodes.values())if(node.type==='reroute'&&['surface','brush'].includes(specs.get(node.id).outputs.output)&&!incoming.get(node.id).input)throw Error('表面或笔刷重定向需要连接来源');
  const reachable=new Set();
  function reach(id){if(reachable.has(id))return;reachable.add(id);for(const p of Object.values(incoming.get(id)))reach(p.node);}
  reach(outputs[0].id);
  const images=new Set(order.filter(id=>reachable.has(id)&&nodes.get(id).type==='image').map(id=>nodes.get(id).params.asset).filter(Boolean));
  if([...images].reduce((sum,id)=>sum+(assets[id]?.width||0)*(assets[id]?.height||0),0)>32*1024*1024)throw Error('节点图像总像素超过 32 Mi 像素，请缩小素材或减少图像节点');
  return {version:1,output:outputs[0].id,nodes:order.filter(id=>reachable.has(id)).map(id=>({id,type:nodes.get(id).type,params:nodes.get(id).type==='reroute'?{dataType:specs.get(id).outputs.output==='any'?'scalar':specs.get(id).outputs.output}:canonicalParams(nodes.get(id)),inputs:incoming.get(id)}))};
}

function canonicalParams(node){
  const params={...node.params};
  // Omit the compatible default so existing preview fingerprints remain valid.
  if(node.type==='image'&&params.colorSpace==='srgb')delete params.colorSpace;
  if(node.type==='pbr')for(const k of paintChannels.slice(3))if(params[k]===channelDefaults[k])delete params[k];
  return params;
}

export const brushNodeTypes={
  reroute:nodeTypes.reroute,
  value:nodeTypes.value,math:nodeTypes.math,
  brush:{name:'笔刷参数',inputs:{worldRadius:'scalar',uvRadius:'scalar',hardness:'scalar',opacity:'scalar'},outputs:{brush:'brush'},
    defaults:{worldRadius:.14,uvRadius:32,hardness:1,opacity:1,pressure:true,mirror:false}},
  output:{name:'笔刷输出',inputs:{brush:'brush'},outputs:{},defaults:{}}
};
export function graphNodeTypes(graph){return graph?.material==='brush'?brushNodeTypes:nodeTypes;}
export function compileNodeGraph(graph,assets={}){return graph?.material==='brush'?compileBrushGraph(graph):compileMaterialGraph(graph,assets);}
export function makeGraphNode(graph,type,x=40,y=40,id=globalThis.crypto.randomUUID()){
  const spec=graphNodeTypes(graph)[type];if(!spec)throw Error('不支持的节点');return {id,type,x,y,params:{...spec.defaults}};
}

// Reroutes unify their two sockets and every adjacent reroute, without conversions.
export function resolveGraphSockets(graph){
  const types=graphNodeTypes(graph),nodes=new Map(graph.nodes.map(n=>[n.id,n])),parents=new Map(),bound=new Map();
  for(const node of graph.nodes)if(node.type==='reroute')parents.set(node.id,node.id);
  function root(id){const p=parents.get(id);if(p!==id)parents.set(id,root(p));return parents.get(id);}
  for(const link of graph.links){const a=nodes.get(link.from?.node),b=nodes.get(link.to?.node);if(a?.type==='reroute'&&b?.type==='reroute')parents.set(root(a.id),root(b.id));}
  function bind(id,type){if(!type||type==='any')return;const r=root(id),previous=bound.get(r);if(previous&&previous!==type)throw Error('节点插口类型不匹配');bound.set(r,type);}
  for(const link of graph.links){const a=nodes.get(link.from?.node),b=nodes.get(link.to?.node);if(a?.type==='reroute')bind(a.id,types[b?.type]?.inputs[link.to.port]);if(b?.type==='reroute')bind(b.id,types[a?.type]?.outputs[link.from.port]);}
  return new Map(graph.nodes.map(n=>[n.id,n.type==='reroute'?{...types.reroute,inputs:{input:bound.get(root(n.id))||'any'},outputs:{output:bound.get(root(n.id))||'any'}}:types[n.type]]));
}
