// Independent RGBA image documents. Material layers reference their composite by ID.
import {paintChannels} from './paint-channels.mjs';
const record=o=>o&&typeof o==='object'&&!Array.isArray(o),id=s=>typeof s==='string'&&/^[\w-]{1,100}$/.test(s),unit=n=>Number.isFinite(n)&&n>=0&&n<=1;
const exact=(o,keys)=>record(o)&&Object.keys(o).every(k=>keys.includes(k));
const label=s=>typeof s==='string'&&!!s.trim()&&s.length<=100;
const ink=s=>typeof s==='string'&&/^#[a-f\d]{6}$/i.test(s);
const layerFields=['name','visible','locked','opacity','blend','maskEnabled','maskBase','asset','x','y','scale','rotation','stretch'];
export const imageLayerDefaults={visible:true,locked:false,opacity:1,blend:'normal',maskEnabled:false,maskBase:1};
export const hasImageLayerMask=layer=>!!layer&&(layer.maskEnabled||Array.isArray(layer.maskStrokes));
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
  if(op.op==='clearUV')return {op:'image',action:'clear',documentId,layerId:op.id,rect:op.rect,...(op.polygon?{polygon:op.polygon}:{})};
  throw Error('图像编辑命令无效');
}
export function validateImageDocuments(paint,{checkStroke,checkedUVTransform,validateText}){
  const documents=paint.imageDocuments??{};
  if(!record(documents)||Object.keys(documents).length>16)throw Error('工程最多包含 16 个图像文档');
  let stamps=0;
  for(const [key,doc] of Object.entries(documents)){
    if(!id(key)||!exact(doc,['name','width','height','colorSpace','layers'])||!label(doc.name)||doc.width!==4096||doc.height!==4096||!['srgb','linear'].includes(doc.colorSpace)||!Array.isArray(doc.layers)||doc.layers.length>64)throw Error('图像文档无效');
    const ids=new Set();
    for(const layer of doc.layers){
      if(!exact(layer,['id','kind',...layerFields,'strokes','maskStrokes','text'])||!id(layer.id)||ids.has(layer.id)||!['pixel','image'].includes(layer.kind)||!label(layer.name)||typeof layer.visible!=='boolean'||typeof layer.locked!=='boolean'||!unit(layer.opacity)||!['normal','multiply','screen','overlay'].includes(layer.blend)||typeof layer.maskEnabled!=='boolean'||!unit(layer.maskBase))throw Error('图像图层无效');
      ids.add(layer.id);
      if(layer.text!==undefined&&(layer.kind!=='image'||!validateText?.(layer.text)))throw Error('图像文字参数无效');
      if(layer.kind==='image'&&(!Object.hasOwn(paint.assets,layer.asset)||![layer.x,layer.y,layer.scale,layer.rotation].every(Number.isFinite)||!unit(layer.x)||!unit(layer.y)||layer.scale<1/4096||layer.scale>4||Math.abs(layer.rotation)>360||!Array.isArray(layer.stretch)||layer.stretch.length!==2||!layer.stretch.every(n=>Number.isFinite(n)&&Math.abs(n)>=.05&&Math.abs(n)<=8)))throw Error('图像层素材或变换无效');
      for(const [field,mask] of [['strokes',false],['maskStrokes',true]]){
        const strokes=layer[field]??[];if(!Array.isArray(strokes)||strokes.length>400||field==='strokes'&&layer.kind==='image'&&strokes.length)throw Error('图像笔触无效');
        for(const stroke of strokes){
          if(!record(stroke))throw Error('图像笔触无效');
          if(stroke.transformUV){if(!exact(stroke,['transformUV'])||mask)throw Error('图像变换无效');checkedUVTransform(stroke.transformUV);}
          else if(stroke.clearUV){if(!exact(stroke,['clearUV','polygon'])||mask)throw Error('图像清除无效');checkStroke({uv:true,rect:stroke.clearUV,...(stroke.polygon?{polygon:stroke.polygon}:{}),opacity:1,value:0},true);}
          else{
            const keys=['uv','radius','hardness','opacity','stamps','clip','polygon','rect',...(mask?['value']:['color','erase'])];
            if(!exact(stroke,keys)||stroke.uv!==true||!mask&&!ink(stroke.color))throw Error('图像只接受二维 RGB 笔触');
            checkStroke(imageStrokeToMaterial(stroke,mask),mask);
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
export function imageDocumentOperation(paint,o,{requireUnlocked}){
  if(!exact(o,['op','action','documentId','layerId','patch','kind','target','stroke','transform','rect','polygon','index','channel','materialLayerId','newLayerId'])||!id(o.documentId))throw Error('图像文档命令无效');
  const documents=paint.imageDocuments??={},doc=Object.hasOwn(documents,o.documentId)?documents[o.documentId]:null;
  if(o.action==='create'){
    if(doc||!exact(o.patch??{},['name','colorSpace']))throw Error('图像文档已存在或参数无效');
    paint.imageDocuments={...documents,[o.documentId]:{name:'未命名贴图',width:4096,height:4096,colorSpace:'srgb',...o.patch,layers:[]}};return;
  }
  if(!doc)throw Error('图像文档不存在');
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
    if(!id(o.layerId)||doc.layers.some(l=>l.id===o.layerId)||!['pixel','image'].includes(o.kind)||!exact(o.patch??{},layerFields))throw Error('图像图层参数无效');
    doc.layers.push({id:o.layerId,kind:o.kind,name:o.kind==='pixel'?'像素层':'图像层',...imageLayerDefaults,...(o.kind==='image'?{x:.5,y:.5,scale:1,rotation:0,stretch:[1,1]}:{}),...o.patch});return;
  }
  const index=doc.layers.findIndex(l=>l.id===o.layerId),layer=doc.layers[index];if(!layer)throw Error('图像图层不存在');
  if(layer.locked&&!(o.action==='updateLayer'&&Object.keys(o.patch??{}).every(k=>['locked','visible'].includes(k))))throw Object.assign(Error('图像图层已锁定'),{status:423});
  if(o.action==='updateLayer'){
    if(!exact(o.patch,layerFields))throw Error('图像图层参数无效');
    if(Object.hasOwn(o.patch,'asset')&&o.patch.asset!==layer.asset)delete layer.text;
    // An empty mask still exists after it is disabled.
    if(layer.maskEnabled&&o.patch.maskEnabled===false)layer.maskStrokes??=[];
    Object.assign(layer,o.patch);
  }
  else if(o.action==='removeLayer')doc.layers.splice(index,1);
  else if(o.action==='duplicateLayer'){if(!id(o.patch?.id)||doc.layers.some(l=>l.id===o.patch.id))throw Error('图像副本编号无效');doc.layers.splice(index+1,0,{...structuredClone(layer),id:o.patch.id,name:(layer.name.slice(0,90)+' 副本')});}
  else if(o.action==='moveLayer'){if(!Number.isInteger(o.index)||o.index<0||o.index>=doc.layers.length)throw Error('图像层序无效');doc.layers.splice(index,1);doc.layers.splice(o.index,0,layer);}
  else if(o.action==='stroke'){
    if(!['pixels','mask'].includes(o.target)||o.target==='pixels'&&layer.kind!=='pixel')throw Error('请在像素层或蒙版上绘制');
    const key=o.target==='mask'?'maskStrokes':'strokes';if(o.target==='mask')layer.maskEnabled=true;(layer[key]??=[]).push(structuredClone(o.stroke));
  }else if(o.action==='transform'||o.action==='clear'){
    if(layer.kind!=='pixel')throw Error('请选择像素层');(layer.strokes??=[]).push(o.action==='transform'?{transformUV:structuredClone(o.transform)}:{clearUV:o.rect,...(o.polygon?{polygon:o.polygon}:{})});
  }else throw Error('不支持的图像命令');
}
