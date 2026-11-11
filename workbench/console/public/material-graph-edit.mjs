import {compileNodeGraph as compileMaterialGraph,nodeTypes,brushNodeTypes,makeGraphNode,resolveGraphSockets} from './material-graph.mjs';

export const materialClipboardPrefix='arachne-material-nodes/v1\n';
const copy=value=>structuredClone(value);
const validId=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);

export function connectMaterialPorts(graph,from,to,assets={}){
  return editMaterialLinks(graph,[],[{from,to}],assets);
}

export const materialLinkKey=link=>JSON.stringify([link.from.node,link.from.port,link.to.node,link.to.port]);
export function editMaterialLinks(graph,remove=[],add=[],assets={}){
  const next=copy(graph);
  const removed=new Set(remove.map(materialLinkKey)),targets=new Set(add.map(link=>JSON.stringify([link.to.node,link.to.port])));
  next.links=next.links.filter(link=>!removed.has(materialLinkKey(link))&&!targets.has(JSON.stringify([link.to.node,link.to.port])));
  next.links.push(...copy(add));
  compileMaterialGraph(next,assets);
  const original=new Set(graph.links.map(materialLinkKey));
  if(next.links.length===graph.links.length&&next.links.every(link=>original.has(materialLinkKey(link))))return copy(graph);
  return next;
}

export function copyMaterialNodes(graph,selection){
  const ids=new Set(selection);
  const nodes=graph.nodes.filter(node=>ids.has(node.id)&&node.type!=='output');
  const picked=new Set(nodes.map(node=>node.id));
  return {version:1,nodes:copy(nodes),links:copy(graph.links.filter(link=>picked.has(link.from.node)&&picked.has(link.to.node)))};
}

export function parseMaterialClipboard(text){
  if(typeof text!=='string'||text.length>128*1024||!text.startsWith(materialClipboardPrefix))throw Error('剪贴板中没有阿拉克涅材质节点');
  const data=JSON.parse(text.slice(materialClipboardPrefix.length));
  if(data?.version!==1||!Array.isArray(data.nodes)||!data.nodes.length||data.nodes.length>47||!Array.isArray(data.links)||data.links.length>128||
     data.nodes.some(node=>!validId(node?.id)||!Object.hasOwn({...nodeTypes,...brushNodeTypes},node.type)||node.type==='output')||new Set(data.nodes.map(node=>node.id)).size!==data.nodes.length)
    throw Error('剪贴板中的材质节点格式无效');
  return data;
}

export function pasteMaterialNodes(graph,fragment,assets={},position=null,id=()=>crypto.randomUUID()){
  const next=copy(graph),ids=new Map(fragment.nodes.map(node=>[node.id,id()]));
  const left=Math.min(...fragment.nodes.map(node=>node.x)),top=Math.min(...fragment.nodes.map(node=>node.y));
  const offset=position?{x:position.x-left,y:position.y-top}:{x:32,y:32};
  for(const node of fragment.nodes)next.nodes.push({...copy(node),id:ids.get(node.id),x:node.x+offset.x,y:node.y+offset.y});
  for(const link of fragment.links){
    if(!ids.has(link.from?.node)||!ids.has(link.to?.node))throw Error('节点副本包含外部连线');
    next.links.push({from:{node:ids.get(link.from.node),port:link.from.port},to:{node:ids.get(link.to.node),port:link.to.port}});
  }
  compileMaterialGraph(next,assets);
  return {graph:next,selection:[...ids.values()]};
}

export function duplicateMaterialNodes(graph,selection,assets={},id){
  const fragment=copyMaterialNodes(graph,selection);
  if(!fragment.nodes.length)throw Error('请选择可复制的节点');
  const result=pasteMaterialNodes(graph,fragment,assets,null,id);
  // Keep incoming dependencies while leaving the original consumers untouched.
  const mapping=new Map(fragment.nodes.map((node,index)=>[node.id,result.selection[index]]));
  for(const link of graph.links)if(mapping.has(link.to.node)&&!mapping.has(link.from.node))
    result.graph.links.push({from:copy(link.from),to:{node:mapping.get(link.to.node),port:link.to.port}});
  compileMaterialGraph(result.graph,assets);
  return result;
}

export function removeMaterialNodes(graph,selection,assets={}){
  const ids=new Set(selection),next=copy(graph);
  if(graph.nodes.some(node=>ids.has(node.id)&&node.type==='output'))throw Error('材质输出不能删除');
  next.nodes=next.nodes.filter(node=>!ids.has(node.id));
  next.links=next.links.filter(link=>!ids.has(link.from.node)&&!ids.has(link.to.node));
  compileMaterialGraph(next,assets);
  return next;
}

export function vacantMaterialPosition(nodes,point,sizes={}){
  const overlaps=p=>nodes.some(node=>p.x<node.x+224+24&&p.x+224+24>node.x&&p.y<node.y+(sizes[node.id]||240)+24&&p.y+240+24>node.y);
  const snap=n=>Math.round(n/20)*20;
  const anchor={x:snap(point.x),y:snap(point.y)};
  if(!overlaps(anchor))return anchor;
  for(let ring=1;ring<50;ring++)for(let side=0;side<4;side++)for(let step=-ring;step<=ring;step++){
    const candidate={x:anchor.x+(side<2?step:(side===2?-ring:ring))*260,y:anchor.y+(side<2?(side===0?ring:-ring):step)*280};
    if(Math.abs(candidate.x)<9500&&Math.abs(candidate.y)<9500&&!overlaps(candidate))return candidate;
  }
  throw Error('节点画布没有可放置空间');
}

export function insertMaterialNode(graph,nodeId,link,assets={}){
  const node=graph.nodes.find(n=>n.id===nodeId),spec=resolveGraphSockets(graph).get(nodeId);
  if(!node||!spec||link.from.node===nodeId||link.to.node===nodeId||!graph.links.some(l=>materialLinkKey(l)===materialLinkKey(link)))throw Error('节点不能插入此连线');
  for(const input of Object.keys(spec.inputs)){
    if(graph.links.some(l=>l.to.node===nodeId&&l.to.port===input))continue;
    for(const output of Object.keys(spec.outputs))try{
      return editMaterialLinks(graph,[link],[{from:link.from,to:{node:nodeId,port:input}},{from:{node:nodeId,port:output},to:link.to}],assets);
    }catch{}
  }
  throw Error('没有兼容且空闲的插口，无法自动插入');
}

export function rerouteMaterialLinks(graph,crossings,assets={},id=()=>crypto.randomUUID()){
  let next=copy(graph);
  for(const {key,point} of crossings){
    const link=next.links.find(l=>materialLinkKey(l)===key);if(!link)throw Error('待重定向连线已变化');
    const node=makeGraphNode(next,'reroute',point.x-10,point.y-10,id());next.nodes.push(node);
    next=insertMaterialNode(next,node.id,link,assets);
  }
  return next;
}
