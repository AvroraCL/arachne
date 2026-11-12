import {copyImagePixels,copiedImage,onImageClipboardChange,imageClipboardPlacement,clipboardPngSize} from './image-clipboard.mjs';
import {headerControls,chromeButton,createContextActions} from './area-chrome.mjs';
import {surfaceControls,selectionControls} from './area-paint-controls.mjs';
import {createSurfaceTools} from './paint-tools.mjs';
import {createLiveView} from './paint-live-view.mjs';
import {hasImageLayerMask,imageDocumentLimit,imageClippingBase,surfaceToImageCommand} from './image-documents.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {workspaceIcons} from './workspace-icons.mjs';
import {layerLockOwner} from './paint-layer-tree.mjs';
import {channelSpecs,paintChannels} from './paint-channels.mjs';
import {maskGray} from './paint-colors.mjs';
import {createBrushBinding} from './paint-brush-binding.mjs';
import {hasAssetDrag,readAssetDrag} from './paint-asset-drag.mjs';
import {createImageEditorSelection} from './image-editor-selection.mjs';
import {pauseImageThumbnail,updateImageThumbnail} from './image-layer-thumbnails.mjs';
import {createImageGradientTool} from './image-gradient-tool.mjs';
import {createImageFillTool} from './image-fill-tool.mjs';
import {createImageCloneTool} from './image-clone-tool.mjs';
import {uvShapePayload,maxUVFeather} from './uv-selection-region.mjs';
import {imageAdjustments,newImageAdjustment,imageBlendGroups} from './image-adjustments.mjs';
import {createCurveEditor} from './image-curve-editor.mjs';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
function button(text,action,label=text){const b=el('button','',text);b.type='button';b.onclick=action;b.setAttribute('aria-label',label);b.title=label;return b;}
function choice(label,items,value,change){const s=el('select');s.setAttribute('aria-label',label);for(const [id,name] of items)s.append(new Option(name,id));s.value=value;s.onchange=()=>change(s.value);return s;}
const selectionNames={rect:'矩形选区',ellipse:'椭圆选区',lasso:'套索'};
const imageDragTypes={layer:'application/x-arachne-image-layer',mask:'application/x-arachne-image-mask'};
const currentDocument=project=>{const documents=project.document?.paint.imageDocuments??{},id=project.imageContext?.documentId;return Object.hasOwn(documents,id)?documents[id]:null;};
const currentLayer=project=>currentDocument(project)?.layers.find(l=>l.id===project.imageContext?.layerId);
function selectImage(project,patch){
  const selection={...project.imageContext,...patch};
  if(selection.target!=='mask'||patch.target&&!patch.inspectMask)delete selection.inspectMask;
  project.selectImage(selection,undefined,{force:true});
  if(!project.isImageEditorActive||project.isImageEditorActive())project.setEditorDomain('image');
}
async function command(project,op){return project.commands([{op:'image',documentId:project.imageContext?.documentId,...op}]);}
async function commandAt(project,origin,op){return project.commands([{op:'image',documentId:origin.documentId,...op}],origin);}
export function imageSelectionOrigin(project){const c=project.imageContext;return {...project.origin(),documentId:c?.documentId,layerId:c?.layerId,target:c?.target};}
function selectAddedLayer(project,origin,layerId){const c=project.imageContext;if(project.document?.id===origin.id&&c?.documentId===origin.documentId&&c?.layerId===origin.layerId&&c?.target===origin.target)selectImage(project,{layerId,target:'pixels'});}
async function addPixel(project,origin){
  const layerId=crypto.randomUUID(),layers=project.document.paint.imageDocuments[origin.documentId].layers;
  const index=layers.findIndex(layer=>layer.id===origin.layerId)+1||layers.length;
  await commandAt(project,origin,{action:'addLayer',layerId,kind:'pixel',index});
  selectAddedLayer(project,origin,layerId);
}
export async function addImageAsset(project,origin,asset,name,position){const layerId=crypto.randomUUID();await project.commands([{op:'image',documentId:origin.documentId,action:'addLayer',layerId,kind:'image',patch:{asset,name,...position}}],origin);selectAddedLayer(project,origin,layerId);}
function remember(project){try{localStorage.setItem('arachne-image-selection:'+project.document.id,JSON.stringify(project.imageContext));}catch{}}
export function createDocumentEditor(ctx,bridge){
  bridge={...bridge,...bridge.imageColors};
  const {host,state}=ctx,life=new AbortController(),signal=life.signal,imageView=createImageEditorSelection(ctx.project,{areaId:ctx.areaId,saved:state.imageSelections,onChange:ctx.onChange}),project=imageView.project;
  const header=el('div','editor-toolbar'),picker=choice('图像文档',[],'',value=>{if(painter.isEditing()||selection.isTransforming())return;selectImage(project,{documentId:value||null,layerId:null,target:'pixels'});});
  const run=fn=>Promise.resolve().then(fn).catch(error=>{status.textContent=error.message;ctx.error(error);});
  const create=button('新建贴图',()=>{const origin=imageSelectionOrigin(project),documentId=crypto.randomUUID(),layerId=crypto.randomUUID();void run(async()=>{
    await project.commands([{op:'image',action:'create',documentId,patch:{name:'未命名贴图 '+(Object.keys(project.document.paint.imageDocuments??{}).length+1)}},{op:'image',action:'addLayer',documentId,layerId,kind:'pixel'}],origin);
    const c=project.imageContext;if(!disposed&&project.document?.id===origin.id&&c?.documentId===origin.documentId&&c?.layerId===origin.layerId&&c?.target===origin.target)selectImage(project,{documentId,layerId,target:'pixels'});
  });});
  const channel=choice('材质引用通道',paintChannels.map(k=>[k,channelSpecs[k].name]),state.channel||'color',()=>{syncDestination(true);ctx.onChange();});
  const destination=choice('材质引用图层',[],'',()=>{});
  const bind=button('应用至材质',()=>{const origin=imageSelectionOrigin(project),materialLayerId=destination.value||undefined,newLayerId=materialLayerId?undefined:crypto.randomUUID(),targetChannel=channel.value,imageName=currentDocument(project)?.name;void run(async()=>{
    if(!origin.documentId||!imageName)throw Error('请先打开图像文档');
    const operations=[{op:'image',action:'bind',documentId:origin.documentId,channel:targetChannel,...(materialLayerId?{materialLayerId}:{newLayerId})}];
    if(newLayerId)operations.push({op:'update',id:newLayerId,patch:{name:('贴图 · '+imageName).slice(0,100)}});
    await project.commands(operations,origin);
  });});
  let destinationDocument=null,destinationProject=null,destinationChannel=null,destinationOptionsKey='',pickerOptionsKey='';
  function syncDestination(force=false){
    const id=project.imageContext?.documentId,doc=project.document;if(!doc)return;
    const previous=destinationProject===doc.id&&destinationDocument===id&&destinationChannel===channel.value&&!force?destination.value:'';destinationDocument=id;destinationProject=doc.id;destinationChannel=channel.value;
    const linked=id&&doc.paint.layers.find(l=>l.kind==='fill'&&l.documentMaps?.[channel.value]===id);
    const layers=doc.paint.layers.filter(l=>l.kind==='fill'&&!l.materialId),key=JSON.stringify([doc.id,layers.map(l=>[l.id,l.name])]);
    if(destinationOptionsKey!==key){destinationOptionsKey=key;destination.replaceChildren(new Option('新建材质填充层',''),...layers.map(l=>new Option(l.name,l.id)));}
    destination.value=previous||linked?.id||'';syncSelectMenu(destination);
  }
  const copy=button('复制图像选区',()=>copySelection()),paste=button('粘贴为图像层',pasteSelection);
  const download=chromeButton(button('导出当前贴图 PNG',downloadDocument),'download');
  download.classList.add('document-export-button');
  download.title='导出当前贴图 · 4096 × 4096 PNG';
  chromeButton(copy,'copy');chromeButton(paste,'paste');
  copy.title='复制图像选区 · ⌘ / Ctrl + C';paste.title='粘贴为图像层 · ⌘ / Ctrl + V';
  copy.disabled=paste.disabled=download.disabled=true;
  let copying=false,exportRequest=null;
  header.append(picker,create,channel,destination,bind,copy,paste,download);headerControls(ctx,header);
  const options=el('div','document-tool-options'),toolName=el('strong','document-current-tool','抓手');
  const parameters=el('div','document-tool-parameters'),viewOptions=el('div','document-view-options');
  const rail=el('aside','document-tools'),stage=el('div','editor-image-stage document-image-stage'),canvas=el('canvas'),empty=el('div','document-empty'),status=el('output','editor-message');
  options.setAttribute('role','group');options.setAttribute('aria-label','图像工具选项');
  viewOptions.setAttribute('role','group');viewOptions.setAttribute('aria-label','画布缩放');
  parameters.addEventListener('wheel',event=>{
    if(event.deltaX||!event.deltaY||event.ctrlKey||event.metaKey||parameters.scrollWidth<=parameters.clientWidth)return;
    const unit=event.deltaMode===1?16:event.deltaMode===2?parameters.clientWidth:1;
    event.preventDefault();parameters.scrollLeft+=event.deltaY*unit;
  },{passive:false,signal});
  const sampleNotice=el('span','document-sample-status');
  sampleNotice.setAttribute('role','status');sampleNotice.hidden=true;
  rail.setAttribute('aria-label','图像绘制工具');canvas.setAttribute('aria-label','图像文档画布');canvas.tabIndex=0;stage.tabIndex=0;stage.append(canvas,empty);empty.append(el('strong','','图像文档'),el('span','','新建贴图，或从材质通道打开已有图像文档。'),button('新建贴图',()=>create.click(),'创建第一个图像文档'));
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
  parameters.append(controls.bar);
  options.append(toolName,parameters,viewOptions);
  host.classList.add('document-editor');host.append(options,rail,stage,status);elements['live-uv']=canvas;elements['viewport']=controls.dummy;elements['uv-brush-cursor'].className='area-uv-cursor';stage.append(elements['uv-brush-cursor']);
  let mode=state.tool||'orbit',selectionShape=Object.hasOwn(selectionNames,state.selectionTool)?state.selectionTool:'rect',space=false,nav=null,pan=state.pan||[0,0],zoom=state.zoom||1,selection=null,disposed=false,shown=true,lastImage='',lastTarget=null,lastProject=null,sourceKey='',restoredProject=null;
  let painter,gradientTool,bucketTool,cloneTool,pendingImageEdit=null,previewCaption='',fillGroup=state.fillGroup==='bucket'?'bucket':'gradient';
  function extent(){return Math.max(1,Math.min(stage.clientWidth,stage.clientHeight)-48);}
  function layout(){
    if(!shown)return;
    const size=extent();
    canvas.style.width=canvas.style.height=size+'px';
    canvas.style.transform=`translate(-50%,-50%) translate(${pan[0]}px,${pan[1]}px) scale(${zoom})`;
    if(previewCaption){
      const label=`${(size*zoom/4096*100).toFixed(1)}%　文档 4096 × 4096　${project.imageContext?.inspectMask?'蒙版 · ':''}${previewCaption}`;
      if(status.textContent!==label)status.textContent=label;
    }
    painter?.refreshUVCursor();
    selection?.sync();gradientTool?.layout();cloneTool?.layout();ctx.onChange();
  }
  const imageOrigin=()=>({id:project.document?.id,revision:project.document?.revision,imageDocumentId:project.imageContext?.documentId});
  const mapOperation=(op,origin)=>op?surfaceToImageCommand(op,origin?.imageDocumentId||project.imageContext?.documentId):null;
  function draft(op,origin){const mapped=mapOperation(op,origin);live.update(mapped);project.draft(mapped);}
  const writing=()=>bridge.busy()||!!pendingImageEdit;
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
    context:()=>{const doc=project.document,c=project.imageContext;if(!doc||!currentDocument(project))return null;const prefs=bridge.preferences();return {id:doc.id,revision:doc.revision,documentId:c.documentId,inspectMask:c.inspectMask?c.layerId:null,channel:'color',detail:prefs.autoDetail,detailDelay:prefs.detailDelay,key:JSON.stringify([doc.id,doc.revision,c.documentId,c.inspectMask?c.layerId:null])};},
    onStatus:(text,error,detail)=>{if(disposed)return;if(!detail){previewCaption='';status.title=status.textContent=text;return;}const {size=0,revision,phase,message,failedSize}=detail;stage.dataset.previewSize=String(size);stage.dataset.previewRevision=String(revision??'');stage.dataset.previewPhase=phase||'';status.title=message||text;
      if(sampleNotice.dataset.pending&&sampleFrame(imageOrigin()))showSampleNotice();
      const actual=size?`实际预览 ${size} × ${size}${size===4096?' · 4K':''}`:'等待实时预览',suffix=phase==='refining'?' · 正在提升到 4K…':phase==='retrying'?' · 预览暂不可用，正在重试…':phase==='error'?` · ${failedSize===4096?'4K 更新失败':'预览更新失败'} · 点击重试`:'';
      previewCaption=actual+suffix;status.tabIndex=phase==='error'?0:-1;if(phase==='error')status.setAttribute('role','button');else status.removeAttribute('role');layout();}});
  function showSampleNotice(text='',pending=false){
    sampleNotice.textContent=text;sampleNotice.hidden=!text;
    if(pending)sampleNotice.dataset.pending='true';else delete sampleNotice.dataset.pending;
  }
  function sampleFrame(origin){
    const frame=live.getFrame(),request=frame?.request;
    return request&&request.id===origin.id&&request.revision===origin.revision&&
      request.documentId===origin.imageDocumentId&&!request.inspectMask&&!request.operation?frame:null;
  }
  function sampleImage(hit,origin){
    if(origin.maskTarget)return false;
    const frame=sampleFrame(origin);
    if(!frame){showSampleNotice('等待当前图像预览',true);return false;}
    const {pixels,request:{size}}=frame;
    const x=Math.min(size-1,Math.floor(hit.u*size)),y=Math.min(size-1,Math.floor(hit.v*size)),offset=(y*size+x)*4;
    if(!pixels[offset+3]){showSampleNotice('此处没有可取样的颜色');return false;}
    const color='#'+Array.from(pixels.subarray(offset,offset+3),n=>n.toString(16).padStart(2,'0')).join('');
    showSampleNotice();bridge.setForeground(color);syncColors();
    return true;
  }
  status.onclick=()=>{if(stage.dataset.previewPhase==='error')live.retryDetail();};status.onkeydown=event=>{if(stage.dataset.previewPhase==='error'&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();live.retryDetail();}};
  function brushContext(){
    const layer=currentLayer(project),origin=imageOrigin(),maskTarget=project.imageContext?.target==='mask',busy=writing();
    return {...origin,busy,enabled:false,uvEnabled:!!layer&&!busy,brushColor:bridge.foreground(),
      maskValue:maskTarget&&elements['brush-erase'].checked?maskGray(bridge.colorPair('mask').background):bridge.maskInk(),maskTarget,
      layer:layer?{...layer,kind:layer.kind==='pixel'?'paint':'image',channels:{color:true,metallic:false,roughness:false},
        values:{color:bridge.foreground(),metallic:0,roughness:.5}}:null};
  }
  painter=createSurfaceTools({viewport:{},host:controls.dummy,uvHost:stage,elements,settingsKey:'arachne-document-brush:'+ctx.areaId,preserveUnavailableMode:true,stickySample:true,sampleAnyLayer:true,isHandHeld:()=>space||!!nav,uvClip:()=>selection?.clip(),onIdle:()=>sync(),
    context:brushContext,cloneTool:()=>cloneTool,
    preview:draft,commit:(op,origin)=>void save(op,origin),sample:sampleImage,place:()=>{}});
  const brushBinding=createBrushBinding({project,painter});
  selectionControls(elements,parameters,stage);
  elements['uv-ellipse-tool']=button(selectionNames.ellipse);
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
  elements['uv-selection-options'].prepend(selectionModes,featherLabel);
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
  elements['uv-selection-options'].append(invertSelectionButton,fitSelectionButton);
  parameters.append(transformOptions,elements['uv-selection-options'],sampleNotice);
  selection=bridge.createSelection({pane:stage,canvas,elements,isHandHeld:()=>space||!!nav,
    context:()=>{const l=currentLayer(project),origin=imageOrigin(),editable=!!l&&!l.locked&&!bridge.busy(),pixels=project.imageContext?.target!=='mask';return {...origin,id:l?.id,projectId:origin.id,active:!!currentDocument(project),interactive:!painter.isEditing()&&!nav,image:l?.kind==='image'?{x:l.x,y:l.y,scale:l.scale,rotation:l.rotation,stretch:l.stretch,size:[project.document.paint.assets[l.asset].width,project.document.paint.assets[l.asset].height]}:null,canTransform:editable&&pixels&&(l.kind==='image'||l.kind==='pixel'&&!!l.strokes?.length),canClear:editable&&pixels&&l.kind==='pixel',canFillMaterial:editable&&pixels&&l.kind==='pixel',canFillMask:editable};},
    activate:()=>{setMode('select');return true;},onTransformState:syncToolName,selectionMode:state.selectionMode,selectionFeather:state.selectionFeather,onMode:ctx.onChange,onError:ctx.error,
    preview:op=>draft(op),commit:(op,origin)=>save(op,{...origin,id:origin.projectId}),
    fillOperation:(rect,target,value,shape)=>painter.fillUV(rect,target,value,shape,{opacity:1})});
  for(const [id,label,icon,key] of [['uv-select-tool',selectionNames.rect,'marquee','M'],['uv-ellipse-tool',selectionNames.ellipse,'ellipseMarquee','Shift+M'],['uv-lasso-tool',selectionNames.lasso,'lasso','L'],['uv-transform-tool','自由变换','transform','V'],['surface-orbit','抓手','hand','H'],['surface-paint','画笔','brush','B'],['uv-eraser-tool','橡皮擦','eraser','E'],['surface-sample','取样','eyedropper','I']]){
    const control=elements[id];control.textContent=label;chromeButton(control,icon,label);
    control.title=label+' · '+key;control.setAttribute('aria-keyshortcuts',key);rail.append(control);
  }
  elements['uv-transform-tool'].title='自由变换 · V / Ctrl T / ⌘T · 方向键微移 · Shift 十像素';
  elements['uv-transform-tool'].setAttribute('aria-keyshortcuts','V Control+T Meta+T');
  const textTool=button('文字工具',()=>{selection.stop();setMode('text');});
  chromeButton(textTool,'text');textTool.title='文字工具 · T';textTool.setAttribute('aria-keyshortcuts','T');rail.append(textTool);
  const gradientButton=button('渐变工具',()=>{selection.stop();setMode('gradient');stage.focus({preventScroll:true});});
  chromeButton(gradientButton,'gradient');gradientButton.title='渐变工具 · G / Shift+G';gradientButton.setAttribute('aria-keyshortcuts','G Shift+G');
  rail.insertBefore(gradientButton,elements['surface-sample']);
  const bucketButton=button('油漆桶',()=>{selection.stop();setMode('bucket');stage.focus({preventScroll:true});});
  chromeButton(bucketButton,'paintBucket');bucketButton.title='油漆桶 · G / Shift+G · 取样当前像素层';
  bucketButton.setAttribute('aria-keyshortcuts','G Shift+G');
  rail.insertBefore(bucketButton,elements['surface-sample']);
  const cloneButton=button('仿制图章',()=>{
    selection.stop();elements['brush-erase'].checked=false;setMode('clone');stage.focus({preventScroll:true});
  });
  chromeButton(cloneButton,'cloneStamp');
  cloneButton.title='仿制图章 · S · Alt / Option 单击取样';
  cloneButton.setAttribute('aria-keyshortcuts','S');
  rail.insertBefore(cloneButton,gradientButton);
  for(const [id,shape] of [['uv-select-tool','rect'],['uv-ellipse-tool','ellipse'],['uv-lasso-tool','lasso']])elements[id].addEventListener('click',()=>{selectionShape=shape;syncToolName();ctx.onChange();});
  elements['surface-orbit'].onclick=()=>{selection.stop();setMode('orbit');};elements['surface-paint'].onclick=()=>{selection.stop();elements['brush-erase'].checked=false;setMode(project.imageContext?.target==='mask'?'mask':'paint');};elements['uv-eraser-tool'].onclick=()=>{selection.stop();elements['brush-erase'].checked=true;setMode(project.imageContext?.target==='mask'?'mask':'paint');};elements['surface-sample'].onclick=()=>{if(project.imageContext?.target!=='mask'){selection.stop();setMode('sample');}};
  const colors=el('div','document-colors'),front=el('input'),back=el('input');front.type=back.type='color';front.setAttribute('aria-label','图像前景色');back.setAttribute('aria-label','图像背景色');colors.append(back,front,button('⇄',()=>colorKey('x'),'交换图像前景色和背景色'),button('◩',()=>colorKey('d'),'恢复图像黑白'));rail.append(colors);
  function colorTarget(){return project.imageContext?.target==='mask'?'mask':'paint';}
  function syncColors(){
    const target=colorTarget(),pair=bridge.colorPair(target);
    front.value=pair.foreground;back.value=pair.background;
    for(const input of [front,back])input.toggleAttribute('data-color-gray',target==='mask');
    gradientTool?.sync();
  }
  front.oninput=()=>{bridge.setColor(colorTarget(),'foreground',front.value);syncColors();};back.oninput=()=>{bridge.setColor(colorTarget(),'background',back.value);syncColors();};
  function colorKey(key){bridge.colorKey(key,colorTarget());syncColors();painter.render();}
  function syncToolName(transforming=selection?.isTransforming()){
    const caption=transforming?'自由变换':{orbit:'抓手',paint:elements['brush-erase'].checked?'橡皮擦':'画笔',mask:elements['brush-erase'].checked?'蒙版橡皮擦':'蒙版画笔',select:selectionNames[selectionShape],sample:'取样',text:'文字',gradient:'渐变',bucket:'油漆桶',clone:'仿制图章'}[mode];
    if(toolName.textContent===caption)return;
    toolName.textContent=caption;
    parameters.scrollLeft=0;
  }
  function setMode(next){
    mode=next;showSampleNotice();
    if(next==='bucket'||next==='gradient')fillGroup=next;
    stage.toggleAttribute('data-text-placement',next==='text');
    painter.setMode(['select','text','gradient','bucket'].includes(next)?'orbit':next);
    textTool.setAttribute('aria-pressed',String(next==='text'));
    gradientButton.setAttribute('aria-pressed',String(next==='gradient'));
    bucketButton.setAttribute('aria-pressed',String(next==='bucket'));
    cloneButton.setAttribute('aria-pressed',String(next==='clone'));
    gradientTool?.setActive(next==='gradient');
    bucketTool?.setActive(next==='bucket');
    cloneTool?.setActive(next==='clone');
    syncToolName();
    controls.bar.hidden=!['paint','mask','clone'].includes(next);ctx.onChange();
  }
  const fitCanvas=button('适应画布',()=>{zoom=1;pan=[0,0];layout();}),actualSize=button('100%',()=>{zoom=4096/extent();pan=[0,0];layout();});
  chromeButton(fitCanvas,'fit');fitCanvas.append(el('span','document-fit-label','适应画布'));
  fitCanvas.title='适应画布 · Ctrl 0 / ⌘0';fitCanvas.setAttribute('aria-keyshortcuts','Control+0 Meta+0');
  actualSize.title='实际像素 · Ctrl 1 / ⌘1';actualSize.setAttribute('aria-keyshortcuts','Control+1 Meta+1');viewOptions.append(fitCanvas,actualSize);
  function fitSelection(){
    const region=selection.clip();
    if(!region||selection.isDragging()||selection.isTransforming())return false;
    const [left,top,right,bottom]=region.clip,size=extent();
    const fitted=Math.min(Math.max(1,stage.clientWidth-48)/(right-left),Math.max(1,stage.clientHeight-48)/(bottom-top));
    zoom=Math.max(.03,Math.min(40,fitted/size));
    pan=[(.5-(left+right)/2)*size*zoom,(.5-(top+bottom)/2)*size*zoom];
    layout();
    return true;
  }
  stage.addEventListener('pointerdown',event=>{if(gradientTool?.isEditing())return;if(event.button===1||event.button===0&&(space||mode==='orbit'&&!event.target.closest('svg'))){nav={pointer:event.pointerId,x:event.clientX,y:event.clientY,pan:[...pan]};painter.refreshUVCursor();stage.setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();}},{capture:true,signal});
  stage.addEventListener('pointermove',event=>{if(nav?.pointer!==event.pointerId)return;pan=[nav.pan[0]+event.clientX-nav.x,nav.pan[1]+event.clientY-nav.y];layout();},{signal});
  const end=event=>{if(nav?.pointer!==event.pointerId)return;nav=null;painter.refreshUVCursor();if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);};for(const name of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(name,end,{signal});
  stage.addEventListener('wheel',event=>{event.preventDefault();if(gradientTool?.isEditing())return;const before=zoom;zoom=Math.max(.03,Math.min(40,zoom*Math.exp(-event.deltaY*.001)));const r=stage.getBoundingClientRect(),x=event.clientX-r.x-r.width/2,y=event.clientY-r.y-r.height/2;pan=[x-(x-pan[0])*zoom/before,y-(y-pan[1])*zoom/before];layout();},{passive:false,signal});
  gradientTool=createImageGradientTool({stage,canvas,parameters,signal,settings:state.gradient,onChange:ctx.onChange,
    context:()=>{
      const origin=imageSelectionOrigin(project),image=currentDocument(project),layer=currentLayer(project);
      const index=layer?image.layers.indexOf(layer)+1:image?.layers.length??0;
      const editable=origin.target==='pixels'||origin.target==='mask'&&hasImageLayerMask(layer)&&!layer.locked;
      return {origin,layer,index,colors:bridge.colorPair(colorTarget()),selection:selection.clip(),
        enabled:!!image&&editable&&!writing()&&!painter.isEditing()&&!selection.isTransforming()&&!nav&&!space};
    },
    preview:operation=>{live.update(operation);project.draft(operation);},
    commit:(operation,origin,added)=>submitEdit(operation,origin,added?()=>selectAddedLayer(project,origin,operation.layerId):undefined)
  });
  function canPaintPixels(){
    const layer=currentLayer(project);
    return layer?.kind==='pixel'&&layer.visible&&!layer.locked&&project.imageContext?.target!=='mask'&&!writing();
  }
  bucketTool=createImageFillTool({stage,canvas,parameters,signal,settings:state.bucket,onChange:ctx.onChange,
    context:()=>({origin:imageSelectionOrigin(project),layer:currentLayer(project),color:bridge.foreground(),
      selection:selection.clip(),enabled:canPaintPixels()&&!selection.isTransforming()&&!nav&&!space}),
    commit:submitEdit,sample:([u,v])=>sampleImage({u,v},imageOrigin())});
  cloneTool=createImageCloneTool({stage,canvas,parameters,settings:state.clone,context:brushContext,onChange:ctx.onChange});
  function canPaste(){
    return !!currentDocument(project)&&!writing()&&!painter.isEditing()&&!gradientTool.isEditing()&&!selection.isDragging()&&!selection.isTransforming()&&!nav;
  }
  function canCopy(merged=false){
    if(!canPaste()||copying)return false;
    if(merged)return currentDocument(project).layers.some(layer=>layer.visible&&layer.opacity>0&&layer.kind!=='adjustment');
    const layer=currentLayer(project);
    return project.imageContext?.target!=='mask'&&!!layer?.visible&&layer.kind!=='adjustment'&&layer.opacity>0;
  }
  function syncClipboard(){
    copy.disabled=!canCopy();paste.disabled=!canPaste()||!copiedImage();
    copy.setAttribute('aria-busy',String(copying));
    download.disabled=!canPaste()||!!exportRequest;
    download.setAttribute('aria-busy',String(!!exportRequest));
    download.title=exportRequest?'正在导出 4K PNG…':'导出当前贴图 · 4096 × 4096 PNG';
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
    const origin=imageSelectionOrigin(project),region=selection.clip()||{clip:[0,0,1,1]};
    copying=true;syncClipboard();
    status.textContent=merged?'正在复制可见图层…':'正在复制 4K 像素…';
    void copyImagePixels(origin,region,{merged}).then(({width,height})=>{
      if(!disposed)status.textContent=`${merged?'已合并复制':'已复制'} ${width} × ${height} px`;
    }).catch(error=>{
      if(!disposed&&error.name!=='AbortError'){status.textContent=error.message;ctx.error(error);}
    }).finally(()=>{if(!disposed){copying=false;syncClipboard();}});
    return true;
  }
  function importFile(file,position,pixelSize=false){
    const origin=imageSelectionOrigin(project),layerId=crypto.randomUUID();
    void run(async()=>{
      if(!origin.documentId)throw Error('请先新建贴图');
      const placement=pixelSize?imageClipboardPlacement(...await clipboardPngSize(file)):position;
      await bridge.importDocumentAsset(file,origin,layerId,placement);
      if(!disposed)selectAddedLayer(project,origin,layerId);
    });
  }
  function pasteSelection(){
    const entry=copiedImage();
    if(!entry||!canPaste())return false;
    const c=project.imageContext;
    const center=entry.projectId===project.document.id&&entry.documentId===c?.documentId?entry.center:undefined;
    importFile(entry.file,imageClipboardPlacement(entry.width,entry.height,center));
    return true;
  }
  const stopClipboard=onImageClipboardChange(syncClipboard);
  host.addEventListener('copy',event=>{
    if(!event.target.closest('input,textarea,[contenteditable]')&&copySelection()){
      event.preventDefault();event.stopPropagation();
    }
  },{signal});
  host.addEventListener('paste',event=>{
    if(event.target.closest('input,textarea,[contenteditable]')||!canPaste())return;
    const file=[...event.clipboardData?.items||[]].find(item=>item.type==='image/png')?.getAsFile();
    if(file){event.preventDefault();event.stopPropagation();importFile(file,undefined,true);}
    else if(!event.clipboardData?.types.length&&pasteSelection()){event.preventDefault();event.stopPropagation();}
  },{signal});
  function dropPosition(event){const r=canvas.getBoundingClientRect(),x=(event.clientX-r.left)/r.width,y=(event.clientY-r.top)/r.height;return r.width&&r.height&&x>=0&&x<=1&&y>=0&&y<=1?{x,y}:null;}
  canvas.addEventListener('click',event=>{
    if(mode!=='text'||event.button!==0||space||nav||bridge.busy())return;
    const placement=dropPosition(event),origin=imageSelectionOrigin(project);
    if(!placement||!origin.documentId)return;
    bridge.openImageText(origin,null,placement,bridge.foreground(),layerId=>{
      if(!disposed)selectAddedLayer(project,origin,layerId);
    });
  },{signal});
  stage.addEventListener('dragover',event=>{const transfer=event.dataTransfer;if(!hasAssetDrag(transfer)&&!transfer?.types.includes('Files'))return;event.preventDefault();transfer.dropEffect=currentDocument(project)&&dropPosition(event)?'copy':'none';},{signal});
  stage.addEventListener('drop',event=>{
    const transfer=event.dataTransfer;if(!hasAssetDrag(transfer)&&!transfer?.types.includes('Files'))return;
    event.preventDefault();event.stopPropagation();const position=dropPosition(event);
    if(!currentDocument(project)){ctx.error(Error('请先新建贴图'));return;}
    if(!position){ctx.error(Error('请将图片放到画布内'));return;}
    if(transfer.types.includes('Files')){const files=[...transfer.files],file=files[0];if(files.length!==1||!(file.type==='image/png'||!file.type&&/\.png$/i.test(file.name))){ctx.error(Error('每次可拖入一张 PNG 图片'));return;}importFile(file,position);return;}
    const dragged=readAssetDrag(transfer,project.document);if(!dragged){ctx.error(Error('素材所属工程或修订已变化，请重新拖动'));return;}
    const origin=imageSelectionOrigin(project),name=project.document.paint.assets[dragged.id].name;void run(()=>addImageAsset(project,origin,dragged.id,name,position));
  },{signal});
  function handleKey(event){
    if(event.defaultPrevented||event.isComposing||event.target.closest('input,textarea,select,.custom-select,[contenteditable]'))return false;
    const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
    if((key===' '||key==='enter')&&event.target.closest('button,summary'))return false;
    if(key!=='escape'&&(painter.isEditing()||gradientTool.isEditing()||selection.isDragging()||nav)){
      event.preventDefault();event.stopPropagation();return true;
    }
    let handled=true;
    if((event.altKey!==mod)&&!event.shiftKey&&(key==='backspace'||key==='delete')){
      const {clip,...shape}=selection.clip()||{clip:[0,0,1,1]};
      const mask=colorTarget()==='mask',slot=event.altKey?'foreground':'background';
      const color=bridge.colorPair(colorTarget())[slot];
      const op=!selection.isTransforming()&&painter.fillUV(clip,mask?'mask':'material',maskGray(color),shape,{opacity:1,color});
      handled=!!op;
      if(op)void save(op,imageOrigin());
    }else if(mod&&!event.altKey){
      if(key==='c')handled=copySelection(event.shiftKey);
      else if(key==='i'&&event.shiftKey)handled=selection.invert();
      else if(key==='i'){
        const layer=currentLayer(project);
        handled=project.imageContext?.target==='mask'&&hasImageLayerMask(layer)&&!layer.locked&&
          (!!pendingImageEdit||!bridge.busy())&&!selection.isTransforming();
        if(handled){
          const origin=imageSelectionOrigin(project),previous=pendingImageEdit;
          void run(async()=>{
            if((previous&&!await previous)||disposed)return;
            const current=imageSelectionOrigin(project);
            if(current.id!==origin.id||current.documentId!==origin.documentId||current.layerId!==origin.layerId||current.target!=='mask')return;
            await submitEdit({op:'image',action:'invertMask',documentId:current.documentId,layerId:current.layerId},current);
          });
        }
      }
      else if(key==='z')void project.travel(event.shiftKey?'redo':'undo').catch(ctx.error);
      else if(key==='a')selection.selectAll(selectionShape);
      else if(key==='d'&&event.shiftKey)handled=selection.reselect();
      else if(key==='d')selection.clear();
      else if(key==='t')selection.start();
      else if(event.code==='Digit0'&&event.shiftKey)handled=fitSelection();
      else if(key==='0'){zoom=1;pan=[0,0];layout();}
      else if(key==='1'){zoom=4096/extent();pan=[0,0];layout();}
      else if(['=','+','-'].includes(key)){
        const before=zoom;zoom=Math.max(.03,Math.min(40,zoom*(key==='-'?.8:1.25)));
        pan=pan.map(value=>value*zoom/before);layout();
      }else handled=false;
    }else if(mod&&event.altKey&&(event.code==='KeyG'||key==='g')&&!event.shiftKey){
      const image=currentDocument(project),layer=currentLayer(project),index=image?.layers.indexOf(layer);
      handled=!!layer&&!layer.locked&&!writing()&&!selection.isTransforming()&&!!imageClippingBase(image.layers,index);
      if(handled){
        const origin=imageSelectionOrigin(project);
        void run(()=>commandAt(project,origin,{action:'setClipping',layerId:layer.id,clipped:!layer.clipped}));
      }
    }else if(event.altKey)handled=false;
    else if(key===' '){space=true;painter.refreshUVCursor();}
    else if(key==='escape'){
      nav=null;painter.cancel({preserveMode:true});
      if(!gradientTool.cancel()&&!selection.cancel())selection.clear();
    }else if(key==='m'){
      const elliptical=selectionShape==='ellipse';
      const tool=event.shiftKey!==elliptical?'uv-ellipse-tool':'uv-select-tool';
      elements[tool].click();
    }
    else if(key==='l')elements['uv-lasso-tool'].click();
    else if(key==='v')handled=selection.start();
    else if(key==='t')textTool.click();
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
    else if(key==='h')elements['surface-orbit'].click();
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
  host.addEventListener('keyup',event=>{if(event.key===' '){space=false;painter.refreshUVCursor();}},{signal});window.addEventListener('blur',()=>{space=false;nav=null;gradientTool.cancel();painter.cancel({preserveMode:true});selection.cancel();},{signal});
  const resize=new ResizeObserver(layout);resize.observe(stage);
  function sync(reselect=false){
    if(disposed||!shown||!project.document)return;const doc=project.document;
    brushBinding.sync(reselect);
    if(restoredProject!==doc.id){restoredProject=doc.id;let saved;try{saved=JSON.parse(localStorage.getItem('arachne-image-selection:'+doc.id));}catch{}if(!project.imageContext&&saved?.documentId)project.selectImage(saved);}
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
      let next=mode;if(c?.target==='mask'&&mode!=='gradient'&&(mode==='paint'||targetChanged||first&&!state.tool))next='mask';else if(c?.target!=='mask'&&mode==='mask')next='paint';
      lastImage=imageKey;lastTarget=c?.target;lastProject=doc.id;gradientTool.cancel();painter.cancel({preserveMode:true});selection.stop();setMode(next);if(next==='select')selection.choose(selectionShape,{focus:false});if(imageView.isActive())remember(project);
    }
    const documents=Object.entries(doc.paint.imageDocuments??{}),optionsKey=JSON.stringify([doc.id,documents.map(([id,d])=>[id,d.name])]);if(pickerOptionsKey!==optionsKey){pickerOptionsKey=optionsKey;picker.replaceChildren(new Option('选择图像文档',''),...documents.map(([id,d])=>new Option(d.name,id)));}
    const next=JSON.stringify([doc.id,doc.revision]);if(sourceKey!==next){sourceKey=next;syncDestination();}else if(destinationDocument!==c?.documentId)syncDestination();
    picker.value=c?.documentId||'';syncSelectMenu(picker);textTool.disabled=bind.disabled=!image||writing();gradientButton.disabled=!image||writing()||c?.target==='mask'&&!!layer?.locked;bucketButton.disabled=cloneButton.disabled=!canPaintPixels();bucketTool.sync();cloneTool.layout();empty.hidden=!!image;canvas.hidden=!image;if(!image){live.clear();previewCaption='';status.textContent='';delete stage.dataset.previewSize;delete stage.dataset.previewRevision;}ctx.title.textContent=image?image.name+' · RGBA':'';painter.render();selection.sync();syncColors();syncClipboard();live.refresh();
  }
  const unsub=project.subscribe(event=>sync(event.kind==='resource'));sync();if(mode==='select')selection.choose(selectionShape,{focus:false});else setMode(mode);
  return {kind:'image',sync,handleKey,getBrushSettings:()=>painter.getSettings(),preferencesChanged:()=>live.preferencesChanged(),activate(){imageView.activate();project.setEditorDomain('image');},getState:()=>({zoom,pan,tool:mode,selectionTool:selectionShape,selectionMode:selection.getCombination(),selectionFeather:selection.getFeather(),gradient:gradientTool.getState(),bucket:bucketTool.getState(),clone:cloneTool.getState(),fillGroup,eraser:elements['brush-erase'].checked,channel:channel.value,imageSelections:imageView.getState()}),isEditing:()=>!!pendingImageEdit||painter.isEditing()||gradientTool.isEditing()||selection.isDragging()||selection.isTransforming(),
    canCopyMerged:()=>canCopy(true),copyMerged:()=>copySelection(true),
    getSelection(origin){return shown&&project.document?.id===origin.id&&project.imageContext?.documentId===origin.documentId&&
      !selection.isDragging()&&!selection.isTransforming()?selection.clip():null;},
    previewAdjustment(origin,operation){
      if(shown&&project.document?.id===origin.id&&project.imageContext?.documentId===origin.documentId&&
         (!operation||project.document.revision===origin.revision)&&!painter.isEditing()&&!gradientTool.isEditing())
        live.update(operation);
    },
    setVisible(visible){
      if(shown===visible)return;
      shown=visible;live.setVisible(visible);
      if(!visible)gradientTool.cancel();
      if(visible)sync();
    },
    dispose(){disposed=true;exportRequest?.abort();unsub();stopClipboard();gradientTool.cancel();imageView.dispose();life.abort();painter.dispose();selection.dispose();live.dispose();resize.disconnect();},setPaintMode(next){setMode(next);}};
}

export function createImagePanel(type,ctx){
  ctx.root.dataset.layerDomain='image';
  const {host,project}=ctx,tools=el('div','editor-toolbar'),body=el('div','document-panel editor-scroll'),error=el('output','editor-message');host.append(body,error);headerControls(ctx,tools);
  const run=fn=>Promise.resolve().then(fn).catch(e=>{error.textContent=e.message;ctx.error(e);});
  let adjustmentEditing=null,curveEditor=null,curveChannel=ctx.state?.curveChannel,curveSelection=null;
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
        if(current.id!==expected.id||current.revision!==expected.revision||current.documentId!==expected.documentId||current.layerId!==expected.layerId)
          throw Error('编辑目标或工程修订已变化，请重新输入');
        if(!input.validity.valid)throw Error('请输入有效的参数');
        return change(next);
      }).finally(()=>{cancel();key='';sync();});
    };
    input.onblur=()=>{if(input.hasAttribute('data-document-dirty')){cancel();key='';sync();}};
    input.onkeydown=event=>{
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
  const filters=el('div','document-layer-filter'),search=el('input'),filterCount=el('output','document-filter-count');
  const kinds=[['all','全部类型'],['pixel','像素层'],['image','图像层'],['gradient','渐变填充'],['adjustment','调整图层'],['text','文字层'],['mask','带蒙版']];
  const kind=choice('筛选图层类型',kinds,kinds.some(([value])=>value===ctx.state?.layerKind)?ctx.state.layerKind:'all',filterChanged);
  let filterOpen=ctx.state?.layerFilterOpen===true;
  search.type='search';search.placeholder='搜索图层';search.setAttribute('aria-label','搜索图像图层');search.value=typeof ctx.state?.layerQuery==='string'?ctx.state.layerQuery:'';search.oninput=filterChanged;
  function resetFilter(){search.value='';kind.value='all';syncSelectMenu(kind);}
  function filterChanged(){sync();ctx.onChange?.();}
  const toggle=type==='layers'?button('',()=>{filterOpen=!filterOpen;if(!filterOpen)resetFilter();filterChanged();if(filterOpen)search.focus();},'筛选图像图层'):null;
  if(toggle){chromeButton(toggle,'search','筛选图像图层');tools.append(toggle);filters.append(search,kind,filterCount);host.insertBefore(filters,body);enhanceSelectMenu(kind);}
  search.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();filterOpen=false;resetFilter();filterChanged();toggle?.focus();}};
  const rowsHost=el('div'),message=el('p','document-muted');
  const actions=el('div','document-layer-actions'),primaryActions=el('div','document-layer-primary-actions');
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
  const adjustmentsMenu=type==='layers'?createContextActions('调整图层类型',failure=>ctx.error(failure)):null;
  const addAdjustment=type==='layers'?chromeButton(button('新建调整图层',openAdjustments),'adjustment'):null;
  addAdjustment?.setAttribute('aria-haspopup','menu');
  if(add){
    actions.setAttribute('role','group');
    actions.setAttribute('aria-label','图层操作');
    primaryActions.append(addMask,addAdjustment,add,stackButtons[3]);
    actions.append(...stackButtons.slice(0,3),primaryActions);
    error.classList.add('document-layer-error');
    host.append(actions);
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
  function openAdjustments(){
    const image=currentDocument(project);
    if(!image||ctx.busy?.())return;
    const origin=imageSelectionOrigin(project),selection=ctx.imageSelection?.(origin);
    const rect=addAdjustment.getBoundingClientRect();
    adjustmentsMenu.open({clientX:rect.left,clientY:rect.bottom},'新建调整图层',
      Object.entries(imageAdjustments).map(([type,{label}])=>({label,icon:'adjustment',run:()=>{
        const layerId=crypto.randomUUID(),index=image.layers.findIndex(layer=>layer.id===origin.layerId)+1;
        const operations=[{op:'image',action:'addLayer',documentId:origin.documentId,layerId,kind:'adjustment',
          index:index||image.layers.length,patch:{name:label,adjustment:newImageAdjustment(type),maskEnabled:!selection}}];
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
    if(!item.text&&item.kind!=='adjustment')updateImageThumbnail(preview,previewContext,item);
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
    if(!view.row.isConnected||view.row.hidden||view.item.locked||ctx.busy?.())return;
    const input=el('input','document-layer-rename'),original=view.item.name;
    renaming={input,view,original,origin:imageSelectionOrigin(project)};
    input.value=original;
    input.setAttribute('aria-label','图像图层名称');
    input.oninput=()=>{input.dataset.documentDirty='';};
    input.onblur=()=>finishRename({commit:true});
    input.onkeydown=event=>{
      if(!['Enter','Escape'].includes(event.key)||event.isComposing)return;
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
  }
  function reorderTarget(event,view){
    if(!reorder||!event.dataTransfer.types.includes(imageDragTypes[reorder.kind])||view.row.hidden)return null;
    const {origin,layerId,kind}=reorder,document=project.document,image=currentDocument(project);
    if(ctx.busy?.()||origin.id!==document?.id||origin.revision!==document.revision||
       origin.documentId!==project.imageContext?.documentId||layerId===view.item.id||!image)return null;
    const from=image.layers.findIndex(item=>item.id===layerId),to=image.layers.findIndex(item=>item.id===view.item.id);
    if(from<0||to<0)return null;
    const source=image.layers[from];
    if(kind==='mask'){
      const copy=event.altKey||source.locked;
      if(view.item.locked||!hasImageLayerMask(source))return null;
      return {edge:'mask',copy};
    }
    if(source.locked)return null;
    const rect=view.row.getBoundingClientRect(),above=event.clientY<rect.top+rect.height/2;
    const index=to+(above?1:0)-(from<to?1:0);
    return index===from?null:{index,edge:above?'above':'below'};
  }
  function bindReorder(view){
    const {row,select,name,mask}=view;
    const startDrag=(event,kind)=>{
      if((kind==='layer'&&view.item.locked)||(kind==='mask'&&!hasImageLayerMask(view.item))||ctx.busy?.()||renaming){
        event.preventDefault();return;
      }
      clearDrag();
      menu.close();
      reorder={origin:imageSelectionOrigin(project),layerId:view.item.id,row,kind};
      row.dataset.dragging='';
      event.dataTransfer.setData(imageDragTypes[kind],view.item.id);
      event.dataTransfer.effectAllowed=kind==='layer'?'move':view.item.locked?'copy':'copyMove';
    };
    for(const [source,kind] of [[select,'layer'],[name,'layer'],[mask,'mask']]){
      source.ondragstart=event=>startDrag(event,kind);
      source.ondragend=clearDrag;
    }
    row.ondragenter=row.ondragover=event=>{
      const target=reorderTarget(event,view);
      if(dropRow&&(!target||dropRow!==row)){
        delete dropRow.dataset.dropEdge;
        dropRow=null;
      }
      if(!target)return;
      event.preventDefault();
      event.dataTransfer.dropEffect=target.copy?'copy':'move';
      if(row.dataset.dropEdge!==target.edge)row.dataset.dropEdge=target.edge;
      dropRow=row;
    };
    row.ondragleave=event=>{
      if(dropRow!==row||row.contains(event.relatedTarget))return;
      delete row.dataset.dropEdge;
      dropRow=null;
    };
    row.ondrop=event=>{
      const target=reorderTarget(event,view);
      if(!target)return;
      event.preventDefault();
      const {origin,layerId,kind}=reorder,targetLayerId=view.item.id;
      clearDrag();
      if(kind==='layer'){
        void run(()=>commandAt(project,origin,{action:'moveLayer',layerId,index:target.index}));
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
  function stackActions(item,index,last,origin,editable){
    const apply=operation=>()=>commandAt(project,origin,{layerId:item.id,...operation()});
    const move=(label,icon,target)=>({label,icon,enabled:editable&&index!==target,run:apply(()=>({action:'moveLayer',index:target}))});
    return [
      move('上移','moveUp',Math.min(last,index+1)),
      move('下移','moveDown',Math.max(0,index-1)),
      {label:'复制',icon:'copy',enabled:editable,run:apply(()=>({action:'duplicateLayer',patch:{id:crypto.randomUUID()}}))},
      {label:'删除',icon:'trash',enabled:editable,run:apply(()=>({action:'removeLayer'}))}
    ];
  }
  function editText(item,origin=imageSelectionOrigin(project)){
    if(item?.text&&!item.locked&&!ctx.busy?.())ctx.openImageText?.(origin,item);
  }
  function selectLayerMask(item,origin=imageSelectionOrigin(project),{inspect=false,reveal=true}={}){
    if(!item||ctx.busy?.())return;
    const hasMask=hasImageLayerMask(item);
    if(item.locked&&!hasMask)return;
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
    if(project.imageContext?.layerId!==item.id)selectImage(project,{layerId:item.id,target:'pixels'});
    const origin=imageSelectionOrigin(project),editable=!item.locked,hasMask=hasImageLayerMask(item);
    const maskAction=action=>()=>commandAt(project,origin,{action,layerId:item.id});
    const update=patch=>()=>commandAt(project,origin,{action:'updateLayer',layerId:item.id,patch});
    const [up,down,copy,remove]=stackActions(item,index,layers.length-1,origin,editable);
    menuTarget={id:item.id,revision:origin.revision};
    // A right-click can open the popover before the pointer is released.
    // Keep the pointer just inside the menu so the release does not dismiss it.
    const position=anchor??{clientX:event.clientX-2,clientY:event.clientY-2};
    menu.open(position,item.name,[
      {label:'重命名',icon:'pen',shortcut:'F2',enabled:editable,run:()=>startRename(view)},
      ...(item.text?[{label:'编辑文字…',icon:'text',enabled:editable,run:()=>editText(item,origin)}]:[]),
      copy,
      {label:item.visible?'隐藏':'显示',icon:item.visible?'hidden':'eye',run:update({visible:!item.visible})},
      {label:item.locked?'解锁':'锁定',icon:item.locked?'unlock':'lock',run:update({locked:!item.locked})},
      null,up,down,null,
      {label:item.clipped?'释放剪贴蒙版':'创建剪贴蒙版',icon:'clippingMask',shortcut:'⌥⌘G',
        enabled:editable&&!!imageClippingBase(layers,index),
        run:()=>commandAt(project,origin,{action:'setClipping',layerId:item.id,clipped:!item.clipped})},
      {label:hasMask?'选择蒙版':'添加蒙版',icon:'mask',enabled:editable||hasMask,run:()=>selectLayerMask(item,origin)},
      ...(hasMask?[
        {label:'单独查看蒙版',icon:'eye',shortcut:'Alt',run:()=>selectLayerMask(item,origin,{inspect:true})},
        {label:item.maskEnabled?'停用蒙版':'启用蒙版',icon:'mask',enabled:editable,run:update({maskEnabled:!item.maskEnabled})},
        {label:'反相蒙版',icon:'invert',enabled:editable,run:maskAction('invertMask')},
        {label:'删除蒙版',icon:'trash',enabled:editable,run:maskAction('removeMask')}
      ]:[{label:ctx.imageSelection?.(origin)?'用蒙版隐藏选区':'用蒙版隐藏全部',icon:'mask',enabled:editable,
        shortcut:'Alt 点击蒙版按钮',run:()=>selectLayerMask(item,origin,{reveal:false})}]),
      null,remove
    ]);
  }
  function makeRow(item){
    const row=el('div','document-layer-row'),preview=el('canvas','document-layer-thumb'),maskPreview=el('canvas'),name=el('span','document-layer-name');
    const textThumb=el('span','document-text-thumbnail');
    textThumb.innerHTML=workspaceIcons.text;textThumb.setAttribute('aria-hidden','true');textThumb.title='双击编辑文字';
    const effectThumb=el('span','document-adjustment-thumbnail');
    effectThumb.innerHTML=workspaceIcons.adjustment;effectThumb.setAttribute('aria-hidden','true');
    const clipMark=el('span','document-layer-clip-mark');
    clipMark.innerHTML=workspaceIcons.clippingMask;
    const view={row,preview,textThumb,effectThumb,maskPreview,name,item,clipMark,nearViewport:!thumbnailObserver};
    function setLayer(patch){
      const origin=imageSelectionOrigin(project);
      void run(()=>commandAt(project,origin,{action:'updateLayer',layerId:item.id,patch}));
    }
    const eye=button('',()=>setLayer({visible:!view.item.visible}));
    const lock=button('',()=>setLayer({locked:!view.item.locked}));
    const select=button('',()=>selectImage(project,{layerId:item.id,target:'pixels'}));
    select.className='document-layer-select';
    select.append(preview,textThumb,effectThumb);
    select.ondblclick=event=>event.target.closest('.document-text-thumbnail')?editText(view.item):startRename(view);
    name.setAttribute('aria-hidden','true');
    name.onclick=()=>{
      if(select.disabled)return;
      select.focus({preventScroll:true});
      select.click();
    };
    name.ondblclick=()=>startRename(view);
    const mask=button('',event=>{
      const layer=view.item;
      if(event.shiftKey){if(!layer.locked)setLayer({maskEnabled:!layer.maskEnabled});return;}
      selectLayerMask(layer,imageSelectionOrigin(project),{inspect:event.altKey});
    });
    mask.className='document-layer-mask';
    const clipEdge=button('',event=>{
      if(!event.altKey){select.click();return;}
      const origin=imageSelectionOrigin(project);
      void run(()=>commandAt(project,origin,{action:'setClipping',layerId:item.id,clipped:!view.item.clipped}));
    });
    clipEdge.className='document-layer-clip-edge';
    clipEdge.tabIndex=-1;
    row.dataset.imageLayerId=item.id;
    row.append(eye,select,mask,name,lock,clipMark,clipEdge);
    Object.assign(view,{eye,select,lock,mask,clipEdge});
    bindReorder(view);
    row.oncontextmenu=event=>openLayerMenu(event,view);
    select.onkeydown=event=>{
      if(event.key==='F2'&&!event.isComposing){
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
  function updateRow(view,item,context,target,busy,base,hasClips){
    const {row,eye,select,preview,textThumb,effectThumb,mask,maskPreview,lock,name,clipMark,clipEdge}=view;
    const selected=item.id===target.layerId,hasMask=hasImageLayerMask(item);
    row.toggleAttribute('data-selected',selected);
    row.toggleAttribute('data-has-mask',hasMask);
    row.toggleAttribute('data-clipped',!!item.clipped);
    row.toggleAttribute('data-clipping-base',hasClips);
    clipMark.hidden=!item.clipped;
    if(item.clipped)clipMark.title='剪贴到底层 '+base?.name;
    clipEdge.hidden=!base||item.locked;
    clipEdge.disabled=busy;
    labelButton(clipEdge,'Alt / Option 单击'+(item.clipped?'释放':'创建')+'剪贴蒙版');
    mask.hidden=!hasMask;
    select.setAttribute('aria-pressed',String(selected&&target.target!=='mask'));
    mask.setAttribute('aria-pressed',String(selected&&target.target==='mask'));
    mask.toggleAttribute('data-disabled',hasMask&&!item.maskEnabled);
    preview.hidden=!!item.text||item.kind==='adjustment';textThumb.hidden=!item.text;effectThumb.hidden=item.kind!=='adjustment';
    if(name.textContent!==item.name){
      name.textContent=item.name;
      name.title=item.name;
    }
    labelButton(select,item.name);
    labelButton(eye,(item.visible?'隐藏 ':'显示 ')+item.name,item.visible?'eye':'hidden');
    labelButton(lock,(item.locked?'解锁 ':'锁定 ')+item.name,item.locked?'lock':'unlock');
    labelButton(mask,'选择蒙版 '+item.name);
    mask.title='选择蒙版 · Alt 单独查看 · Shift 启用或停用 · 拖动移动 · Alt 拖动复制';
    if(hasMask&&!mask.contains(maskPreview))mask.replaceChildren(maskPreview);
    else if(!hasMask&&mask.contains(maskPreview)){
      pauseImageThumbnail(maskPreview);
      maskPreview.remove();
    }
    for(const control of [eye,select,lock])control.disabled=busy;
    mask.disabled=busy;
    mask.draggable=hasMask&&!busy;
    name.draggable=select.draggable=!busy&&!item.locked;
    view.item=item;
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
  function renderRows(image,doc,context,visibleIds,busy){
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
    const previewContext={projectId:doc.id,revision:doc.revision,documentId:context.documentId,colorSpace:image.colorSpace};
    let cursor=rowsHost.firstChild;
    for(let index=image.layers.length-1;index>=0;index--){
      const item=image.layers[index],shown=visibleIds.has(item.id);
      let view=rows.get(item.id);
      if(!view&&!shown)continue;
      if(!view){
        view=makeRow(item);
        rows.set(item.id,view);
        thumbnailObserver?.observe(view.row);
      }
      if(view.row!==cursor)rowsHost.insertBefore(view.row,cursor);
      cursor=view.row.nextSibling;
      if(!shown&&!view.row.hidden){
        if(renaming?.view===view)finishRename({commit:true});
        stopPreviews(view);
      }
      view.row.hidden=!shown;
      if(shown)updateRow(view,item,previewContext,context,busy,
        imageClippingBase(image.layers,index),!item.clipped&&!!image.layers[index+1]?.clipped);
    }
  }
  function renderAdjustment(layer,busy){
    const adjustment=layer.adjustment,spec=imageAdjustments[adjustment.type],disabled=layer.locked||busy;
    const section=el('section','document-adjustment-properties'),heading=el('div','document-adjustment-heading');
    const reset=button('重置调整',()=>void run(()=>command(project,{
      action:'updateLayer',layerId:layer.id,patch:{adjustment:newImageAdjustment(adjustment.type)}
    })));
    reset.disabled=disabled;
    heading.append(el('strong','',spec.label),reset);section.append(heading);
    const update=(key,value)=>command(project,{action:'updateLayer',layerId:layer.id,patch:{adjustment:{...adjustment,[key]:value}}});
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
    for(const [key,field] of Object.entries(spec.fields)){
      if(field.choices){
        const select=choice(field.label,field.choices,adjustment[key],value=>void run(()=>update(key,value)));
        select.disabled=disabled;section.append(select);enhanceSelectMenu(select);
        continue;
      }
      const owner={};
      const min=key==='inputWhite'?adjustment.inputBlack+1:field.min;
      const max=key==='inputBlack'?adjustment.inputWhite-1:field.max;
      const control=addControl(section,field.label,'number',adjustment[key],value=>update(key,value),
        {min,max,step:field.step,disabled},(value,origin)=>{
          if(value===null){clearAdjustment(owner);return;}
          if(!ctx.imageAdjustment||!origin.id||!Number.isFinite(value))return;
          adjustmentEditing={owner,origin};
          ctx.imageAdjustment(owner,origin,{op:'image',action:'updateLayer',documentId:origin.documentId,
            layerId:layer.id,patch:{adjustment:{...adjustment,[key]:value}}});
        });
      control.dataset.scrubSpeed=String(field.step===1?1:field.step);
    }
    body.append(section);
  }
  let key='',pickerOptionsKey='',renderedTarget='';function sync(){
    if(disposed)return;
    const doc=project.document;if(!doc)return;const image=currentDocument(project),layer=currentLayer(project),c=project.imageContext;
    if(adjustmentEditing){
      const {origin,owner}=adjustmentEditing;
      if(origin.id!==doc.id||origin.revision!==doc.revision||origin.documentId!==c?.documentId||origin.layerId!==c?.layerId||origin.target!==c?.target)
        clearAdjustment(owner);
    }
    const targetKey=JSON.stringify([doc.id,c]),next=JSON.stringify([doc.id,doc.revision,c,!!ctx.busy?.(),filterOpen,search.value,kind.value]);if(key===next)return;if(renderedTarget===targetKey&&body.contains(document.activeElement)&&document.activeElement.hasAttribute('data-document-dirty'))return;key=next;renderedTarget=targetKey;
    const selected=project.imageContext?.documentId||'',documents=Object.entries(doc.paint.imageDocuments??{}),optionsKey=JSON.stringify([doc.id,documents.map(([id,d])=>[id,d.name])]);if(pickerOptionsKey!==optionsKey){pickerOptionsKey=optionsKey;picker.replaceChildren(new Option('选择图像文档',''),...documents.map(([id,d])=>new Option(d.name,id)));}picker.value=selected;syncSelectMenu(picker);
    const busy=!!ctx.busy?.();
    if(add)add.disabled=addAdjustment.disabled=!image||busy||image.layers.length>=64;
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
      bar=null;
      curveEditor?.dispose();curveEditor=null;
      body.replaceChildren(el('p','document-muted','没有打开图像文档'));
      return;
    }
    if(type==='layers'){
      const query=filterOpen?search.value.trim().toLocaleLowerCase():'',mode=filterOpen?kind.value:'all';
      const matches=image.layers.filter(item=>item.name.toLocaleLowerCase().includes(query)&&(mode==='all'||mode===(item.text?'text':item.kind)||mode==='mask'&&hasImageLayerMask(item)));
      const visibleIds=new Set(matches.map(item=>item.id));
      const selectedVisible=!!layer&&visibleIds.has(layer.id),canEdit=selectedVisible&&!layer.locked&&!busy;
      filterCount.textContent=matches.length+' / '+image.layers.length+(layer&&!selectedVisible?' · 当前图层不在结果中':'');

      const controls=el('div','document-layer-controls');
      const blend=choice('图像图层混合模式',[],'',value=>{
        const origin=imageSelectionOrigin(project);
        void run(()=>commandAt(project,origin,{action:'updateLayer',layerId:layer.id,patch:{blend:value}}));
      });
      for(const [label,modes] of imageBlendGroups){
        const target=label?el('optgroup'):blend;
        if(label)target.label=label;
        target.append(...modes.map(([value,name])=>new Option(name,value)));
        if(label)blend.append(target);
      }
      blend.value=layer?.blend||'normal';
      blend.disabled=!canEdit;
      controls.append(blend);
      addControl(controls,'不透明度','number',Math.round((layer?.opacity??1)*100),value=>command(project,{action:'updateLayer',layerId:layer.id,patch:{opacity:value/100}}),{min:0,max:100,disabled:!canEdit});
      if(bar)bar.replaceWith(controls);
      else body.replaceChildren(controls,message,rowsHost);
      bar=controls;
      enhanceSelectMenu(blend);
      message.hidden=matches.length>0;
      message.textContent=image.layers.length?'没有匹配的图层':'没有图层';
      renderRows(image,doc,c,visibleIds,busy);

      const index=image.layers.findIndex(item=>item.id===layer?.id);
      addMask.disabled=!canEdit||hasImageLayerMask(layer);
      footerStack=stackActions(layer,index,image.layers.length-1,imageSelectionOrigin(project),canEdit);
      stackButtons.forEach((control,i)=>{control.disabled=!footerStack[i].enabled;});
    }else{
      curveEditor?.dispose();curveEditor=null;
      body.replaceChildren();
      const layerType={pixel:'像素层',image:'图像层',gradient:'渐变填充',adjustment:'调整图层'};
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
      remove.disabled=!!refs.length;remove.title=refs.length?'请先解除材质通道引用':'删除图像文档';
      documentActions.append(duplicate,remove);
      body.append(el('div','document-muted','4096 × 4096 · RGBA'),documentActions);
      if(layer){addControl(body,'图层名称','text',layer.name,name=>command(project,{action:'updateLayer',layerId:layer.id,patch:{name}}));addControl(body,'锁定图层','checkbox',layer.locked,locked=>command(project,{action:'updateLayer',layerId:layer.id,patch:{locked}}));
        if(layer.adjustment&&c.target!=='mask')renderAdjustment(layer,busy);
        if(layer.text&&c.target!=='mask'){const edit=button('编辑文字…',()=>editText(layer));edit.disabled=layer.locked;body.append(edit);}
        if(layer.gradient&&c.target!=='mask'){
          const disabled=layer.locked||busy;
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
          const disabled=layer.locked||busy;
          addControl(body,'启用蒙版','checkbox',layer.maskEnabled,maskEnabled=>command(project,{action:'updateLayer',layerId:layer.id,patch:{maskEnabled}}),{disabled});
          addControl(body,'蒙版底色','number',layer.maskBase,maskBase=>command(project,{action:'updateLayer',layerId:layer.id,patch:{maskBase}}),{min:0,max:1,step:'any',disabled});
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
        }
        if(layer.kind==='image'){for(const [name,key,min,max] of [['位置 X','x',0,1],['位置 Y','y',0,1],['缩放','scale',1/4096,4],['旋转','rotation',-360,360]])addControl(body,name,'number',layer[key],value=>command(project,{action:'updateLayer',layerId:layer.id,patch:{[key]:value}}),{min,max,step:'any'});}
      }
      body.append(el('strong','document-properties-heading','材质引用'));for(const {layer,channel} of refs){
        const reference=el('div','document-reference');reference.append(el('span','',layer.name+' · '+channelSpecs[channel].name));
        reference.append(button('定位',()=>ctx.openMaterial?.(layer.id),'定位材质图层 '+layer.name));
        const unlink=button('解除',()=>void run(()=>{const documentMaps={...layer.documentMaps};delete documentMaps[channel];return project.commands([{op:'update',id:layer.id,patch:{documentMaps}}]);}),'解除材质引用 '+layer.name+' · '+channelSpecs[channel].name);unlink.disabled=!!layerLockOwner(doc.paint.layers,layer);reference.append(unlink);body.append(reference);
      }if(!refs.length)body.append(el('div','document-muted','尚未绑定材质通道'));
      const assets=Object.entries(doc.paint.assets);if(assets.length){const select=choice('图像层素材',[['','选择素材…'],...assets.map(([id,a])=>[id,a.name])],'',asset=>{if(!asset)return;const origin=imageSelectionOrigin(project),name=doc.paint.assets[asset].name;void run(()=>addImageAsset(project,origin,asset,name));});body.append(select);enhanceSelectMenu(select);}
    }
    if(ctx.busy?.())for(const control of body.querySelectorAll('input,select,button'))control.disabled=true;
  }
  const unsub=project.subscribe(sync);
  sync();
  return {
    sync,kind:type==='layers'?'imageLayers':'imageProperties',domain:'image',
    getState:()=>toggle?{layerFilterOpen:filterOpen,layerQuery:search.value,layerKind:kind.value}:{curveChannel},
    isEditing:()=>!!renaming||!!reorder||!!adjustmentEditing,
    activate(){project.setEditorDomain('image');},
    dispose(){
      disposed=true;
      curveEditor?.dispose();curveEditor=null;
      if(adjustmentEditing)clearAdjustment(adjustmentEditing.owner);
      unsub();
      thumbnailObserver?.disconnect();
      finishRename({commit:false});
      clearRows();
      menu?.dispose();
      adjustmentsMenu?.dispose();
    }
  };
}
