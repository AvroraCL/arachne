export const maskGeneratorFields={
  edgeWear:[
    {key:'edge',label:'边缘类型',value:'convex',choices:[['convex','凸边'],['concave','凹边'],['both','凹凸边']]},
    {key:'angle',label:'最小折角 (°)',value:20,min:1,max:170,step:1,dragSpeed:1},
    {key:'width',label:'磨损宽度 (%)',value:2,min:.05,max:20,step:'any',dragSpeed:.05},
    {key:'softness',label:'边缘柔和度',value:.65,min:.01,max:1,step:'any'}
  ],
  surfaceNoise:[
    {key:'scale',label:'噪声密度',value:36,min:1,max:256,step:'any',dragSpeed:.5},
    {key:'threshold',label:'噪声阈值',value:.48,min:0,max:1,step:'any'},
    {key:'softness',label:'噪声过渡',value:.35,min:.01,max:1,step:'any'},
    {key:'seed',label:'随机种子',value:1,min:0,max:65535,step:1,integer:true,dragSpeed:1}
  ]
};
export const maskEffectLabels={invert:'反相',levels:'色阶',height:'位置渐变',facing:'表面朝向',edgeWear:'边缘磨损',surfaceNoise:'表面噪声'};
export const maskEffectBlends=[
  ['replace','替换'],['multiply','相乘'],['add','相加'],['subtract','相减'],['max','取大'],['min','取小']
];
export const maskEffectBlendLabel=mode=>maskEffectBlends.find(([key])=>key===mode)?.[1];
export const maskEffectLimit=12;

export function newMaskEffect(kind){
  const effect={kind,enabled:true,opacity:1};
  if(kind==='levels')return {...effect,black:.15,white:.85,gamma:1};
  if(kind==='height'||kind==='facing')
    return {...effect,axis:'z',center:kind==='height'?.38:.7,feather:.25,blend:'multiply'};
  const fields=Object.hasOwn(maskGeneratorFields,kind)?maskGeneratorFields[kind]:null;
  return fields?{...effect,blend:'multiply',...Object.fromEntries(fields.map(({key,value})=>[key,value]))}:effect;
}
