import {menuShortcut} from './menu-shortcut.mjs';
import {documentClip,documentFrame,editingSide,imageViewGeometry,previewDimensions} from './image-document-size.mjs';
import {editDocumentSize} from './image-size-dialog.mjs';
import {textEffects,imageStyleKinds,outlinePositions,hasImageStyle} from './image-text-style.mjs';
import {createImageEdgeTool} from './image-edge-tool.mjs';
import {createImagePenTool} from './image-pen-tool.mjs';
import {createImageCanvasText} from './image-canvas-text.mjs';
import {createImageUVGuide} from './image-uv-guide.mjs';
import {canvasCoordinates,canvasPoint,orientImageCanvas} from './image-canvas-coordinates.mjs';
import {copyImagePixels,copiedImage,onImageClipboardChange,imageClipboardPlacement} from './image-clipboard.mjs';
import {compositionKey} from './text-input.mjs';
import {drawingImageTypes,acceptsDrawingImage,prepareDrawingImage} from './drawing-image-import.mjs';
import {headerControls,chromeButton,chromeMenu,createContextActions} from './area-chrome.mjs';
import {surfaceControls,selectionControls} from './area-paint-controls.mjs';
import {createSurfaceTools} from './paint-tools.mjs';
import {createLiveView} from './paint-live-view.mjs';
import {hasImageLayerMask,imageDocumentLimit,imageClippingBase,surfaceToImageCommand,fullBlendRange} from './image-documents.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {workspaceIcons} from './workspace-icons.mjs';
import {layerChildren,layerIsVisible,layerLockOwner,layerParent,layerTreeOrder,layerTreeRows} from './paint-layer-tree.mjs';
import {followingClips,imageGroupBlend,imageLayerInsertion} from './image-layer-tree.mjs';
import {imageCombineLabels,planImageCombine} from './image-layer-combine.mjs';
import {checkImageLayerDuplicate,imageBatchSelection,imageLayerLimit,imageLayerMoveStep,planImageLayerDelete,planImageLayerMove} from './image-layer-batch.mjs';
import {channelSpecs,paintChannels} from './paint-channels.mjs';
import {maskGray} from './paint-colors.mjs';
import {createBrushBinding} from './paint-brush-binding.mjs';
import {defaultBrushGraph,isBrushImage} from './paint-library.mjs';
import {brushImageFields,brushImageMaxSize} from './material-graph.mjs';
import {hasAssetDrag,readAssetDrag} from './paint-asset-drag.mjs';
import {createImageEditorSelection} from './image-editor-selection.mjs';
import {pauseImageThumbnail,updateImageThumbnail} from './image-layer-thumbnails.mjs';
import {createImageGradientTool} from './image-gradient-tool.mjs';
import {createImageFillTool} from './image-fill-tool.mjs';
import {createImageCloneTool} from './image-clone-tool.mjs';
import {createImageMoveTool} from './image-move-tool.mjs';
import {createImageWarpTool} from './image-warp-tool.mjs';
import {createImageStrokeQueue} from './image-stroke-queue.mjs';
import {createStrokeDraftJournal,unavailableStrokeJournal} from './stroke-draft-journal.mjs';
import {createImageShapeTool} from './image-shape-tool.mjs';
import {imageShapeKinds,imageShapeSize} from './image-shapes.mjs';
import {uvShapePayload,maxUVFeather,isSelectionAsset} from './uv-selection-region.mjs';
import {imageAdjustments,newImageAdjustment,imageBlendGroups,imageAdjustmentBanks,hueFamilies} from './image-adjustments.mjs';
import {createCurveEditor} from './image-curve-editor.mjs';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
function button(text,action,label=text){const b=el('button','',text);b.type='button';b.onclick=action;b.setAttribute('aria-label',label);b.title=label;return b;}
function choice(label,items,value,change){const s=el('select');s.setAttribute('aria-label',label);for(const [id,name] of items)s.append(new Option(name,id));s.value=value;s.onchange=()=>change(s.value);return s;}
const selectionNames={rect:'矩形选区',ellipse:'椭圆选区',lasso:'套索',polygon:'多边形套索',wand:'魔棒',colorRange:'颜色范围'};
const imageDragTypes={layer:'application/x-arachne-image-layer',mask:'application/x-arachne-image-mask'};
const currentDocument=project=>{const documents=project.document?.paint.imageDocuments??{},id=project.imageContext?.documentId;return Object.hasOwn(documents,id)?documents[id]:null;};
const currentLayer=project=>currentDocument(project)?.layers.find(l=>l.id===project.imageContext?.layerId);
function editableImageLayer(project){
  const layer=currentLayer(project);
  if(!layer)return null;
  const {layers}=currentDocument(project);
  return {...layer,locked:!!layerLockOwner(layers,layer),visible:layerIsVisible(layers,layer)};
}
function imageInsertion(project){
  const image=currentDocument(project);
  return imageLayerInsertion(image?.layers??[],project.imageContext?.layerId);
}
function canInsertImage(project){
  const image=currentDocument(project);
  if(!image||image.layers.length>=64)return false;
  const {parentId}=imageInsertion(project),parent=image.layers.find(item=>item.id===parentId);
  return !parent||!layerLockOwner(image.layers,parent);
}
function selectImage(project,patch,{reveal=false}={}){
  const selection={...project.imageContext,...patch};
  if(!Object.hasOwn(patch,'layerIds')&&(patch.documentId!==undefined&&patch.documentId!==project.imageContext?.documentId||
     patch.layerId!==undefined&&patch.layerId!==project.imageContext?.layerId||patch.target==='mask'))delete selection.layerIds;
  if(patch.documentId!==undefined&&patch.documentId!==project.imageContext?.documentId&&!Object.hasOwn(patch,'sourceTrail'))delete selection.sourceTrail;
  if(selection.target!=='mask'||patch.target&&!patch.inspectMask)delete selection.inspectMask;
  project.selectImage(selection,undefined,{force:true,reveal});
  if(!project.isImageEditorActive||project.isImageEditorActive())project.setEditorDomain('image');
}
function openEmbeddedSource(project,item){
  if(!item?.embedded)return;
  const source=project.document.paint.imageDocuments[item.embedded.documentId],current=project.imageContext;
  const trail=[...(current.sourceTrail??[]),{documentId:current.documentId,layerId:item.id}];
  selectImage(project,{documentId:item.embedded.documentId,layerId:(source.layers.find(l=>l.text)??source.layers.at(-1))?.id??null,
    target:'pixels',sourceTrail:trail},{reveal:true});
}
async function command(project,op){return project.commands([{op:'image',documentId:project.imageContext?.documentId,...op}]);}
async function commandAt(project,origin,op){return project.commands([{op:'image',documentId:origin.documentId,...op}],origin);}
export function imageSelectionOrigin(project){const c=project.imageContext;return {...project.origin(),documentId:c?.documentId,layerId:c?.layerId,target:c?.target};}
async function combineImageLayers(project,origin,action,ids){
  const layers=currentDocument(project)?.layers;
  if(!layers)throw Error('请先打开图像文档');
  const stamp=action==='stampVisible',layerIds=stamp?[]:ids;
  const selected=action==='rasterize'?ids[0]:planImageCombine(layers,action,layerIds).bottom;
  const newLayerId=stamp?crypto.randomUUID():undefined,layerId=newLayerId||selected;
  await commandAt(project,origin,{action,layerIds,newLayerId});
  const current=project.imageContext;
  if(project.document?.id!==origin.id||current?.documentId!==origin.documentId)return;
  const nextLayers=currentDocument(project).layers;
  if(current.layerId===origin.layerId||!nextLayers.some(layer=>layer.id===origin.layerId))
    selectImage(project,{layerId,layerIds:[layerId],target:'pixels'});
}
function selectAddedLayer(project,origin,layerId){const c=project.imageContext;if(project.document?.id===origin.id&&c?.documentId===origin.documentId&&c?.layerId===origin.layerId&&c?.target===origin.target)selectImage(project,{layerId,target:'pixels'});}
async function addPixel(project,origin){
  const layerId=crypto.randomUUID(),layers=project.document.paint.imageDocuments[origin.documentId].layers;
  await commandAt(project,origin,{action:'addLayer',layerId,kind:'pixel',...imageLayerInsertion(layers,origin.layerId)});
  selectAddedLayer(project,origin,layerId);
}
export async function addImageAsset(project,origin,asset,name,position){
  const layerId=crypto.randomUUID(),layers=project.document.paint.imageDocuments[origin.documentId].layers;
  await commandAt(project,origin,{action:'addLayer',layerId,kind:'image',...imageLayerInsertion(layers,origin.layerId),patch:{asset,name,...position}});
  selectAddedLayer(project,origin,layerId);
}
function remember(project){try{localStorage.setItem('arachne-image-selection:'+project.document.id,JSON.stringify(project.imageContext));}catch{}}
export function createDocumentEditor(ctx,bridge){
  bridge={...bridge,...bridge.imageColors};
  const {host,state}=ctx,life=new AbortController(),signal=life.signal,imageView=createImageEditorSelection(ctx.project,{areaId:ctx.areaId,saved:state.imageSelections,onChange:ctx.onChange}),project=imageView.project;
  const header=el('div','editor-toolbar'),picker=choice('图像文档',[],'',value=>{if(painter.isEditing()||selection.isTransforming())return;selectImage(project,{documentId:value||null,layerId:null,target:'pixels'});});
  const run=fn=>Promise.resolve().then(fn).catch(error=>{status.textContent=error.message;ctx.error(error);});
  const create=button('新建贴图',()=>{const origin=imageSelectionOrigin(project),documentId=crypto.randomUUID(),layerId=crypto.randomUUID();void run(async()=>{
    const dimensions=await editDocumentSize('create',null,{signal});if(!dimensions)return;
    await project.commands([{op:'image',action:'create',documentId,patch:{...dimensions,name:'未命名贴图 '+(Object.keys(project.document.paint.imageDocuments??{}).length+1)}},{op:'image',action:'addLayer',documentId,layerId,kind:'pixel'}],origin);
    const c=project.imageContext;if(!disposed&&project.document?.id===origin.id&&c?.documentId===origin.documentId&&c?.layerId===origin.layerId&&c?.target===origin.target)selectImage(project,{documentId,layerId,target:'pixels'});
  });});
  const channel=choice('材质引用通道',paintChannels.map(k=>[k,channelSpecs[k].name]),state.channel||'color',()=>{syncDestination(true);ctx.onChange();});
  const destination=choice('材质引用图层',[],'',value=>{destinationChoice=value;syncBind();});
  const bind=button('应用至材质',()=>{const origin=imageSelectionOrigin(project),materialLayerId=destination.value||undefined,newLayerId=materialLayerId?undefined:crypto.randomUUID(),targetChannel=channel.value,imageName=currentDocument(project)?.name;void run(async()=>{
    if(!origin.documentId||!imageName)throw Error('请先打开图像文档');
    const operations=[{op:'image',action:'bind',documentId:origin.documentId,channel:targetChannel,...(materialLayerId?{materialLayerId}:{newLayerId})}];
    if(newLayerId)operations.push({op:'update',id:newLayerId,patch:{name:('贴图 · '+imageName).slice(0,100)}});
    await project.commands(operations,origin);
    if(!disposed&&project.document?.id===origin.id&&project.imageContext?.documentId===origin.documentId&&channel.value===targetChannel){
      destinationChoice=materialLayerId||newLayerId;
      syncDestination();
    }
  });});
  let destinationDocument=null,destinationProject=null,destinationChannel=null,destinationChoice=null,destinationOptionsKey='',pickerOptionsKey='';
  function syncDestination(force=false){
    const id=project.imageContext?.documentId,doc=project.document;if(!doc)return;
    if(force||destinationProject!==doc.id||destinationDocument!==id||destinationChannel!==channel.value)destinationChoice=null;
    destinationDocument=id;destinationProject=doc.id;destinationChannel=channel.value;
    const linked=id&&doc.paint.layers.find(l=>l.kind==='fill'&&l.documentMaps?.[channel.value]===id);
    const layers=doc.paint.layers.filter(l=>l.kind==='fill'&&!layerLockOwner(doc.paint.layers,l));
    const key=JSON.stringify([doc.id,layers.map(l=>[l.id,l.name,!!l.materialId])]);
    if(destinationOptionsKey!==key){
      destinationOptionsKey=key;
      destination.replaceChildren(new Option('新建材质填充层',''),...layers.map(l=>new Option(l.name+(l.materialId?' · 库材质':''),l.id)));
    }
    const target=destinationChoice??linked?.id;
    destination.value=layers.some(layer=>layer.id===target)?target:'';
    syncSelectMenu(destination);
    syncBind();
  }
  function syncBind(){
    const doc=project.document,id=project.imageContext?.documentId;
    const layer=doc?.paint.layers.find(item=>item.id===destination.value);
    const bound=layer?.documentMaps?.[channel.value],same=!!id&&bound===id;
    bind.disabled=!currentDocument(project)||writing()||same;
    bind.textContent=same?'已应用':bound?'替换贴图':'应用至材质';
    bind.setAttribute('aria-label',bind.textContent);
    bind.title=same?'修改此贴图会同步到已绑定通道':bound?'以当前图像文档替换此通道的贴图':'应用至材质';
  }
  const copy=button('复制图像选区',()=>copySelection()),paste=button('粘贴为图像层',()=>pasteSelection());
  const importInput=el('input');
  importInput.type='file';importInput.accept=drawingImageTypes;importInput.hidden=true;
  importInput.setAttribute('aria-label','选择要导入的图片');
  const importButton=chromeButton(button('导入图片至画布',()=>importInput.click()),'importImage');
  importButton.title='导入 PNG、JPEG 或 WebP 至当前画布';
  importInput.onchange=()=>{
    const file=importInput.files[0];
    importInput.value='';
    if(file)importFile(file);
  };
  const download=chromeButton(button('导出当前贴图 PNG',downloadDocument),'download');
  download.classList.add('document-export-button');
  download.title='导出当前贴图 PNG';
  chromeButton(copy,'copy');chromeButton(paste,'paste');
  copy.title='复制图像选区 · ⌘ / Ctrl + C';paste.title='粘贴为图像层 · ⌘ / Ctrl + V';
  copy.disabled=paste.disabled=importButton.disabled=download.disabled=true;
  let copying=false,cutting=false,importing=false,exportRequest=null;
  const dimensions=choice('图像尺寸操作',[['','尺寸'],['resizeCanvas','画布尺寸…'],['cropCanvas','裁切…'],['resizeImage','图像尺寸…']],'',action=>{
    dimensions.value='';syncSelectMenu(dimensions);if(!action)return;
    const origin=imageSelectionOrigin(project),doc=currentDocument(project);
    void run(async()=>{
      const patch=await editDocumentSize(action,doc,{canvas,signal});
      if(patch)await commandAt(project,origin,{action,patch});
    });
  });
  const backToParent=button('返回原稿',()=>{
    const trail=project.imageContext?.sourceTrail;
    if(!trail?.length)return;
    selectImage(project,{...trail.at(-1),target:'pixels',sourceTrail:trail.slice(0,-1)},{reveal:true});
  });
  backToParent.hidden=true;
  header.append(backToParent,picker,create,dimensions,channel,destination,bind,copy,paste,importButton,download);headerControls(ctx,header);
  const options=el('div','document-tool-options'),toolName=el('strong','document-current-tool','抓手');
  const editTarget=el('span','document-edit-target'),targetLayerName=el('span'),targetKind=el('span');
  editTarget.append(targetLayerName,' · ',targetKind);
  const parameters=el('div','document-tool-parameters'),viewOptions=el('div','document-view-options');
  const parameterStrip=el('div','document-parameter-strip');
  const scrollBack=chromeButton(button('上一组工具参数',()=>scrollParameters(-1)),'chevron','上一组工具参数');
  const scrollForward=chromeButton(button('下一组工具参数',()=>scrollParameters(1)),'chevron','下一组工具参数');
  scrollBack.classList.add('document-parameter-back');
  scrollForward.classList.add('document-parameter-forward');
  scrollBack.hidden=scrollForward.hidden=true;
  const brushOptions=el('details','document-brush-popup'),brushSummary=el('summary');
  const brushPopup=el('div','document-brush-popup-content');
  brushPopup.tabIndex=-1;brushPopup.setAttribute('role','dialog');brushPopup.setAttribute('aria-label','笔尖参数');
  chromeButton(brushSummary,'settings','笔尖参数');brushSummary.setAttribute('role','button');brushSummary.setAttribute('aria-haspopup','dialog');
  brushSummary.setAttribute('aria-expanded','false');
  brushOptions.append(brushSummary,brushPopup);brushOptions.hidden=true;
  chromeMenu(brushOptions,brushPopup);
  brushOptions.addEventListener('toggle',()=>{
    brushSummary.setAttribute('aria-expanded',String(brushOptions.open));
    if(brushOptions.open&&document.activeElement===brushSummary)brushPopup.focus({preventScroll:true});
  },{signal});
  brushSummary.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!brushOptions.open)return;
    event.preventDefault();event.stopPropagation();brushOptions.open=false;
    if(brushPopup.matches(':popover-open'))brushPopup.hidePopover();
  },{signal});
  parameterStrip.append(scrollBack,parameters,scrollForward,brushOptions);
  const rail=el('aside','document-tools'),toolList=el('div','document-tool-list');
  const stage=el('div','editor-image-stage document-image-stage'),canvas=el('canvas'),empty=el('div','document-empty'),status=el('output','editor-message');
  const uvGuideImage=el('img','document-uv-guide'),uvGuideNotice=el('output','document-uv-guide-notice');
  uvGuideImage.alt='';uvGuideImage.draggable=false;uvGuideImage.hidden=uvGuideNotice.hidden=true;
  uvGuideNotice.setAttribute('role','status');
  const compass=el('div','document-view-compass'),needle=el('span'),degree=el('output');
  needle.innerHTML=workspaceIcons.viewNorth;
  compass.append(needle,degree);compass.setAttribute('aria-hidden','true');compass.hidden=true;
  rail.append(toolList);
  options.setAttribute('role','group');options.setAttribute('aria-label','图像工具选项');
  viewOptions.setAttribute('role','group');viewOptions.setAttribute('aria-label','画布视图');
  function syncParameterEdges(){
    const available=parameterStrip.clientWidth-brushOptions.offsetWidth;
    const overflowing=available>0&&parameters.scrollWidth>available+1;
    scrollBack.hidden=scrollForward.hidden=!overflowing;
    const remaining=parameters.scrollWidth-parameters.clientWidth-parameters.scrollLeft;
    const hasPrevious=overflowing&&parameters.scrollLeft>1,hasNext=overflowing&&remaining>1;
    parameters.toggleAttribute('data-scroll-start',hasPrevious);
    parameters.toggleAttribute('data-scroll-end',hasNext);
    scrollBack.setAttribute('aria-disabled',String(!hasPrevious));
    scrollForward.setAttribute('aria-disabled',String(!hasNext));
  }
  function scrollParameters(direction){
    const control=direction===1?scrollForward:scrollBack;
    if(control.getAttribute('aria-disabled')==='true')return;
    const at=parameters.scrollLeft,max=parameters.scrollWidth-parameters.clientWidth;
    const root=parameters.getBoundingClientRect().left;
    const visible=[...parameters.children].filter(item=>!item.hidden);
    const items=visible.flatMap(item=>item.matches('.editor-toolbar')?[...item.children].filter(child=>!child.hidden):[item]);
    const boundaries=[0,max,...items.map(item=>item.getBoundingClientRect().left-root+at)];
    const target=at+direction*Math.max(48,parameters.clientWidth*.75);
    const next=boundaries.filter(position=>direction*(position-at)>1&&position>=0&&position<=max)
      .reduce((best,position)=>Math.abs(position-target)<Math.abs(best-target)?position:best,direction===1?max:0);
    const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
    parameters.scrollTo({left:next,behavior:reduceMotion?'instant':'smooth'});
  }
  const stripResize=new ResizeObserver(syncParameterEdges);
  stripResize.observe(parameterStrip);
  parameters.addEventListener('scroll',syncParameterEdges,{passive:true,signal});
  parameters.addEventListener('wheel',event=>{
    if(event.deltaX||!event.deltaY||event.ctrlKey||event.metaKey||parameters.scrollWidth<=parameters.clientWidth)return;
    const unit=event.deltaMode===1?16:event.deltaMode===2?parameters.clientWidth:1;
    event.preventDefault();parameters.scrollLeft+=event.deltaY*unit;
  },{passive:false,signal});
  const sampleNotice=el('span','document-sample-status');
  sampleNotice.setAttribute('role','status');sampleNotice.hidden=true;
  rail.setAttribute('aria-label','图像绘制工具');canvas.setAttribute('aria-label','图像文档画布');canvas.tabIndex=0;stage.tabIndex=0;stage.append(canvas,uvGuideImage,uvGuideNotice,empty,compass);empty.append(el('strong','','图像文档'),el('span','','新建贴图，或从材质通道打开已有图像文档。'),button('新建贴图',()=>create.click(),'创建第一个图像文档'));
  const controls=surfaceControls(el('div'),{drawing:true}),elements=controls.elements;
  elements['brush-erase'].checked=state.eraser===true;
  elements['brush-radius'].closest('label').hidden=true;
  elements['brush-mirror-enabled'].closest('label').hidden=true;
  for(const [key,speed] of [['brush-uv-radius',1],['brush-hardness',.5],['brush-opacity',.5],['brush-flow',.5],['brush-spacing',.5]]){
    const input=elements[key];
    input.dataset.scrubNumber='';
    input.dataset.scrubSpeed=String(speed);
  }
  controls.bar.classList.add('document-brush-options');
  const extendedBrushFields=['brush-smoothing','brush-uv-pressure','brush-pressure-size','brush-tipAngle','brush-roundness','brush-scatter','brush-grain'];
  const brushFields=['brush-hardness','brush-opacity','brush-flow','brush-spacing',...extendedBrushFields].map(key=>{
    const label=elements[key].closest('label'),anchor=document.createComment(key),popupAnchor=document.createComment(key);
    label.before(anchor);brushPopup.append(popupAnchor);
    return {key,label,anchor,popupAnchor};
  });
  let brushImageBusy=false,brushImageOptions='';
  const imageControls=Object.fromEntries(brushImageFields.map(key=>{
    const title=key==='tipAsset'?'图片笔尖':'笔刷纹理';
    const field=el('label','document-brush-image',title);
    const select=choice(title,[],'',value=>{
      painter.setSettings({...painter.getSettings(),[key]:value});
      syncBrushImages();
    });
    field.append(select);brushPopup.append(field);enhanceSelectMenu(select);
    const file=el('input');file.type='file';file.accept=drawingImageTypes;file.hidden=true;
    file.setAttribute('aria-label','选择'+title+'文件');host.append(file);
    const upload=button('导入'+title+'…',()=>file.click());
    upload.title='导入不超过 1024 × 1024 的图片';
    file.onchange=()=>{
      const image=file.files[0],origin=project.origin();
      file.value='';
      if(!image||!origin||brushImageBusy)return;
      brushImageBusy=true;syncBrushImages();
      void run(async()=>{
        const prepared=await prepareDrawingImage(image);
        if(Math.max(...prepared.size)>brushImageMaxSize)throw Error('请选择不超过 1024 × 1024 的笔刷图片');
        if(disposed||project.document?.id!==origin.id||project.document.revision!==origin.revision)
          throw Error('工程已变化，请重新选取笔刷图片');
        const asset=await bridge.importBrushImage(prepared.file,origin);
        if(!disposed&&project.document?.id===origin.id){
          painter.setSettings({...painter.getSettings(),[key]:asset.id});
          syncBrushImages();
        }
      }).finally(()=>{brushImageBusy=false;if(!disposed)syncBrushImages();});
    };
    return [key,{select,upload}];
  }));
  const brushUploads=el('div','document-brush-uploads');
  brushUploads.append(...brushImageFields.map(key=>imageControls[key].upload));brushPopup.append(brushUploads);
  function syncBrushImages(){
    const assets=Object.entries(project.document?.paint.assets??{}).filter(([,asset])=>isBrushImage(asset));
    const options=JSON.stringify(assets.map(([id,asset])=>[id,asset.name]));
    const current=painter.getSettings();
    for(const [key,{select,upload}] of Object.entries(imageControls)){
      if(options!==brushImageOptions)select.replaceChildren(new Option(key==='tipAsset'?'圆形':'内置颗粒',''),
        ...assets.map(([id,asset])=>new Option(asset.name,id)));
      const value=assets.some(([id])=>id===current[key])?current[key]:'';
      if(select.value!==value)select.value=value;
      select.disabled=upload.disabled=brushImageBusy||!project.document;
      select.title=value?assets.find(([id])=>id===value)[1].name:'';
      syncSelectMenu(select);
    }
    brushImageOptions=options;
  }
  async function brushTipFromSelection(){
    const region=selection.clip(),origin=imageSelectionOrigin(project);
    if(!region||!canCopy(true)||brushImageBusy)return;
    brushImageBusy=true;syncBrushImages();selectionBrush.disabled=true;
    await run(async()=>{
      const response=await fetch('/api/projects/'+origin.id+'/paint/image-clipboard',{
        method:'POST',headers:{'Content-Type':'application/json'},signal,
        body:JSON.stringify({revision:origin.revision,documentId:origin.documentId,merged:true,rect:region.clip,...uvShapePayload(region)})
      });
      if(response.status===204)throw Error('图像已变化，请重新创建笔尖');
      if(!response.ok)throw Error((await response.json()).error||'无法读取选区像素');
      const bitmap=await createImageBitmap(await response.blob());
      const scale=Math.min(1,brushImageMaxSize/Math.max(bitmap.width,bitmap.height));
      const mask=el('canvas');mask.width=Math.max(1,Math.round(bitmap.width*scale));mask.height=Math.max(1,Math.round(bitmap.height*scale));
      const ctx=mask.getContext('2d',{willReadFrequently:true});
      try{ctx.drawImage(bitmap,0,0,mask.width,mask.height);}finally{bitmap.close();}
      const frame=ctx.getImageData(0,0,mask.width,mask.height),rgba=frame.data;
      let visible=false;
      for(let i=0;i<rgba.length;i+=4){
        rgba[i+3]=Math.round(rgba[i+3]*(1-(.299*rgba[i]+.587*rgba[i+1]+.114*rgba[i+2])/255));
        visible||=rgba[i+3]>0;
        rgba[i]=rgba[i+1]=rgba[i+2]=0;
      }
      if(!visible)throw Error('选区没有可用笔尖像素，深色区域会产生笔迹');
      ctx.putImageData(frame,0,0);
      const blob=await new Promise((resolve,reject)=>mask.toBlob(value=>value?resolve(value):reject(Error('无法生成笔尖图片')),'image/png'));
      if(disposed||project.document?.id!==origin.id||project.document.revision!==origin.revision)
        throw Error('工程已变化，请重新创建笔尖');
      const asset=await bridge.importBrushImage(new File([blob],'选区笔尖.png',{type:'image/png'}),origin);
      if(disposed||project.document?.id!==origin.id)return;
      if(canPaintPixels()){
        elements['brush-erase'].checked=false;
        setMode('paint');
      }
      painter.setSettings({...painter.getSettings(),tipAsset:asset.id});
      syncBrushImages();
      if(mode==='paint')brushOptions.open=true;
      status.textContent='已从选区生成笔尖 · 可在笔尖参数中保存预设';
    }).finally(()=>{brushImageBusy=false;if(!disposed){syncBrushImages();selectionBrush.disabled=false;}});
  }
  const presetForm=el('form','document-brush-preset-form'),presetName=el('input');
  presetName.setAttribute('aria-label','笔刷名称');
  Object.assign(presetName,{required:true,maxLength:100,placeholder:'笔刷名称'});
  const savePreset=el('button','','保存预设');
  savePreset.type='submit';
  presetForm.append(presetName,savePreset);brushPopup.append(presetForm);
  presetForm.onsubmit=event=>{
    event.preventDefault();
    const name=presetName.value.trim(),origin=project.origin();
    if(!name||!origin||brushImageBusy||painter.isEditing())return;
    void run(async()=>{
      const id=crypto.randomUUID();
      const settings=painter.getSettings();
      for(const key of brushImageFields)settings[key]=imageControls[key].select.value;
      await project.commands([{op:'library',library:'brushes',id,action:'create',
        patch:{name,graph:defaultBrushGraph(settings)}}],origin);
      presetForm.reset();brushOptions.open=false;
      if(project.document?.id===origin.id)project.selectResource({library:'brushes',id});
      status.textContent='笔刷已保存到当前项目';
    });
  };
  parameters.append(controls.bar);
  options.append(toolName,editTarget,parameterStrip,viewOptions);
  const footer=el('div','document-status-bar'),clipboardNotice=el('output','document-clipboard-notice');
  let clipboardTimer;
  function clearClipboardNotice(){clearTimeout(clipboardTimer);clipboardNotice.textContent='';}
  function reportClipboard(origin,text){
    if(disposed||project.document?.id!==origin.id||project.imageContext?.documentId!==origin.documentId)return;
    clearClipboardNotice();clipboardNotice.textContent=text;
    clipboardTimer=setTimeout(clearClipboardNotice,3500);
  }
  footer.append(clipboardNotice,status);
  host.classList.add('document-editor');host.append(options,rail,stage,footer,importInput);elements['live-uv']=canvas;elements['viewport']=controls.dummy;elements['uv-brush-cursor'].className='area-uv-cursor';stage.append(elements['uv-brush-cursor']);
  let mode=state.tool||'orbit',selectionShape=Object.hasOwn(selectionNames,state.selectionTool)?state.selectionTool:'rect',space=false,nav=null,pan=state.pan||[0,0],zoom=state.zoom||1,selection=null,disposed=false,shown=true,lastImage='',lastTarget=null,lastProject=null,sourceKey='',restoredProject=null;
  let angle=state.angle??0,mirror=state.mirror===true;
  let lassoShape=state.lassoShape==='polygon'?'polygon':'lasso';
  let painter,gradientTool,bucketTool,cloneTool,shapeTool,moveTool,warpTool,canvasText,penTool,edgeTool,pendingImageEdit=null,previewCaption='',fillGroup=state.fillGroup==='bucket'?'bucket':'gradient';
  function layoutBrushOptions(){
    const width=host.clientWidth,compact=width>0&&width<780,small=width>0&&width<440;
    const enabled=['paint','mask','clone','heal','spot'].includes(mode);
    if(!enabled&&brushOptions.open)brushOptions.open=false;
    brushOptions.hidden=!enabled;
    for(const {key,label,anchor,popupAnchor} of brushFields){
      const primary=key==='brush-hardness'||key==='brush-opacity';
      const docked=extendedBrushFields.includes(key)||compact&&(!primary||small);
      if(docked&&label.parentNode!==brushPopup)popupAnchor.after(label);
      else if(!docked&&label.parentNode!==controls.bar)anchor.after(label);
    }
    syncParameterEdges();
  }
  function fitScale(){
    const doc=currentDocument(project);
    return Math.min(Math.max(1,stage.clientWidth-48)/(doc?.width??editingSide),
      Math.max(1,stage.clientHeight-48)/(doc?.height??editingSide));
  }
  function extent(){
    const doc=currentDocument(project);
    return fitScale()*(doc?.width??editingSide)*editingSide/documentFrame(doc)[2];
  }
  // The wheel and keyboard share the same document-pixel range at any panel size.
  function clampZoom(value){return Math.max(.03,Math.min(16/fitScale(),value));}
  function updateViewStatus(size){
    if(previewCaption){
      const pending=strokeQueue?.size>0?` · ${strokeQueue.failure?'待恢复':'保存中'} ${strokeQueue.size} 笔`:'';
      const doc=currentDocument(project);
      const label=`${(fitScale()*zoom*100).toFixed(1)}%　文档 ${doc?.width??4096} × ${doc?.height??4096}　${project.imageContext?.inspectMask?'蒙版 · ':''}${previewCaption}${pending}`;
      if(status.textContent!==label)status.textContent=label;
    }
  }
  function layout(){
    if(!shown)return;
    const doc=currentDocument(project),[x,y,w,h]=documentFrame(doc),scale=fitScale(),size=extent();
    const logicalWidth=scale*(doc?.width??editingSide),logicalHeight=scale*(doc?.height??editingSide);
    const gridHeight=logicalHeight*editingSide/h;
    canvas.style.width=logicalWidth+'px';canvas.style.height=logicalHeight+'px';
    orientImageCanvas(canvas,size*zoom,angle,mirror,gridHeight*zoom,[(x+w/2)/editingSide,(y+h/2)/editingSide]);
    const transform=`translate(-50%,-50%) translate(${pan[0]}px,${pan[1]}px) rotate(${angle}deg) scale(${mirror?-zoom:zoom},${zoom})`;
    canvas.style.transform=transform;
    uvGuideImage.style.width=logicalWidth+'px';uvGuideImage.style.height=logicalHeight+'px';
    uvGuideImage.style.transform=transform;
    angleField.value=angle;
    mirrorView.setAttribute('aria-pressed',String(mirror));
    viewSummary.toggleAttribute('data-oriented',!!angle||mirror);
    if(nav?.rotation){
      const box=stage.getBoundingClientRect(),{center}=nav.rotation;
      compass.style.left=Math.max(32,Math.min(box.width-32,center[0]-box.left))+'px';
      compass.style.top=Math.max(32,Math.min(box.height-58,center[1]-box.top))+'px';
      compass.style.setProperty('--view-angle',angle+'deg');degree.value=angle+'°';
    }
    updateViewStatus(size);
    painter?.refreshUVCursor();
    live?.interactionResolutionChanged();
    selection?.sync();gradientTool?.layout();cloneTool?.layout();shapeTool?.layout();moveTool?.layout();warpTool?.layout();canvasText?.layout();penTool?.layout();edgeTool?.sync();layoutBrushOptions();ctx.onChange();
  }
  const imageOrigin=()=>({id:project.document?.id,revision:project.document?.revision,imageDocumentId:project.imageContext?.documentId});
  const mapOperation=(op,origin)=>op?surfaceToImageCommand(op,origin?.imageDocumentId||project.imageContext?.documentId):null;
  function draft(op,origin){const mapped=mapOperation(op,origin);live.update(mapped);project.draft(mapped);}
  const writing=()=>canvasText?.isEditing()||penTool?.isEditing()||edgeTool?.isEditing()||bridge.busy()||!!pendingImageEdit||strokeQueue.size>0||importing||cutting;
  function submitEdit(operation,origin,onSaved){
    const task=(async()=>{
      try{
        await project.commands([operation],origin);
        if(!disposed)onSaved?.();
        return true;
      }catch(error){if(!disposed)ctx.error(error);return false;}
      finally{if(!disposed){live.update(null);project.draft(null);}}
    })();
    pendingImageEdit=task;
    sync();
    return task.finally(()=>{
      if(pendingImageEdit===task)pendingImageEdit=null;
      if(!disposed)sync();
    });
  }
  function save(op,origin){
    return submitEdit(mapOperation(op,origin),{id:origin.id||origin.projectId,revision:origin.revision});
  }
  const live=createLiveView({rgba:true,viewport:{showLivePaint(){}},canvas,guide:el('canvas'),
    context:()=>{
      const doc=project.document,c=project.imageContext;
      if(!doc||!currentDocument(project))return null;
      const prefs=bridge.preferences();
      // Beyond 50% document scale, one 512px sample covers at least four CSS pixels.
      const fastSize=extent()*zoom>=2048?1024:zoom>=1.75?512:256;
      let visiblePixels,strokeBleed=0;
      const image=currentDocument(project),frame=documentFrame(image);
      const patchable=frame[2]===image.width&&frame[3]===image.height&&frame.every(Number.isInteger);
      if(patchable&&extent()*zoom>=4096*.9){
        const layers=currentDocument(project).layers;
        for(let item=layers.find(layer=>layer.id===c.layerId);item;item=layers.find(layer=>layer.id===layerParent(item))){
          const {outline,shadow}=item.styles??{};
          strokeBleed+=(outline?.enabled?outline.width:0)+(shadow?.enabled?Math.max(Math.abs(shadow.x),Math.abs(shadow.y))+3*shadow.blur:0)+
            3*(item.maskFeather??0);
        }
        const rect=stage.getBoundingClientRect(),at=canvasCoordinates(canvas).fromClient;
        const corners=[[rect.left,rect.top],[rect.right,rect.top],[rect.right,rect.bottom],[rect.left,rect.bottom]].map(([x,y])=>at(x,y));
        visiblePixels=[0,1].map(axis=>[
          Math.max(0,Math.min(...corners.map(point=>point[axis]))*4096),
          Math.min(4096,Math.max(...corners.map(point=>point[axis]))*4096)
        ]);
      }
      return {id:doc.id,revision:doc.revision,documentId:c.documentId,inspectMask:c.inspectMask?c.layerId:null,channel:'color',
        imageGeometry:imageViewGeometry(image),
        fastSize,visiblePixels,strokeBleed,detail:prefs.autoDetail,detailDelay:prefs.detailDelay,key:JSON.stringify([doc.id,doc.revision,c.documentId,c.inspectMask?c.layerId:null])};
    },
    onFrame:frame=>{stage.dataset.strokeWindow=frame.window?.join(',')??'';},
    onStatus:(text,error,detail)=>{if(disposed)return;if(!detail){previewCaption='';status.title=status.textContent=text;return;}const {size=0,revision,phase,message,failedSize}=detail;stage.dataset.previewSize=String(size);stage.dataset.previewRevision=String(revision??'');stage.dataset.previewPhase=phase||'';status.title=message||text;
      if(sampleNotice.dataset.pending&&sampleFrame(imageOrigin()))showSampleNotice();
      const [pw,ph]=previewDimensions(currentDocument(project),size);
      const actual=size?`实际预览 ${pw} × ${ph}${size===4096&&pw===4096&&ph===4096?' · 4K':''}`:'等待实时预览',suffix=phase==='refining'?(currentDocument(project)?.width===4096&&currentDocument(project)?.height===4096?' · 正在提升到 4K…':' · 正在细化至文档尺寸…'):phase==='retrying'?' · 预览暂不可用，正在重试…':phase==='error'?` · ${failedSize===4096?'全尺寸更新失败':'预览更新失败'} · 点击重试`:'';
      previewCaption=actual+suffix;status.tabIndex=phase==='error'?0:-1;if(phase==='error')status.setAttribute('role','button');else status.removeAttribute('role');layout();}});
  let brushPreview=[],brushPreviewRevision=null;
  function syncStrokePreview(){
    if(disposed||!shown)return;
    const origin=imageSelectionOrigin(project),operations=strokeQueue.operations(origin);
    stage.dataset.pendingStrokes=String(strokeQueue.size);
    if(!operations.length&&!brushPreview.length)return;
    if(brushPreviewRevision===origin.revision&&operations.length===brushPreview.length&&operations.every((op,i)=>op===brushPreview[i]))return;
    brushPreview=operations;
    brushPreviewRevision=origin.revision;
    const operation=operations.length>1?operations:operations[0]||null;
    live.update(operation,operations.length ? null : strokeQueue.confirmedOperation(origin.revision));
    project.draft(operation);
  }
  const recovery=el('div','document-save-recovery'),saveMessage=el('output');
  saveMessage.setAttribute('role','alert');
  const retryStroke=button('重试保存笔触',()=>retryStrokeSave());
  const rebaseStroke=button('按最新修订保存',()=>{
    if(window.confirm('把待保存的笔触应用到当前工程的最新修订？'))retryStrokeSave({rebase:true});
  });
  const discardStroke=button('放弃待保存笔触',()=>{
    const id=project.document?.id;
    if(window.confirm('放弃留在本窗口中的待保存笔触？已经写入工程的笔触仍会保留。')&&strokeQueue.discard())
      bridge.strokeSaveSettled(id);
  });
  recovery.hidden=true;recovery.append(saveMessage,retryStroke,rebaseStroke,discardStroke);stage.append(recovery);
  async function retryStrokeSave(options){
    if(drawingGesture())return;
    const id=project.document?.id;
    if(await strokeQueue.retry(options))bridge.strokeSaveSettled(id);
  }
  function syncStrokeSave(){
    const failure=strokeQueue.failure;
    if(shown)updateViewStatus(extent());
    recovery.hidden=!failure;
    if(failure)saveMessage.textContent=`${strokeQueue.size} 笔待保存。 ${failure.message}${journal.unavailable?' '+unavailableStrokeJournal:''}`;
    rebaseStroke.hidden=!strokeQueue.canRebase;
    retryStroke.disabled=rebaseStroke.disabled=discardStroke.disabled=drawingGesture();
    bridge.saveStateChanged();
  }
  const journal=createStrokeDraftJournal(id=>`arachne-image-stroke-draft:${id}:${ctx.workspaceName}:${ctx.areaId}`);
  const strokeQueue=createImageStrokeQueue({read:()=>project.document,readLatest:bridge.readStrokeProject,
    write:(operation,origin)=>project.commands([operation],origin),
    onPreview:syncStrokePreview,onStateChange:()=>{sync();syncStrokeSave();},
    onError:error=>{if(!disposed&&!strokeQueue.failure)ctx.error(error);},
    onDraftChange:journal.write
  });
  function showSampleNotice(text='',pending=false){
    sampleNotice.textContent=text;sampleNotice.hidden=!text;
    if(pending)sampleNotice.dataset.pending='true';else delete sampleNotice.dataset.pending;
  }
  let adjustmentPick=null;
  function stopAdjustmentPick(){
    if(!adjustmentPick)return false;
    adjustmentPick.controller.abort();
    adjustmentPick=null;
    stage.removeAttribute('data-adjustment-pick');
    showSampleNotice();
    return true;
  }
  function currentAdjustmentPick(pick){
    const {origin}=pick,current=imageSelectionOrigin(project);
    return shown&&imageView.isActive()&&origin.id===current.id&&origin.revision===current.revision&&
      origin.documentId===current.documentId&&origin.layerId===current.layerId&&current.target!=='mask';
  }
  stage.addEventListener('pointerdown',event=>{
    const pick=adjustmentPick;
    if(!pick||event.button!==0||event.target!==canvas||space||nav)return;
    if(!currentAdjustmentPick(pick)){stopAdjustmentPick();return;}
    const point=canvasPoint(canvas,event);
    if(point.some(n=>n<0||n>1))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(pick.sampling)return;
    pick.sampling=true;
    showSampleNotice('正在读取调整前的颜色…');
    const {origin,controller}=pick,size=512;
    void run(async()=>{
      try{
        const response=await fetch('/api/projects/'+origin.id+'/paint/image-live',{
          method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
          body:JSON.stringify({revision:origin.revision,documentId:origin.documentId,beforeImageLayer:origin.layerId,resolution:size})
        });
        if(response.status===204)throw Error('贴图已变化，请重新取色');
        if(!response.ok)throw Error((await response.json()).error);
        const pixels=new Uint8Array(await response.arrayBuffer());
        if(adjustmentPick!==pick||!currentAdjustmentPick(pick))return;
        const [x,y]=point.map(n=>Math.min(size-1,Math.floor(n*size)));
        const [r,g,b,alpha]=pixels.subarray(4*(y*size+x),4*(y*size+x)+4);
        const high=Math.max(r,g,b),chroma=high-Math.min(r,g,b);
        if(!alpha||chroma<4){
          showSampleNotice('此处没有可用色相 · 请选择有颜色的区域');
          return;
        }
        const angle=high===r?(g-b)/chroma:high===g?(b-r)/chroma+2:(r-g)/chroma+4;
        stopAdjustmentPick();
        await pick.apply(Math.round(angle*60+360)%360);
      }catch(error){
        if(adjustmentPick!==pick&&controller.signal.aborted&&error.name==='AbortError')return;
        if(adjustmentPick===pick)stopAdjustmentPick();
        throw error;
      }finally{pick.sampling=false;}
    });
  },{signal,capture:true});
  function sampleFrame(origin){
    const frame=live.getFrame(),request=frame?.request;
    return request&&request.id===origin.id&&request.revision===origin.revision&&
      request.documentId===origin.imageDocumentId&&!request.inspectMask&&!request.operation?frame:null;
  }
  function sampleImage(hit,origin){
    if(origin.maskTarget)return false;
    const frame=sampleFrame(origin);
    if(!frame){showSampleNotice('等待当前图像预览',true);return false;}
    const {pixels,request:{size,imageGeometry}}=frame;
    const [width,height]=previewDimensions(imageGeometry,size),[l,t,r,b]=documentClip(imageGeometry);
    const x=Math.max(0,Math.min(width-1,Math.floor((hit.u-l)*width/(r-l))));
    const y=Math.max(0,Math.min(height-1,Math.floor((hit.v-t)*height/(b-t)))),offset=(y*width+x)*4;
    if(!pixels[offset+3]){showSampleNotice('此处没有可取样的颜色');return false;}
    const color='#'+Array.from(pixels.subarray(offset,offset+3),n=>n.toString(16).padStart(2,'0')).join('');
    showSampleNotice();bridge.setForeground(color);syncColors();
    return true;
  }
  status.onclick=()=>{if(stage.dataset.previewPhase==='error')live.retryDetail();};status.onkeydown=event=>{if(stage.dataset.previewPhase==='error'&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();live.retryDetail();}};
  function brushContext(){
    const layer=editableImageLayer(project),origin=imageOrigin(),maskTarget=project.imageContext?.target==='mask';
    const busy=!!pendingImageEdit||importing||cutting||bridge.busy()&&!strokeQueue.saving||!strokeQueue.accepts(imageSelectionOrigin(project));
    return {...origin,busy,enabled:false,uvEnabled:!!layer&&!busy,imageTool:mode,brushColor:bridge.foreground(),brushAssets:project.document?.paint.assets,
      maskValue:maskTarget&&elements['brush-erase'].checked?maskGray(bridge.colorPair('mask').background):bridge.maskInk(),maskTarget,
      layer:layer?{...layer,kind:layer.kind==='pixel'?'paint':'image',channels:{color:true,metallic:false,roughness:false},
        values:{color:bridge.foreground(),metallic:0,roughness:.5}}:null};
  }
  painter=createSurfaceTools({viewport:{},host:controls.dummy,uvHost:stage,elements,settingsKey:'arachne-document-brush:'+ctx.areaId,preserveUnavailableMode:true,stickySample:true,sampleAnyLayer:true,isHandHeld:()=>space||!!nav,uvClip:()=>selection?.clip(),onIdle:()=>{sync();syncStrokeSave();},
    context:brushContext,uvBounds:()=>documentClip(currentDocument(project)),cloneTool:()=>cloneTool,
    preview:(op,origin)=>strokeQueue.preview(mapOperation(op,origin),origin),
    commit:(op,origin)=>strokeQueue.submit(mapOperation(op,origin),origin),sample:sampleImage,place:()=>{}});
  const brushBinding=createBrushBinding({project,painter});
  selectionControls(elements,parameters,stage);
  elements['uv-ellipse-tool']=button(selectionNames.ellipse);
  elements['uv-polygon-tool']=button(selectionNames.polygon);
  elements['uv-wand-tool']=button(selectionNames.wand);
  elements['uv-color-range-tool']=button(selectionNames.colorRange);
  const selectionModes=el('div','document-selection-modes');
  selectionModes.setAttribute('role','group');
  selectionModes.setAttribute('aria-label','选区模式');
  elements.selectionModes=[
    ['replace','新建选区','marquee',''],
    ['add','添加到选区','marqueeAdd','Shift'],
    ['subtract','从选区减去','marqueeSubtract','Alt / Option'],
    ['intersect','与选区相交','marqueeIntersect','Shift + Alt / Option']
  ].map(([mode,label,icon,shortcut])=>{
    const control=chromeButton(button(label,()=>{}),icon);
    control.dataset.selectionMode=mode;
    control.title=shortcut?label+' · '+shortcut:label;
    selectionModes.append(control);
    return control;
  });
  const wandOptions=el('div','document-wand-options');
  const toleranceField=el('input');
  Object.assign(toleranceField,{type:'number',min:0,max:255,step:1,value:state.wand?.tolerance??32});
  toleranceField.setAttribute('aria-label','魔棒容差');
  toleranceField.dataset.scrubNumber='';toleranceField.dataset.scrubSpeed='1';
  const toleranceLabel=el('label','','容差');toleranceLabel.append(toleranceField);
  const contiguousField=el('input');
  Object.assign(contiguousField,{type:'checkbox',checked:state.wand?.contiguous!==false});
  contiguousField.setAttribute('aria-label','连续区域');
  const contiguousLabel=el('label','','连续区域');contiguousLabel.append(contiguousField);
  const wandSource=choice('魔棒取样来源',[['layer','当前层'],['merged','可见合成']],state.wand?.merged?'merged':'layer',()=>ctx.onChange());
  toleranceField.onchange=contiguousField.onchange=()=>ctx.onChange();
  wandOptions.append(toleranceLabel,contiguousLabel,wandSource);
  const readWand=()=>({tolerance:toleranceField.validity.valid&&Number.isFinite(toleranceField.valueAsNumber)?toleranceField.valueAsNumber:32,
    contiguous:contiguousField.checked,merged:wandSource.value==='merged'});
  const rangeOptions=el('div','document-wand-options');
  const fuzzinessField=el('input');
  Object.assign(fuzzinessField,{type:'number',min:0,max:255,step:1,value:state.colorRange?.tolerance??50});
  fuzzinessField.setAttribute('aria-label','颜色范围模糊度');
  fuzzinessField.dataset.scrubNumber='';fuzzinessField.dataset.scrubSpeed='1';
  fuzzinessField.onchange=()=>ctx.onChange();
  const fuzzinessLabel=el('label','','模糊度');
  fuzzinessLabel.title='提高模糊度可选中更多相近色，并保留过渡';
  fuzzinessLabel.append(fuzzinessField);
  const rangeSource=choice('颜色范围取样来源',[['merged','可见合成'],['layer','当前层']],state.colorRange?.merged===false?'layer':'merged',()=>ctx.onChange());
  rangeOptions.append(fuzzinessLabel,rangeSource);
  const readRange=()=>({tolerance:fuzzinessField.validity.valid&&Number.isFinite(fuzzinessField.valueAsNumber)?fuzzinessField.valueAsNumber:50,
    merged:rangeSource.value==='merged'});
  const invertSelectionButton=button('反选',()=>{});
  invertSelectionButton.title='反选 · Ctrl Shift I / ⌘⇧I';
  invertSelectionButton.setAttribute('aria-keyshortcuts','Control+Shift+I Meta+Shift+I');
  elements['uv-selection-inverse']=invertSelectionButton;
  elements['uv-selection-fill-material'].textContent='填充前景色';
  const featherLabel=el('label','','羽化'),featherInput=el('input');
  Object.assign(featherInput,{type:'number',min:0,max:maxUVFeather,step:1,value:0});
  featherInput.setAttribute('aria-label','选区羽化');
  featherInput.dataset.scrubNumber='';
  featherInput.dataset.scrubSpeed='1';
  featherInput.dataset.scrubSuffix=' px';
  featherLabel.title='按图像像素软化选区边缘';
  featherLabel.append(featherInput);
  elements['uv-selection-feather']=featherInput;
  elements['uv-selection-options'].prepend(selectionModes,wandOptions,rangeOptions,featherLabel);
  const transformOptions=elements['uv-transform-options'];
  for(const field of transformOptions.querySelectorAll('[data-transform-field]')){
    field.dataset.scrubNumber='';
    const position=field.dataset.transformField==='x'||field.dataset.transformField==='y';
    field.dataset.scrubSpeed=position?'4':'0.5';
  }
  const fitSelectionButton=button('适应选区',()=>{if(fitSelection())stage.focus({preventScroll:true});});
  fitSelectionButton.title='适应选区 · Ctrl Shift 0 / ⌘⇧0';
  fitSelectionButton.setAttribute('aria-keyshortcuts','Control+Shift+0 Meta+Shift+0');
  fitSelectionButton.disabled=true;
  elements['uv-selection-fit']=fitSelectionButton;
  const transformBoundary=button('变换选区边界',()=>{});
  transformBoundary.title='缩放或旋转选区边界，保留图层内容';
  elements['uv-transform-boundary']=transformBoundary;
  const refineMenu=el('details','document-selection-library'),refineSummary=el('summary','','修改选区');
  refineSummary.setAttribute('aria-haspopup','dialog');refineSummary.setAttribute('aria-expanded','false');
  const refinePopup=el('div','document-brush-popup-content document-selection-library-popup');
  refinePopup.setAttribute('role','dialog');refinePopup.setAttribute('aria-label','修改选区');
  const refineRadius=el('input');
  Object.assign(refineRadius,{type:'number',min:1,max:256,step:1,value:state.selectionRefineRadius??12});
  refineRadius.setAttribute('aria-label','修改半径');
  refineRadius.onchange=()=>ctx.onChange();
  const refineLabel=el('label','','半径（像素）');refineLabel.append(refineRadius);refinePopup.append(refineLabel);
  for(const [operation,label] of [['expand','扩展'],['contract','收缩'],['smooth','平滑']])
    refinePopup.append(button(label,()=>{
      if(!refineRadius.validity.valid||!Number.isFinite(refineRadius.valueAsNumber))return;
      void selection.refine(operation,refineRadius.valueAsNumber);
      refineMenu.open=false;stage.focus({preventScroll:true});
    }));
  const selectionBrush=button('从选区创建笔尖',()=>{refineMenu.open=false;void brushTipFromSelection();});
  refinePopup.append(selectionBrush);
  refineMenu.append(refineSummary,refinePopup);chromeMenu(refineMenu,refinePopup);
  refineMenu.addEventListener('toggle',()=>{
    refineSummary.setAttribute('aria-expanded',String(refineMenu.open));
    if(refineMenu.open){
      selectionBrush.disabled=brushImageBusy||!selection.clip()||!canCopy(true);
      selectionBrush.title=selectionBrush.disabled?'请先选取包含可见像素的区域':'使用选区内的深色像素创建笔尖';
    }
  },{signal});
  const selectionLibrary=el('details','document-selection-library');
  const selectionSummary=el('summary','','已存选区');
  selectionSummary.setAttribute('aria-haspopup','dialog');
  selectionSummary.setAttribute('aria-expanded','false');
  const libraryPopup=el('div','document-brush-popup-content document-selection-library-popup');
  libraryPopup.setAttribute('role','dialog');
  libraryPopup.setAttribute('aria-label','已存选区');
  const libraryList=el('div','document-selection-library-list');
  const libraryForm=el('form','document-selection-library-form');
  const selectionName=el('input');
  Object.assign(selectionName,{type:'text',placeholder:'选区名称',maxLength:100,required:true});
  selectionName.setAttribute('aria-label','选区名称');
  const saveSelectionButton=el('button','','保存');
  saveSelectionButton.type='submit';
  libraryForm.append(selectionName,saveSelectionButton);
  libraryPopup.append(libraryList,libraryForm);
  selectionLibrary.append(selectionSummary,libraryPopup);
  chromeMenu(selectionLibrary,libraryPopup);
  let selectionListKey='';
  function renderSelectionLibrary(){
    if(!selectionLibrary.open)return;
    const names=currentDocument(project)?.selections??[];
    const busy=writing(),key=JSON.stringify([project.document?.id,project.imageContext?.documentId,names,busy]);
    if(key!==selectionListKey){
      selectionListKey=key;
      libraryList.replaceChildren();
      if(!names.length)libraryList.append(el('span','document-muted','暂无已存选区'));
      for(const saved of names){
        const row=el('div','document-selection-library-row');
        const load=button(saved.name,()=>{
          if(!selection.loadSelection(saved))return;
          selectionLibrary.open=false;
          stage.focus({preventScroll:true});
        },'载入选区 '+saved.name);
        const remove=chromeButton(button('删除选区 '+saved.name,()=>{
          const origin=imageSelectionOrigin(project);
          void submitEdit({op:'image',action:'deleteSelection',documentId:origin.documentId,patch:{name:saved.name}},origin);
        }),'trash');
        load.disabled=remove.disabled=busy;
        row.append(load,remove);libraryList.append(row);
      }
    }
    saveSelectionButton.disabled=selectionName.disabled=busy||!selection?.clip();
    selectionName.placeholder=selectionName.disabled?'先在画布上建立选区':'选区名称';
  }
  selectionLibrary.addEventListener('toggle',()=>{
    selectionSummary.setAttribute('aria-expanded',String(selectionLibrary.open));
    if(selectionLibrary.open){renderSelectionLibrary();if(!selectionName.disabled)selectionName.focus();}
  },{signal});
  libraryForm.onsubmit=event=>{
    event.preventDefault();
    const origin=imageSelectionOrigin(project),region=selection.snapshot(),name=selectionName.value.trim();
    if(!region||!name||writing())return;
    void submitEdit({op:'image',action:'saveSelection',documentId:origin.documentId,
      patch:{name,...region}},origin,()=>{selectionName.value='';});
  };
  elements['uv-selection-options'].append(invertSelectionButton,fitSelectionButton,transformBoundary,refineMenu,selectionLibrary);
  parameters.append(transformOptions,elements['uv-selection-options'],sampleNotice);
  selection=bridge.createSelection({pane:stage,canvas,elements,isHandHeld:()=>space||!!nav,
    context:()=>{
      const layer=editableImageLayer(project),origin=imageOrigin(),editable=!!layer&&layer.visible&&!layer.locked&&!writing();
      const pixels=project.imageContext?.target!=='mask';
      const asset=layer?.kind==='image'?(layer.embedded??project.document.paint.assets[layer.asset]):layer?.shape;
      const image=asset?{x:layer.x,y:layer.y,scale:layer.scale,rotation:layer.rotation,
        stretch:layer.stretch,size:[asset.width,asset.height]}:null;
      return {...origin,id:layer?.id,projectId:origin.id,active:!!currentDocument(project),interactive:!writing()&&!drawingGesture()&&!nav,image,
        canvasRect:documentClip(currentDocument(project)),editTarget:pixels?'pixels':'mask',
        canSampleLayer:!!layer&&layer.kind!=='adjustment',
        canTransform:editable&&pixels&&(!!image||layer.kind==='pixel'&&!layer.alphaLocked&&!!(layer.raster||layer.strokes?.length)),
        transformReason:layer?.locked?'请先解锁图层':layer&&!layer.visible?'请先显示图层':
          layer?.alphaLocked?'请先解锁透明像素':undefined,
        canClear:editable&&pixels&&layer.kind==='pixel'&&!layer.alphaLocked,
        canFillMaterial:editable&&pixels&&layer.kind==='pixel',canFillMask:editable};
    },
    activate:()=>{setMode('select');return true;},onTransformState:syncToolName,selectionMode:state.selectionMode,selectionFeather:state.selectionFeather,onMode:ctx.onChange,onError:ctx.error,
    wandOptions:{host:wandOptions,read:readWand,rangeHost:rangeOptions,readRange,refine:refineMenu},
    requestSelection:async(request,origin,signal)=>{
      const response=await fetch('/api/projects/'+origin.projectId+'/paint/image-select',{method:'POST',signal,
        headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,revision:origin.revision,documentId:origin.imageDocumentId})});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'无法计算选区');
      return result.selection;
    },
    preview:op=>draft(op),commit:(op,origin)=>save(op,{...origin,id:origin.projectId}),
    fillOperation:(rect,target,value,shape)=>painter.fillUV(rect,target,value,shape,{opacity:1})});
  for(const [id,label,icon,key] of [['uv-select-tool',selectionNames.rect,'marquee','M'],['uv-ellipse-tool',selectionNames.ellipse,'ellipseMarquee','Shift+M'],['uv-lasso-tool',selectionNames.lasso,'drawLasso','L'],['uv-polygon-tool',selectionNames.polygon,'polygonLasso','Shift+L'],['uv-wand-tool',selectionNames.wand,'wand','W'],['uv-color-range-tool',selectionNames.colorRange,'drawColorRange','Shift+W'],['uv-transform-tool','自由变换','drawTransform','Control+T Meta+T'],['surface-orbit','抓手','hand','H'],['surface-paint','画笔','drawBrush','B'],['uv-eraser-tool','橡皮擦','drawEraser','E'],['surface-sample','取样','drawEyedropper','I']]){
    const control=elements[id];control.textContent=label;chromeButton(control,icon,label);
    control.title=label+' · '+key;control.setAttribute('aria-keyshortcuts',key);
  }
  const rotateView=chromeButton(button('旋转视图',()=>{selection.stop();setMode('rotateView');stage.focus({preventScroll:true});}),'rotateView');
  rotateView.title='旋转视图 · R · 拖动旋转 · Shift 每 15°';
  rotateView.setAttribute('aria-keyshortcuts','R');
  rotateView.ondblclick=()=>resetOrientation();
  const moveButton=chromeButton(button('移动图层',()=>{
    selection.stop();setMode('move');stage.focus({preventScroll:true});
  }),'move');
  moveButton.title='移动图层 · V · 单击画布选层 · Shift 加选';
  moveButton.setAttribute('aria-keyshortcuts','V');
  const warpButton=chromeButton(button('图层变形',()=>{
    selection.stop();setMode('warp');warpTool.begin();stage.focus({preventScroll:true});
  }),'drawWarp');
  warpButton.title='图层变形 · 斜切、四角扭曲、透视、平滑网格';
  for(const id of ['surface-paint','uv-eraser-tool'])elements[id].title+=' · Control + Option 拖动调节笔尖';
  const edgeButton=chromeButton(button('局部修边',()=>{selection.stop();setMode('refineEdge');stage.focus({preventScroll:true});}),'edgeRefine');
  edgeButton.title='沿当前选区边缘局部收边、扩边或软化';
  const penButton=chromeButton(button('钢笔工具',()=>{selection.stop();setMode('pen');stage.focus({preventScroll:true});}),'penPath');
  penButton.title='钢笔工具 · P';penButton.setAttribute('aria-keyshortcuts','P');
  const textTool=button('文字工具',()=>{selection.stop();setMode('text');});
  chromeButton(textTool,'text');textTool.title='文字工具 · T';textTool.setAttribute('aria-keyshortcuts','T');
  const shapeButton=button('形状工具',()=>{selection.stop();setMode('shape');stage.focus({preventScroll:true});});
  chromeButton(shapeButton,'drawShape');shapeButton.title='形状工具 · U / Shift+U · Shift 等比 · Alt 从中心';
  shapeButton.setAttribute('aria-keyshortcuts','U Shift+U');
  const gradientButton=button('渐变工具',()=>{selection.stop();setMode('gradient');stage.focus({preventScroll:true});});
  chromeButton(gradientButton,'drawGradient');gradientButton.title='渐变工具 · G / Shift+G';gradientButton.setAttribute('aria-keyshortcuts','G Shift+G');
  const bucketButton=button('油漆桶',()=>{selection.stop();setMode('bucket');stage.focus({preventScroll:true});});
  chromeButton(bucketButton,'paintBucket');bucketButton.title='油漆桶 · G / Shift+G · 取样当前像素层';
  bucketButton.setAttribute('aria-keyshortcuts','G Shift+G');
  const cloneButton=button('仿制图章',()=>{
    selection.stop();elements['brush-erase'].checked=false;setMode('clone');stage.focus({preventScroll:true});
  });
  chromeButton(cloneButton,'cloneStamp');
  cloneButton.title='仿制图章 · S · Alt / Option 单击取样';
  cloneButton.setAttribute('aria-keyshortcuts','S');
  function repairTool(name,mode,icon){
    const control=chromeButton(button(name,()=>{
      selection.stop();elements['brush-erase'].checked=false;setMode(mode);stage.focus({preventScroll:true});
    }),icon);
    control.title=name+(mode==='heal'?' · Shift + J · Alt / Option 单击取样':' · J');
    control.setAttribute('aria-keyshortcuts',mode==='heal'?'Shift+J':'J');
    return control;
  }
  const spotButton=repairTool('污点修复画笔','spot','drawSpotRepair'),healButton=repairTool('修复画笔','heal','healBrush');
  for(const [name,tools] of [
    ['移动与选区',[moveButton,elements['uv-select-tool'],elements['uv-ellipse-tool'],elements['uv-lasso-tool'],
      elements['uv-polygon-tool'],elements['uv-wand-tool'],elements['uv-color-range-tool'],edgeButton]],
    ['绘制与修复',[elements['surface-paint'],elements['uv-eraser-tool'],cloneButton,spotButton,healButton]],
    ['变换',[elements['uv-transform-tool'],warpButton]],
    ['填充与取样',[gradientButton,bucketButton,elements['surface-sample']]],
    ['路径、文字与形状',[penButton,textTool,shapeButton]],
    ['画布导航',[elements['surface-orbit'],rotateView]]
  ]){
    const group=el('div','document-tool-group');
    group.setAttribute('role','group');group.setAttribute('aria-label',name);
    group.append(...tools);toolList.append(group);
  }
  for(const [id,shape] of [['uv-select-tool','rect'],['uv-ellipse-tool','ellipse'],['uv-lasso-tool','lasso'],['uv-polygon-tool','polygon'],['uv-wand-tool','wand'],['uv-color-range-tool','colorRange']]){
    elements[id].addEventListener('click',()=>{
      selectionShape=shape;
      if(shape==='lasso'||shape==='polygon')lassoShape=shape;
      syncToolName();ctx.onChange();
    });
  }
  elements['surface-orbit'].onclick=()=>{selection.stop();setMode('orbit');};elements['surface-paint'].onclick=()=>{selection.stop();elements['brush-erase'].checked=false;setMode(project.imageContext?.target==='mask'?'mask':'paint');};elements['uv-eraser-tool'].onclick=()=>{selection.stop();elements['brush-erase'].checked=true;setMode(project.imageContext?.target==='mask'?'mask':'paint');};elements['surface-sample'].onclick=()=>{if(project.imageContext?.target!=='mask'){selection.stop();setMode('sample');}};
  const colors=el('div','document-colors'),swatches=el('div','document-color-swatches'),actions=el('div','document-color-actions');
  colors.setAttribute('role','group');colors.setAttribute('aria-label','前景色和背景色');
  const front=el('input','document-color-front'),back=el('input','document-color-back');
  front.type=back.type='color';
  front.setAttribute('aria-label','图像前景色');front.title='图像前景色';
  back.setAttribute('aria-label','图像背景色');back.title='图像背景色';
  swatches.append(front,back);
  for(const [key,label,icon] of [
    ['d','恢复图像黑白','drawDefaultColors'],
    ['x','交换图像前景色和背景色','drawSwapColors']
  ]){
    const action=chromeButton(button(label,()=>colorKey(key)),icon);
    action.setAttribute('aria-keyshortcuts',key.toUpperCase());action.title=label+' · '+key.toUpperCase();
    actions.append(action);
  }
  colors.append(swatches,actions);rail.append(colors);
  function colorTarget(){return project.imageContext?.target==='mask'?'mask':'paint';}
  function syncColors(){
    const target=colorTarget(),pair=bridge.colorPair(target);
    front.value=pair.foreground;back.value=pair.background;
    for(const input of [front,back])input.toggleAttribute('data-color-gray',target==='mask');
    gradientTool?.sync();
  }
  front.oninput=()=>{bridge.setColor(colorTarget(),'foreground',front.value);syncColors();};back.oninput=()=>{bridge.setColor(colorTarget(),'background',back.value);syncColors();};
  function colorKey(key){bridge.colorKey(key,colorTarget());syncColors();painter.render();}
  function syncToolName(transforming=selection?.isTransforming(),boundary=selection?.isTransformingBoundary()){
    const caption=space?'临时抓手':transforming?(boundary?'变换选区边界':'自由变换'):{orbit:'抓手',rotateView:'旋转视图',move:colorTarget()==='mask'?'移动蒙版':'移动图层',warp:'图层变形',paint:elements['brush-erase'].checked?'橡皮擦':'画笔',mask:elements['brush-erase'].checked?'蒙版橡皮擦':'蒙版画笔',select:selectionNames[selectionShape],sample:'取样',refineEdge:'局部修边',pen:'钢笔',text:'文字',gradient:'渐变',bucket:'油漆桶',clone:'仿制图章',heal:'修复画笔',spot:'污点修复画笔',shape:'形状'}[mode];
    const layer=currentLayer(project);
    editTarget.hidden=!layer;
    if(layer){
      const label=project.imageContext?.target==='mask'?'蒙版':'图层内容';
      if(targetLayerName.textContent!==layer.name)targetLayerName.textContent=layer.name;
      if(targetKind.textContent!==label)targetKind.textContent=label;
      editTarget.title=layer.name+' · '+label;
    }
    if(toolName.textContent===caption)return;
    toolName.textContent=caption;
    parameters.scrollLeft=0;
    syncParameterEdges();
  }
  function setMode(next){
    if(canvasText?.isEditing()&&next!==mode)return;
    stopAdjustmentPick();
    mode=next;showSampleNotice();
    if(next==='bucket'||next==='gradient')fillGroup=next;
    stage.toggleAttribute('data-text-placement',next==='text');
    stage.toggleAttribute('data-rotate-view',next==='rotateView');
    rotateView.setAttribute('aria-pressed',String(next==='rotateView'));
    painter.setMode(['rotateView','select','move','warp','pen','refineEdge','text','gradient','bucket','shape'].includes(next)?'orbit':next);
    moveButton.setAttribute('aria-pressed',String(next==='move'));
    moveButton.title=colorTarget()==='mask'?'移动蒙版 · V · 解除链接后可拖动':'移动图层 · V · 单击画布选层 · Shift 加选';
    moveTool?.setActive(next==='move');
    warpButton.setAttribute('aria-pressed',String(next==='warp'));
    warpTool?.setActive(next==='warp');
    textTool.setAttribute('aria-pressed',String(next==='text'));
    penButton.setAttribute('aria-pressed',String(next==='pen'));penTool?.setActive(next==='pen');
    edgeButton.setAttribute('aria-pressed',String(next==='refineEdge'));edgeTool?.setActive(next==='refineEdge');
    shapeButton.setAttribute('aria-pressed',String(next==='shape'));
    gradientButton.setAttribute('aria-pressed',String(next==='gradient'));
    bucketButton.setAttribute('aria-pressed',String(next==='bucket'));
    cloneButton.setAttribute('aria-pressed',String(next==='clone'));
    healButton.setAttribute('aria-pressed',String(next==='heal'));spotButton.setAttribute('aria-pressed',String(next==='spot'));
    gradientTool?.setActive(next==='gradient');
    bucketTool?.setActive(next==='bucket');
    cloneTool?.setActive(['clone','heal','spot'].includes(next)?next:'');
    shapeTool?.setActive(next==='shape');
    syncBrushImages();
    syncToolName();
    controls.bar.hidden=!['paint','mask','clone','heal','spot'].includes(next);painter.render();canvasText?.layout();layoutBrushOptions();ctx.onChange();
  }
  function setAngle(value){
    angle=Number((((value+180)%360+360)%360-180).toFixed(1));
    layout();
  }
  function resetOrientation(){
    mirror=false;setAngle(0);
  }
  const fitCanvas=button('适应画布',()=>{
    const {cos,sin}=viewRotation(),doc=currentDocument(project);
    const w=doc?.width??editingSide,h=doc?.height??editingSide;
    zoom=Math.min(Math.max(1,stage.clientWidth-48)/(Math.abs(cos)*w+Math.abs(sin)*h),
      Math.max(1,stage.clientHeight-48)/(Math.abs(sin)*w+Math.abs(cos)*h))/fitScale();pan=[0,0];layout();
  });
  const actualSize=button('实际像素',()=>{zoom=1/fitScale();pan=[0,0];layout();});
  const viewMenu=el('details','document-brush-popup document-orientation-menu'),viewSummary=el('summary');
  const viewPopup=el('div','document-brush-popup-content document-orientation-popup');
  viewPopup.setAttribute('role','dialog');viewPopup.setAttribute('aria-label','画布方向');
  chromeButton(viewSummary,'rotateView','画布方向');
  viewSummary.setAttribute('role','button');viewSummary.setAttribute('aria-haspopup','dialog');viewSummary.setAttribute('aria-expanded','false');
  const angleField=el('input'),angleLabel=el('label','','视图角度');
  Object.assign(angleField,{type:'number',min:-180,max:180,step:.1,value:angle});
  angleField.setAttribute('aria-label','视图角度');angleField.dataset.scrubNumber='';angleField.dataset.scrubSuffix='°';
  angleField.oninput=()=>{if(Number.isFinite(angleField.valueAsNumber))setAngle(angleField.valueAsNumber);};
  angleLabel.append(angleField);
  const mirrorView=chromeButton(button('水平镜像视图',()=>{mirror=!mirror;layout();}),'mirrorView');
  mirrorView.append('水平镜像视图');
  const resetView=button('复位视图方向',resetOrientation);
  viewPopup.append(angleLabel,mirrorView,resetView);viewMenu.append(viewSummary,viewPopup);
  viewMenu.addEventListener('toggle',()=>viewSummary.setAttribute('aria-expanded',String(viewMenu.open)),{signal});
  chromeMenu(viewMenu,viewPopup);
  chromeButton(fitCanvas,'fit');fitCanvas.append(el('span','document-fit-label','适应画布'));
  fitCanvas.title='适应画布 · Ctrl 0 / ⌘0';fitCanvas.setAttribute('aria-keyshortcuts','Control+0 Meta+0');
  actualSize.title='实际像素 · Ctrl 1 / ⌘1';actualSize.setAttribute('aria-keyshortcuts','Control+1 Meta+1');
  const uvToggle=chromeButton(button('原 UV 参考',()=>{}),'grid');
  uvToggle.classList.add('document-uv-toggle');
  const uvGuide=createImageUVGuide({image:uvGuideImage,toggle:uvToggle,notice:uvGuideNotice,onChange:ctx.onChange,enabled:state.uvGuide===true,
    read:()=>{
      const doc=project.document;
      if(!doc)return null;
      return {id:doc.id,visible:shown&&!!currentDocument(project)&&!project.imageContext?.inspectMask,
        key:JSON.stringify([doc.id,doc.source.files?.[doc.source.reviewSource],doc.source.uvSha256,doc.modeling?.steps])};
    }});
  viewOptions.append(viewMenu,uvToggle,fitCanvas,actualSize);
  function viewRotation(){
    const radians=angle*Math.PI/180;
    return {cos:Math.cos(radians),sin:Math.sin(radians)};
  }
  function fitSelection(){
    const region=selection.clip();
    if(!region||selection.isDragging()||selection.isTransforming())return false;
    const [left,top,right,bottom]=region.clip,doc=currentDocument(project);
    const [x,y,fw,fh]=documentFrame(doc),width=extent(),height=fitScale()*doc.height*editingSide/fh;
    const {cos,sin}=viewRotation(),w=(right-left)*width,h=(bottom-top)*height;
    zoom=clampZoom(Math.min(Math.max(1,stage.clientWidth-48)/(w*Math.abs(cos)+h*Math.abs(sin)),
      Math.max(1,stage.clientHeight-48)/(w*Math.abs(sin)+h*Math.abs(cos))));
    const dx=((left+right)/2-(x+fw/2)/editingSide)*width*(mirror?-zoom:zoom);
    const dy=((top+bottom)/2-(y+fh/2)/editingSide)*height*zoom;
    pan=[-dx*cos+dy*sin,-dx*sin-dy*cos];
    layout();
    return true;
  }
  function drawingGesture(){return painter.isEditing()||gradientTool?.isEditing()||shapeTool?.isEditing()||moveTool?.isEditing()||warpTool?.isEditing()||canvasText?.isEditing()||penTool?.isEditing()||edgeTool?.isEditing();}
  function pointerAngle(event,center){
    return Math.atan2(event.clientY-center[1],event.clientX-center[0])*180/Math.PI;
  }
  stage.addEventListener('pointerdown',event=>{
    if(drawingGesture()||selection.isDragging())return;
    const rotating=mode==='rotateView'&&!space&&event.button===0&&!canvas.hidden;
    const panning=event.button===1||event.button===0&&(space||mode==='orbit'&&!event.target.closest('svg'));
    if(!rotating&&!panning)return;
    nav={pointer:event.pointerId,x:event.clientX,y:event.clientY,pan:[...pan]};
    if(rotating){
      const {center}=canvasCoordinates(canvas);
      nav.rotation={center,start:pointerAngle(event,center),angle,nearCenter:Math.hypot(event.clientX-center[0],event.clientY-center[1])<20};
      compass.hidden=false;layout();
    }
    painter.refreshUVCursor();stage.setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();
  },{capture:true,signal});
  function updateNavigation(event){
    if(nav.rotation){
      const {center,start,angle,nearCenter}=nav.rotation;
      const value=angle+(nearCenter?(event.clientX-nav.x)*.5:pointerAngle(event,center)-start);
      setAngle(event.shiftKey?Math.round(value/15)*15:value);
    }else{
      pan=[nav.pan[0]+event.clientX-nav.x,nav.pan[1]+event.clientY-nav.y];layout();
    }
  }
  let strokePan=null;
  stage.addEventListener('pointermove',event=>{
    if(nav?.pointer===event.pointerId)updateNavigation(event);
    else if(space&&painter.isDrawing()&&painter.pauseDrawing()){
      strokePan??={x:event.clientX,y:event.clientY,pan:[...pan]};
      pan=[strokePan.pan[0]+event.clientX-strokePan.x,strokePan.pan[1]+event.clientY-strokePan.y];
      layout();event.preventDefault();
    }
  },{signal});
  function finishNavigation(cancel=false){
    if(!nav)return false;
    const {pointer,rotation}=nav;
    nav=null;compass.hidden=true;
    if(cancel&&rotation)setAngle(rotation.angle);
    painter.refreshUVCursor();
    if(stage.hasPointerCapture(pointer))stage.releasePointerCapture(pointer);
    return true;
  }
  for(const name of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(name,event=>{
    strokePan=null;
    if(nav?.pointer!==event.pointerId)return;
    if(name==='pointerup')updateNavigation(event);
    finishNavigation(name!=='pointerup');
  },{signal});
  stage.addEventListener('wheel',event=>{event.preventDefault();if(drawingGesture()&&!painter.pauseDrawing())return;const before=zoom;zoom=clampZoom(zoom*Math.exp(-event.deltaY*.001));const r=stage.getBoundingClientRect(),x=event.clientX-r.x-r.width/2,y=event.clientY-r.y-r.height/2;pan=[x-(x-pan[0])*zoom/before,y-(y-pan[1])*zoom/before];layout();},{passive:false,signal});
  gradientTool=createImageGradientTool({stage,canvas,parameters,signal,settings:state.gradient,onChange:ctx.onChange,
    context:()=>{
      const origin=imageSelectionOrigin(project),layer=editableImageLayer(project);
      const editable=origin.target==='mask'?hasImageLayerMask(layer)&&!layer.locked:
        layer?.kind==='gradient'?!layer.locked:canInsertImage(project);
      return {origin,layer,insertion:imageInsertion(project),colors:bridge.colorPair(colorTarget()),selection:selection.clip(),
        enabled:!!currentDocument(project)&&editable&&!writing()&&!painter.isEditing()&&!selection.isTransforming()&&!nav&&!space};
    },
    preview:operation=>{live.update(operation);project.draft(operation);},
    commit:(operation,origin,added)=>submitEdit(operation,origin,added?()=>selectAddedLayer(project,origin,operation.layerId):undefined)
  });
  function canPaintPixels(){
    const layer=editableImageLayer(project);
    return layer?.kind==='pixel'&&layer.visible&&!layer.locked&&project.imageContext?.target!=='mask'&&!writing();
  }
  bucketTool=createImageFillTool({stage,canvas,parameters,signal,settings:state.bucket,onChange:ctx.onChange,
    context:()=>({origin:imageSelectionOrigin(project),layer:currentLayer(project),color:bridge.foreground(),
      selection:selection.clip(),enabled:canPaintPixels()&&!selection.isTransforming()&&!nav&&!space}),
    commit:submitEdit,sample:([u,v])=>sampleImage({u,v},imageOrigin())});
  cloneTool=createImageCloneTool({stage,canvas,parameters,settings:state.clone,context:brushContext,onChange:ctx.onChange,onError:ctx.error});
  moveTool=createImageMoveTool({stage,canvas,parameters,signal,settings:state.move,context:()=>{
    const image=currentDocument(project),origin=imageSelectionOrigin(project),selected=project.imageContext;
    const ids=(selected?.layerIds??(selected?.layerId?[selected.layerId]:[])).filter(id=>image?.layers.some(layer=>layer.id===id));
    const mask=selected?.target==='mask'?editableImageLayer(project):null;
    const reason=writing()?'请等待当前编辑完成':mask?.locked?'请先解锁图层':
      mask&&mask.maskLinked!==false?'请先解除蒙版与图层的链接':'';
    return {image,origin,ids,mask,enabled:!!image&&!reason,reason,space,assets:project.document?.paint.assets??{}};
  },select:(id,extend)=>{
    const current=project.imageContext;
    const ids=new Set(extend?(current?.layerIds??(current?.layerId?[current.layerId]:[])):[]);
    if(extend&&ids.has(id)&&ids.size>1)ids.delete(id);else ids.add(id);
    imageView.activate();
    selectImage(project,{layerId:ids.has(id)?id:[...ids].at(-1),layerIds:[...ids],target:'pixels'},{reveal:ids.has(id)});
  },preview:operation=>{live.update(operation);project.draft(operation);},
    commit:(operation,origin)=>submitEdit(operation,origin),onError:ctx.error,onChange:ctx.onChange});
  warpTool=createImageWarpTool({stage,canvas,parameters,signal,context:()=>{
    const layer=editableImageLayer(project),origin=imageSelectionOrigin(project),layerIds=project.imageContext?.layerIds;
    const reason=writing()?'请等待当前编辑完成':origin.target==='mask'?'请先选择图层内容':
      layerIds?.length>1?'请选择一个图层':
      !['image','shape'].includes(layer?.kind)?'请选择图像、文字或形状层':
      layer.locked?'请先解锁图层':!layer.visible?'请先显示图层':'';
    return {layer,origin,layerIds,reason,enabled:!reason,assets:project.document?.paint.assets??{}};
  },preview:operation=>{live.update(operation);project.draft(operation);},
    commit:(operation,origin)=>submitEdit(operation,origin),onError:ctx.error});
  function canCreateShape(){
    return canInsertImage(project)&&project.imageContext?.target!=='mask'&&!writing();
  }
  shapeTool=createImageShapeTool({stage,canvas,parameters,signal,settings:state.shape,onChange:ctx.onChange,
    context:()=>{
      return {origin:imageSelectionOrigin(project),insertion:imageInsertion(project),colors:bridge.colorPair('paint'),
        enabled:canCreateShape()&&!selection.isTransforming()&&!nav&&!space};
    },
    preview:operation=>{live.update(operation);project.draft(operation);},
    commit:(operation,origin)=>submitEdit(operation,origin,()=>selectAddedLayer(project,origin,operation.layerId))
  });
  function canPaste(){
    return !!currentDocument(project)&&!writing()&&!drawingGesture()&&!selection.isDragging()&&!selection.isTransforming()&&!nav;
  }
  function canCopy(merged=false){
    if(!canPaste()||copying)return false;
    if(merged){
      const {layers}=currentDocument(project);
      return layers.some(layer=>layerIsVisible(layers,layer)&&layer.opacity>0&&!['adjustment','group'].includes(layer.kind));
    }
    const layer=editableImageLayer(project);
    return project.imageContext?.target!=='mask'&&!!layer?.visible&&layer.kind!=='adjustment'&&layer.opacity>0;
  }
  function canCut(){
    const layer=editableImageLayer(project);
    return canCopy()&&layer?.kind==='pixel'&&!layer.locked&&!layer.alphaLocked&&!!(layer.raster||layer.strokes?.length)&&!!selection.clip();
  }
  function cutSelection(){
    if(!canCut())return false;
    const origin=imageSelectionOrigin(project),region=selection.clip();
    clearClipboardNotice();cutting=true;sync();
    status.textContent='正在剪切 4K 像素…';
    void run(async()=>{
      const copied=await copyImagePixels(origin,region,{cut:true});
      const current=imageSelectionOrigin(project);
      if(disposed||current.id!==origin.id||current.revision!==origin.revision||current.documentId!==origin.documentId||
         current.layerId!==origin.layerId||current.target!==origin.target)
        throw Error('原图层已变化，请重新剪切');
      await commandAt(project,origin,{action:'cutPixels',layerId:origin.layerId,rect:region.clip,...uvShapePayload(region)});
      reportClipboard(origin,'已剪切 '+copied.width+' × '+copied.height+' px');
    }).finally(()=>{cutting=false;if(!disposed)sync();});
    return true;
  }
  function syncClipboard(){
    copy.disabled=!canCopy();paste.disabled=!canPaste()||!canInsertImage(project)||!copiedImage();
    copy.setAttribute('aria-busy',String(copying));
    importButton.disabled=!canPaste()||!canInsertImage(project);
    importButton.setAttribute('aria-busy',String(importing));
    download.disabled=!canPaste()||!!exportRequest;
    download.setAttribute('aria-busy',String(!!exportRequest));
    const doc=currentDocument(project);
    download.title=exportRequest?'正在导出 PNG…':doc?`导出当前贴图 · ${doc.width} × ${doc.height} PNG`:'导出当前贴图 PNG';
  }
  async function downloadDocument(){
    const image=currentDocument(project);
    if(!image||exportRequest||!canPaste())return;
    const {id,revision,documentId}=imageSelectionOrigin(project);
    const controller=exportRequest=new AbortController();
    syncClipboard();
    try{
      const response=await fetch('/api/projects/'+id+'/paint/image-export',{
        method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify({revision,documentId})
      });
      if(response.status===204)throw Error('图像已变化，请重新导出');
      if(!response.ok)throw Error((await response.json()).error||'导出 PNG 失败');
      const png=await response.blob();
      if(controller.signal.aborted)return;
      const url=URL.createObjectURL(png),link=el('a');
      const name=image.name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').replace(/[ .]+$/,'')||'贴图';
      link.href=url;link.download=name+'.png';
      host.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),10000);
    }catch(error){
      if(!disposed&&error.name!=='AbortError')ctx.error(error);
    }finally{
      exportRequest=null;
      if(!disposed)syncClipboard();
    }
  }
  function copySelection(merged=false){
    if(!canCopy(merged))return false;
    const origin=imageSelectionOrigin(project),region=selection.clip()||{clip:documentClip(currentDocument(project))};
    clearClipboardNotice();copying=true;syncClipboard();
    status.textContent=merged?'正在复制可见图层…':'正在复制 4K 像素…';
    void copyImagePixels(origin,region,{merged}).then(({width,height})=>{
      reportClipboard(origin,`${merged?'已合并复制':'已复制'} ${width} × ${height} px`);
    }).catch(error=>{
      if(!disposed&&error.name!=='AbortError'){status.textContent=error.message;ctx.error(error);}
    }).finally(()=>{if(!disposed){copying=false;syncClipboard();}});
    return true;
  }
  function importFile(file,position,pixelSize=false){
    if(!canPaste()||!canInsertImage(project))return;
    const origin=imageSelectionOrigin(project),layerId=crypto.randomUUID(),insertion=imageInsertion(project);
    importing=true;
    syncClipboard();
    void run(async()=>{
      if(!origin.documentId)throw Error('请先新建贴图');
      const prepared=await prepareDrawingImage(file);
      if(disposed)return;
      const [width,height]=prepared.size;
      const placement=position?.scale!==undefined?position:imageClipboardPlacement(width,height,position&&[position.x,position.y]);
      if(!pixelSize&&position?.scale===undefined)placement.scale=Math.min(1,placement.scale);
      await bridge.importDocumentAsset(prepared.file,origin,layerId,{...placement,...insertion});
      if(!disposed)selectAddedLayer(project,origin,layerId);
    }).finally(()=>{importing=false;if(!disposed)sync();});
  }
  function pasteSelection(inPlace=false){
    const entry=copiedImage();
    if(!entry||!canPaste()||!canInsertImage(project))return false;
    const c=project.imageContext;
    const center=inPlace||entry.projectId===project.document.id&&entry.documentId===c?.documentId?entry.center:undefined;
    importFile(entry.file,imageClipboardPlacement(entry.width,entry.height,center));
    return true;
  }
  function pasteSystemImage(){
    const read=window.arachneDesktop?.readImageClipboard;
    if(!read||!canPaste()||!canInsertImage(project))return false;
    const target=imageSelectionOrigin(project);
    void run(async()=>{
      const bytes=await read(),current=imageSelectionOrigin(project);
      if(disposed||!imageView.isActive()||target.id!==current.id||target.documentId!==current.documentId||
         target.layerId!==current.layerId||target.target!==current.target)return;
      if(bytes)importFile(new File([bytes],'粘贴图像.png',{type:'image/png'}),undefined,true);
      else pasteSelection();
    });
    return true;
  }
  function editCommand(name){
    if(!shown||disposed)return false;
    if(name==='copy')return copySelection();
    if(name==='cut')return cutSelection();
    if(name==='paste'&&typeof window.arachneDesktop?.readImageClipboard==='function')return pasteSystemImage();
    if(name==='selectAll')return !writing()&&!drawingGesture()&&selection.selectAll(selectionShape);
  }
  const stopClipboard=onImageClipboardChange(syncClipboard);
  host.addEventListener('copy',event=>{
    if(!event.target.closest('input,textarea,[contenteditable]')&&copySelection()){
      event.preventDefault();event.stopPropagation();
    }
  },{signal});
  host.addEventListener('cut',event=>{
    if(!event.target.closest('input,textarea,[contenteditable]')&&cutSelection()){
      event.preventDefault();event.stopPropagation();
    }
  },{signal});
  host.addEventListener('paste',event=>{
    if(event.target.closest('input,textarea,[contenteditable]')||!canPaste()||!canInsertImage(project))return;
    const file=[...event.clipboardData?.items||[]].filter(item=>item.kind==='file')
      .map(item=>item.getAsFile()).find(acceptsDrawingImage);
    if(file){event.preventDefault();event.stopPropagation();importFile(file,undefined,true);}
    else if(!event.clipboardData?.types.length&&pasteSelection()){event.preventDefault();event.stopPropagation();}
  },{signal});
  function dropPosition(event){const [x,y]=canvasPoint(canvas,event);return x>=0&&x<=1&&y>=0&&y<=1?{x,y}:null;}
  canvasText=createImageCanvasText({stage,canvas,parameters,signal,
    context:()=>{
      const layer=editableImageLayer(project),origin=imageSelectionOrigin(project);
      const usable=!!currentDocument(project)&&origin.target!=='mask'&&!space&&!nav&&!bridge.busy()&&
        !pendingImageEdit&&!importing&&!cutting&&!strokeQueue.size&&!selection.isDragging()&&!selection.isTransforming();
      return {layer,origin,active:mode==='text',usable,editable:usable&&layer?.text&&!layer.locked,canInsert:canInsertImage(project),
        color:bridge.foreground(),assets:project.document?.paint.assets??{},fonts:project.document?.paint.textFonts??{},insertion:imageInsertion(project)};
    },
    preview:operation=>live.update(operation),
    save:async(origin,layer,placement,text)=>{
      const result=await bridge.saveImageText(origin,layer,placement,text);
      if(!disposed&&!layer)selectAddedLayer(project,origin,result.layerId);
    },
    onChange:()=>{sync();ctx.onChange();bridge.saveStateChanged();},
    openProperties:(origin,layer)=>bridge.openImageText(origin,layer)
  });
  penTool=createImagePenTool({stage,canvas,parameters,signal,context:()=>{
    const image=currentDocument(project),origin=imageSelectionOrigin(project);
    return {origin,owner:image?[origin.id,origin.documentId]:null,paths:image?.paths??[],
      enabled:!!image&&!pendingImageEdit&&!bridge.busy()&&!space&&!nav&&!canvasText.isEditing()&&!selection.isTransforming()};
  },
    save:(origin,patch)=>commandAt(project,origin,{action:'savePath',patch}),
    remove:(origin,id)=>commandAt(project,origin,{action:'deletePath',patch:{id}}),
    select:selection.fromPath,onError:ctx.error,onChange:()=>{sync();ctx.onChange();}
  });
  edgeTool=createImageEdgeTool({stage,canvas,parameters,signal,settings:state.edgeRefine,context:()=>{
    const layer=editableImageLayer(project),image=currentDocument(project),origin=imageSelectionOrigin(project);
    const usable=!!image&&!bridge.busy()&&!pendingImageEdit&&!space&&!nav&&!strokeQueue.size&&!selection.isTransforming();
    const source=layer&&['image','pixel','shape'].includes(layer.kind)?{layerId:layer.id,origin,region:selection.snapshot()}:null;
    return {usable,source,hasMask:source&&hasImageLayerMask(layer),canSaveMask:source&&!layerLockOwner(image.layers,layer),
      selection:selection.hasSelection(),canUndo:selection.canTravelRefinement('undo'),canRedo:selection.canTravelRefinement('redo')};
  },apply:selection.refineLocal,travel:direction=>selection.travelRefinement(direction),
  loadMask:()=>selection.sampleLayer(currentLayer(project).id,'mask','replace'),
  saveMask:async()=>{
    const layer=currentLayer(project),origin=imageSelectionOrigin(project),region=selection.snapshot();
    const {outline,...coverage}=region;
    const base={op:'image',documentId:origin.documentId,layerId:layer.id};
    const operations=[...(hasImageLayerMask(layer)?[{...base,action:'removeMask'}]:[]),{...base,action:'createMask',reveal:true,...coverage}];
    if(layer.maskLinked===false)operations.push({...base,action:'updateLayer',patch:{maskLinked:false}});
    await project.commands(operations,origin);
  },onError:ctx.error,onChange:()=>{sync();ctx.onChange();}});
  stage.addEventListener('dragover',event=>{const transfer=event.dataTransfer;if(!hasAssetDrag(transfer)&&!transfer?.types.includes('Files'))return;event.preventDefault();transfer.dropEffect=currentDocument(project)&&dropPosition(event)?'copy':'none';},{signal});
  stage.addEventListener('drop',event=>{
    const transfer=event.dataTransfer;if(!hasAssetDrag(transfer)&&!transfer?.types.includes('Files'))return;
    event.preventDefault();event.stopPropagation();const position=dropPosition(event);
    if(!currentDocument(project)){ctx.error(Error('请先新建贴图'));return;}
    if(!position){ctx.error(Error('请将图片放到画布内'));return;}
    if(transfer.types.includes('Files')){
      const files=[...transfer.files],file=files[0];
      if(files.length!==1||!acceptsDrawingImage(file)){ctx.error(Error('每次可拖入一张 PNG、JPEG 或 WebP 图片'));return;}
      importFile(file,position);return;
    }
    const dragged=readAssetDrag(transfer,project.document);if(!dragged){ctx.error(Error('素材所属工程或修订已变化，请重新拖动'));return;}
    const origin=imageSelectionOrigin(project),name=project.document.paint.assets[dragged.id].name;void run(()=>addImageAsset(project,origin,dragged.id,name,position));
  },{signal});
  function travelHistory(direction){
    if(mode==='pen'&&penTool.travel(direction))return true;
    if(mode==='warp'&&warpTool.travel(direction))return true;
    if(mode==='refineEdge'&&selection.travelRefinement(direction)){edgeTool.sync();return true;}
    if(cutting||drawingGesture()||selection.isDragging()||selection.isTransforming()||nav)return false;
    const id=project.document?.id;
    if(!id)return false;
    void strokeQueue.flush().then(saved=>saved&&project.document?.id===id&&project.travel(direction)).catch(ctx.error);
    return true;
  }
  function combineShortcut(event){
    if(!(event.metaKey||event.ctrlKey)||(event.code!=='KeyE'&&event.key.toLowerCase()!=='e')||
       event.altKey!==event.shiftKey)return false;
    const origin=imageSelectionOrigin(project);
    if(!origin.documentId||origin.target==='mask'&&!event.altKey||writing()||selection.isTransforming())return false;
    const ids=project.imageContext.layerIds??(origin.layerId?[origin.layerId]:[]);
    if(!event.altKey&&!ids.length)return false;
    const action=event.altKey?'stampVisible':ids.length>1?'mergeSelected':'mergeDown';
    if(!event.repeat)void run(()=>combineImageLayers(project,origin,action,ids));
    return true;
  }
  function startImageTransform(){
    const image=currentDocument(project),selected=project.imageContext;
    if(!image)return false;
    if(selection.hasSelection())selection.start();
    else if(mode==='move'||selected?.layerIds?.length>1||currentLayer(project)?.kind==='group'||selected?.target==='mask'){
      if(mode!=='move'){selection.stop();setMode('move');}
      moveTool.startTransform();
    }else selection.start();
    return true;
  }
  function holdHand(held){
    space=held;
    stage.toggleAttribute('data-hand-held',held);
    syncToolName();
    painter.refreshUVCursor();
  }
  function handleKey(event){
    if(event.defaultPrevented||compositionKey(event)||event.target.closest('input,textarea,select,.custom-select,[contenteditable]'))return false;
    const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
    if(key==='escape'&&stopAdjustmentPick()){
      event.preventDefault();event.stopPropagation();return true;
    }
    const fromThumbnail=key===' '&&!mod&&!event.altKey&&event.target.closest('.document-layer-select,.document-layer-mask')&&stage.matches(':hover');
    if((key===' '||key==='enter')&&event.target.closest('button,summary')&&!fromThumbnail)return false;
    if(fromThumbnail)stage.focus({preventScroll:true});
    if(canvasText?.isEditing()){
      if(key==='escape'){canvasText.cancel();event.preventDefault();event.stopPropagation();return true;}
      return false;
    }
    if(penTool.key(event)||moveTool.key(event)||warpTool.key(event)){
      event.preventDefault();event.stopPropagation();return true;
    }
    if(selection.isTracing()){
      if(key==='enter')selection.finishTrace();
      else if(key==='backspace'||key==='delete')selection.removeTracePoint();
      else if(key==='escape')selection.cancel();
      else if(key===' '){holdHand(true);}
      event.preventDefault();event.stopPropagation();
      return true;
    }
    if(key==='escape'){
      if(!finishNavigation(true)&&!edgeTool.cancel()&&!painter.cancel({preserveMode:true})&&!gradientTool.cancel()&&!shapeTool.cancel()&&!selection.cancel())selection.clear();
      event.preventDefault();event.stopPropagation();return true;
    }
    if(key===' '&&painter.isDrawing()&&painter.pauseDrawing()){
      holdHand(true);event.preventDefault();event.stopPropagation();return true;
    }
    if(key===' '&&selection.repositionMarquee(true)){
      event.preventDefault();event.stopPropagation();return true;
    }
    if(drawingGesture()||selection.isDragging()||nav){
      event.preventDefault();event.stopPropagation();return true;
    }
    if(combineShortcut(event)){
      event.preventDefault();event.stopPropagation();return true;
    }
    let handled=true;
    if((event.altKey!==mod)&&!event.shiftKey&&(key==='backspace'||key==='delete')){
      const {clip,...shape}=selection.clip()||{clip:documentClip(currentDocument(project))};
      const mask=colorTarget()==='mask',slot=event.altKey?'foreground':'background';
      const color=bridge.colorPair(colorTarget())[slot];
      const op=!selection.isTransforming()&&painter.fillUV(clip,mask?'mask':'material',maskGray(color),shape,{opacity:1,color});
      handled=!!op;
      if(op)void save(op,imageOrigin());
    }else if(mod&&!event.altKey){
      if(key==='c')handled=copySelection(event.shiftKey);
      else if(key==='x'&&!event.shiftKey)handled=cutSelection();
      else if(key==='v'&&event.shiftKey)handled=pasteSelection(true);
      else if(key==='i'&&event.shiftKey)handled=selection.invert();
      else if(key==='i'){
        const layer=editableImageLayer(project);
        handled=project.imageContext?.target==='mask'&&hasImageLayerMask(layer)&&!layer.locked&&
          (!!pendingImageEdit||strokeQueue.saving||!bridge.busy())&&!selection.isTransforming();
        if(handled){
          const origin=imageSelectionOrigin(project),previous=pendingImageEdit,strokes=strokeQueue.flush();
          void run(async()=>{
            if((previous&&!await previous)||!await strokes||disposed)return;
            const current=imageSelectionOrigin(project);
            if(current.id!==origin.id||current.documentId!==origin.documentId||current.layerId!==origin.layerId||current.target!=='mask')return;
            await submitEdit({op:'image',action:'invertMask',documentId:current.documentId,layerId:current.layerId},current);
          });
        }
      }
      else if(key==='z')travelHistory(event.shiftKey?'redo':'undo');
      else if(key==='a')selection.selectAll(selectionShape);
      else if(key==='d'&&event.shiftKey)handled=selection.reselect();
      else if(key==='d')selection.clear();
      else if(key==='t')handled=startImageTransform();
      else if(event.code==='Digit0'&&event.shiftKey)handled=fitSelection();
      else if(key==='0')fitCanvas.click();
      else if(key==='1')actualSize.click();
      else if(['=','+','-'].includes(key)){
        const before=zoom;zoom=clampZoom(zoom*(key==='-'?.8:1.25));
        pan=pan.map(value=>value*zoom/before);layout();
      }else handled=false;
    }else if(mod&&event.altKey&&(event.code==='KeyG'||key==='g')&&!event.shiftKey){
      const image=currentDocument(project),layer=currentLayer(project),index=image?.layers.indexOf(layer);
      handled=!!layer&&!layerLockOwner(image.layers,layer)&&!writing()&&!selection.isTransforming()&&!!imageClippingBase(image.layers,index);
      if(handled){
        const origin=imageSelectionOrigin(project);
        void run(()=>commandAt(project,origin,{action:'setClipping',layerId:layer.id,clipped:!layer.clipped}));
      }
    }else if(event.altKey)handled=false;
    else if(key===' '){holdHand(true);}
    else if(key==='m'){
      const elliptical=selectionShape==='ellipse';
      const tool=event.shiftKey!==elliptical?'uv-ellipse-tool':'uv-select-tool';
      elements[tool].click();
    }
    else if(key==='l')elements[(lassoShape==='polygon')!==event.shiftKey?'uv-polygon-tool':'uv-lasso-tool'].click();
    else if(key==='v'){moveButton.click();}
    else if(key==='t')textTool.click();
    else if(key==='p')penButton.click();
    else if(key==='u'&&!shapeButton.disabled){shapeButton.click();if(event.shiftKey)shapeTool.cycle();}
    else if(key==='g'){
      const next=(fillGroup==='bucket')!==event.shiftKey?bucketButton:gradientButton;
      const fallback=next===bucketButton?gradientButton:bucketButton;
      handled=!next.disabled||!fallback.disabled;
      if(handled)(next.disabled?fallback:next).click();
    }
    else if(key==='enter'&&selection.isTransforming())void selection.apply();
    else if(key==='b')elements['surface-paint'].click();
    else if(key==='e')elements['uv-eraser-tool'].click();
    else if(key==='s'&&!cloneButton.disabled)cloneButton.click();
    else if(key==='j'&&!spotButton.disabled)(event.shiftKey?healButton:spotButton).click();
    else if(key==='w')elements[event.shiftKey?'uv-color-range-tool':'uv-wand-tool'].click();
    else if(key==='h')elements['surface-orbit'].click();
    else if(key==='r')rotateView.click();
    else if(key==='i')elements['surface-sample'].click();
    else if(key==='x'||key==='d')colorKey(key);
    else if(key==='['||key===']')painter.adjustRadius(key==='['?-1:1,true);
    else if(key==='delete'||key==='backspace')handled=selection.erase();
    else{
      const arrows={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]};
      handled=!!arrows[key]&&selection.nudge(...arrows[key],event.shiftKey?10:1);
    }
    if(handled){event.preventDefault();event.stopPropagation();}
    return handled;
  }
  host.addEventListener('keydown',handleKey,{signal});
  host.addEventListener('keyup',event=>{
    if(event.key!==' ')return;
    if(selection.repositionMarquee(false)){event.preventDefault();event.stopPropagation();return;}
    strokePan=null;holdHand(false);
  },{signal});window.addEventListener('blur',()=>{strokePan=null;holdHand(false);finishNavigation(true);edgeTool.cancel();penTool.cancelDrag();gradientTool.cancel();shapeTool.cancel();moveTool.cancel();warpTool.cancel();painter.cancel({preserveMode:true});selection.cancel();},{signal});
  stage.addEventListener('dblclick',event=>{
    if(mode!=='move'||(event.target!==canvas&&event.target!==stage)||writing()||!currentDocument(project)?.layers.some(l=>l.embedded))return;
    const bounds=canvas.getBoundingClientRect();
    if(event.clientX<bounds.left||event.clientX>=bounds.right||event.clientY<bounds.top||event.clientY>=bounds.bottom)return;
    const origin=imageSelectionOrigin(project),point=canvasPoint(canvas,event);
    if(point.some(value=>value<0||value>1))return;
    void run(async()=>{
      const response=await fetch('/api/projects/'+origin.id+'/paint/image-layout-probe',{method:'POST',signal,
        headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:origin.revision,documentId:origin.documentId,point,layerIds:[],resolution:512})});
      if(response.status===204||disposed)return;
      const result=await response.json();
      if(!response.ok)throw Error(result.error);
      if(project.document?.id===origin.id&&project.document.revision===origin.revision&&project.imageContext?.documentId===origin.documentId)
        openEmbeddedSource(project,currentDocument(project).layers.find(l=>l.id===result.hit));
    });
  },{signal});
  const resize=new ResizeObserver(layout);resize.observe(stage);resize.observe(parameters);
  function sync(reselect=false){
    if(disposed||!shown||!project.document)return;const doc=project.document;
    brushBinding.sync(reselect);
    syncBrushImages();
    if(restoredProject!==doc.id){
      restoredProject=doc.id;
      let saved;
      try{saved=JSON.parse(localStorage.getItem('arachne-image-selection:'+doc.id));}catch{}
      const draft=journal.read(doc.id);
      if(strokeQueue.restore(doc.id,draft)){
        const [,documentId,layerId,target]=draft.target;
        if(doc.paint.imageDocuments?.[documentId]?.layers.some(item=>item.id===layerId))saved={documentId,layerId,target};
        queueMicrotask(()=>{if(!disposed)syncStrokeSave();});
      }
      if(saved?.documentId&&(!project.imageContext||strokeQueue.failure))project.selectImage(saved);
    }
    let image=currentDocument(project);if(!image){const documentId=Object.keys(doc.paint.imageDocuments??{})[0]||null;if(project.imageContext?.documentId!==documentId){project.selectImage({documentId,layerId:null,target:'pixels'});return;}image=currentDocument(project);}
    const c=project.imageContext,layer=currentLayer(project);
    if(image&&image.layers.length&&!layer){
      selectImage(project,{layerId:image.layers.at(-1).id,target:'pixels'});return;
    }
    if(c?.target==='mask'&&!hasImageLayerMask(layer)){
      selectImage(project,{target:'pixels'});return;
    }
    const imageKey=JSON.stringify([doc.id,c?.documentId,c?.layerId,c?.target]);if(lastImage!==imageKey){
      const first=lastProject!==doc.id,targetChanged=!first&&lastTarget!==c?.target;
      let next=mode;if(c?.target==='mask'&&!['gradient','move'].includes(mode)&&(mode==='paint'||targetChanged||first&&!state.tool))next='mask';else if(c?.target!=='mask'&&mode==='mask')next='paint';
      clearClipboardNotice();lastImage=imageKey;lastTarget=c?.target;lastProject=doc.id;gradientTool.cancel();shapeTool.cancel();painter.cancel({preserveMode:true});selection.stop();setMode(next);if(next==='select')selection.choose(selectionShape,{focus:false});if(imageView.isActive())remember(project);
    }
    const documents=Object.entries(doc.paint.imageDocuments??{}),optionsKey=JSON.stringify([doc.id,documents.map(([id,d])=>[id,d.name])]);if(pickerOptionsKey!==optionsKey){pickerOptionsKey=optionsKey;picker.replaceChildren(new Option('选择图像文档',''),...documents.map(([id,d])=>new Option(d.name,id)));}
    const next=JSON.stringify([doc.id,doc.revision]);if(sourceKey!==next){sourceKey=next;syncDestination();}else if(destinationDocument!==c?.documentId)syncDestination();
    picker.value=c?.documentId||'';syncSelectMenu(picker);
    backToParent.hidden=!c?.sourceTrail?.length;
    backToParent.disabled=writing();backToParent.title='返回 '+(doc.paint.imageDocuments?.[c?.sourceTrail?.at(-1)?.documentId]?.name??'原稿');
    dimensions.disabled=!image||writing();syncSelectMenu(dimensions);
    syncBind();textTool.disabled=!image||writing()||c?.target==='mask'||(!canInsertImage(project)&&!(layer?.text&&!layerLockOwner(image.layers,layer)));
    const locked=layer&&layerLockOwner(image.layers,layer);
    gradientButton.disabled=!image||writing()||(c?.target==='mask'||layer?.kind==='gradient'?!!locked:!canInsertImage(project));
    bucketButton.disabled=cloneButton.disabled=healButton.disabled=spotButton.disabled=!canPaintPixels();
    cloneButton.title=cloneButton.disabled?'请选择可编辑的像素层，或新建像素层后仿制':'仿制图章 · S · Alt / Option 单击取样';
    for(const control of [healButton,spotButton])if(control.disabled)control.title='请选择可编辑的像素层，或新建像素层后修补';
    else control.title=control.getAttribute('aria-label')+(control===healButton?' · Shift + J · Alt / Option 单击取样':' · J');shapeButton.disabled=!canCreateShape();
    penButton.disabled=!image||!!pendingImageEdit||bridge.busy();
    if(adjustmentPick&&!currentAdjustmentPick(adjustmentPick))stopAdjustmentPick();
    bucketTool.sync();cloneTool.refresh();shapeTool.sync();moveTool.layout();warpTool.layout();canvasText.layout();penTool.layout();edgeTool.sync();empty.hidden=!!image;canvas.hidden=!image;
    if(!image){live.clear();previewCaption='';status.textContent='';delete stage.dataset.previewSize;delete stage.dataset.previewRevision;}
    ctx.title.textContent=image?image.name+' · RGBA':'';syncToolName();painter.render();selection.sync();renderSelectionLibrary();syncColors();syncClipboard();syncStrokePreview();live.refresh();uvGuide.sync();
  }
  const unsub=project.subscribe(event=>sync(event.kind==='resource'));sync();if(mode==='select')selection.choose(selectionShape,{focus:false});else setMode(mode);
  return {kind:'image',sync,handleKey,travelHistory,getBrushSettings:()=>painter.getSettings(),preferencesChanged:()=>live.preferencesChanged(),activate(){imageView.activate();project.setEditorDomain('image');},getState:()=>({zoom,pan,angle,mirror,uvGuide:uvGuide.enabled,tool:mode,edgeRefine:edgeTool.getState(),selectionTool:selectionShape,lassoShape,selectionMode:selection.getCombination(),selectionFeather:selection.getFeather(),wand:readWand(),colorRange:readRange(),selectionRefineRadius:refineRadius.valueAsNumber,gradient:gradientTool.getState(),bucket:bucketTool.getState(),clone:cloneTool.getState(),shape:shapeTool.getState(),move:moveTool.getState(),fillGroup,eraser:elements['brush-erase'].checked,channel:channel.value,imageSelections:imageView.getState()}),isEditing:()=>!!pendingImageEdit||importing||cutting||strokeQueue.size>0||drawingGesture()||selection.isDragging()||selection.isTransforming(),
    strokeSaveStatus:()=>({pending:strokeQueue.size,saving:strokeQueue.saving,failure:strokeQueue.failure}),retryStrokeSave,
    editCommand,canCopyMerged:()=>canCopy(true),copyMerged:()=>copySelection(true),
    canCut,cutSelection,pasteSystemImage,canPasteInPlace:()=>canPaste()&&canInsertImage(project)&&!!copiedImage(),pasteInPlace:()=>pasteSelection(true),
    getSelection(origin){return shown&&project.document?.id===origin.id&&project.imageContext?.documentId===origin.documentId&&
      !selection.isDragging()&&!selection.isTransforming()?selection.clip():null;},
    sampleLayerSelection(origin,layerId,source,operation){
      if(!shown||project.document?.id!==origin.id||project.imageContext?.documentId!==origin.documentId||writing())return false;
      imageView.activate();
      if(mode!=='select'&&!selection.choose(selectionShape,{focus:false}))return false;
      return selection.sampleLayer(layerId,source,operation);
    },
    pickAdjustmentColor(origin,apply){
      if(!shown||project.document?.id!==origin.id||project.imageContext?.documentId!==origin.documentId||
         writing()||drawingGesture()||selection.isDragging()||selection.isTransforming())return false;
      imageView.activate();
      if(project.imageContext?.layerId!==origin.layerId||project.imageContext?.target==='mask')
        selectImage(project,{layerId:origin.layerId,target:'pixels'});
      stopAdjustmentPick();
      adjustmentPick={origin,apply,controller:new AbortController(),sampling:false};
      stage.setAttribute('data-adjustment-pick','');
      stage.focus({preventScroll:true});
      showSampleNotice('在画布点击取色 · Esc 取消');
      return true;
    },
    previewAdjustment(origin,operation){
      if(shown&&project.document?.id===origin.id&&project.imageContext?.documentId===origin.documentId&&
         (!operation||project.document.revision===origin.revision)&&!drawingGesture())
        live.update(operation);
    },
    setVisible(visible){
      if(shown===visible)return;
      shown=visible;live.setVisible(visible);
      uvGuide.sync();
      if(!visible){stopAdjustmentPick();edgeTool.cancel();penTool.cancelDrag();canvasText.cancel();gradientTool.cancel();shapeTool.cancel();moveTool.cancel();warpTool.cancel();}
      if(visible)sync();
    },
    dispose(){disposed=true;clearClipboardNotice();stopAdjustmentPick();exportRequest?.abort();unsub();stopClipboard();gradientTool.cancel();cloneTool.dispose();shapeTool.cancel();moveTool.dispose();warpTool.cancel();imageView.dispose();life.abort();painter.dispose();selection.dispose();live.dispose();uvGuide.dispose();resize.disconnect();stripResize.disconnect();},setPaintMode(next){setMode(next);}};
}

export function createImagePanel(type,ctx){
  ctx.root.dataset.layerDomain='image';
  const {host,project}=ctx,tools=el('div','editor-toolbar'),body=el('div','document-panel editor-scroll'),error=el('output','editor-message');host.append(body,error);headerControls(ctx,tools);
  const run=fn=>Promise.resolve().then(fn).catch(e=>{error.textContent=e.message;ctx.error(e);});
  let adjustmentEditing=null,curveEditor=null,curveChannel=ctx.state?.curveChannel,curveSelection=null;
  const adjustmentBankTargets=new Map(),blendIfOpen=new Map();
  function clearAdjustment(owner){
    if(adjustmentEditing?.owner!==owner)return;
    const {origin}=adjustmentEditing;adjustmentEditing=null;
    ctx.imageAdjustment?.(owner,origin,null);
  }
  function addControl(parent,label,type,value,change,extra={},preview){
    const row=el('label','document-property',label),input=el('input');
    Object.assign(input,{type,value,...extra});
    if(type==='checkbox')input.checked=value;
    if(type==='number'){input.dataset.scrubNumber='';input.dataset.scrubSpeed='.01';}
    input.setAttribute('aria-label',label);
    let origin=null,cancelled=false;
    const read=()=>type==='checkbox'?input.checked:type==='number'?input.valueAsNumber:input.value;
    const cancel=()=>{
      preview?.(null,origin);
      origin=null;
      delete input.dataset.documentDirty;
    };
    input.oninput=()=>{
      origin??=imageSelectionOrigin(project);
      input.dataset.documentDirty='';
      if(input.validity.valid)preview?.(read(),origin);
    };
    if(type==='number')input.addEventListener('workspace-range-cancel',()=>{cancel();sync();});
    input.onchange=()=>{
      if(cancelled){cancel();key='';sync();return;}
      const next=read(),expected=origin||imageSelectionOrigin(project);
      delete input.dataset.documentDirty;
      void run(()=>{
        const current=imageSelectionOrigin(project);
        if(current.id!==expected.id||current.revision!==expected.revision||current.documentId!==expected.documentId||
           current.layerId!==expected.layerId||current.target!==expected.target)
          throw Error('编辑目标或工程修订已变化，请重新输入');
        if(!input.validity.valid)throw Error('请输入有效的参数');
        return change(next);
      }).finally(()=>{cancel();key='';sync();});
    };
    input.onblur=()=>{if(input.hasAttribute('data-document-dirty')){cancel();key='';sync();}};
    input.onkeydown=event=>{
      if(compositionKey(event))return;
      if(event.key==='Enter'){event.preventDefault();input.blur();}
      else if(event.key==='Escape'){
        event.preventDefault();cancelled=true;
        if(type==='checkbox')input.checked=!!value;else input.value=String(value);
        cancel();input.blur();key='';sync();
      }
    };
    row.append(input);parent.append(row);return input;
  }
  const picker=choice('图像图层文档',[],'',value=>selectImage(project,{documentId:value||null,layerId:null,target:'pixels'}));tools.append(picker);enhanceSelectMenu(picker);
  const filters=el('div','document-layer-filter'),search=el('input','editor-search-field'),filterCount=el('output','document-filter-count');
  const kinds=[['all','全部类型'],['group','图层组'],['pixel','像素层'],['image','图像层'],['gradient','渐变填充'],['adjustment','调整图层'],['shape','形状层'],['text','文字层'],['mask','带蒙版']];
  const kind=choice('筛选图层类型',kinds,kinds.some(([value])=>value===ctx.state?.layerKind)?ctx.state.layerKind:'all',filterChanged);
  let filterOpen=ctx.state?.layerFilterOpen===true;
  search.type='search';search.placeholder='搜索图层';search.setAttribute('aria-label','搜索图像图层');search.value=typeof ctx.state?.layerQuery==='string'?ctx.state.layerQuery:'';search.oninput=filterChanged;
  function resetFilter(){search.value='';kind.value='all';syncSelectMenu(kind);}
  function filterChanged(){sync();ctx.onChange?.();}
  const toggle=type==='layers'?button('',()=>{filterOpen=!filterOpen;if(!filterOpen)resetFilter();filterChanged();if(filterOpen)search.focus();},'筛选图像图层'):null;
  if(toggle){chromeButton(toggle,'search','筛选图像图层');tools.append(toggle);filters.append(search,kind,filterCount);host.insertBefore(filters,body);enhanceSelectMenu(kind);}
  search.onkeydown=event=>{if(event.key==='Escape'&&!compositionKey(event)){event.preventDefault();event.stopPropagation();filterOpen=false;resetFilter();filterChanged();toggle?.focus();}};
  const rowsHost=el('div'),message=el('p','document-muted');
  const actions=el('div','document-layer-actions'),primaryActions=el('div','document-layer-primary-actions');
  const feedback=type==='layers'?el('output','document-layer-feedback'):null;
  const dropNote=type==='layers'?el('output','document-layer-drop-note'):null;
  let feedbackTimer=null,completedAction='';
  let footerStack=[];
  const stackButtons=type==='layers'?[['上移','moveUp'],['下移','moveDown'],['复制','copy'],['删除','trash']].map(([label,icon],index)=>
    chromeButton(button(label,()=>{
      const action=footerStack[index];
      if(action?.enabled)void run(action.run);
    }),icon)):[];
  const addMask=type==='layers'?chromeButton(button('添加蒙版',event=>
    selectLayerMask(currentLayer(project),undefined,{reveal:!event.altKey})),'mask'):null;
  if(addMask)addMask.title='添加蒙版 · 显示选区 · Alt / Option 隐藏选区';
  const add=type==='layers'?chromeButton(button('新建像素层',()=>{
    const origin=imageSelectionOrigin(project);
    resetFilter();filterChanged();void run(()=>addPixel(project,origin));
  }),'plus'):null;
  const addGroup=type==='layers'?chromeButton(button('新建图层组',event=>createGroup(event.shiftKey)),'folder'):null;
  if(addGroup)addGroup.title='新建图层组 · Shift 点击将所选图层成组';
  const adjustmentsMenu=type==='layers'?createContextActions('调整图层类型',failure=>ctx.error(failure)):null;
  const addAdjustment=type==='layers'?chromeButton(button('新建调整图层',openAdjustments),'adjustment'):null;
  addAdjustment?.setAttribute('aria-haspopup','menu');
  if(addAdjustment)addAdjustment.title='新建调整或滤镜图层';
  if(add){
    actions.setAttribute('role','group');
    actions.setAttribute('aria-label','图层操作');
    primaryActions.append(addMask,addAdjustment,addGroup,add,stackButtons[3]);
    actions.append(...stackButtons.slice(0,3),primaryActions);
    error.classList.add('document-layer-error');
    feedback.setAttribute('role','status');dropNote.setAttribute('role','status');
    dropNote.hidden=true;host.append(dropNote,feedback,actions);
  }
  const rows=new Map();
  const menu=type==='layers'?createContextActions('图像图层操作',failure=>ctx.error(failure)):null;
  // Keep one row of previews ahead of the scroll position. Image thumbnails share
  // the worker that renders the active canvas, so offscreen rows must not queue work.
  const thumbnailObserver=type==='layers'&&typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
    for(const entry of entries){
      const view=rows.get(entry.target.dataset.imageLayerId);
      if(!view||view.row!==entry.target)continue;
      view.nearViewport=entry.isIntersecting;
      if(view.nearViewport)refreshPreviews(view);
      else stopPreviews(view);
    }
  },{root:body,rootMargin:'38px 0px'}):null;
  let menuTarget=null,reorder=null,dropRow=null;
  let stackDocument='',renaming=null,bar=null,disposed=false;
  let selectedRows=new Set(),selectionAnchor=null,selectionContext='',renderedRows=[];
  const collapsedGroups=new Set((Array.isArray(ctx.state?.collapsedImageGroups)?ctx.state.collapsedImageGroups:[])
    .filter(value=>typeof value==='string').slice(-256));
  const selectionKey=(origin,layerId=origin.layerId,target=origin.target)=>JSON.stringify([origin.id,origin.documentId,layerId,target]);
  function setRowSelection(ids,active,anchor=active){
    const origin=imageSelectionOrigin(project);
    selectedRows=new Set(ids);selectionAnchor=anchor;
    selectionContext=selectionKey(origin,active,'pixels');
    selectImage(project,{layerId:active,layerIds:[...ids],target:'pixels'});
    sync();
  }
  function updateBatchFeedback(){
    if(!feedback)return;
    const visible=new Set(renderedRows.map(row=>row.layer.id)),hidden=[...selectedRows].filter(id=>!visible.has(id)).length;
    feedback.textContent=completedAction||(selectedRows.size>1||hidden?
      selectedRows.size+' 个图层已选'+(hidden?' · '+hidden+' 个未在列表中显示':''):'');
    feedback.hidden=!feedback.textContent;
  }
  function noteBatch(text){
    completedAction=text;clearTimeout(feedbackTimer);updateBatchFeedback();
    feedbackTimer=setTimeout(()=>{completedAction='';updateBatchFeedback();},3500);
  }
  function selectRow(item,event){
    if(event.shiftKey&&selectionAnchor){
      const from=renderedRows.findIndex(row=>row.layer.id===selectionAnchor),to=renderedRows.findIndex(row=>row.layer===item);
      if(from>=0&&to>=0){
        setRowSelection(renderedRows.slice(Math.min(from,to),Math.max(from,to)+1).map(row=>row.layer.id),item.id,selectionAnchor);
        return;
      }
    }
    if(event.ctrlKey||event.metaKey){
      const next=new Set(selectedRows),active=project.imageContext?.layerId;
      if(next.has(item.id)&&next.size>1){
        next.delete(item.id);
        setRowSelection(next,active===item.id?[...next].at(-1):active);
        return;
      }
      next.add(item.id);setRowSelection(next,item.id);return;
    }
    setRowSelection([item.id],item.id);
  }
  function changeGroup(id,open){
    if(open)collapsedGroups.delete(id);
    else collapsedGroups.add(id);
    sync();ctx.onChange?.();
  }
  function createGroup(fromSelection){
    const image=currentDocument(project);
    if(!image||ctx.busy?.()||image.layers.length>=imageLayerLimit)return;
    const origin=imageSelectionOrigin(project),layerId=crypto.randomUUID();
    const op=fromSelection?{action:'groupLayers',layerIds:[...selectedRows]}:
      {action:'addLayer',kind:'group',...imageLayerInsertion(image.layers,origin.layerId)};
    return run(async()=>{
      resetFilter();
      sync();
      await commandAt(project,origin,{...op,layerId});
      if(!disposed)selectAddedLayer(project,origin,layerId);
    });
  }
  const groupDialog=type==='layers'?el('dialog','paint-form-dialog'):null;
  let groupAction;
  if(groupDialog){
    groupDialog.setAttribute('aria-label','确认图层组操作');
    const form=el('form'),header=el('header'),title=el('h2'),content=el('div','paint-form-content');
    const message=el('p','project-copy-source'),footer=el('footer','paint-form-footer');
    const cancel=button('取消',()=>groupDialog.close()),confirm=el('button','primary');
    confirm.type='submit';
    header.append(title);content.append(message);footer.append(cancel,confirm);
    form.append(header,content,footer);groupDialog.append(form);host.append(groupDialog);
    groupDialog.addEventListener('close',()=>{groupAction=null;});
    form.onsubmit=event=>{
      event.preventDefault();
      const action=groupAction;
      groupDialog.close();
      if(action)void run(action);
    };
    groupDialog.setAction=(label,description,action)=>{
      groupAction=action;
      title.textContent=confirm.textContent=label;
      message.textContent=description;
      groupDialog.showModal();cancel.focus();
    };
  }
  function ungroup(item,origin=imageSelectionOrigin(project)){
    const action=()=>commandAt(project,origin,{action:'ungroupLayer',layerId:item.id});
    if(hasImageLayerMask(item)||item.blend!==imageGroupBlend||item.opacity!==1||!item.visible)
      groupDialog.setAction('解散图层组','子图层将保留，组蒙版和组级显示、混合设置会移除。',action);
    else return run(action);
  }
  if(type==='layers')host.addEventListener('keydown',event=>{
    if(event.defaultPrevented||compositionKey(event)||event.altKey||
       event.target.closest('input,select,textarea,[contenteditable],dialog[open]'))return;
    const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
    if(mod&&!event.shiftKey&&key==='a'&&selectAllRows()){
      event.preventDefault();event.stopPropagation();return;
    }
    const slot=!event.shiftKey&&(mod?{']':0,'[':1,j:2}[key]:['delete','backspace'].includes(key)?3:undefined);
    if(slot!==false&&slot!==undefined){
      const action=footerStack[slot];
      if(!action)return;
      event.preventDefault();event.stopPropagation();
      if(action.enabled)void run(action.run);
      else if(action.reason)noteBatch(action.reason);
      return;
    }
    if(!mod||key!=='g')return;
    const item=currentLayer(project);
    if(!item||event.shiftKey&&item.kind!=='group')return;
    event.preventDefault();event.stopPropagation();
    if(event.shiftKey)void ungroup(item);
    else void createGroup(true);
  });
  function selectAllRows(){
    if(type!=='layers'||ctx.busy?.()||!renderedRows.length)return false;
    const ids=renderedRows.map(row=>row.layer.id),active=project.imageContext?.layerId;
    setRowSelection(ids,ids.includes(active)?active:ids[0]);
    return true;
  }
  function openAdjustments(){
    const image=currentDocument(project);
    if(!image||ctx.busy?.())return;
    const origin=imageSelectionOrigin(project),selection=ctx.imageSelection?.(origin);
    const rect=addAdjustment.getBoundingClientRect();
    adjustmentsMenu.open({clientX:rect.left,clientY:rect.bottom},'调整与滤镜',
      Object.entries(imageAdjustments).map(([type,{label}])=>({label,icon:'adjustment',run:()=>{
        const layerId=crypto.randomUUID();
        const operations=[{op:'image',action:'addLayer',documentId:origin.documentId,layerId,kind:'adjustment',
          ...imageLayerInsertion(image.layers,origin.layerId),patch:{name:label,adjustment:newImageAdjustment(type),maskEnabled:!selection}}];
        if(selection)operations.push({op:'image',action:'createMask',documentId:origin.documentId,layerId,reveal:true,
          rect:selection.clip,...uvShapePayload(selection)});
        return run(async()=>{
          resetFilter();filterChanged();
          await project.commands(operations,origin);
          if(!disposed)selectAddedLayer(project,origin,layerId);
        });
      }})));
  }
  function stopPreviews(view){
    pauseImageThumbnail(view.preview);
    pauseImageThumbnail(view.maskPreview);
    view.previewRevision=undefined;
  }
  function refreshPreviews(view){
    const {item,previewContext,preview,maskPreview,nearViewport,row}=view;
    if(!nearViewport||row.hidden||!previewContext)return;
    const {revision,colorSpace}=previewContext;
    if(view.previewItem===item&&view.previewRevision===revision&&view.previewColorSpace===colorSpace)return;
    if(!item.text&&!['adjustment','group'].includes(item.kind))updateImageThumbnail(preview,previewContext,item);
    if(hasImageLayerMask(item))updateImageThumbnail(maskPreview,previewContext,item,true);
    view.previewItem=item;
    view.previewRevision=revision;
    view.previewColorSpace=colorSpace;
  }
  function finishRename({commit,focus=false}){
    const edit=renaming;
    if(!edit)return;
    renaming=null;
    const {input,view,origin,original}=edit,name=input.value;
    input.remove();
    view.name.hidden=false;
    if(focus)view.select.focus({preventScroll:true});
    if(commit&&name!==original&&project.document?.id===origin.id){
      void run(()=>commandAt(project,origin,{action:'updateLayer',layerId:view.item.id,patch:{name}})).finally(sync);
    }else queueMicrotask(sync);
  }
  function startRename(view){
    finishRename({commit:true});
    if(!view.row.isConnected||view.row.hidden||view.lockOwner||ctx.busy?.())return;
    const input=el('input','document-layer-rename'),original=view.item.name;
    renaming={input,view,original,origin:imageSelectionOrigin(project)};
    input.value=original;
    input.setAttribute('aria-label','图像图层名称');
    input.oninput=()=>{input.dataset.documentDirty='';};
    input.onblur=()=>finishRename({commit:true});
    input.onkeydown=event=>{
      if(!['Enter','Escape'].includes(event.key)||compositionKey(event))return;
      event.preventDefault();
      event.stopPropagation();
      finishRename({commit:event.key==='Enter',focus:true});
    };
    view.name.after(input);
    view.name.hidden=true;
    input.focus();
    input.select();
  }
  function clearDrag(){
    if(reorder)delete reorder.row.dataset.dragging;
    reorder=null;
    if(dropRow)delete dropRow.dataset.dropEdge;
    dropRow=null;
    if(dropNote){dropNote.hidden=true;dropNote.textContent='';}
  }
  function reportDrop(target){
    if(!dropNote||reorder?.kind!=='layer')return;
    const {count}=reorder,description=target?.note;
    dropNote.textContent='移动 '+count+' 项'+(description?' · '+description:'');
    dropNote.toggleAttribute('data-blocked',!!target?.blocked);
    dropNote.hidden=false;
  }
  function reorderTarget(event,view){
    if(!reorder||!event.dataTransfer.types.includes(imageDragTypes[reorder.kind])||view.row.hidden)return null;
    const {origin,layerId,kind}=reorder,document=project.document,image=currentDocument(project);
    if(ctx.busy?.()||origin.id!==document?.id||origin.revision!==document.revision||
       origin.documentId!==project.imageContext?.documentId||layerId===view.item.id||!image)return null;
    const from=image.layers.findIndex(item=>item.id===layerId),to=image.layers.findIndex(item=>item.id===view.item.id);
    if(from<0||to<0)return null;
    const source=image.layers[from],sourceLock=layerLockOwner(image.layers,source),targetLock=layerLockOwner(image.layers,view.item);
    if(kind==='mask'){
      const copy=event.altKey||!!sourceLock;
      if(targetLock||!hasImageLayerMask(source))return null;
      return {edge:'mask',copy};
    }
    const rect=view.row.getBoundingClientRect(),fraction=(event.clientY-rect.top)/rect.height;
    const edge=view.item.kind==='group'&&fraction>=.24&&fraction<=.76?'inside':fraction<.5?'above':'below';
    try{
      const plan=planImageLayerMove(image.layers,reorder.ids,{anchorId:view.item.id,placement:edge});
      if(!plan.changed)return {blocked:true,note:'图层位置未改变'};
      const group=image.layers.find(item=>item.id===plan.parentId);
      const note=edge==='inside'?'放入「'+view.item.name+'」':
        (group?'「'+group.name+'」内：':'根图层：')+'置于「'+view.item.name+(edge==='above'?'」上方':'」下方');
      return {edge,note};
    }catch(error){return {blocked:true,note:error.message};}
  }
  function bindReorder(view){
    const {row,select,name,mask}=view;
    const startDrag=(event,kind)=>{
      if((kind==='layer'&&view.lockOwner)||(kind==='mask'&&!hasImageLayerMask(view.item))||ctx.busy?.()||renaming){
        event.preventDefault();return;
      }
      clearDrag();
      menu.close();
      let ids,count;
      if(kind==='layer'){
        if(!selectedRows.has(view.item.id))setRowSelection([view.item.id],view.item.id);
        ids=[...selectedRows];
        try{
          const layers=currentDocument(project).layers,batch=imageBatchSelection(layers,ids);
          if(batch.affected.some(layer=>layerLockOwner(layers,layer)))throw Error('所选图层或组内图层已锁定');
          count=batch.affected.length;
        }catch(error){event.preventDefault();noteBatch(error.message);return;}
      }
      reorder={origin:imageSelectionOrigin(project),layerId:view.item.id,row,kind,ids,count};
      row.dataset.dragging='';
      event.dataTransfer.setData(imageDragTypes[kind],view.item.id);
      event.dataTransfer.effectAllowed=kind==='layer'?'move':view.lockOwner?'copy':'copyMove';
      reportDrop();
    };
    for(const [source,kind] of [[select,'layer'],[name,'layer'],[mask,'mask']]){
      source.ondragstart=event=>startDrag(event,kind);
      source.ondragend=clearDrag;
    }
    row.ondragenter=row.ondragover=event=>{
      const target=reorderTarget(event,view);
      if(dropRow&&(!target||target.blocked||dropRow!==row)){
        delete dropRow.dataset.dropEdge;
        dropRow=null;
      }
      reportDrop(target);
      if(!target||target.blocked){if(reorder)event.dataTransfer.dropEffect='none';return;}
      event.preventDefault();
      event.dataTransfer.dropEffect=target.copy?'copy':'move';
      if(row.dataset.dropEdge!==target.edge)row.dataset.dropEdge=target.edge;
      dropRow=row;
    };
    row.ondragleave=event=>{
      if(dropRow!==row||row.contains(event.relatedTarget))return;
      delete row.dataset.dropEdge;
      dropRow=null;
      reportDrop();
    };
    row.ondrop=event=>{
      const target=reorderTarget(event,view);
      if(!target||target.blocked)return;
      event.preventDefault();
      const {origin,layerId,kind,ids,count}=reorder,targetLayerId=view.item.id;
      clearDrag();
      if(kind==='layer'){
        void run(()=>moveLayerSelection(origin,ids,{anchorId:targetLayerId,placement:target.edge},count));
        return;
      }
      void run(async()=>{
        await commandAt(project,origin,{action:'transferMask',layerId:targetLayerId,sourceLayerId:layerId,copy:target.copy});
        const current=project.imageContext;
        if(project.document?.id===origin.id&&current?.documentId===origin.documentId&&current?.layerId===origin.layerId)
          selectImage(project,{layerId:targetLayerId,target:'mask'});
      });
    };
  }
  async function moveLayerSelection(origin,ids,target,count){
    await commandAt(project,origin,{action:'moveLayers',layerIds:ids,...target});
    if(disposed||project.document?.id!==origin.id||project.imageContext?.documentId!==origin.documentId)return;
    if(target.placement==='inside')changeGroup(target.anchorId,true);
    noteBatch('已移动 '+count+' 项');
  }
  function layerMoveMenu(layers,origin,position){
    const ids=[...selectedRows],batch=imageBatchSelection(layers,ids),count=batch.affected.length;
    const byId=new Map(layers.map(layer=>[layer.id,layer]));
    function folderPath(item){
      const parts=[item.name];
      for(let parent=byId.get(layerParent(item));parent;parent=byId.get(layerParent(parent)))parts.unshift(parent.name);
      return parts.join(' / ');
    }
    const destinations=[];
    function add(label,target){
      try{
        if(!planImageLayerMove(layers,ids,target).changed)return;
        destinations.push({label,icon:'folder',title:label,run:()=>run(()=>moveLayerSelection(origin,ids,target,count))});
      }catch{/* Locked groups, self destinations and broken clip relationships are not available. */}
    }
    const top=layerChildren(layers,null).filter(layer=>!batch.removed.has(layer.id)).at(-1);
    if(top)add('顶层',{anchorId:top.id,placement:'above'});
    for(const layer of batch.ordered)if(layer.kind==='group')add(folderPath(layer),{anchorId:layer.id,placement:'inside'});
    return {label:'移动到…',icon:'folder',enabled:destinations.length>0,
      run:()=>menu.open(position,'移动 '+count+' 项到',destinations)};
  }
  function stackActions(item,layers,origin,editable){
    if(!item)return [];
    const ids=selectedRows.has(item.id)?[...selectedRows]:[item.id];
    const batch=imageBatchSelection(layers,ids),count=batch.affected.length,multi=ids.length>1;
    const actionName=label=>multi?label+' '+count+' 项':label;
    const sameImage=()=>!disposed&&project.document?.id===origin.id&&project.imageContext?.documentId===origin.documentId;
    const apply=(action,patch)=>commandAt(project,origin,{action,layerIds:ids,...patch});
    const guarded=(label,icon,shortcut,plan,execute)=>{
      let result,reason;
      if(editable)try{result=plan();}catch(error){reason=error.message;}
      if(editable&&!result&&!reason)reason='没有可用的移动位置；也可拖动到其他图层组';
      return {label:actionName(label),icon,shortcut,enabled:!!result,reason,run:()=>execute(result)};
    };
    const move=(label,icon,shortcut,direction)=>guarded(label,icon,shortcut,()=>imageLayerMoveStep(layers,ids,direction),async placement=>{
      await moveLayerSelection(origin,ids,placement,count);
    });
    const duplicate=guarded(item.embedded&&!multi?'放置关联实例':'复制','copy',menuShortcut('Mod+J'),()=>checkImageLayerDuplicate(layers,ids),async plan=>{
      const copyIds=plan.roots.map(()=>crypto.randomUUID());
      await apply('duplicateLayers',{copyIds});
      if(sameImage()&&project.imageContext?.layerId===origin.layerId){
        resetFilter();
        const activeRoot=plan.roots.findIndex(layer=>layer.id===origin.layerId);
        setRowSelection(copyIds,copyIds[activeRoot]??copyIds.at(-1));
        noteBatch('已复制 '+count+' 项');
      }
    });
    const remove=guarded('删除','trash','Delete',()=>planImageLayerDelete(layers,ids),plan=>{
      const removeSelection=async()=>{
        await apply('removeLayers');
        if(!sameImage())return;
        const remaining=plan.layers,active=project.imageContext?.layerId;
        if(!remaining.some(layer=>layer.id===active)){
          const next=remaining.at(-1)?.id??null;
          setRowSelection(next?[next]:[],next);
        }
        noteBatch('已删除 '+count+' 项'+(plan.released.length?' · 解除 '+plan.released.length+' 个剪贴关系':''));
      };
      const visible=new Set(renderedRows.map(row=>row.layer.id));
      if(plan.released.length||plan.roots.some(layer=>layer.kind==='group')||ids.some(id=>!visible.has(id))){
        const clips=plan.released.length?' '+plan.released.length+' 个保留的图层会解除剪贴。':'';
        groupDialog.setAction(multi?'删除所选图层':item.kind==='group'?'删除图层组':'删除图层',
          '将删除 '+count+' 项。'+clips,removeSelection);
      }else return removeSelection();
    });
    return [move('上移','moveUp',menuShortcut('Mod+]'),1),move('下移','moveDown',menuShortcut('Mod+['),-1),duplicate,remove];
  }
  function editText(item,origin=imageSelectionOrigin(project)){
    if(item?.text&&!layerLockOwner(currentDocument(project).layers,item)&&!ctx.busy?.())ctx.openImageText?.(origin,item);
  }
  function selectLayerMask(item,origin=imageSelectionOrigin(project),{inspect=false,reveal=true}={}){
    if(!item||ctx.busy?.())return;
    const hasMask=hasImageLayerMask(item);
    if(layerLockOwner(currentDocument(project).layers,item)&&!hasMask)return;
    const selection=hasMask?null:ctx.imageSelection?.(origin);
    void run(async()=>{
      if(!hasMask)await commandAt(project,origin,{action:'createMask',layerId:item.id,reveal,
        ...(selection?{rect:selection.clip,...uvShapePayload(selection)}:{})});
      const current=project.imageContext;
      if(project.document?.id===origin.id&&current?.documentId===origin.documentId&&
         current?.layerId===origin.layerId&&current?.target===origin.target){
        const inspectMask=inspect&&!(current.layerId===item.id&&current.inspectMask);
        selectImage(project,{layerId:item.id,target:'mask',inspectMask});
      }
    });
  }
  function openLayerMenu(event,view,anchor){
    if(ctx.busy?.()||event.target.closest('input'))return;
    const item=view.item,layers=currentDocument(project)?.layers,index=layers?.findIndex(layer=>layer.id===item.id);
    if(index==null||index<0)return;
    event.preventDefault();
    event.stopPropagation();
    view.select.focus({preventScroll:true});
    if(!selectedRows.has(item.id))setRowSelection([item.id],item.id);
    const origin=imageSelectionOrigin(project),editable=!view.lockOwner,hasMask=hasImageLayerMask(item);
    const maskAction=action=>()=>commandAt(project,origin,{action,layerId:item.id});
    const update=patch=>()=>commandAt(project,origin,{action:'updateLayer',layerId:item.id,patch});
    const [up,down,copy,remove]=stackActions(item,layers,origin,true);
    menuTarget={id:item.id,revision:origin.revision};
    // A right-click can open the popover before the pointer is released.
    // Keep the pointer just inside the menu so the release does not dismiss it.
    const position=anchor??{clientX:event.clientX-2,clientY:event.clientY-2};
    const destination=layerMoveMenu(layers,origin,position);
    function combine(action,layerIds){
      const stamp=action==='stampVisible',rasterize=action==='rasterize';
      let reason;
      if(rasterize&&!editable)reason='请先解锁图层';
      if(!rasterize){
        try{planImageCombine(layers,action,layerIds);}
        catch(error){reason=error.message;}
      }
      if(stamp&&layers.length>=imageLayerLimit)reason='请先合并图层，为盖印结果腾出空间';
      return {
        label:imageCombineLabels[action],icon:rasterize?'brush':'copy',enabled:!reason,
        shortcut:rasterize?undefined:stamp?menuShortcut('Mod+Alt+Shift+E'):menuShortcut('Mod+E'),
        title:reason||(stamp?'生成像素层，暂时隐藏原图层。可撤销恢复原来的显隐状态。':undefined),
        run:()=>combineImageLayers(project,origin,action,layerIds)
      };
    }
    if(selectedRows.size>1){
      menu.open(position,'已选 '+selectedRows.size+' 个图层',[
        {label:'将所选图层成组',icon:'folder',shortcut:menuShortcut('Mod+G'),enabled:editable,run:()=>createGroup(true)},
        combine('mergeSelected',[...selectedRows]),combine('stampVisible',[]),
        null,up,down,destination,copy,remove
      ]);
      return;
    }
    menu.open(position,item.name,[
      {label:'重命名',icon:'pen',shortcut:'F2',enabled:editable,run:()=>startRename(view)},
      {label:'将所选图层成组',icon:'folder',shortcut:menuShortcut('Mod+G'),enabled:editable,run:()=>createGroup(true)},
      ...(item.embedded?[{label:'编辑内嵌源稿',icon:'image',run:()=>openEmbeddedSource(project,item)}]:
        [{label:'转换为内嵌对象',icon:'image',enabled:editable&&item.kind!=='adjustment',
          run:()=>commandAt(project,origin,{action:'embedLayer',layerId:item.id,newDocumentId:crypto.randomUUID()})}]),
      ...(item.kind==='group'?[{label:'解散图层组',icon:'folder',shortcut:menuShortcut('Mod+Shift+G'),enabled:editable,run:()=>ungroup(item,origin)}]:[]),
      ...(item.text?[{label:'编辑文字…',icon:'text',enabled:editable,run:()=>editText(item,origin)}]:[]),
      ...(['image','shape'].includes(item.kind)||hasImageStyle(item)||item.edgeDecontaminate?[combine('rasterize',[item.id])]:[]),
      combine('mergeDown',[item.id]),combine('stampVisible',[]),
      copy,
      {label:item.visible?'隐藏':'显示',icon:item.visible?'hidden':'eye',enabled:!view.lockOwner||view.lockOwner===item,run:update({visible:!item.visible})},
      {label:item.locked?'解锁':'锁定',icon:item.locked?'unlock':'lock',enabled:!view.lockOwner||view.lockOwner===item,run:update({locked:!item.locked})},
      ...(item.kind==='pixel'?[{label:item.alphaLocked?'解锁透明像素':'锁定透明像素',icon:'alphaLock',
        enabled:editable,run:update({alphaLocked:!item.alphaLocked})}]:[]),
      null,up,down,destination,null,
      ...(item.kind==='group'?[]:[{label:item.clipped?'释放剪贴蒙版':'创建剪贴蒙版',icon:'clippingMask',shortcut:menuShortcut('Mod+Alt+G'),
        enabled:editable&&!!imageClippingBase(layers,index),
        run:()=>commandAt(project,origin,{action:'setClipping',layerId:item.id,clipped:!item.clipped})}]),
      {label:hasMask?'选择蒙版':'添加蒙版',icon:'mask',enabled:editable||hasMask,run:()=>selectLayerMask(item,origin)},
      {label:'从透明度载入选区',icon:'marquee',enabled:item.kind!=='adjustment',
        run:()=>ctx.sampleLayerSelection?.(origin,item.id,'alpha','replace')},
      {label:'从可见范围载入选区',icon:'marquee',enabled:item.kind!=='adjustment'&&layerIsVisible(layers,item),
        title:'包含图层蒙版、剪贴底层和上级组的覆盖范围',
        run:()=>ctx.sampleLayerSelection?.(origin,item.id,'visibleAlpha','replace')},
      ...(hasMask?[
        {label:'从蒙版载入选区',icon:'marquee',run:()=>ctx.sampleLayerSelection?.(origin,item.id,'mask','replace')},
        {label:item.maskLinked===false?'链接图层和蒙版':'解除蒙版链接',icon:'mask',enabled:editable,
          run:update({maskLinked:item.maskLinked===false})},
        {label:'单独查看蒙版',icon:'eye',shortcut:menuShortcut('Alt+点击'),run:()=>selectLayerMask(item,origin,{inspect:true})},
        {label:item.maskEnabled?'停用蒙版':'启用蒙版',icon:'mask',enabled:editable,run:update({maskEnabled:!item.maskEnabled})},
        {label:'反相蒙版',icon:'invert',enabled:editable,run:maskAction('invertMask')},
        {label:'删除蒙版',icon:'trash',enabled:editable,run:maskAction('removeMask')}
      ]:[{label:ctx.imageSelection?.(origin)?'用蒙版隐藏选区':'用蒙版隐藏全部',icon:'mask',enabled:editable,
        shortcut:menuShortcut('Alt+点击蒙版按钮'),run:()=>selectLayerMask(item,origin,{reveal:false})}]),
      null,remove
    ]);
  }
  function makeRow(item){
    const row=el('div','document-layer-row'),preview=el('canvas','document-layer-thumb'),maskPreview=el('canvas'),name=el('span','document-layer-name');
    const textThumb=el('span','document-text-thumbnail');
    textThumb.innerHTML=workspaceIcons.text;textThumb.setAttribute('aria-hidden','true');textThumb.title='双击编辑文字';
    const effectThumb=el('span','document-adjustment-thumbnail');
    effectThumb.innerHTML=workspaceIcons.adjustment;effectThumb.setAttribute('aria-hidden','true');
    const folderThumb=el('span','document-group-thumbnail');
    folderThumb.innerHTML=workspaceIcons.folder;folderThumb.setAttribute('aria-hidden','true');
    const clipMark=el('span','document-layer-clip-mark');
    clipMark.innerHTML=workspaceIcons.clippingMask;
    const view={row,preview,textThumb,effectThumb,folderThumb,maskPreview,name,item,clipMark,nearViewport:!thumbnailObserver};
    function setLayer(patch){
      const origin=imageSelectionOrigin(project);
      void run(()=>commandAt(project,origin,{action:'updateLayer',layerId:item.id,patch}));
    }
    const eye=button('',()=>setLayer({visible:!view.item.visible}));
    const lock=button('',()=>setLayer({locked:!view.item.locked}));
    function loadThumbnail(event,source){
      if(!(event.metaKey||event.ctrlKey))return false;
      const operation=event.shiftKey?(event.altKey?'intersect':'add'):event.altKey?'subtract':'replace';
      const origin=imageSelectionOrigin(project);
      void run(()=>ctx.sampleLayerSelection?.(origin,view.item.id,source,operation));
      return true;
    }
    const select=button('',event=>{
      if(event.target.closest('.document-layer-thumb,.document-text-thumbnail,.document-group-thumbnail')&&
         view.item.kind!=='adjustment'&&loadThumbnail(event,'alpha'))return;
      selectRow(view.item,event);
    });
    select.className='document-layer-select';
    select.append(preview,textThumb,effectThumb,folderThumb);
    select.ondblclick=event=>view.item.embedded?openEmbeddedSource(project,view.item):event.target.closest('.document-text-thumbnail')?editText(view.item):startRename(view);
    name.setAttribute('aria-hidden','true');
    name.onclick=event=>{
      if(select.disabled)return;
      select.focus({preventScroll:true});
      selectRow(view.item,event);
    };
    name.ondblclick=()=>view.item.embedded?openEmbeddedSource(project,view.item):startRename(view);
    const mask=button('',event=>{
      const layer=view.item;
      if(hasImageLayerMask(layer)&&loadThumbnail(event,'mask'))return;
      if(event.shiftKey){if(!view.lockOwner)setLayer({maskEnabled:!layer.maskEnabled});return;}
      selectLayerMask(layer,imageSelectionOrigin(project),{inspect:event.altKey});
    });
    mask.className='document-layer-mask';
    const link=button('',()=>setLayer({maskLinked:view.item.maskLinked===false}));
    link.className='document-layer-mask-link';
    const clipEdge=button('',event=>{
      if(!event.altKey){select.click();return;}
      const origin=imageSelectionOrigin(project);
      void run(()=>commandAt(project,origin,{action:'setClipping',layerId:item.id,clipped:!view.item.clipped}));
    });
    clipEdge.className='document-layer-clip-edge';
    clipEdge.tabIndex=-1;
    const disclosure=button('',()=>changeGroup(item.id,collapsedGroups.has(item.id)));
    disclosure.className='document-group-disclosure';
    disclosure.innerHTML=workspaceIcons.chevron;
    row.dataset.imageLayerId=item.id;
    row.append(eye,select,link,mask,name,lock,clipMark,clipEdge,disclosure);
    Object.assign(view,{eye,select,lock,mask,link,clipEdge,disclosure});
    bindReorder(view);
    row.oncontextmenu=event=>openLayerMenu(event,view);
    select.onkeydown=event=>{
      if(compositionKey(event))return;
      if(event.key==='F2'){
        event.preventDefault();
        event.stopPropagation();
        startRename(view);
      }else if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){
        const rect=select.getBoundingClientRect();
        openLayerMenu(event,view,{clientX:rect.left,clientY:rect.bottom});
      }
    };
    return view;
  }
  function labelButton(control,label,icon){
    if(control.getAttribute('aria-label')!==label){
      control.setAttribute('aria-label',label);
      control.title=label;
    }
    if(icon&&control.dataset.icon!==icon){
      control.dataset.icon=icon;
      control.innerHTML=workspaceIcons[icon];
    }
  }
  function updateRow(view,rowState,context,target,busy,base,hasClips,filtering){
    const {layer:item,depth,open,visible,lockOwner}=rowState;
    const {row,eye,select,preview,textThumb,effectThumb,folderThumb,mask,link,maskPreview,lock,name,clipMark,clipEdge,disclosure}=view;
    const selected=selectedRows.has(item.id),active=item.id===target.layerId,group=item.kind==='group',hasMask=hasImageLayerMask(item);
    const inheritedLock=lockOwner&&lockOwner!==item;
    row.toggleAttribute('data-selected',selected);
    row.toggleAttribute('data-active',active);
    row.toggleAttribute('data-group',group);
    row.toggleAttribute('data-embedded',!!item.embedded);
    row.toggleAttribute('data-inherited-hidden',item.visible&&!visible);
    row.style.setProperty('--image-layer-depth',depth);
    row.toggleAttribute('data-has-mask',hasMask);
    row.toggleAttribute('data-clipped',!!item.clipped);
    row.toggleAttribute('data-clipping-base',hasClips);
    clipMark.hidden=!item.clipped;
    if(item.clipped)clipMark.title='剪贴到底层 '+base?.name;
    clipEdge.hidden=!base||!!lockOwner;
    clipEdge.disabled=busy;
    labelButton(clipEdge,'Alt / Option 单击'+(item.clipped?'释放':'创建')+'剪贴蒙版');
    mask.hidden=!hasMask;
    select.setAttribute('aria-pressed',String(selected&&!(active&&target.target==='mask')));
    mask.setAttribute('aria-pressed',String(active&&target.target==='mask'));
    mask.toggleAttribute('data-disabled',hasMask&&!item.maskEnabled);
    const linked=item.maskLinked!==false;
    link.hidden=!hasMask;
    link.disabled=busy||!!lockOwner;
    link.setAttribute('aria-pressed',String(linked));
    labelButton(link,linked?'解除蒙版链接':'链接图层和蒙版',linked?'chain':'chainOff');
    preview.hidden=!!item.text||group||item.kind==='adjustment';textThumb.hidden=!item.text;effectThumb.hidden=item.kind!=='adjustment';folderThumb.hidden=!group;
    disclosure.hidden=!group;
    disclosure.disabled=busy||filtering;
    if(group){
      disclosure.setAttribute('aria-expanded',String(open));
      labelButton(disclosure,(open?'收起 ':'展开 ')+item.name);
    }
    if(name.textContent!==item.name){
      name.textContent=item.name;
      name.title=item.name;
    }
    labelButton(select,item.name);
    if(item.embedded)select.title=item.name+' · 内嵌对象，双击编辑源稿';
    labelButton(eye,(item.visible?'隐藏 ':'显示 ')+item.name,item.visible?'eye':'hidden');
    labelButton(lock,inheritedLock?'由「'+lockOwner.name+'」锁定':(item.locked?'解锁 ':'锁定 ')+item.name,lockOwner?'lock':'unlock');
    labelButton(mask,'选择蒙版 '+item.name);
    mask.title='选择蒙版 · ⌘ / Ctrl 点击载入选区 · Alt 单独查看 · Shift 启用或停用';
    if(hasMask&&!mask.contains(maskPreview))mask.replaceChildren(maskPreview);
    else if(!hasMask&&mask.contains(maskPreview)){
      pauseImageThumbnail(maskPreview);
      maskPreview.remove();
    }
    eye.disabled=lock.disabled=busy||!!inheritedLock;
    select.disabled=busy;
    mask.disabled=busy;
    mask.draggable=hasMask&&!busy;
    name.draggable=select.draggable=!busy&&!lockOwner;
    view.item=item;
    view.lockOwner=lockOwner;
    view.previewContext=context;
    refreshPreviews(view);
  }
  function clearRows(){
    clearDrag();
    menu?.close();
    menuTarget=null;
    finishRename({commit:true});
    for(const view of rows.values()){
      thumbnailObserver?.unobserve(view.row);
      stopPreviews(view);
    }
    rows.clear();
    rowsHost.replaceChildren();
  }
  function renderRows(image,doc,context,visibleIds,busy,filtering){
    const documentKey=JSON.stringify([doc.id,context.documentId]);
    if(stackDocument!==documentKey){clearRows();stackDocument=documentKey;}
    if(reorder&&(reorder.origin.revision!==doc.revision||busy||!visibleIds.has(reorder.layerId)))clearDrag();
    if(menuTarget&&(busy||menuTarget.revision!==doc.revision||!visibleIds.has(menuTarget.id))){menu.close();menuTarget=null;}
    const ids=new Set(image.layers.map(item=>item.id));
    for(const [id,view] of rows){
      if(ids.has(id))continue;
      if(renaming?.view===view)finishRename({commit:false});
      thumbnailObserver?.unobserve(view.row);
      stopPreviews(view);
      view.row.remove();
      rows.delete(id);
    }
    const previewContext={projectId:doc.id,revision:doc.revision,documentId:context.documentId,colorSpace:image.colorSpace,
      geometry:imageViewGeometry(image)};
    for(const [id,view] of rows){
      if(visibleIds.has(id))continue;
      view.row.toggleAttribute('data-selected',selectedRows.has(id));
      view.row.toggleAttribute('data-active',context.layerId===id);
      if(view.row.hidden)continue;
      if(renaming?.view===view)finishRename({commit:true});
      stopPreviews(view);view.row.hidden=true;
    }
    let cursor=rowsHost.firstChild;
    for(const state of renderedRows){
      const item=state.layer,index=image.layers.indexOf(item);
      let view=rows.get(item.id);
      if(!view){
        view=makeRow(item);
        rows.set(item.id,view);
        thumbnailObserver?.observe(view.row);
      }
      if(view.row!==cursor)rowsHost.insertBefore(view.row,cursor);
      cursor=view.row.nextSibling;
      view.row.hidden=false;
      updateRow(view,state,previewContext,context,busy,imageClippingBase(image.layers,index),
        !item.clipped&&followingClips(image.layers,item).length>0,filtering);
    }
  }
  function renderAdjustment(layer,busy){
    const adjustment=layer.adjustment,spec=imageAdjustments[adjustment.type],disabled=!!layerLockOwner(currentDocument(project).layers,layer)||busy;
    const section=el('section','document-adjustment-properties'),heading=el('div','document-adjustment-heading');
    const reset=button(spec.filter?'重置滤镜':'重置调整',()=>void run(()=>command(project,{
      action:'updateLayer',layerId:layer.id,patch:{adjustment:newImageAdjustment(adjustment.type)}
    })));
    reset.disabled=disabled;
    heading.append(el('strong','',spec.label),reset);section.append(heading);
    if(adjustment.type==='curves'){
      const origin=imageSelectionOrigin(project),owner={};
      const operation=points=>({op:'image',action:'updateLayer',documentId:origin.documentId,layerId:layer.id,
        patch:{adjustment:{type:'curves',points}}});
      curveEditor=createCurveEditor(section,{layer,image:currentDocument(project),origin,channel:curveChannel,
        point:curveSelection?.layerId===layer.id?curveSelection.point:null,disabled,
        onChannel:value=>{curveChannel=value;ctx.onChange?.();},
        onPoint:point=>{curveSelection={layerId:layer.id,point};},
        onPreview:points=>{
          if(!points){clearAdjustment(owner);return;}
          adjustmentEditing={owner,origin};ctx.imageAdjustment?.(owner,origin,operation(points));
        },
        onCommit:points=>run(()=>project.commands([operation(points)],origin)).finally(()=>{key='';sync();})
      });
      body.append(section);
      return;
    }
    const bank=imageAdjustmentBanks[adjustment.type],bankKey=JSON.stringify([project.document.id,project.imageContext.documentId,layer.id]);
    const selectedBank=bank&&(adjustmentBankTargets.get(bankKey)??bank.initial);
    const range=adjustment.range??'all';
    if(adjustment.type==='hueSaturation'&&ctx.pickAdjustmentColor){
      const sample=chromeButton(button('在画布取色',()=>void run(()=>{
        const origin=imageSelectionOrigin(project);
        ctx.pickAdjustmentColor(origin,center=>{
          if(adjustment.range==='custom'&&adjustment.center===center)return;
          return project.commands([{op:'image',action:'updateLayer',documentId:origin.documentId,
            layerId:layer.id,patch:{adjustment:{...adjustment,range:'custom',center}}}],origin);
        });
      })),'eyedropper');
      sample.disabled=disabled;
      sample.classList.add('document-adjustment-pick');
      heading.insertBefore(sample,reset);
    }
    function editField(field,value,patch,{min=field.min,max=field.max}={}){
      const operation=(value,origin)=>({op:'image',action:'updateLayer',documentId:origin.documentId,layerId:layer.id,
        patch:{adjustment:{...adjustment,...patch(value)}}});
      const update=value=>{
        const origin=imageSelectionOrigin(project);
        return project.commands([operation(value,origin)],origin);
      };
      if(field.choices){
        const select=choice(field.label,field.choices,value,value=>void run(()=>update(value)));
        select.disabled=disabled;section.append(select);enhanceSelectMenu(select);
        return;
      }
      const owner={};
      const type=field.type??'number';
      const control=addControl(section,field.label,type,value,update,
        {disabled,...(type==='number'?{min,max,step:field.step}:{})},(value,origin)=>{
          if(value===null){clearAdjustment(owner);return;}
          if(!ctx.imageAdjustment||!origin.id||field.valid&&!field.valid(value))return;
          adjustmentEditing={owner,origin};
          ctx.imageAdjustment(owner,origin,operation(value,origin));
        });
      if(type==='number')control.dataset.scrubSpeed=String(field.scrubSpeed??field.step);
      if(field.suffix)control.dataset.scrubSuffix=field.suffix;
    }
    for(const [name,field] of Object.entries(spec.fields)){
      if(name==='tones'||field.show==='custom'&&range!=='custom'||field.show==='range'&&range==='all')continue;
      editField(field,adjustment[name]??field.initial,value=>({[name]:value}),{
        min:name==='inputWhite'?adjustment.inputBlack+1:field.min,
        max:name==='inputBlack'?adjustment.inputWhite-1:field.max
      });
    }
    if(bank){
      const select=choice(bank.label,bank.ranges,selectedBank,value=>{
        adjustmentBankTargets.set(bankKey,value);key='';sync();
        body.querySelector('button[aria-label="'+bank.label+'"]')?.focus({preventScroll:true});
      });
      select.disabled=disabled;section.append(select);enhanceSelectMenu(select);
      for(const [name,field] of Object.entries(bank.fields))
        editField(field,adjustment.tones[selectedBank][name],value=>({tones:{...adjustment.tones,
          [selectedBank]:{...adjustment.tones[selectedBank],[name]:value}}}));
    }
    if(adjustment.type==='gradientMap'){
      const ramp=el('div','document-adjustment-ramp');
      const colors=[adjustment.shadow,adjustment.middle,adjustment.highlight];
      if(adjustment.reverse)colors.reverse();
      ramp.style.background=`linear-gradient(90deg,${colors[0]},${colors[1]} ${adjustment.reverse?100-adjustment.midpoint:adjustment.midpoint}%,${colors[2]})`;
      heading.after(ramp);
    }else if(adjustment.type==='hueSaturation'&&range!=='all'){
      const ramp=el('div','document-adjustment-ramp document-hue-range');
      const center=range==='custom'?(adjustment.center??0):hueFamilies.find(([id])=>id===range)[2];
      const width=adjustment.width??30,falloff=adjustment.falloff??20;
      const shading=Array.from({length:73},(_,i)=>{
        const distance=Math.abs(((i*5-center+540)%360)-180);
        const weight=distance<=width?0:falloff?Math.min(1,(distance-width)/falloff):1;
        return `rgb(0 0 0 / ${(.78*weight).toFixed(3)}) ${i/72*100}%`;
      });
      ramp.style.setProperty('--hue-range-shading',`linear-gradient(90deg,${shading.join(',')})`);
      heading.after(ramp);
    }
    body.append(section);
  }
  function renderBlendIf(layer,disabled){
    const section=el('details','document-blend-if'),summary=el('summary','','明暗混合');
    section.open=blendIfOpen.get(layer.id)??!!layer.blendIf;
    section.ontoggle=()=>blendIfOpen.set(layer.id,section.open);
    section.append(summary);
    const ranges=layer.blendIf??{source:[...fullBlendRange],backdrop:[...fullBlendRange]};
    const owner={};
    function operation(origin,key,index,value){
      const stops=[...ranges[key]];
      stops[index]=value;
      return {op:'image',action:'updateLayer',documentId:origin.documentId,layerId:layer.id,patch:{blendIf:{...ranges,[key]:stops}}};
    }
    const headings=['暗部隐藏','暗部全显','亮部全显','亮部隐藏'];
    for(const [key,label] of [['source','本图层'],['backdrop','下方图层']]){
      const band=el('fieldset','document-blend-range'),caption=el('legend','',label),ramp=el('div','document-blend-ramp');
      const fields=el('div','document-blend-stops');
      const show=stops=>ramp.style.setProperty('--tone-window',`linear-gradient(90deg,transparent ${stops[0]/2.55}%,white ${stops[1]/2.55}%,white ${stops[2]/2.55}%,transparent ${stops[3]/2.55}%)`);
      show(ranges[key]);band.append(caption,ramp,fields);section.append(band);
      ranges[key].forEach((value,index)=>{
        const input=addControl(fields,label+' · '+headings[index],'number',value,n=>{
          const origin=imageSelectionOrigin(project);
          return project.commands([operation(origin,key,index,n)],origin);
        },{disabled,min:ranges[key][index-1]??0,max:ranges[key][index+1]??255,step:1},(n,origin)=>{
          if(n===null){show(ranges[key]);clearAdjustment(owner);return;}
          const op=operation(origin,key,index,n);
          show(op.patch.blendIf[key]);adjustmentEditing={owner,origin};
          ctx.imageAdjustment?.(owner,origin,op);
        });
        input.dataset.scrubSpeed='1';
        input.parentElement.title=label+' · '+headings[index];
      });
    }
    const reset=button('清除明暗混合',()=>void run(()=>command(project,{action:'updateLayer',layerId:layer.id,patch:{blendIf:null}})));
    reset.disabled=disabled||!layer.blendIf;
    section.append(reset);body.append(section);
  }
  function renderShape(layer,busy){
    const shape=layer.shape,disabled=layer.locked||busy,section=el('section','document-shape-properties');
    const write=patch=>command(project,{action:'updateLayer',layerId:layer.id,patch});
    const style=(name,value)=>({shape:{...shape,[name]:value}});
    const kind=choice('图层形状',imageShapeKinds,shape.kind,value=>void run(()=>write(style('kind',value))));
    kind.disabled=disabled;section.append(kind);enhanceSelectMenu(kind);
    function control(label,type,value,patch,attrs={}){
      const owner={};
      const preview=type==='checkbox'?undefined:(value,origin)=>{
        if(value===null){clearAdjustment(owner);return;}
        if(!origin.id)return;
        adjustmentEditing={owner,origin};
        ctx.imageAdjustment?.(owner,origin,{op:'image',action:'updateLayer',documentId:origin.documentId,
          layerId:layer.id,patch:patch(value)});
      };
      return addControl(section,label,type,value,value=>write(patch(value)),{disabled,...attrs},preview);
    }
    imageShapeSize(layer).forEach((size,index)=>{
      const unit=size/Math.abs(layer.stretch[index]);
      const field=control(index===0?'宽度':'高度','number',Number(size.toFixed(1)),value=>({
        stretch:layer.stretch.map((n,i)=>i===index?Math.sign(n)*Math.max(.05,Math.min(8,value/unit)):n)
      }),{min:Math.ceil(unit*.05*10)/10,max:Math.floor(unit*8*10)/10,step:'any'});
      field.dataset.scrubSpeed='1';field.dataset.scrubSuffix=' px';
    });
    control('填充','checkbox',shape.fill!==null,enabled=>style('fill',enabled?'#808080':null));
    if(shape.fill)control('填充颜色','color',shape.fill,value=>style('fill',value));
    control('描边','checkbox',shape.stroke!==null,enabled=>({shape:{...shape,stroke:enabled?'#000000':null,
      strokeWidth:enabled?shape.strokeWidth||16:shape.strokeWidth}}));
    if(shape.stroke){
      control('描边颜色','color',shape.stroke,value=>style('stroke',value));
      const width=control('描边宽度','number',shape.strokeWidth,value=>style('strokeWidth',value),{min:0,max:512,step:1});
      width.dataset.scrubSpeed='1';width.dataset.scrubSuffix=' px';
    }
    if(shape.kind==='rectangle'){
      const radius=control('圆角','number',shape.cornerRadius,value=>style('cornerRadius',value),{min:0,max:2048,step:1});
      radius.dataset.scrubSpeed='1';radius.dataset.scrubSuffix=' px';
    }
    body.append(section);
  }
  function revealLayerRow(id){
    const row=rows.get(id)?.row;
    if(!row||row.hidden)return;
    const {top,bottom}=row.getBoundingClientRect(),viewport=body.getBoundingClientRect();
    if(top<viewport.top)body.scrollTop+=top-viewport.top;
    else if(bottom>viewport.bottom)body.scrollTop+=bottom-viewport.bottom;
  }
  let copiedStyles=null,stylesOpen=false;
  const openEffects=new Set();
  function renderStyles(layer,disabled){
    const section=el('details','property-section');
    section.open=stylesOpen;
    section.ontoggle=()=>{stylesOpen=section.open;};
    const heading=el('summary','','图层样式'),controls=el('div','property-section-body');
    section.append(heading,controls);body.append(section);
    const origin=imageSelectionOrigin(project);
    const write=styles=>commandAt(project,origin,{action:'updateLayer',layerId:layer.id,patch:{styles}});
    const actions=el('div','document-property-actions');
    const copy=button('复制样式',()=>{
      copiedStyles=structuredClone(layer.styles);
      paste.disabled=disabled;
    });
    copy.disabled=!Object.keys(layer.styles??{}).length;
    const paste=button('粘贴样式',()=>void run(()=>write(copiedStyles)));
    paste.disabled=disabled||!copiedStyles;
    actions.append(copy,paste);controls.append(actions);
    if(layer.kind==='group'&&layer.blend==='passThrough')
      controls.append(el('div','document-muted','启用组样式时，组内图层先独立合成。'));
    for(const [id,{label,fields}] of Object.entries(textEffects)){
      const state=layer.styles?.[id]??{enabled:false,...Object.fromEntries(Object.entries(fields).map(([key,spec])=>[key,spec.value])),
        ...(id==='outline'?{position:'outside'}:{})};
      const effect=el('details','property-section'),summary=el('summary','',label),params=el('div','property-section-body');
      effect.open=openEffects.has(id);
      effect.ontoggle=()=>{if(effect.open)openEffects.add(id);else openEffects.delete(id);};
      effect.append(summary,params);controls.append(effect);
      const update=patch=>write({...layer.styles,[id]:{...state,...patch}});
      addControl(params,'启用'+label,'checkbox',state.enabled,enabled=>update({enabled}),{disabled});
      if(id==='outline'){
        const position=choice('描边位置',outlinePositions,state.position,position=>void run(()=>update({position})));
        position.disabled=disabled||!state.enabled;
        const row=el('label','document-property','位置');row.append(position);params.append(row);enhanceSelectMenu(position);
      }
      for(const [name,{label,value,min,max}] of Object.entries(fields)){
        const isColor=typeof value==='string';
        const input=addControl(params,label,isColor?'color':'number',state[name],value=>update({[name]:value}),
          {disabled:disabled||!state.enabled,...(isColor?{}:{min,max,step:1})});
        if(!isColor)input.dataset.scrubSpeed='1';
      }
    }
  }
  let key='',pickerOptionsKey='',renderedTarget='';function sync(event){
    if(disposed)return;
    const doc=project.document;if(!doc)return;const image=currentDocument(project),layer=currentLayer(project),c=project.imageContext;
    const reveal=type==='layers'&&layer&&event?.kind==='imageSelection'&&event.reveal;
    if(reveal){
      let revealed=false;
      for(let parent=layerParent(layer);parent;parent=layerParent(image.layers.find(item=>item.id===parent))){
        if(collapsedGroups.delete(parent))revealed=true;
      }
      if(revealed)ctx.onChange?.();
    }
    if(adjustmentEditing){
      const {origin,owner}=adjustmentEditing;
      if(origin.id!==doc.id||origin.revision!==doc.revision||origin.documentId!==c?.documentId||origin.layerId!==c?.layerId||origin.target!==c?.target)
        clearAdjustment(owner);
    }
    const origin=imageSelectionOrigin(project),rowKey=selectionKey(origin);
    if(selectionContext!==rowKey){
      selectionContext=rowKey;selectionAnchor=layer?.id??null;selectedRows=new Set(layer?[layer.id]:[]);
    }
    if(image)selectedRows=new Set(image.layers.filter(item=>(c?.layerIds??(layer?[layer.id]:[])).includes(item.id)).map(item=>item.id));
    const targetKey=JSON.stringify([doc.id,c]),next=JSON.stringify([doc.id,doc.revision,c,!!ctx.busy?.(),filterOpen,search.value,kind.value,[...selectedRows],[...collapsedGroups]]);
    if(key===next){
      if(reveal)revealLayerRow(layer.id);
      return;
    }
    if(renderedTarget===targetKey&&body.contains(document.activeElement)&&document.activeElement.hasAttribute('data-document-dirty'))return;
    key=next;renderedTarget=targetKey;
    const selected=project.imageContext?.documentId||'',documents=Object.entries(doc.paint.imageDocuments??{}),optionsKey=JSON.stringify([doc.id,documents.map(([id,d])=>[id,d.name])]);if(pickerOptionsKey!==optionsKey){pickerOptionsKey=optionsKey;picker.replaceChildren(new Option('选择图像文档',''),...documents.map(([id,d])=>new Option(d.name,id)));}picker.value=selected;syncSelectMenu(picker);
    const busy=!!ctx.busy?.();
    const lockOwner=layer&&layerLockOwner(image.layers,layer);
    if(add){
      const parent=layer&&(layer.kind==='group'?layer:layerParent(layer)&&image.layers.find(item=>item.id===layerParent(layer)));
      add.disabled=addAdjustment.disabled=addGroup.disabled=!image||busy||image.layers.length>=imageLayerLimit||!!(parent&&layerLockOwner(image.layers,parent));
    }
    if(toggle){
      toggle.disabled=!image;
      toggle.setAttribute('aria-pressed',String(filterOpen));
      filters.hidden=!image||!filterOpen;
    }
    error.textContent='';
    if(!image){
      if(addMask){
        addMask.disabled=true;
        footerStack=[];
        for(const control of stackButtons)control.disabled=true;
      }
      clearRows();
      if(feedback){renderedRows=[];updateBatchFeedback();}
      bar=null;
      curveEditor?.dispose();curveEditor=null;
      body.replaceChildren(el('p','document-muted','没有打开图像文档'));
      return;
    }
    if(type==='layers'){
      const query=filterOpen?search.value.trim():'',mode=filterOpen?kind.value:'all',filtering=!!query||mode!=='all';
      const filter=mode==='all'?null:item=>mode===(item.text?'text':item.kind)||mode==='mask'&&hasImageLayerMask(item);
      renderedRows=layerTreeRows(image.layers,{query,filter,collapsed:collapsedGroups});
      const visibleIds=new Set(renderedRows.map(row=>row.layer.id));
      const selectedVisible=!!layer&&visibleIds.has(layer.id),canEdit=selectedVisible&&!lockOwner&&!busy;
      filterCount.textContent=(filtering?renderedRows.length:image.layers.length)+' / '+image.layers.length+
        (filtering&&layer&&!selectedVisible?' · 当前图层不在结果中':'');

      const controls=el('div','document-layer-controls');
      const blend=choice('图像图层混合模式',[],'',value=>{
        const origin=imageSelectionOrigin(project);
        void run(()=>commandAt(project,origin,{action:'updateLayer',layerId:layer.id,patch:{blend:value}}));
      });
      if(layer?.kind==='group')blend.append(new Option('穿透',imageGroupBlend));
      for(const [label,modes] of imageBlendGroups){
        const target=label?el('optgroup'):blend;
        if(label)target.label=label;
        target.append(...modes.map(([value,name])=>new Option(name,value)));
        if(label)blend.append(target);
      }
      blend.value=layer?.blend||'normal';
      blend.disabled=!canEdit;
      controls.append(blend);
      const opacity=addControl(controls,'不透明度','number',Math.round((layer?.opacity??1)*100),
        value=>command(project,{action:'updateLayer',layerId:layer.id,patch:{opacity:value/100}}),{min:0,max:100,disabled:!canEdit});
      opacity.dataset.scrubSuffix='%';
      opacity.parentElement.firstChild.replaceWith(el('span','document-opacity-caption','不透明度'));
      const alphaLock=chromeButton(button('锁定透明像素',()=>{
        const origin=imageSelectionOrigin(project);
        void run(()=>commandAt(project,origin,{action:'updateLayer',layerId:layer.id,patch:{alphaLocked:!layer.alphaLocked}}));
      }),'alphaLock');
      alphaLock.disabled=!canEdit||layer?.kind!=='pixel';
      alphaLock.setAttribute('aria-pressed',String(!!layer?.alphaLocked));
      alphaLock.classList.add('document-alpha-lock');
      controls.append(alphaLock);
      if(bar)bar.replaceWith(controls);
      else body.replaceChildren(controls,message,rowsHost);
      bar=controls;
      enhanceSelectMenu(blend);
      message.hidden=renderedRows.length>0;
      message.textContent=image.layers.length?'没有匹配的图层':'没有图层';
      renderRows(image,doc,c,visibleIds,busy,filtering);
      if(reveal)revealLayerRow(layer.id);

      addMask.disabled=!canEdit||hasImageLayerMask(layer);
      footerStack=stackActions(layer,image.layers,origin,!busy);
      stackButtons.forEach((control,i)=>{
        const action=footerStack[i];
        control.disabled=!action?.enabled;
        if(action){labelButton(control,action.label);control.title=action.reason||action.label+(action.shortcut?' · '+action.shortcut:'');}
      });
      updateBatchFeedback();
    }else{
      curveEditor?.dispose();curveEditor=null;
      body.replaceChildren();
      const layerType={pixel:'像素层',image:'图像层',gradient:'渐变填充',adjustment:'调整图层',shape:'形状层',group:'图层组'};
      body.append(el('strong','document-properties-heading',c?.target==='mask'?'图层蒙版':layer?layer.text?'文字层':layerType[layer.kind]:'图像文档'));
      addControl(body,'文档名称','text',image.name,name=>command(project,{action:'update',patch:{name}}));
      const colorSpace=choice('图像颜色空间',[['srgb','颜色（sRGB）'],['linear','数据（线性）']],image.colorSpace,value=>void run(()=>command(project,{action:'update',patch:{colorSpace:value}})));body.append(colorSpace);enhanceSelectMenu(colorSpace);
      const refs=doc.paint.layers.flatMap(layer=>Object.entries(layer.documentMaps??{}).filter(([,id])=>id===c.documentId).map(([channel])=>({layer,channel})));
      const documentActions=el('div','document-property-actions');
      const duplicate=button('复制贴图',()=>{
        const origin=imageSelectionOrigin(project),documentId=crypto.randomUUID();
        duplicate.disabled=true;
        void run(async()=>{
          await commandAt(project,origin,{action:'duplicate',newDocumentId:documentId});
          const current=imageSelectionOrigin(project);
          if(!disposed&&current.id===origin.id&&current.documentId===origin.documentId&&current.layerId===origin.layerId&&current.target===origin.target)
            selectImage(project,{documentId,layerId:origin.layerId,target:'pixels'});
        }).finally(()=>{if(duplicate.isConnected)duplicate.disabled=documents.length>=imageDocumentLimit||!!ctx.busy?.();});
      });
      duplicate.disabled=busy||documents.length>=imageDocumentLimit;
      duplicate.title=documents.length>=imageDocumentLimit?'工程最多包含 16 个图像文档':'复制贴图的全部图层和蒙版';
      const remove=button('删除贴图',()=>void run(()=>command(project,{action:'remove'})),'删除图像文档');
      const embeddedUsers=Object.values(doc.paint.imageDocuments).some(source=>source.layers.some(l=>l.embedded?.documentId===c.documentId));
      remove.disabled=!!refs.length||embeddedUsers;remove.title=embeddedUsers?'源稿仍被内嵌实例引用':refs.length?'请先解除材质通道引用':'删除图像文档';
      documentActions.append(duplicate,remove);
      body.append(el('div','document-muted',`${image.width} × ${image.height} · RGBA`),documentActions);
      if(layer){addControl(body,'图层名称','text',layer.name,name=>command(project,{action:'updateLayer',layerId:layer.id,patch:{name}}),{disabled:!!lockOwner});addControl(body,'锁定图层','checkbox',layer.locked,locked=>command(project,{action:'updateLayer',layerId:layer.id,patch:{locked}}),{disabled:!!lockOwner&&lockOwner!==layer});
        if(layer.adjustment&&c.target!=='mask')renderAdjustment(layer,busy);
        if(layer.shape&&c.target!=='mask')renderShape(layer,busy);
        if(c.target!=='mask'&&!['group','adjustment'].includes(layer.kind))renderBlendIf(layer,!!lockOwner||busy);
        if(c.target!=='mask'&&imageStyleKinds.includes(layer.kind))renderStyles(layer,!!lockOwner||busy);
        if(layer.text&&c.target!=='mask'){const edit=button('编辑文字…',()=>editText(layer));edit.disabled=layer.locked;body.append(edit);}
        if(layer.gradient&&c.target!=='mask'){
          const disabled=!!lockOwner||busy;
          const update=(key,index,value)=>{
            const gradient={...layer.gradient,[key]:layer.gradient[key].map((previous,i)=>i===index?value:previous)};
            return command(project,{action:'updateLayer',layerId:layer.id,patch:{gradient}});
          };
          for(const [index,label] of ['起点','终点'].entries()){
            addControl(body,label+'颜色','color',layer.gradient.colors[index],color=>update('colors',index,color),{disabled});
            addControl(body,label+'不透明度','number',layer.gradient.alpha[index],alpha=>update('alpha',index,alpha),{min:0,max:1,step:'any',disabled});
          }
        }
        if(c.target==='mask'){
          const disabled=!!lockOwner||busy;
          addControl(body,'启用蒙版','checkbox',layer.maskEnabled,maskEnabled=>command(project,{action:'updateLayer',layerId:layer.id,patch:{maskEnabled}}),{disabled});
          addControl(body,'链接图层和蒙版','checkbox',layer.maskLinked!==false,maskLinked=>
            command(project,{action:'updateLayer',layerId:layer.id,patch:{maskLinked}}),{disabled});
          for(const [field,label,value,max,suffix] of [
            ['maskDensity','密度',(layer.maskDensity??1)*100,100,'%'],
            ['maskFeather','羽化',layer.maskFeather??0,maxUVFeather,' px']
          ]){
            const owner={};
            const operation=(number,origin)=>({op:'image',action:'updateLayer',documentId:origin.documentId,layerId:layer.id,
              patch:{[field]:field==='maskDensity'?number/100:number}});
            const control=addControl(body,label,'number',value,number=>{
              const origin=imageSelectionOrigin(project);
              return project.commands([operation(number,origin)],origin);
            },{min:0,max,step:.1,disabled},(number,origin)=>{
              if(number===null){clearAdjustment(owner);return;}
              adjustmentEditing={owner,origin};
              ctx.imageAdjustment?.(owner,origin,operation(number,origin));
            });
            control.dataset.scrubSpeed=field==='maskDensity'?'1':'.5';
            control.dataset.scrubSuffix=suffix;
          }
          const maskActions=el('div','document-mask-actions');
          for(const [label,action] of [['反相蒙版','invertMask'],['删除蒙版','removeMask']]){
            const control=button(label,()=>void run(()=>command(project,{action,layerId:layer.id})));
            control.disabled=disabled;maskActions.append(control);
          }
          if(layer.maskGradient){
            const remove=button('移除渐变',()=>void run(()=>command(project,{action:'updateLayer',layerId:layer.id,patch:{maskGradient:null}})));
            remove.disabled=disabled;maskActions.append(remove);
          }
          body.append(maskActions);
          if(['image','pixel','shape'].includes(layer.kind)){
            const treatment=layer.edgeDecontaminate??{color:'#ffffff',amount:0};
            const update=patch=>command(project,{action:'updateLayer',layerId:layer.id,
              patch:{edgeDecontaminate:{...treatment,...patch}}});
            const clean=el('details','property-section'),cleanBody=el('div','property-section-body');
            clean.append(el('summary','','边缘去杂色'),cleanBody);body.append(clean);
            clean.open=!!treatment.amount;
            addControl(cleanBody,'原背景颜色','color',treatment.color,color=>update({color}),{disabled});
            addControl(cleanBody,'去杂色强度','number',treatment.amount*100,value=>update({amount:value/100}),{min:0,max:100,step:1,disabled});
          }
        }
        if(layer.kind==='image'&&c.target!=='mask'){for(const [name,key,min,max] of [['位置 X','x',0,1],['位置 Y','y',0,1],['缩放','scale',1/4096,4],['旋转','rotation',-360,360]])addControl(body,name,'number',layer[key],value=>command(project,{action:'updateLayer',layerId:layer.id,patch:{[key]:value}}),{min,max,step:'any'});}
      }
      body.append(el('strong','document-properties-heading','材质引用'));for(const {layer,channel} of refs){
        const reference=el('div','document-reference');reference.append(el('span','',layer.name+' · '+channelSpecs[channel].name));
        reference.append(button('定位',()=>ctx.openMaterial?.(layer.id),'定位材质图层 '+layer.name));
        const unlink=button('解除',()=>void run(()=>{const documentMaps={...layer.documentMaps};delete documentMaps[channel];return project.commands([{op:'update',id:layer.id,patch:{documentMaps}}]);}),'解除材质引用 '+layer.name+' · '+channelSpecs[channel].name);unlink.disabled=!!layerLockOwner(doc.paint.layers,layer);reference.append(unlink);body.append(reference);
      }if(!refs.length)body.append(el('div','document-muted','尚未绑定材质通道'));
      const assets=Object.entries(doc.paint.assets).filter(([,asset])=>!isSelectionAsset(asset));if(assets.length){const select=choice('图像层素材',[['','选择素材…'],...assets.map(([id,a])=>[id,a.name])],'',asset=>{if(!asset)return;const origin=imageSelectionOrigin(project),name=doc.paint.assets[asset].name;void run(()=>addImageAsset(project,origin,asset,name));});body.append(select);enhanceSelectMenu(select);}
    }
    if(ctx.busy?.())for(const control of body.querySelectorAll('input,select,button'))control.disabled=true;
  }
  const unsub=project.subscribe(sync);
  sync();
  return {
    sync,kind:type==='layers'?'imageLayers':'imageProperties',domain:'image',
    editCommand:name=>name==='selectAll'&&type==='layers'?selectAllRows():undefined,
    getState:()=>toggle?{layerFilterOpen:filterOpen,layerQuery:search.value,layerKind:kind.value,collapsedImageGroups:[...collapsedGroups].slice(-256)}:{curveChannel},
    isEditing:()=>!!renaming||!!reorder||!!adjustmentEditing||!!groupDialog?.open,
    activate(){project.setEditorDomain('image');},
    dispose(){
      disposed=true;
      clearTimeout(feedbackTimer);
      curveEditor?.dispose();curveEditor=null;
      if(adjustmentEditing)clearAdjustment(adjustmentEditing.owner);
      unsub();
      thumbnailObserver?.disconnect();
      finishRename({commit:false});
      clearRows();
      menu?.dispose();
      adjustmentsMenu?.dispose();
      groupDialog?.remove();
    }
  };
}
