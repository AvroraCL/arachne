const baseColor={name:'BaseColor.png',colorSpace:'sRGB',bands:['color.R','color.G','color.B','alpha']};
const height={name:'Height.png',colorSpace:'linear',copy:'height'};
const emission={name:'Emissive.png',colorSpace:'sRGB',copy:'emission'};

export const textureExportPresets={
  separate:{label:'独立 PBR 通道',hint:'8 张 4K PNG，法线使用 OpenGL（+Y）。'},
  'unreal-orm':{
    label:'Unreal · ORM',
    hint:'ORM 的 R／G／B 为环境遮蔽／粗糙度／金属度。基础色含透明度，法线使用 DirectX（−Y）。',
    files:[baseColor,{name:'ORM.png',colorSpace:'linear',bands:['ao','roughness','metallic']},
      {name:'Normal_DirectX.png',colorSpace:'linear',bands:['normal.R','!normal.G','normal.B']},emission,height]
  },
  'unity-hdrp':{
    label:'Unity · HDRP',
    hint:'Mask Map 的 R／G／B／A 为金属度／环境遮蔽／细节蒙版（0）／平滑度。基础色含透明度。',
    files:[baseColor,{name:'MaskMap.png',colorSpace:'linear',bands:['metallic','ao',0,'!roughness']},
      {name:'Normal_OpenGL.png',colorSpace:'linear',copy:'normal'},emission,height]
  }
};

export function checkedTexturePreset(value){
  if(value===undefined)return 'separate';
  if(typeof value!=='string'||!Object.hasOwn(textureExportPresets,value))throw Error('贴图输出预设无效');
  return value;
}
