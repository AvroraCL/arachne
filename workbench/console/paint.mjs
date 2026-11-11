import {validateImageDocuments,imageDocumentOperation} from './public/image-documents.mjs';
import {validateObjectNames} from './public/scene-object-names.mjs';
import {paintChannels,legacyChannels,channelSpecs,activePaintChannels} from './public/paint-channels.mjs';
import {validateLibraries,libraryOperation,compileLibraryMaterial} from './public/paint-library.mjs';
import {compileMaterialGraph} from './public/material-graph.mjs';
import {pinSurfaceInputs,validateSurfaceBindings} from './paint-surface-bindings.mjs';
import {modelFingerprint,validateModelState,preparePaintGeometry} from './project-model.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {sha256File} from './file-fingerprint.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual,promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {crc32} from 'node:zlib';
import {ROOT,list,read,commit,forkProject,projectDir,hash,atomic} from './store.mjs';
import {bindingFingerprint,demoProjectId as defaultSource} from './demo-source.mjs';
import {cyclesOptions} from './cycles-options.mjs';
import {pngSizeIs,validateCyclesOutput} from './cycles-output.mjs';
import {blenderExecutable,blenderScriptArgs} from './blender-runtime.mjs';
import {cyclesProgressReader} from './cycles-progress.mjs';
import {checkRenderAppearance,matchesRenderAppearance} from './public/render-appearance.mjs';
import {checkRenderLighting} from './public/render-lighting.mjs';
import {checkRenderPreset} from './public/paint-delivery-options.mjs';
import {matchesCyclesLightPaths} from './public/cycles-light-paths.mjs';
import {checkRenderVisibility,updateRenderVisibility} from './public/render-visibility.mjs';
import {checkRenderOptics,matchesRenderOptics} from './public/render-optics.mjs';
import {checkRenderRegion,renderRegionPixels} from './public/render-region.mjs';
import {layerParent,layerChildren,layerTreeOrder,layerLockOwner} from './public/paint-layer-tree.mjs';

export const PAINT='pbr_paint';
const archiveFormat='arachne-pbr-paint-project';
const channels=paintChannels;
const values={color:'#262a30',metallic:0,roughness:.46};
const paintTextures=channels.map(k=>channelSpecs[k].file);
const legacyTextures=legacyChannels.map(k=>channelSpecs[k].file);
const extendedPaint=doc=>activePaintChannels(doc.paint).length>3;
const sha256=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const unit=n=>Number.isFinite(n)&&n>=0&&n<=1;
const color=s=>typeof s==='string'&&/^#[0-9a-f]{6}$/i.test(s);
const asset=(doc,id)=>typeof id==='string'&&Object.hasOwn(doc.paint.assets,id)?doc.paint.assets[id]:null;
const assetPath=(doc,id)=>path.join(projectDir(doc.id),'assets',asset(doc,id).file);
const fields=(patch,keys)=>{
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!keys.includes(k)))throw Error('不支持的属性');
  return patch;
};
const blendModes=['normal','multiply','screen','overlay'];
const folderFields=['name','visible','locked'];
const layerFields=[...folderFields,'opacity','channelOpacity','channels','values','x','y','scale','rotation','image','mask','maskBase','maskEnabled','maskEffects','blend','maps','tiling','projector','space','uvScale','materialId','documentMaps'];
const revisionError=doc=>Object.assign(Error('工程修订已变化'),{status:409,currentRevision:doc.revision});
const materialValues=v=>v&&legacyChannels.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>channels.includes(k)&&(channelSpecs[k].type==='color'?color(v[k]):unit(v[k])));
const channelFlags=v=>v&&legacyChannels.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>channels.includes(k)&&typeof v[k]==='boolean');
const vector=(v,length,limit)=>Array.isArray(v)&&v.length===length&&v.every(n=>Number.isFinite(n)&&Math.abs(n)<=limit);
const normal=v=>vector(v,3,2)&&Math.hypot(...v)>.1;
const ranged=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
function checkedText(value){
  const {content,color:ink,fontSize,weight,align}=fields(value,['content','color','fontSize','weight','align']);
  const text=typeof content==='string'?content.replace(/\r\n?/g,'\n'):'';
  if(!text.trim()||text.length>480||text.split('\n').length>12||
     /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text)||!color(ink)||
     !Number.isInteger(fontSize)||!ranged(fontSize,16,512)||![400,700].includes(weight)||!['left','center','right'].includes(align))
    throw Error('文字参数无效，支持 16–512 像素、最多 12 行和 480 个字符');
  return {content:text,color:ink,fontSize,weight,align};
}
function textLayerName(style){return '文字 · '+style.content.trim().split('\n')[0].trim().slice(0,80);}
function checkMaskEffects(effects){
  if(!Array.isArray(effects)||effects.length>12)throw Error('蒙版效果栈最多包含 12 项');
  for(const effect of effects){
    const common=['kind','enabled','opacity'];
    if(!effect||typeof effect.enabled!=='boolean'||!unit(effect.opacity))throw Error('蒙版效果参数无效');
    if(effect.kind==='invert')fields(effect,common);
    else if(effect.kind==='levels'){
      fields(effect,[...common,'black','white','gamma']);
      if(!unit(effect.black)||!unit(effect.white)||effect.white-effect.black<.0001||!ranged(effect.gamma,.1,5))
        throw Error('色阶需要有效的黑点、白点和中间调');
    }else if(['height','facing'].includes(effect.kind)){
      fields(effect,[...common,'axis','center','feather','blend']);
      if(!['x','-x','y','-y','z','-z'].includes(effect.axis)||!unit(effect.center)||
         !ranged(effect.feather,.01,1)||!['replace','multiply'].includes(effect.blend))
        throw Error('几何蒙版参数无效');
    }else throw Error('不支持的蒙版效果');
  }
}
function checkProjector(p){
  fields(p,['center','normal','up','size','depth','rotation']);
  if(!vector(p.center,3,1000)||!normal(p.normal)||!normal(p.up)||
     Math.abs(p.normal.reduce((sum,n,i)=>sum+n*p.up[i],0)/(Math.hypot(...p.normal)*Math.hypot(...p.up)))>.999||
     !ranged(p.size,.02,40)||!ranged(p.depth,.005,15)||!ranged(p.rotation,-36000,36000))
    throw Error('三维投影变换无效');
}
function validUVRect(rect){
  return vector(rect,4,1)&&rect.every(unit)&&rect[2]-rect[0]>=1/4096&&rect[3]-rect[1]>=1/4096;
}
function validUVPolygon(polygon,rect){
  if(polygon===undefined)return true;
  if(!validUVRect(rect)||!Array.isArray(polygon)||polygon.length<3||polygon.length>256)return false;
  const [left,top,right,bottom]=rect,tolerance=1e-9;
  return polygon.every(point=>vector(point,2,1)&&point.every(unit)&&
    ranged(point[0],left-tolerance,right+tolerance)&&ranged(point[1],top-tolerance,bottom+tolerance));
}
function validBrushStamp(stamp,uv){
  if(!Array.isArray(stamp))return false;
  if(uv)return [2,3].includes(stamp.length)&&stamp.every(unit);
  return (stamp.length===6||stamp.length===7&&unit(stamp[6]))&&
    vector(stamp.slice(0,6),6,1000)&&normal(stamp.slice(3,6));
}
function checkStroke(s,isMask){
  if(isMask&&s?.region!==undefined){
    fields(s,['region','hit','value','opacity','surfaceBinding']);
    if(!['triangle','polygon','mesh','island'].includes(s.region)||!vector(s.hit,6,1000)||
       !normal(s.hit.slice(3))||!unit(s.value)||!unit(s.opacity))throw Error('蒙版填充区域无效');
    return;
  }
  const inkFields=isMask?['value']:['channels','values','erase'];
  const validInk=stroke=>isMask?unit(stroke.value):
    channelFlags(stroke.channels)&&materialValues(stroke.values)&&typeof stroke.erase==='boolean';
  if(s?.rect!==undefined){
    fields(s,['uv','rect','polygon','opacity',...inkFields]);
    if(s.uv!==true||!validUVRect(s.rect)||!validUVPolygon(s.polygon,s.rect)||!unit(s.opacity)||!validInk(s))
      throw Error('选区填充参数无效');
    return;
  }
  fields(s,['radius','hardness','opacity','stamps','mirrorX','uv','clip','polygon','surfaceBinding',...inkFields]);
  const uv=s.uv===true;
  if((s.uv!==undefined&&!uv)||(uv&&s.mirrorX!==undefined)||
     (s.clip!==undefined&&(!uv||!validUVRect(s.clip)))||!validUVPolygon(s.polygon,s.clip)||
     !(uv?ranged(s.radius,1/4096,.125):ranged(s.radius,.01,2))||
     !unit(s.hardness)||!unit(s.opacity)||!Array.isArray(s.stamps)||!s.stamps.length||s.stamps.length>1024||
     s.stamps.some(stamp=>!validBrushStamp(stamp,uv))||
     (s.mirrorX!==undefined&&typeof s.mirrorX!=='boolean')||
     !validInk(s))
    throw Error('表面笔触参数无效');
}
async function verifyRegisteredFiles(doc,{signal}={}){
  for(const [file,expected] of Object.entries(doc.source.files))
    if(await sha256File(file,{signal})!==expected)throw Error('模型、UV缓存或登记输入已改变：'+path.basename(file));
}
async function checkRegisteredSource(doc,options){
  if(doc.source.material!=='f_16xl'||doc.source.bindingVersion!==2)throw Error('请选择已登记的示例模型');
  await verifyRegisteredFiles(doc,options);
}
function paintTemplate(doc,paint){
  doc.workflowType=PAINT;doc.layers=[];doc.assets={};doc.fonts={};doc.guides={};
  delete doc.design;delete doc.imageWorkflow;delete doc.modeling;
  doc.paint=paint;
  return doc;
}
export async function createPaint({sourceProjectId=defaultSource,name='示例模型 · PBR 涂装'}){
  let doc;
  try{doc=read(sourceProjectId);}
  catch(error){if(error.code!=='ENOENT')throw error;throw Error('示例模型尚未生成，请先运行 npm run seed:demo');}
  await checkRegisteredSource(doc);
  paintTemplate(doc,{base:{...values},layers:[],assets:{}});
  return forkProject(sourceProjectId,doc,(typeof name==='string'?name.trim().slice(0,100):'')||'示例模型 · PBR 涂装');
}
function checkedRenderCamera(value){
  fields(value,['projection','eye','target','up','fov','orthoHeight']);
  return cyclesOptions({camera:value}).camera;
}
function validate(doc){
  validateObjectNames(doc.paint.objectNames);
  if(doc.paint.renderVisibility!==undefined)checkRenderVisibility(doc.paint.renderVisibility);
  if(doc.paint.renderCamera!==undefined)checkedRenderCamera(doc.paint.renderCamera);
  if(doc.paint.renderAppearance!==undefined)checkRenderAppearance(doc.paint.renderAppearance);
  if(doc.paint.renderLighting!==undefined)checkRenderLighting(doc.paint.renderLighting);
  if(doc.paint.renderOptics!==undefined)checkRenderOptics(doc.paint.renderOptics);
  if(doc.paint.renderRegion!==undefined)checkRenderRegion(doc.paint.renderRegion);
  if(doc.paint.renderPreset!==undefined){
    checkRenderPreset(doc.paint.renderPreset);
    if(doc.paint.renderPreset.framing==='saved'&&!doc.paint.renderCamera)throw Error('工程渲染预设需要已保存的相机');
  }
  validateSurfaceBindings(doc.paint);
  validateLibraries(doc.paint);
  validateImageDocuments(doc.paint,{checkStroke,checkedUVTransform,validateText:value=>isDeepStrictEqual(checkedText(value),value)});
  compileMaterialGraph(doc.paint.materialGraph,doc.paint.assets);
  if(doc.paint.baseChannels!==undefined&&Object.values(fields(doc.paint.baseChannels,channels)).some(v=>typeof v!=='boolean'))throw Error('底层通道开关无效');
  if(!materialValues(doc.paint.base)||doc.paint.layers.length>64)throw Error('底层或图层数量无效');
  const layers=doc.paint.layers,byId=new Map(layers.map(l=>[l.id,l]));
  if(byId.size!==layers.length)throw Error('图层编号重复');
  let stampCount=0;
  for(const l of layers){
    if(typeof l.name!=='string'||!l.name.trim()||l.name.length>100||typeof l.visible!=='boolean'||
       l.locked!==undefined&&typeof l.locked!=='boolean')throw Error('图层属性无效');
    let parent=layerParent(l),depth=0;
    while(parent!==null){
      const group=byId.get(parent);
      if(group?.kind!=='group'||++depth>6)throw Error('文件夹归属无效或超过 6 层');
      parent=layerParent(group);
    }
    if(l.materialId!=null&&(l.kind!=='fill'||typeof l.materialId!=='string'||!Object.hasOwn(doc.paint.materials??{},l.materialId)))throw Error('填充层引用的材质不存在');
    if(l.kind==='group')continue;
    if(!['fill','decal','paint'].includes(l.kind)||
       !(l.blend===undefined||blendModes.includes(l.blend))||!unit(l.opacity)||!materialValues(l.values)||
       !channelFlags(l.channels))throw Error('图层属性无效');
    if(l.kind==='decal'&&(!asset(doc,l.image)||![l.x,l.y,l.scale,l.rotation].every(Number.isFinite)||
       !unit(l.x)||!unit(l.y)||l.scale<.01||l.scale>4))throw Error('贴花素材或变换无效');
    if(l.space!==undefined&&(l.kind!=='decal'||l.space!=='uv'||l.projector!=null))throw Error('画布图片须使用 UV 坐标');
    if(l.uvScale!==undefined&&(l.space!=='uv'||!vector(l.uvScale,2,8)||!l.uvScale.every(n=>Math.abs(n)>=.05)))
      throw Error('画布图片缩放无效');
    if(l.text!==undefined&&(l.space!=='uv'||!isDeepStrictEqual(checkedText(l.text),l.text)))
      throw Error('文字层属性无效');
    if(l.mask!==null&&!asset(doc,l.mask))throw Error('蒙版素材不存在');
    if(l.maskBase!==undefined&&!unit(l.maskBase)||
       l.maskEnabled!==undefined&&typeof l.maskEnabled!=='boolean')throw Error('蒙版底色或启用状态无效');
    if(l.maskEffects!==undefined)checkMaskEffects(l.maskEffects);
    if(l.projector!=null){
      if(l.kind!=='decal')throw Error('三维投影仅适用于贴花');
      checkProjector(l.projector);
    }
    for(const key of ['strokes','maskStrokes'])for(const stroke of l[key]||[])
      stampCount+=(stroke.stamps?.length??1)*(stroke.mirrorX?2:1);
    if(l.channelOpacity!==undefined&&Object.values(fields(l.channelOpacity,channels)).some(n=>!unit(n)))
      throw Error('通道不透明度须为 0 至 1');
    if(l.maps!==undefined){
      if(l.kind==='paint')throw Error('绘制层的通道由笔触写入');
      const maps=fields(l.maps,l.kind==='fill'?channels:channels.filter(k=>k!=='color'));
      if(Object.values(maps).some(id=>!asset(doc,id)))throw Error('属性贴图素材不存在');
    }
    if(l.tiling!=null){
      if(l.kind!=='fill')throw Error('平铺仅适用于填充层');
      const {repeat,rotation,offsetX,offsetY}=fields(l.tiling,['repeat','rotation','offsetX','offsetY']);
      if(![repeat,rotation,offsetX,offsetY].every(Number.isFinite)||repeat<1||repeat>32||
        Math.abs(rotation)>360||Math.abs(offsetX)>1||Math.abs(offsetY)>1)throw Error('平铺参数无效');
    }
  }
  if(stampCount>30000)throw Error('工程笔触超出首版上限');
}
function makeFolder(patch,parentId){
  return {id:crypto.randomUUID(),kind:'group',name:'文件夹',visible:true,parentId,
    ...fields(patch??{},folderFields)};
}
const lockedError=owner=>Object.assign(Error('「'+owner.name+'」已锁定'),{status:423});
function requireUnlocked(layers,...items){
  for(const item of items){
    const owner=layerLockOwner(layers,item);
    if(owner)throw lockedError(owner);
  }
}
function siblingSelection(layers,{id,ids=[id]}){
  if(!Array.isArray(ids)||!ids.length||ids.length>64||new Set(ids).size!==ids.length)throw Error('图层选择无效');
  const items=layers.filter(layer=>ids.includes(layer.id));
  if(items.length!==ids.length||items.some(item=>layerParent(item)!==layerParent(items[0])))
    throw Error('请选择同一文件夹内的图层');
  return items;
}
function arrangeLayers(layers,items,{parentId=null,anchorId=null,placement}){
  const selected=new Set(items.map(item=>item.id));
  if(!['above','below'].includes(placement)||selected.has(anchorId))throw Error('放置位置无效');
  const anchor=anchorId===null?null:layers.find(layer=>layer.id===anchorId);
  if(anchorId!==null&&(!anchor||layerParent(anchor)!==parentId))throw Error('放置目标不在指定文件夹');
  const folder=parentId===null?null:layers.find(layer=>layer.id===parentId&&layer.kind==='group');
  if(parentId!==null&&!folder)throw Error('文件夹不存在');
  requireUnlocked(layers,folder,...items);
  for(let parent=parentId;parent!==null;){
    if(selected.has(parent))throw Error('不能把文件夹放进自己的子级');
    const folder=layers.find(layer=>layer.id===parent);
    if(!folder)throw Error('文件夹归属无效');
    parent=layerParent(folder);
  }
  const remaining=layers.filter(layer=>!selected.has(layer.id)),siblings=layerChildren(remaining,parentId);
  for(const item of items)item.parentId=parentId;
  let at;
  if(anchor)at=remaining.indexOf(anchor)+(placement==='above'?1:0);
  else if(placement==='below'&&siblings.length)at=remaining.indexOf(siblings[0]);
  else at=remaining.length;
  remaining.splice(at,0,...items);
  return remaining;
}
function checkedUVTransform(value){
  const {rect,polygon,offset,scale,angle,copy,interpolation}=
    fields(value,['rect','polygon','offset','scale','angle','copy','interpolation']);
  if(!validUVRect(rect)||!validUVPolygon(polygon,rect)||
     !vector(offset,2,2)||!vector(scale,2,8)||!scale.every(n=>Math.abs(n)>=.05)||!ranged(angle,-360,360)||
     (copy!==undefined&&typeof copy!=='boolean')||
     (interpolation!==undefined&&!['linear','nearest'].includes(interpolation)))
    throw Error('选区变换参数无效');
  return {rect,polygon,offset,scale,angle,copy,interpolation};
}
function applyOperations(next,operations,sourceVisibility){
  if(!Array.isArray(operations)||!operations.length||operations.length>128)throw Error('需要 1–128 条制作命令');
  const p=next.paint,reproject=[];
  for(const o of operations){
    const {op,id,patch}=o;
    if(op==='renameObjects'){validateObjectNames(o.names);if(!o.names||!Object.keys(o.names).length)throw Error('请选择物体');p.objectNames={...p.objectNames,...o.names};continue;}
    if(op==='renderVisibility'){
      fields(o,['op','visibility']);
      const visibility=updateRenderVisibility(sourceVisibility,p.renderVisibility,o.visibility);
      if(Object.keys(visibility).length)p.renderVisibility=visibility;else delete p.renderVisibility;
      continue;
    }
    if(op==='renderCamera'){
      fields(o,['op','camera']);
      if(o.camera===null){
        delete p.renderCamera;
        if(p.renderPreset?.framing==='saved')p.renderPreset={...p.renderPreset,framing:'auto'};
      }
      else p.renderCamera=checkedRenderCamera(o.camera);
      continue;
    }
    if(op==='renderAppearance'){
      fields(o,['op','appearance']);
      if(o.appearance===null)delete p.renderAppearance;
      else p.renderAppearance=checkRenderAppearance(o.appearance);
      continue;
    }
    if(op==='renderLighting'){
      fields(o,['op','lighting']);
      if(o.lighting===null)delete p.renderLighting;
      else p.renderLighting=checkRenderLighting(o.lighting);
      continue;
    }
    if(op==='renderOptics'){
      fields(o,['op','optics']);
      if(o.optics===null)delete p.renderOptics;
      else p.renderOptics=checkRenderOptics(o.optics);
      continue;
    }
    if(op==='renderRegion'){
      fields(o,['op','region']);
      if(o.region===null)delete p.renderRegion;
      else p.renderRegion=checkRenderRegion(o.region);
      continue;
    }
    if(op==='renderPreset'){
      fields(o,['op','preset']);
      if(o.preset===null)delete p.renderPreset;
      else p.renderPreset=checkRenderPreset(o.preset);
      continue;
    }
    if(op==='image'){imageDocumentOperation(p,o,{requireUnlocked});continue;}
    if(op==='library'){libraryOperation(p,o);continue;}
    if(op==='shader'){if(o.graph===undefined)throw Error('请提供完整节点材质或 null');compileMaterialGraph(o.graph,p.assets);if(o.graph==null)delete p.materialGraph;else p.materialGraph=structuredClone(o.graph);continue;}
    if(op==='baseChannels'){p.baseChannels={...p.baseChannels,...fields(patch,channels)};continue;}
    if(op==='base'){Object.assign(p.base,fields(patch,channels));continue;}
    if(op==='add'){
      requireUnlocked(p.layers,p.layers.find(item=>item.id===o.parentId));
      if(o.kind==='group'){p.layers.push(makeFolder(patch,o.parentId??null));continue;}
      p.layers.push({name:{fill:'填充层',decal:'贴花层',paint:'绘制层'}[o.kind],visible:true,opacity:1,blend:'normal',
        channels:{color:true,metallic:o.kind==='paint',roughness:o.kind==='paint'},values:{...values},
        x:.5,y:.5,scale:1,rotation:0,mask:null,...fields(patch??{},layerFields),kind:o.kind,id:crypto.randomUUID(),
        ...(o.parentId!=null?{parentId:o.parentId}:{})});
      continue;
    }
    if(op==='group'){
      const items=siblingSelection(p.layers,o);
      requireUnlocked(p.layers,...items);
      const folder=makeFolder(patch,layerParent(items[0]));
      for(const item of items)item.parentId=folder.id;
      p.layers.splice(p.layers.indexOf(items.at(-1)),0,folder);
      continue;
    }
    if(op==='arrange'){
      p.layers=arrangeLayers(p.layers,siblingSelection(p.layers,o),o);
      continue;
    }
    const i=p.layers.findIndex(l=>l.id===id);
    if(i<0)throw Error('图层不存在');
    const item=p.layers[i];
    if(op==='duplicate')requireUnlocked(p.layers,p.layers.find(layer=>layer.id===layerParent(item)));
    else if(op!=='update')requireUnlocked(p.layers,item);
    if(op==='remove'){
      const children=layerChildren(p.layers,id);
      for(const child of children)child.parentId=layerParent(item);
      // Insert lifted children where the folder was, even after a batched reparent.
      const insertion=p.layers.slice(0,i).filter(l=>!children.includes(l)).length;
      p.layers=p.layers.filter(l=>l!==item&&!children.includes(l));
      p.layers.splice(insertion,0,...children);
    }
    else if(op==='duplicate'){
      const subtree=[item,...(item.kind==='group'?layerTreeOrder(p.layers,id):[])];
      const ids=new Map(subtree.map(layer=>[layer.id,crypto.randomUUID()]));
      const copies=subtree.map(layer=>{
        const copy=structuredClone(layer);
        copy.id=ids.get(layer.id);
        if(layer===item)copy.name=copy.name.slice(0,95)+' · 副本';
        else copy.parentId=ids.get(layerParent(layer));
        return copy;
      });
      p.layers.splice(i+1,0,...copies);
    }
    else if(op==='move'){
      if(!Number.isInteger(o.index)||o.index<0||o.index>=p.layers.length)throw Error('层序无效');
      p.layers.splice(o.index,0,p.layers.splice(i,1)[0]);
    }else if(op==='update'){
      const changes=fields(patch,item.kind==='group'?folderFields:layerFields);
      const owner=layerLockOwner(p.layers,item);
      if(owner&&Object.keys(changes).some(key=>key!=='visible'&&(key!=='locked'||owner!==item)))throw lockedError(owner);
      if(item.text&&Object.hasOwn(changes,'image')&&changes.image!==item.image)delete item.text;
      if(item.kind==='decal'&&Object.keys(changes).some(key=>['projector','x','y','scale','rotation','space','uvScale'].includes(key)))reproject.push(item.id);
      Object.assign(item,changes);
    }else if(op==='transformUV'||op==='clearUV'){
      if(item.kind!=='paint'||!item.strokes?.length)throw Error('请选择已有笔触的绘制层');
      if(item.strokes.length>=400)throw Error('此图层的笔触数量达到首版上限');
      if(op==='clearUV'){
        if(!validUVRect(o.rect)||!validUVPolygon(o.polygon,o.rect))throw Error('选区参数无效');
        item.strokes.push({clearUV:o.rect,...(o.polygon?{polygon:o.polygon}:{})});
        continue;
      }
      const {rect,polygon,offset,scale,angle,copy,interpolation='linear'}=checkedUVTransform(o.transform);
      item.strokes.push({transformUV:{rect,...(polygon?{polygon}:{}),offset,scale,angle,interpolation,...(copy?{copy:true}:{})}});
    }else if(op==='stroke'){
      if(item.kind==='group')throw Error('请选择文件夹内的图层进行绘制');
      if(!['material','mask'].includes(o.target))throw Error('请选择材质或蒙版作为笔触目标');
      const isMask=o.target==='mask',layer=p.layers[i];
      if(!isMask&&layer.kind!=='paint')throw Error('请在绘制层上绘制材质');
      checkStroke(o.stroke,isMask);
      const key=isMask?'maskStrokes':'strokes';
      layer[key]??=[];
      if(layer[key].length>=400)throw Error('此图层的笔触数量达到首版上限');
      layer[key].push(o.stroke);
    }else throw Error('制作命令无效');
  }
  pinSurfaceInputs(next,{reproject});
  validate(next);
  p.layers=layerTreeOrder(p.layers);
  return next;
}
export function editPaint(doc,{revision,operations},sourceVisibility){
  if(doc.revision!==revision)throw revisionError(doc);
  return commit(doc.id,revision,next=>applyOperations(next,operations,sourceVisibility),Array.isArray(operations)?operations.map(o=>({
    op:o?.op,id:o?.id,...(Array.isArray(o?.ids)?{ids:o.ids}:{})
  })):[]);
}
function paintBinding(doc){const model=modelFingerprint(doc);return model?crypto.createHash('sha256').update(JSON.stringify([bindingFingerprint(doc),model])).digest('hex'):bindingFingerprint(doc);}
let compositorFingerprint;
export function paintBakeFingerprint(doc,binding=paintBinding(doc)){
  compositorFingerprint??=crypto.createHash('sha256').update(JSON.stringify([
    'paint_worker.py','paint_channels.py','paint_surface.py','material_graph.py','image_documents.py','project_model.py','model-binding.mjs',
    '../tools/geometry.py','../tools/prepare_guides.py','../tools/projection_scope.py','../tools/uv_raster.py','../tools/view_select.py'
  ].map(file=>hash(path.join(ROOT,file))))).digest('hex');
  const {objectNames,renderCamera,renderAppearance,renderLighting,renderOptics,renderPreset,renderRegion,renderVisibility,...content}=doc.paint;
  return crypto.createHash('sha256').update(JSON.stringify([compositorFingerprint,binding,content])).digest('hex');
}
export function materialFingerprint(doc){
  const plan=compileMaterialGraph(doc.paint.materialGraph,doc.paint.assets),fills=fillMaterialPlans(doc),bindings=doc.paint.layers.filter(l=>Object.keys(l.documentMaps??{}).length).map(l=>({id:l.id,documentMaps:l.documentMaps}));
  let input=Object.keys(fills).length?{output:plan,fills}:plan;
  if(bindings.length){const ids=[...new Set(bindings.flatMap(l=>Object.values(l.documentMaps)))].sort();input={output:plan,fills,bindings,imageDocuments:Object.fromEntries(ids.map(id=>[id,doc.paint.imageDocuments[id]]))};}
  return input?crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'):undefined;
}
function fillMaterialPlans(doc){return Object.fromEntries([...new Set(doc.paint.layers.filter(layer=>layer.materialId).map(layer=>layer.materialId))].sort().map(id=>[id,compileLibraryMaterial(doc.paint.materials[id].graph,doc.paint.assets)]));}
export function paintInput(doc,binding=paintBinding(doc)){
  return {activeChannels:activePaintChannels(doc.paint),fillMaterialPlans:fillMaterialPlans(doc),materialPlan:compileMaterialGraph(doc.paint.materialGraph,doc.paint.assets),materialFingerprint:materialFingerprint(doc),source:doc.source,paint:doc.paint,revision:doc.revision,bindingFingerprint:binding,...(modelFingerprint(doc)?{modelFingerprint:modelFingerprint(doc)}:{}),
    assets:Object.fromEntries(Object.keys(doc.paint.assets).map(id=>[id,assetPath(doc,id)]))};
}
function liveOperationAllowed(doc,operation){
  if(operation.op==='image')return ['stroke','transform','clear','updateLayer'].includes(operation.action);
  if(operation.op==='shader')return true;
  if(operation.op==='library')return operation.library==='materials'&&operation.action==='update'&&Object.hasOwn(doc.paint.materials??{},operation.id);
  if(['stroke','transformUV'].includes(operation.op))return true;
  const keys=Object.keys(operation.patch||{});
  if(!keys.length)return false;
  if(operation.op==='baseChannels')return keys.every(key=>channels.includes(key));
  if(operation.op==='base')return keys.every(key=>channels.includes(key));
  if(operation.op!=='update')return false;
  const item=doc.paint.layers.find(layer=>layer.id===operation.id);
  if(!item||item.kind==='group')return false;
  const allowed=['opacity','values'];
  if(item.kind==='decal'){
    if(item.projector)allowed.push('projector');
    else allowed.push('x','y','scale','rotation',...(item.space==='uv'?['uvScale']:[]));
  }
  return keys.every(key=>allowed.includes(key));
}
export function livePaintInput(doc,{revision,operation,inspectMask,isolatedLayer,pickUv,uvGuide,rawLayer=false,resolution=256,format='legacy'}){
  if(doc.revision!==revision)throw revisionError(doc);
  if(!['legacy','pbr8'].includes(format))throw Error('实时贴图格式无效');
  if(typeof rawLayer!=='boolean'||rawLayer&&(operation||inspectMask||isolatedLayer===undefined||resolution!==256||pickUv!==undefined))throw Error('图层缩略图仅支持已保存的单层 256px 预览');
  if(pickUv!==undefined){
    if(!Array.isArray(pickUv)||pickUv.length!==2||!pickUv.every(unit))throw Error('表面 UV 坐标无效');
    return {...paintInput(doc),pickUv};
  }
  if(operation&&!liveOperationAllowed(doc,operation))
    throw Error('实时预览仅接受笔触、变换或材质参数');
  if(![256,512,4096].includes(resolution))throw Error('实时预览分辨率无效');
  if(resolution===4096&&operation)throw Error('4K 实时预览仅接受已保存的工程修订');
  const next=operation?applyOperations(structuredClone(doc),[operation]):doc;
  if(inspectMask&&!next.paint.layers.some(l=>l.id===inspectMask&&l.kind!=='group'))throw Error('蒙版图层不存在');
  if(isolatedLayer!==undefined&&(inspectMask||!next.paint.layers.some(l=>l.id===isolatedLayer)))throw Error('独显图层无效');
  const input=paintInput(next);
  if(rawLayer){input.paint={...input.paint,base:{color:'#383838',metallic:0,roughness:.5}};delete input.paint.baseChannels;delete input.paint.materialGraph;input.materialPlan=null;delete input.materialFingerprint;}
  return {...input,inspectMask,isolatedLayer,uvGuide:uvGuide===true,liveResolution:resolution,liveFormat:format};
}
export function imageDocumentInput(doc,{revision,documentId,operation,inspectMask,isolatedImageLayer,resolution=256}){
  if(doc.revision!==revision)throw revisionError(doc);
  if(![64,128,256,512,4096].includes(resolution)||resolution===4096&&operation)throw Error('图像预览尺寸无效');
  if(operation&&(operation.op!=='image'||operation.documentId!==documentId||!liveOperationAllowed(doc,operation)))throw Error('图像预览目标无效');
  const next=operation?applyOperations(structuredClone(doc),[operation]):doc;
  if(!Object.hasOwn(next.paint.imageDocuments??{},documentId))throw Error('图像文档不存在');
  const image=next.paint.imageDocuments[documentId];
  if(isolatedImageLayer&&!image.layers.some(layer=>layer.id===isolatedImageLayer))throw Error('图像图层不存在');
  if(inspectMask&&!image.layers.some(layer=>layer.id===inspectMask))throw Error('图像蒙版不存在');

  const selected=isolatedImageLayer?image.layers.filter(layer=>layer.id===isolatedImageLayer):image.layers;
  const layers=inspectMask
    ?selected.filter(layer=>layer.id===inspectMask).map(({id,maskBase,maskStrokes})=>({id,maskBase,maskStrokes}))
    :selected.filter(layer=>layer.visible&&layer.opacity>0);
  const assetIds=new Set(inspectMask?[]:layers.filter(layer=>layer.kind==='image').map(layer=>layer.asset));
  return {
    paint:{imageDocuments:{[documentId]:{colorSpace:image.colorSpace,layers}}},
    assets:Object.fromEntries([...assetIds].map(id=>[id,assetPath(next,id)])),
    revision:next.revision,
    imageDocumentId:documentId,
    imageInspectMask:inspectMask,
    liveResolution:resolution,
    liveFormat:'rgba'
  };
}
function completePng(bytes){
  if(bytes.length<45||!bytes.subarray(0,8).equals(pngSignature)||
     bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR'||
     ![bytes.readUInt32BE(16),bytes.readUInt32BE(20)].every(n=>n>0&&n<=8192))return false;
  let imageData=false;
  for(let offset=8;offset+12<=bytes.length;){
    const length=bytes.readUInt32BE(offset),end=offset+8+length;
    if(end+4>bytes.length||crc32(bytes.subarray(offset+4,end))!==bytes.readUInt32BE(end))return false;
    const type=bytes.toString('ascii',offset+4,offset+8);
    if(type==='IDAT'&&length)imageData=true;
    if(type==='IEND')return length===0&&imageData&&end+4===bytes.length;
    offset=end+4;
  }
  return false;
}
function describePng(doc,bytes,name){
  if(bytes.length>24*1024*1024||!completePng(bytes))throw Error('素材须为完整的 PNG，且不超过 24 MiB 和 8192 像素宽高');
  const id=crypto.createHash('sha256').update(bytes).digest('hex'),file='paint-'+id+'.png';
  const existing=asset(doc,id),label=String(name||'PNG').trim().slice(0,100)||'PNG';
  const dimensions={width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  const entry={...(existing||{id,file,sha256:id,name:label}),...dimensions};
  return {entry,existing,label,bytes};
}
function ensurePaintAsset(doc,{entry,existing,bytes}){
  if(entry.file!=='paint-'+entry.id+'.png')throw Error('涂装素材路径无效');
  const destination=path.join(projectDir(doc.id),'assets',entry.file);
  if(existing){
    try{if(hash(destination)===entry.id)return;}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const temporary=destination+'.'+crypto.randomUUID()+'.tmp';
  try{
    fs.writeFileSync(temporary,bytes,{flag:'wx'});
    fs.renameSync(temporary,destination);
  }finally{
    if(fs.existsSync(temporary))fs.unlinkSync(temporary);
  }
}
function writePaintAsset(doc,revision,png,summary,update){
  const {entry}=png;
  const document=commit(doc.id,revision,p=>{
    p.paint.assets[entry.id]=entry;
    update(p);
    ensurePaintAsset(doc,png);
    return p;
  },summary);
  return {document,asset:entry};
}
export function importPaint(doc,{revision,name,data,maskLayerId,placement,nodeId,materialId,imageLayer}){
  if(doc.revision!==revision)throw revisionError(doc);
  const image=imageLayer===undefined?null:fields(imageLayer,['documentId','layerId','x','y']);
  if(image&&(image.x!==undefined||image.y!==undefined)&&(!unit(image.x)||!unit(image.y)))throw Error('图像图层放置参数无效');
  if(image&&(maskLayerId!==undefined||placement!==undefined||nodeId!==undefined||materialId!==undefined))throw Error('请选择单个图像导入目标');
  if(materialId!==undefined&&(typeof materialId!=='string'||!Object.hasOwn(doc.paint.materials??{},materialId)||nodeId===undefined))throw Error('节点材质不存在');
  const targetGraph=materialId===undefined?doc.paint.materialGraph:doc.paint.materials[materialId].graph;
  const imageNode=nodeId===undefined?null:targetGraph?.nodes.find(node=>node.id===nodeId&&node.type==='image');
  if(nodeId!==undefined&&(!imageNode||maskLayerId!==undefined||placement!==undefined))throw Error('请选择单个图像节点导入 PNG');
  const place=placement===undefined?null:fields(placement,['x','y','parentId']);
  if(place&&(!unit(place.x)||!unit(place.y)||maskLayerId!==undefined))throw Error('画布图片放置参数无效');
  const target=maskLayerId===undefined?null:doc.paint.layers.find(layer=>layer.id===maskLayerId&&layer.kind!=='group');
  if(maskLayerId!==undefined&&!target)throw Error('蒙版图层不存在');
  requireUnlocked(doc.paint.layers,target);
  const png=describePng(doc,typeof data==='string'?Buffer.from(data,'base64'):Buffer.alloc(0),name);
  const {entry,existing,label}=png;
  if(existing&&!image&&!place&&(!target||target.mask===entry.id)&&(!imageNode||imageNode.params.asset===entry.id)){
    ensurePaintAsset(doc,png);
    return {document:doc,asset:entry};
  }
  return writePaintAsset(doc,revision,png,image?'导入图像图层':place?'导入并放置画布图片':target?'保存图层蒙版':imageNode?'导入节点图像':'导入涂装素材',p=>{
    if(imageNode){(materialId===undefined?p.paint.materialGraph:p.paint.materials[materialId].graph).nodes.find(node=>node.id===nodeId).params.asset=entry.id;validate(p);}
    if(target)p.paint.layers.find(layer=>layer.id===target.id).mask=entry.id;
    if(image)applyOperations(p,[{op:'image',action:'addLayer',documentId:image.documentId,layerId:image.layerId,kind:'image',patch:{asset:entry.id,name:label,...(image.x===undefined?{}:{x:image.x,y:image.y})}}]);
    if(place)applyOperations(p,[{op:'add',kind:'decal',parentId:place.parentId,patch:{
      image:entry.id,name:label,space:'uv',x:place.x,y:place.y,scale:.25
    }}]);
  });
}
const renderTextFile=promisify(execFile);
export async function savePaintText(doc,{revision,text,placement,layerId,documentId}){
  if(doc.revision!==revision)throw revisionError(doc);
  const style=checkedText(text);
  const inImage=documentId!==undefined,documents=doc.paint.imageDocuments??{};
  if(inImage&&(typeof documentId!=='string'||!Object.hasOwn(documents,documentId)))throw Error('图像文档不存在');
  const layers=inImage?documents[documentId].layers:doc.paint.layers,assetField=inImage?'asset':'image';
  const target=layerId===undefined?null:layers.find(item=>item.id===layerId&&item.text);
  if(layerId!==undefined&&!target)throw Error('请选择可编辑的文字层');
  requireUnlocked(layers,target);
  const place=placement===undefined?null:fields(placement,inImage?['x','y']:['x','y','parentId']);
  if((target&&place)||(!target&&(!place||!unit(place.x)||!unit(place.y))))throw Error('文字放置位置无效');
  const scratch=fs.mkdtempSync(path.join(projectDir(doc.id),'assets','.text-'));
  let bytes;
  try{
    const input=path.join(scratch,'text.json'),output=path.join(scratch,'text.png');
    fs.writeFileSync(input,JSON.stringify(style));
    try{
      await renderTextFile(process.env.ARACHNE_PYTHON||'python',['-X','utf8',path.join(ROOT,'paint_text.py'),
        input,path.join(ROOT,'public','SourceHanSansSC-VF.ttf'),output],{windowsHide:true,timeout:10_000,maxBuffer:256*1024});
    }catch(error){
      throw Error(error.stderr?.trim().split(/\r?\n/).at(-1)||'无法生成文字贴图');
    }
    bytes=fs.readFileSync(output);
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
  const current=read(doc.id);
  if(current.revision!==revision)throw revisionError(current);
  const name=textLayerName(style),png=describePng(current,bytes,name+'.png'),{entry}=png;
  const edge=Math.max(bytes.readUInt32BE(16),bytes.readUInt32BE(20));
  if(target&&target[assetField]===entry.id&&isDeepStrictEqual(target.text,style)){
    ensurePaintAsset(current,png);
    return {document:current,asset:entry,layerId};
  }
  let selected=layerId;
  const result=writePaintAsset(current,revision,png,target?'编辑文字层':'添加文字层',p=>{
    const currentLayers=inImage?p.paint.imageDocuments[documentId].layers:p.paint.layers;
    const existingLayer=target&&currentLayers.find(item=>item.id===layerId);
    if(existingLayer){
      const old=asset(p,existingLayer[assetField]);
      const prior=Math.max(old.width,old.height);
      existingLayer.scale=Math.max(.01,Math.min(4,existingLayer.scale*edge/prior));
      if(existingLayer.name===textLayerName(existingLayer.text))existingLayer.name=name;
      existingLayer[assetField]=entry.id;
      existingLayer.text=style;
    }else if(inImage){
      selected=crypto.randomUUID();
      applyOperations(p,[{op:'image',action:'addLayer',documentId,layerId:selected,kind:'image',patch:{
        asset:entry.id,name,x:place.x,y:place.y,scale:Math.max(.01,edge/4096)
      }}]);
      currentLayers.at(-1).text=style;
    }else{
      const known=new Set(p.paint.layers.map(item=>item.id));
      applyOperations(p,[{op:'add',kind:'decal',parentId:place.parentId,patch:{
        image:entry.id,name,space:'uv',x:place.x,y:place.y,scale:Math.max(.01,edge/4096)
      }}]);
      const layer=p.paint.layers.find(item=>!known.has(item.id));
      layer.text=style;
      selected=layer.id;
    }
    validate(p);
  });
  return {...result,layerId:selected};
}
export async function verifyPaint(doc,{signal}={}){
  await verifyRegisteredFiles(doc,{signal});
  for(const id of Object.keys(doc.paint.assets))
    if(await sha256File(assetPath(doc,id),{signal})!==id)throw Error('涂装素材指纹变化');
  if(doc.modeling)validateModelState(doc.modeling);
  return paintBinding(doc);
}
function registrationFingerprint(source){
  const role=file=>{
    for(const key of ['reviewSource','baseImage','finImage','finMapping'])if(file===source[key])return key;
    for(const [key,prefix] of [['bundle','guide'],['cacheRun','cache']]){
      const relative=path.relative(source[key],file);
      if(relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep))
        return prefix+'/'+relative.split(path.sep).join('/');
    }
    return 'registered/'+path.basename(file);
  };
  const files=Object.entries(source.files).map(([file,digest])=>[role(file),digest]);
  files.sort(([a,x],[b,y])=>a<b?-1:a>b?1:x<y?-1:x>y?1:0);
  return crypto.createHash('sha256').update(JSON.stringify({
    material:source.material,bindingVersion:source.bindingVersion,files
  })).digest('hex');
}
function validateRestoredLayers(layers){
  if(!Array.isArray(layers)||layers.length>64)throw Error('图层数量无效');
  const validId=id=>typeof id==='string'&&/^[\w-]{1,100}$/.test(id);
  for(const layer of layers){
    const common=['id','kind','parentId'];
    fields(layer,layer?.kind==='group'?[...common,...folderFields]:[...common,...layerFields,'strokes','maskStrokes','text','surfaceBinding']);
    if(!validId(layer.id)||(layer.parentId!=null&&!validId(layer.parentId)))throw Error('图层编号无效');
    for(const key of ['strokes','maskStrokes']){
      if(layer[key]===undefined)continue;
      const isMask=key==='maskStrokes';
      if((!isMask&&layer.kind!=='paint')||!Array.isArray(layer[key])||layer[key].length>400)
        throw Error('图层笔触无效');
      for(const stroke of layer[key]){
        if(!isMask&&stroke?.transformUV!==undefined){
          fields(stroke,['transformUV']);
          checkedUVTransform(stroke.transformUV);
        }else if(!isMask&&stroke?.clearUV!==undefined){
          fields(stroke,['clearUV','polygon']);
          if(!validUVRect(stroke.clearUV)||!validUVPolygon(stroke.polygon,stroke.clearUV))throw Error('选区参数无效');
        }else checkStroke(stroke,isMask);
      }
    }
  }
}
export async function restorePaint(archive,scratch){
  const folder=path.join(scratch,'editable');
  fs.mkdirSync(folder);
  try{
    await renderTextFile(process.env.ARACHNE_PYTHON||'python',
      ['-X','utf8',path.join(ROOT,'paint_archive.py'),'unpack',archive,folder],
      {windowsHide:true,timeout:120_000,maxBuffer:256*1024});
  }catch(error){
    const reason=error.stderr?.trim().split(/\r?\n/).at(-1);
    throw Error(reason&&/^[\u4e00-\u9fff]/.test(reason)?reason:'无法读取涂装 ZIP');
  }
  const manifest=fields(JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8')),
    ['format','version','name','revision','previewId','geometry','paint','modeling']);
  const geometry=fields(manifest.geometry,['material','modelSha256','uvSha256','registrationSha256','editedModelSha256','modelFingerprint']);
  const projectOnly=manifest.format===archiveFormat;
  if(typeof manifest.name!=='string'||!manifest.name.trim()||manifest.name.length>100||
     !Number.isSafeInteger(manifest.revision)||manifest.revision<0||
     geometry.material!=='f_16xl'||!sha256(geometry.modelSha256)||!sha256(geometry.registrationSha256)||
     (!projectOnly&&(typeof manifest.previewId!=='string'||!/^[\w-]{1,100}$/.test(manifest.previewId)||
       !sha256(geometry.uvSha256))))
    throw Error('涂装 ZIP 的可编辑清单无效');
  const {base,baseChannels,layers,assets,surfaceBindings,materialGraph,materials,brushes,imageDocuments,objectNames,renderCamera,renderAppearance,renderLighting,renderOptics,renderPreset,renderRegion,renderVisibility}=fields(manifest.paint,['base','baseChannels','layers','assets','surfaceBindings','materialGraph','materials','brushes','imageDocuments','objectNames','renderCamera','renderAppearance','renderLighting','renderOptics','renderPreset','renderRegion','renderVisibility']);
  validateRestoredLayers(layers);
  const paint={base,...(imageDocuments?{imageDocuments}:{}),...(baseChannels!==undefined?{baseChannels}:{}),layers,assets:{},...(materials?{materials}:{}),...(brushes?{brushes}:{}),...(materialGraph?{materialGraph}:{}),...(surfaceBindings?{surfaceBindings}:{})};
  for(const [id,item] of Object.entries(assets)){
    fields(item,['name','path','sha256']);
    if(!sha256(id)||item.sha256!==id||typeof item.name!=='string'||!item.name.trim()||item.name.length>100)
      throw Error('交付包素材记录无效');
    const file=path.join(folder,'paint-'+id+'.png');
    const png=describePng({paint},fs.readFileSync(file),item.name);
    if(png.entry.id!==id)throw Error('交付包素材指纹变化');
    paint.assets[id]=png.entry;
  }
  if(objectNames!==undefined){validateObjectNames(objectNames);paint.objectNames=objectNames;}
  if(renderCamera!==undefined)paint.renderCamera=checkedRenderCamera(renderCamera);
  if(renderAppearance!==undefined)paint.renderAppearance=checkRenderAppearance(renderAppearance);
  if(renderLighting!==undefined)paint.renderLighting=checkRenderLighting(renderLighting);
  if(renderOptics!==undefined)paint.renderOptics=checkRenderOptics(renderOptics);
  if(renderRegion!==undefined)paint.renderRegion=checkRenderRegion(renderRegion);
  if(renderPreset!==undefined)paint.renderPreset=checkRenderPreset(renderPreset);
  if(renderVisibility!==undefined){
    const visibility=checkRenderVisibility(renderVisibility);
    if(Object.keys(visibility).length)paint.renderVisibility=visibility;
  }
  validate({paint});
  let source;
  for(const id of new Set([defaultSource,...list().map(project=>project.id)])){
    let candidate;
    try{candidate=read(id);}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    const s=candidate.source;
    if(s.material!==geometry.material||s.bindingVersion!==2||
       s.files[s.reviewSource]!==geometry.modelSha256||registrationFingerprint(s)!==geometry.registrationSha256)continue;
    try{await checkRegisteredSource(candidate);}
    catch{continue;}
    source=candidate;
    break;
  }
  if(!source)throw Error('本机没有与交付包模型和 UV 缓存一致的登记工程');
  const doc=paintTemplate(source,paint);
  if(manifest.modeling){
    validateModelState(manifest.modeling);
    doc.modeling=manifest.modeling;
    if(modelFingerprint(doc)!==geometry.modelFingerprint)throw Error('建模修改指纹与工程副本不一致');
  }
  return forkProject(source.id,doc,manifest.name,destination=>{
    for(const item of Object.values(paint.assets)){
      const file=path.join(destination,item.file);
      fs.copyFileSync(path.join(folder,item.file),file,fs.constants.COPYFILE_EXCL);
      if(hash(file)!==item.id)throw Error('恢复时素材指纹变化');
    }
  });
}
function prepareEditableFiles(doc,out,files,{preview,uv}={}){
  const manifestPath='editable/manifest.json',assets={};
  const entries=Object.entries(doc.paint.assets);
  if(entries.length>32000)throw Error('可编辑涂装素材数量超出打包限制');
  const folder=path.join(out,'editable','assets');
  fs.mkdirSync(folder,{recursive:true});
  for(const [id,item] of entries){
    const name='paint-'+id+'.png',file=path.join(folder,name);
    fs.copyFileSync(assetPath(doc,id),file,fs.constants.COPYFILE_EXCL);
    if(hash(file)!==id)throw Error('打包时涂装素材指纹变化');
    assets[id]={name:item.name,path:'assets/'+name,sha256:id};
    files['editable/'+assets[id].path]=file;
  }
  files[manifestPath]=path.join(out,manifestPath);
  const geometry={material:doc.source.material,modelSha256:doc.source.files[doc.source.reviewSource],
    registrationSha256:registrationFingerprint(doc.source),...(doc.modeling?{modelFingerprint:modelFingerprint(doc)}:{}),...(uv&&modelFingerprint(doc)?{editedModelSha256:uv.source_sha256}:{}),...(uv?{uvSha256:uv.uv_before}:{})};
  const manifest={
    format:preview?'arachne-pbr-paint':archiveFormat,version:1,name:doc.name,revision:doc.revision,
    ...(preview?{previewId:preview.id}:{}),geometry,...(doc.modeling?{modeling:doc.modeling}:{}),
    paint:{base:doc.paint.base,...(doc.paint.objectNames?{objectNames:doc.paint.objectNames}:{}),...(doc.paint.renderCamera?{renderCamera:doc.paint.renderCamera}:{}),...(doc.paint.renderAppearance?{renderAppearance:doc.paint.renderAppearance}:{}),...(doc.paint.renderLighting?{renderLighting:doc.paint.renderLighting}:{}),...(doc.paint.renderOptics?{renderOptics:doc.paint.renderOptics}:{}),...(doc.paint.renderPreset?{renderPreset:doc.paint.renderPreset}:{}),...(doc.paint.renderRegion?{renderRegion:doc.paint.renderRegion}:{}),...(doc.paint.renderVisibility?{renderVisibility:doc.paint.renderVisibility}:{}),...(doc.paint.imageDocuments?{imageDocuments:doc.paint.imageDocuments}:{}),...(doc.paint.baseChannels!==undefined?{baseChannels:doc.paint.baseChannels}:{}),layers:doc.paint.layers,assets,...(doc.paint.materials?{materials:doc.paint.materials}:{}),...(doc.paint.brushes?{brushes:doc.paint.brushes}:{}),...(doc.paint.materialGraph?{materialGraph:doc.paint.materialGraph}:{}),...(doc.paint.surfaceBindings?{surfaceBindings:doc.paint.surfaceBindings}:{})}
  };
  if(Buffer.byteLength(JSON.stringify(manifest,null,2)+'\n')>16*1024*1024)throw Error('可编辑工程清单超过 16 MiB，无法生成可恢复的 ZIP');
  atomic(files[manifestPath],manifest);
  return {manifestPath,assetCount:Object.keys(assets).length,geometry};
}
const channelsForReport=report=>channels.filter(k=>Object.hasOwn(report.files,channelSpecs[k].file));
export function paintPreviewFolder(doc,j){
  if(j?.type!=='paint-preview'||j.status!=='completed'||j.revision!==doc.revision)throw Error('请先生成当前修订的有效预览');
  return path.join(projectDir(doc.id),'jobs',j.id,'paint');
}
export async function checkPaintPreview(doc,j,options){
  const folder=paintPreviewFolder(doc,j);
  await verifyPaintBake(doc,j.paintReport,folder,options);
  return folder;
}
export async function verifyPaintBake(doc,report,folder,{draft=false,binding,signal}={}){
  const size=draft?1024:4096;
  if(report?.revision!==doc.revision||Boolean(report.draft)!==draft||!isDeepStrictEqual(report.resolution,[size,size])||
     report.uv_unchanged!==true||report.protectedTexelsWritten!==0||report.conflictTexelsWritten!==0||
     !(isDeepStrictEqual([...Object.keys(report.files||{})].sort(),[...paintTextures].sort())||!extendedPaint(doc)&&isDeepStrictEqual([...Object.keys(report.files||{})].sort(),[...legacyTextures].sort()))||
     !isDeepStrictEqual(report.assetFingerprints,Object.keys(doc.paint.assets))||
     report.materialFingerprint!==materialFingerprint(doc)||report.bindingFingerprint!==(binding??await verifyPaint(doc,{signal})))throw Error(draft?'Cycles 视口贴图与当前修订不一致':'请先生成当前修订的有效预览');
  if(report.bakeFingerprint!==undefined&&report.bakeFingerprint!==paintBakeFingerprint(doc))throw Error('贴图输入或烘焙版本已变化');
  if(!isDeepStrictEqual(report,JSON.parse(await fsp.readFile(path.join(folder,'report.json'),{encoding:'utf8',signal}))))throw Error('预览校验报告变化');
  for(const [file,expected] of Object.entries(report.files)){
    const mismatch=()=>Error('预览贴图尺寸或指纹变化');
    const digest=await sha256File(path.join(folder,file),{signal,inspectHead:bytes=>{
      if(!pngSizeIs(bytes,size,size))throw mismatch();
    }});
    if(digest!==expected)throw mismatch();
  }
}
export {pngSizeIs};
export const renderChannels=(report,folder)=>Object.fromEntries(channelsForReport(report).filter(k=>k!=='color').map(k=>{
  const name=channelSpecs[k].file;
  return [k,{file:path.join(folder,name),sha256:report.files[name],enabled:!report.activeChannels||report.activeChannels.includes(k),colorSpace:channelSpecs[k].srgb?'sRGB':'Non-Color'}];
}));
export async function nativePaintMaterial(doc,report,folder,{signal}={}){
  const graph=doc.paint.materialGraph;
  if(!graph)return null;
  const paint={},paintSha256={};
  for(const name of channelsForReport(report)){
    const file='node-paint-'+name+'.png',source=path.join(folder,file),expected=report.graphSourceFiles?.[file];
    if(!expected||await sha256File(source,{signal})!==expected)throw Error('节点涂装输入指纹变化');
    paint[name]=source;paintSha256[name]=expected;
  }
  return {activeChannels:report.activeChannels||legacyChannels,graph,plan:compileMaterialGraph(graph,doc.paint.assets),
    fingerprint:materialFingerprint(doc),paint,paintSha256,assets:paintInput(doc).assets};
}
export async function reusablePaintBake(doc,jobs,fingerprint,{binding,signal}={}){
  for(const job of jobs){
    const report=job.paintReport;
    if(!['paint-preview','paint-render'].includes(job.type)||job.status!=='completed'||job.revision>doc.revision||
       report?.bakeFingerprint!==fingerprint||report.revision!==job.revision||!/^[\w-]{1,100}$/.test(job.id))continue;
    const folder=path.join(projectDir(doc.id),'jobs',job.id,'paint');
    try{
      await verifyPaintBake({...doc,revision:job.revision},report,folder,{binding,signal});
      const nodeMaterial=await nativePaintMaterial(doc,report,folder,{signal});
      return {job,report,folder,nodeMaterial};
    }catch{signal?.throwIfAborted();/* Try another immutable artifact or bake afresh. */}
  }
  return null;
}
async function copyPaintBake(doc,match,out,{binding,signal}){
  if(!match)return null;
  const report={...match.report,revision:doc.revision};
  const graphFiles=match.nodeMaterial?Object.keys(match.nodeMaterial.paint).map(name=>'node-paint-'+name+'.png'):[];
  const names=[...Object.keys(report.files),...graphFiles,'base.png','coverage.png',...channelsForReport(report)
    .filter(name=>name!=='color').map(name=>'base-'+name+'.png')];
  const incoming=await fsp.mkdtemp(path.join(path.dirname(out),'paint-reuse-'));
  try{
    for(const name of names){
      signal?.throwIfAborted();
      await fsp.copyFile(path.join(match.folder,name),path.join(incoming,name),fs.constants.COPYFILE_FICLONE|fs.constants.COPYFILE_EXCL);
    }
    atomic(path.join(incoming,'report.json'),report);
    await verifyPaintBake(doc,report,incoming,{binding,signal});
    await fsp.rename(incoming,out);
    return report;
  }catch{signal?.throwIfAborted();return null;}
  finally{await fsp.rm(incoming,{recursive:true,force:true});}
}

export async function runPaintJob(j,doc,{stage,update,runProcess,getJob,listJobs,signal}){
  stage(j,'核对登记模型、原 UV 与素材');
  const binding=await verifyPaint(doc,{signal}),folder=path.join(projectDir(doc.id),'jobs',j.id);
  const python=process.env.ARACHNE_PYTHON||'python',blender=blenderExecutable();
  const url=name=>`/api/projects/${doc.id}/jobs/${j.id}/files/${name}`;
  const run=async(name,cfg,exe,args)=>{
    const file=path.join(folder,name+'.json');atomic(file,cfg);
    const progress=cfg.progress===true?cyclesProgressReader(value=>{if(!signal?.aborted)update(j,{progress:value});}):null;
    await runProcess(j,exe,[...args,file],progress?{onLine:progress}:undefined);
  };
  const blenderArgs=script=>blenderScriptArgs(path.join(ROOT,script));
  if(['paint-backup','paint-texture-export'].includes(j.type)){
    const withTextures=j.type==='paint-texture-export';
    const out=path.join(folder,withTextures?'textures':'backup'),files={};
    stage(j,withTextures?'核对 4K 贴图并打包工程':'保存可编辑工程副本');
    try{
      const editable=prepareEditableFiles(doc,out,files);
      const report={format:archiveFormat,revision:doc.revision,editable};
      if(withTextures){
        const preview=getJob(doc.id,j.paintPreviewId);
        const input=await checkPaintPreview(doc,preview,{binding,signal});
        const bake=preview.paintReport;
        const hashes={};
        for(const [name,digest] of Object.entries(bake.files)){
          const member='textures/'+name;
          files[member]=path.join(input,name);
          hashes[member]=digest;
        }
        const projection=path.join(out,'projection-report.json');
        atomic(projection,bake);
        files['projection-report.json']=projection;
        report.bake={previewId:preview.id,resolution:bake.resolution,files:hashes};
      }
      await run('backup-config',{out,files,report},
        python,['-X','utf8',path.join(ROOT,'paint_archive.py'),'pack']);
      signal?.throwIfAborted();
      if(withTextures&&read(doc.id).revision!==doc.revision)
        throw Error('工程已变化，请预览并确认当前修订');
    }catch(error){
      fs.rmSync(path.join(out,'project.zip'),{force:true});
      throw error;
    }finally{fs.rmSync(path.join(out,'editable'),{recursive:true,force:true});}
    update(j,withTextures?{packageUrl:url('textures/project.zip')}:{archiveUrl:url('backup/project.zip')});
    return;
  }
  if(modelFingerprint(doc))stage(j,'准备建模后的涂装表面与遮挡');
  const geometry=await preparePaintGeometry(doc,{signal,frozen:true}),paintSource=geometry.source;
  const renderAppearance=doc.paint.renderAppearance||null,renderLighting=doc.paint.renderLighting||null,renderOptics=doc.paint.renderOptics||null;
  const renderVisibility=Object.keys(doc.paint.renderVisibility||{}).length?doc.paint.renderVisibility:null;
  if(j.type==='paint-preview'||j.type==='paint-draft'||j.type==='paint-render'){
    const out=path.join(folder,'paint');
    const draft=j.type==='paint-draft',bakeFingerprint=paintBakeFingerprint(doc,binding);
    const compose={...paintInput(doc,binding),source:paintSource,surfaceSources:geometry.surfaceSources,out,draft,bakeFingerprint};
    const cached=!draft&&listJobs?await reusablePaintBake(doc,listJobs(doc.id),bakeFingerprint,{binding,signal}):null;
    if(cached)stage(j,'复用已验证的 4K 涂装贴图');
    let report=await copyPaintBake(doc,cached,out,{binding,signal});
    if(report){
      atomic(path.join(folder,'paint-input.json'),compose);
      update(j,{reusedPaintBake:{jobId:cached.job.id,revision:cached.job.revision}});
    }
    else{
      stage(j,draft?'生成 1K 试算':'合成八通道并写回原 UV');
      await run('paint-input',compose,
        python,['-X','utf8',path.join(ROOT,'paint_worker.py')]);
      report=JSON.parse(await fsp.readFile(path.join(out,'report.json'),{encoding:'utf8',signal}));
      await verifyPaintBake(doc,report,out,{draft,binding,signal});
      await verifyPaint(doc,{signal});
    }
    if(j.type==='paint-render'){
      const settings=j.paintSettings,channelFiles=renderChannels(report,out),sourceHash=geometry.report?.modelSha256||doc.source.files[doc.source.reviewSource];
      const renderRegion=renderRegionPixels(doc.paint.renderRegion,settings.width,settings.height);
      const nodeMaterial=await nativePaintMaterial(doc,report,out,{signal});
      const texture={kind:'paint',roundId:j.id,sha256:report.files['f_16xl_BaseColor.png']};
      const color=path.join(out,'f_16xl_BaseColor.png'),renderOut=path.join(folder,'cycles-render');
      stage(j,'Cycles 渲染冻结修订');
      await run('cycles-config',{source:paintSource,sourceSha256:sourceHash,color,channels:channelFiles,nodeMaterial,out:renderOut,revision:doc.revision,settings,renderAppearance,renderLighting,renderVisibility,renderOptics,renderRegion,texture,progress:true},
        blender,blenderArgs('cycles_render.py'));
      const cycles=JSON.parse(fs.readFileSync(path.join(renderOut,'validation.json'),'utf8'));
      if(cycles.engine!=='CYCLES'||cycles.document_revision!==doc.revision||cycles.source_sha256!==sourceHash||
        cycles.source_saved!==false||cycles.uv_unchanged!==true||!cycles.uv_before||cycles.uv_before!==cycles.uv_after||
        !isDeepStrictEqual(cycles.texture,texture)||!isDeepStrictEqual(cycles.camera,settings.camera)||
        !isDeepStrictEqual(cycles.frame_resolution,[settings.width,settings.height])||
        !isDeepStrictEqual(cycles.render_region??null,renderRegion)||
        cycles.samples!==settings.samples||cycles.denoising!==(settings.denoise??true)||
        (settings.device==='cpu'&&cycles.device!=='CPU')||(settings.device==='gpu'&&cycles.device==='CPU'))
        throw Error('Cycles 渲染结果与冻结工程或输出设置不一致');
      for(const key of ['adaptive','noiseThreshold','maxBounces','transparent','bitDepth']){
        const value=settings[key],actual=cycles.render_effective?.[key];
        if(value!==undefined&&(key==='noiseThreshold'?typeof actual!=='number'||Math.abs(value-actual)>1e-6:value!==actual))
          throw Error('Cycles 渲染设置与请求不一致');
      }
      if(settings.transparent&&cycles.render_effective?.colorMode!=='RGBA')throw Error('透明背景需要 RGBA 输出');
      if(settings.lightPaths&&!matchesCyclesLightPaths(settings.lightPaths,cycles.render_effective?.lightPaths))
        throw Error('Cycles 光线路径与出图设置不一致');
      const output=await validateCyclesOutput(renderOut,settings,cycles,renderRegion,{signal});
      if(!matchesRenderAppearance(renderAppearance,cycles.render_effective?.colorManagement))throw Error('Cycles 色彩管理与工程不一致');
      if(!isDeepStrictEqual(cycles.lighting?.options??null,renderLighting))throw Error('Cycles 布光与工程不一致');
      if(!isDeepStrictEqual(cycles.render_visibility??null,renderVisibility))throw Error('Cycles 物体渲染显隐与工程不一致');
      if(!matchesRenderOptics(renderOptics,cycles.camera_framing?.optics))throw Error('Cycles 相机景深与工程不一致');
      if(nodeMaterial&&cycles.nodeMaterial?.fingerprint!==nodeMaterial.fingerprint)throw Error('Cycles 节点材质指纹不一致');
      for(const [key,input] of Object.entries(channelFiles))
        if(cycles.channels?.[key]?.sha256!==input.sha256||cycles.channels[key].applied!==input.enabled||await sha256File(input.file,{signal})!==input.sha256)
          throw Error('Cycles 贴图通道核对失败');
      if(await sha256File(color,{signal})!==texture.sha256)throw Error('Cycles 颜色贴图指纹变化');
      await verifyPaint(doc,{signal});
      update(j,{paintReport:report,cycles,...output,...(output.outputSha256?{outputUrl:url('cycles-render/cycles.exr')}:{}),
        ...(output.passesSha256?{passesUrl:url('cycles-render/cycles-passes.exr')}:{}),
        renderUrl:url('cycles-render/cycles.png'),validationUrl:url('cycles-render/validation.json')});
      return;
    }
    update(j,{paintReport:report,colorUrl:url('paint/f_16xl_BaseColor.png'),baseUrl:url('paint/base.png'),
      materialUrls:Object.fromEntries(channels.filter(k=>k!=='color').map(k=>[k,url('paint/'+channelSpecs[k].file)])),
      baseMaterialUrls:Object.fromEntries(channels.filter(k=>k!=='color').map(k=>[k,url('paint/base-'+k+'.png')])),
      coverageUrl:url('paint/coverage.png'),validationUrl:url('paint/report.json')});return;
  }
  const preview=getJob(doc.id,j.paintPreviewId),input=await checkPaintPreview(doc,preview,{binding,signal}),out=path.join(folder,'delivery');
  fs.mkdirSync(out);
  const report=preview.paintReport,files={};
  for(const file of Object.keys(report.files)){
    files[file]=path.join(out,file);await fsp.copyFile(path.join(input,file),files[file]);
  }
  files['projection-report.json']=path.join(input,'report.json');
  const color=files['f_16xl_BaseColor.png'];
  const channelFiles=renderChannels(report,out);
  const nodeMaterial=await nativePaintMaterial(doc,report,input,{signal});
  const renderSettings=cyclesOptions(j.paintSettings);
  const renderRegion=renderRegionPixels(doc.paint.renderRegion,renderSettings.width,renderSettings.height);
  stage(j,'生成独立 Blender 副本');
  await run('blend-config',{out,source:paintSource,color,channels:channelFiles,nodeMaterial,roundId:preview.id,settings:renderSettings,renderAppearance,renderLighting,renderVisibility,renderOptics,renderRegion},blender,blenderArgs('image_blend.py'));
  stage(j,'Cycles 渲染冻结修订');
  await run('cycles-config',{source:paintSource,color,channels:channelFiles,nodeMaterial,out:path.join(out,'cycles'),revision:doc.revision,
    settings:renderSettings,renderAppearance,renderLighting,renderVisibility,renderOptics,renderRegion,progress:true,texture:{kind:'paint',roundId:preview.id,sha256:report.files['f_16xl_BaseColor.png']}},
  blender,blenderArgs('cycles_render.py'));
  const uv=JSON.parse(fs.readFileSync(path.join(out,'blend-validation.json'),'utf8'));
  const cycles=JSON.parse(fs.readFileSync(path.join(out,'cycles/validation.json'),'utf8'));
  if(nodeMaterial&&(uv.nodeMaterial?.fingerprint!==nodeMaterial.fingerprint||!isDeepStrictEqual(cycles.nodeMaterial,uv.nodeMaterial)))
    throw Error('Blender 副本与 Cycles 节点材质指纹不一致');
  if(!uv.uv_unchanged||!cycles.uv_unchanged||uv.source_saved||cycles.source_saved||
     uv.source_sha256!==(geometry.report?.modelSha256||doc.source.files[doc.source.reviewSource])||
     uv.source_sha256!==cycles.source_sha256||uv.uv_before!==cycles.uv_before||
     cycles.texture.sha256!==report.files['f_16xl_BaseColor.png'])throw Error('交付 UV 或版本核对失败');
  if(!isDeepStrictEqual(uv.camera_framing,cycles.camera_framing)||uv.render_settings?.width!==cycles.frame_resolution?.[0]||
     uv.render_settings?.height!==cycles.frame_resolution?.[1]||uv.render_settings?.samples!==cycles.samples||
     (uv.render_settings?.denoise??true)!==cycles.denoising)
    throw Error('Blender 副本与 Cycles 的取景或输出设置不一致');
  if(!matchesRenderOptics(renderOptics,cycles.camera_framing?.optics))throw Error('Blender 副本与 Cycles 的相机景深不一致');
  if(!isDeepStrictEqual(cycles.render_region??null,renderRegion)||!isDeepStrictEqual(cycles.render_region,uv.render_region))
    throw Error('Blender 副本与 Cycles 的渲染区域不一致');
  const output=await validateCyclesOutput(path.join(out,'cycles'),renderSettings,cycles,renderRegion,{signal});
  if(!matchesRenderAppearance(renderAppearance,cycles.render_effective?.colorManagement)||
     !isDeepStrictEqual(uv.render_effective?.colorManagement,cycles.render_effective?.colorManagement))
    throw Error('Blender 副本与 Cycles 的色彩管理不一致');
  if(!isDeepStrictEqual(cycles.lighting?.options??null,renderLighting)||!isDeepStrictEqual(cycles.lighting,uv.lighting))
    throw Error('Blender 副本与 Cycles 布光不一致');
  if(!isDeepStrictEqual(cycles.passes,uv.passes))throw Error('Blender 副本与 Cycles 的渲染通道不一致');
  if(!isDeepStrictEqual(cycles.render_visibility??null,renderVisibility)||!isDeepStrictEqual(cycles.render_visibility,uv.render_visibility))
    throw Error('Blender 副本与 Cycles 物体渲染显隐不一致');
  const advancedKeys=['adaptive','noiseThreshold','maxBounces','transparent','bitDepth'];
  if(advancedKeys.some(key=>uv.render_settings?.[key]!==undefined)&&(!uv.render_effective||!cycles.render_effective))throw Error('缺少 Cycles 渲染设置核对结果');
  if(uv.render_effective&&cycles.render_effective){
    for(const key of ['adaptive','maxBounces','transparent','colorMode','bitDepth','fileFormat'])
      if(uv.render_effective[key]!==cycles.render_effective[key])throw Error('Blender 副本与 Cycles 的渲染设置不一致');
    if(Math.abs(uv.render_effective.noiseThreshold-cycles.render_effective.noiseThreshold)>1e-6)throw Error('Blender 副本与 Cycles 的噪波阈值不一致');
    if(!matchesCyclesLightPaths(uv.render_effective.lightPaths,cycles.render_effective.lightPaths)||
      renderSettings.lightPaths&&!matchesCyclesLightPaths(renderSettings.lightPaths,cycles.render_effective.lightPaths))
      throw Error('Blender 副本与 Cycles 光线路径不一致');
    for(const key of advancedKeys){
      const requested=uv.render_settings?.[key],actual=cycles.render_effective[key];
      if(requested!==undefined&&(key==='noiseThreshold'?Math.abs(requested-actual)>1e-6:requested!==actual))throw Error('Cycles 渲染设置与确认值不一致');
    }
    if(uv.render_settings?.transparent&&cycles.render_effective.colorMode!=='RGBA')throw Error('透明背景需要 RGBA 输出');
  }
  if((uv.render_settings?.device==='cpu'&&cycles.device!=='CPU')||(uv.render_settings?.device==='gpu'&&cycles.device==='CPU'))throw Error('Cycles 使用的渲染设备与确认设置不一致');
  for(const [name,channel] of Object.entries(channelFiles)){
    if(uv.channels?.[name]?.sha256!==channel.sha256||cycles.channels?.[name]?.sha256!==channel.sha256||
       await sha256File(channel.file,{signal})!==channel.sha256)throw Error('Blender、Cycles 或贴图通道指纹不一致');
  }
  if(await sha256File(color,{signal})!==report.files['f_16xl_BaseColor.png']||uv.roundId!==preview.id||cycles.texture.roundId!==preview.id)
    throw Error('交付文件与冻结预览不一致');
  if(read(doc.id).revision!==doc.revision)throw Error('工程已变化，请预览并确认当前修订');
  await checkPaintPreview(doc,preview,{signal});
  Object.assign(files,{'preview.blend':path.join(out,'preview.blend'),'cycles.png':path.join(out,'cycles/cycles.png'),
    'blend-validation.json':path.join(out,'blend-validation.json'),'cycles-validation.json':path.join(out,'cycles/validation.json'),
    'snapshot.json':path.join(folder,'snapshot.json')});
  if(output.outputSha256)files['cycles.exr']=path.join(out,'cycles/cycles.exr');
  if(output.passesSha256)files['cycles-passes.exr']=path.join(out,'cycles/cycles-passes.exr');
  stage(j,'核对并打包交付文件');
  const editable=prepareEditableFiles(doc,out,files,{preview,uv});
  await run('package-config',{out,files,report:{revision:doc.revision,previewId:preview.id,confirmedAt:j.paintConfirmedAt,projection:report,uv,cycles,editable}},
    python,['-X','utf8',path.join(ROOT,'image_worker.py'),'package']);
  if(read(doc.id).revision!==doc.revision)throw Error('工程已变化，请预览并确认当前修订');
  update(j,{packageUrl:url('delivery/delivery.zip'),blendUrl:url('delivery/preview.blend'),cycles,...output,
    ...(output.outputSha256?{outputUrl:url('delivery/cycles/cycles.exr')}:{}),
    ...(output.passesSha256?{passesUrl:url('delivery/cycles/cycles-passes.exr')}:{}),
    renderUrl:url('delivery/cycles/cycles.png'),validationUrl:url('delivery/delivery-report.json')});
}
