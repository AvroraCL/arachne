import {checkImageStyles} from './image-text-style.mjs';
import {validPenPath} from './image-pen-path.mjs';
import {isBrushImage} from './paint-library.mjs';
// Independent RGBA image documents. Material layers reference their composite by ID.
import {paintChannels} from './paint-channels.mjs';
import {maxUVFeather,imageSelectionFields as uvShapeFields,uvShapePayload,validSelectionOutline} from './uv-selection-region.mjs';
import {checkImageAdjustment,imageBlendModes} from './image-adjustments.mjs';
import {validImageShape} from './image-shapes.mjs';
import {layerChildren,layerLockOwner,layerParent} from './paint-layer-tree.mjs';
import {arrangeImageLayer,duplicateImageLayer,followingClips,groupImageLayers,imageGroupBlend,imageGroupTarget,imageLayersBefore,
  imageStackBase,removeImageLayer,repairImageClips,ungroupImageLayer,validateImageLayerTree} from './image-layer-tree.mjs';
import {duplicateImageLayerBatch,imageLayerLimit,planImageLayerDelete,planImageLayerMove} from './image-layer-batch.mjs';
import {isStrokeBlock,checkStrokeBlock} from './stroke-blocks.mjs';
import {imageLayoutTargets,layoutPoint} from './image-layout.mjs';
import {identityImageSpace,imagePlacement,validImageWarp} from './image-warp.mjs';
const record=o=>o&&typeof o==='object'&&!Array.isArray(o),id=s=>typeof s==='string'&&/^[\w-]{1,100}$/.test(s),unit=n=>Number.isFinite(n)&&n>=0&&n<=1;
const exact=(o,keys)=>record(o)&&Object.keys(o).every(k=>keys.includes(k));
const label=s=>typeof s==='string'&&!!s.trim()&&s.length<=100;
const ink=s=>typeof s==='string'&&/^#[a-f\d]{6}$/i.test(s);
const cloneAsset=s=>typeof s==='string'&&/^[a-f\d]{64}$/.test(s);
export const imageLayerAssets=layer=>[layer.asset,layer.raster,...(layer.cloneSources??[]),...(layer.selectionSources??[]),...(layer.brushSources??[])].filter(Boolean);
const layerFields=['name','visible','locked','alphaLocked','opacity','blend','maskEnabled','maskBase','maskGradient','maskDensity','maskFeather','maskLinked','maskTransform','asset','x','y','scale','rotation','stretch','gradient','gradientTransform','adjustment','clipped','shape','warp','blendIf','styles','edgeDecontaminate'];
const layerNames={pixel:'像素层',image:'图像层',gradient:'渐变填充',adjustment:'调整图层',shape:'形状层',group:'图层组'};
const pair=(values,check)=>Array.isArray(values)&&values.length===2&&values.every(check);
export const fullBlendRange=Object.freeze([0,0,255,255]);
export function checkImageBlendIf(value){
  if(!exact(value,['source','backdrop'])||!['source','backdrop'].every(key=>{
    const stops=value[key];
    return Array.isArray(stops)&&stops.length===4&&stops.every((n,i)=>Number.isInteger(n)&&n>=0&&n<=255&&(!i||n>=stops[i-1]));
  }))throw Error('明暗混合端点必须在 0–255 之间，并从左到右递增');
}
const maskCoordinate=n=>Number.isFinite(n)&&Math.abs(n)<=4096;
export const maskTransformIdentity=identityImageSpace;
const validMaskTransform=m=>Array.isArray(m)&&m.length===6&&m.every(n=>Number.isFinite(n)&&Math.abs(n)<=4096)&&
  Math.abs(m[0]*m[3]-m[1]*m[2])>1e-12;
function transformImageSpace(space,{pivot,offset,angle,scale}){
  const [sx,sy]=Array.isArray(scale)?scale:[scale,scale],radians=angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  const [a,b,d,e]=[sx*c,sx*s,-sy*s,sy*c], [x,y]=pivot;
  const tx=x+offset[0]-a*x-d*y,ty=y+offset[1]-b*x-e*y;
  const [A,B,D,E,X,Y]=space??maskTransformIdentity;
  return [a*A+d*B,b*A+e*B,a*D+d*E,b*D+e*E,a*X+d*Y+tx,b*X+e*Y+ty];
}
function moveLayerMask(layer,transform){layer.maskTransform=transformImageSpace(layer.maskTransform,transform);}
function retainMaskTransform(layer,previous){
  if(layer.maskLinked===false||!hasImageLayerMask(layer)||!['image','shape'].includes(layer.kind))return;
  const changed=['x','y','scale','rotation'].some(key=>previous[key]!==layer[key])||
    previous.stretch.some((value,index)=>value!==layer.stretch[index]);
  if(!changed)return;
  const angle=layer.rotation-previous.rotation;
  const scale=layer.stretch.map((value,index)=>value*layer.scale/(previous.stretch[index]*previous.scale));
  if(scale[0]===scale[1])moveLayerMask(layer,{pivot:[previous.x,previous.y],offset:[layer.x-previous.x,layer.y-previous.y],angle,scale});
  else{
    moveLayerMask(layer,{pivot:[previous.x,previous.y],offset:[0,0],angle:-previous.rotation,scale:1});
    moveLayerMask(layer,{pivot:[previous.x,previous.y],offset:[layer.x-previous.x,layer.y-previous.y],angle:layer.rotation,scale});
  }
}
function retainMaskWarp(layer,previous,assets){
  if(layer.maskLinked===false||!['image','shape'].includes(layer.kind)||
     JSON.stringify(previous.warp)===JSON.stringify(layer.warp))return;
  const placement=imagePlacement(layer,assets);
  if(!placement)throw Error('图像素材无效');
  layer.maskWarpSteps=[...(layer.maskWarpSteps??[]),{from:previous.warp??null,to:layer.warp??null,
    space:[...(layer.maskTransform??maskTransformIdentity)],placement:placement.matrix}];
}
function validMaskWarpStep(step){
  return exact(step,['from','to','space','placement'])&&
    (step.from!==null||step.to!==null)&&[step.from,step.to].every(warp=>warp===null||validImageWarp(warp))&&
    validMaskTransform(step.space)&&Array.isArray(step.placement)&&step.placement.length===6&&
    step.placement.every(n=>Number.isFinite(n)&&Math.abs(n)<=64)&&
    step.placement[0]*step.placement[3]!==step.placement[1]*step.placement[2];
}
const validMaskWarpIndex=(index,layer)=>index===undefined||Number.isInteger(index)&&index>=0&&index<=(layer.maskWarpSteps?.length??0);
function checkGradient(gradient,checkStroke,mask=false){
  if(!exact(gradient,['kind','start','end','colors','alpha','clip',...uvShapeFields,...(mask?['maskSpace','maskWarpIndex']:[])])||
     !['linear','radial'].includes(gradient.kind)||!pair(gradient.start,maskCoordinate)||!pair(gradient.end,maskCoordinate)||
     Math.hypot(gradient.start[0]-gradient.end[0],gradient.start[1]-gradient.end[1])<1/4096||
     !pair(gradient.colors,ink)||!pair(gradient.alpha,unit)||
     mask&&(!gradient.colors.every(color=>/^#([a-f\d]{2})\1\1$/i.test(color))||
       gradient.maskSpace!==undefined&&!validMaskTransform(gradient.maskSpace)))
    throw Error('渐变方向或颜色无效');
  if(gradient.clip!==undefined||uvShapeFields.some(key=>Object.hasOwn(gradient,key)))
    checkStroke({uv:true,rect:gradient.clip,...uvShapePayload(gradient),opacity:1,value:1},true,true);
}
export const imageLayerDefaults={visible:true,locked:false,opacity:1,blend:'normal',maskEnabled:false,maskBase:1};
export const imageDocumentLimit=16;
export const hasImageLayerMask=layer=>!!layer&&(layer.maskEnabled||Array.isArray(layer.maskStrokes)||!!layer.maskGradient);
export const imageClippingBase=imageStackBase;
export function imageLayersBeforeAdjustment(layers,id){
  const index=layers.findIndex(layer=>layer.id===id&&layer.kind==='adjustment');
  if(index<0)return null;
  const layer=layers[index],base=layer.clipped?imageClippingBase(layers,index):null;
  return imageLayersBefore(layers,layer,base);
}
export function visibleImageLayers(layers){
  const visible=new Set();
  function visit(parent){
    let baseVisible=false;
    for(const layer of layerChildren(layers,parent)){
      const active=layer.visible&&layer.opacity>0;
      if(!layer.clipped)baseVisible=active&&!['adjustment','group'].includes(layer.kind);
      if(active&&(!layer.clipped||baseVisible)){
        visible.add(layer.id);
        if(layer.kind==='group')visit(layer.id);
      }
    }
  }
  visit(null);
  return layers.filter(layer=>visible.has(layer.id));
}
export function clearImageLayerMask(layer){
  layer.maskEnabled=false;
  layer.maskBase=1;
  delete layer.maskStrokes;
  delete layer.maskGradient;
  delete layer.maskDensity;
  delete layer.maskFeather;
  delete layer.maskLinked;
  delete layer.maskTransform;
  delete layer.maskWarpSteps;
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
export function validateImageDocuments(paint,{checkStroke,checkedUVTransform,validateText,unpackStrokeBlock,checkPending=true}){
  const documents=paint.imageDocuments??{};
  if(!record(documents)||Object.keys(documents).length>imageDocumentLimit)throw Error('工程最多包含 16 个图像文档');
  let stamps=0;
  for(const [key,doc] of Object.entries(documents)){
    const checkCoverage=key=>cloneAsset(key)&&paint.assets[key]?.width===4096&&paint.assets[key]?.height===4096;
    if(!id(key)||!exact(doc,['name','width','height','colorSpace','layers','selections','paths'])||!label(doc.name)||doc.width!==4096||doc.height!==4096||!['srgb','linear'].includes(doc.colorSpace)||!Array.isArray(doc.layers)||doc.layers.length>imageLayerLimit)throw Error('图像文档无效');
    if(doc.selections!==undefined){
      if(!Array.isArray(doc.selections))throw Error('已保存的选区无效');
      const names=new Set();
      for(const selection of doc.selections){
        if(!exact(selection,['name','rect',...uvShapeFields,'outline'])||!label(selection.name)||names.has(selection.name))
          throw Error('选区名称无效或重复');
        names.add(selection.name);
        checkStroke({uv:true,rect:selection.rect,...uvShapePayload(selection),opacity:1,value:1},true,true);
        if(selection.coverage!==undefined&&!checkCoverage(selection.coverage))throw Error('选区覆盖图不存在');
        if(selection.coverage!==undefined?!validSelectionOutline(selection.outline):selection.outline!==undefined)
          throw Error('已存选区轮廓无效');
      }
    }
    if(doc.paths!==undefined){
      if(!Array.isArray(doc.paths))throw Error('已保存的路径无效');
      const pathIds=new Set();
      for(const {id:key,name,geometry,...other} of doc.paths){
        if(!id(key)||pathIds.has(key)||!label(name)||!validPenPath(geometry)||Object.keys(other).length)
          throw Error('路径参数无效或编号重复');
        pathIds.add(key);
      }
    }
    const ids=new Set();
    for(const [index,layer] of doc.layers.entries()){
      if(!exact(layer,['id','kind','parentId',...layerFields,'strokes','maskStrokes','maskWarpSteps','text','textOrigin','raster','cloneSources','selectionSources','brushSources'])||!id(layer.id)||ids.has(layer.id)||typeof layer.kind!=='string'||!Object.hasOwn(layerNames,layer.kind)||!label(layer.name)||typeof layer.visible!=='boolean'||typeof layer.locked!=='boolean'||!unit(layer.opacity)||!(imageBlendModes.includes(layer.blend)||layer.kind==='group'&&layer.blend===imageGroupBlend)||typeof layer.maskEnabled!=='boolean'||!unit(layer.maskBase))throw Error('图像图层无效');
      if(layer.brushSources!==undefined&&(!Array.isArray(layer.brushSources)||layer.brushSources.some(key=>!cloneAsset(key)||!isBrushImage(paint.assets[key]))))
        throw Error('图层笔刷图片无效');
      if(layer.selectionSources!==undefined&&(!Array.isArray(layer.selectionSources)||!layer.selectionSources.every(checkCoverage)))
        throw Error('图层选区覆盖图无效');
      const ownsCoverage=value=>value===undefined||layer.selectionSources?.includes(value);
      if(!ownsCoverage(layer.gradient?.coverage)||!ownsCoverage(layer.maskGradient?.coverage))throw Error('渐变选区覆盖图不存在');
      if(layer.raster!==undefined&&(layer.kind!=='pixel'||!Object.hasOwn(paint.assets,layer.raster)||
         paint.assets[layer.raster].width!==doc.width||paint.assets[layer.raster].height!==doc.height))
        throw Error('栅格图层底稿尺寸无效');
      if(layer.cloneSources!==undefined&&(layer.kind!=='pixel'||!Array.isArray(layer.cloneSources)||
         layer.cloneSources.some(key=>!cloneAsset(key)||!Object.hasOwn(paint.assets,key)||
           paint.assets[key].width!==doc.width||paint.assets[key].height!==doc.height)))
        throw Error('仿制取样源无效');
      if(layer.clipped!==undefined&&(typeof layer.clipped!=='boolean'||layer.clipped&&!imageClippingBase(doc.layers,index)))
        throw Error('剪贴蒙版需要下方的底层');
      if(layer.alphaLocked!==undefined&&(layer.kind!=='pixel'||typeof layer.alphaLocked!=='boolean'))
        throw Error('只有像素图层可以锁定透明度');
      if(layer.kind==='group'&&['asset','x','y','scale','rotation','stretch'].some(key=>Object.hasOwn(layer,key)))
        throw Error('图层组只能保存组属性与蒙版');
      ids.add(layer.id);
      if(layer.kind==='gradient')checkGradient(layer.gradient,checkStroke);
      else if(layer.gradient!==undefined)throw Error('请选择渐变填充层');
      if(layer.gradientTransform!==undefined&&(layer.kind!=='gradient'||!validMaskTransform(layer.gradientTransform)))
        throw Error('渐变变换无效');
      if(layer.edgeDecontaminate!==undefined&&(!['image','pixel','shape'].includes(layer.kind)||
         !exact(layer.edgeDecontaminate,['color','amount'])||!ink(layer.edgeDecontaminate.color)||!unit(layer.edgeDecontaminate.amount)))
        throw Error('边缘去杂色参数无效');
      if(layer.styles!==undefined)checkImageStyles(layer);
      if(layer.blendIf!==undefined){
        if(['group','adjustment'].includes(layer.kind))throw Error('明暗混合需要图像内容图层');
        checkImageBlendIf(layer.blendIf);
      }
      if(layer.kind==='adjustment')checkImageAdjustment(layer.adjustment);
      else if(layer.adjustment!==undefined)throw Error('请选择调整图层');
      if(layer.kind==='shape'?!validImageShape(layer.shape):layer.shape!==undefined)throw Error('图像形状参数无效');
      if(layer.warp!==undefined&&(!['image','shape'].includes(layer.kind)||!validImageWarp(layer.warp)))
        throw Error('变形网格发生折叠或退化');
      if(layer.maskGradient!==undefined)checkGradient(layer.maskGradient,checkStroke,true);
      if(layer.maskWarpSteps!==undefined&&(!Array.isArray(layer.maskWarpSteps)||!layer.maskWarpSteps.every(validMaskWarpStep))||
         !validMaskWarpIndex(layer.maskGradient?.maskWarpIndex,layer))throw Error('蒙版变形参数无效');
      if(layer.maskDensity!==undefined&&!unit(layer.maskDensity)||
         layer.maskFeather!==undefined&&(!Number.isFinite(layer.maskFeather)||layer.maskFeather<0||layer.maskFeather>maxUVFeather))
        throw Error('蒙版密度或羽化无效');
      if((layer.maskLinked!==undefined&&typeof layer.maskLinked!=='boolean')||
         (layer.maskTransform!==undefined&&!validMaskTransform(layer.maskTransform)))
        throw Error('蒙版链接或变换无效');
      if(layer.textOrigin!==undefined&&(!layer.text||!pair(layer.textOrigin,n=>Number.isFinite(n)&&n>=0&&n<=8192)))
        throw Error('文字锚点无效');
      if(layer.text!==undefined&&(layer.kind!=='image'||!validateText?.(layer.text)))throw Error('图像文字参数无效');
      if(layer.kind==='image'&&!Object.hasOwn(paint.assets,layer.asset))throw Error('图像素材无效');
      if(['image','shape'].includes(layer.kind)&&(![layer.x,layer.y,layer.scale,layer.rotation].every(Number.isFinite)||Math.abs(layer.x)>8||Math.abs(layer.y)>8||layer.scale<1/4096||layer.scale>4||Math.abs(layer.rotation)>360||!Array.isArray(layer.stretch)||layer.stretch.length!==2||!layer.stretch.every(n=>Number.isFinite(n)&&Math.abs(n)>=.05&&Math.abs(n)<=8)))throw Error('图像层变换无效');
      for(const [field,mask] of [['strokes',false],['maskStrokes',true]]){
        const strokes=layer[field]??[];if(!Array.isArray(strokes)||field==='strokes'&&layer.kind!=='pixel'&&strokes.length)throw Error('图像笔触无效');
        function validateStroke(stroke){
          if(!record(stroke))throw Error('图像笔触无效');
          if(stroke.preserveAlpha!==undefined&&(stroke.preserveAlpha!==true||mask||stroke.erase!==false))
            throw Error('锁定透明度的笔触无效');
          if(!ownsCoverage(stroke.coverage)||!ownsCoverage(stroke.transformUV?.coverage))throw Error('笔触选区覆盖图不存在');
          if(stroke.transformUV){if(!exact(stroke,['transformUV'])||mask)throw Error('图像变换无效');checkedUVTransform(stroke.transformUV,true);}
          else if(stroke.clearUV){if(!exact(stroke,['clearUV','cut',...uvShapeFields])||mask||stroke.cut!==undefined&&stroke.cut!==true)throw Error('图像清除无效');checkStroke({uv:true,rect:stroke.clearUV,...uvShapePayload(stroke),opacity:1,value:0},true,true);}
          else if(stroke.flood!==undefined){
            const fill=stroke.flood;
            if(mask||!exact(stroke,['uv','flood','opacity','clip',...uvShapeFields,'color','erase','preserveAlpha'])||
              stroke.uv!==true||stroke.erase!==false||!ink(stroke.color)||!unit(stroke.opacity)||
              !exact(fill,['point','tolerance','contiguous'])||!pair(fill.point,unit)||
              !Number.isInteger(fill.tolerance)||fill.tolerance<0||fill.tolerance>255||typeof fill.contiguous!=='boolean')
              throw Error('油漆桶填充参数无效');
            if(stroke.clip!==undefined||uvShapeFields.some(key=>Object.hasOwn(stroke,key)))
              checkStroke({uv:true,rect:stroke.clip,...uvShapePayload(stroke),opacity:1,value:0},true,true);
          }
          else{
            const keys=['uv','radius','hardness','opacity','flow','spacing','pressureMode','stamps','breaks','tip','clone','clip',...uvShapeFields,'rect',...(mask?['value','maskSpace','maskWarpIndex']:['color','erase','preserveAlpha'])];
            if(!exact(stroke,keys)||stroke.uv!==true||!mask&&!ink(stroke.color))throw Error('图像只接受二维 RGB 笔触');
            if(stroke.maskSpace!==undefined&&!validMaskTransform(stroke.maskSpace))throw Error('蒙版笔触变换无效');
            if(!validMaskWarpIndex(stroke.maskWarpIndex,layer))throw Error('蒙版笔触变形位置无效');
            if([stroke.tip?.tipAsset,stroke.tip?.textureAsset].some(asset=>asset!==undefined&&!layer.brushSources?.includes(asset)))
              throw Error('笔刷图片不存在');
            if(stroke.clone!==undefined&&(mask||stroke.rect!==undefined||stroke.erase!==false||
              !exact(stroke.clone,['offset','asset','kind','backdrop'])||!pair(stroke.clone.offset,n=>Number.isFinite(n)&&n>=-1&&n<=1)||
              ![undefined,'heal','spot'].includes(stroke.clone.kind)||
              stroke.clone.kind!==undefined&&stroke.clone.asset===undefined||
              (stroke.clone.kind==='heal')!==(stroke.clone.backdrop!==undefined)||
              [stroke.clone.asset,stroke.clone.backdrop].some(asset=>asset!==undefined&&!layer.cloneSources?.includes(asset))))
              throw Error('仿制源偏移无效');
            const {maskSpace,maskWarpIndex,...inkStroke}=stroke;
            checkStroke(imageStrokeToMaterial(inkStroke,mask),mask,true);
          }
        }
        for(const stroke of strokes){
          if(isStrokeBlock(stroke)){
            checkStrokeBlock(stroke,{mask});
            if(unpackStrokeBlock)for(const item of unpackStrokeBlock(stroke,{mask}))validateStroke(item);
          }else{
            validateStroke(stroke);
            stamps+=stroke.stamps?.length??1;
          }
        }
      }
    }
    validateImageLayerTree(doc.layers);
  }
  if(checkPending&&stamps>60000)throw Error('待压实的图像笔触过多，请分批保存');
  for(const layer of paint.layers){
    if(layer.documentMaps===undefined)continue;
    if(!exact(layer.documentMaps,paintChannels))throw Error('图像文档引用无效');
    if(!Object.keys(layer.documentMaps).length)continue;
    if(layer.kind!=='fill'||Object.values(layer.documentMaps).some(key=>!id(key)||!Object.hasOwn(documents,key)))throw Error('图像文档只能绑定到填充层的通道');
  }
}
function duplicateImageName(documents,source){
  const names=new Set(Object.values(documents).map(doc=>doc.name));
  const candidate=suffix=>source.slice(0,100-suffix.length).trimEnd()+suffix;
  let number=1,name=candidate(' 副本');
  while(names.has(name))name=candidate(' 副本 '+(++number));
  return name;
}
function imageGroupName(layers){
  const names=new Set(layers.map(layer=>layer.name));
  let name=layerNames.group,count=1;
  while(names.has(name))name=layerNames.group+' '+(++count);
  return name;
}
export function imageCoverageSources(o){
  return [o.coverage,o.stroke?.coverage,o.transform?.coverage,o.patch?.coverage,o.patch?.gradient?.coverage,o.patch?.maskGradient?.coverage]
    .filter(value=>value!==undefined);
}
function retainCoverage(layer,sources){
  if(sources.length)layer.selectionSources=[...new Set([...(layer.selectionSources??[]),...sources])];
}
export function imageDocumentOperation(paint,o,{requireUnlocked}){
  if(!exact(o,['op','action','documentId','newDocumentId','layerId','layerIds','copyIds','parentId','anchorId','placement','sourceLayerId','reveal','copy','clipped','patch','kind','target','stroke','transform','transforms','rect',...uvShapeFields,'index','channel','materialLayerId','newLayerId'])||!id(o.documentId))throw Error('图像文档命令无效');
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
  if(o.action==='saveSelection'||o.action==='deleteSelection'){
    const save=o.action==='saveSelection';
    if(!exact(o,['op','action','documentId','patch'])||!exact(o.patch,save?['name','rect',...uvShapeFields,'outline']:['name'])||
       !label(o.patch.name))throw Error('请输入选区名称');
    const name=o.patch.name.trim();
    const index=(doc.selections??[]).findIndex(selection=>selection.name===name);
    if(save){
      if(index!==-1)throw Error('已有同名选区，请使用其他名称');
      (doc.selections??=[]).push({...structuredClone(o.patch),name});
    }else{
      if(index===-1)throw Error('选区不存在');
      doc.selections.splice(index,1);
      if(!doc.selections.length)delete doc.selections;
    }
    return;
  }
  if(o.action==='savePath'||o.action==='deletePath'){
    const save=o.action==='savePath';
    if(!exact(o.patch,save?['id','name','geometry']:['id'])||!id(o.patch.id)||
       save&&(!label(o.patch.name)||!validPenPath(o.patch.geometry)))throw Error('路径参数无效');
    const index=(doc.paths??[]).findIndex(path=>path.id===o.patch.id);
    if(save){
      const value=structuredClone(o.patch);
      if(index===-1)(doc.paths??=[]).push(value);
      else doc.paths[index]=value;
    }else{
      if(index===-1)throw Error('路径不存在');
      doc.paths.splice(index,1);
      if(!doc.paths.length)delete doc.paths;
    }
    return;
  }
  if(o.action==='remove'){
    if(paint.layers.some(l=>Object.values(l.documentMaps??{}).includes(o.documentId)))throw Error('图像文档仍被材质引用，请先解除绑定');delete documents[o.documentId];return;
  }
  if(o.action==='bind'){
    if(!paintChannels.includes(o.channel))throw Error('请选择材质通道');
    let layer=paint.layers.find(l=>l.id===o.materialLayerId);
    if(o.materialLayerId&&!layer)throw Error('材质图层不存在');
    if(!layer){if(!id(o.newLayerId)||paint.layers.some(l=>l.id===o.newLayerId))throw Error('新材质图层编号无效');layer={id:o.newLayerId,kind:'fill',name:doc.name,visible:true,opacity:1,blend:'normal',channels:{color:false,metallic:false,roughness:false},values:{color:'#808080',metallic:0,roughness:.5},x:.5,y:.5,scale:1,rotation:0,mask:null};paint.layers.push(layer);}
    requireUnlocked(paint.layers,layer);if(layer.kind!=='fill')throw Error('请选择填充层');
    layer.documentMaps={...layer.documentMaps,[o.channel]:o.documentId};layer.channels[o.channel]=true;if(layer.maps)delete layer.maps[o.channel];return;
  }
  if(o.action==='addLayer'){
    let index=o.index??doc.layers.length;
    if(!id(o.layerId)||doc.layers.some(l=>l.id===o.layerId)||typeof o.kind!=='string'||!Object.hasOwn(layerNames,o.kind)||!exact(o.patch??{},layerFields)||
       !Number.isInteger(index)||index<0||index>doc.layers.length)throw Error('图像图层参数无效');
    const parent=imageGroupTarget(doc.layers,o.parentId)?.id??null;
    const defaults=['image','shape'].includes(o.kind)?{x:.5,y:.5,scale:1,rotation:0,stretch:[1,1]}:
      o.kind==='adjustment'?{maskEnabled:true}:o.kind==='group'?{blend:imageGroupBlend}:{};
    const next=doc.layers.slice(index).find(layer=>layerParent(layer)===parent);
    if(o.kind==='group'&&next?.clipped)
      index=doc.layers.indexOf(followingClips(doc.layers,next).at(-1)??next)+1;
    const clipped=o.kind!=='group'&&next?.clipped&&imageClippingBase(doc.layers,doc.layers.indexOf(next));
    const name=o.kind==='group'?imageGroupName(doc.layers):layerNames[o.kind];
    const layer={id:o.layerId,kind:o.kind,name,...imageLayerDefaults,...defaults,
      ...(parent?{parentId:parent}:{}),...(clipped?{clipped:true}:{}),...o.patch};
    retainCoverage(layer,imageCoverageSources(o));
    doc.layers.splice(index,0,layer);
    return;
  }
  if(o.action==='groupLayers'){
    if(!id(o.layerId)||doc.layers.some(l=>l.id===o.layerId)||!exact(o.patch??{},['name']))throw Error('新图层组参数无效');
    groupImageLayers(doc,o.layerIds,{id:o.layerId,kind:'group',name:imageGroupName(doc.layers),...imageLayerDefaults,blend:imageGroupBlend,...o.patch});
    return;
  }
  const batchFields=['op','action','documentId','layerIds'];
  if(o.action==='layoutLayers'){
    if(!exact(o,['op','action','documentId','transforms'])||!Array.isArray(o.transforms)||!o.transforms.length||
       o.transforms.length>doc.layers.length)throw Error('请选择要变换的图层');
    const moved=new Set();
    for(const transform of o.transforms){
      if(!exact(transform,['layerIds','pivot','offset','scale','angle'])||
         !pair(transform.pivot,n=>Number.isFinite(n)&&Math.abs(n)<=8)||
         !pair(transform.offset,n=>Number.isFinite(n)&&Math.abs(n)<=8)||
         !Number.isFinite(transform.scale)||transform.scale<.05||transform.scale>8||
         !Number.isFinite(transform.angle)||Math.abs(transform.angle)>360)
        throw Error('图层变换参数无效');
      const {targets,masks}=imageLayoutTargets(doc.layers,transform.layerIds);
      for(const layer of new Set([...targets,...masks])){
        if(moved.has(layer.id))throw Error('同一图层只能变换一次');
        moved.add(layer.id);
      }
      for(const layer of masks)moveLayerMask(layer,transform);
      for(const layer of targets){
        if(layer.kind==='pixel'){
          (layer.strokes??=[]).push({transformUV:{rect:[0,0,1,1],pivot:transform.pivot,offset:transform.offset,
            scale:[transform.scale,transform.scale],angle:transform.angle,interpolation:'linear'}});
        }else if(layer.kind==='gradient'){
          layer.gradientTransform=transformImageSpace(layer.gradientTransform,transform);
        }else{
          [layer.x,layer.y]=layoutPoint([layer.x,layer.y],transform);
          layer.scale*=transform.scale;
          layer.rotation=((layer.rotation+transform.angle+180)%360+360)%360-180;
        }
      }
    }
    return;
  }
  if(o.action==='moveLayers'){
    if(!exact(o,[...batchFields,'anchorId','placement']))throw Error('图层移动参数无效');
    const plan=planImageLayerMove(doc.layers,o.layerIds,o);
    if(!plan.changed)throw Error('图层顺序没有变化');
    doc.layers=plan.layers;return;
  }
  if(o.action==='duplicateLayers'){
    if(!exact(o,[...batchFields,'copyIds']))throw Error('图层复制参数无效');
    doc.layers=duplicateImageLayerBatch(doc.layers,o.layerIds,o.copyIds);return;
  }
  if(o.action==='removeLayers'){
    if(!exact(o,batchFields))throw Error('图层删除参数无效');
    doc.layers=planImageLayerDelete(doc.layers,o.layerIds).layers;return;
  }
  const index=doc.layers.findIndex(l=>l.id===o.layerId),layer=doc.layers[index];if(!layer)throw Error('图像图层不存在');
  const owner=layerLockOwner(doc.layers,layer);
  if(owner&&!(owner===layer&&o.action==='updateLayer'&&Object.keys(o.patch??{}).every(k=>['locked','visible'].includes(k))))
    throw Object.assign(Error('图像图层或上级组已锁定'),{status:423});
  retainCoverage(layer,imageCoverageSources(o));
  if(o.action==='updateLayer'){
    if(!exact(o.patch,layerFields)||Object.hasOwn(o.patch,'clipped'))throw Error('图像图层参数无效');
    if(Object.hasOwn(o.patch,'asset')&&o.patch.asset!==layer.asset){
      delete layer.text;delete layer.textOrigin;
    }
    // An empty mask still exists after it is disabled.
    if(layer.maskEnabled&&o.patch.maskEnabled===false)layer.maskStrokes??=[];
    const previous={...layer};
    Object.assign(layer,o.patch);
    if(layer.maskGradient===null)delete layer.maskGradient;
    if(layer.warp===null)delete layer.warp;
    if(layer.styles===null)delete layer.styles;
    if(layer.edgeDecontaminate===null)delete layer.edgeDecontaminate;
    if(layer.blendIf===null)delete layer.blendIf;
    retainMaskTransform(layer,previous);
    if(Object.hasOwn(o.patch,'warp')&&(previous.maskGradient||previous.maskStrokes?.length)){
      if(layer.warp!==undefined&&!validImageWarp(layer.warp))throw Error('变形网格发生折叠或退化');
      retainMaskWarp(layer,previous,paint.assets);
    }
    if(o.patch.maskGradient&&record(layer.maskGradient)){
      const gradient={...layer.maskGradient};
      if(layer.maskTransform)gradient.maskSpace??=[...layer.maskTransform];
      if(layer.maskWarpSteps?.length)gradient.maskWarpIndex??=layer.maskWarpSteps.length;
      layer.maskGradient=gradient;
    }
  }
  else if(o.action==='transformMask'){
    const {transform}=o;
    if(!hasImageLayerMask(layer)||layer.maskLinked!==false)throw Error('请先解除蒙版与图层的链接');
    if(!exact(transform,['pivot','offset','scale','angle'])||!pair(transform.pivot,unit)||
       !pair(transform.offset,n=>Number.isFinite(n)&&Math.abs(n)<=2)||
       !pair(transform.scale,n=>Number.isFinite(n)&&Math.abs(n)>=.05&&Math.abs(n)<=8)||
       !Number.isFinite(transform.angle)||Math.abs(transform.angle)>360)throw Error('蒙版变换参数无效');
    moveLayerMask(layer,transform);
  }
  else if(o.action==='setClipping'){
    if(typeof o.clipped!=='boolean')throw Error('请选择创建或释放剪贴蒙版');
    if(o.clipped){
      if(!imageClippingBase(doc.layers,index))throw Error('剪贴蒙版需要下方的底层');
      layer.clipped=true;
    }else if(layer.clipped)for(const item of [layer,...followingClips(doc.layers,layer)])delete item.clipped;
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
    if(layerLockOwner(doc.layers,source)&&!o.copy)throw Object.assign(Error('源图层或上级组已锁定'),{status:423});
    clearImageLayerMask(layer);
    layer.maskEnabled=source.maskEnabled;
    layer.maskBase=source.maskBase;
    if(source.maskStrokes)layer.maskStrokes=structuredClone(source.maskStrokes);
    if(source.maskGradient)layer.maskGradient=structuredClone(source.maskGradient);
    if(source.maskDensity!==undefined)layer.maskDensity=source.maskDensity;
    if(source.maskFeather!==undefined)layer.maskFeather=source.maskFeather;
    if(source.maskLinked!==undefined)layer.maskLinked=source.maskLinked;
    if(source.maskTransform)layer.maskTransform=[...source.maskTransform];
    if(source.maskWarpSteps)layer.maskWarpSteps=structuredClone(source.maskWarpSteps);
    retainCoverage(layer,source.selectionSources??[]);
    if(source.brushSources?.length)layer.brushSources=[...new Set([...(layer.brushSources??[]),...source.brushSources])];
    if(!o.copy)clearImageLayerMask(source);
  }
  else if(o.action==='invertMask'||o.action==='removeMask'){
    if(!hasImageLayerMask(layer))throw Error('图像图层没有蒙版');
    if(o.action==='invertMask'){
      layer.maskBase=1-layer.maskBase;
      if(layer.maskGradient)layer.maskGradient.colors=layer.maskGradient.colors.map(color=>
        '#'+(255-parseInt(color.slice(1,3),16)).toString(16).padStart(2,'0').repeat(3));
      for(const stroke of layer.maskStrokes??[]){
        if(isStrokeBlock(stroke)){
          if(stroke.inverted)delete stroke.inverted;else stroke.inverted=true;
        }else stroke.value=1-stroke.value;
      }
    }else clearImageLayerMask(layer);
  }
  else if(o.action==='removeLayer')removeImageLayer(doc,layer);
  else if(o.action==='ungroupLayer')ungroupImageLayer(doc,layer);
  else if(o.action==='duplicateLayer'){
    if(!id(o.patch?.id)||doc.layers.some(l=>l.id===o.patch.id))throw Error('图像副本编号无效');
    duplicateImageLayer(doc,layer,o.patch.id);
  }
  else if(o.action==='moveLayer'){
    if(o.anchorId!==undefined||o.placement!==undefined){arrangeImageLayer(doc,layer,o);return;}
    if(!Number.isInteger(o.index)||o.index<0||o.index>=doc.layers.length)throw Error('图像层序无效');
    if(doc.layers.some(item=>item.kind==='group'))throw Error('图层组内请指定相邻图层');
    if(o.index===index)return;
    doc.layers.splice(index,1);
    if(doc.layers[o.index]?.clipped&&imageClippingBase(doc.layers,o.index))layer.clipped=true;
    doc.layers.splice(o.index,0,layer);
    repairImageClips(doc.layers);
  }
  else if(o.action==='stroke'){
    if(!['pixels','mask'].includes(o.target)||o.target==='pixels'&&layer.kind!=='pixel')throw Error('请在像素层或蒙版上绘制');
    if(!record(o.stroke)||isStrokeBlock(o.stroke)||['preserveAlpha','maskSpace','maskWarpIndex'].some(key=>Object.hasOwn(o.stroke,key)))
      throw Error('图像笔触参数无效');
    const stroke=structuredClone(o.stroke),mask=o.target==='mask';
    if(mask){
      layer.maskEnabled=true;
      if(layer.maskTransform)stroke.maskSpace=[...layer.maskTransform];
      if(layer.maskWarpSteps?.length)stroke.maskWarpIndex=layer.maskWarpSteps.length;
    }
    else if(layer.alphaLocked){
      if(stroke.erase)throw Error('请先解锁透明像素再擦除');
      stroke.preserveAlpha=true;
    }
    for(const source of [stroke.clone?.asset,stroke.clone?.backdrop]){
      if(source===undefined)continue;
      if(!cloneAsset(source))throw Error('像素取样源无效');
      const sources=layer.cloneSources??=[];
      if(!sources.includes(source))sources.push(source);
    }
    for(const source of [stroke.tip?.tipAsset,stroke.tip?.textureAsset]){
      if(source===undefined)continue;
      if(!cloneAsset(source)||!isBrushImage(paint.assets[source]))throw Error('请选择工程中的笔刷图片');
      const sources=layer.brushSources??=[];
      if(!sources.includes(source))sources.push(source);
    }
    (layer[mask?'maskStrokes':'strokes']??=[]).push(stroke);
  }else if(['transform','clear','cutPixels'].includes(o.action)){
    if(layer.kind!=='pixel')throw Error('请选择像素层');
    if(layer.alphaLocked)throw Error('请先解锁透明像素再清除或变换');
    (layer.strokes??=[]).push(o.action==='transform'?{transformUV:structuredClone(o.transform)}:
      {clearUV:o.rect,...uvShapePayload(o),...(o.action==='cutPixels'?{cut:true}:{})});
    const transform=o.action==='transform'&&o.transform;
    if(transform&&layer.maskLinked!==false&&hasImageLayerMask(layer)&&!transform.copy&&!transform.coverage&&
       !transform.polygon&&!transform.regions&&!transform.feather&&transform.rect?.join()==='0,0,1,1')
      moveLayerMask(layer,{...transform,pivot:transform.pivot??[.5,.5]});
  }else throw Error('不支持的图像命令');
}
