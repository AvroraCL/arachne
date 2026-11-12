import {channelSpecs,paintChannels} from './paint-channels.mjs';
import {makeNode} from './material-graph.mjs';
import {compileLibraryMaterial,defaultLibraryMaterial} from './paint-library.mjs';

const suffixes={
  color:['base color','basecolor','albedo','diffuse','color','颜色','基础色'],
  metallic:['metallic','metalness','metal','金属度'],
  roughness:['roughness','rough','粗糙度'],
  normal:['normal opengl','normal gl','normalgl','normal','nrm','法线'],
  height:['height','displacement','disp','高度'],
  emission:['emissive','emission','发光','自发光'],
  alpha:['opacity','alpha','透明度','不透明度'],
  ao:['ambient occlusion','ambientocclusion','occlusion','ao','环境遮蔽']
};
const separator=/[\s._-]+/g;

export function groupMaterialMaps(assets,aliases=[]){
  const groups=new Map(),sources=[...Object.entries(assets),...aliases.map(({id,name})=>[id,{name}])];
  for(const [id,asset] of sources){
    const stem=asset.name.normalize('NFKC').replace(/\.[^.]+$/,'').replace(separator,' ').trim()
      .replace(/\s(?:\d+k|\d{3,4}|\d+bit)$/i,'');
    const lower=stem.toLowerCase();
    for(const channel of paintChannels){
      const suffix=suffixes[channel].find(term=>lower===term||lower.endsWith(' '+term));
      if(!suffix)continue;
      const name=stem.slice(0,-suffix.length).trim()||'未命名贴图组',key=name.toLowerCase();
      let group=groups.get(key);
      if(!group){group={key,name,maps:{},names:{}};groups.set(key,group);}
      // A repeated channel needs a manual choice.
      if(!Object.hasOwn(group.maps,channel))group.maps[channel]=id;
      else if(group.maps[channel]!==id)group.maps[channel]=null;
      if(group.maps[channel]===id)group.names[channel]=asset.name;
      break;
    }
  }
  return [...groups.values()].filter(group=>Object.values(group.maps).some(Boolean))
    .sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
}

export function mappedLibraryMaterial(maps,assets,{alphaOutput='value'}={}){
  const entries=paintChannels.filter(channel=>maps[channel]);
  if(!entries.length)throw Error('请至少选择一张贴图');
  if(!['value','alpha'].includes(alphaOutput))throw Error('不透明度来源无效');
  const graph=defaultLibraryMaterial(),[pbr,output]=graph.nodes,center=(entries.length-1)*76;
  Object.assign(pbr,{x:304,y:center});Object.assign(output,{x:610,y:center+24});
  entries.forEach((channel,i)=>{
    const asset=maps[channel],spec=channelSpecs[channel];
    if(!Object.hasOwn(assets,asset))throw Error(spec.name+'贴图已不存在');
    const node=makeNode('image',0,i*152,'map-'+channel);
    node.params={asset,colorSpace:spec.srgb?'srgb':'linear'};
    graph.nodes.push(node);
    const port=spec.type==='color'?'color':channel==='alpha'?alphaOutput:'value';
    graph.links.push({from:{node:node.id,port},to:{node:pbr.id,port:channel}});
  });
  compileLibraryMaterial(graph,assets);
  return graph;
}
