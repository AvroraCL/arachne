import {defaultExrSpace,exrSpaces} from './public/render-exr-color.mjs';
import {outputProfileLimit,outputProfileMode} from './public/image-output-profile.mjs';
import {documentFrame,editingSide,previewDimensions,thumbnailDimensions} from './public/image-document-size.mjs';
import {libraryFill,insertMaterialLayers} from './public/smart-material-placement.mjs';
import {validPenPath,flattenPenPath} from './public/image-pen-path.mjs';
import {textDefaults,textFonts,textEffects,checkStyleFields,hasImageStyle,paragraphOrigin} from './public/image-text-style.mjs';
import {imageColorSpaces,embeddedDependencies,validateImageDocuments,imageDocumentOperation,imageLayersBeforeAdjustment,visibleImageLayers,imageLayerDefaults,imageClippingBase,imageLayerAssets,clearImageLayerMask,imageCoverageSources,hasImageLayerMask} from './public/image-documents.mjs';
import {layoutKinds} from './public/image-layout.mjs';
import {imagePlacement,warpPoint} from './public/image-warp.mjs';
import {imageLayersThrough,isolateImageLayer} from './public/image-layer-tree.mjs';
import {imageCombineLabels,planImageCombine} from './public/image-layer-combine.mjs';
import {imageLayerLimit} from './public/image-layer-batch.mjs';
import {imageStrokeQueueLimit,strokeReceiptLimit,strokeTarget} from './public/image-stroke-queue.mjs';
import {validateObjectNames} from './public/scene-object-names.mjs';
import {paintChannels,legacyChannels,channelSpecs,activePaintChannels,channelBlendChoices} from './public/paint-channels.mjs';
import {checkedTexturePreset,textureExportPresets} from './public/texture-export-presets.mjs';
import {maskGeneratorFields,maskEffectBlendLabel,maskEffectLimit} from './public/paint-mask-effects.mjs';
import {validateLibraries,libraryOperation,compileLibraryMaterial} from './public/paint-library.mjs';
import {compileMaterialGraph} from './public/material-graph.mjs';
import {pinSurfaceInputs,validateSurfaceBindings} from './paint-surface-bindings.mjs';
import {modelFingerprint,validateModelState,prepareModelGeometry,preparePaintGeometry} from './project-model.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {sha256File} from './file-fingerprint.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual,promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {crc32} from 'node:zlib';
import {ROOT,list,read,commit,forkProject,projectDir,hash,atomic} from './store.mjs';
import {bindingFingerprint,demoProjectId,nativeDemoProjectId} from './demo-source.mjs';
import {cyclesOptions} from './cycles-options.mjs';
import {pngSizeIs,exrMatches} from './cycles-output.mjs';
import {glbRegistrationFiles,installGlbRegistration} from './model-registration.mjs';
import {primitiveRegistration} from './primitive-model.mjs';
import {modelTemplates} from './public/model-templates.mjs';
import {renderSceneObjects} from './render-scene-objects.mjs';
import {renderPathTrace} from './path-trace-render.mjs';
import {checkRenderAppearance} from './public/render-appearance.mjs';
import {checkRenderLighting} from './public/render-lighting.mjs';
import {checkRenderPreset,renderBookmarkLimit} from './public/paint-delivery-options.mjs';
import {checkRenderVisibility,updateRenderVisibility} from './public/render-visibility.mjs';
import {checkRenderOptics} from './public/render-optics.mjs';
import {checkRenderRegion,renderRegionPixels} from './public/render-region.mjs';
import {layerParent,layerChildren,layerTreeOrder,layerIsVisible,layerLockOwner,hasMaterialMask,materialMaskFields,paintAnchorSources,remapPaintAnchors} from './public/paint-layer-tree.mjs';
import {uvShapeFields,imageSelectionFields,uvShapePayload,uvRegionLimits,maxUVFeather} from './public/uv-selection-region.mjs';
import {checkStrokeBlock,isStrokeBlock} from './public/stroke-blocks.mjs';
import {compactPaintStrokes,unpackStrokeBlock} from './stroke-compaction.mjs';
import {livePaint} from './paint-live.mjs';
import {pythonExecutable} from './python-runtime.mjs';

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
function checkSourceMaterials(records,target,registered){
  if(!records||typeof records!=='object'||Array.isArray(records))throw Error('模型材质记录无效');
  for(const [name,factors] of Object.entries(records)){
    if(!name||['__proto__','constructor','prototype',target].includes(name)||registered&&!registered.materials.includes(name))throw Error('无法编辑该模型材质');
    fields(factors,['color','metallic','roughness','transmission','mark']);
    if(factors.transmission!==undefined&&registered&&!registered.transmissionMaterials.includes(name))throw Error('该模型材质没有透射通道');
    if(factors.mark){
      fields(factors.mark,['image','coverage','projector','surfaceBinding']);
      if(typeof factors.mark.surfaceBinding!=='string'||!sha256(factors.mark.image)||!sha256(factors.mark.coverage))throw Error('投影标记素材无效');
      checkProjector(factors.mark.projector);
    }
    if(!Object.keys(factors).length||Object.entries(factors).some(([key,value])=>key==='mark'?!value:key==='color'?!color(value):!unit(value)))throw Error('模型材质参数无效');
  }
}
const supportsBlend=(channel,blend)=>channelBlendChoices(channel).some(([mode])=>mode===blend);
const folderFields=['name','visible','locked','opacity','mask','maskBase','maskEnabled','maskEffects','maskStrokeOrder'];
const layerFields=[...folderFields,'anchorPoint','channelOpacity','channelBlend','channels','values','x','y','scale','rotation','image','blend','maps','tiling','fillProjection','projector','space','uvScale','materialId','documentMaps'];
const revisionError=doc=>Object.assign(Error('工程修订已变化'),{status:409,currentRevision:doc.revision});
const materialValues=v=>v&&legacyChannels.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>channels.includes(k)&&(channelSpecs[k].type==='color'?color(v[k]):unit(v[k])));
const channelFlags=v=>v&&legacyChannels.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>channels.includes(k)&&typeof v[k]==='boolean');
const vector=(v,length,limit)=>Array.isArray(v)&&v.length===length&&v.every(n=>Number.isFinite(n)&&Math.abs(n)<=limit);
const normal=v=>vector(v,3,2)&&Math.hypot(...v)>.1;
const ranged=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
const textFontRegistry=doc=>doc.paint.textFonts??{};
const fontName=name=>typeof name==='string'&&name.length>0&&name.length<=256&&!/[\u0000-\u001f\u007f]/.test(name);
function checkedFontEntry(id,entry){
  const {file,family,style,weight,italic,weights}=fields(entry,['file','family','style','weight','italic','weights']);
  if(!sha256(id)||!['ttf','otf'].some(extension=>file==='font-'+id+'.'+extension)||!fontName(family)||!fontName(style)||
     typeof italic!=='boolean'||!Array.isArray(weights)||!weights.every(pair=>Array.isArray(pair)&&pair.length===2&&
       Number.isInteger(pair[0])&&ranged(pair[0],1,1000)&&fontName(pair[1]))||!weights.some(([value])=>value===weight))
    throw Error('工程字体登记无效');
  return entry;
}
export async function paintFontFile(doc,id){
  const entry=Object.hasOwn(textFontRegistry(doc),id)&&checkedFontEntry(id,textFontRegistry(doc)[id]);
  if(!entry)throw Object.assign(Error('工程中没有该字体'),{status:404});
  const file=path.join(projectDir(doc.id),'assets',entry.file);
  let digest;
  try{digest=await sha256File(file);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(digest!==id)throw Object.assign(Error('缺少字体或文件已变化：'+entry.family+' · '+entry.style+'。请重新添加原字体文件'),{status:422});
  return file;
}
function checkedText(value,fonts={}){
  const {content,color:ink,fontSize,weight,align,font,tracking,leading,box,effects}=fields(value,
    ['content','color','fontSize','weight','align','font','tracking','leading','box','effects']);
  const text=typeof content==='string'?content.replace(/\r\n?/g,'\n'):'';
  if(!text.trim()||text.length>480||text.split('\n').length>12||
     /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text)||!color(ink)||
     !Number.isInteger(fontSize)||!ranged(fontSize,16,512)||!['left','center','right'].includes(align))
    throw Error('文字参数无效，支持 16–512 像素、最多 12 行和 480 个字符');
  const allowedWeights=font===undefined?[400,700]:
    (Object.hasOwn(textFonts,font)?textFonts[font].weights:Object.hasOwn(fonts,font)?fonts[font].weights:[]).map(([weight])=>weight);
  if(!allowedWeights.includes(weight)||
     tracking!==undefined&&(!Number.isInteger(tracking)||!ranged(tracking,-64,256))||
     leading!==undefined&&(!Number.isInteger(leading)||!ranged(leading,0,1024)))throw Error('字体、字距或行距无效');
  if(box!==undefined){
    const {width,height}=fields(box,['width','height']);
    if(![width,height].every(n=>Number.isInteger(n)&&ranged(n,16,4096)))throw Error('段落框宽高须在 16–4096 px 之间');
  }
  if(effects!==undefined){
    fields(effects,Object.keys(textEffects));
    for(const [id,settings] of Object.entries(effects))checkStyleFields(id,settings);
  }
  return {content:text,color:ink,fontSize,weight,align,...(font===undefined?{}:{font}),...(tracking===undefined?{}:{tracking}),
    ...(leading===undefined?{}:{leading}),...(box===undefined?{}:{box}),...(effects===undefined?{}:{effects})};
}
function textLayerName(style){return '文字 · '+style.content.trim().split('\n')[0].trim().slice(0,80);}
function checkMaskEffects(effects){
  if(!Array.isArray(effects)||effects.length>maskEffectLimit)throw Error('蒙版效果栈最多包含 '+maskEffectLimit+' 项');
  const ids=new Set();
  for(const effect of effects){
    const common=['kind','id','enabled','opacity','blend'];
    if(!effect||typeof effect.enabled!=='boolean'||!unit(effect.opacity))throw Error('蒙版效果参数无效');
    if(effect.id!==undefined){
      if(typeof effect.id!=='string'||!/^[\w-]{1,100}$/.test(effect.id)||ids.has(effect.id))throw Error('蒙版效果编号无效或重复');
      ids.add(effect.id);
    }
    if(effect.blend!==undefined&&!maskEffectBlendLabel(effect.blend))throw Error('蒙版效果合成方式无效');
    if(effect.kind==='invert')fields(effect,common);
    else if(effect.kind==='anchor'){
      fields(effect,[...common,'source','channel']);
      if(typeof effect.source!=='string'||!['coverage','luminance'].includes(effect.channel))throw Error('请选择锚点及其取样通道');
    }else if(effect.kind==='levels'){
      fields(effect,[...common,'black','white','gamma']);
      if(!unit(effect.black)||!unit(effect.white)||effect.white-effect.black<.0001||!ranged(effect.gamma,.1,5))
        throw Error('色阶需要有效的黑点、白点和中间调');
    }else if(['height','facing'].includes(effect.kind)){
      fields(effect,[...common,'axis','center','feather']);
      if(!['x','-x','y','-y','z','-z'].includes(effect.axis)||!unit(effect.center)||
         !ranged(effect.feather,.01,1)||!effect.blend)
        throw Error('几何蒙版参数无效');
    }else if(Object.hasOwn(maskGeneratorFields,effect.kind)){
      const specs=maskGeneratorFields[effect.kind];
      fields(effect,[...common,...specs.map(spec=>spec.key)]);
      if(!effect.blend||specs.some(spec=>{
        const value=effect[spec.key];
        return spec.choices?!spec.choices.some(([choice])=>value===choice):
          !ranged(value,spec.min,spec.max)||(spec.integer&&!Number.isInteger(value));
      }))throw Error('几何蒙版生成器参数无效');
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
function validUVPolygon(polygon,rect,limit=256){
  if(polygon===undefined)return true;
  if(!validUVRect(rect)||!Array.isArray(polygon)||polygon.length<3||polygon.length>limit)return false;
  const [left,top,right,bottom]=rect,tolerance=1e-9;
  return polygon.every(point=>vector(point,2,1)&&point.every(unit)&&
    ranged(point[0],left-tolerance,right+tolerance)&&ranged(point[1],top-tolerance,bottom+tolerance));
}
function validUVSelection(shape,rect,image=false){
  const {polygon,regions,feather,coverage}=shape;
  if(coverage!==undefined&&(!image||!sha256(coverage)||polygon!==undefined||regions!==undefined||!validUVRect(rect)))return false;
  if(feather!==undefined&&(!validUVRect(rect)||!Number.isInteger(feather)||!ranged(feather,0,maxUVFeather)))return false;
  if(regions===undefined)return validUVPolygon(polygon,rect);
  if(polygon!==undefined||!validUVRect(rect)||!Array.isArray(regions)||!regions.length||regions.length>uvRegionLimits.rings)return false;
  let rings=0,points=0;
  for(const region of regions){
    if(!Array.isArray(region)||!region.length||(rings+=region.length)>uvRegionLimits.rings)return false;
    for(const ring of region){
      if(!Array.isArray(ring)||(points+=ring.length)>uvRegionLimits.points||!validUVPolygon(ring,rect,uvRegionLimits.points))return false;
    }
  }
  return true;
}
function validBrushStamp(stamp,uv){
  if(!Array.isArray(stamp))return false;
  if(uv)return [2,3].includes(stamp.length)&&stamp.every(unit);
  return (stamp.length===6||stamp.length===7&&unit(stamp[6]))&&
    vector(stamp.slice(0,6),6,1000)&&normal(stamp.slice(3,6));
}
function checkStroke(s,isMask,image=false){
  if(isMask&&s?.region!==undefined){
    fields(s,['region','hit','value','opacity','surfaceBinding']);
    if(!['triangle','polygon','mesh','island'].includes(s.region)||!vector(s.hit,6,1000)||
       !normal(s.hit.slice(3))||!unit(s.value)||!unit(s.opacity))throw Error('蒙版填充区域无效');
    return;
  }
  const inkFields=isMask?['value']:['channels','values','erase'];
  const validInk=stroke=>isMask?unit(stroke.value):
    channelFlags(stroke.channels)&&materialValues(stroke.values)&&typeof stroke.erase==='boolean';
  const shapeFields=image?imageSelectionFields:uvShapeFields;
  if(s?.rect!==undefined){
    fields(s,['uv','rect',...shapeFields,'opacity',...inkFields,...(image?['preserveAlpha']:[])]);
    if(s.uv!==true||!validUVRect(s.rect)||!validUVSelection(s,s.rect,image)||!unit(s.opacity)||!validInk(s))
      throw Error('选区填充参数无效');
    return;
  }
  fields(s,['radius','hardness','opacity','stamps','mirrorX','uv','clip',...shapeFields,'surfaceBinding',...inkFields,
    ...(image?['flow','spacing','pressureMode','breaks','tip','clone','preserveAlpha']:[])]);
  const uv=s.uv===true;
  const brushPath=s.flow!==undefined||s.spacing!==undefined||s.breaks!==undefined;
  if(s.tip!==undefined){
    const {angle,roundness,scatter,grain,seed,tipAsset,textureAsset}=fields(s.tip,['angle','roundness','scatter','grain','seed','tipAsset','textureAsset']);
    if(!image||!uv||!brushPath||!ranged(angle,-180,180)||!ranged(roundness,.1,1)||!unit(scatter)||!unit(grain)||
       !Number.isSafeInteger(seed)||seed<0||seed>0xffffffff||
       [tipAsset,textureAsset].some(id=>id!==undefined&&!sha256(id)))throw Error('笔尖参数无效');
  }
  if((s.uv!==undefined&&!uv)||(uv&&s.mirrorX!==undefined)||
     (s.clip!==undefined&&(!uv||!validUVRect(s.clip)))||!validUVSelection(s,s.clip,image)||
     !(uv?ranged(s.radius,1/4096,.125):ranged(s.radius,.01,2))||
     !unit(s.hardness)||!unit(s.opacity)||!Array.isArray(s.stamps)||!s.stamps.length||s.stamps.length>(brushPath?2048:1024)||
     s.stamps.some(stamp=>!validBrushStamp(stamp,uv))||
     s.pressureMode!==undefined&&(!image||!uv||!['size','both'].includes(s.pressureMode))||
     brushPath&&(!image||!uv||!ranged(s.flow,.01,1)||!ranged(s.spacing,.05,2)||
       s.breaks!==undefined&&(!Array.isArray(s.breaks)||s.breaks.length>64||
         !s.breaks.every((index,i)=>Number.isInteger(index)&&index>(s.breaks[i-1]??0)&&index<s.stamps.length)))||
     (s.mirrorX!==undefined&&typeof s.mirrorX!=='boolean')||
     !validInk(s))
    throw Error('表面笔触参数无效');
}
async function verifyRegisteredFiles(doc,{signal}={}){
  for(const [file,expected] of Object.entries(doc.source.files))
    if(await sha256File(file,{signal})!==expected)throw Error('模型、UV缓存或登记输入已改变：'+path.basename(file));
}
async function checkRegisteredSource(doc,options){
  if(doc.source.bindingVersion!==2||(doc.source.format!=='glb'&&doc.source.material!=='f_16xl'))throw Error('请选择已登记的模型');
  await verifyRegisteredFiles(doc,options);
}
function paintTemplate(doc,paint){
  doc.workflowType=PAINT;doc.layers=[];doc.assets={};doc.fonts={};doc.guides={};
  delete doc.design;delete doc.imageWorkflow;delete doc.modeling;
  doc.paint=paint;
  return doc;
}
export async function createPaint({sourceProjectId,name,modelTemplate}){
  const title=typeof name==='string'?name.trim().slice(0,100):'';
  if(modelTemplate!==undefined){
    if(sourceProjectId)throw Error('请选择一种模型来源');
    if(typeof modelTemplate!=='string'||!Object.hasOwn(modelTemplates,modelTemplate))throw Error('不支持的模型模板');
    const document=await primitiveRegistration(modelTemplate);
    return forkProject(document.id,document,title||modelTemplates[modelTemplate]+' · PBR 涂装');
  }
  let doc;
  for(const id of sourceProjectId?[sourceProjectId]:[nativeDemoProjectId,demoProjectId]){
    try{doc=read(id);break;}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(!doc)throw Error(sourceProjectId?'找不到指定的模型工程':'示例模型尚未生成，请先运行 npm run seed:demo');
  await checkRegisteredSource(doc);
  paintTemplate(doc,{base:{...values},layers:[],assets:{}});
  return forkProject(doc.id,doc,title||'示例模型 · PBR 涂装');
}
export async function savePaintCopy(doc,request){
  const {revision,name}=fields(request,['revision','name']);
  if(doc.revision!==revision)throw revisionError(doc);
  const title=typeof name==='string'?name.trim():'';
  if(!title||title.length>100||/[\u0000-\u001f\u007f]/.test(title))throw Error('请输入有效的工程名称');
  return forkProject(doc.id,doc,title,async destination=>{
    for(const [id,entry] of Object.entries(textFontRegistry(doc)))
      await fsp.copyFile(await paintFontFile(doc,id),path.join(destination,entry.file),fs.constants.COPYFILE_EXCL);
    for(const [id,entry] of Object.entries(doc.paint.assets)){
      if(!sha256(id)||entry.file!=='paint-'+id+'.png')throw Error('涂装素材登记无效');
      const copied=path.join(destination,entry.file);
      try{await fsp.copyFile(assetPath(doc,id),copied,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);}
      catch(error){if(error.code==='ENOENT')throw Error('缺少涂装素材：'+entry.name);throw error;}
      if(await sha256File(copied)!==id)throw Error('复制时素材指纹变化：'+entry.name);
    }
  });
}
function checkedRenderCamera(value){
  fields(value,['projection','eye','target','up','fov','orthoHeight']);
  return cyclesOptions({camera:value}).camera;
}
function renderBookmarkName(name){
  const title=typeof name==='string'?name.trim():'';
  if(!title||title.length>80||/[\u0000-\u001f\u007f]/.test(title))throw Error('请输入有效的镜头名称');
  return title;
}
function checkedRenderBookmarks(entries){
  if(!Array.isArray(entries)||entries.length>renderBookmarkLimit)throw Error('工程最多保存 '+renderBookmarkLimit+' 个相机书签');
  const ids=new Set();
  return entries.map(entry=>{
    const {id,name,camera,lighting,optics}=fields(entry,['id','name','camera','lighting','optics']);
    if(typeof id!=='string'||!/^[-\w]{1,80}$/.test(id)||ids.has(id))throw Error('相机书签编号无效');
    ids.add(id);
    return {id,name:renderBookmarkName(name),camera:checkedRenderCamera(camera),
      ...(lighting==null?{}:{lighting:checkRenderLighting(lighting)}),
      ...(optics==null?{}:{optics:optics==='source'?'source':checkRenderOptics(optics)})};
  });
}
function editRenderBookmark(paint,operation){
  const {action,id,patch}=fields(operation,['op','action','id','patch']);
  const bookmarks=paint.renderBookmarks??[],index=bookmarks.findIndex(entry=>entry.id===id);
  if(action==='add'){
    bookmarks.push({id,...fields(patch,['name','camera','lighting','optics'])});
  }else{
    if(index<0)throw Error('相机书签不存在');
    if(action==='update')bookmarks[index]={...bookmarks[index],...fields(patch,['name','camera','lighting','optics'])};
    else if(action==='remove')bookmarks.splice(index,1);
    else throw Error('相机书签操作无效');
  }
  if(bookmarks.length)paint.renderBookmarks=checkedRenderBookmarks(bookmarks);
  else delete paint.renderBookmarks;
}
function checkedSceneCursor(position){
  if(!vector(position,3,1e6))throw Error('三维游标坐标无效');
  return position.slice();
}
// The original stack stays in its on-disk location. A secondary stack shares
// project assets and runs through the same commands, compositor and history.
export function textureSetDocument(doc,name){
  if(name===undefined||name===doc.source.material)return doc;
  if(doc.source.format!=='glb'||typeof name!=='string'||!Object.hasOwn(doc.paint.textureSets??{},name))
    throw Error('找不到指定的纹理集');
  const {textureSets,materialGraph,baseChannels,sourceMaterials,...shared}=doc.paint;
  return {...doc,textureSetName:name,source:{...doc.source,material:name},paint:{...shared,...textureSets[name]}};
}
// Decode an existing material only on the first authored edit, before committing
// any project state. The files become ordinary project assets in the same revision.
export async function prepareTextureSetMaps(doc,request){
  const seeds=new Map();
  if(doc.revision!==request.revision||!Array.isArray(request.operations)||request.operations.length>128)return seeds;
  const names=new Set(request.operations.filter(o=>o?.op==='textureSet'&&o.edit?.op==='add'&&typeof o.name==='string'&&
    o.name!==doc.source.material&&!Object.hasOwn(doc.paint.textureSets??{},o.name)).map(o=>o.name));
  if(!names.size)return seeds;
  const slots=renderSceneObjects(doc).textureSlots;
  for(const name of names){
    if(!slots[name]?.textured||doc.paint.sourceMaterials?.[name]?.mark)continue;
    const folder=await fsp.mkdtemp(path.join(projectDir(doc.id),'slot-maps-'));
    try{
      const file=path.join(folder,'input.json');
      atomic(file,{input:doc.source.reviewSource,name,out:folder,overrides:doc.paint.sourceMaterials?.[name]??{},ownerPid:process.pid});
      const {stdout}=await renderTextFile(pythonExecutable(),['-X','utf8',path.join(ROOT,'model_surface.py'),'slot-maps',file],{windowsHide:true,timeout:120000})
        .catch(error=>{throw Error(error.stderr?.trim()||'源材质贴图读取失败');});
      const entries=new Map();
      for(const channel of JSON.parse(stdout)){
        const bytes=await fsp.readFile(path.join(folder,channel+'.png'));
        entries.set(channel,describePng(doc,bytes,name+' · '+channelSpecs[channel].name,64));
      }
      seeds.set(name,entries);
    }finally{await fsp.rm(folder,{recursive:true,force:true});}
  }
  return seeds;
}
function applyTextureSet(doc,operation,compact,seeds){
  const {name,edit}=fields(operation,['op','name','edit']);
  if(typeof name!=='string'||['__proto__','constructor','prototype'].includes(name)||
    !edit||!['add','update','stroke','remove'].includes(edit.op))throw Error('纹理集命令无效');
  if(edit.op==='add'&&edit.kind!=='fill')throw Error('纹理集面板支持新建填充层');
  if(edit.op==='update')fields(edit.patch,['name','channels','values','maskEnabled']);
  if(edit.op==='stroke'&&(edit.target!=='mask'||edit.stroke?.uv!==true))
    throw Error('请选择纹理集的 UV 蒙版');
  if(name===doc.source.material){applyOperations(doc,[edit],undefined,{compact});return;}
  const slots=renderSceneObjects(doc).textureSlots;
  if(doc.source.format!=='glb'||!Object.hasOwn(slots,name))throw Error('该材质槽没有可绘制的原 UV');
  if(!Object.hasOwn(doc.paint.textureSets??{},name)){
    if(edit.op!=='add')throw Error('请先新建纹理集图层');
    const overrides=doc.paint.sourceMaterials?.[name]??{};
    if(overrides.mark)throw Error('此槽已有投影标记，请先合并标记或将它选为主涂装材质');
    const base={...slots[name].base};
    for(const key of legacyChannels)if(overrides[key]!==undefined)base[key]=overrides[key];
    const layers=[];
    if(slots[name].textured){
      const images=seeds?.get(name);
      if(!images?.size)throw Error('该槽的原材质贴图未准备好');
      const maps={};
      for(const [channel,png] of images){
        ensurePaintAsset(doc,png);doc.paint.assets[png.entry.id]=png.entry;maps[channel]=png.entry.id;
      }
      layers.push({id:crypto.randomUUID(),kind:'fill',name:'源材质贴图',visible:true,opacity:1,blend:'normal',mask:null,
        x:.5,y:.5,scale:1,rotation:0,channels:{color:false,metallic:false,roughness:false,...Object.fromEntries(Object.keys(maps).map(k=>[k,true]))},
        values:{...base},maps});
    }
    doc.paint.textureSets={...doc.paint.textureSets,[name]:{base,layers}};
  }
  const scoped=textureSetDocument(doc,name);
  applyOperations(scoped,[edit],undefined,{compact});
  if(scoped.paint.layers.length)doc.paint.textureSets[name]={base:scoped.paint.base,layers:scoped.paint.layers};
  else{
    delete doc.paint.textureSets[name];
    if(!Object.keys(doc.paint.textureSets).length)delete doc.paint.textureSets;
  }
}

function validate(doc,{unpackBlocks=false,checkPending=true}={}){
  if(doc.paint.textureSets!==undefined){
    const sets=doc.paint.textureSets;
    if(!sets||typeof sets!=='object'||Array.isArray(sets))throw Error('纹理集数据无效');
    for(const [name,set] of Object.entries(sets)){
      if(!name||['__proto__','constructor','prototype',doc.source?.material].includes(name))throw Error('纹理集材质名称无效');
      fields(set,['base','layers']);
      if(!Array.isArray(set.layers))throw Error('纹理集图层列表无效');
      const {textureSets,materialGraph,baseChannels,...shared}=doc.paint;
      const stack={...shared,...set};
      validateSurfaceBindings(stack);
      validateMaterialStack({...doc,paint:stack},{unpackBlocks,checkPending});
    }
  }
  if(doc.paint.sceneCursor!==undefined)checkedSceneCursor(doc.paint.sceneCursor);
  validateObjectNames(doc.paint.objectNames);
  for(const {mark} of Object.values(doc.paint.sourceMaterials||{}))if(mark&&(!asset(doc,mark.image)||!asset(doc,mark.coverage)))throw Error('缺少投影标记素材');
  if(doc.paint.sourceMaterials!==undefined)checkSourceMaterials(doc.paint.sourceMaterials,doc.source?.material);
  if(doc.paint.renderVisibility!==undefined)checkRenderVisibility(doc.paint.renderVisibility);
  if(doc.paint.renderCamera!==undefined)checkedRenderCamera(doc.paint.renderCamera);
  if(doc.paint.renderBookmarks!==undefined)checkedRenderBookmarks(doc.paint.renderBookmarks);
  if(doc.paint.renderAppearance!==undefined)checkRenderAppearance(doc.paint.renderAppearance);
  if(doc.paint.renderLighting!==undefined)checkRenderLighting(doc.paint.renderLighting);
  if(doc.paint.renderOptics!==undefined)checkRenderOptics(doc.paint.renderOptics);
  if(doc.paint.renderRegion!==undefined)checkRenderRegion(doc.paint.renderRegion);
  if(doc.paint.renderPreset!==undefined){
    checkRenderPreset(doc.paint.renderPreset);
    if(doc.paint.renderPreset.framing==='saved'&&!doc.paint.renderCamera)throw Error('工程渲染预设需要已保存的相机');
  }
  for(const [id,entry] of Object.entries(textFontRegistry(doc)))checkedFontEntry(id,entry);
  validateSurfaceBindings(doc.paint);
  validateLibraries(doc.paint);
  validateImageDocuments(doc.paint,{checkStroke,checkedUVTransform,validateText:value=>isDeepStrictEqual(checkedText(value,textFontRegistry(doc)),value),
    unpackStrokeBlock:unpackBlocks?unpackStrokeBlock:undefined,checkPending});
  compileMaterialGraph(doc.paint.materialGraph,doc.paint.assets);
  validateMaterialStack(doc,{unpackBlocks,checkPending});
}
function validateMaterialStack(doc,{unpackBlocks,checkPending}){
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
    if(l.mask!=null&&!asset(doc,l.mask))throw Error('蒙版素材不存在');
    if(l.maskBase!==undefined&&!unit(l.maskBase)||
       l.maskEnabled!==undefined&&typeof l.maskEnabled!=='boolean'||
       l.maskStrokeOrder!==undefined&&!['before','after'].includes(l.maskStrokeOrder))throw Error('蒙版底色、顺序或启用状态无效');
    if(l.anchorPoint!==undefined&&(l.kind!=='paint'||typeof l.anchorPoint!=='boolean'))throw Error('只有材质绘制层可发布涂装锚点');
    if(l.maskEffects!==undefined){
      checkMaskEffects(l.maskEffects);
      for(const effect of l.maskEffects){
        if(effect.kind==='anchor'&&!paintAnchorSources(layers,l).some(source=>source.id===effect.source))
          throw Error('「'+l.name+'」的蒙版引用了下层锚点。请保留来源在同一文件夹的下方，或先移除引用。');
      }
    }
    for(const [key,mask] of [['strokes',false],['maskStrokes',true]])
      for(const stroke of l[key]??[]){
        if(isStrokeBlock(stroke))checkStrokeBlock(stroke,{mask,spatial:true});
        else stampCount+=(stroke.stamps?.length??1)*(stroke.mirrorX?2:1);
      }
    if(l.opacity!==undefined&&!unit(l.opacity))throw Error('图层不透明度须为 0 至 1');
    if(l.materialId!=null&&(l.kind!=='fill'||typeof l.materialId!=='string'||!Object.hasOwn(doc.paint.materials??{},l.materialId)))throw Error('填充层引用的材质不存在');
    if(l.kind==='group')continue;
    if(!['fill','decal','paint'].includes(l.kind)||
       !(l.blend===undefined||supportsBlend('color',l.blend))||!unit(l.opacity)||!materialValues(l.values)||
       !channelFlags(l.channels))throw Error('图层属性无效');
    if(l.kind==='decal'&&(!asset(doc,l.image)||![l.x,l.y,l.scale,l.rotation].every(Number.isFinite)||
       !unit(l.x)||!unit(l.y)||l.scale<.01||l.scale>4))throw Error('贴花素材或变换无效');
    if(l.space!==undefined&&(l.kind!=='decal'||l.space!=='uv'||l.projector!=null))throw Error('画布图片须使用 UV 坐标');
    if(l.uvScale!==undefined&&(l.space!=='uv'||!vector(l.uvScale,2,8)||!l.uvScale.every(n=>Math.abs(n)>=.05)))
      throw Error('画布图片缩放无效');
    if(l.text!==undefined&&(l.space!=='uv'||!isDeepStrictEqual(checkedText(l.text,textFontRegistry(doc)),l.text)))
      throw Error('文字层属性无效');
    if(l.projector!=null){
      if(l.kind!=='decal')throw Error('三维投影仅适用于贴花');
      checkProjector(l.projector);
    }
    if(l.channelOpacity!==undefined&&Object.values(fields(l.channelOpacity,channels)).some(n=>!unit(n)))
      throw Error('通道不透明度须为 0 至 1');
    if(l.channelBlend!==undefined&&Object.entries(fields(l.channelBlend,channels.filter(key=>key!=='color')))
      .some(([channel,mode])=>!supportsBlend(channel,mode)))throw Error('所选通道不支持该混合模式');
    if(l.maps!==undefined){
      if(l.kind==='paint')throw Error('绘制层的通道由笔触写入');
      const maps=fields(l.maps,l.kind==='fill'?channels:channels.filter(k=>k!=='color'));
      if(Object.values(maps).some(id=>!asset(doc,id)))throw Error('属性贴图素材不存在');
    }
    if(l.fillProjection!=null){
      const {mode,scale,rotation,blend}=fields(l.fillProjection,['mode','scale','rotation','blend']);
      if(l.kind!=='fill'||!['uv','triplanar'].includes(mode)||!ranged(scale,.03125,20)||
         !Array.isArray(rotation)||rotation.length!==3||!rotation.every(angle=>ranged(angle,-360,360))||!unit(blend))
        throw Error('填充层投影参数无效');
    }
    if(l.tiling!=null){
      if(l.kind!=='fill')throw Error('平铺仅适用于填充层');
      const {repeat,repeatY=repeat,rotation,offsetX,offsetY}=fields(l.tiling,['repeat','repeatY','rotation','offsetX','offsetY']);
      if(!ranged(repeat,.05,32)||!ranged(repeatY,.05,32)||!ranged(rotation,-360,360)||
        !ranged(offsetX,-1,1)||!ranged(offsetY,-1,1))throw Error('平铺参数无效');
    }
  }
  if(checkPending&&stampCount>120000)throw Error('待压实的材质笔触过多，请分批保存');
}
export {validate as validateProjectPaint};
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
function checkedUVTransform(value,image=false){
  const {rect,offset,scale,angle,copy,interpolation,pivot}=
    fields(value,['rect',...(image?imageSelectionFields:uvShapeFields),'offset','scale','angle','copy','interpolation','pivot']);
  if(!validUVRect(rect)||!validUVSelection(value,rect,image)||
     !vector(offset,2,pivot===undefined?2:8)||pivot!==undefined&&!vector(pivot,2,8)||
     !vector(scale,2,8)||!scale.every(n=>Math.abs(n)>=.05)||!ranged(angle,-360,360)||
     (copy!==undefined&&typeof copy!=='boolean')||
     (interpolation!==undefined&&!['linear','nearest'].includes(interpolation)))
    throw Error('选区变换参数无效');
  return {rect,...uvShapePayload(value),offset,scale,angle,copy,interpolation,...(pivot===undefined?{}:{pivot})};
}
function applyOperations(next,operations,sourceVisibility,{compact=false,textureSeeds}={}){
  if(!Array.isArray(operations)||!operations.length||operations.length>128)throw Error('需要 1–128 条制作命令');
  const p=next.paint,reproject=[];
  for(const o of operations){
    const {op,id,patch}=o;
    if(op==='textureSet'){applyTextureSet(next,o,compact,textureSeeds);continue;}
    if(op==='sourceMaterial'){
      if(Object.hasOwn(p.textureSets??{},o.name)&&(!patch||['color','metallic','roughness','mark'].some(k=>Object.hasOwn(patch,k))))
        throw Error('此材质已使用纹理集，请在材质图层的纹理集中编辑');
      fields(o,['op','name','patch']);
      const registered=renderSceneObjects(next);
      if(next.source.format!=='glb'||!registered.materials.includes(o.name)||o.name===next.source.material)throw Error('无法编辑该模型材质');
      const records={...p.sourceMaterials};
      if(patch===null)delete records[o.name];
      else if(patch?.mark===null){
        fields(patch,['mark']);
        if(!records[o.name]?.mark)throw Error('该材质没有投影标记');
        records[o.name]={...records[o.name]};delete records[o.name].mark;
        if(!Object.keys(records[o.name]).length)delete records[o.name];
      }
      else{
        fields(patch,['color','metallic','roughness','transmission']);
        if(!Object.keys(patch).length)throw Error('模型材质参数无效');
        const updated={...records[o.name]};
        for(const [key,value] of Object.entries(patch)){
          if(value===null)delete updated[key];
          else updated[key]=value;
        }
        if(Object.keys(updated).length){
          checkSourceMaterials({[o.name]:updated},next.source.material,registered);
          records[o.name]=updated;
        }else delete records[o.name];
      }
      if(Object.keys(records).length)p.sourceMaterials=records;else delete p.sourceMaterials;
      continue;
    }
    if(op==='renameObjects'){validateObjectNames(o.names);if(!o.names||!Object.keys(o.names).length)throw Error('请选择物体');p.objectNames={...p.objectNames,...o.names};continue;}
    if(op==='renderVisibility'){
      fields(o,['op','visibility']);
      const visibility=updateRenderVisibility(sourceVisibility,p.renderVisibility,o.visibility);
      if(Object.keys(visibility).length)p.renderVisibility=visibility;else delete p.renderVisibility;
      continue;
    }
    if(op==='sceneCursor'){
      fields(o,['op','position']);
      if(o.position===null)delete p.sceneCursor;
      else p.sceneCursor=checkedSceneCursor(o.position);
      continue;
    }
    if(op==='renderBookmark'){editRenderBookmark(p,o);continue;}
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
    if(op==='image'){
      const source=o.action==='stroke'?o.stroke?.clone?.asset:undefined;
      if(source!==undefined)registerImageSnapshot(next,source,'像素取样');
      const backdrop=o.action==='stroke'?o.stroke?.clone?.backdrop:undefined;
      if(backdrop!==undefined)registerImageSnapshot(next,backdrop,'修复画笔目标取样');
      for(const coverage of imageCoverageSources(o))registerImageSnapshot(next,coverage,'选区覆盖图',true);
      imageDocumentOperation(p,o,{requireUnlocked});
      continue;
    }
    if(op==='library'){libraryOperation(p,o);continue;}
    if(op==='shader'){if(o.graph===undefined)throw Error('请提供完整节点材质或 null');compileMaterialGraph(o.graph,p.assets);if(o.graph==null)delete p.materialGraph;else p.materialGraph=structuredClone(o.graph);continue;}
    if(op==='baseChannels'){p.baseChannels={...p.baseChannels,...fields(patch,channels)};continue;}
    if(op==='base'){Object.assign(p.base,fields(patch,channels));continue;}
    if(op==='add'){
      requireUnlocked(p.layers,p.layers.find(item=>item.id===o.parentId));
      if(o.kind==='group'){p.layers.push(makeFolder(patch,o.parentId??null));continue;}
      const added={name:{fill:'填充层',decal:'贴花层',paint:'绘制层'}[o.kind],visible:true,opacity:1,blend:'normal',
        channels:{color:true,metallic:o.kind==='paint',roughness:o.kind==='paint'},values:{...values},
        x:.5,y:.5,scale:1,rotation:0,mask:null,...fields(patch??{},layerFields),kind:o.kind,id:crypto.randomUUID(),
        ...(o.parentId!=null?{parentId:o.parentId}:{})};
      if(o.placement===undefined)p.layers.push(added);
      else insertMaterialLayers(p.layers,[added],o.placement);
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
        remapPaintAnchors(copy,ids);
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
    }else if(op==='transferMask'){
      fields(o,['op','id','sourceId','copy']);
      const source=p.layers.find(layer=>layer.id===o.sourceId);
      if(source===item||!hasMaterialMask(source)||typeof o.copy!=='boolean')throw Error('请选择另一个材质图层的蒙版');
      if(!o.copy)requireUnlocked(p.layers,source);
      for(const key of materialMaskFields){
        if(Object.hasOwn(source,key))item[key]=structuredClone(source[key]);
        else delete item[key];
        if(!o.copy)delete source[key];
      }
      item.mask??=null;
      if(!o.copy)source.mask=null;
    }else if(op==='removeMask'){
      fields(o,['op','id']);
      if(!hasMaterialMask(item))throw Error('该图层没有蒙版');
      for(const key of materialMaskFields)delete item[key];
      item.mask=null;
    }else if(op==='transformUV'||op==='clearUV'){
      if(item.kind!=='paint'||!item.strokes?.length)throw Error('请选择已有笔触的绘制层');
      if(op==='clearUV'){
        if(!validUVRect(o.rect)||!validUVSelection(o,o.rect))throw Error('选区参数无效');
        item.strokes.push({clearUV:o.rect,...uvShapePayload(o)});
        continue;
      }
      const {copy,interpolation='linear',...transform}=checkedUVTransform(o.transform);
      item.strokes.push({transformUV:{...transform,interpolation,...(copy?{copy:true}:{})}});
    }else if(op==='stroke'){
      if(!['material','mask'].includes(o.target))throw Error('请选择材质或蒙版作为笔触目标');
      const isMask=o.target==='mask',layer=p.layers[i];
      if(!isMask&&layer.kind!=='paint')throw Error('请在绘制层上绘制材质');
      checkStroke(o.stroke,isMask);
      const key=isMask?'maskStrokes':'strokes';
      layer[key]??=[];
      layer[key].push(o.stroke);
    }else throw Error('制作命令无效');
  }
  pinSurfaceInputs(next,{reproject});
  validate(next,{checkPending:!compact});
  if(compact)compactPaintStrokes(p);
  p.layers=layerTreeOrder(p.layers);
  return next;
}
export function applyPlacedMaterial(doc,materialId,placement){
  const existing=new Set(doc.paint.layers.map(layer=>layer.id));
  applyOperations(doc,[libraryFill(doc.paint,materialId,{placement})]);
  return doc.paint.layers.find(layer=>!existing.has(layer.id)).id;
}
export function editPaint(doc,{revision,operations,strokeRequestId},sourceVisibility,textureSeeds){
  let receipt;
  if(strokeRequestId!==undefined){
    if(typeof strokeRequestId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(strokeRequestId)||
       !Array.isArray(operations)||operations.length!==1||!strokeTarget(operations[0]))
      throw Error('笔触保存编号无效');
    const digest=crypto.createHash('sha256').update(JSON.stringify(operations)).digest('hex');
    const saved=doc.strokeSaveReceipts?.find(item=>item.id===strokeRequestId);
    if(saved){
      if(saved.revision!==revision+1||saved.digest!==digest)throw Object.assign(Error('笔触保存编号已被使用'),{status:409,currentRevision:doc.revision});
      return doc;
    }
    receipt={id:strokeRequestId,revision:revision+1,digest};
  }
  if(doc.revision!==revision)throw revisionError(doc);
  return commit(doc.id,revision,next=>{
    const edited=applyOperations(next,operations,sourceVisibility,{compact:true,textureSeeds});
    if(receipt)edited.strokeSaveReceipts=[...(next.strokeSaveReceipts||[]),receipt].slice(-strokeReceiptLimit);
    return edited;
  },Array.isArray(operations)?operations.map(o=>({
    op:o?.op,id:o?.id,...(Array.isArray(o?.ids)?{ids:o.ids}:{})
  })):[]);
}
function paintBinding(doc){const model=modelFingerprint(doc);return model?crypto.createHash('sha256').update(JSON.stringify([bindingFingerprint(doc),model])).digest('hex'):bindingFingerprint(doc);}
let compositorFingerprint;
export function paintBakeFingerprint(doc,binding=paintBinding(doc)){
  compositorFingerprint??=crypto.createHash('sha256').update(JSON.stringify([
    'paint_worker.py','paint_channels.py','paint_surface.py','paint_mask_generators.py','fill_projection.py','material_graph.py','material_noise.py','image_documents.py','image_color_spaces.py','public/color-profiles/sRGB-v4.icc','public/color-profiles/DisplayP3-v4.icc','public/color-profiles/AdobeCompat-v2.icc','public/color-profiles/ProPhoto-v4.icc',
    'public/color-profiles/Gray-g22.icc','public/color-profiles/Gray-linear.icc',
    'public/color-profiles/ACEScg-linear.icc','public/color-profiles/ACES2065-1-linear.icc',
    'public/color-profiles/Rec709-v4.icc','public/color-profiles/Rec2020-v4.icc','public/color-profiles/Rec2020-g24-v4.icc','public/color-profiles/DCI-P3-v4.icc','public/color-profiles/scRGB-v2.icc','image_adjustments.py','image_filters.py','image_raster_tools.py',
    'project_model.py','model-binding.mjs','model_glb.py','model_surface.py',
    '../tools/geometry.py','../tools/prepare_guides.py','../tools/guide_raster.py','../tools/projection_scope.py','../tools/uv_raster.py','../tools/view_select.py'
  ].map(file=>hash(path.join(ROOT,file))))).digest('hex');
  const {objectNames,sceneCursor,renderCamera,renderBookmarks,renderAppearance,renderLighting,renderOptics,renderPreset,renderRegion,renderVisibility,sourceMaterials,textureSets,...content}=doc.paint;
  return crypto.createHash('sha256').update(JSON.stringify([compositorFingerprint,binding,content])).digest('hex');
}
export function materialFingerprint(doc){
  const plan=compileMaterialGraph(doc.paint.materialGraph,doc.paint.assets),fills=fillMaterialPlans(doc),bindings=doc.paint.layers.filter(l=>Object.keys(l.documentMaps??{}).length).map(l=>({id:l.id,documentMaps:l.documentMaps}));
  let input=Object.keys(fills).length?{output:plan,fills}:plan;
  if(bindings.length){const ids=[...new Set(bindings.flatMap(l=>Object.values(l.documentMaps)))].sort();input={output:plan,fills,bindings,imageDocuments:{...Object.fromEntries(ids.map(id=>[id,doc.paint.imageDocuments[id]])),...embeddedDependencies(doc.paint.imageDocuments,ids.flatMap(id=>doc.paint.imageDocuments[id].layers))}};}
  return input?crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'):undefined;
}
function fillMaterialPlans(doc){return Object.fromEntries([...new Set(doc.paint.layers.filter(layer=>layer.materialId).map(layer=>layer.materialId))].sort().map(id=>[id,compileLibraryMaterial(doc.paint.materials[id].graph,doc.paint.assets)]));}
export function paintInput(doc,binding=paintBinding(doc)){
  const {textureSets,...paint}=doc.paint;
  return {activeChannels:activePaintChannels(paint),fillMaterialPlans:fillMaterialPlans(doc),materialPlan:compileMaterialGraph(doc.paint.materialGraph,doc.paint.assets),materialFingerprint:materialFingerprint(doc),source:doc.source,paint,revision:doc.revision,bindingFingerprint:binding,...(modelFingerprint(doc)?{modelFingerprint:modelFingerprint(doc)}:{}),
    assets:Object.fromEntries(Object.keys(doc.paint.assets).map(id=>[id,assetPath(doc,id)]))};
}
function liveOperationAllowed(doc,operation){
  if(operation.op==='image')return ['stroke','transform','clear','updateLayer','layoutLayers','transformMask'].includes(operation.action)||
    operation.action==='addLayer'&&['gradient','shape'].includes(operation.kind);
  if(operation.op==='shader')return true;
  if(operation.op==='library')return operation.library==='materials'&&operation.action==='update'&&Object.hasOwn(doc.paint.materials??{},operation.id);
  if(['stroke','transformUV'].includes(operation.op))return true;
  const keys=Object.keys(operation.patch||{});
  if(!keys.length)return false;
  if(operation.op==='baseChannels')return keys.every(key=>channels.includes(key));
  if(operation.op==='base')return keys.every(key=>channels.includes(key));
  if(operation.op!=='update')return false;
  const item=doc.paint.layers.find(layer=>layer.id===operation.id);
  if(!item)return false;
  if(item.kind==='group')return keys.every(key=>key==='opacity'||key==='maskEffects');
  const allowed=['opacity','values','maskEffects'];
  if(item.kind==='fill')allowed.push('tiling','fillProjection');
  if(item.kind==='decal'){
    if(item.projector)allowed.push('projector');
    else allowed.push('x','y','scale','rotation',...(item.space==='uv'?['uvScale']:[]));
  }
  return keys.every(key=>allowed.includes(key));
}
function liveDraftOperations(doc,operation,operations,imageDocumentId){
  if(operations!==undefined){
    if(operation||!Array.isArray(operations)||!operations.length||operations.length>imageStrokeQueueLimit)
      throw Error('实时笔触批次无效');
    const first=strokeTarget(operations[0]);
    if(!first||imageDocumentId!==undefined&&(first[0]!=='image'||first[1]!==imageDocumentId)||
       operations.some(edit=>{const key=strokeTarget(edit);return !key||key.some((value,index)=>value!==first[index]);}))
      throw Error('实时笔触必须位于同一图层和编辑目标');
    return operations;
  }
  if(!operation)return [];
  if(!liveOperationAllowed(doc,operation)||
     imageDocumentId!==undefined&&(operation.op!=='image'||operation.documentId!==imageDocumentId))
    throw Error('实时预览仅接受当前目标的笔触、变换或材质参数');
  return [operation];
}
export function livePaintInput(doc,{revision,operation,operations,inspectMask,isolatedLayer,pickUv,uvGuide,rawLayer=false,resolution=256,format='legacy'}){
  if(doc.revision!==revision)throw revisionError(doc);
  if(!['legacy','pbr8'].includes(format))throw Error('实时贴图格式无效');
  if(typeof rawLayer!=='boolean'||rawLayer&&(operation||operations||inspectMask||isolatedLayer===undefined||resolution!==256||pickUv!==undefined))throw Error('图层缩略图仅支持已保存的单层 256px 预览');
  if(pickUv!==undefined){
    if(!Array.isArray(pickUv)||pickUv.length!==2||!pickUv.every(unit))throw Error('表面 UV 坐标无效');
    return {...paintInput(doc),pickUv};
  }
  if(![256,512,4096].includes(resolution))throw Error('实时预览分辨率无效');
  const edits=liveDraftOperations(doc,operation,operations);
  if(resolution===4096&&edits.length)throw Error('4K 实时预览仅接受已保存的工程修订');
  const next=edits.length?applyOperations(structuredClone(doc),edits):doc;
  if(inspectMask&&!next.paint.layers.some(l=>l.id===inspectMask))throw Error('蒙版图层不存在');
  if(isolatedLayer!==undefined&&(inspectMask||!next.paint.layers.some(l=>l.id===isolatedLayer)))throw Error('独显图层无效');
  const input=paintInput(next);
  if(rawLayer){input.paint={...input.paint,base:{color:'#383838',metallic:0,roughness:.5}};delete input.paint.baseChannels;delete input.paint.materialGraph;input.materialPlan=null;delete input.materialFingerprint;}
  return {...input,inspectMask,isolatedLayer,uvGuide:uvGuide===true,liveResolution:resolution,liveFormat:format};
}
export function imageDocumentInput(doc,{revision,documentId,operation,operations,inspectMask,isolatedImageLayer,beforeImageLayer,window,documentView=false,resolution=256}){
  if(doc.revision!==revision)throw revisionError(doc);
  const edits=liveDraftOperations(doc,operation,operations,documentId);
  if(window!==undefined){
    if(!Array.isArray(window)||window.length!==3||!window.every(Number.isInteger))throw Error('局部预览范围无效');
    const [x,y,side]=window;
    if(![256,512,768,1024,1536,2048].includes(side)||x<0||y<0||x+side>4096||y+side>4096||
       isolatedImageLayer||beforeImageLayer!==undefined||!edits.length||edits.some(edit=>edit.action!=='stroke'||!edit.stroke.stamps))
      throw Error('局部预览范围无效');
  }
  if(![64,128,256,512,1024,4096].includes(resolution)||resolution===4096&&edits.length)throw Error('图像预览尺寸无效');
  const next=edits.length?applyOperations(structuredClone(doc),edits):doc;
  if(!Object.hasOwn(next.paint.imageDocuments??{},documentId))throw Error('图像文档不存在');
  const image=next.paint.imageDocuments[documentId];
  if(isolatedImageLayer&&!image.layers.some(layer=>layer.id===isolatedImageLayer))throw Error('图像图层不存在');
  if(inspectMask&&!image.layers.some(layer=>layer.id===inspectMask))throw Error('图像蒙版不存在');
  if(beforeImageLayer!==undefined&&(edits.length||inspectMask||isolatedImageLayer||resolution>512))
    throw Error('图像调整采样参数无效');
  const before=beforeImageLayer===undefined?null:imageLayersBeforeAdjustment(image.layers,beforeImageLayer);
  if(beforeImageLayer!==undefined&&!before)throw Error('图像调整图层不存在');

  const thumbnail=documentView&&Boolean(isolatedImageLayer)&&resolution===64;
  const selected=isolatedImageLayer
    ?isolateImageLayer(image.layers,isolatedImageLayer)
    :before??image.layers;
  const layers=inspectMask
    ?selected.filter(layer=>layer.id===inspectMask).map(({id,maskBase,maskStrokes,maskGradient,maskDensity,maskFeather,selectionSources,maskTransform,maskWarpSteps,brushSources})=>({
      id,maskBase,maskStrokes,...(maskGradient?{maskGradient}:{}),...(maskDensity!==undefined?{maskDensity}:{}),
      ...(maskFeather!==undefined?{maskFeather}:{}),...(selectionSources?{selectionSources}:{}),...(maskTransform?{maskTransform}:{}),
      ...(maskWarpSteps?{maskWarpSteps}:{}),...(brushSources?{brushSources}:{})
    }))
    :visibleImageLayers(selected);
  const embedded=embeddedDependencies(next.paint.imageDocuments,image.layers);
  const embeddedAssets=Object.fromEntries(Object.values(embedded).flatMap(source=>source.layers.flatMap(imageLayerAssets)).map(id=>[id,assetPath(next,id)]));
  const assetIds=new Set(layers.flatMap(imageLayerAssets));
  return {
    ...(Object.keys(embedded).length?{embeddedDocuments:embedded,embeddedAssets}:{}),
    paint:{imageDocuments:{[documentId]:{width:image.width,height:image.height,...(image.frame?{frame:image.frame}:{}),colorSpace:image.colorSpace,layers}}},
    assets:Object.fromEntries([...assetIds].map(id=>[id,assetPath(next,id)])),
    revision:next.revision,
    imageDocumentId:documentId,
    ...(thumbnail?{imageThumbnail:true,imageViewSize:thumbnailDimensions(image,resolution)}:
      documentView?{imageViewSize:previewDimensions(image,resolution)}:{}),
    imageInspectMask:inspectMask,...(window?{imageWindow:window}:{}),
    liveResolution:resolution,
    liveFormat:'rgba'
  };
}
export function imageClipboardInput(doc,request){
  const {revision,documentId,layerId,rect,merged=false,cut=false,coverage}=fields(request,['revision','documentId','layerId','rect','merged','cut',...imageSelectionFields]);
  if(!validUVRect(rect)||!validUVSelection(request,rect,true))throw Error('图像复制选区无效');
  if(typeof merged!=='boolean'||typeof cut!=='boolean'||merged&&(layerId!==undefined||cut))throw Error('图像复制来源无效');
  let raw;
  if(!merged){
    const documents=doc.paint.imageDocuments??{};
    const image=Object.hasOwn(documents,documentId)?documents[documentId]:null;
    const layer=image?.layers.find(item=>item.id===layerId);
    if(!layer||!layerIsVisible(image.layers,layer)||!layer.opacity||layer.kind==='adjustment')
      throw Error('请选择包含像素的可见图像图层');
    if(cut){
      if(layer.kind!=='pixel'||layer.alphaLocked)throw Error('请选择可编辑的像素图层并解锁透明像素');
      requireUnlocked(image.layers,layer);
      raw={colorSpace:image.colorSpace,layers:[{id:layer.id,kind:'pixel',visible:true,opacity:1,blend:'normal',
        maskEnabled:false,raster:layer.raster,cloneSources:layer.cloneSources,selectionSources:layer.selectionSources,
        brushSources:layer.brushSources,strokes:layer.strokes??[]}]};
    }
  }
  const input=imageDocumentInput(doc,{revision,documentId,isolatedImageLayer:merged?undefined:layerId,resolution:4096});
  if(raw)input.paint.imageDocuments[documentId]=raw;
  if(coverage!==undefined)input.assets[coverage]=imageSnapshotPath(doc,coverage,'选区覆盖图',true);
  return {...input,clipboardRegion:{rect,...uvShapePayload(request)}};
}
export function imageExportInput(doc,request){
  const {revision,documentId,outputSpace,outputProfile,proof}=fields(request,['revision','documentId','outputSpace','outputProfile','proof']);
  const input=imageDocumentInput(doc,{revision,documentId,resolution:4096});
  if(proof!==undefined&&outputProfile===undefined)throw Error('请选择校样的目标 ICC');
  if(outputSpace!==undefined){
    const source=doc.paint.imageDocuments[documentId].colorSpace;
    if(!imageColorSpaces.some(([space])=>space===outputSpace))throw Error('请选择有效的 PNG 输出颜色空间');
    if((source==='linear')!==(outputSpace==='linear'))throw Error('数据贴图须保留原始通道数值');
    input.exportColorSpace=outputSpace;
  }
  if(outputProfile!==undefined){
    if(outputSpace!==undefined||doc.paint.imageDocuments[documentId].colorSpace==='linear')
      throw Error('请选择单个颜色转换目标，数据贴图须保留原始数值');
    const {data,intent}=fields(outputProfile,['data','intent']);
    if(typeof data!=='string'||data.length>4*Math.ceil(outputProfileLimit/3)||!['perceptual','relative'].includes(intent))
      throw Error('ICC 文件或渲染意图无效');
    const bytes=Buffer.from(data,'base64'),mode=outputProfileMode(bytes,bytes.length);
    if(proof!==undefined){
      const {space,paper,plate,inkLimit,point}=fields(proof,['space','paper','plate','inkLimit','point']);
      if(!['srgb','display-p3'].includes(space)||typeof paper!=='boolean'||paper&&mode!=='CMYK')throw Error('校样显示设置无效');
      if(plate!==undefined&&(mode!=='CMYK'||paper||!['C','M','Y','K','limit'].includes(plate)))throw Error('请选择有效的 CMYK 分色版');
      if(plate==='limit'?(!Number.isFinite(inkLimit)||inkLimit<0||inkLimit>400):inkLimit!==undefined)throw Error('总墨量警戒线须在 0–400% 之间');
      if(point!==undefined){
        const image=doc.paint.imageDocuments[documentId];
        if(mode!=='CMYK'||!Array.isArray(point)||point.length!==2||!point.every(Number.isInteger)||
            point[0]<0||point[0]>=image.width||point[1]<0||point[1]>=image.height)
          throw Error('请选择图像范围内的 CMYK 取样点');
        return {...input,exportProfile:{data,mode,intent},imageProof:{point},imageViewSize:[1,1]};
      }
      return {...input,imagePng:true,exportProfile:{data,mode,intent},imageProof:{space,paper,plate,inkLimit},
        imageViewSize:thumbnailDimensions(doc.paint.imageDocuments[documentId],512)};
    }
    return {...input,exportProfile:{data,mode,intent},exportDocument:true,...(['CMYK','LAB'].includes(mode)?{imageTiff:true}:{imagePng:true})};
  }
  return {...input,imagePng:true,exportDocument:true};
}
export function imageLayoutProbeInput(doc,request){
  const {revision,documentId,layerIds,point,resolution=256}=fields(request,['revision','documentId','layerIds','point','resolution']);
  if(![256,512,1024].includes(resolution)||point===undefined&&resolution!==256)
    throw Error('画布取样分辨率无效');
  const input=imageDocumentInput(doc,{revision,documentId,resolution});
  const image=doc.paint.imageDocuments[documentId];
  if(!Array.isArray(layerIds)||layerIds.length>image.layers.length||new Set(layerIds).size!==layerIds.length||
     layerIds.some(id=>!image.layers.some(layer=>layer.id===id&&layoutKinds.includes(layer.kind)))||
     point!==undefined&&(!Array.isArray(point)||point.length!==2||!point.every(unit)))throw Error('画布取样参数无效');
  if(point){
    input.imageLayoutProbe={point};
    return input;
  }
  const selected=new Set(layerIds);
  const layers=image.layers.filter(layer=>selected.has(layer.id));
  input.paint.imageDocuments[documentId].layers=layers;
  const ids=new Set(layers.flatMap(imageLayerAssets));
  input.assets=Object.fromEntries([...ids].map(id=>[id,assetPath(doc,id)]));
  input.imageLayoutProbe={layerIds};
  return input;
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
function describePng(doc,bytes,name,limit=24){
  if(bytes.length>limit*1024*1024||!completePng(bytes))throw Error('素材须为完整的 PNG，且不超过 '+limit+' MiB 和 8192 像素宽高');
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
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const temporary=destination+'.'+crypto.randomUUID()+'.tmp';
  try{
    fs.writeFileSync(temporary,bytes,{flag:'wx'});
    fs.renameSync(temporary,destination);
  }finally{
    if(fs.existsSync(temporary))fs.unlinkSync(temporary);
  }
}
function imageSnapshotPath(doc,id,label,grayscale=false){
  if(!sha256(id))throw Error(label+'无效');
  const file=path.join(projectDir(doc.id),'assets','paint-'+id+'.png');
  let descriptor;
  try{descriptor=fs.openSync(file,'r');}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    throw Error(label+'已失效，请重新取样');
  }
  try{
    const header=Buffer.alloc(26);
    if(fs.readSync(descriptor,header,0,header.length,0)!==header.length||!header.subarray(0,8).equals(pngSignature)||
       header.readUInt32BE(16)!==4096||header.readUInt32BE(20)!==4096||grayscale&&(header[24]!==8||header[25]!==0))
      throw Error(label+'格式无效，请重新取样');
  }finally{fs.closeSync(descriptor);}
  return file;
}
function registerImageSnapshot(doc,id,label,grayscale=false){
  if(asset(doc,id)&&!grayscale)return;
  imageSnapshotPath(doc,id,label,grayscale);
  doc.paint.assets[id]??={id,file:'paint-'+id+'.png',sha256:id,name:label,width:4096,height:4096,
    ...(grayscale?{purpose:'selection'}:{})};
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
export async function captureImageCloneSource(doc,request,{signal}={}){
  const {revision,documentId,layerId,mode}=fields(request,['revision','documentId','layerId','mode']);
  const input=imageDocumentInput(doc,{revision,documentId,resolution:4096});
  const image=doc.paint.imageDocuments[documentId];
  const layer=image.layers.find(item=>item.id===layerId&&item.kind==='pixel');
  if(!['current','below','visible'].includes(mode)||!layer)throw Error('请选择要修补的像素层');
  if(mode==='below')input.paint.imageDocuments[documentId].layers=visibleImageLayers(imageLayersThrough(image.layers,layerId));
  if(mode==='current'){
    const {strokes,raster,cloneSources,selectionSources,brushSources}=layer;
    const raw={id:layerId,kind:'pixel',visible:true,opacity:1,blend:'normal',maskEnabled:false,
      strokes,raster,cloneSources,selectionSources,brushSources};
    input.paint.imageDocuments[documentId].layers=[raw];
    input.assets=Object.fromEntries(imageLayerAssets(raw).map(id=>[id,assetPath(doc,id)]));
  }
  const pixels=await livePaint({...input,imagePng:true},{signal});
  signal?.throwIfAborted();
  const latest=read(doc.id);
  if(latest.revision!==revision)throw revisionError(latest);
  const png=describePng(doc,pixels,'像素取样',64);
  ensurePaintAsset(doc,png);
  return {asset:png.entry.id};
}
function edgeSourceLayers(image,layerId){
  const [root,...children]=isolateImageLayer(image.layers,layerId);
  if(!root||!['image','pixel','shape'].includes(root.kind))throw Error('请选择要修边的图像、像素或形状图层');
  const raw={...root,visible:true,opacity:1,blend:'normal',maskEnabled:false};
  delete raw.styles;delete raw.blendIf;delete raw.edgeDecontaminate;
  return [raw,...children];
}
export function imageEdgeViewInput(doc,request){
  const {revision,documentId,layerId,view,selection}=fields(request,['revision','documentId','layerId','view','selection']);
  if(!['original','black','white','overlay','mask'].includes(view))throw Error('检查视图无效');
  const input=imageDocumentInput(doc,{revision,documentId,resolution:1024});
  const layers=edgeSourceLayers(doc.paint.imageDocuments[documentId],layerId);
  input.paint.imageDocuments[documentId].layers=layers;
  input.assets=Object.fromEntries(layers.flatMap(imageLayerAssets).map(id=>[id,assetPath(doc,id)]));
  if(selection){
    fields(selection,['rect',...imageSelectionFields]);
    if(!validUVRect(selection.rect)||!validUVSelection(selection,selection.rect,true))throw Error('当前选区无效');
    if(selection.coverage)input.assets[selection.coverage]=imageSnapshotPath(doc,selection.coverage,'选区覆盖图',true);
  }
  return {...input,imageEdgeView:{view,selection}};
}
export async function sampleImageSelection(doc,request,{signal}={}){
  const {revision,documentId,layerId,source,point,tolerance,contiguous,operation,previous,pixels,candidate,transform,path:curve,feather,edge}=fields(request,
    ['revision','documentId','layerId','source','point','tolerance','contiguous','operation','previous','pixels','candidate','transform','path','feather','edge']);
  const wand=source==='wand',range=source==='colorRange',refine=source==='refine',pen=source==='path';
  const visibleAlpha=source==='visibleAlpha';
  if(!['alpha','visibleAlpha','mask','wand','colorRange','refine','path'].includes(source)||
     (wand||range?(!vector(point,2,1)||!point.every(unit)||!Number.isInteger(tolerance)||!ranged(tolerance,0,255)||
       (wand?typeof contiguous!=='boolean':contiguous!==undefined)):point!==undefined||tolerance!==undefined||contiguous!==undefined))
    throw Error('选区取样参数无效');
  if(pen?(!validPenPath(curve)||!curve.closed||layerId!==undefined||
      feather!==undefined&&(!Number.isInteger(feather)||!ranged(feather,0,maxUVFeather))):curve!==undefined||feather!==undefined)
    throw Error('请选择有效的闭合路径');
  const local=operation==='localEdge';
  if(local){
    fields(edge,['points','radius','amount','layerId','foreground','background']);
    if(!refine||!Array.isArray(edge.points)||!edge.points.length||edge.points.length>2048||
       edge.points.some(point=>!vector(point,2,1)||!point.every(unit))||
       !Number.isInteger(edge.radius)||!ranged(edge.radius,2,512)||
       !Number.isInteger(edge.amount)||!ranged(edge.amount,-64,64)||
       edge.layerId!==undefined&&(typeof edge.layerId!=='string'||![edge.foreground,edge.background].every(point=>
         point===undefined||vector(point,2,1)&&point.every(unit)))||
       edge.layerId===undefined&&(edge.foreground!==undefined||edge.background!==undefined))throw Error('局部修边参数无效');
  }else if(edge!==undefined)throw Error('局部修边参数无效');
  const combine=['add','subtract','intersect'].includes(operation),sizeEdit=['expand','contract','smooth'].includes(operation);
  if(!['replace','add','subtract','intersect','invert','expand','contract','smooth','reshape','localEdge'].includes(operation)||
     !refine&&operation!=='replace'&&!combine||
     (sizeEdit?!Number.isInteger(pixels)||!ranged(pixels,1,256):pixels!==undefined))
    throw Error('选区修改参数无效');
  const input=imageDocumentInput(doc,{revision,documentId,resolution:4096,inspectMask:source==='mask'?layerId:undefined});
  const image=doc.paint.imageDocuments[documentId];
  const layer=image.layers.find(item=>item.id===layerId);
  if((source==='alpha'||visibleAlpha||source==='mask'||layerId!==undefined)&&(!layer||source==='mask'&&!hasImageLayerMask(layer)||source!=='mask'&&layer.kind==='adjustment'))
    throw Error('请选择包含像素或蒙版的图层');
  for(const shape of [previous,candidate])if(shape!==undefined){
    fields(shape,['rect',...imageSelectionFields]);
    if(!validUVRect(shape.rect)||!validUVSelection(shape,shape.rect,true))throw Error('当前选区无效');
    if(shape.coverage)input.assets[shape.coverage]=imageSnapshotPath(doc,shape.coverage,'选区覆盖图',true);
  }
  if((candidate!==undefined)!==(refine&&combine)||(transform!==undefined)!==(operation==='reshape'))throw Error('选区修改参数无效');
  if(transform){
    fields(transform,['offset','scale','angle','pivot']);
    if(!vector(transform.pivot,2,1)||!transform.pivot.every(unit))throw Error('选区变换中心无效');
    checkedUVTransform({...transform,rect:previous?.rect},true);
  }
  let alphaInput;
  if(visibleAlpha){
    const ancestors=[];
    for(let parent=layerParent(layer);parent;parent=layerParent(ancestors.at(-1)))
      ancestors.push(image.layers.find(item=>item.id===parent));
    const base=layer.clipped?imageClippingBase(image.layers,image.layers.indexOf(layer)):null;
    const sources=[layer,base].filter(Boolean).map(item=>{
      const [root,...children]=isolateImageLayer(image.layers,item.id);
      delete root.blendIf;
      if(root.kind!=='group')root.blend='normal';
      return visibleImageLayers([root,...children]);
    });
    input.paint.imageDocuments[documentId].layers=sources[0];
    const ids=new Set([...sources.flat(),...ancestors].flatMap(imageLayerAssets));
    input.assets={...Object.fromEntries([previous?.coverage].filter(Boolean).map(id=>[id,input.assets[id]])),
      ...Object.fromEntries([...ids].map(id=>[id,assetPath(doc,id)]))};
    alphaInput={base:sources[1],ancestors};
  }else if(refine||pen){
    if(refine&&(layerId!==undefined||!previous&&(sizeEdit||local||operation==='reshape'||operation==='replace')))throw Error('请先在画布上建立选区');
    const layers=edge?.layerId===undefined?[]:edgeSourceLayers(image,edge.layerId);
    input.paint.imageDocuments[documentId].layers=layers;
    input.assets={...Object.fromEntries([previous?.coverage,candidate?.coverage].filter(Boolean).map(id=>[id,input.assets[id]])),
      ...Object.fromEntries(layers.flatMap(imageLayerAssets).map(id=>[id,assetPath(doc,id)]))};
  }else if(layer&&source!=='mask'){
    const [root,...children]=isolateImageLayer(image.layers,layerId);
    const layers=visibleImageLayers([{...root,visible:true,opacity:1,blend:'normal',maskEnabled:false},...children]);
    input.paint.imageDocuments[documentId].layers=layers;
    const coverageInputs=Object.fromEntries([previous?.coverage,candidate?.coverage].filter(Boolean).map(id=>[id,input.assets[id]]));
    input.assets={...coverageInputs,...Object.fromEntries(layers.flatMap(imageLayerAssets).map(id=>[id,assetPath(doc,id)]))};
  }
  const result=await livePaint({...input,imageSelectionSample:{source,point,tolerance,contiguous,operation,previous,pixels,candidate,transform,edge,
    ...(pen?{vertices:flattenPenPath(curve),feather}:{}),...(source==='mask'?{maskId:layerId}:{}),
    ...(alphaInput?{alphaInput}:{})}},{signal});
  signal?.throwIfAborted();
  const latest=read(doc.id);
  if(latest.revision!==revision)throw revisionError(latest);
  const length=result.readUInt32BE(0),outline=JSON.parse(result.toString('utf8',4,4+length));
  if(!outline)return null;
  const png=describePng(doc,result.subarray(4+length),'选区覆盖图',24);
  ensurePaintAsset(doc,png);
  return {...outline,coverage:png.entry.id};
}
export async function bakeImageLayers(doc,request,{signal}={}){
  const {revision,documentId,action,layerIds,newLayerId}=fields(request,['revision','documentId','action','layerIds','newLayerId']);
  const input=imageDocumentInput(doc,{revision,documentId,resolution:4096});
  const image=doc.paint.imageDocuments[documentId];
  if(typeof action!=='string'||!Object.hasOwn(imageCombineLabels,action)||!Array.isArray(layerIds)||
     layerIds.length>image.layers.length||layerIds.some(id=>typeof id!=='string'))throw Error('图层操作参数无效');
  const rasterize=action==='rasterize',stamp=action==='stampVisible';
  let plan;
  if(rasterize){
    const layer=image.layers.find(item=>item.id===layerIds[0]);
    const styled=layer&&(hasImageStyle(layer)||!!layer.edgeDecontaminate?.amount&&layer.maskEnabled);
    if(layerIds.length!==1||!layer||!(['image','shape'].includes(layer.kind)||styled&&['pixel','group'].includes(layer.kind)))
      throw Error('请选择要栅格化的图像、文字、形状或已应用样式的图层');
    const children=layer.kind==='group'?layerTreeOrder(image.layers,layer.id):[];
    for(const child of children)requireUnlocked(image.layers,child);
    requireUnlocked(image.layers,layer);
    const content={...layer,visible:true,blend:'normal',opacity:1,maskEnabled:!!styled&&layer.maskEnabled};
    delete content.blendIf;
    delete content.parentId;
    delete content.clipped;
    plan={render:[content,...children],name:layer.name,bottom:layer.id,styled,children:children.map(item=>item.id)};
  }else{
    plan=planImageCombine(image.layers,action,layerIds);
    if(stamp&&(typeof newLayerId!=='string'||!/^[\w-]{1,100}$/.test(newLayerId)||image.layers.some(item=>item.id===newLayerId)))
      throw Error('盖印图层编号无效');
    if(stamp&&image.layers.length>=imageLayerLimit)throw Error('请先合并图层，为盖印结果腾出空间');
  }
  const layers=visibleImageLayers(plan.render);
  input.paint.imageDocuments[documentId]={colorSpace:image.colorSpace,layers};
  input.assets=Object.fromEntries(layers.flatMap(layer=>imageLayerAssets(layer).map(id=>[id,assetPath(doc,id)])));
  const pixels=await livePaint({...input,imagePng:true},{signal});
  signal?.throwIfAborted();
  const png=describePng(doc,pixels,plan.name+' · 像素',64);
  return writePaintAsset(doc,revision,png,imageCombineLabels[action],next=>{
    const target=next.paint.imageDocuments[documentId];
    const raster=png.entry.id;
    if(rasterize){
      const layer=target.layers.find(item=>item.id===plan.bottom);
      for(const field of ['asset','embedded','text','textOrigin','shape','x','y','scale','rotation','stretch','warp','styles','strokes','edgeDecontaminate'])delete layer[field];
      if(plan.styled)clearImageLayerMask(layer);
      if(layer.blend==='passThrough')layer.blend='normal';
      if(plan.children.length){
        const detached=new Set(plan.children);
        target.layers=target.layers.filter(item=>!detached.has(item.id));
      }
      Object.assign(layer,{kind:'pixel',raster});
    }else{
      const replacement={id:stamp?newLayerId:plan.bottom,kind:'pixel',name:plan.name,raster,...imageLayerDefaults,...plan.appearance,
        ...(plan.parent?{parentId:plan.parent}:{})};
      if(stamp){
        // Preserve the source stack and avoid compositing its translucent
        // pixels a second time under the stamp.
        for(const layer of target.layers)if(layerParent(layer)===null&&layer.visible)layer.visible=false;
        target.layers.push(replacement);
      }
      else {
        const removed=new Set(plan.remove);
        target.layers=target.layers.flatMap(layer=>layer.id===plan.bottom?[replacement]:removed.has(layer.id)?[]:[layer]);
      }
    }
    validate(next);
  }).document;
}
export async function meshMapOperation(doc,request,operation,signal,highModel){
  const {revision}=request;
  let config,names,target;
  if(operation==='mesh-normal'){
    const {resolution,front,rear,createLayer}=fields(request,['revision','resolution','front','rear','createLayer']);
    if(![512,1024,2048,4096].includes(resolution)||![front,rear].every(v=>Number.isFinite(v)&&v>=0)||
      !Number.isFinite(front+rear)||front+rear===0||typeof createLayer!=='boolean')throw Error('请选择有效的分辨率与投射距离');
    if(doc.revision!==revision)throw revisionError(doc);
    const {source}=await prepareModelGeometry(doc,{signal});
    config={source,resolution,front,rear,highModel,steps:doc.modeling?.steps??[]};
    names={normal:'高模 · 切线法线'};
  }else if(operation==='mesh-bake'){
    const {resolution,idSource}=fields(request,['revision','resolution','idSource']);
    if(![512,1024,2048].includes(resolution)||!['material','object','vertex'].includes(idSource))throw Error('网格贴图参数无效');
    const {source}=await prepareModelGeometry(doc,{signal});
    config={source,resolution,idSource};
    names={ao:'环境遮蔽 AO',curvature:'曲率',id:{material:'材质槽 ID',object:'物体 ID',vertex:'顶点色 ID'}[idSource]};
  }else{
    const {image,layerId,mode,color:pick}=fields(request,['revision','image','layerId','mode','color']);
    if(!asset(doc,image)||!['cavity','convex','concave','id'].includes(mode)||mode==='id'&&!color(pick))
      throw Error('请选择有效的网格贴图与取样方式');
    target=doc.paint.layers.find(layer=>layer.id===layerId);
    if(!target)throw Error('请选择材质图层或文件夹');
    requireUnlocked(doc.paint.layers,target);
    config={file:assetPath(doc,image),mode,color:pick};
    names={mask:'蒙版 · '+({cavity:'积灰',convex:'凸边',concave:'凹槽',id:pick}[mode])};
  }
  const scratch=await fsp.mkdtemp(path.join(projectDir(doc.id),'.mesh-bake-'));
  try{
    await fsp.writeFile(path.join(scratch,'input.json'),JSON.stringify({...config,ownerPid:process.pid}));
    try{
      await renderTextFile(pythonExecutable(),['-X','utf8',path.join(ROOT,'mesh_maps.py'),scratch],{windowsHide:true,signal});
    }catch(error){
      if(signal?.aborted)throw error;
      throw Error(error.stderr?.trim().split(/\r?\n/).at(-1)||error.message);
    }
    const pictures={};
    for(const [key,title] of Object.entries(names))
      pictures[key]=describePng(doc,await fsp.readFile(path.join(scratch,key+'.png')),title+'.png',64);
    const coverage=highModel?JSON.parse(await fsp.readFile(path.join(scratch,'coverage.json'),'utf8')):null;
    signal?.throwIfAborted();
    const updated=commit(doc.id,revision,next=>{
      for(const png of Object.values(pictures)){
        ensurePaintAsset(doc,png);
        next.paint.assets[png.entry.id]=png.entry;
      }
      if(highModel&&request.createLayer){
        applyOperations(next,[{op:'add',kind:'fill',patch:{name:'高模法线',channels:Object.fromEntries(channels.map(k=>[k,k==='normal'])),maps:{normal:pictures.normal.entry.id}}}]);
        validate(next);
      }
      if(target)Object.assign(next.paint.layers.find(layer=>layer.id===target.id),{mask:pictures.mask.entry.id,maskEnabled:true});
      return next;
    },highModel?'烘焙高模切线法线':target?'从网格贴图提取蒙版':'烘焙网格贴图');
    return {revision:updated.revision,...(coverage?{coverage}:{}),maps:Object.fromEntries(Object.entries(pictures).map(([key,png])=>[key,png.entry.id]))};
  }finally{await fsp.rm(scratch,{recursive:true,force:true});}
}

async function normalizeImageFiles(files,scratch){
  const manifest=path.join(scratch,'maps.json');
  await fsp.writeFile(manifest,JSON.stringify(files),{flag:'wx'});
  try{
    const {stdout}=await renderTextFile(process.env.ARACHNE_PYTHON||'python',
      ['-X','utf8',path.join(ROOT,'material_image_import.py'),manifest],{windowsHide:true,timeout:90000,maxBuffer:64*1024});
    const converted=JSON.parse(stdout);
    if(!Array.isArray(converted)||converted.length!==files.length||converted.some((file,i)=>file!==files[i].source&&file!==files[i].destination))
      throw Error('贴图转换结果不完整');
    return converted;
  }catch(error){
    const reason=error.stderr?.trim().split(/\r?\n/).at(-1);
    throw Error(reason&&/^[\u4e00-\u9fff]/.test(reason)?reason:'图片转换失败');
  }
}
export async function importPaintMaps(doc,revision,files,scratch){
  if(doc.revision!==revision)throw revisionError(doc);
  const converted=await normalizeImageFiles(files,scratch);
  const current=read(doc.id);
  if(current.revision!==revision)throw revisionError(current);
  const pictures=[];
  for(const [index,file] of converted.entries())pictures.push(describePng(current,await fsp.readFile(file),files[index].name,64));
  const unique=new Map(pictures.map(png=>[png.entry.id,png]));
  const saved=[...unique.values()].every(png=>png.existing)?current:commit(current.id,revision,next=>{
    for(const png of unique.values())next.paint.assets[png.entry.id]=png.entry;
    for(const png of unique.values())ensurePaintAsset(current,png);
    return next;
  },'导入材质贴图');
  if(saved===current){
    const latest=read(doc.id);
    if(latest.revision!==revision)throw revisionError(latest);
    for(const png of unique.values())ensurePaintAsset(current,png);
  }
  return {document:saved,uploaded:pictures.map((png,index)=>({id:png.entry.id,name:files[index].name}))};
}
export async function openDocumentPhoto(doc,request){
  const {revision,name,data,inputFormat,openWorkingSpace}=fields(request,['revision','name','data','inputFormat','openWorkingSpace']);
  if(doc.revision!==revision)throw revisionError(doc);
  if(!['png','jpeg','webp','tiff'].includes(inputFormat)||typeof name!=='string'||typeof data!=='string'||
     openWorkingSpace!=='auto'&&!imageColorSpaces.some(([id])=>id===openWorkingSpace))throw Error('图片格式或文档颜色空间无效');
  const bytes=Buffer.from(data,'base64');
  if(!bytes.length||bytes.length>24*1024*1024)throw Error('图片大小须在 24 MiB 以内');
  const scratch=await fsp.mkdtemp(path.join(projectDir(doc.id),'open-image-'));
  try{
    const source=path.join(scratch,'source'),destination=path.join(scratch,'picture.png'),documentInfo=path.join(scratch,'color.json');
    await fsp.writeFile(source,bytes);
    await normalizeImageFiles([{source,destination,documentInfo,name:'image.'+inputFormat,openWorkingSpace}],scratch);
    const {colorSpace,sourceProfile}=JSON.parse(await fsp.readFile(documentInfo,'utf8'));
    const title=(path.basename(name).replace(/\.[^.]*$/,'').trim()||'打开的图像').slice(0,100);
    const png=describePng(doc,await fsp.readFile(destination),title,64);
    const patch={name:title,colorSpace,width:png.entry.width,height:png.entry.height};
    const [left,top,w,h]=documentFrame(patch);
    const documentId=crypto.randomUUID(),layerId=crypto.randomUUID();
    const result=writePaintAsset(doc,revision,png,'打开图像 · '+title,current=>applyOperations(current,[
      {op:'image',action:'create',documentId,patch},
      {op:'image',action:'addLayer',documentId,layerId:crypto.randomUUID(),kind:'image',
       patch:{asset:png.entry.id,name:title,x:(left+w/2)/editingSide,y:(top+h/2)/editingSide,scale:Math.max(w,h)/editingSide}},
      {op:'image',action:'addLayer',documentId,layerId,kind:'pixel'}
    ]));
    return {...result,documentId,layerId,sourceProfile,colorSpace};
  }finally{await fsp.rm(scratch,{recursive:true,force:true});}
}
export async function importDocumentPhoto(doc,request){
  const {revision,imageLayer,inputFormat,name,data,pixelSize=false}=request;
  if(doc.revision!==revision)throw revisionError(doc);
  const documents=doc.paint.imageDocuments??{};
  if(!Object.hasOwn(documents,imageLayer?.documentId)||!['jpeg','webp','tiff'].includes(inputFormat)||typeof data!=='string'||typeof name!=='string'||typeof pixelSize!=='boolean')
    throw Error('请选择图像文档以及有效的 JPEG、WebP 或 TIFF 图片');
  const bytes=Buffer.from(data,'base64');
  if(!bytes.length||bytes.length>24*1024*1024)throw Error('图片大小须在 24 MiB 以内');
  const folder=await fsp.mkdtemp(path.join(projectDir(doc.id),'photo-import-'));
  try{
    const source=path.join(folder,'source'),destination=path.join(folder,'picture.png');
    await fsp.writeFile(source,bytes);
    const [output]=await normalizeImageFiles([{source,destination,name:'photo.'+inputFormat,workingSpace:documents[imageLayer.documentId].colorSpace}],folder);
    const current=read(doc.id);
    if(current.revision!==revision)throw revisionError(current);
    const png=await fsp.readFile(output);
    const nativeScale=Math.max(png.readUInt32BE(16),png.readUInt32BE(20))/4096;
    return importPaint(current,{...request,imageLayer:{...imageLayer,scale:imageLayer.scale??(pixelSize?nativeScale:Math.min(1,nativeScale))},
      name:(name.replace(/\.[^.]*$/,'')||'导入图片')+'.png'},png);
  }finally{await fsp.rm(folder,{recursive:true,force:true});}
}
export function importPaint(doc,{revision,name,data,maskLayerId,placement,nodeId,materialId,imageLayer},decodedBytes){
  if(doc.revision!==revision)throw revisionError(doc);
  const image=imageLayer===undefined?null:fields(imageLayer,['documentId','layerId','x','y','scale','index','parentId']);
  if(image&&(image.x!==undefined||image.y!==undefined)&&(!unit(image.x)||!unit(image.y)))throw Error('图像图层放置参数无效');
  if(image?.scale!==undefined&&!ranged(image.scale,1/4096,4))throw Error('图像图层缩放无效');
  if(image&&(maskLayerId!==undefined||placement!==undefined||nodeId!==undefined||materialId!==undefined))throw Error('请选择单个图像导入目标');
  if(materialId!==undefined&&(typeof materialId!=='string'||!Object.hasOwn(doc.paint.materials??{},materialId)||nodeId===undefined))throw Error('节点材质不存在');
  const targetGraph=materialId===undefined?doc.paint.materialGraph:doc.paint.materials[materialId].graph;
  const imageNode=nodeId===undefined?null:targetGraph?.nodes.find(node=>node.id===nodeId&&node.type==='image');
  if(nodeId!==undefined&&(!imageNode||maskLayerId!==undefined||placement!==undefined))throw Error('请选择单个图像节点导入 PNG');
  const place=placement===undefined?null:fields(placement,['x','y','parentId']);
  if(place&&(!unit(place.x)||!unit(place.y)||maskLayerId!==undefined))throw Error('画布图片放置参数无效');
  const target=maskLayerId===undefined?null:doc.paint.layers.find(layer=>layer.id===maskLayerId);
  if(maskLayerId!==undefined&&!target)throw Error('蒙版图层不存在');
  requireUnlocked(doc.paint.layers,target);
  const png=describePng(doc,decodedBytes??(typeof data==='string'?Buffer.from(data,'base64'):Buffer.alloc(0)),name);
  const {entry,existing,label}=png;
  if(existing&&!image&&!place&&(!target||target.mask===entry.id)&&(!imageNode||imageNode.params.asset===entry.id)){
    ensurePaintAsset(doc,png);
    return {document:doc,asset:entry};
  }
  return writePaintAsset(doc,revision,png,image?'导入图像图层':place?'导入并放置画布图片':target?'保存图层蒙版':imageNode?'导入节点图像':'导入涂装素材',p=>{
    if(imageNode){(materialId===undefined?p.paint.materialGraph:p.paint.materials[materialId].graph).nodes.find(node=>node.id===nodeId).params.asset=entry.id;validate(p);}
    if(target)p.paint.layers.find(layer=>layer.id===target.id).mask=entry.id;
    if(image)applyOperations(p,[{op:'image',action:'addLayer',documentId:image.documentId,layerId:image.layerId,kind:'image',
      index:image.index,parentId:image.parentId,patch:{asset:entry.id,name:label,...(image.x===undefined?{}:{x:image.x,y:image.y}),
        ...(image.scale===undefined?{}:{scale:image.scale})}}]);
    if(place)applyOperations(p,[{op:'add',kind:'decal',parentId:place.parentId,patch:{
      image:entry.id,name:label,space:'uv',x:place.x,y:place.y,scale:.25
    }}]);
  });
}
const renderTextFile=promisify(execFile);
export async function importPaintFont(doc,request){
  const {revision,name,data}=fields(request,['revision','name','data']);
  if(doc.revision!==revision)throw revisionError(doc);
  const extension=typeof name==='string'&&name.match(/\.(ttf|otf)$/i)?.[1].toLowerCase();
  const bytes=typeof data==='string'&&Buffer.from(data,'base64');
  if(!extension||!bytes||bytes.length<12||bytes.length>32*1024*1024||
     !(bytes.readUInt32BE(0)===0x10000||bytes.toString('ascii',0,4)==='OTTO'))throw Error('请选择有效的 TTF 或 OTF 字体（最大 32 MiB）');
  const id=crypto.createHash('sha256').update(bytes).digest('hex');
  const registered=textFontRegistry(doc)[id];
  const file=registered?.file??'font-'+id+'.'+extension;
  const assets=path.join(projectDir(doc.id),'assets');
  await fsp.mkdir(assets,{recursive:true});
  const scratch=await fsp.mkdtemp(path.join(assets,'.font-'));
  try{
    const temporary=path.join(scratch,file);
    await fsp.writeFile(temporary,bytes);
    let metadata;
    try{
      const {stdout}=await renderTextFile(process.env.ARACHNE_PYTHON||'python',
        ['-X','utf8',path.join(ROOT,'paint_text.py'),'--inspect',temporary],{windowsHide:true,timeout:10_000,maxBuffer:256*1024});
      metadata=JSON.parse(stdout);
    }catch(error){
      if(error.code==='ENOENT')throw error;
      throw Error('无法读取该字体的家族、字形或字重');
    }
    const entry=checkedFontEntry(id,{file,...metadata});
    const current=read(doc.id);
    if(current.revision!==revision)throw revisionError(current);
    fs.renameSync(temporary,path.join(assets,file));
    const document=registered?current:commit(doc.id,revision,next=>{
      next.paint.textFonts??={};
      next.paint.textFonts[id]=entry;
      return next;
    },'添加工程字体');
    return {document,id};
  }finally{await fsp.rm(scratch,{recursive:true,force:true});}
}
async function withRenderedText(doc,style,consume,signal){
  const assetFolder=path.join(projectDir(doc.id),'assets');
  fs.mkdirSync(assetFolder,{recursive:true});
  const scratch=fs.mkdtempSync(path.join(assetFolder,'.text-'));
  try{
    const input=path.join(scratch,'text.json'),output=path.join(scratch,'text.png');
    fs.writeFileSync(input,JSON.stringify(style));
    const files=textFonts[style.font||'sourceHan']?.paths;
    const primary=files?path.join(ROOT,'public',files[style.weight===700&&files.length===2?1:0]):await paintFontFile(doc,style.font);
    let origin;
    try{
      const {stdout}=await renderTextFile(process.env.ARACHNE_PYTHON||'python',['-X','utf8',path.join(ROOT,'paint_text.py'),
        input,path.join(ROOT,'public',textFonts.sourceHan.paths[0]),output,primary],
      {windowsHide:true,timeout:10_000,maxBuffer:256*1024,signal});
      origin=JSON.parse(stdout);
    }catch(error){
      if(signal?.aborted)throw error;
      throw Error(error.stderr?.trim().split(/\r?\n/).at(-1)||'无法生成文字贴图');
    }
    const png=describePng(doc,fs.readFileSync(output),textLayerName(style)+'.png');
    return await consume(png,output,origin);
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
function replaceTextLayer(doc,layer,style,entry,assetField,origin){
  const old=asset(doc,layer[assetField]);
  const prior=Math.max(old.width,old.height),edge=Math.max(entry.width,entry.height);
  const inImage=assetField==='asset',anchored=inImage&&layer.textOrigin!==undefined;
  const paragraph=inImage&&layer.text.box&&style.box;
  const at=(text,asset,offset)=>warpPoint(layer.warp,offset||paragraph?
    (offset??paragraphOrigin(text)).map((value,i)=>value/(i?asset.height:asset.width)):[.5,.5],false,true);
  const before=inImage&&(anchored||paragraph||layer.warp)?
    imagePlacement(layer,doc.paint.assets).toCanvas(at(layer.text,old,layer.textOrigin)):null;
  layer.scale=Math.max(inImage?1/4096:.01,Math.min(4,layer.scale*edge/prior));
  if(layer.name===textLayerName(layer.text))layer.name=textLayerName(style);
  layer[assetField]=entry.id;
  layer.text=style;
  if(anchored)layer.textOrigin=style.box?paragraphOrigin(style):origin;
  if(before){
    const after=imagePlacement(layer,doc.paint.assets).toCanvas(at(style,entry,layer.textOrigin));
    layer.x+=before[0]-after[0];
    layer.y+=before[1]-after[1];
  }
}

export async function previewImageText(doc,request,{signal}={}){
  const {revision,documentId,resolution,textDraft,inspectMask,documentView}=fields(request,['revision','documentId','resolution','textDraft','inspectMask','documentView']);
  if(doc.revision!==revision)throw revisionError(doc);
  if(![256,512,1024].includes(resolution)||inspectMask!=null)throw Error('文字预览参数无效');
  const {layerId,content,box}=fields(textDraft,['layerId','content','box']);
  const documents=doc.paint.imageDocuments??{};
  const layer=Object.hasOwn(documents,documentId)&&documents[documentId].layers.find(item=>item.id===layerId&&item.text);
  if(!layer)throw Error('请选择可编辑的文字层');
  if(typeof content!=='string')throw Error('文字参数无效');
  const inputFor=next=>imageDocumentInput(next,{revision,documentId,resolution,documentView});
  if(!content.trim()){
    const next=structuredClone(doc);
    next.paint.imageDocuments[documentId].layers.find(item=>item.id===layerId).visible=false;
    return livePaint(inputFor(next),{signal});
  }
  if(content===layer.text.content&&isDeepStrictEqual(box,layer.text.box))return livePaint(inputFor(doc),{signal});
  const style=checkedText({...textDefaults,...layer.text,content,...(box===undefined?{}:{box})},textFontRegistry(doc));
  return withRenderedText(doc,style,(png,file,origin)=>{
    signal?.throwIfAborted();
    const next=structuredClone(doc);
    next.paint.assets[png.entry.id]=png.entry;
    replaceTextLayer(next,next.paint.imageDocuments[documentId].layers.find(item=>item.id===layerId),style,png.entry,'asset',origin);
    const input=inputFor(next);
    if(Object.hasOwn(input.assets,png.entry.id))input.assets[png.entry.id]=file;
    // Once queued, the compositor owns this temporary PNG until it replies.
    return livePaint(input);
  },signal);
}

export async function savePaintText(doc,{revision,text,placement,layerId,documentId}){
  if(doc.revision!==revision)throw revisionError(doc);
  const style=checkedText(text,textFontRegistry(doc));
  const inImage=documentId!==undefined,documents=doc.paint.imageDocuments??{};
  if(inImage&&(typeof documentId!=='string'||!Object.hasOwn(documents,documentId)))throw Error('图像文档不存在');
  const layers=inImage?documents[documentId].layers:doc.paint.layers,assetField=inImage?'asset':'image';
  const target=layerId===undefined?null:layers.find(item=>item.id===layerId&&item.text);
  if(layerId!==undefined&&!target)throw Error('请选择可编辑的文字层');
  requireUnlocked(layers,target);
  const place=placement===undefined?null:fields(placement,inImage?['x','y','index','parentId','anchor']:['x','y','parentId']);
  if((target&&place)||(!target&&(!place||!unit(place.x)||!unit(place.y)||place.anchor!==undefined&&place.anchor!=='start')))throw Error('文字放置位置无效');
  const {png,origin}=await withRenderedText(doc,style,(png,_file,origin)=>({png,origin}));
  const current=read(doc.id);
  if(current.revision!==revision)throw revisionError(current);
  const name=textLayerName(style),{entry}=png;
  const {width,height}=entry,edge=Math.max(width,height);
  if(target&&target[assetField]===entry.id&&isDeepStrictEqual(target.text,style)){
    ensurePaintAsset(current,png);
    return {document:current,asset:entry,layerId};
  }
  let selected=layerId;
  const result=writePaintAsset(current,revision,png,target?'编辑文字层':'添加文字层',p=>{
    const currentLayers=inImage?p.paint.imageDocuments[documentId].layers:p.paint.layers;
    const existingLayer=target&&currentLayers.find(item=>item.id===layerId);
    if(existingLayer){
      replaceTextLayer(p,existingLayer,style,entry,assetField,origin);
    }else if(inImage){
      selected=crypto.randomUUID();
      const [left,top]=style.box?paragraphOrigin(style):origin??[0,0];
      const x=place.anchor==='start'?place.x+(width/2-left)/4096:place.x;
      const y=place.anchor==='start'?place.y+(height/2-top)/4096:place.y;
      applyOperations(p,[{op:'image',action:'addLayer',documentId,layerId:selected,kind:'image',index:place.index,parentId:place.parentId,
        patch:{asset:entry.id,name,x,y,scale:Math.max(.01,edge/4096)}}]);
      const added=currentLayers.find(item=>item.id===selected);
      added.text=style;
      if(place.anchor==='start'&&!style.box&&origin)added.textOrigin=origin;
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
    if(source.format==='glb'){
      const relative=path.relative(path.dirname(source.reviewSource),file).split(path.sep).join('/');
      if(relative.startsWith('history/'))return relative;
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
    fields(layer,layer?.kind==='group'?[...common,...folderFields,'maskStrokes']:[...common,...layerFields,'strokes','maskStrokes','text','surfaceBinding']);
    if(!validId(layer.id)||(layer.parentId!=null&&!validId(layer.parentId)))throw Error('图层编号无效');
    for(const key of ['strokes','maskStrokes']){
      if(layer[key]===undefined)continue;
      const isMask=key==='maskStrokes';
      if((!isMask&&layer.kind!=='paint')||!Array.isArray(layer[key]))
        throw Error('图层笔触无效');
      function validateStroke(stroke){
        if(!isMask&&stroke?.transformUV!==undefined){
          fields(stroke,['transformUV']);
          checkedUVTransform(stroke.transformUV);
        }else if(!isMask&&stroke?.clearUV!==undefined){
          fields(stroke,['clearUV',...uvShapeFields]);
          if(!validUVRect(stroke.clearUV)||!validUVSelection(stroke,stroke.clearUV))throw Error('选区参数无效');
        }else checkStroke(stroke,isMask);
      }
      for(const stroke of layer[key]){
        if(isStrokeBlock(stroke))for(const item of unpackStrokeBlock(stroke,{mask:isMask,spatial:true}))validateStroke(item);
        else validateStroke(stroke);
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
  if(![1,2].includes(manifest.version)||typeof manifest.name!=='string'||!manifest.name.trim()||manifest.name.length>100||
     !Number.isSafeInteger(manifest.revision)||manifest.revision<0||
     typeof geometry.material!=='string'||!geometry.material||geometry.material.length>256||!sha256(geometry.modelSha256)||!sha256(geometry.registrationSha256)||
     (!projectOnly&&(typeof manifest.previewId!=='string'||!/^[\w-]{1,100}$/.test(manifest.previewId)||
       !sha256(geometry.uvSha256))))
    throw Error('涂装 ZIP 的可编辑清单无效');
  const {base,baseChannels,layers,assets,textFonts:projectFonts,surfaceBindings,materialGraph,materials,brushes,imageDocuments,objectNames,sceneCursor,renderCamera,renderBookmarks,renderAppearance,renderLighting,renderOptics,renderPreset,renderRegion,renderVisibility,sourceMaterials,textureSets}=fields(manifest.paint,['base','baseChannels','layers','assets','textFonts','surfaceBindings','materialGraph','materials','brushes','imageDocuments','objectNames','sceneCursor','renderCamera','renderBookmarks','renderAppearance','renderLighting','renderOptics','renderPreset','renderRegion','renderVisibility','sourceMaterials','textureSets']);
  validateRestoredLayers(layers);
  const paint={base,...(projectFonts?{textFonts:projectFonts}:{}),...(imageDocuments?{imageDocuments}:{}),...(baseChannels!==undefined?{baseChannels}:{}),layers,assets:{},...(materials?{materials}:{}),...(brushes?{brushes}:{}),...(materialGraph?{materialGraph}:{}),...(surfaceBindings?{surfaceBindings}:{})};
  for(const [id,item] of Object.entries(assets)){
    fields(item,['name','path','sha256','purpose']);
    if(!sha256(id)||item.sha256!==id||typeof item.name!=='string'||!item.name.trim()||item.name.length>100)
      throw Error('交付包素材记录无效');
    if(item.purpose!==undefined&&item.purpose!=='selection')throw Error('交付包素材用途无效');
    const file=path.join(folder,'paint-'+id+'.png');
    const png=describePng({paint},fs.readFileSync(file),item.name,64);
    if(png.entry.id!==id)throw Error('交付包素材指纹变化');
    paint.assets[id]={...png.entry,...(item.purpose?{purpose:item.purpose}:{})};
  }
  if(textureSets!==undefined){
    for(const set of Object.values(textureSets))validateRestoredLayers(set.layers);
    paint.textureSets=textureSets;
  }
  if(sourceMaterials!==undefined)paint.sourceMaterials=sourceMaterials;
  if(objectNames!==undefined){validateObjectNames(objectNames);paint.objectNames=objectNames;}
  if(renderCamera!==undefined)paint.renderCamera=checkedRenderCamera(renderCamera);
  if(renderBookmarks!==undefined)paint.renderBookmarks=checkedRenderBookmarks(renderBookmarks);
  if(sceneCursor!==undefined)paint.sceneCursor=checkedSceneCursor(sceneCursor);
  if(renderAppearance!==undefined)paint.renderAppearance=checkRenderAppearance(renderAppearance);
  if(renderLighting!==undefined)paint.renderLighting=checkRenderLighting(renderLighting);
  if(renderOptics!==undefined)paint.renderOptics=checkRenderOptics(renderOptics);
  if(renderRegion!==undefined)paint.renderRegion=checkRenderRegion(renderRegion);
  if(renderPreset!==undefined)paint.renderPreset=checkRenderPreset(renderPreset);
  if(renderVisibility!==undefined){
    const visibility=checkRenderVisibility(renderVisibility);
    if(Object.keys(visibility).length)paint.renderVisibility=visibility;
  }
  validate({paint},{unpackBlocks:true});
  let source;
  for(const id of new Set([nativeDemoProjectId,demoProjectId,...list().map(project=>project.id)])){
    let candidate;
    try{candidate=read(id);}
    catch(error){if(['ENOENT','EINVALIDPROJECT'].includes(error.code))continue;throw error;}
    const s=candidate.source;
    if(s.material!==geometry.material||s.bindingVersion!==2||
       s.files[s.reviewSource]!==geometry.modelSha256||registrationFingerprint(s)!==geometry.registrationSha256)continue;
    try{await checkRegisteredSource(candidate);}
    catch{continue;}
    source=candidate;
    break;
  }
  const restore=async source=>{
    if(textureSets){
      const slots=renderSceneObjects(source).textureSlots;
      if(Object.keys(textureSets).some(name=>name===source.source.material||!Object.hasOwn(slots,name)))throw Error('纹理集与登记的材质槽不匹配');
    }
    if(sourceMaterials)checkSourceMaterials(sourceMaterials,source.source.material,renderSceneObjects(source));
    if(source.source.format==='glb')for(const [key,state] of Object.entries(paint.surfaceBindings||{})){
      const sha=state?.modelSha256??(key==='original'?geometry.modelSha256:key);
      if(sha!==geometry.modelSha256&&!source.source.history?.includes(sha))throw Error('工程副本缺少投放时的历史模型');
    }
    const doc=paintTemplate(source,paint);
    if(manifest.modeling){
      validateModelState(manifest.modeling);
      doc.modeling=manifest.modeling;
      if(modelFingerprint(doc)!==geometry.modelFingerprint||
         doc.source.format==='glb'&&doc.modeling.modelSha256!==geometry.modelSha256)
        throw Error('建模修改指纹与工程副本不一致');
    }
    return forkProject(source.id,doc,manifest.name,destination=>{
      for(const item of Object.values(paint.assets)){
        const file=path.join(destination,item.file);
        fs.copyFileSync(path.join(folder,item.file),file,fs.constants.COPYFILE_EXCL);
        if(hash(file)!==item.id)throw Error('恢复时素材指纹变化');
      }
    });
  };
  if(source)return restore(source);
  const registration=path.join(folder,'registration');
  if(fs.existsSync(registration))return installGlbRegistration(registration,async candidate=>{
    const s=candidate.source;
    if(s.material!==geometry.material||s.files[s.reviewSource]!==geometry.modelSha256||
       registrationFingerprint(s)!==geometry.registrationSha256)throw Error('包内登记模型与工程清单不一致');
    await checkRegisteredSource(candidate);
    return restore(candidate);
  });
  throw Error('本机没有与交付包模型和 UV 缓存一致的登记工程');
}
async function prepareEditableFiles(doc,out,files){
  const manifestPath='editable/manifest.json',assets={};
  const entries=Object.entries(doc.paint.assets);
  if(entries.length>32000)throw Error('可编辑涂装素材数量超出打包限制');
  for(const [id,item] of entries){
    const name='paint-'+id+'.png';
    assets[id]={name:item.name,path:'assets/'+name,sha256:id,...(item.purpose?{purpose:item.purpose}:{})};
    files['editable/'+assets[id].path]=assetPath(doc,id);
  }
  files[manifestPath]=path.join(out,manifestPath);
  const geometry={material:doc.source.material,modelSha256:doc.source.files[doc.source.reviewSource],
    registrationSha256:registrationFingerprint(doc.source),...(doc.modeling?{modelFingerprint:modelFingerprint(doc)}:{})};
  const images=Object.values(doc.paint.imageDocuments??{});
  const needsModernImageLayers=images.some(image=>image.selections?.length)||[...doc.paint.layers,...images.flatMap(image=>image.layers)]
    .some(layer=>layer.raster||layer.warp||layer.maskDensity!==undefined||layer.maskFeather!==undefined||layer.maskLinked!==undefined||
      layer.maskTransform||layer.maskWarpSteps?.length||layer.selectionSources?.length||layer.brushSources?.length||
      layer.cloneSources?.length||layer.strokes?.some(isStrokeBlock)||layer.maskStrokes?.some(isStrokeBlock));
  const manifest={
    format:archiveFormat,version:needsModernImageLayers?2:1,name:doc.name,revision:doc.revision,geometry,...(doc.modeling?{modeling:doc.modeling}:{}),
    paint:{base:doc.paint.base,...(doc.paint.textureSets?{textureSets:doc.paint.textureSets}:{}),...(doc.paint.sourceMaterials?{sourceMaterials:doc.paint.sourceMaterials}:{}),...(doc.paint.objectNames?{objectNames:doc.paint.objectNames}:{}),...(doc.paint.sceneCursor?{sceneCursor:doc.paint.sceneCursor}:{}),...(doc.paint.renderCamera?{renderCamera:doc.paint.renderCamera}:{}),...(doc.paint.renderBookmarks?{renderBookmarks:doc.paint.renderBookmarks}:{}),...(doc.paint.renderAppearance?{renderAppearance:doc.paint.renderAppearance}:{}),...(doc.paint.renderLighting?{renderLighting:doc.paint.renderLighting}:{}),...(doc.paint.renderOptics?{renderOptics:doc.paint.renderOptics}:{}),...(doc.paint.renderPreset?{renderPreset:doc.paint.renderPreset}:{}),...(doc.paint.renderRegion?{renderRegion:doc.paint.renderRegion}:{}),...(doc.paint.renderVisibility?{renderVisibility:doc.paint.renderVisibility}:{}),...(doc.paint.imageDocuments?{imageDocuments:doc.paint.imageDocuments}:{}),...(doc.paint.baseChannels!==undefined?{baseChannels:doc.paint.baseChannels}:{}),layers:doc.paint.layers,assets,...(doc.paint.textFonts?{textFonts:doc.paint.textFonts}:{}),...(doc.paint.materials?{materials:doc.paint.materials}:{}),...(doc.paint.brushes?{brushes:doc.paint.brushes}:{}),...(doc.paint.materialGraph?{materialGraph:doc.paint.materialGraph}:{}),...(doc.paint.surfaceBindings?{surfaceBindings:doc.paint.surfaceBindings}:{})}
  };
  const metadata=JSON.stringify(manifest)+'\n';
  if(Buffer.byteLength(metadata)>64*1024*1024)throw Error('可编辑工程清单超过 64 MiB，无法生成可恢复的 ZIP');
  await fsp.mkdir(path.dirname(files[manifestPath]),{recursive:true});
  await fsp.writeFile(files[manifestPath],metadata,{flag:'wx'});
  return {manifestPath,assetCount:Object.keys(assets).length,geometry};
}
function prepareRegistrationFiles(source,files){
  if(source.format!=='glb')return null;
  const registration={};
  for(const name of glbRegistrationFiles(source.preservedSurface,source.history)){
    const file=path.join(path.dirname(source.reviewSource),name),member='registration/'+name;
    const digest=source.files[file];
    if(!sha256(digest))throw Error('缺少可恢复的 GLB 登记文件');
    files[member]=file;
    registration[member]=digest;
  }
  return registration;
}
const channelsForReport=report=>channels.filter(k=>Object.hasOwn(report.files,channelSpecs[k].file));
function setBakeDirectory(name){
  return 'sets/'+crypto.createHash('sha256').update(name).digest('hex');
}
export function paintPreviewFolder(doc,j){
  if(j?.type!=='paint-preview'||j.status!=='completed'||j.revision!==doc.revision)throw Error('请先生成当前修订的有效预览');
  if(!isDeepStrictEqual(Object.keys(doc.paint.textureSets??{}).sort(),Object.keys(j.textureSetBakes??{}).sort()))
    throw Error('请重新生成包含全部纹理集的 4K 预览');
  return path.join(projectDir(doc.id),'jobs',j.id,'paint');
}
export async function checkPaintPreview(doc,j,options){
  const folder=paintPreviewFolder(doc,j);
  await verifyPaintBake(doc,j.paintReport,folder,options);
  for(const [name,{report}] of Object.entries(j.textureSetBakes??{})){
    const scoped=textureSetDocument(doc,name);
    await verifyPaintBake(scoped,report,path.join(folder,setBakeDirectory(name)),{binding:paintBinding(scoped),signal:options?.signal});
  }
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
    const report=doc.textureSetName?job.textureSetBakes?.[doc.textureSetName]?.report:job.paintReport;
    if(!['paint-preview','paint-render'].includes(job.type)||job.status!=='completed'||job.revision>doc.revision||
       report?.bakeFingerprint!==fingerprint||report.revision!==job.revision||!/^[\w-]{1,100}$/.test(job.id))continue;
    const folder=path.join(projectDir(doc.id),'jobs',job.id,'paint',doc.textureSetName?setBakeDirectory(doc.textureSetName):'');
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

const hashBytes=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function glbStackMaps(bake,input){
  const maps=Object.fromEntries(channelsForReport(bake).map(channel=>{
    const name=channelSpecs[channel].file;
    return [channel,{file:path.join(input,name),sha256:bake.files[name]}];
  }));
  const activeChannels=(bake.activeChannels||Object.keys(maps)).filter(channel=>Object.hasOwn(maps,channel));
  return {maps,activeChannels};
}

async function writePaintGlb(doc,{bake,textureSetBakes,input,model,out,stage,j,run,python,signal}){
  stage(j,'将已确认的 4K 贴图与建模修改写入 GLB');
  const {maps,activeChannels}=glbStackMaps(bake,input);
  const textureSets=Object.fromEntries(Object.entries(textureSetBakes??{}).map(([name,{report}])=>
    [name,glbStackMaps(report,path.join(input,setBakeDirectory(name)))]));
  await run('glb-input',{model,maps,activeChannels,textureSets,out,material:doc.source.material,revision:doc.revision,
    modeling:doc.modeling,sourceMaterials:doc.paint.sourceMaterials,marks:Object.fromEntries(Object.values(doc.paint.sourceMaterials||{}).filter(m=>m.mark).map(({mark})=>[mark.coverage,assetPath(doc,mark.coverage)])),verifyNativeUV:doc.source.format==='glb'},python,['-X','utf8',path.join(ROOT,'paint_glb.py')]);
  return {sha256:await sha256File(out,{signal}),activeChannels};
}

async function renderPaintFrame(j,doc,{model,report,textureSetBakes,input,out,binding,stage,update,signal,registerBrowser}){
  const bookmark=j.renderBookmark&&doc.paint.renderBookmarks?.find(item=>item.id===j.renderBookmark.id);
  const renderLighting=bookmark?.lighting??doc.paint.renderLighting??null;
  const renderAppearance=doc.paint.renderAppearance||null;
  const renderOptics=bookmark?.optics==='source'?null:bookmark?.optics??doc.paint.renderOptics??null;
  const renderVisibility=Object.keys(doc.paint.renderVisibility||{}).length?doc.paint.renderVisibility:null;
  const settings=j.paintSettings,region=renderRegionPixels(doc.paint.renderRegion,settings.width,settings.height);
  const active=report.activeChannels||legacyChannels;
  const applied=['color','metallic','roughness','normal','emission','alpha'].filter(name=>active.includes(name));
  const files=Object.fromEntries(applied.map(name=>['/input/'+name+'.png',path.join(input,channelSpecs[name].file)]));
  const textureSets={};
  for(const [name,{report:setReport}] of Object.entries(textureSetBakes??{})){
    const directory=setBakeDirectory(name),maps={};
    for(const channel of ['color','metallic','roughness','normal','emission','alpha']){
      if(!setReport.activeChannels.includes(channel))continue;
      const url='/input/'+directory+'/'+channel+'.png';
      files[url]=path.join(input,directory,channelSpecs[channel].file);
      maps[channel]=url;
    }
    textureSets[name]=maps;
  }
  for(const {mark} of Object.values(doc.paint.sourceMaterials||{}))if(mark)files['/input/mark-'+mark.coverage+'.png']=assetPath(doc,mark.coverage);
  files['/input/model.glb']=model.file;
  stage(j,'路径追踪渲染冻结修订');
  const result=await renderPathTrace({
    settings,region,lighting:renderLighting,appearance:renderAppearance,optics:renderOptics,
    material:doc.source.material,sourceMaterials:doc.paint.sourceMaterials,textureSets,channels:applied,modeling:doc.modeling,visibility:renderVisibility||{},
    defaultVisibility:model.metadata.render_visibility||{}
  },files,{signal,registerBrowser,onSample:sample=>{
    if(!signal?.aborted)update(j,{progress:{phase:'sample',sample,total:settings.samples}});
  }});
  const resolution=region?.output||[settings.width,settings.height];
  if(result.samples!==settings.samples||!pngSizeIs(result.png,...resolution)||result.png[24]!== (settings.fileFormat==='PNG'?settings.bitDepth:8)||
     !(settings.transparent?[6]:[2,6]).includes(result.png[25])||
     settings.camera&&!isDeepStrictEqual(settings.camera,result.camera))throw Error('渲染预览与冻结的出图设置不一致');
  await verifyPaintBake(doc,report,input,{binding,signal});
  await verifyPaint(doc,{signal});
  if(await sha256File(model.file,{signal})!==model.sha256)throw Error('登记模型在出图过程中变化');
  const render={
    engine:'PATH_TRACING',revision:doc.revision,resolution,frameResolution:[settings.width,settings.height],
    ...(j.renderBookmark?{cameraBookmark:j.renderBookmark}:{}),
    region,camera:result.camera,samples:result.samples,fileFormat:settings.fileFormat,bitDepth:settings.bitDepth,
    transparent:settings.transparent,...(settings.pngSpace?{pngSpace:settings.pngSpace}:{}),...(result.exr?{colorSpace:settings.exrSpace?exrSpaces[settings.exrSpace].label:'scene-linear sRGB',colorInteropID:settings.exrSpace??defaultExrSpace,alphaMode:'premultiplied'}:{}),
    lighting:renderLighting,appearance:renderAppearance,optics:renderOptics,visibility:renderVisibility,
    textureSampling:result.textureSampling,
    ...(Object.keys(textureSets).length?{textureSets:Object.fromEntries(Object.entries(textureSets).map(([name,maps])=>
      [name,Object.fromEntries(Object.keys(maps).map(channel=>[channel,textureSetBakes[name].report.files[channelSpecs[channel].file]]))]))}:{}),
    modelSha256:model.sha256,uvSha256:model.uvSha256,materialFingerprint:report.materialFingerprint??null,
    textures:Object.fromEntries(applied.map(name=>[name,report.files[channelSpecs[name].file]])),
    pngSha256:hashBytes(result.png),...(result.exr?{exrSha256:hashBytes(result.exr)}:{}),
    sha256:hashBytes(result.exr||result.png)
  };
  const pending=await fsp.mkdtemp(out+'-');
  try{
    await fsp.writeFile(path.join(pending,'render.png'),result.png,{signal});
    if(settings.fileFormat==='OPEN_EXR'){
      if(!result.exr)throw Error('路径追踪未返回 OpenEXR');
      const exr=path.join(pending,'render.exr');
      await fsp.writeFile(exr,result.exr,{signal});
      if(!exrMatches(exr,...resolution,settings.bitDepth,['R','G','B','A'],{compressionType:0,exrSpace:render.colorInteropID}))
        throw Error('OpenEXR 的尺寸、颜色空间、通道或位深与出图设置不一致');
    }
    atomic(path.join(pending,'validation.json'),render);
    signal?.throwIfAborted();
    fs.renameSync(pending,out);
  }finally{await fsp.rm(pending,{recursive:true,force:true});}
  signal?.throwIfAborted();
  return render;
}

export async function runPaintJob(j,doc,{stage,update,runProcess,getJob,listJobs,signal,registerBrowser}){
  stage(j,'核对登记模型、原 UV 与素材');
  const binding=await verifyPaint(doc,{signal}),folder=path.join(projectDir(doc.id),'jobs',j.id);
  const python=process.env.ARACHNE_PYTHON||'python';
  const url=name=>`/api/projects/${doc.id}/jobs/${j.id}/files/${name}`;
  const run=async(name,cfg,exe,args)=>{
    const file=path.join(folder,name+'.json');atomic(file,cfg);
    await runProcess(j,exe,[...args,file]);
  };
  async function packTexturePreset(bake,input,out,archiveFiles,prefix){
    const preset=checkedTexturePreset(j.texturePreset),recipes=textureExportPresets[preset].files;
    if(!recipes)return null;
    if(paintChannels.some(key=>!bake.files[channelSpecs[key].file]))
      throw Error('此输出预设需要八通道贴图，请重新生成 4K 预览');
    stage(j,'生成 '+textureExportPresets[preset].label+' 贴图');
    const sources=Object.fromEntries(paintChannels.map(key=>[key,path.join(input,channelSpecs[key].file)]));
    const directory=path.join(out,'packed');
    await run('texture-pack-config',{out:directory,sources,resolution:bake.resolution,files:recipes},
      python,['-X','utf8',path.join(ROOT,'paint_texture_pack.py')]);
    const files={};
    for(const {name,colorSpace,bands,copy} of recipes){
      const file=path.join(directory,name),member=prefix+'presets/'+preset+'/'+name;
      archiveFiles[member]=file;
      const sha256=await sha256File(file,{signal});
      files[member]={sha256,colorSpace,...(bands?{bands}:{source:copy})};
    }
    return {version:1,preset,resolution:bake.resolution,files};
  }
  async function archiveTextureSets(preview,input,out,files){
    async function addStack(report,source,prefix){
      const hashes={};
      for(const [name,digest] of Object.entries(report.files)){
        const member=prefix+'textures/'+name;
        files[member]=path.join(source,name);
        hashes[member]=digest;
      }
      files[prefix+'projection-report.json']=path.join(source,'report.json');
      const packed=await packTexturePreset(report,source,path.join(out,prefix),files,prefix);
      return {bake:{previewId:preview.id,resolution:report.resolution,files:hashes},...(packed?{textureOutput:packed}:{})};
    }
    const result=await addStack(preview.paintReport,input,'');
    const entries=Object.entries(preview.textureSetBakes??{});
    if(entries.length){
      result.textureSets={};
      for(const [index,[name,{directory,report}]] of entries.entries()){
        // A numbered prefix distinguishes names that collide on a case-insensitive disk.
        const label=Array.from(name.normalize('NFC').replace(/[^\p{L}\p{N} _-]+/gu,'-')).slice(0,48).join('').trim();
        const target='texture-sets/'+String(index+1).padStart(2,'0')+'-'+(label||'material');
        result.textureSets[name]={directory:target,...await addStack(report,path.join(input,directory),target+'/')};
      }
    }
    return result;
  }
  if(j.type==='paint-glb-export'){
    const preview=getJob(doc.id,j.paintPreviewId);
    const input=await checkPaintPreview(doc,preview,{binding,signal});
    const model=(await import('./viewport.mjs')).registeredViewportModel(doc);
    const out=path.join(folder,'model.glb'),pending=out+'.tmp';
    try{
      const {sha256}=await writePaintGlb(doc,{bake:preview.paintReport,textureSetBakes:preview.textureSetBakes,input,model,out:pending,stage,j,run,python,signal});
      signal?.throwIfAborted();
      if(read(doc.id).revision!==doc.revision)throw Error('工程已变化，请预览并确认当前修订');
      fs.renameSync(pending,out);
      update(j,{glbUrl:url('model.glb'),glbSha256:sha256});
    }finally{fs.rmSync(pending,{force:true});}
    return;
  }
  if(['paint-backup','paint-texture-export'].includes(j.type)){
    const withTextures=j.type==='paint-texture-export';
    const out=path.join(folder,withTextures?'textures':'backup'),files={};
    stage(j,withTextures?'核对 4K 贴图并打包工程':'保存可编辑工程副本');
    let portable=false;
    try{
      const editable=await prepareEditableFiles(doc,out,files);
      const report={format:archiveFormat,revision:doc.revision,editable};
      const registration=prepareRegistrationFiles(doc.source,files);
      if(registration){
        if(!sha256(doc.source.uvSha256))throw Error('缺少登记模型的原 UV 指纹');
        report.registration={version:1,uvSha256:doc.source.uvSha256,files:registration};
        portable=true;
      }
      if(withTextures){
        const preview=getJob(doc.id,j.paintPreviewId);
        const input=await checkPaintPreview(doc,preview,{binding,signal});
        Object.assign(report,await archiveTextureSets(preview,input,out,files));
      }
      await run('backup-config',{out,files,report,expected:registration??{}},
        python,['-X','utf8',path.join(ROOT,'paint_archive.py'),'pack']);
      signal?.throwIfAborted();
      if(withTextures&&read(doc.id).revision!==doc.revision)
        throw Error('工程已变化，请预览并确认当前修订');
    }catch(error){
      fs.rmSync(path.join(out,'project.zip'),{force:true});
      throw error;
    }finally{
      fs.rmSync(path.join(out,'editable'),{recursive:true,force:true});
      fs.rmSync(path.join(out,'packed'),{recursive:true,force:true});
      fs.rmSync(path.join(out,'texture-sets'),{recursive:true,force:true});
    }
    update(j,{portable,...(withTextures?{packageUrl:url('textures/project.zip')}:{archiveUrl:url('backup/project.zip')})});
    return;
  }
  if(j.type==='paint-preview'||j.type==='paint-draft'||j.type==='paint-render'){
    if(modelFingerprint(doc))stage(j,'准备建模后的涂装表面与遮挡');
    const out=path.join(folder,'paint'),draft=j.type==='paint-draft',previous=!draft&&listJobs?listJobs(doc.id):[];
    const model=j.type==='paint-render'?(await import('./viewport.mjs')).registeredViewportModel(doc):null;
    if(model&&doc.modeling?.steps?.length&&doc.modeling.modelSha256!==model.sha256)
      throw Error('工程建模绑定与登记模型不一致');
    async function bakeStack(scoped,output,key){
      signal?.throwIfAborted();
      const name=scoped.source.material,scopeBinding=paintBinding(scoped),fingerprint=paintBakeFingerprint(scoped,scopeBinding);
      const geometry=await preparePaintGeometry(scoped,{signal,frozen:true});
      const compose={...paintInput(scoped,scopeBinding),source:geometry.source,surfaceSources:geometry.surfaceSources,
        out:output,draft,bakeFingerprint:fingerprint};
      const cached=await reusablePaintBake(scoped,previous,fingerprint,{binding:scopeBinding,signal});
      if(cached){
        stage(j,'复用已验证的 4K 涂装贴图 · '+name);
        await fsp.mkdir(path.dirname(output),{recursive:true});
        const report=await copyPaintBake(scoped,cached,output,{binding:scopeBinding,signal});
        if(report){
          atomic(path.join(folder,key+'.json'),compose);
          if(scoped===doc)update(j,{reusedPaintBake:{jobId:cached.job.id,revision:cached.job.revision}});
          return report;
        }
      }
      stage(j,(draft?'生成 1K 试算':'合成八通道并写回原 UV')+' · '+name);
      await run(key,compose,python,['-X','utf8',path.join(ROOT,'paint_worker.py')]);
      const report=JSON.parse(await fsp.readFile(path.join(output,'report.json'),{encoding:'utf8',signal}));
      await verifyPaintBake(scoped,report,output,{draft,binding:scopeBinding,signal});
      return report;
    }
    const report=await bakeStack(doc,out,'paint-input'),textureSetBakes={};
    if(!draft){
      for(const name of Object.keys(doc.paint.textureSets??{})){
        const directory=setBakeDirectory(name);
        const secondary=await bakeStack(textureSetDocument(doc,name),path.join(out,directory),'paint-set-'+path.basename(directory));
        textureSetBakes[name]={directory,report:secondary};
      }
    }
    await verifyPaint(doc,{signal});
    const extra=Object.keys(textureSetBakes).length?{textureSetBakes}:{};
    if(model){
      const render=await renderPaintFrame(j,doc,{model,report,textureSetBakes,input:out,out:path.join(folder,'path-tracing'),binding,stage,update,signal,registerBrowser});
      update(j,{paintReport:report,...extra,render,renderUrl:url('path-tracing/render.png'),validationUrl:url('path-tracing/validation.json'),
        ...(render.exrSha256?{outputUrl:url('path-tracing/render.exr'),outputSha256:render.exrSha256}:{})});
      return;
    }
    update(j,{paintReport:report,...extra,colorUrl:url('paint/f_16xl_BaseColor.png'),baseUrl:url('paint/base.png'),
      materialUrls:Object.fromEntries(channels.filter(k=>k!=='color').map(k=>[k,url('paint/'+channelSpecs[k].file)])),
      baseMaterialUrls:Object.fromEntries(channels.filter(k=>k!=='color').map(k=>[k,url('paint/base-'+k+'.png')])),
      coverageUrl:url('paint/coverage.png'),validationUrl:url('paint/report.json')});return;
  }
  if(j.type!=='paint-export')throw Error('不支持的涂装任务');
  const preview=getJob(doc.id,j.paintPreviewId),input=await checkPaintPreview(doc,preview,{binding,signal});
  const out=path.join(folder,'delivery'),pending=await fsp.mkdtemp(path.join(folder,'delivery-'));
  try{
    const bake=preview.paintReport;
    const model=(await import('./viewport.mjs')).registeredViewportModel(doc);
    const modelFile=path.join(pending,'model.glb');
    const {sha256:modelSha256,activeChannels}=await writePaintGlb(doc,{bake,textureSetBakes:preview.textureSetBakes,input,model,out:modelFile,stage,j,run,python,signal});
    const render=await renderPaintFrame(j,doc,{model,report:bake,textureSetBakes:preview.textureSetBakes,input,out:path.join(pending,'frame'),binding,stage,update,signal,registerBrowser});
    stage(j,'核对模型、材质、贴图与渲染并打包');
    const files={'model.glb':modelFile,'materials.json':path.join(pending,'materials.json'),
      'render.png':path.join(pending,'frame','render.png'),'render-report.json':path.join(pending,'frame','validation.json')};
    const expected={'model.glb':modelSha256,'render.png':render.pngSha256};
    if(render.exrSha256){
      files['render.exr']=path.join(pending,'frame','render.exr');
      expected['render.exr']=render.exrSha256;
    }
    const stacks=await archiveTextureSets(preview,input,pending,files);
    const channelManifest=(report,prefix,active)=>Object.fromEntries(channelsForReport(report).map(key=>{
      const spec=channelSpecs[key],enabled=active.includes(key);
      return [key,{file:prefix+'textures/'+spec.file,sha256:report.files[spec.file],colorSpace:spec.srgb?'sRGB':'linear',active:enabled,embedded:enabled&&key!=='height'}];
    }));
    atomic(files['materials.json'],{format:'arachne-pbr-material',version:1,revision:doc.revision,material:doc.source.material,
      model:'model.glb',uv:'TEXCOORD_0',uvSha256:model.uvSha256,resolution:bake.resolution,
      channels:channelManifest(bake,'',activeChannels),
      ...(stacks.textureSets?{textureSets:Object.fromEntries(Object.entries(stacks.textureSets).map(([name,{directory}])=>{
        const {report}=preview.textureSetBakes[name];
        return [name,{channels:channelManifest(report,directory+'/',report.activeChannels)}];
      }))}:{})});
    const registration=prepareRegistrationFiles(doc.source,files);
    Object.assign(expected,registration);
    const editable=await prepareEditableFiles(doc,pending,files);
    const report={format:archiveFormat,revision:doc.revision,editable,...stacks,
      delivery:{version:1,confirmedAt:j.paintConfirmedAt,model:{file:'model.glb',sha256:modelSha256,
        sourceGlbSha256:model.sha256,uvSha256:model.uvSha256},material:'materials.json',render:{
        file:render.exrSha256?'render.exr':'render.png',preview:'render.png',report:'render-report.json',engine:render.engine,resolution:render.resolution,
        sha256:render.sha256,pngSha256:render.pngSha256
      },...(registration?{registration}:{})}};
    await run('package-config',{out:pending,files,report,expected,writeReport:true},python,['-X','utf8',path.join(ROOT,'paint_archive.py'),'pack']);
    signal?.throwIfAborted();
    await fsp.rm(path.join(pending,'editable'),{recursive:true,force:true});
    await fsp.rm(path.join(pending,'packed'),{recursive:true,force:true});
    await fsp.rm(path.join(pending,'texture-sets'),{recursive:true,force:true});
    signal?.throwIfAborted();
    if(read(doc.id).revision!==doc.revision)throw Error('工程已变化，请预览并确认当前修订');
    fs.renameSync(pending,out);
    update(j,{packageUrl:url('delivery/project.zip'),glbUrl:url('delivery/model.glb'),glbSha256:modelSha256,render,
      renderUrl:url('delivery/frame/render.png'),materialUrl:url('delivery/materials.json'),validationUrl:url('delivery/project-report.json'),
      ...(render.exrSha256?{outputUrl:url('delivery/frame/render.exr'),outputSha256:render.exrSha256}:{})});
  }finally{await fsp.rm(pending,{recursive:true,force:true});}
}

// A mark on a secondary material uses the same surface projector, then keeps
// its alpha in that material's own UV space. Its mesh and source PNG stay editable.
export async function placeSourceMark(doc,{revision,name,image,projector},{signal}={}){
  if(Object.hasOwn(doc.paint.textureSets??{},name))throw Error('此槽已使用纹理集，请在纹理集中绘制蒙版');
  if(revision!==doc.revision)throw revisionError(doc);
  if(doc.source.format!=='glb'||doc.source.material===name||!renderSceneObjects(doc).materials.includes(name)||!asset(doc,image))
    throw Error('请选择原生 GLB 的附属材质和工程中的 PNG');
  checkProjector(projector);
  const scratch=await fsp.mkdtemp(path.join(projectDir(doc.id),'mark-'));
  try{
    const input=path.join(scratch,'input.json'),output=path.join(scratch,'mark.png');
    atomic(input,{model:doc.source.reviewSource,steps:doc.modeling?.steps||[],name,projector,image:assetPath(doc,image),output});
    try{await renderTextFile(pythonExecutable(),['-X','utf8',path.join(ROOT,'source_material_mark.py'),input],{signal,windowsHide:true});}
    catch(error){signal?.throwIfAborted();throw Error(error.stderr?.trim()||'投影标记计算失败');}
    const png=describePng(doc,await fsp.readFile(output),name+' · 标记覆盖',64);
    return commit(doc.id,revision,next=>{
      ensurePaintAsset(next,png);next.paint.assets[png.entry.id]=png.entry;
      next.paint.sourceMaterials??={};
      next.paint.sourceMaterials[name]={...next.paint.sourceMaterials[name],mark:{image,coverage:png.entry.id,projector}};
      pinSurfaceInputs(next);validate(next);return next;
    },'投放材质标记');
  }finally{await fsp.rm(scratch,{recursive:true,force:true});}
}
