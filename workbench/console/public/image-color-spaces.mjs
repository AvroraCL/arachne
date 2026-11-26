const workingGroups=[
  ['常用 RGB',[['srgb','颜色（sRGB）'],['display-p3','Display P3'],['adobe-rgb','Adobe RGB (1998)'],['prophoto-rgb','ProPhoto RGB'],['eci-rgb-v2','eciRGB v2（印前）']]],
  ['视频与影院',[['rec709','Rec.709'],['rec709-g24','Rec.709（Gamma 2.4）'],['rec2020','Rec.2020'],['rec2020-g24','Rec.2020（Gamma 2.4）'],['dci-p3','DCI-P3（影院）']]],
  ['场景线性 RGB',[['linear-srgb','线性 sRGB（颜色）'],['linear-p3','线性 Display P3'],['linear-rec2020','线性 Rec.2020'],['linear-adobe-rgb','线性 Adobe RGB'],['linear-prophoto-rgb','线性 ProPhoto RGB'],['acescg','ACEScg（AP1 线性）'],['aces2065-1','ACES2065-1（AP0 线性）']]],
  ['灰度',[['gray-g22','灰度（Gamma 2.2）'],['gray-linear','灰度（线性光）']]],
  ['材质数据',[['linear','数据（线性）']]]
];
export const imageColorSpaces=workingGroups.flatMap(([,spaces])=>spaces);
export const isGraySpace=space=>space==='gray-g22'||space==='gray-linear';
export const textureColorSpaces=[['auto','读取图像配置（ICC）'],...imageColorSpaces.filter(([space])=>!isGraySpace(space))];

export function fillWorkingSpaces(select,selected='srgb',include=()=>true){
  select.replaceChildren(...workingGroups.flatMap(([label,choices])=>{
    const group=document.createElement('optgroup');
    group.label=label;
    for(const [id,name] of choices)if(include(id))group.append(new Option(name,id));
    return group.children.length?[group]:[];
  }));
  select.value=selected;
}
