export const imageColorSpaces=[
  ['srgb','颜色（sRGB）'],['display-p3','Display P3'],['adobe-rgb','Adobe RGB (1998)'],
  ['prophoto-rgb','ProPhoto RGB'],['linear-srgb','线性 sRGB（颜色）'],
  ['rec709','Rec.709'],['rec2020','Rec.2020'],['rec2020-g24','Rec.2020（Gamma 2.4）'],
  ['dci-p3','DCI-P3（影院）'],['acescg','ACEScg（AP1 线性）'],['aces2065-1','ACES2065-1（AP0 线性）'],
  ['gray-g22','灰度（Gamma 2.2）'],['gray-linear','灰度（线性光）'],['linear','数据（线性）']
];

export const isGraySpace=space=>space==='gray-g22'||space==='gray-linear';

export const textureColorSpaces=[['auto','读取图像配置（ICC）'],...imageColorSpaces.filter(([space])=>!isGraySpace(space))];
