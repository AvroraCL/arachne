const number=(label,initial,min,max,step=1)=>({label,initial,min,max,step});
const choice=(label,initial,choices)=>({label,initial,choices});
const ink=(label,initial)=>({label,initial,type:'color',valid:value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)});
export const curveChannels=[['rgb','RGB'],['red','红色'],['green','绿色'],['blue','蓝色']];
const channel={label:'通道',initial:'rgb',choices:curveChannels};
export const maxCurvePoints=16;
const identity=()=>[[0,0],[255,255]];
const defaultCurves=()=>Object.fromEntries(curveChannels.map(([id])=>[id,identity()]));
const curveValue=value=>Number.isInteger(value)&&value>=0&&value<=255;
const validCurve=points=>Array.isArray(points)&&points.length>=2&&points.length<=maxCurvePoints&&
  points[0]?.[0]===0&&points.at(-1)?.[0]===255&&points.every((point,index)=>
    Array.isArray(point)&&point.length===2&&point.every(curveValue)&&(index===0||point[0]>points[index-1][0]));

export const hueFamilies=[['red','红色',0],['yellow','黄色',60],['green','绿色',120],
  ['cyan','青色',180],['blue','蓝色',240],['magenta','洋红',300]];
const hueRange=choice('颜色范围','all',[['all','全图'],...hueFamilies.map(([id,label])=>[id,label]),['custom','自定义']]);
const balanceFields={red:number('青色／红色',0,-100,100),green:number('洋红／绿色',0,-100,100),blue:number('黄色／蓝色',0,-100,100)};
const selectiveFields={cyan:number('青色',0,-100,100),magenta:number('洋红',0,-100,100),
  yellow:number('黄色',0,-100,100),black:number('黑色',0,-100,100)};
const tonalRanges=[['shadows','阴影'],['midtones','中间调'],['highlights','高光']];
const selectiveRanges=[...hueFamilies.map(([id,label])=>[id,label]),['white','白色'],['neutral','中性色'],['black','黑色']];
function bankFields(ranges,fields){
  return {label:'分区参数',initial:()=>Object.fromEntries(ranges.map(([id])=>[id,Object.fromEntries(
    Object.keys(fields).map(key=>[key,0]))])),valid:bank=>bank&&typeof bank==='object'&&!Array.isArray(bank)&&
    Object.keys(bank).length===ranges.length&&ranges.every(([id])=>{
      const values=bank[id];
      return values&&typeof values==='object'&&!Array.isArray(values)&&Object.keys(values).length===Object.keys(fields).length&&
        Object.keys(fields).every(key=>Number.isInteger(values[key])&&Math.abs(values[key])<=100);
    })};
}
export const imageAdjustmentBanks={
  colorBalance:{label:'色调范围',ranges:tonalRanges,initial:'midtones',fields:balanceFields},
  selectiveColor:{label:'颜色族',ranges:selectiveRanges,initial:'red',fields:selectiveFields}
};

export function curveSlopes(points){
  const spans=points.slice(1).map(([x],index)=>x-points[index][0]);
  const slopes=points.slice(1).map(([,y],index)=>(y-points[index][1])/spans[index]);
  return points.map((_,index)=>{
    if(index===0)return slopes[0];
    if(index===points.length-1)return slopes.at(-1);
    const left=slopes[index-1],right=slopes[index];
    if(left*right<=0)return 0;
    const first=2*spans[index]+spans[index-1],second=spans[index]+2*spans[index-1];
    return (first+second)/(first/left+second/right);
  });
}

export const imageAdjustments=Object.freeze({
  brightnessContrast:{label:'亮度／对比度',fields:{
    brightness:number('亮度',0,-100,100),contrast:number('对比度',0,-100,100)
  }},
  levels:{label:'色阶',fields:{
    channel,inputBlack:number('输入黑场',0,0,254),gamma:number('中间调',1,.1,5,.01),
    inputWhite:number('输入白场',255,1,255),outputBlack:number('输出黑场',0,0,255),outputWhite:number('输出白场',255,0,255)
  }},
  curves:{label:'曲线',fields:{points:{label:'控制点',initial:defaultCurves,valid:value=>
    value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===curveChannels.length&&
    curveChannels.every(([id])=>validCurve(value[id]))}}},
  hueSaturation:{label:'色相／饱和度',fields:{
    range:{...hueRange,optional:true},center:{...number('色相中心',0,0,360),optional:true,show:'custom',suffix:'°'},
    width:{...number('范围半宽',30,1,180),optional:true,show:'range',suffix:'°'},
    falloff:{...number('过渡宽度',20,0,180),optional:true,show:'range',suffix:'°'},
    hue:number('色相',0,-180,180),saturation:number('饱和度',0,-100,100),lightness:number('明度',0,-100,100)
  }},
  colorBalance:{label:'色彩平衡',fields:{
    preserve:{label:'保持亮度',initial:true,type:'checkbox',valid:value=>typeof value==='boolean'},
    tones:bankFields(tonalRanges,balanceFields)
  }},
  selectiveColor:{label:'可选颜色',fields:{
    method:choice('调整方式','relative',[['relative','相对'],['absolute','绝对']]),
    tones:bankFields(selectiveRanges,selectiveFields)
  }},
  gradientMap:{label:'渐变映射',fields:{
    shadow:ink('阴影颜色','#000000'),middle:ink('中间色','#808080'),highlight:ink('高光颜色','#ffffff'),
    midpoint:{...number('中间色位置',50,1,99),suffix:'%'},
    reverse:{label:'反向',initial:false,type:'checkbox',valid:value=>typeof value==='boolean'}
  }},
  exposure:{label:'曝光度',fields:{
    exposure:number('曝光补偿',0,-10,10,.1),offset:number('偏移量',0,-.5,.5,.01),gamma:number('伽马',1,.1,5,.01)
  }},
  blackWhite:{label:'黑白',fields:{
    red:number('红色',21,-100,200),green:number('绿色',72,-100,200),blue:number('蓝色',7,-100,200)
  }},
  invert:{label:'反相',fields:{}},
  posterize:{label:'色调分离',fields:{steps:number('色阶数',4,2,256)}},
  gaussianBlur:{label:'高斯模糊',filter:true,fields:{radius:{...number('半径（像素）',12,0,256,.1),scrubSpeed:.5}}},
  unsharpMask:{label:'USM 锐化',filter:true,fields:{
    amount:{...number('锐化数量',100,0,500),suffix:'%'},
    radius:{...number('半径（像素）',2,.1,250,.1),scrubSpeed:.5},
    threshold:number('阈值',0,0,255)
  }}
});

export function newImageAdjustment(type){
  if(!Object.hasOwn(imageAdjustments,type))throw Error('请选择有效的图像调整');
  return {type,...Object.fromEntries(Object.entries(imageAdjustments[type].fields).map(([key,field])=>[
    key,typeof field.initial==='function'?field.initial():field.initial
  ]))};
}

export function checkImageAdjustment(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(imageAdjustments,value.type))
    throw Error('图像调整参数无效');
  const fields=imageAdjustments[value.type].fields;
  if(Object.keys(value).some(key=>key!=='type'&&!Object.hasOwn(fields,key)))throw Error('图像调整参数无效');
  for(const [key,field] of Object.entries(fields)){
    const current=value[key];
    if(current===undefined&&field.optional)continue;
    if(field.valid?!field.valid(current):field.choices? !field.choices.some(([choice])=>choice===current):
      !Number.isFinite(current)||current<field.min||current>field.max||field.step===1&&!Number.isInteger(current))
      throw Error('图像调整参数无效：'+field.label);
  }
  if(value.type==='levels'&&value.inputBlack>=value.inputWhite)throw Error('输入黑场必须低于白场');
}

export const imageBlendGroups=Object.freeze([
  ['', [['normal','正常']]],
  ['变暗',[['darken','变暗'],['multiply','正片叠底'],['colorBurn','颜色加深'],['linearBurn','线性加深']]],
  ['变亮',[['lighten','变亮'],['screen','滤色'],['colorDodge','颜色减淡'],['linearDodge','线性减淡']]],
  ['对比',[['overlay','叠加'],['softLight','柔光'],['hardLight','强光']]],
  ['差值',[['difference','差值'],['exclusion','排除'],['subtract','减去'],['divide','划分']]],
  ['颜色分量',[['hue','色相'],['saturation','饱和度'],['color','颜色'],['luminosity','明度']]]
]);
export const imageBlendModes=imageBlendGroups.flatMap(([,modes])=>modes.map(([id])=>id));
