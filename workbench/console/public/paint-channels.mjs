// Stable legacy prefix: RGB, metal, rough, diagnostics. V2 appends the other maps.
export const channelSpecs={
  color:{name:'颜色',type:'color',value:'#262a30',offset:0,file:'f_16xl_BaseColor.png',srgb:true},
  metallic:{name:'金属度',type:'scalar',value:0,offset:3,file:'f_16xl_metallic.png'},
  roughness:{name:'粗糙度',type:'scalar',value:.46,offset:4,file:'f_16xl_roughness.png'},
  normal:{name:'法线',type:'color',value:'#8080ff',offset:6,file:'f_16xl_normal.png'},
  height:{name:'高度',type:'scalar',value:.5,offset:9,file:'f_16xl_height.png'},
  emission:{name:'自发光',type:'color',value:'#000000',offset:10,file:'f_16xl_emission.png',srgb:true},
  alpha:{name:'不透明度',type:'scalar',value:1,offset:13,file:'f_16xl_alpha.png'},
  ao:{name:'环境遮蔽',type:'scalar',value:1,offset:14,file:'f_16xl_ao.png'}
};
export const paintChannels=Object.keys(channelSpecs),legacyChannels=paintChannels.slice(0,3);
const materialBlendChoices=[
  ['normal','正常'],['multiply','正片叠底'],['screen','滤色'],['overlay','叠加'],
  ['add','相加'],['subtract','相减'],['darken','取较小值'],['lighten','取较大值'],['difference','差值']
];
const normalBlendChoices=[['normal','替换'],['normalCombine','叠加法线细节']];
export const channelBlendChoices=channel=>channel==='normal'?normalBlendChoices:materialBlendChoices;
export const layerChannelBlend=(layer,channel)=>(channel==='color'?layer?.blend:layer?.channelBlend?.[channel])??'normal';
export const channelDefaults=Object.fromEntries(paintChannels.map(k=>[k,channelSpecs[k].value]));
export const effectiveValues=values=>({...channelDefaults,...values});
export const baseChannelEnabled=(paint,key)=>paint.baseChannels?.[key]!==false;
export const effectiveBaseValues=paint=>Object.fromEntries(paintChannels.map(k=>[k,baseChannelEnabled(paint,k)?(paint.base[k]??channelDefaults[k]):channelDefaults[k]]));
export function activePaintChannels(paint){
  if(!paint)return legacyChannels;
  return paintChannels.filter(k=>legacyChannels.includes(k)||baseChannelEnabled(paint,k)&&(Object.hasOwn(paint.base,k)||paint.baseChannels?.[k]===true)||
    paint.layers.some(l=>l.channels?.[k]===true)||paint.materialGraph?.nodes.some(n=>n.type==='pbr'&&Object.hasOwn(n.params,k))||
    paint.materialGraph?.links.some(l=>l.to.port===k));
}
export const liveStride=(pixels,size)=>pixels.length/(size*size);
export function renderChannel(pixels,size,channel,target=new Uint8ClampedArray(size*size*4),startPixel=0){
  const stride=liveStride(pixels,size),spec=channelSpecs[channel]||channelSpecs.color,o=spec.offset;
  const fallback=channelPixel(new Uint8Array(),0,channel,0);
  const start=startPixel*stride,end=Math.min(pixels.length,start+target.length/4*stride);
  for(let i=start,j=0;i<end;i+=stride,j+=4){
    if(o>=stride){target[j]=fallback[0];target[j+1]=fallback[1];target[j+2]=fallback[2];}
    else if(spec.type==='color'){target[j]=pixels[i+o];target[j+1]=pixels[i+o+1];target[j+2]=pixels[i+o+2];}
    else target[j]=target[j+1]=target[j+2]=pixels[i+o];
    target[j+3]=255;
  }
  return target;
}
export function channelPixel(pixels,start,channel,stride){
  const spec=channelSpecs[channel]||channelSpecs.color,o=spec.offset;
  if(o>=stride)return spec.type==='color'?spec.value.slice(1).match(/../g).map(n=>parseInt(n,16)):Array(3).fill(Math.round(spec.value*255));
  return spec.type==='color'?[pixels[start+o],pixels[start+o+1],pixels[start+o+2]]:Array(3).fill(pixels[start+o]);
}
