// Independent RGBA image documents. Material layers reference their composite by ID.
import {paintChannels} from './paint-channels.mjs';
import {uvShapeFields,uvShapePayload} from './uv-selection-region.mjs';
import {checkImageAdjustment,imageBlendModes} from './image-adjustments.mjs';
const record=o=>o&&typeof o==='object'&&!Array.isArray(o),id=s=>typeof s==='string'&&/^[\w-]{1,100}$/.test(s),unit=n=>Number.isFinite(n)&&n>=0&&n<=1;
const exact=(o,keys)=>record(o)&&Object.keys(o).every(k=>keys.includes(k));
const label=s=>typeof s==='string'&&!!s.trim()&&s.length<=100;
const ink=s=>typeof s==='string'&&/^#[a-f\d]{6}$/i.test(s);
const layerFields=['name','visible','locked','opacity','blend','maskEnabled','maskBase','maskGradient','asset','x','y','scale','rotation','stretch','gradient','adjustment','clipped'];
const layerNames={pixel:'像素层',image:'图像层',gradient:'渐变填充',adjustment:'调整图层'};
const pair=(values,check)=>Array.isArray(values)&&values.length===2&&values.every(check);
function checkGradient(gradient,checkStroke,mask=false){
  if(!exact(gradient,['kind','start','end','colors','alpha','clip',...uvShapeFields])||
     !['linear','radial'].includes(gradient.kind)||!pair(gradient.start,unit)||!pair(gradient.end,unit)||
     Math.hypot(gradient.start[0]-gradient.end[0],gradient.start[1]-gradient.end[1])<1/4096||
     !pair(gradient.colors,ink)||!pair(gradient.alpha,unit)||
     mask&&!gradient.colors.every(color=>/^#([a-f\d]{2})\1\1$/i.test(color)))
    throw Error('渐变方向或颜色无效');
  if(gradient.clip!==undefined||uvShapeFields.some(key=>Object.hasOwn(gradient,key)))
    checkStroke({uv:true,rect:gradient.clip,...uvShapePayload(gradient),opacity:1,value:1},true);
}
export const imageLayerDefaults={visible:true,locked:false,opacity:1,blend:'normal',maskEnabled:false,maskBase:1};
export const imageDocumentLimit=16;
export const hasImageLayerMask=layer=>!!layer&&(layer.maskEnabled||Array.isArray(layer.maskStrokes)||!!layer.maskGradient);
export function imageClippingBase(layers,index){
  for(let i=index-1;i>=0;i--){
    const layer=layers[i];
    if(!layer.clipped)return layer.kind==='adjustment'?null:layer;
  }
  return null;
}
export function imageLayersBeforeAdjustment(layers,id){
  const index=layers.findIndex(layer=>layer.id===id&&layer.kind==='adjustment');
  if(index<0)return null;
  const layer=layers[index],base=layer.clipped?imageClippingBase(layers,index):null;
  return layers.slice(base?layers.indexOf(base):0,index);
}
export function visibleImageLayers(layers){
  let baseVisible=false;
  return layers.filter(layer=>{
    const visible=layer.visible&&layer.opacity>0;
    if(!layer.clipped)baseVisible=visible&&layer.kind!=='adjustment';
    return visible&&(!layer.clipped||baseVisible);
  });
}
function releaseClipping(layers,index){
  for(let i=index;layers[i]?.clipped;i++)delete layers[i].clipped;
}
function repairClipping(layers){
  for(let i=0;i<layers.length;i++){
    if(layers[i].clipped&&!imageClippingBase(layers,i))releaseClipping(layers,i);
  }
}
function resetMask(layer){
  layer.maskEnabled=false;
  layer.maskBase=1;
  delete layer.maskStrokes;
  delete layer.maskGradient;
}
export function imageStrokeToMaterial(s,mask=false){
  if(s.transformUV||s.clearUV)return structuredClone(s);
  const {color,...stroke}=s;return mask?stroke:{...stroke,channels:{color:true,metallic:false,roughness:false},values:{color,metallic:0,roughness:.5}};
}
export function surfaceToImageCommand(op,documentId){
  if(op.op==='stroke'){
    const {values,channels,...stroke}=op.stroke;
    return {op:'image',action:'stroke',documentId,layerId:op.id,target:op.target==='mask'?'mask':'pixels',stroke:{...stroke,...(values?{color:values.color}:{})}};
  }
  if(op.op==='update'){const {uvScale,...patch}=op.patch;return {op:'image',action:'updateLayer',documentId,layerId:op.id,patch:{...patch,...(uvScale?{stretch:uvScale}:{})}};}
  if(op.op==='transformUV')return {op:'image',action:'transform',documentId,layerId:op.id,transform:op.transform};
  if(op.op==='clearUV')return {op:'image',action:'clear',documentId,layerId:op.id,rect:op.rect,...uvShapePayload(op)};
  throw Error('图像编辑命令无效');
}
export function validateImageDocuments(paint,{checkStroke,checkedUVTransform,validateText}){
  const documents=paint.imageDocuments??{};
  if(!record(documents)||Object.keys(documents).length>imageDocumentLimit)throw Error('工程最多包含 16 个图像文档');
  let stamps=0;
  for(const [key,doc] of Object.entries(documents)){
    if(!id(key)||!exact(doc,['name','width','height','colorSpace','layers'])||!label(doc.name)||doc.width!==4096||doc.height!==4096||!['srgb','linear'].includes(doc.colorSpace)||!Array.isArray(doc.layers)||doc.layers.length>64)throw Error('图像文档无效');
    const ids=new Set();
    for(const [index,layer] of doc.layers.entries()){
      if(!exact(layer,['id','kind',...layerFields,'strokes','maskStrokes','text'])||!id(layer.id)||ids.has(layer.id)||typeof layer.kind!=='string'||!Object.hasOwn(layerNames,layer.kind)||!label(layer.name)||typeof layer.visible!=='boolean'||typeof layer.locked!=='boolean'||!unit(layer.opacity)||!imageBlendModes.includes(layer.blend)||typeof layer.maskEnabled!=='boolean'||!unit(layer.maskBase))throw Error('图像图层无效');
      if(layer.clipped!==undefined&&(typeof layer.clipped!=='boolean'||layer.clipped&&!imageClippingBase(doc.layers,index)))
        throw Error('剪贴蒙版需要下方的底层');
      ids.add(layer.id);
      if(layer.kind==='gradient')checkGradient(layer.gradient,checkStroke);
      else if(layer.gradient!==undefined)throw Error('请选择渐变填充层');
      if(layer.kind==='adjustment')checkImageAdjustment(layer.adjustment);
      else if(layer.adjustment!==undefined)throw Error('请选择调整图层');
      if(layer.maskGradient!==undefined)checkGradient(layer.maskGradient,checkStroke,true);
      if(layer.text!==undefined&&(layer.kind!=='image'||!validateText?.(layer.text)))throw Error('图像文字参数无效');
      if(layer.kind==='image'&&(!Object.hasOwn(paint.assets,layer.asset)||![layer.x,layer.y,layer.scale,layer.rotation].every(Number.isFinite)||!unit(layer.x)||!unit(layer.y)||layer.scale<1/4096||layer.scale>4||Math.abs(layer.rotation)>360||!Array.isArray(layer.stretch)||layer.stretch.length!==2||!layer.stretch.every(n=>Number.isFinite(n)&&Math.abs(n)>=.05&&Math.abs(n)<=8)))throw Error('图像层素材或变换无效');
      for(const [field,mask] of [['strokes',false],['maskStrokes',true]]){
        const strokes=layer[field]??[];if(!Array.isArray(strokes)||strokes.length>400||field==='strokes'&&layer.kind!=='pixel'&&strokes.length)throw Error('图像笔触无效');
        for(const stroke of strokes){
          if(!record(stroke))throw Error('图像笔触无效');
          if(stroke.transformUV){if(!exact(stroke,['transformUV'])||mask)throw Error('图像变换无效');checkedUVTransform(stroke.transformUV);}
          else if(stroke.clearUV){if(!exact(stroke,['clearUV',...uvShapeFields])||mask)throw Error('图像清除无效');checkStroke({uv:true,rect:stroke.clearUV,...uvShapePayload(stroke),opacity:1,value:0},true);}
          else if(stroke.flood!==undefined){
            const fill=stroke.flood;
            if(mask||!exact(stroke,['uv','flood','opacity','clip',...uvShapeFields,'color','erase'])||
              stroke.uv!==true||stroke.erase!==false||!ink(stroke.color)||!unit(stroke.opacity)||
              !exact(fill,['point','tolerance','contiguous'])||!pair(fill.point,unit)||
              !Number.isInteger(fill.tolerance)||fill.tolerance<0||fill.tolerance>255||typeof fill.contiguous!=='boolean')
              throw Error('油漆桶填充参数无效');
            if(stroke.clip!==undefined||uvShapeFields.some(key=>Object.hasOwn(stroke,key)))
              checkStroke({uv:true,rect:stroke.clip,...uvShapePayload(stroke),opacity:1,value:0},true);
          }
          else{
            const keys=['uv','radius','hardness','opacity','flow','spacing','stamps','breaks','clone','clip',...uvShapeFields,'rect',...(mask?['value']:['color','erase'])];
            if(!exact(stroke,keys)||stroke.uv!==true||!mask&&!ink(stroke.color))throw Error('图像只接受二维 RGB 笔触');
            if(stroke.clone!==undefined&&(mask||stroke.rect!==undefined||stroke.erase!==false||
              !exact(stroke.clone,['offset'])||!pair(stroke.clone.offset,n=>Number.isFinite(n)&&n>=-1&&n<=1)))
              throw Error('仿制源偏移无效');
            checkStroke(imageStrokeToMaterial(stroke,mask),mask,true);
          }
          stamps+=stroke.stamps?.length??1;
        }
      }
    }
  }
  if(stamps>30000)throw Error('图像文档笔触超出上限');
  for(const layer of paint.layers){
    if(layer.documentMaps===undefined)continue;
    if(!exact(layer.documentMaps,paintChannels))throw Error('图像文档引用无效');
    if(!Object.keys(layer.documentMaps).length)continue;
    if(layer.kind!=='fill'||layer.materialId||Object.values(layer.documentMaps).some(key=>!id(key)||!Object.hasOwn(documents,key)))throw Error('图像文档只能绑定到独立填充层的通道');
  }
}
function duplicateImageName(documents,source){
  const names=new Set(Object.values(documents).map(doc=>doc.name));
  const candidate=suffix=>source.slice(0,100-suffix.length).trimEnd()+suffix;
  let number=1,name=candidate(' 副本');
  while(names.has(name))name=candidate(' 副本 '+(++number));
  return name;
}
export function imageDocumentOperation(paint,o,{requireUnlocked}){
  if(!exact(o,['op','action','documentId','newDocumentId','layerId','sourceLayerId','reveal','copy','clipped','patch','kind','target','stroke','transform','rect',...uvShapeFields,'index','channel','materialLayerId','newLayerId'])||!id(o.documentId))throw Error('图像文档命令无效');
  const documents=paint.imageDocuments??={},doc=Object.hasOwn(documents,o.documentId)?documents[o.documentId]:null;
  if(o.action==='create'){
    if(doc||!exact(o.patch??{},['name','colorSpace']))throw Error('图像文档已存在或参数无效');
    paint.imageDocuments={...documents,[o.documentId]:{name:'未命名贴图',width:4096,height:4096,colorSpace:'srgb',...o.patch,layers:[]}};return;
  }
  if(!doc)throw Error('图像文档不存在');
  if(o.action==='duplicate'){
    if(!id(o.newDocumentId)||Object.hasOwn(documents,o.newDocumentId))throw Error('图像副本编号无效');
    if(Object.keys(documents).length>=imageDocumentLimit)throw Error('工程最多包含 16 个图像文档');
    paint.imageDocuments={...documents,[o.newDocumentId]:{...structuredClone(doc),name:duplicateImageName(documents,doc.name)}};
    return;
  }
  if(o.action==='update'){if(!exact(o.patch,['name','colorSpace']))throw Error('图像文档参数无效');Object.assign(doc,o.patch);return;}
  if(o.action==='remove'){
    if(paint.layers.some(l=>Object.values(l.documentMaps??{}).includes(o.documentId)))throw Error('图像文档仍被材质引用，请先解除绑定');delete documents[o.documentId];return;
  }
  if(o.action==='bind'){
    if(!paintChannels.includes(o.channel))throw Error('请选择材质通道');
    let layer=paint.layers.find(l=>l.id===o.materialLayerId);
    if(o.materialLayerId&&!layer)throw Error('材质图层不存在');
    if(!layer){if(!id(o.newLayerId)||paint.layers.some(l=>l.id===o.newLayerId))throw Error('新材质图层编号无效');layer={id:o.newLayerId,kind:'fill',name:doc.name,visible:true,opacity:1,blend:'normal',channels:{color:false,metallic:false,roughness:false},values:{color:'#808080',metallic:0,roughness:.5},x:.5,y:.5,scale:1,rotation:0,mask:null};paint.layers.push(layer);}
    requireUnlocked(paint.layers,layer);if(layer.kind!=='fill'||layer.materialId)throw Error('请选择独立填充层');
    layer.documentMaps={...layer.documentMaps,[o.channel]:o.documentId};layer.channels[o.channel]=true;if(layer.maps)delete layer.maps[o.channel];return;
  }
  if(o.action==='addLayer'){
    const index=o.index??doc.layers.length;
    if(!id(o.layerId)||doc.layers.some(l=>l.id===o.layerId)||typeof o.kind!=='string'||!Object.hasOwn(layerNames,o.kind)||!exact(o.patch??{},layerFields)||
       !Number.isInteger(index)||index<0||index>doc.layers.length)throw Error('图像图层参数无效');
    const defaults=o.kind==='image'?{x:.5,y:.5,scale:1,rotation:0,stretch:[1,1]}:o.kind==='adjustment'?{maskEnabled:true}:{};
    const clipped=doc.layers[index]?.clipped&&imageClippingBase(doc.layers,index);
    doc.layers.splice(index,0,{id:o.layerId,kind:o.kind,name:layerNames[o.kind],...imageLayerDefaults,...defaults,
      ...(clipped?{clipped:true}:{}),...o.patch});
    return;
  }
  const index=doc.layers.findIndex(l=>l.id===o.layerId),layer=doc.layers[index];if(!layer)throw Error('图像图层不存在');
  if(layer.locked&&!(o.action==='updateLayer'&&Object.keys(o.patch??{}).every(k=>['locked','visible'].includes(k))))throw Object.assign(Error('图像图层已锁定'),{status:423});
  if(o.action==='updateLayer'){
    if(!exact(o.patch,layerFields)||Object.hasOwn(o.patch,'clipped'))throw Error('图像图层参数无效');
    if(Object.hasOwn(o.patch,'asset')&&o.patch.asset!==layer.asset)delete layer.text;
    // An empty mask still exists after it is disabled.
    if(layer.maskEnabled&&o.patch.maskEnabled===false)layer.maskStrokes??=[];
    Object.assign(layer,o.patch);
    if(layer.maskGradient===null)delete layer.maskGradient;
  }
  else if(o.action==='setClipping'){
    if(typeof o.clipped!=='boolean')throw Error('请选择创建或释放剪贴蒙版');
    if(o.clipped){
      if(!imageClippingBase(doc.layers,index))throw Error('剪贴蒙版需要下方的底层');
      layer.clipped=true;
    }else releaseClipping(doc.layers,index);
  }
  else if(o.action==='createMask'){
    if(hasImageLayerMask(layer))throw Error('图像图层已有蒙版');
    if(typeof o.reveal!=='boolean')throw Error('请选择显示或隐藏蒙版');
    const selection=o.rect!==undefined||uvShapeFields.some(key=>Object.hasOwn(o,key));
    layer.maskEnabled=true;
    layer.maskBase=Number(selection?!o.reveal:o.reveal);
    if(selection)layer.maskStrokes=[{uv:true,rect:o.rect,...uvShapePayload(o),opacity:1,value:Number(o.reveal)}];
  }
  else if(o.action==='transferMask'){
    const source=doc.layers.find(item=>item.id===o.sourceLayerId);
    if(typeof o.copy!=='boolean'||source===layer||!hasImageLayerMask(source))throw Error('请选择另一个图层的蒙版');
    if(source.locked&&!o.copy)throw Object.assign(Error('源图层已锁定'),{status:423});
    resetMask(layer);
    layer.maskEnabled=source.maskEnabled;
    layer.maskBase=source.maskBase;
    if(source.maskStrokes)layer.maskStrokes=structuredClone(source.maskStrokes);
    if(source.maskGradient)layer.maskGradient=structuredClone(source.maskGradient);
    if(!o.copy)resetMask(source);
  }
  else if(o.action==='invertMask'||o.action==='removeMask'){
    if(!hasImageLayerMask(layer))throw Error('图像图层没有蒙版');
    if(o.action==='invertMask'){
      layer.maskBase=1-layer.maskBase;
      if(layer.maskGradient)layer.maskGradient.colors=layer.maskGradient.colors.map(color=>
        '#'+(255-parseInt(color.slice(1,3),16)).toString(16).padStart(2,'0').repeat(3));
      for(const stroke of layer.maskStrokes??[])stroke.value=1-stroke.value;
    }else resetMask(layer);
  }
  else if(o.action==='removeLayer'){
    doc.layers.splice(index,1);
    if(!layer.clipped)releaseClipping(doc.layers,index);
    repairClipping(doc.layers);
  }
  else if(o.action==='duplicateLayer'){
    if(!id(o.patch?.id)||doc.layers.some(l=>l.id===o.patch.id))throw Error('图像副本编号无效');
    const duplicate={...structuredClone(layer),id:o.patch.id,name:layer.name.slice(0,90)+' 副本'};
    // Place a base-layer copy above its group so the existing clips stay attached.
    let destination=index+1;
    if(!layer.clipped)while(doc.layers[destination]?.clipped)destination++;
    doc.layers.splice(destination,0,duplicate);
  }
  else if(o.action==='moveLayer'){
    if(!Number.isInteger(o.index)||o.index<0||o.index>=doc.layers.length)throw Error('图像层序无效');
    if(o.index===index)return;
    doc.layers.splice(index,1);
    if(doc.layers[o.index]?.clipped&&imageClippingBase(doc.layers,o.index))layer.clipped=true;
    doc.layers.splice(o.index,0,layer);
    repairClipping(doc.layers);
  }
  else if(o.action==='stroke'){
    if(!['pixels','mask'].includes(o.target)||o.target==='pixels'&&layer.kind!=='pixel')throw Error('请在像素层或蒙版上绘制');
    const key=o.target==='mask'?'maskStrokes':'strokes';if(o.target==='mask')layer.maskEnabled=true;(layer[key]??=[]).push(structuredClone(o.stroke));
  }else if(o.action==='transform'||o.action==='clear'){
    if(layer.kind!=='pixel')throw Error('请选择像素层');(layer.strokes??=[]).push(o.action==='transform'?{transformUV:structuredClone(o.transform)}:{clearUV:o.rect,...uvShapePayload(o)});
  }else throw Error('不支持的图像命令');
}
