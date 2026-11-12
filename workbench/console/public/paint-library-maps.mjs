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
const packedSuffixes={unreal:['orm'],unity:['hdrp mask map','hdrp maskmap','mask map','maskmap']};
export const packedMaterialLayouts={
  unreal:{label:'Unreal · ORM',description:'R 环境遮蔽 · G 粗糙度 · B 金属度',
    channels:{ao:'red',roughness:'green',metallic:'blue'}},
  unity:{label:'Unity · HDRP',description:'R 金属度 · G 环境遮蔽 · A 反相为粗糙度',
    channels:{metallic:'red',ao:'green',roughness:'smoothness'}}
};

export function groupMaterialMaps(assets,aliases=[]){
  const groups=new Map(),sources=[...Object.entries(assets),...aliases.map(({id,name})=>[id,{name}])];
  function groupFor(stem,suffix){
    const name=stem.slice(0,-suffix.length).trim()||'未命名贴图组',key=name.toLowerCase();
    if(!groups.has(key))groups.set(key,{key,name,maps:{},names:{}});
    return groups.get(key);
  }
  for(const [id,asset] of sources){
    const stem=asset.name.normalize('NFKC').replace(/\.[^.]+$/,'').replace(separator,' ').trim()
      .replace(/\s(?:\d+k|\d{3,4}|\d+bit)$/i,'');
    const lower=stem.toLowerCase();
    const format=Object.keys(packedSuffixes).find(key=>packedSuffixes[key].some(term=>lower===term||lower.endsWith(' '+term)));
    if(format){
      const suffix=packedSuffixes[format].find(term=>lower===term||lower.endsWith(' '+term));
      const group=groupFor(stem,suffix);
      const packed=group.packed??={};
      if(!Object.hasOwn(packed,format))packed[format]=id;
      else if(packed[format]!==id)packed[format]=null;
      continue;
    }
    for(const channel of paintChannels){
      const suffix=suffixes[channel].find(term=>lower===term||lower.endsWith(' '+term));
      if(!suffix)continue;
      const group=groupFor(stem,suffix);
      // A repeated channel needs a manual choice.
      if(!Object.hasOwn(group.maps,channel))group.maps[channel]=id;
      else if(group.maps[channel]!==id)group.maps[channel]=null;
      if(group.maps[channel]===id)group.names[channel]=asset.name;
      break;
    }
  }
  return [...groups.values()].filter(group=>Object.values(group.maps).some(Boolean)||Object.values(group.packed??{}).some(Boolean))
    .sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
}

export function mappedLibraryMaterial(maps,assets,{alphaOutput='value',packed=null,normalFormat='opengl'}={}){
  const entries=paintChannels.filter(channel=>maps[channel]);
  const layout=packed&&Object.hasOwn(packedMaterialLayouts,packed.format)?packedMaterialLayouts[packed.format]:null;
  if(packed&&(!layout||!Object.hasOwn(assets,packed.asset)))throw Error('请选择有效的打包贴图');
  if(!entries.length&&!packed)throw Error('请至少选择一张贴图');
  if(!['value','alpha'].includes(alphaOutput))throw Error('不透明度来源无效');
  if(!['opengl','directx'].includes(normalFormat))throw Error('法线方向无效');
  const graph=defaultLibraryMaterial(),[pbr,output]=graph.nodes;
  const add=(type,x,y,id,params)=>{
    const node=makeNode(type,x,y,id);
    Object.assign(node.params,params);
    graph.nodes.push(node);
    return node.id;
  };
  const link=(node,port,target,input)=>graph.links.push({from:{node,port},to:{node:target,port:input}});
  const normalConversion=entries.includes('normal')&&normalFormat==='directx';
  const rows=entries.filter(channel=>!layout?.channels[channel]);
  const pbrX=normalConversion?1040:packed?800:304;
  const center=Math.max(0,(rows.length-1)*96+(packed?128:0)+(normalConversion?80:0));
  Object.assign(pbr,{x:pbrX,y:center});Object.assign(output,{x:pbrX+306,y:center+24});
  let y=0;
  for(const channel of rows){
    const asset=maps[channel],spec=channelSpecs[channel];
    if(!Object.hasOwn(assets,asset))throw Error(spec.name+'贴图已不存在');
    const image=add('image',0,y,'map-'+channel,{asset,colorSpace:spec.srgb?'srgb':'linear'});
    const port=spec.type==='color'?'color':channel==='alpha'?alphaOutput:'value';
    if(channel==='normal'&&normalConversion){
      const split=add('separateColor',250,y,'normal-separate');
      const flip=add('math',500,y+96,'normal-green-invert',{operation:'subtract',a:1,b:0});
      const combine=add('combineColor',750,y,'normal-combine');
      link(image,'color',split,'color');
      link(split,'green',flip,'b');
      link(split,'red',combine,'red');link(flip,'value',combine,'green');link(split,'blue',combine,'blue');
      link(combine,'color',pbr.id,channel);
      y+=112;
    }else link(image,port,pbr.id,channel);
    y+=192;
  }
  if(packed){
    const image=add('image',0,y,'map-packed',{asset:packed.asset,colorSpace:'linear'});
    const split=add('separateColor',250,y,'packed-separate');
    link(image,'color',split,'color');
    for(const [channel,port] of Object.entries(layout.channels)){
      if(port==='smoothness'){
        const invert=add('math',500,y+132,'packed-smoothness-invert',{operation:'subtract',a:1,b:0});
        link(image,'alpha',invert,'b');link(invert,'value',pbr.id,channel);
      }else link(split,port,pbr.id,channel);
    }
  }
  compileLibraryMaterial(graph,assets);
  return graph;
}
