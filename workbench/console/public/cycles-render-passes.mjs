export const cyclesRenderPasses=Object.freeze({
  depth:{label:'深度',layer:'Depth',channels:'V'},
  normal:{label:'法线',layer:'Normal',channels:'XYZ'},
  ao:{label:'环境遮蔽',layer:'AO',channels:'RGBA'},
  diffuse:{label:'漫反射颜色',layer:'Diffuse',channels:'RGBA'},
  specular:{label:'光泽颜色',layer:'Specular',channels:'RGBA'},
  emission:{label:'自发光',layer:'Emission',channels:'RGBA'},
  environment:{label:'环境光',layer:'Environment',channels:'RGBA'}
});
export const cyclesPassBudget=768*1024*1024;
export const renderPassBytes=(selected,width,height)=>selected.length?width*height*4*
  (4+selected.reduce((count,key)=>count+cyclesRenderPasses[key].channels.length,0)):0;

export function checkCyclesRenderPasses(value,width,height){
  if(!Array.isArray(value)||value.length>Object.keys(cyclesRenderPasses).length||
    new Set(value).size!==value.length||value.some(key=>typeof key!=='string'||!Object.hasOwn(cyclesRenderPasses,key)))
    throw Error('Cycles 渲染通道无效');
  const selected=Object.keys(cyclesRenderPasses).filter(key=>value.includes(key));
  if(renderPassBytes(selected,width,height)>cyclesPassBudget)
    throw Error('当前分辨率的渲染通道占用较大，请减少通道或降低分辨率');
  return selected;
}

export function renderPassChannels(selected){
  return [...'RGBA'].map(channel=>'Combined.'+channel).concat(selected.flatMap(key=>{
    const {layer,channels}=cyclesRenderPasses[key];return [...channels].map(channel=>layer+'.'+channel);
  }));
}
