import {connectDesktopWorkspace} from './paint-desktop-workspace.mjs';
import {compositionKey} from './text-input.mjs';
import {connectDesktopSettings} from './paint-desktop-settings.mjs';
import {setupProjectFiles} from './paint-project-files.mjs';
import {textureExportPresets} from './texture-export-presets.mjs';
import {maskEffectLabels,maskEffectBlends,maskGeneratorFields,newMaskEffect} from './paint-mask-effects.mjs';
import {setupTaskMonitor} from './paint-task-monitor.mjs';
import {matchesSearch,searchTerms} from './search-picker.mjs';
import {setupProjectWelcome} from './paint-project-welcome.mjs';
import {setupWorkspaceLayouts} from './paint-workspace-layouts.mjs';
import {setupCommandPicker} from './paint-command-picker.mjs';
import {setupRenderCameraBatch} from './render-camera-batch.mjs';
import {setupPaintColorPicker} from './paint-color-picker.mjs';
import {setupProjectPicker} from './paint-project-picker.mjs';
import {paintChannels,channelSpecs,effectiveValues,baseChannelEnabled,channelBlendChoices,layerChannelBlend} from './paint-channels.mjs';
import {installPaintTooltips} from './paint-tooltips.mjs';
import {setupPaintAreas} from './paint-area-adapter.mjs';
import {createContextActions} from './area-chrome.mjs';
import {propertyHeading,propertySection,propertyChannelSwitch,propertyColorValue} from './paint-properties.mjs';
import {evaluateBrushGraph} from './paint-library.mjs';
import {createPaintLibrary} from './paint-library-ui.mjs';
import {setupPaintHistory} from './paint-history.mjs';
import {createShaderEditor} from './paint-shader-editor.mjs';
import {createRenderPreferences,deliveryEditorValues,updateDeliveryOptions,captureDeliverySettings,captureRenderPreset,sameDeliveryCamera} from './paint-delivery-options.mjs';
import {createNativeWorkbench,notifyNativeProject} from './native-workbench.mjs';
import {projectionIsCurrent} from './paint-surface-state.mjs';
import {showGeometryStatus} from './paint-geometry-status.mjs';
import {createViewport} from './viewport3d.mjs';
import {createUVSelection} from './paint-uv-selection.mjs';
import {createPaintModeling} from './paint-modeling.mjs';
import {createModelOutliner} from './paint-model-outliner.mjs';
import {createMaskEditor} from './paint-mask.mjs';
import {createPaintRenderResults} from './paint-render-results.mjs';
import {viewportSamplingOptions,updateViewportSampling} from './cycles-viewport-sampling.mjs';
import {cyclesProgressLabel} from './cycles-progress-ui.mjs';
import {checkRenderAppearance,matchesRenderAppearance,renderAppearanceDefaults,renderLooks} from './render-appearance.mjs';
import {checkRenderLighting,renderLightingDefaults} from './render-lighting.mjs';
import {checkRenderOptics,renderOpticsDefaults} from './render-optics.mjs';
import {checkRenderRegion,renderRegionPixels} from './render-region.mjs';
import {cyclesFormatLabel} from './render-output-ui.mjs';
import {createImageViewer} from './image-viewer.mjs';
import {createPaintTextEditor} from './paint-text-editor.mjs';
import {createLiveView} from './paint-live-view.mjs';
import {createSurfaceTools} from './paint-tools.mjs';
import {setupPaintLayout} from './paint-layout.mjs';
import {setupPaintDisplay} from './paint-display.mjs';
import {setupWorkspaceMotion} from './paint-workspace-motion.mjs';
import {loadPreferences,applyAppearance} from './paint-preferences.mjs';
import {setupPaintSettings} from './paint-settings.mjs';
import {enhanceSelectMenu,setSelectValue,syncSelectMenu} from './paint-select.mjs';
import {scrubNumber} from './studio-fields.mjs';
import {decorateWorkspaceButtons,workspaceIcons} from './workspace-icons.mjs';
import {layerParent,layerChildren,layerIsVisible,layerLockOwner,materialLayerRows} from './paint-layer-tree.mjs';
import {createMaterialLayerDrag} from './material-layer-drag.mjs';
import {navigationCommand,projectionCamera} from './viewport-navigation.mjs';
import {canvasZoomPercent,canvasScale,zoomCanvas,resizeCanvas} from './paint-canvas-navigation.mjs';
import {createPaintColors,maskGray} from './paint-colors.mjs';
import {createMaskThumbnails} from './paint-mask-thumbnails.mjs';
import {startAssetDrag,currentAssetDrag,endAssetDrag,hasAssetDrag,readAssetDrag} from './paint-asset-drag.mjs';

const $=id=>document.getElementById(id);
const [desktopSettings,desktopWorkspace]=await Promise.all([connectDesktopSettings(window,localStorage),connectDesktopWorkspace(window)]);
let preferences=desktopSettings?.initial?.preferences||loadPreferences(localStorage);
applyAppearance(preferences);
const names={...Object.fromEntries(paintChannels.map(k=>[k,channelSpecs[k].name])),x:'横向中心',y:'纵向中心',scale:'缩放',rotation:'旋转角度'};
const geometryStatusNodes={status:$('model-geometry-status'),retry:$('model-geometry-retry'),log:$('model-geometry-log')};
geometryStatusNodes.retry.onclick=()=>run(async()=>{await post('model-prepare');liveView.refresh();});
let shaderEditor=null,historyPanel=null,libraryUI=null,areaSystem=null,taskMonitor=null,cameraBatch=null;
let autoTimer=null,inspectChannel=false,inspectMask=false,isolatedLayerId=null;
let paintTarget='material';
const colorPreferenceKey='arachne-paint-colors-v1';
let savedColors;try{savedColors=JSON.parse(localStorage.getItem(colorPreferenceKey));}catch{}
const paintColors=createPaintColors(savedColors);
let uvPose={scale:1,x:0,y:0},uvPan=null;
let locatingUV=false,uvPin=null;
let uvHandHeld=false,showUVGuide=true,placingText=false;
let uvZoomTool=false,uvZoomDirection='in',uvPointerInside=false,uvZoomMode='fit';
let doc=null,jobs=[],selected=null,busy=false,polling=false,view='uv',textureKey='',selectedAsset=null,drag=null,transform='move';
const projectWrites=new Map(),projectSaveErrors=new Map();
let snapshotTag=null,projectGeneration=0,refreshSequence=0,appliedRefresh=0;
let selection=new Set(),selectionAnchor=null,layerRename=null;
let assetGridKey='';
const canvasAssetSizes=new Map();
let approvedPreviewId=null,approvedRenderSettings=null,propertyDraft=null,pendingBackupId=null;
let collapsedFolders=new Set();
const areaButtons=[...document.querySelectorAll('[data-area-mode]')];
const addLayerControls=['fill','paint-layer','add-folder','decal','uv-text-tool'].map($);
const lockOwner=layer=>doc&&layerLockOwner(doc.paint.layers,layer);
const canAddLayer=()=>doc&&!lockOwner(doc.paint.layers.find(item=>item.id===selectedParent()));
let layerSelectionGeneration=0;
const materialLayerDrag=createMaterialLayerDrag({
  read:()=>doc,
  selection:()=>[...selection],
  canDrag:()=>!busy&&!maskEditor.isOpen()&&!surfaceTools.isEditing(),
  commit:(operation,{id,revision})=>run(()=>api('/api/projects/'+id+'/paint/commands',{revision,operations:[operation]})),
  importSmartMaterial:async(resource,placement,{id,revision})=>{
    const generation=layerSelectionGeneration;
    let imported;
    const saved=await run(async()=>{imported=await api('/api/projects/'+id+'/paint/library-import',{
      revision,libraryRevision:resource.revision,id:resource.id,placement
    });});
    if(saved&&doc?.id===id&&generation===layerSelectionGeneration){
      setSelection([imported.resource.id]);render(true);areaSystem?.materialSelectionChanged();
    }
    return saved;
  }
});
function syncBusyControls(){
  libraryUI?.sync();shaderEditor?.sync();historyPanel?.sync();areaSystem?.busyChanged();taskMonitor?.sync();
  $('open-settings').disabled=busy;
  for(const control of $('empty').querySelectorAll('button'))control.disabled=busy;
  for(const control of [...areaButtons,$('upload')])control.disabled=busy||!doc;
  for(const control of addLayerControls)control.disabled=busy||!canAddLayer();
  renderDrawingLayerSettings();
}
function renderDrawingLayerSettings(){
  const item=doc&&selection.size===1?layer():null;
  const channel=$('layer-channel').value,blendChannel=channel||'color';
  const available=!!item&&item.kind!=='group'&&!lockOwner(item)&&!busy&&!uvSelection.isTransforming()&&!surfaceTools.isEditing();
  const blend=$('drawing-layer-blend'),opacity=$('drawing-layer-opacity');
  blend.disabled=opacity.disabled=!available||!!channel&&!item?.channels?.[channel];
  const blendMode=layerChannelBlend(item,blendChannel);
  if(blend.dataset.channel!==blendChannel){
    blend.dataset.channel=blendChannel;
    blend.replaceChildren(...channelBlendChoices(blendChannel).map(([value,label])=>new Option(label,value)));
  }
  const inactive=channel&&item&&!item.channels?.[channel]?' · 当前图层未启用':'';
  blend.title=channelSpecs[blendChannel].name+'混合'+inactive;
  opacity.title=(channel?channelSpecs[channel].name+'不透明度':'整层不透明度')+inactive;
  if(!busy&&blend.value!==blendMode)setSelectValue(blend,blendMode);
  else syncSelectMenu(blend);
  if(!busy&&document.activeElement!==opacity&&!$('drawing-opacity-label').classList.contains('scrubbing'))
    opacity.value=Number(((channel?item?.channelOpacity?.[channel]??1:item?.opacity??1)*100).toFixed(2));
}
const areaViews={modeling:'three',material:'split',drawing:'uv'};
let workArea='modeling',modelWireframe=false;
view=areaViews[workArea];
let marqueeArmed=false,modelMarquee=null;
const workbenchSessionKey='arachne-paint-session-v1';
function restoreWorkbenchSession(){
  try{return JSON.parse(localStorage.getItem(workbenchSessionKey))||{};}
  catch{return {};}
}
function rememberWorkbenchSession(){
  if(!doc)return;
  try{localStorage.setItem(workbenchSessionKey,JSON.stringify({projectId:doc.id,workArea:areaSystem?.workspace||workArea}));}catch{}
  notifyNativeProject(window,doc);
}
const startingArea=preferences.startupArea==='last'?restoreWorkbenchSession().workArea:preferences.startupArea;
if(Object.hasOwn(areaViews,startingArea)){workArea=startingArea;view=areaViews[workArea];}
const workspaceMotion=setupWorkspaceMotion({switcher:document.querySelector('.area-switch'),workspace:$('workspace'),initialArea:workArea,initialMotion:preferences.motion});
let viewportLoad=null;
const viewport=createViewport({
  host:$('viewport'),animateAxes:true,onStatus:text=>$('viewport-status').textContent=text,
  onModelingPick:event=>{
    if(workArea!=='modeling')return false;
    modeler.pick(event);
    return true;
  }
});
const modelElements=[...document.querySelectorAll('[data-model-element]')];
const modelTools=[...document.querySelectorAll('[data-model-tool]')];
let modelExporting=false,modelHasDraft=false;
const modelOutliner=createModelOutliner({
  select:(id,extend)=>modeler.selectObject(id,extend),
  frame:id=>modeler.frameSelection(id),
  toggleVisibility:id=>modeler.toggleVisibility(id),
  showAll:()=>modeler.showAll(),
  applyNumeric:values=>modeler.applyNumeric(values)
});
const modeler=createPaintModeling(state=>{
  const {mode,element,tool,dragging,summary,hasDraft,activeId,topologyState,localActive}=state;
  modelOutliner.update(state);
  shaderEditor?.setScope(state.materialScope);
  setSelectValue($('model-mode'),mode);
  $('model-mode').disabled=dragging;
  syncSelectMenu($('model-mode'));
  $('model-elements').hidden=mode!=='edit';
  for(const control of [...modelElements,...modelTools]){
    control.disabled=dragging;
    control.setAttribute('aria-pressed',String(control.dataset.modelElement===element||control.dataset.modelTool===tool));
  }
  $('model-status').textContent=summary;
  renderProjectState();
  $('model-status').dataset.topology=topologyState;
  $('model-status').title=topologyState==='fallback'?'原拓扑读取失败，当前使用视口三角网格':
    topologyState==='partial'?'部分几何使用视口三角网格':'建模修改随工程自动保存，可在材质区继续涂装';
  modelHasDraft=hasDraft;
  $('model-export').disabled=!hasDraft||dragging||modelExporting;
  $('model-frame-selection').disabled=dragging||activeId===undefined;
  $('model-local-view').disabled=dragging||(!localActive&&activeId===undefined);
  $('model-local-view').setAttribute('aria-pressed',String(localActive));
  $('model-local-view').title=localActive?'退出局部视图 · /':'隔离所选物体 · /';
}, {
  read:()=>doc,
  travel:async direction=>{
    try{
      doc=await api(route()+'/'+direction,{revision:doc.revision});approvedPreviewId=null;
      viewport.syncDocument(doc);render();schedulePreview(true);
    }catch(error){if(error.status===409)await refresh();throw error;}
  },
  save:async (modeling,revision,id)=>{
    if(doc?.id!==id)throw Error('当前工程已切换');
    try{
      const next=await api(route()+'/model',{revision,modeling});
      if(doc?.id!==id)throw Error('当前工程已切换');
      doc=next;approvedPreviewId=null;
      viewport.syncDocument(doc);render();schedulePreview(true);
    }catch(error){if(error.status===409)await refresh();throw error;}
  }
});
$('model-frame-selection').onclick=()=>modeler.frameSelection();
$('model-local-view').onclick=()=>modeler.toggleLocalView();
$('model-mode').onchange=()=>modeler.setMode($('model-mode').value);
for(const control of modelElements)control.onclick=()=>modeler.setElement(control.dataset.modelElement);
for(const control of modelTools)control.onclick=()=>modeler.setTool(control.dataset.modelTool);
const route=()=>'/api/projects/'+doc.id+'/paint';
function renderProjectState(){
  const name=$('project-name'),status=$('project-save-state');
  name.textContent=doc?.name||'未打开工程';name.title=doc?.name||'';
  const pending=projectWrites.get(doc?.id),failure=projectSaveErrors.get(doc?.id);
  const state=!doc?'empty':pending?'saving':failure?'error':'saved';
  status.dataset.state=state;status.textContent={empty:'',saving:'正在保存…',error:'保存失败',saved:'已保存'}[state];
  status.title=failure||'工程修改自动保存在本机';
  $('open-project-details').disabled=$('open-project-copy').disabled=!doc;
  $('project-detail-name').textContent=doc?.name||'未打开工程';
  $('project-detail-id').textContent=doc?.id||'—';
  $('project-detail-updated').textContent=doc?.updated?new Date(doc.updated).toLocaleString():'—';
  $('open-glb-migration').hidden=!(doc?.source.bindingVersion===2&&doc.source.format!=='glb'&&/\.blend$/i.test(doc.source.reviewSource));
}
async function api(url,data){
  const write=data!==undefined&&url.match(/^\/api\/projects\/([^/]+)\/paint\/(?:commands|model|undo|redo|assets|text|library-import)$/);
  const id=write?.[1];
  if(id){projectWrites.set(id,(projectWrites.get(id)||0)+1);renderProjectState();}
  try{
    const response=await fetch(url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const result=await responseJson(response);if(id)projectSaveErrors.delete(id);return result;
  }catch(error){if(id)projectSaveErrors.set(id,error.message);throw error;}
  finally{if(id){projectWrites.set(id,projectWrites.get(id)-1);renderProjectState();}}
}
async function responseJson(response){
  const value=await response.json();
  if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});
  return value;
}
function element(tag,text){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
function localButton(text,action){const node=element('button',text);node.type='button';node.onclick=action;return node;}
function button(text,action){return localButton(text,()=>run(action));}
function link(text,url){const node=element('a',text);node.href=url;return node;}
function layer(){return doc.paint.layers.find(l=>l.id===selected);}
function setSelection(ids=[],current=ids.at(-1)??null,anchor=current){
  layerSelectionGeneration++;
  const leavingMask=paintTarget==='mask';
  selection=new Set(ids);selected=current;selectionAnchor=anchor;inspectMask=false;
  paintTarget='material';
  const materialId=doc?.paint.layers.find(l=>l.id===current)?.materialId;
  if(materialId)libraryUI?.select('materials',materialId);
  if(leavingMask){$('brush-erase').checked=false;surfaceTools.setMode(layer()?.kind==='paint'?'paint':'orbit');}
  if(isolatedLayerId&&current!==isolatedLayerId&&!isLayerUnder(doc?.paint.layers.find(item=>item.id===current),isolatedLayerId)){
    isolatedLayerId=null;
  }
}
function selectLayer(l,event){
  const active=layer(),parent=layerParent(l);
  if(active&&layerParent(active)===parent){
    if(event.shiftKey){
      const siblings=layerChildren(doc.paint.layers,parent).map(item=>item.id);
      const anchor=siblings.includes(selectionAnchor)?selectionAnchor:active.id;
      const start=siblings.indexOf(anchor),end=siblings.indexOf(l.id);
      setSelection(siblings.slice(Math.min(start,end),Math.max(start,end)+1),l.id,anchor);return;
    }
    if(event.metaKey||event.ctrlKey){
      if(selection.has(l.id))setSelection([...selection].filter(id=>id!==l.id));
      else setSelection([...selection,l.id],l.id);
      return;
    }
  }
  setSelection([l.id]);
}
function selectMaterialLayerById(id,event){
  const item=doc?.paint.layers.find(layer=>layer.id===id);
  if(!item||maskEditor.isOpen()||surfaceTools.isEditing())return;
  selectLayer(item,event);
  render(true);
  areaSystem?.materialSelectionChanged();
}
function inspectedMask(){return inspectMask&&layer()?.kind!=='group'?layer():null;}
const hasLayerMask=l=>Boolean(l.mask||l.maskBase===0||l.maskStrokes?.length||l.maskEffects?.length||typeof l.maskEnabled==='boolean');
function renderPaintColors(){
  const target=paintTarget==='mask'?'mask':'paint',pair=paintColors.pair(target);
  for(const slot of ['foreground','background']){
    const input=$(slot+'-color');input.value=pair[slot];
    input.toggleAttribute('data-color-gray',target==='mask');
    input.parentElement.title=(slot==='foreground'?'前景色':'背景色')+' · '+pair[slot].toUpperCase()+(target==='mask'?' · 蒙版灰度':'');
  }
  for(const input of document.querySelectorAll('[data-paint-foreground]')){
    input.value=paintColors.pair('paint').foreground;
    const readout=input.closest('label')?.querySelector('.property-color-value');
    if(readout)readout.textContent=input.value.toUpperCase();
  }
  $('paint-color-controls').dataset.target=target;
  const gray=maskGray(paintColors.pair('mask')[paintTarget==='mask'&&$('brush-erase').checked?'background':'foreground']),custom=$('brush-ink').querySelector('[value=custom]');
  custom.hidden=gray===0||gray===1;custom.textContent='灰度 '+Math.round(gray*100)+'%';
  const value=gray===0?'0':gray===1?'1':'custom';
  if($('brush-ink').value!==value)setSelectValue($('brush-ink'),value);
}
function changePaintColors(change,target=paintTarget==='mask'?'mask':'paint'){
  if(surfaceTools.isEditing())return;
  change(target);
  try{localStorage.setItem(colorPreferenceKey,JSON.stringify(paintColors.snapshot()));}catch{}
  renderPaintColors();surfaceTools.render();renderCanvasChrome();
}
function assetUrl(id){return route()+'/assets/'+id;}
const assetViewer=createImageViewer({resolve:id=>{
  const asset=doc?.paint.assets[id];
  if(!asset)return null;
  const size=asset.width&&asset.height?' · '+asset.width+'×'+asset.height:'';
  return {id,url:assetUrl(id),title:asset.name+size};
}});
function filteredAssets(assets){
  const terms=searchTerms($('asset-search').value);
  return assets.filter(asset=>matchesSearch(asset.name,terms));
}
function showAsset(id,from,visibleAssets){
  if(!doc?.paint.assets[id])return;
  const galleryIds=visibleAssets||filteredAssets(Object.values(doc.paint.assets)).map(asset=>asset.id);
  assetViewer.open(id,{from,galleryIds});
}
$('asset-view').onclick=()=>showAsset(selectedAsset,$('asset-view'));
function maskOptions(l){return {projectId:doc.id,revision:doc.revision,layer:l,source:l.mask?assetUrl(l.mask):null};}
function command(operations){return post('commands',{operations});}
function post(action,extra={}){return api(route()+'/'+action,{revision:doc.revision,...extra});}
function edit(patch){const l=layer();return command([l?{op:'update',id:l.id,patch}:{op:'base',patch}]);}
function clearPropertyDraft(){
  if(!propertyDraft)return;
  propertyDraft=null;
  updatePaintDraft(null);
}
function livePropertyField(text,type,value,makePatch,options={},selectedLayer=layer()){
  const operation=value=>selectedLayer
    ? {op:'update',id:selectedLayer.id,patch:makePatch(value)}
    : {op:'base',patch:makePatch(value)};
  return field(text,type,value,null,{...options,previewOperation:operation});
}
function field(text,type,value,change,options={}){
  const {dragSpeed,previewOperation,...attributes}=options;
  const label=element('label',type==='number'?'':text),input=element(type==='select'?'select':'input');
  input.setAttribute('aria-label',text);
  if(type==='select')for(const [id,name] of options.choices)input.append(new Option(name,id));
  else {input.type=type;if(type==='number')Object.assign(input,{step:'any',...attributes});}
  if(type==='checkbox')input.checked=value;else input.value=value??'';
  const currentValue=()=>type==='checkbox'?input.checked:type==='number'?input.valueAsNumber:input.value;
  const snapshot=previewOperation?{projectId:doc.id,revision:doc.revision}:null;
  const isCurrent=()=>doc?.id===snapshot.projectId&&doc.revision===snapshot.revision&&input.isConnected;
  function draft(){
    const context=liveContext();
    if(!isCurrent()||!context||context.inspectMask||busy||surfaceTools.isEditing()||uvSelection.isTransforming())return;
    const next=currentValue();
    if(!input.validity.valid||next===value||type==='number'&&!Number.isFinite(next)){
      if(propertyDraft===input)clearPropertyDraft();
      return;
    }
    propertyDraft=input;
    updatePaintDraft(previewOperation(next));
  }
  input.onchange=()=>{
    if(snapshot&&(!isCurrent()||uvSelection.isTransforming())){
      input.value=value;
      if(propertyDraft===input)clearPropertyDraft();
      return;
    }
    void run(async()=>{
      const next=currentValue();
      try{
        if(snapshot){
          const {projectId,revision}=snapshot;
          await api('/api/projects/'+projectId+'/paint/commands',{revision,operations:[previewOperation(next)]});
        }else await change(next);
      }catch(error){
        if(snapshot||type==='number')input.value=value;
        if(propertyDraft===input)clearPropertyDraft();
        throw error;
      }
    }).then(ok=>{if(!ok&&propertyDraft===input)clearPropertyDraft();});
  };
  if(snapshot){
    input.oninput=draft;
    input.onblur=()=>{if(propertyDraft===input&&!busy)clearPropertyDraft();};
    input.onkeydown=event=>{
      if(event.key!=='Escape'||propertyDraft!==input)return;
      event.preventDefault();
      event.stopPropagation();
      input.value=value;
      clearPropertyDraft();
    };
  }
  label.append(input);
  if(type==='number'){
    const caption=element('span',text);
    label.prepend(caption);
    const span=attributes.max-attributes.min;
    input.dataset.scrubSpeed=String(dragSpeed??(Number.isFinite(span)?Math.min(.05,span/200):.05));
    scrubNumber(caption,input,{
      speed:Number(input.dataset.scrubSpeed),
      canStart:()=>!busy&&!surfaceTools.isEditing()&&!maskEditor.isOpen()&&(!snapshot||!uvSelection.isTransforming()),
      onDraft:snapshot?draft:undefined
    });
  }
  if(type==='select')enhanceSelectMenu(input);
  return label;
}
$('properties').onsubmit=event=>event.preventDefault();

const maskEditor=createMaskEditor(async({projectId,revision,layerId,name,data})=>{
  await api('/api/projects/'+projectId+'/paint/assets',{revision,maskLayerId:layerId,name,data});
  await refresh();
});
const paintTextEditor=createPaintTextEditor(async(state,text,error)=>{
  const {projectId,revision,placement,layerId,documentId,onSaved}=state;
  let result;
  const saved=await run(async()=>{
    if(doc?.id!==projectId)throw Error('工程已切换，请重新打开文字编辑');
    result=await api('/api/projects/'+projectId+'/paint/text',{revision,placement,layerId,documentId,text});
    if(documentId!==undefined)return;
    setSelection([result.layerId]);
    if(placement&&collapsedFolders.delete(placement.parentId))saveCollapsedFolders();
    setSelectValue($('source'),'live');setSelectValue($('channel'),'color');setSelectValue($('compare-preview'),'');
    if(result.document.revision===doc.revision)render();
  },error);
  if(saved)onSaved?.(result.layerId);
  return saved;
});
function viewportReady(){
  return !!doc&&$('viewport').dataset.projectId===doc.id&&$('viewport').dataset.state==='ready';
}
function liveContext(){
  if(!doc||$('source').value!=='live')return null;
  // The modular editors own live compositing while the legacy canvas is parked.
  if(areaSystem&&$('live-uv').closest('#editor-parking,[inert]'))return null;
  const {id,revision}=doc,inspectMask=inspectedMask()?.id,isolatedLayer=isolatedLayerId||undefined;
  return {id,revision,modeling:!!doc.modeling?.steps?.length||Object.keys(doc.paint.surfaceBindings||{}).some(key=>key!=='original'),inspectMask,isolatedLayer,channel:$('channel').value,solo:inspectChannel,
    preview3D:!$('viewport').hidden&&viewportReady(),
    detail:preferences.autoDetail,detailDelay:preferences.detailDelay,
    key:JSON.stringify([id,revision,inspectMask,isolatedLayer])};
}
const liveView=createLiveView({viewport,canvas:$('live-uv'),guide:$('uv-guide'),context:liveContext,
  onStatus:(text,error,detail)=>{
    $('viewport-status').textContent=text;$('viewport-status').dataset.error=String(!!error);
    if(!detail)return;
    const output=$('live-resolution'),{size,revision,phase,message,failedSize}=detail;
    output.hidden=phase==='hidden';output.dataset.phase=phase;
    output.dataset.resolution=String(size);output.dataset.revision=String(revision??'');
    output.textContent=(size?`${size} × ${size}${size===4096?' · 4K':''}`:'实时预览')+
      (phase==='refining'?' · 正在提升到 4K…':phase==='retrying'?' · 预览暂不可用，正在重试…':phase==='error'?` · ${failedSize===4096?'4K 更新失败':'预览更新失败'}`:phase==='fast'?(preferences.autoDetail?' · 快速预览':' · 快速预览 · 自动 4K 已关闭'):'');
    output.title=message||`当前实际预览${size?` ${size} × ${size}`:''}${revision===undefined?'':` · r${revision}`}；${preferences.autoDetail?'停笔后自动提升到 4K':'自动 4K 提升已关闭'}，交付仍需确认同版烘焙。`;
    $('retry-live-detail').hidden=phase!=='error';$('retry-live-detail').textContent=failedSize===4096?'重试 4K':'重试预览';
  }});
function updatePaintDraft(operation){if(areaSystem&&!areaSystem.acceptExternalDraft(operation))return;liveView.update(operation);areaSystem?.draftPreview(operation);}
$('retry-live-detail').onclick=()=>liveView.retryDetail();
shaderEditor=createShaderEditor({host:$('shader-editor'),read:()=>doc,busy:()=>busy||modeler.isDragging(),
  readTarget:()=>libraryUI?.target(),onIdle:()=>libraryUI?.sync(),
  draft:(graph,origin)=>{
    if(origin?.target?.library==='brushes'){
      const saved=doc?.paint.brushes?.[origin.target.id]?.graph;
      if(graph||saved)surfaceTools.setSettings(evaluateBrushGraph(graph||saved));
    }else updatePaintDraft(graph?(origin?.target?{op:'library',library:origin.target.library,id:origin.target.id,action:'update',patch:{graph}}:{op:'shader',graph}):null);
  },
  viewAsset:(id,from)=>showAsset(id,from),
  importImage:(file,nodeId,origin)=>run(async()=>{
    if(doc.id!==origin.id)throw Error('当前工程已切换');
    const data=await pngData(file);
    await api('/api/projects/'+origin.id+'/paint/assets',{revision:origin.revision,nodeId,...(origin.target?{materialId:origin.target.id}:{}),name:file.name,data});
  },$('shader-error')),
  save:(graph,origin)=>run(async()=>{if(doc.id!==origin.id)throw Error('当前工程已切换');await api(route()+'/commands',{revision:origin.revision,operations:[origin.target?{op:'library',library:origin.target.library,id:origin.target.id,action:'update',patch:{graph}}:{op:'shader',graph}]});approvedPreviewId=null;},$('shader-error'))});
let placeImage=null,replaceProjection=null;
const surfaceTools=createSurfaceTools({viewport,host:$('viewport'),uvHost:$('uv-view'),isHandHeld:()=>uvHandHeld||uvZoomTool,onIdle:()=>libraryUI?.sync(),
  uvClip:()=>uvSelection.clip(),
  context:()=>{
    const selected=doc&&selection.size===1?layer():null;
    const enabled=!!liveContext()&&!busy&&!maskEditor.isOpen()&&!$('delivery-dialog').open;
    return {layer:selected&&selected.kind!=='group'?{...selected,visible:layerIsVisible(doc.paint.layers,selected),
      locked:!!lockOwner(selected),projectionCurrent:projectionIsCurrent(doc,selected)}:null,
      id:doc?.id,revision:doc?.revision,
      brushColor:workArea==='drawing'?paintColors.pair('paint').foreground:undefined,
      maskValue:maskGray(paintColors.pair('mask')[$('brush-erase').checked?'background':'foreground']),
      maskTarget:paintTarget==='mask',
      enabled:enabled&&workArea==='material'&&!$('viewport').hidden&&viewportReady(),
      uvEnabled:enabled&&workArea==='drawing'};
  },
  preview:(op,state)=>{if(state.id===doc?.id&&state.revision===doc.revision)updatePaintDraft(op);},
  commit:(op,state)=>void run(async()=>{
    try{await api('/api/projects/'+state.id+'/paint/commands',{revision:state.revision,operations:[op]});}
    catch(error){updatePaintDraft(null);throw error;}
  }),
  place:(projector,hit)=>{if(replaceProjection)void run(()=>replaceSurfaceProjection(projector,hit));else if(placeImage)void run(()=>placeSurfaceAsset(placeImage,projector,hit));},
  sample:(hit,state)=>{
    const values=liveView.sampleMaterial(hit.u,hit.v);
    if(!values){$('status').textContent='等待当前修订的实时材质加载';return false;}
    if(workArea==='drawing'){
      changePaintColors(()=>paintColors.set('paint','foreground',values.color));return true;
    }
    void run(()=>api('/api/projects/'+state.id+'/paint/commands',{revision:state.revision,
      operations:[{op:'update',id:state.layer.id,patch:{values}}]}));
    return true;
  },
  swapInk:()=>changePaintColors(target=>paintColors.swap(target),'mask')
});
libraryUI=createPaintLibrary({host:$('paint-library'),read:()=>doc,uploadMaps:importProjectPngs,
  saveMap:(ops,origin)=>areaSystem.project.commands(ops,origin),
  selectedImage:()=>selectedAsset,
  onImportedImage:id=>{selectedAsset=id;renderAssets();renderAssetRoles();},
  onAppliedSmart:id=>{setSelection([id]);render(true);areaSystem?.materialSelectionChanged();},
  importResource:async(item,libraryRevision)=>{const origin={id:doc.id,revision:doc.revision};let result;const ok=await run(async()=>{result=await api('/api/projects/'+origin.id+'/paint/library-import',{revision:origin.revision,libraryRevision,id:item.id});});return ok===true?result:false;},
  canEdit:()=>!!doc&&!busy&&!shaderEditor?.isEditing()&&!surfaceTools.isEditing()&&!modeler.isDragging()&&!maskEditor.isOpen(),
  selectedLayer:()=>layer(),brushSettings:()=>areaSystem?.brushSettings()||surfaceTools.getSettings(),applyBrush:settings=>surfaceTools.setSettings(settings),
  write:operations=>run(()=>command(operations)),
  openNodes:()=>areaSystem?.areas.openEditor('shader'),
  changed:options=>{updatePaintDraft(null);shaderEditor?.sync();areaSystem?.resourceChanged(options);},
  applyMaterial:id=>run(()=>addAndSelect({op:'add',kind:'fill',parentId:selectedParent(),patch:{name:doc.paint.materials[id].name,materialId:id,channels:Object.fromEntries(paintChannels.map(k=>[k,true]))}}))
});
const uvSelection=createUVSelection({
  pane:$('uv-view'),canvas:$('live-uv'),isHandHeld:()=>uvHandHeld||uvZoomTool,
  context:()=>{
    const selectedLayer=doc&&selection.size===1?layer():null;
    const active=workArea==='drawing'&&!!liveContext();
    const interactive=active&&!busy&&!maskEditor.isOpen()&&!$('delivery-dialog').open&&!surfaceTools.isEditing();
    const image=selectedLayer?.space==='uv'?canvasImageState(selectedLayer):null;
    const painted=selectedLayer?.kind==='paint'&&!!selectedLayer.strokes?.length;
    const editable=interactive&&!!selectedLayer&&!lockOwner(selectedLayer)&&layerIsVisible(doc.paint.layers,selectedLayer);
    return {active,interactive,id:selectedLayer?.id,projectId:doc?.id,revision:doc?.revision,image,
      maskInspection:inspectMask,canTransform:editable&&!inspectMask&&(painted||!!image),
      canClear:editable&&!inspectMask&&painted,
      canFillMaterial:editable&&!inspectMask&&selectedLayer.kind==='paint',canFillMask:editable&&selectedLayer.kind!=='group'};
  },
  activate:()=>{
    if(!doc||workArea!=='drawing'||busy||surfaceTools.isEditing()||maskEditor.isOpen())return false;
    activateSurface('orbit');
    return true;
  },
  preview:operation=>{maskThumbnails.pause();updatePaintDraft(operation);},
  fillOperation:(rect,target,value,polygon)=>surfaceTools.fillUV(rect,target,value,polygon),
  commit:(operation,state)=>run(async()=>{
    try{await api('/api/projects/'+state.projectId+'/paint/commands',{revision:state.revision,operations:[operation]});}
    catch(error){updatePaintDraft(null);throw error;}
  })
});
const maskThumbnails=createMaskThumbnails({context:()=>doc,
  canRun:()=>!busy&&!surfaceTools.isEditing()&&!uvSelection.isDragging()&&!uvSelection.isTransforming()&&!modeler.isDragging()&&!maskEditor.isOpen()&&!shaderEditor?.isEditing()});
function canvasImageState(layer){
  const asset=doc.paint.assets[layer.image];
  const size=asset?.width&&asset?.height?[asset.width,asset.height]:canvasAssetSizes.get(layer.image);
  if(size===undefined&&asset){
    const id=layer.image,img=new Image();
    canvasAssetSizes.set(id,null);
    img.onload=()=>{
      canvasAssetSizes.set(id,[img.naturalWidth,img.naturalHeight]);
      uvSelection.render();
    };
    img.src=assetUrl(id);
  }
  if(!size)return null;
  return {x:layer.x,y:layer.y,scale:layer.scale,rotation:layer.rotation,stretch:layer.uvScale||[1,1],size};
}
function setTextPlacement(active){
  if(placingText===active)return;
  placingText=active;
  $('uv-text-tool').setAttribute('aria-pressed',String(active));
  $('uv-view').toggleAttribute('data-text-placement',active);
  surfaceTools.render();
}
function chooseTextTool(){
  if(!canAddLayer()||workArea!=='drawing'||busy||surfaceTools.isEditing()||uvSelection.isDragging()||
     uvSelection.isTransforming()||maskEditor.isOpen()||paintTextEditor.isOpen||$('delivery-dialog').open)return false;
  if(placingText){setTextPlacement(false);return true;}
  inspectMask=false;
  activateSurface('orbit');
  setTextPlacement(true);
  $('uv-view').focus({preventScroll:true});
  return true;
}
$('uv-text-tool').onclick=chooseTextTool;
function editTextLayer(layer){
  if(busy||lockOwner(layer)||uvSelection.isTransforming()||surfaceTools.isEditing()||maskEditor.isOpen())return;
  setTextPlacement(false);
  paintTextEditor.open({projectId:doc.id,revision:doc.revision,layerId:layer.id},layer);
}
function activateSurface(mode){
  if(selection.size>1&&['paint','mask','fill','sample'].includes(mode))return;
  if(surfaceTools.isEditing()||mode==='sample'&&(layer()?.kind!=='paint'||paintTarget==='mask'))return;
  if(layer()?.kind==='group'&&['paint','mask','fill'].includes(mode))return;
  if(workArea==='modeling'||(workArea==='drawing'&&['place','fill'].includes(mode)))return;
  if(['mask','fill'].includes(mode)&&layer()&&!hasLayerMask(layer())){void selectMaskTarget(layer(),{mode});return;}
  if(['mask','fill'].includes(mode))paintTarget='mask';
  else if(mode==='paint')paintTarget='material';
  if(mode==='fill')$('brush-erase').checked=false;
  setUVZoomTool(false);
  setUVLocateMode(false);
  if(workArea==='drawing')uvSelection.stop();
  setTextPlacement(false);
  if(!['orbit','mask'].includes(mode))inspectMask=false;
  inspectChannel=false;
  setSelectValue($('source'),'live');setSelectValue($('compare-preview'),'');
  if($('channel').value==='coverage')setSelectValue($('channel'),'color');
  if(workArea==='material'&&(view==='projection'||view==='uv'&&mode!=='orbit'))showView('three');
  surfaceTools.setMode(mode);
  render();
}
for(const tool of ['orbit','paint','mask','fill','sample'])$('surface-'+tool).onclick=()=>activateSurface(tool);
$('surface-paint').onclick=()=>chooseBrush(false);
$('uv-eraser-tool').onclick=()=>chooseBrush(true);
function chooseBrush(erase){
  if(!doc||busy||!(layer()?.kind==='paint'||paintTarget==='mask'&&layer()?.kind!=='group')||surfaceTools.isEditing()||uvSelection.isDragging())return;
  $('brush-erase').checked=erase;
  activateSurface(paintTarget==='mask'?'mask':'paint');
}
$('brush-ink-color').onchange=()=>{
  const color=$('brush-ink-color').value;
  if(workArea==='drawing'){changePaintColors(()=>paintColors.set('paint','foreground',color));return;}
  void run(()=>{
    const selectedLayer=layer();
    if(selectedLayer?.kind==='paint')return edit({values:{...selectedLayer.values,color}});
  });
};
for(const slot of ['foreground','background'])$(slot+'-color').onchange=()=>{
  const value=$(slot+'-color').value;
  changePaintColors(target=>paintColors.set(target,slot,value));
};
$('swap-paint-colors').onclick=()=>changePaintColors(target=>paintColors.swap(target));
$('reset-paint-colors').onclick=()=>changePaintColors(target=>paintColors.reset(target));
$('brush-ink').onchange=()=>{
  const value=$('brush-ink').value;
  if(value!=='custom')changePaintColors(()=>paintColors.set('mask',$('brush-erase').checked?'background':'foreground',value==='1'?'#ffffff':'#000000'),'mask');
};
const effectAxes=[['z','朝上'],['-z','朝下'],['x','X 正向'],['-x','X 负向'],['y','Y 正向'],['-y','Y 负向']];
function renderMaskEffects(l,editTarget=edit){
  const effects=l.maskEffects||[],stack=element('fieldset');
  stack.className='property-material mask-effects';
  stack.append(element('legend','蒙版效果'));
  if(effects.length<12)stack.append(field('添加效果','select','',kind=>kind&&editTarget({maskEffects:[...effects,newMaskEffect(kind)]}),
    {choices:[['','选择效果'],...Object.entries(maskEffectLabels)]}));
  for(const [index,effect] of effects.entries()){
    const section=element('section'),label=maskEffectLabels[effect.kind];
    section.className='mask-effect';
    section.append(element('strong',label));
    const change=patch=>editTarget({maskEffects:effects.map((item,i)=>i===index?{...item,...patch}:item)});
    section.append(field('启用'+label,'checkbox',effect.enabled,enabled=>change({enabled})));
    if(effect.enabled) section.append(field(label+'强度','number',effect.opacity,opacity=>change({opacity}),{min:0,max:1}));
    if(effect.enabled&&effect.kind==='levels'){
      for(const [key,name,min,max] of [['black','输入黑点',0,1],['white','输入白点',0,1],['gamma','中间调',.1,5]])
        section.append(field(name,'number',effect[key],value=>change({[key]:value}),{min,max}));
    }
    if(effect.enabled&&['height','facing'].includes(effect.kind)){
      section.append(field(label+'方向','select',effect.axis,axis=>change({axis}),{choices:effectAxes}),
        field('阈值','number',effect.center,center=>change({center}),{min:0,max:1}),
        field('过渡','number',effect.feather,feather=>change({feather}),{min:.01,max:1}));
    }
    if(effect.enabled&&Object.hasOwn(maskGeneratorFields,effect.kind)){
      for(const {key,label,choices,min,max,step,dragSpeed} of maskGeneratorFields[effect.kind])
        section.append(field(label,choices?'select':'number',effect[key],value=>change({[key]:value}),
          choices?{choices}:{min,max,step,dragSpeed}));
    }
    if(effect.enabled&&effect.blend)
      section.append(field(label+'合成','select',effect.blend,blend=>change({blend}),{choices:maskEffectBlends}));
    const actions=element('div');actions.className='bar';
    for(const [delta,text] of [[-1,'上移'],[1,'下移']]){
      const control=button(text,()=>{
        const next=effects.slice();
        [next[index],next[index+delta]]=[next[index+delta],next[index]];
        return editTarget({maskEffects:next});
      });
      control.setAttribute('aria-label',text+label);
      control.disabled=index+delta<0||index+delta>=effects.length;actions.append(control);
    }
    const remove=button('删除',()=>editTarget({maskEffects:effects.filter((_,i)=>i!==index)}));
    remove.setAttribute('aria-label','删除'+label);
    actions.append(remove);section.append(actions);stack.append(section);
  }
  return stack;
}
function propertyImage(assetId){
  const asset=doc.paint.assets[assetId],control=localButton('',()=>showAsset(assetId,control));
  control.className='property-image-slot';control.setAttribute('aria-label','查看贴图 · '+asset.name);
  const thumbnail=element('img');thumbnail.src=assetUrl(assetId);thumbnail.alt='';thumbnail.loading='lazy';
  const text=element('span');text.append(element('strong',asset.name),element('small',asset.width+' × '+asset.height));
  control.append(thumbnail,text);return control;
}
function renderProperties(form=$('properties'),scope=null){
  if(!scope||form.contains(propertyDraft))clearPropertyDraft();
  const scoped=scope!==null,l=scoped?doc.paint.layers.find(item=>item.id===scope.layerId):layer();
  if(scoped&&(scope.projectId!==doc.id||scope.layerId!=null&&!l)){
    form.replaceChildren(element('p','固定的材质图层不可用'));return;
  }
  const revision=doc.revision,projectId=doc.id;
  const checkTarget=()=>{
    if(!form.isConnected||doc?.id!==projectId||doc.revision!==revision||scope?.layerId!=null&&!doc.paint.layers.some(item=>item.id===scope.layerId))throw Error('属性目标或工程修订已变化，请重新编辑');
  };
  const commandTarget=scoped?operations=>{checkTarget();return api('/api/projects/'+projectId+'/paint/commands',{revision,operations});}:command;
  const editTarget=scoped?patch=>commandTarget([l?{op:'update',id:l.id,patch}:{op:'base',patch}]):edit;
  const liveField=(text,type,value,makePatch,options)=>livePropertyField(text,type,value,makePatch,options,l||null);
  const actionBar=()=>layerActions(l,{issue:commandTarget,add:scoped?(...operations)=>{checkTarget();return addAndSelect(...operations);}:addAndSelect});
  const ensureSelected=()=>{if(scoped&&l&&(selected!==l.id||selection.size!==1)){setSelection([l.id]);render();}};
  const values=effectiveValues(l?.values||doc.paint.base);
  const choices=Object.values(doc.paint.assets).map(a=>[a.id,a.name]);
  form.replaceChildren();
  if(!scoped&&selection.size>1){
    propertyHeading(form,{name:'已选 '+selection.size+' 个图层',type:'多选'});
    const actions=element('div');actions.className='bar';
    for(const visible of [true,false]){
      actions.append(button(visible?'显示所选':'隐藏所选',()=>command([...selection].map(id=>({op:'update',id,patch:{visible}})))));
    }
    const group=button('收进新文件夹',groupSelection),duplicate=button('复制所选',duplicateSelection);
    const items=doc.paint.layers.filter(item=>selection.has(item.id));
    group.disabled=items.some(lockOwner);
    duplicate.disabled=items.some(item=>{const owner=lockOwner(item);return !!owner&&owner!==item;});
    actions.append(group,duplicate);
    propertySection(form,'selection','图层操作').append(actions);return;
  }
  const maskTarget=(scoped?scope.target:paintTarget)==='mask'&&!!l;
  propertyHeading(form,{name:l?.name||'全 UV 底层',
    type:maskTarget?'蒙版':({fill:'填充',paint:'绘制',decal:'投影',group:'文件夹'}[l?.kind]||'填充'),
    icon:maskTarget?'mask':({paint:'brush',decal:'image',group:'fillLayer'}[l?.kind]||'fillLayer'),
    scope:undefined});
  if(l?.kind==='group'){
    const general=propertySection(form,'folder','文件夹设置');
    const visibility=field('显示文件夹','checkbox',l.visible,visible=>editTarget({visible}));
    visibility.dataset.lockAction='visibility';
    general.append(field('名称','text',l.name,name=>editTarget({name})),visibility);
    propertySection(form,'actions','图层操作',{open:false}).append(actionBar());
    renderPropertyLock(form,l||null,scoped?1:selection.size);
    return;
  }
  if(l){
    const general=propertySection(form,'layer','图层设置',{open:false});
    general.append(field('颜色混合','select',layerChannelBlend(l,'color'),blend=>editTarget({blend}),
      {choices:channelBlendChoices('color')}));
    const visibility=field('可见','checkbox',l.visible,visible=>editTarget({visible}));
    visibility.dataset.lockAction='visibility';
    general.append(field('名称','text',l.name,name=>editTarget({name})),visibility,
      liveField('整层不透明度','number',l.opacity,opacity=>({opacity}),{min:0,max:1}));
  }
  const material=maskTarget?null:propertySection(form,'material','材质');
  const channels=element('div');channels.className='property-channel-switches';channels.setAttribute('role','group');channels.setAttribute('aria-label','材质通道');
  material?.append(channels);
  if(!maskTarget&&l?.kind==='fill'){
    const source=element('div');source.className='property-material-source';material.append(source);
    source.append(field('引用材质','select',l.materialId||'',async materialId=>{await editTarget({materialId:materialId||null});if(materialId)libraryUI.select('materials',materialId);},
      {choices:[['','独立材质值'],...Object.entries(doc.paint.materials||{}).map(([id,m])=>[id,m.name])]}));
    if(l.materialId){
      const linked=element('div');linked.className='property-linked-material';
      linked.append(localButton('编辑材质节点',()=>libraryUI.select('materials',l.materialId)));
      source.append(linked);
    }
  }
  for(const key of paintChannels){
    if(!material)break;
    const enabled=l?l.channels[key]===true:baseChannelEnabled(doc.paint,key);
    const toggle=field('启用'+names[key],'checkbox',enabled,value=>l?editTarget({channels:{...l.channels,[key]:value}}):commandTarget([{op:'baseChannels',patch:{[key]:value}}]));
    channels.append(propertyChannelSwitch(toggle,names[key]));
    if(!enabled||l?.materialId)continue;
    const section=element('fieldset');section.className='property-channel';section.dataset.channel=key;
    section.title=names[key]+' · '+(channelSpecs[key].srgb?'sRGB':key==='normal'?'OpenGL 切线空间':'线性');
    section.append(element('legend',names[key]));
    if(!l?.materialId&&!(key==='color'&&l?.kind==='decal')&&!l?.maps?.[key]){
      const type=channelSpecs[key].type==='color'?'color':'number',range={min:0,max:1};
      const patch=value=>l?{values:{...values,[key]:value}}:{[key]:value};
      if(l?.kind==='paint'&&key==='color'&&(workArea==='drawing'||areaSystem)){
        const control=field('前景色',type,paintColors.pair('paint').foreground,
          value=>changePaintColors(()=>paintColors.set('paint','foreground',value),'paint'),range);
        control.querySelector('input').dataset.paintForeground='true';section.append(control);
      }else section.append(l?.kind==='paint'
        ?field(names[key],type,values[key],value=>editTarget(patch(value)),range)
        :liveField(names[key],type,values[key],patch,range));
    }
    if(l&&!l.materialId&&l.kind!=='paint'&&(key!=='color'||l.kind==='fill'))section.append(field(names[key]+'贴图','select',l.documentMaps?.[key]?'document:'+l.documentMaps[key]:l.maps?.[key]||'',asset=>{
      const maps={...l.maps},documentMaps={...l.documentMaps};delete maps[key];delete documentMaps[key];
      if(asset.startsWith('document:'))documentMaps[key]=asset.slice(9);else if(asset)maps[key]=asset;
      return editTarget({maps,...(l.kind==='fill'?{documentMaps}:{})});
    },{choices:[['','使用数值'],...choices,...(l.kind==='fill'?Object.entries(doc.paint.imageDocuments??{}).map(([id,d])=>['document:'+id,'图像文档 · '+d.name]):[])]}));
    if(l?.documentMaps?.[key])section.append(localButton('编辑图像文档',()=>areaSystem.openImage(l.documentMaps[key])));
    if(!l?.materialId){
      for(const control of section.querySelectorAll('label:has(input[type=color])'))propertyColorValue(control);
      const image=l?.maps?.[key]||(key==='color'&&l?.kind==='decal'?l.image:null);
      if(key==='color'&&l?.kind==='decal')section.append(element('span','颜色'));
      if(image)section.append(propertyImage(image));
      const controls=[...section.querySelectorAll(':scope>label')];
      controls.forEach((control,index)=>control.classList.add(index===0?'property-channel-value':'property-channel-map'));
      material.append(section);
    }
  }
  if(material&&l?.materialId&&Object.keys(doc.paint.imageDocuments??{}).length){
    const bound=Object.keys(l.documentMaps??{}).length;
    const drawings=propertySection(form,'linked-drawings','绘制贴图',{open:bound>0});
    const docs=Object.entries(doc.paint.imageDocuments).map(([id,image])=>[id,image.name]);
    for(const key of paintChannels){
      if(!l.channels[key])continue;
      const documentId=l.documentMaps?.[key]||'';
      drawings.append(field(names[key],'select',documentId,id=>{
        const documentMaps={...l.documentMaps};
        if(id)documentMaps[key]=id;else delete documentMaps[key];
        return editTarget({documentMaps});
      },{choices:[['','沿用库材质'],...docs]}));
      if(documentId)drawings.append(localButton('编辑'+names[key]+'贴图',()=>areaSystem.openImage(documentId)));
    }
  }
  if(!l)return;
  if(!maskTarget&&(areaSystem||workArea==='material')&&l.kind==='paint')material.append(localButton('在三维视口中绘制',()=>{
    ensureSelected();
    if(areaSystem){areaSystem.openMaterialPainting();return;}else if(!selectWorkArea('drawing'))return;
    activateSurface('paint');
  }));
  if(!maskTarget&&l.kind==='decal'){
    const projection=propertySection(form,'projection',l.space==='uv'?'图像变换':'投影');
    if(l.text)projection.append(localButton('编辑文字…',()=>editTextLayer(l)));
    else projection.append(field(l.space==='uv'?'画布图片':'贴花 PNG','select',l.image,image=>editTarget({image}),{choices}));
    if(l.projector){
      if(!projectionIsCurrent(doc,l))projection.append(element('small','贴花已随模型保留；重新放置可调整位置。'));
      for(const [key,label,min,max] of [['size','投影尺寸',.02,40],['depth','前后深度',.005,15],['rotation','旋转角度',-36000,36000]])
        projection.append(liveField(label,'number',l.projector[key],value=>({projector:{...l.projector,[key]:value}}),
          {min,max,dragSpeed:key==='rotation'?.5:undefined}));
      for(const [index,axis] of ['X','Y','Z'].entries())
        projection.append(liveField('位置 '+axis,'number',Number(l.projector.center[index].toFixed(5)),value=>{
          const center=l.projector.center.slice();center[index]=value;
          return {projector:{...l.projector,center}};
        },{min:-1000,max:1000,dragSpeed:.02}));
      if(areaSystem||workArea==='material')projection.append(localButton('在模型上重新放置',()=>{
        ensureSelected();
        if(areaSystem){areaSystem.reproject(l.id);return;}
        replaceProjection={projectId:doc.id,revision:doc.revision,layerId:l.id};
        activateSurface('place');$('status').textContent='在模型上点击新的贴花落点，Esc 取消';
      }));
      if(areaSystem||workArea==='material')projection.append(button('投影对齐当前视角',()=>{
        if(areaSystem?!areaSystem.deliveryViewport():!viewportReady())throw Error('请先打开三维视图');
        const {normal,up}=deliveryViewport().viewFrame();
        return editTarget({projector:{...l.projector,normal,up}});
      }));
    }else for(const [key,range] of Object.entries({
      x:{min:0,max:1},y:{min:0,max:1},scale:{min:.01,max:4},rotation:{dragSpeed:.5}
    })){
      const label=l.space==='uv'?{x:'画布位置 X',y:'画布位置 Y',scale:'图片缩放',rotation:'旋转角度'}[key]:names[key];
      projection.append(liveField(label,'number',l[key],value=>({[key]:value}),range));
    }
  }
  if(!maskTarget&&l.kind==='fill'&&!l.materialId&&(Object.keys(l.maps||{}).length||Object.keys(l.documentMaps||{}).length)){
    const tiling=l.tiling||{repeat:1,rotation:0,offsetX:0,offsetY:0};
    const group=propertySection(form,'uv','UV 平铺');
    group.append(field('重复平铺','checkbox',!!l.tiling,enabled=>editTarget({tiling:enabled?tiling:null})));
    if(l.tiling)for(const [key,label,min,max] of [
      ['repeat','重复次数',1,32],['rotation','旋转角度',-360,360],
      ['offsetX','横向偏移',-1,1],['offsetY','纵向偏移',-1,1]
    ])group.append(field(label,'number',tiling[key],value=>editTarget({tiling:{...tiling,[key]:value}}),{min,max}));
  }
  const mask=propertySection(form,maskTarget?'mask-edit':'mask','蒙版',{open:maskTarget,hint:hasLayerMask(l)?'已添加':undefined});
  mask.append(field('灰度蒙版','select',l.mask,mask=>editTarget({mask:mask||null}),{choices:[['','无'],...choices]}));
  if(!l.mask)mask.append(field('蒙版底色','select',String(l.maskBase??1),value=>editTarget({maskBase:Number(value)}),
    {choices:[['1','白色 · 显示'],['0','黑色 · 遮盖']]}));
  if(hasLayerMask(l))mask.append(field('使用蒙版','checkbox',l.maskEnabled!==false,maskEnabled=>editTarget({maskEnabled})));
  mask.append(button('编辑图片蒙版…',()=>maskEditor.open(maskOptions(l))));
  mask.append(localButton(areaSystem?'在三维视口中绘制蒙版':workArea==='drawing'?'在画布上绘制蒙版':'在模型上绘制蒙版',()=>{
    ensureSelected();
    if(!busy&&!maskEditor.isOpen()){activateSurface('mask');areaSystem?.maskTarget();}
  }));
  mask.append(renderMaskEffects(l,editTarget));
  propertySection(form,'actions','图层操作',{open:false}).append(actionBar());
  renderPropertyLock(form,l||null,scoped?1:selection.size);
}
function renderPropertyLock(form=$('properties'),active=layer(),count=selection.size){
  const owner=lockOwner(active);
  if(!owner||count!==1)return;
  const note=element('small',owner===active?'图层已锁定':'由「'+owner.name+'」锁定');
  note.className='property-lock-note';
  form.firstElementChild.after(note);
  for(const control of form.querySelectorAll('button,input,select,textarea')){
    const action=control.closest('[data-lock-action]')?.dataset.lockAction;
    if(action!=='visibility'&&(action!=='duplicate'||owner!==active))control.disabled=true;
  }
}
function layerActions(l,{issue=command,add=addAndSelect}={}){
  const siblings=layerChildren(doc.paint.layers,layerParent(l)),index=siblings.indexOf(l),bar=element('div');
  bar.className='bar';
  for(const [label,delta] of [['上移',1],['下移',-1]]){
    const neighbor=siblings[index+delta];
    const move=button(label,()=>issue([{op:'arrange',id:l.id,parentId:layerParent(l),
      anchorId:neighbor.id,placement:delta>0?'above':'below'}]));
    move.disabled=!neighbor;bar.append(move);
  }
  if(layerParent(l)){
    const parent=doc.paint.layers.find(item=>item.id===layerParent(l));
    bar.append(button('移出文件夹',()=>issue([{op:'arrange',id:l.id,parentId:layerParent(parent),
      anchorId:parent.id,placement:'above'}])));
  }
  bar.append(button('收进新文件夹',()=>add({op:'group',id:l.id})));
  const duplicate=button(l.kind==='group'?'复制文件夹':'复制层',()=>add({op:'duplicate',id:l.id}));
  duplicate.dataset.lockAction='duplicate';
  bar.append(duplicate);
  bar.append(button(l.kind==='group'?'解散文件夹':'删除层',()=>issue([{op:'remove',id:l.id}])));
  return bar;
}
const isPreview=j=>['paint-preview','paint-draft'].includes(j.type);
const previews=()=>jobs.filter(j=>isPreview(j)&&j.status==='completed')
  .sort((a,b)=>b.revision-a.revision||Number(a.type==='paint-draft')-Number(b.type==='paint-draft'));
const current=()=>previews().find(j=>j.revision===doc.revision&&j.type==='paint-preview');
const previewLabel=j=>j.type==='paint-draft'?'1K 试算':'4K 预览';
async function renderTexture(){
  const j=previews()[0],mode=$('source').value,channel=$('channel').value;
  $('uv-guide-toggle').hidden=mode!=='live';
  $('uv-guide').hidden=mode!=='live'||!showUVGuide||channel==='coverage';
  if(mode==='live'){
    textureKey='';
    $('texture').hidden=true;$('live-uv').hidden=false;$('uv-unavailable').hidden=true;
    $('uv-wipe-control').hidden=$('uv-wipe-overlay').hidden=true;
    $('uv-version').textContent=inspectMask?'表面蒙版 · '+layer()?.name:
      isolatedLayerId?'独显 · '+doc.paint.layers.find(item=>item.id===isolatedLayerId)?.name:
      channel==='coverage'?'红色保护 · 黄色共享 UV · 青色写入':'实时 UV · '+names[channel];
    $('inspect-channel').disabled=inspectMask;
    $('inspect-channel').setAttribute('aria-pressed',String(inspectChannel&&!inspectMask));
    liveView.refresh();
    return;
  }
  $('live-uv').hidden=true;
  liveView.clear();
  const original='/api/projects/'+doc.id+'/viewport/base';
  const url=mode==='original'?original:mode==='base'?j?.baseUrl||original:j?.colorUrl||original;
  const materialUrls=mode==='preview'?j?.materialUrls:mode==='base'?j?.baseMaterialUrls:null;
  const inspectionUrl=channel==='color'?url:channel==='coverage'?(mode==='preview'?j?.coverageUrl:null):materialUrls?.[channel];
  const reference=previews().find(job=>job.id===$('compare-preview').value);
  const uvUrl=reference?(channel==='color'?reference.colorUrl:channel==='coverage'?reference.coverageUrl:reference.materialUrls?.[channel]):inspectionUrl;
  $('texture').hidden=!uvUrl;
  $('uv-unavailable').hidden=!!uvUrl;
  if(uvUrl&&$('texture').getAttribute('src')!==uvUrl)$('texture').src=uvUrl;
  const wiping=!!(reference&&uvUrl&&inspectionUrl);
  $('uv-wipe-control').hidden=!wiping;
  $('uv-wipe-overlay').hidden=!wiping;
  if(wiping&&$('uv-wipe-texture').getAttribute('src')!==inspectionUrl)$('uv-wipe-texture').src=inspectionUrl;
  $('uv-version').textContent=reference?`对照 · ${previewLabel(reference)} r${reference.revision}${wiping?' / 当前':''}`:
    mode==='original'?'原贴图':mode==='base'?'全 UV 底层':j?`${previewLabel(j)} r${j.revision}`:'原贴图';
  $('inspect-channel').disabled=!inspectionUrl;
  const solo=inspectChannel&&!!inspectionUrl;
  $('inspect-channel').setAttribute('aria-pressed',String(solo));
  const displayUrl=solo?inspectionUrl:doc.source.format==='glb'&&(mode==='original'||!j)?null:url;
  const displayMaps=solo?null:materialUrls;
  const key=JSON.stringify([displayUrl,displayMaps,solo]);
  if(key===textureKey||$('viewport').hidden||!viewportReady())return;
  textureKey=key;
  await viewport.setTextureSource({textureUrl:displayUrl,materialUrls:displayMaps,
    activeChannels:mode==='preview'?j?.paintReport?.activeChannels:undefined,
    textureRevision:mode==='preview'?(j?.revision??null):null,
    textureLabel:solo?'通道检查 · '+(names[channel]||'写入诊断'):'PBR 涂装'});
  if(textureKey===key)viewport.setUnlit(solo);
}
function syncLayerSelection(){
  const maskId=paintTarget==='mask'?selected:null;
  for(const row of $('layers').querySelectorAll('.layer-row')){
    const {layerId}=row.dataset;
    row.querySelector('.layer-select').setAttribute('aria-pressed',String(selection.has(layerId)));
    row.querySelector('.layer-thumb')?.toggleAttribute('data-active',selection.size===1&&selected===layerId&&paintTarget==='material');
    row.toggleAttribute('data-isolated-layer',layerId===isolatedLayerId);
    if(isolatedLayerId){
      const item=doc.paint.layers.find(layer=>layer.id===layerId);
      row.toggleAttribute('data-isolated-away',layerId!==isolatedLayerId&&!isLayerUnder(item,isolatedLayerId));
    }else row.removeAttribute('data-isolated-away');
    const mask=row.querySelector('.layer-mask[aria-pressed]');
    if(mask)mask.setAttribute('aria-pressed',String(maskId===layerId));
  }
  $('base').setAttribute('aria-pressed',String(!layer()));
  $('exit-layer-isolation').hidden=!isolatedLayerId;
  maskThumbnails.sync();
}
async function selectMaskTarget(item,{altKey=false,mode='mask'}={}){
  if(!item||item.kind==='group'||busy||workArea==='modeling'&&!areaSystem||maskEditor.isOpen()||surfaceTools.isEditing()||uvSelection.isTransforming())return;
  if(!hasLayerMask(item)){
    if(altKey||lockOwner(item))return;
    if(!await run(()=>command([{op:'update',id:item.id,patch:{maskEnabled:true,maskBase:item.maskBase??1}}])))return;
    item=doc.paint.layers.find(layer=>layer.id===item.id);if(!item)return;
  }
  const wasInspected=inspectedMask()?.id===item.id;
  isolatedLayerId=null;setSelection([item.id]);paintTarget='mask';$('brush-erase').checked=false;
  inspectMask=altKey&&!wasInspected;activateSurface(mode);render();areaSystem?.materialSelectionChanged();areaSystem?.maskTarget({openViewport:!altKey});
  if(workArea==='drawing')$('uv-view').focus({preventScroll:true});
}
$('add-layer-mask').onclick=()=>void selectMaskTarget(layer());
function clearLayerIsolation(){
  if(!isolatedLayerId)return;
  isolatedLayerId=null;
  syncLayerSelection();
  areaSystem?.sync();
  void renderTexture();
}
function clearMaterialInspection(){
  if(inspectMask){inspectMask=false;render(true);}
  else clearLayerIsolation();
}
function toggleLayerIsolation(item){
  if(busy||workArea==='modeling'&&!areaSystem||maskEditor.isOpen()||paintTextEditor.isOpen||surfaceTools.isEditing()||
     uvSelection.isDragging()||uvSelection.isTransforming())return;
  const next=isolatedLayerId===item.id?null:item.id;
  setSelection([item.id]);
  isolatedLayerId=next;
  setSelectValue($('source'),'live');setSelectValue($('compare-preview'),'');
  render(true);
}
$('exit-layer-isolation').onclick=clearLayerIsolation;
function endLayerRename(restoreFocus=false){
  if(!layerRename)return null;
  const pending=layerRename;
  layerRename=null;
  pending.input.onblur=null;
  pending.input.remove();
  pending.button.hidden=false;
  if(restoreFocus)pending.button.focus({preventScroll:true});
  return pending;
}
function startLayerRename(id){
  if(!doc||busy||workArea==='modeling'&&!areaSystem||maskEditor.isOpen()||$('delivery-dialog').open||
     surfaceTools.isEditing()||uvSelection.isTransforming())return false;
  const item=doc.paint.layers.find(l=>l.id===id);
  const row=[...$('layers').children].find(node=>node.dataset.layerId===id);
  if(!item||!row||lockOwner(item))return false;
  if(layerRename?.id===id){layerRename.input.focus();return true;}
  endLayerRename();
  if(selection.size!==1||selected!==id){setSelection([id]);render(true);}
  const button=row.querySelector('.layer-select'),input=element('input');
  input.className='layer-inline-name';
  input.maxLength=100;
  input.value=item.name;
  input.setAttribute('aria-label','重命名图层');
  button.after(input);
  button.hidden=true;
  const pending={input,button,id,initial:item.name,projectId:doc.id,revision:doc.revision};
  layerRename=pending;
  function finish(save,focus){
    if(layerRename!==pending)return;
    const name=input.value.trim();
    endLayerRename(focus);
    if(!save||!name||name===pending.initial)return;
    const {projectId,revision}=pending;
    void run(()=>api('/api/projects/'+projectId+'/paint/commands',{revision,
      operations:[{op:'update',id,patch:{name}}]})).then(()=>{
      if(focus&&doc?.id===projectId){
        [...$('layers').children].find(node=>node.dataset.layerId===id)
          ?.querySelector('.layer-select')?.focus({preventScroll:true});
      }
    });
  }
  input.onblur=()=>finish(true,false);
  input.onkeydown=event=>{
    if(compositionKey(event)||!['Enter','Escape'].includes(event.key))return;
    event.preventDefault();
    finish(event.key==='Enter',true);
  };
  input.focus({preventScroll:true});
  input.select();
  return true;
}
function renderLayers(){
  const pending=endLayerRename();
  if(pending&&pending.input.value.trim()!==pending.initial){
    $('status').textContent='图层列表已更新，请重新命名';
  }
  const channel=$('layer-channel').value;
  const query=layerSearch.value.trim(),filtering=!!query;
  const rows=materialLayerRows(doc.paint.layers,{query,collapsed:collapsedFolders});
  const stack=$('layers');
  const previous=stack.dataset.projectId===doc.id?new Map([...stack.children].map(row=>[row.dataset.layerId,row])):new Map();
  stack.dataset.projectId=doc.id;
  stack.replaceChildren(...rows.map(({layer,depth})=>{
    const row=renderLayer(layer,depth,channel,filtering),old=previous.get(layer.id);
    if(old){
      for(const selector of ['.layer-thumb canvas','.layer-mask canvas']){
        const existing=old.querySelector(selector),replacement=row.querySelector(selector);
        if(!existing||!replacement)continue;
        const state=existing.parentElement.dataset.thumbnailState;
        if(state)replacement.parentElement.dataset.thumbnailState=state;
        replacement.replaceWith(existing);
      }
    }
    return row;
  }));
  $('layer-search-empty').hidden=!filtering||rows.length!==0;
  syncLayerSelection();
}
function renderLayer(l,depth,channel,filtering){
    const node=localButton('',event=>selectMaterialLayerById(l.id,event));
    node.className='layer-select';
    node.ondblclick=event=>{if(event.target.closest('.layer-title'))startLayerRename(l.id);};
    const folder=l.kind==='group';
    const owner=lockOwner(l),inheritedLock=!!owner&&owner!==l;
    const thumbnail=element(l.kind==='decal'?'img':'span');
    thumbnail.className='layer-thumb';
    if(l.kind==='decal'){thumbnail.src=route()+'/assets/'+l.image;thumbnail.alt='';}
    else if(folder){thumbnail.classList.add('folder-thumb');thumbnail.textContent='▰';}
    else if(l.kind==='paint'||l.materialId){const canvas=element('canvas');canvas.width=canvas.height=64;canvas.dataset.layerPreview='';canvas.setAttribute('aria-hidden','true');thumbnail.append(canvas);}
    else thumbnail.style.background=l.values.color;
    const title=element('span',l.name);title.className='layer-title';
    node.append(thumbnail,title,element('small',l.visible?'':'隐藏'));
    node.title=channel
      ?(l.channels?.[channel]?names[channel]+' · '+Number(((l.channelOpacity?.[channel]??1)*100).toFixed(2))+'%':names[channel]+' · 未启用')
      :'双击名称重命名 · ⌘ / Ctrl 多选 · Shift 连续选择';
    const row=element('div');row.className='layer-row';row.dataset.layerId=l.id;
    row.style.setProperty('--layer-depth',depth);
    row.toggleAttribute('data-inherited-hidden',l.visible&&!layerIsVisible(doc.paint.layers,l));
    row.toggleAttribute('data-channel-inactive',!!channel&&!folder&&!l.channels?.[channel]);
    row.toggleAttribute('data-locked',!!owner);
    const visibility=localButton('',event=>{
      if(event.altKey){toggleLayerIsolation(l);return;}
      clearLayerIsolation();
      void run(()=>command([{op:'update',id:l.id,patch:{visible:!l.visible}}]));
    });
    visibility.className='layer-visibility';
    visibility.innerHTML=l.visible?workspaceIcons.eye:workspaceIcons.hidden;
    const visibilityLabel=(l.visible?'隐藏 ':'显示 ')+l.name;
    visibility.title=visibilityLabel+' · Alt 点击独显';
    visibility.setAttribute('aria-label',visibilityLabel);
    const lock=localButton('',()=>void run(()=>command([{op:'update',id:l.id,patch:{locked:!l.locked}}])));
    lock.className='layer-lock';
    lock.innerHTML=owner?workspaceIcons.lock:workspaceIcons.unlock;
    lock.title=inheritedLock?'由「'+owner.name+'」锁定':(l.locked?'解锁 ':'锁定 ')+l.name;
    lock.setAttribute('aria-label',lock.title);
    lock.disabled=inheritedLock;
    row.append(visibility,node,lock);
    node.draggable=!owner;
    materialLayerDrag.bind(node,row,l.id,id=>{
      if(collapsedFolders.delete(id)){saveCollapsedFolders();renderLayers();}
    });
    if(folder){
      const collapsed=!filtering&&collapsedFolders.has(l.id);
      const disclosure=localButton(collapsed?'▸':'▾',()=>{
        if(busy||maskEditor.isOpen()||surfaceTools.isEditing())return;
        if(collapsed)collapsedFolders.delete(l.id);
        else{
          collapsedFolders.add(l.id);
          if(isLayerUnder(layer(),l.id))setSelection([l.id]);
        }
        saveCollapsedFolders();
        render();
      });
      disclosure.className='layer-disclosure';
      disclosure.setAttribute('aria-label',(collapsed?'展开 ':'收起 ')+l.name);
      disclosure.setAttribute('aria-expanded',String(!collapsed));
      disclosure.disabled=filtering;
      row.append(disclosure);
      return row;
    }
    const hasMask=hasLayerMask(l);
    const maskButton=localButton(hasMask?'':'＋',event=>{
      if(busy||maskEditor.isOpen()||surfaceTools.isEditing())return;
      if(hasMask&&event.shiftKey){
        if(owner)return;
        void run(()=>command([{op:'update',id:l.id,patch:{maskEnabled:l.maskEnabled===false}}]));
        return;
      }
      void selectMaskTarget(l,{altKey:event.altKey});
    });
    const maskLabel=(hasMask?'绘制蒙版 · ':'添加蒙版 · ')+l.name;
    maskButton.className='layer-mask';maskButton.title=hasMask?maskLabel+' · Option 点击单独查看 · Shift 点击启用或停用':maskLabel;
    maskButton.disabled=!!owner&&!hasMask;
    maskButton.toggleAttribute('data-mask-disabled',l.maskEnabled===false);
    maskButton.toggleAttribute('data-mask-effects',!!l.maskEffects?.length);
    maskButton.setAttribute('aria-label',maskLabel);
    if(hasMask){
      const image=element('canvas');image.width=image.height=64;image.setAttribute('aria-hidden','true');
      maskButton.replaceChildren(image);
    }
    if(hasMask)maskButton.setAttribute('aria-pressed',String(paintTarget==='mask'&&selected===l.id));
    row.append(maskButton);
    return row;
}
function isLayerUnder(layer,folder){
  for(let parent=layer&&layerParent(layer);parent!=null;){
    if(parent===folder)return true;
    const ancestor=doc.paint.layers.find(item=>item.id===parent);
    parent=ancestor?layerParent(ancestor):null;
  }
  return false;
}
const materialLayerMenu=createContextActions('材质图层操作',error=>void run(()=>{throw error;}));
function openMaterialLayerMenu(event,id,rename=startLayerRename){
  const item=doc?.paint.layers.find(layer=>layer.id===id);
  if(!item||busy||maskEditor.isOpen()||surfaceTools.isEditing()||uvSelection.isTransforming()||event.target.closest('input,select'))return;
  event.preventDefault();event.stopPropagation();
  if(!selection.has(item.id)){setSelection([item.id]);render(true);areaSystem?.materialSelectionChanged();}
  const ids=[...selection],items=doc.paint.layers.filter(layer=>ids.includes(layer.id)),single=items.length===1?items[0]:null;
  const origin={id:doc.id,revision:doc.revision};
  const guard=action=>()=>{if(doc?.id!==origin.id||doc.revision!==origin.revision||busy)throw Error('工程已更新，请重新打开图层菜单');return action();};
  const edit=(label,icon,action,enabled=true,shortcut='')=>({label,icon,enabled,shortcut,run:guard(()=>run(action))});
  const name=(label,icon,action,enabled=true,shortcut='')=>({label,icon,enabled,shortcut,run:guard(action)});
  const editable=!!single&&!lockOwner(single),canGroup=items.every(layer=>!lockOwner(layer)&&layerParent(layer)===layerParent(item));
  const canCopy=items.every(layer=>{const owner=lockOwner(layer);return !owner||owner===layer;});
  const actions=[name('重命名…','text',()=>rename(single.id),editable,'F2'),
    edit(items.length>1?'复制所选图层':'复制图层','copy',()=>addAndSelect(...ids.map(id=>({op:'duplicate',id}))),canCopy,'⌘D'),
    edit('收进新文件夹','collection',()=>addAndSelect({op:'group',ids}),canGroup,'⌘G'),null,
    edit('隐藏所选图层','hidden',()=>command(ids.map(id=>({op:'update',id,patch:{visible:false}}))),items.some(layer=>layer.visible)),
    edit('显示所选图层','eye',()=>command(ids.map(id=>({op:'update',id,patch:{visible:true}}))),items.some(layer=>!layer.visible))];
  if(single)actions.push(name(isolatedLayerId===single.id?'退出图层独显':'独显图层','eye',()=>toggleLayerIsolation(single),true,'⌥ 点击眼睛'));
  if(single?.kind==='group')actions.push(null,name('保存为智能材质','material',()=>{
    areaSystem?.areas.openEditor('library');
    return libraryUI.saveSmart(single.id);
  }));
  if(single&&single.kind!=='group'){
    actions.push(null);
    if(hasLayerMask(single))actions.push(name('编辑蒙版','mask',()=>selectMaskTarget(single)),
      name(inspectedMask()?.id===single.id?'退出蒙版查看':'查看蒙版','mask',()=>selectMaskTarget(single,{altKey:true}),true,'⌥ 点击缩略图'),
      edit(single.maskEnabled===false?'启用蒙版':'停用蒙版','mask',()=>command([{op:'update',id:single.id,patch:{maskEnabled:single.maskEnabled===false}}]),editable));
    else for(const [label,value] of [['添加白色蒙版',1],['添加黑色蒙版',0]])actions.push(name(label,'mask',async()=>{
      if(await run(()=>command([{op:'update',id:single.id,patch:{maskEnabled:true,maskBase:value}}]))&&doc?.id===origin.id){const current=doc.paint.layers.find(layer=>layer.id===single.id);if(current)await selectMaskTarget(current);}
    },editable));
  }
  materialLayerMenu.open(event,single?.name||items.length+' 个图层',actions);
}
$('layers').addEventListener('contextmenu',event=>openMaterialLayerMenu(event,event.target.closest('[data-layer-id]')?.dataset.layerId));
$('layer-channel').onchange=()=>{renderLayers();renderDrawingLayerSettings();};
const layerSearch=$('layer-search'),layerSearchToggle=$('toggle-layer-search');
function setLayerSearch(open,interactive=true){
  layerSearch.hidden=!open;
  layerSearchToggle.setAttribute('aria-expanded',String(open));
  if(open){layerSearch.focus({preventScroll:true});return;}
  const hadQuery=!!layerSearch.value;
  layerSearch.value='';
  if(interactive){
    if(hadQuery)renderLayers();
    layerSearchToggle.focus({preventScroll:true});
  }
}
layerSearchToggle.onclick=()=>setLayerSearch(layerSearch.hidden);
layerSearch.oninput=renderLayers;
layerSearch.onkeydown=event=>{
  if(event.key==='Escape'&&!compositionKey(event)){event.preventDefault();setLayerSearch(false);}
};
function render(keepLayerRows=false){
  renderProjectState();
  syncDeliveryPreferences();
  libraryUI?.sync();shaderEditor?.sync();historyPanel?.sync();
  $('workspace').hidden=!doc;$('empty').hidden=!!doc;
  for(const id of ['preview','undo','redo','open-delivery','open-render-settings','open-paint-render','open-render-results','three','uv','split'])$(id).disabled=!doc;
  syncBusyControls();
  if(!doc)return;
  if(paintTarget==='mask'&&(!layer()||!hasLayerMask(layer()))){
    paintTarget='material';inspectMask=false;surfaceTools.setMode(layer()?.kind==='paint'?'paint':'orbit');
  }
  $('revision').textContent='修订 '+doc.revision;
  if(isolatedLayerId&&!doc.paint.layers.some(l=>l.id===isolatedLayerId))isolatedLayerId=null;
  if(!inspectedMask())inspectMask=false;
  $('exit-mask-inspection').hidden=!inspectMask;
  if(keepLayerRows)syncLayerSelection();
  else renderLayers();
  renderProjection();
  renderAssets();renderAssetRoles();renderProperties();uvSelection.sync();renderJobs();
  surfaceTools.render();
  renderCanvasChrome();areaSystem?.sync();
}
function renderAssetRoles(){
  const l=selection.size===1?layer():null,select=$('asset-role'),previous=select.value;
  select.hidden=false;if(select.closest('.custom-select'))select.closest('.custom-select').hidden=false;$('apply-asset').hidden=false;
  const roles=l&&l.kind!=='group'&&!lockOwner(l)?[['mask','灰度蒙版']]:[];
  if(roles.length&&l.kind!=='paint'&&!l.materialId){
    if(l.kind==='fill')roles.push(['color','颜色贴图']);
    else if(!l.text)roles.push(['image','替换贴花']);
    roles.push(...paintChannels.filter(k=>k!=='color').map(k=>[k,names[k]+'贴图']));
  }
  select.replaceChildren(...(roles.length?roles:[['','选择一个图层']]).map(([key,label])=>new Option(label,key)));
  if(roles.some(([key])=>key===previous))select.value=previous;
  select.disabled=$('apply-asset').disabled=!roles.length||!selectedAsset;
  $('uv-add-image').disabled=!selectedAsset||busy||(areaSystem?!areaSystem.project.document?.paint.imageDocuments?.[areaSystem.project.imageContext?.documentId]:!canAddLayer());
  $('asset-view').disabled=!selectedAsset;
  syncSelectMenu(select);
}
function syncAssetSelection(){
  for(const item of $('assets').querySelectorAll('button[data-asset-id]')){
    item.setAttribute('aria-pressed',String(item.dataset.assetId===selectedAsset));
  }
}
function renderAssets(){
  const assets=Object.values(doc.paint.assets);
  if(!doc.paint.assets[selectedAsset])selectedAsset=null;
  const displayed=filteredAssets(assets);
  const key=JSON.stringify([doc.id,!!assets.length,displayed.map(a=>[a.id,a.name])]);
  if(key===assetGridKey){syncAssetSelection();return;}
  assetGridKey=key;
  const tiles=displayed.map(a=>{
    const img=element('img');img.alt='';img.src=route()+'/assets/'+a.id;img.draggable=false;img.loading='lazy';
    const tile=element('button');tile.type='button';tile.draggable=true;tile.dataset.assetId=a.id;
    tile.onclick=()=>{
      selectedAsset=a.id;
      syncAssetSelection();
      renderAssetRoles();
      libraryUI?.sync();
    };
    tile.ondblclick=()=>showAsset(a.id,tile);
    tile.ondragstart=event=>{
      startAssetDrag(event.dataTransfer,{projectId:doc.id,revision:doc.revision,id:a.id});
    };
    tile.ondragend=()=>{
      endAssetDrag();delete $('projection-frame').dataset.drop;delete $('viewport').dataset.drop;delete $('uv-view').dataset.drop;
    };
    tile.title=a.name+' · 双击查看大图';tile.setAttribute('aria-pressed',String(a.id===selectedAsset));
    tile.append(img,element('span',a.name));return tile;
  });
  $('assets').replaceChildren(...(tiles.length?tiles:[element('p',assets.length?'没有匹配的素材':'导入 PNG 素材')]));
}
function refreshComparison(){
  const select=$('compare-preview'),selectedId=select.value;
  const available=previews();
  const keys=['',...available.map(j=>j.id)];
  if(keys.length!==select.options.length||keys.some((key,i)=>select.options[i].value!==key)){
    select.replaceChildren(new Option('版本对照',''),...available.map(j=>
      new Option(`${previewLabel(j)} r${j.revision} · ${new Date(j.created).toLocaleTimeString()}`,j.id)));
    select.value=keys.includes(selectedId)?selectedId:'';
  }
  select.disabled=!available.length;
  syncSelectMenu(select);
}
const exportLabels={'paint-export':'交付','paint-texture-export':'工程与贴图','paint-glb-export':'GLB'};
const isPaintExport=job=>Object.hasOwn(exportLabels,job?.type);
const deliveryJobs=()=>jobs.filter(job=>isPreview(job)||isPaintExport(job));
function renderJobs(){
  refreshComparison();
  const production=deliveryJobs();
  const j=previews()[0],active=production.find(job=>['queued','running'].includes(job.status));
  const building=active&&isPreview(active)?active:null;
  $('preview-state').textContent=building?`正在生成 ${previewLabel(building)} r${building.revision}`:
    j?.revision===doc.revision?`${previewLabel(j)} r${j.revision} · ${current()?'可确认交付':'仅供定位'}`:j?`${previewLabel(j)} r${j.revision} · 待重烘焙`:'未烘焙 4K';
  $('preview-state').dataset.stale=String(j?.revision!==doc.revision);
  $('preview').disabled=!!active;
  renderDelivery(j,active,active||production[0]);
  renderPaintBackups();
  paintRenderResults.sync();
  taskMonitor?.sync();
  cameraBatch?.sync();
  for(const listener of renderResultsListeners)listener();
  void renderTexture();
}
function renderPaintBackups(){
  const backups=jobs.filter(job=>job.type==='paint-backup');
  const active=backups.find(job=>['queued','running'].includes(job.status));
  const latest=backups.find(job=>job.status==='completed'&&job.archiveUrl);
  const start=$('create-paint-backup'),download=$('download-paint-backup'),log=$('paint-backup-log');
  start.disabled=!!active;
  start.textContent=active?'正在生成副本…':'生成工程副本';
  download.hidden=!latest;
  if(latest){
    const safeName=doc.name.replace(/[\\/:*?"<>|]+/g,'-');
    download.href=latest.archiveUrl;
    download.download=safeName+'-r'+latest.revision+'.zip';
    download.textContent='下载工程副本 · r'+latest.revision;
    download.title=latest.portable?'含原模型、图层和素材，可在另一台电脑恢复':'恢复时需要本机原登记模型';
  }
  const failed=backups[0]&&['failed','cancelled','interrupted'].includes(backups[0].status)?backups[0]:null;
  log.hidden=!failed;
  if(failed)log.href='/api/projects/'+doc.id+'/jobs/'+failed.id+'/files/run.log';
  const pending=backups.find(job=>job.id===pendingBackupId);
  if(!pending||['queued','running'].includes(pending.status))return;
  pendingBackupId=null;
  $('status').textContent=pending.status==='completed'
    ? (pending.portable?'可移植工程副本 r':'工程副本 r')+pending.revision+' 已生成，可在文件菜单下载'
    : pending.error||pending.stage;
}
function renderDelivery(j,active,last){
  const ready=current(),r=j?.paintReport,revision=doc.revision;
  if($('delivery-dialog').open)syncDeliveryControls();
  if(approvedPreviewId!==ready?.id){approvedPreviewId=null;approvedRenderSettings=null;}
  $('approved').checked=!!approvedPreviewId;
  $('approved').disabled=!ready||!!active;
  $('delivery').disabled=!approvedPreviewId||!approvedRenderSettings||!!active;
  $('export-textures').disabled=!ready||!!active;
  $('export-glb').disabled=!ready||!!active;
  $('export-glb').title='导出建模结果和内嵌 4K PBR 贴图';
  const preset=$('delivery-texture-preset');
  preset.disabled=isPaintExport(active);
  syncSelectMenu(preset);
  for(const control of [...Object.values(deliveryControls),$('delivery-format')]){
    control.disabled=active?.type==='paint-export';syncSelectMenu(control);
  }
  const renderValues=deliveryEditorValues(effectiveDeliveryPreferences());
  const renderDetail=renderValues.fileFormat==='OPEN_EXR'?cyclesFormatLabel(renderValues.fileFormat)+' '+(renderValues.bitDepth??16)+' 位 + PNG 预览':'PNG 8 位';
  const region=renderRegionPixels(doc.paint.renderRegion,renderValues.width,renderValues.height);
  $('delivery-render-hint').textContent=(renderValues.framing==='saved'?'使用工程渲染相机。':
    approvedRenderSettings?.camera?'已固定确认时的三维视角。':renderValues.framing==='viewport'?'使用当前三维视角。':'自动取景。')+
    ` ${renderValues.samples} 次采样 · ${renderDetail}`+(region?` · ${region.crop?'裁切':'区域渲染'} ${region.output.join(' × ')}`:'');
  $('delivery-revision').textContent='当前修订 r'+revision;
  $('delivery-preview').textContent=ready?`4K · r${revision} · 原 UV 已校验`:j?
    `${previewLabel(j)} · r${j.revision} · 交付需要当前修订的 4K 预览`:'先生成当前修订的 4K 预览';
  $('diagnostics').textContent=r?`局部涂装写入 ${r.writtenTexels.toLocaleString()} · 共享 UV 冲突 ${r.conflictTexels.toLocaleString()} · 保护区写入 ${r.protectedTexelsWritten}`:'';
  $('delivery-preview-button').disabled=!!active;
  const previewKey=j?.id||'';
  if($('delivery-channels').dataset.job!==previewKey){
    $('delivery-channels').dataset.job=previewKey;
    const [width,height]=r?.resolution||[];
    $('delivery-channels').replaceChildren(...[
      ...paintChannels.map(k=>[names[k],k==='color'?j?.colorUrl:j?.materialUrls?.[k]])
    ].map(([label,url])=>{
      const node=url?deliveryLink('',url):element('span');
      if(url){
        const thumb=element('img');Object.assign(thumb,{src:url,alt:'',loading:'lazy',decoding:'async'});node.append(thumb);
      }
      node.append(element('span',label),element('small',url?`${width}×${height}`:'待生成'));return node;
    }));
    $('delivery-reference').replaceChildren(...(j?[deliveryLink('写入诊断图',j.coverageUrl),deliveryLink('预览校验报告',j.validationUrl)]:[]));
  }
  const task=last?`r${last.revision} · ${exportLabels[last.type]||previewLabel(last)} · ${last===active&&cyclesProgressLabel(last.progress)||last.stage}${last.error?' · '+last.error:''}`:'';
  if($('task').textContent!==task)$('task').textContent=task;
  $('cancel').hidden=!active;
  $('retry-preview').hidden=!!active||!isPreview(last||{})||last.revision!==revision||
    !['failed','cancelled','interrupted'].includes(last.status);
  $('retry-preview').dataset.type=last?.type||'';
  $('retry-export').hidden=!!active||!isPaintExport(last)||last.revision!==revision||!['failed','cancelled','interrupted'].includes(last.status);
  $('retry-export').dataset.job=$('retry-export').hidden?'':last.id;
  $('log').hidden=!last;
  if(last){$('log').href='/api/projects/'+doc.id+'/jobs/'+last.id+'/files/run.log';$('log').target='_blank';}
  const delivered=jobs.find(j=>j.type==='paint-export'&&j.packageUrl&&j.status==='completed');
  const textures=jobs.find(j=>j.type==='paint-texture-export'&&j.packageUrl&&j.status==='completed');
  const model=jobs.find(j=>j.type==='paint-glb-export'&&j.glbUrl&&j.status==='completed');
  const deliveryKey=[delivered?.id,textures?.id,model?.id].join(':');
  if($('downloads').dataset.job!==deliveryKey){
    $('downloads').dataset.job=deliveryKey;
    const entries=[];
    if(model)entries.push(Object.assign(link('模型 GLB · r'+model.revision,model.glbUrl),
      {download:'Arachne-r'+model.revision+'.glb'}));
    if(textures){
      const packed=textureExportPresets[textures.texturePreset]?.files;
      entries.push(Object.assign(link('工程与贴图 ZIP · r'+textures.revision+(packed?' · '+textureExportPresets[textures.texturePreset].label:''),
        textures.packageUrl),{download:'Arachne-r'+textures.revision+'-'+(packed?textures.texturePreset:'textures')+'.zip'}));
    }
    if(delivered){
      const name=`Arachne-r${delivered.revision}`;
      entries.push(Object.assign(link('交付 ZIP · r'+delivered.revision,delivered.packageUrl),{download:name+'.zip'}));
      if(delivered.glbUrl)entries.push(Object.assign(link('模型 GLB',delivered.glbUrl),{download:name+'.glb'}));
      if(delivered.materialUrl)entries.push(deliveryLink('材质清单',delivered.materialUrl));
      if(delivered.blendUrl)entries.push(link('Blender',delivered.blendUrl));
      if(delivered.renderUrl)entries.push(deliveryLink('渲染 PNG',delivered.renderUrl));
      if(delivered.outputUrl)entries.push(Object.assign(link('OpenEXR',delivered.outputUrl),{download:name+'.exr'}));
      if(delivered.passesUrl)entries.push(Object.assign(link('通道 EXR',delivered.passesUrl),{download:name+'-Passes.exr'}));
      entries.push(deliveryLink('交付校验报告',delivered.validationUrl));
    }
    $('downloads').replaceChildren(...(entries.length?entries:[element('small','尚无导出')]));
  }
}
function deliveryLink(text,url){
  const node=link(text,url);node.target='_blank';return node;
}
async function refresh(){
  if(!doc)return;
  const {revision}=doc,generation=projectGeneration,sequence=++refreshSequence;
  const headers=snapshotTag?.revision===revision?{'If-None-Match':snapshotTag.value}:{};
  const response=await fetch(route()+'?knownRevision='+revision,{headers,cache:'no-store'});
  if(generation!==projectGeneration||sequence<appliedRefresh)return;
  if(response.status===304){appliedRefresh=sequence;await refreshGeometry();return;}
  const {document,jobs:next}=await responseJson(response);
  const returnedRevision=document?.revision??revision;
  if(generation!==projectGeneration||sequence<appliedRefresh||returnedRevision<doc.revision)return;
  appliedRefresh=sequence;
  const value=response.headers.get('etag');
  snapshotTag=value?{revision:returnedRevision,value}:null;
  const changed=doc.revision!==returnedRevision;
  if(changed)approvedPreviewId=null;
  if(document)doc=document;
  jobs=next;
  if(changed){
    const active=layer(),parent=active&&layerParent(active);
    const retained=doc.paint.layers.filter(item=>selection.has(item.id)&&(!active||layerParent(item)===parent)).map(item=>item.id);
    if(retained.length!==selection.size)setSelection(retained,active?.id);
    if(viewportReady())viewport.syncDocument(doc);
    modeler.syncDocument();
    render();
  }else renderJobs();
  schedulePreview(changed);
  await refreshGeometry();
}
async function refreshGeometry(){
  if(doc.modeling?.steps?.length||Object.keys(doc.paint.surfaceBindings||{}).some(key=>key!=='original')){
    const revision=doc.revision,generation=projectGeneration,geometry=await api(route()+'/model-state');
    if(generation===projectGeneration&&doc.revision===revision)showGeometryStatus(geometryStatusNodes,geometry);
  }else showGeometryStatus(geometryStatusNodes,null);
}
async function run(action,errorOutput=null){
  if(busy)return;
  if(surfaceTools.isEditing()||modelMarquee||modeler.isDragging()||uvSelection.isDragging())return false;
  if(maskEditor.isOpen()){ $('mask-status').textContent='请先保存或取消当前蒙版';return; }
  busy=true;$('status').textContent='';$('delivery-error').textContent='';
  syncBusyControls();
  try{await action();await refresh();return true;}
  catch(error){
    if(error.status===409)await refresh();
    (errorOutput||$(!doc?'welcome-error':$('delivery-dialog').open?'delivery-error':'status')).textContent=error.message;
    return false;
  }
  finally{
    busy=false;
    syncBusyControls();
    surfaceTools.render();uvSelection.sync();areaSystem?.sync();
  }
}
async function projects(){
  return (await api('/api/projects')).filter(project=>project.workflowType==='pbr_paint');
}
async function load(id,{initialLayer}={}){
  if(maskEditor.isOpen())throw Error('请先保存或取消当前蒙版');
  if(!/^[\w-]{1,100}$/.test(id))throw Object.assign(Error('工程 ID 无效'),{status:400});
  const next=await api('/api/projects/'+encodeURIComponent(id));
  if(next.workflowType!=='pbr_paint')throw Error('请选择涂装工程');
  replaceProjection=null;
  modeler.close();
  uvSelection.clear();
  setModelMarquee(false);
  uvPin=null;setUVLocateMode(false);
  isolatedLayerId=null;
  setTextPlacement(false);
  clearTimeout(autoTimer);
  liveView.clear();
  doc=next;projectGeneration++;snapshotTag=null;projectSaveErrors.delete(id);
  setLayerSearch(false,false);
  pendingBackupId=null;
  collapsedFolders=new Set();
  try{
    const stored=JSON.parse(localStorage.getItem('arachne-paint-folders-'+id));
    if(Array.isArray(stored))collapsedFolders=new Set(stored);
  }catch{}
  setSelection(next.paint.layers.some(layer=>layer.id===initialLayer)?[initialLayer]:[]);
  selectedAsset=null;jobs=[];$('asset-search').value='';setSelectValue($('compare-preview'),'');inspectChannel=false;viewport.setUnlit(false);resetUV();textureKey='';approvedPreviewId=null;
  updateProjectUrl();
  rememberWorkbenchSession();
  setSelectValue($('source'),'live');surfaceTools.setMode('orbit');
  render();
  showView(view);
}
function canOpenProjectDialog(){
  return !busy&&!modeler.isDragging()&&!modelMarquee&&!surfaceTools.isEditing()&&
    !uvSelection.isDragging()&&!uvSelection.isTransforming()&&!areaSystem?.isEditing()&&!document.querySelector('dialog[open]');
}
const projectDialog=$('project-dialog');
$('open-project-details').onclick=()=>{
  if(!doc||!canOpenProjectDialog())return;
  renderProjectState();document.querySelectorAll('.paint-menu[open]').forEach(menu=>menu.open=false);projectDialog.showModal();
};
$('close-project-dialog').onclick=()=>projectDialog.close();
const projectCopy=$('project-copy-dialog'),copyName=$('project-copy-name'),copySave=$('save-project-copy');
const copyClose=$('close-project-copy'),copyError=$('project-copy-error');
let copySource=null,copyId=null,copyPending=false;
function openProjectCopy(){
  if(!doc||!canOpenProjectDialog())return false;
  copySource=doc.id;copyId=null;copyPending=false;
  copyName.value=doc.name.slice(0,95)+' · 副本';
  copyName.disabled=copySave.disabled=copyClose.disabled=false;
  copySave.textContent='另存并打开';
  copyError.textContent='';
  $('project-copy-source').textContent='源工程　'+doc.name;
  document.querySelectorAll('.paint-menu[open]').forEach(menu=>menu.open=false);
  projectCopy.showModal();copyName.focus();copyName.select();
  return true;
}
$('open-project-copy').onclick=openProjectCopy;
copyClose.onclick=()=>projectCopy.close();
projectCopy.addEventListener('cancel',event=>{if(copyPending)event.preventDefault();});
$('project-copy-form').onsubmit=async event=>{
  event.preventDefault();
  if(copyPending||doc?.id!==copySource)return;
  copyPending=copyName.disabled=copySave.disabled=copyClose.disabled=true;
  copyError.textContent='';
  copySave.textContent=copyId?'正在打开…':'正在复制…';
  try{
    const success=await run(async()=>{
      if(!copyId)copyId=(await post('save-copy',{name:copyName.value})).id;
      await load(copyId);
    },copyError);
    if(success)projectCopy.close();
  }finally{
    copyPending=copySave.disabled=copyClose.disabled=false;
    copyName.disabled=!!copyId;
    copySave.textContent=copyId?'打开副本':'另存并打开';
    if(projectCopy.open)(copyId?copySave:copyName).focus();
  }
};
const projectPicker=setupProjectPicker({list:projects,current:()=>doc?.id,open:(id,error)=>run(()=>load(id),error),canOpen:canOpenProjectDialog});
$('open-projects').onclick=projectPicker;
setupCommandPicker({canOpen:canOpenProjectDialog});
setupPaintColorPicker();
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.repeat||compositionKey(event))return;
  const picker=event.key==='Escape'&&document.querySelector('.workbench-picker[open]');
  if(picker){
    event.preventDefault();event.stopPropagation();
    if(typeof picker.requestClose==='function')picker.requestClose();
    else if(picker.dispatchEvent(new Event('cancel',{cancelable:true})))picker.close();
    return;
  }
  if(event.altKey||!(event.metaKey||event.ctrlKey))return;
  const key=event.key.toLowerCase();
  const opened=event.shiftKey&&key==='s'?openProjectCopy():!event.shiftKey&&key==='o'&&projectPicker();
  if(opened){event.preventDefault();event.stopPropagation();}
},true);
const glbMigration=$('glb-migration-dialog'),migrationStart=$('start-glb-migration'),migrationClose=$('close-glb-migration');
$('open-glb-migration').onclick=()=>{
  if(busy||modeler.isDragging()||surfaceTools.isEditing()||document.querySelector('dialog[open]'))return;
  document.querySelectorAll('.paint-menu[open]').forEach(menu=>menu.open=false);
  $('glb-migration-error').textContent='';
  glbMigration.showModal();
};
migrationClose.onclick=()=>glbMigration.close();
glbMigration.addEventListener('cancel',event=>{if(migrationStart.disabled)event.preventDefault();});
migrationStart.onclick=async()=>{
  migrationStart.disabled=migrationClose.disabled=true;
  migrationStart.textContent='正在转换并核对…';
  const error=$('glb-migration-error');error.textContent='';
  try{
    if(await run(async()=>{
      const next=await post('migrate-glb');
      await load(next.id);
    },error))glbMigration.close();
  }finally{
    migrationStart.disabled=migrationClose.disabled=false;
    migrationStart.textContent='迁移并打开新工程';
  }
};

historyPanel=setupPaintHistory({trigger:$('open-history'),read:()=>doc,load:id=>api('/api/projects/'+id+'/paint/history'),canEdit:()=>!busy&&!modeler.isDragging()&&!surfaceTools.isEditing()&&!uvSelection.isDragging()&&!uvSelection.isTransforming(),
  restore:(direction,steps,origin)=>run(async()=>{if(doc.id!==origin.id)throw Error('当前工程已切换');await api('/api/projects/'+origin.id+'/paint/'+direction,{revision:origin.revision,steps});approvedPreviewId=null;},$('history-error'))});
const newPaintDialog=$('new-paint-dialog'),importDialog=$('paint-import-dialog');
setupProjectFiles({canOpen:canOpenProjectDialog,
  create:(name,model,error,material,modelTemplate,preserveTextures,upAxis)=>run(async()=>{
    const options=new URLSearchParams({name,...(material==null?{}:{material}),...(!preserveTextures?{textures:'blank'}:{})});
    let project;
    if(model?.format==='obj'){
      const files=new FormData();
      files.append('model',model.file);
      for(const file of model.attachments)files.append('attachment',file);
      options.set('up',upAxis);
      project=await responseJson(await fetch('/api/projects/obj-import?'+options,{method:'POST',body:files}));
    }else if(model){
      project=await responseJson(await fetch('/api/projects/model-import?'+options,{
        method:'POST',headers:{'Content-Type':'model/gltf-binary'},body:model.file
      }));
    }else project=await api('/api/projects',{workflowType:'pbr_paint',name,modelTemplate});
    await load(project.id,{initialLayer:model?project.paint.layers[0]?.id:undefined});
  },error),
  restore:(archive,error)=>run(async()=>{
    const response=await fetch('/api/projects/paint-import',{method:'POST',
      headers:{'Content-Type':'application/zip'},body:archive});
    const project=await responseJson(response);
    await load(project.id);
  },error)
});
$('create-paint-backup').onclick=()=>run(async()=>{
  const job=await post('backup',{requestId:crypto.randomUUID()});
  pendingBackupId=job.id;
  $('status').textContent='正在生成工程副本…';
});
$('base').onclick=()=>{setSelection();render();areaSystem?.materialSelectionChanged();};
$('exit-mask-inspection').onclick=clearMaterialInspection;
function saveCollapsedFolders(){
  try{localStorage.setItem('arachne-paint-folders-'+doc.id,JSON.stringify([...collapsedFolders]));}catch{}
}
function selectedParent(){
  const active=layer();
  return active?.kind==='group'&&selection.size===1?active.id:active?layerParent(active):null;
}
function materialLayerOperation(kind){
  const target=kind==='fill'?libraryUI.target():null;
  const operation={op:'add',kind,parentId:selectedParent()};
  if(kind==='paint')operation.patch={name:'材质绘制层'};
  if(target?.library==='materials'){
    operation.patch={name:target.name,materialId:target.id,channels:Object.fromEntries(paintChannels.map(key=>[key,true]))};
  }
  return operation;
}
async function addAndSelect(...operations){
  const id=doc.id,generation=layerSelectionGeneration,ids=new Set(doc.paint.layers.map(l=>l.id));
  const next=await command(operations);
  if(doc?.id!==id||layerSelectionGeneration!==generation)return next;
  const added=next.paint.layers.filter(l=>!ids.has(l.id));
  if(added.length){
    const addedIds=new Set(added.map(l=>l.id));
    const roots=added.filter(l=>!addedIds.has(layerParent(l)));
    setSelection(roots.map(l=>l.id));
    if(collapsedFolders.delete(layerParent(roots[0])))saveCollapsedFolders();
    if(doc.revision===next.revision)render();
  }
  return next;
}
function groupSelection(){return addAndSelect({op:'group',ids:[...selection]});}
function duplicateSelection(){return addAndSelect(...[...selection].map(id=>({op:'duplicate',id})));}
$('add-folder').onclick=()=>run(()=>addAndSelect(materialLayerOperation('group')));
$('fill').onclick=()=>run(()=>addAndSelect(materialLayerOperation('fill')));
$('paint-layer').onclick=()=>run(async()=>{
  const id=doc.id,existing=new Set(doc.paint.layers.map(layer=>layer.id));
  const result=await addAndSelect(materialLayerOperation('paint'));
  const created=result.paint.layers.find(layer=>!existing.has(layer.id));
  await refresh();
  if(doc?.id===id&&created?.id===selected){
    if(areaSystem)areaSystem.openMaterialPainting();
    else activateSurface('paint');
  }
});
async function createDecal(image,position={}){
  const asset=doc.paint.assets[image];
  if(!asset)throw Error('先导入 PNG 素材');
  await addAndSelect({op:'add',kind:'decal',parentId:selectedParent(),patch:{image,name:asset.name,...position}});
}
function addCanvasImage(image,x=.5,y=.5){
  return run(async()=>{
    if(workArea!=='drawing'||uvSelection.isTransforming())return;
    setSelectValue($('source'),'live');setSelectValue($('compare-preview'),'');
    await createDecal(image,{space:'uv',x,y,scale:.25});
  });
}
$('uv-add-image').onclick=()=>{if(selectedAsset){if(areaSystem)void areaSystem.addImageAsset(selectedAsset).catch(error=>$('status').textContent=error.message);else void addCanvasImage(selectedAsset);}};
async function validateSurfacePlacement(hit){
  const response=await fetch(route()+'/live',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({revision:doc.revision,pickUv:[hit.u,hit.v]})});
  if(response.status===204)throw Object.assign(Error('工程已更新，请重新放置贴花'),{status:409});
  if(!response.ok)throw Error((await response.json()).error);
  const [code]=new Uint8Array(await response.arrayBuffer());
  if(code!==0)throw Error(({1:'这个落点属于保护区',2:'这个落点与其他表面共享 UV',3:'这个落点没有可写的原 UV'})[code]||'无法验证落点');
}
async function placeSurfaceAsset(image,projector,hit){
  await validateSurfacePlacement(hit);
  await createDecal(image,{projector});activateSurface('orbit');
}
async function replaceSurfaceProjection(projector,hit){
  const target=replaceProjection;
  if(!target||doc?.id!==target.projectId||doc.revision!==target.revision||selected!==target.layerId)
    throw Error('工程或选中图层已变化，请重新选择放置');
  const layer=doc.paint.layers.find(layer=>layer.id===target.layerId);
  if(!layer?.projector)throw Error('请选择三维贴花层');
  await validateSurfacePlacement(hit);
  await api(route()+'/commands',{revision:target.revision,operations:[{op:'update',id:target.layerId,
    patch:{projector:{...layer.projector,center:projector.center,normal:projector.normal,up:projector.up}}}]});
  replaceProjection=null;activateSurface('orbit');$('status').textContent='';
}
$('decal').onclick=()=>{
  if(!doc||busy||maskEditor.isOpen())return;
  replaceProjection=null;
  placeImage=selectedAsset||Object.keys(doc.paint.assets).at(-1);
  if(!placeImage){$('status').textContent='先导入 PNG 素材';return;}
  activateSurface('place');
};
$('asset-search').oninput=renderAssets;
function updateProjectUrl(){
  const params=new URLSearchParams({project:doc.id});
  history.replaceState(null,'','/paint.html?'+params);
}
async function pngData(blob){
  if(blob.size>24*1024*1024)throw Error('PNG 不能超过 24 MiB');
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result.split(',')[1]);
    reader.onerror=reject;reader.readAsDataURL(blob);
  });
}
async function importProjectPngs(files,origin,progress){
  const uploaded=[],failures=[];
  let revision=origin?.revision;
  const ok=await run(async()=>{
    if(!origin||doc?.id!==origin.id||doc.revision!==revision)throw Error('工程修订已变化，请重新打开材质窗口');
    for(const [index,file] of files.entries()){
      progress?.(index,files.length);
      if(doc?.id!==origin.id){failures.push('工程已切换，导入已停止');break;}
      try{
        const data=await pngData(file);
        const result=await api('/api/projects/'+origin.id+'/paint/assets',{revision,name:file.name,data});
        revision=result.document.revision;
        uploaded.push({id:result.asset.id,name:file.name});
      }catch(error){
        failures.push(file.name+' · '+error.message);
        if(error.status===409)break;
      }
    }
    progress?.(files.length,files.length);
  });
  if(ok!==true)throw Error('请结束当前操作或重新打开材质窗口');
  return {uploaded,failures};
}
async function importAsset(blob,name,placement){
  const target={id:doc.id,revision:doc.revision},data=await pngData(blob);
  if(doc.id!==target.id)throw Error('当前工程已切换');
  const {asset,document}=await api('/api/projects/'+target.id+'/paint/assets',{revision:target.revision,name,data,placement});
  if(doc.id!==target.id)throw Error('素材已保存至原工程，请重新打开原工程查看');
  selectedAsset=asset.id;$('asset-search').value='';libraryUI.showImages();
  if(doc.paint.assets[asset.id]){renderAssets();renderAssetRoles();}
  return document;
}

$('apply-asset').onclick=()=>run(()=>{
  const l=layer(),role=$('asset-role').value;
  if(selection.size!==1||!l||l.kind==='group'||!role||!doc.paint.assets[selectedAsset])return;
  if(role==='image'||role==='mask')return edit({[role]:selectedAsset});
  const documentMaps={...l.documentMaps};delete documentMaps[role];
  return edit({maps:{...l.maps,[role]:selectedAsset},...(l.kind==='fill'?{documentMaps}:{}),channels:{...l.channels,[role]:true}});
});
$('upload').onchange=()=>run(async()=>{
  const file=$('upload').files[0];if(!file)return;
  await importAsset(file,file.name);$('upload').value='';
});
for(const id of ['undo','redo','preview'])$(id).onclick=()=>{
  if(areaSystem&&id!=='preview')areaSystem.travelHistory(id);
  else if(workArea==='modeling'&&id!=='preview')modeler.travel(id);
  else void run(()=>post(id,{requestId:crypto.randomUUID()}));
};
function schedulePreview(reset=false){
  if(reset){clearTimeout(autoTimer);autoTimer=null;}
  if(!doc||!$('auto-preview').checked||autoTimer!==null||current()||
     jobs.some(j=>isPreview(j)&&(j.revision===doc.revision||['queued','running'].includes(j.status))))return;
  const projectId=doc.id,revision=doc.revision;
  autoTimer=setTimeout(()=>{
    autoTimer=null;
    if(doc?.id!==projectId||doc.revision!==revision||!$('auto-preview').checked||busy||polling||
       jobs.some(j=>isPreview(j)&&(j.revision===revision||['queued','running'].includes(j.status))))return;
    void run(()=>post('draft',{requestId:'auto-paint-'+revision}));
  },700);
}
$('auto-preview').onchange=()=>schedulePreview(true);
const uvNudgeKeys={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]};
const numpadDirections=new Set(['front','back','left','right','top','bottom']);
function navigateViewport(event){
  if(!event.target.matches('#viewport > canvas')||$('viewport').hidden||!viewportReady()||
     surfaceTools.isEditing()||modeler.isDragging()||modelMarquee)return;
  const command=navigationCommand(event);
  if(!command)return;
  if(numpadDirections.has(command))viewport.direction(command);
  else if(command==='projection')viewport.projection(!viewport.getState().orthographic);
  else if(command==='focus'){
    if(workArea!=='modeling'||!modeler.frameSelection())viewport.focusSelected();
  }else if(command==='local'){
    if(workArea!=='modeling'||!modeler.toggleLocalView())return;
  }else if(command==='zoomIn'||command==='zoomOut')viewport.navigate('zoom',command==='zoomIn'?.82:1/.82);
  else viewport.navigate(command);
  event.preventDefault();
}
document.addEventListener('keydown',event=>{
  if(compositionKey(event))return;
  if(areaSystem&&!areaSystem.legacyKeyboard(event))return;
  if(!doc||historyPanel?.isOpen()||assetViewer.isOpen||paintTextEditor.isOpen||newPaintDialog.open||importDialog.open||$('mask-editor').open||$('delivery-dialog').open||$('settings-dialog').open||projectDialog.open||event.defaultPrevented||
     event.target.closest?.('input,textarea,select,.custom-select,[contenteditable]'))return;
  const key=event.key.toLowerCase();
  if(key==='escape'&&locatingUV){event.preventDefault();setUVLocateMode(false);return;}
  if(key==='escape'&&marqueeArmed){event.preventDefault();setModelMarquee(false);return;}
  if(modelMarquee)return;
  if(workArea==='drawing'&&!event.altKey&&!event.metaKey&&!event.ctrlKey&&uvNudgeKeys[key]&&
     event.target.closest?.('#uv-view,#uv-transform-options')&&
     uvSelection.nudge(...uvNudgeKeys[key],event.shiftKey?10:1)){
    event.preventDefault();return;
  }
  if(event.repeat)return;
  if(event.code.startsWith('Numpad')&&workArea!=='drawing'){navigateViewport(event);return;}
  if(workArea==='modeling'&&event.code==='KeyH'&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!$('viewport').hidden){
    if(event.altKey?modeler.showAll():modeler.hideSelection())event.preventDefault();
    return;
  }
  if(event.altKey){
    if(workArea==='drawing'&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&
       ['Backspace','Delete'].includes(event.code)&&event.target.closest?.('#uv-view,#uv-selection-options')&&
       uvSelection.fill('material'))event.preventDefault();
    return;
  }
  if(workArea==='drawing'){
    if(!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&['x','d'].includes(key)){
      event.preventDefault();changePaintColors(target=>key==='x'?paintColors.swap(target):paintColors.reset(target));return;
    }
    if((event.metaKey||event.ctrlKey)&&['0','1','=','+','-'].includes(key)){
      event.preventDefault();
      if(key==='0')resetUV();else if(key==='1')actualUV();else zoomUV(key==='-'?.8:1.25);
      return;
    }
    if(key==='z'&&!event.metaKey&&!event.ctrlKey){event.preventDefault();setUVZoomTool(true);return;}
    if((event.metaKey||event.ctrlKey)&&key==='a'&&uvSelection.selectAll()){event.preventDefault();return;}
    if(((event.metaKey||event.ctrlKey)?key==='t':key==='v'&&!event.shiftKey)&&uvSelection.start()){
      event.preventDefault();return;
    }
    if((event.metaKey||event.ctrlKey)&&key==='d'&&uvSelection.hasSelection()){
      event.preventDefault();uvSelection.clear();return;
    }
    if(key==='enter'&&uvSelection.isTransforming()){event.preventDefault();void uvSelection.apply();return;}
    if((key==='delete'||key==='backspace')&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&
       event.target.closest?.('#uv-view,#uv-selection-options')&&uvSelection.erase()){
      event.preventDefault();return;
    }
    if(key==='escape'){
      if(uvZoomTool){event.preventDefault();setUVZoomTool(false);return;}
      if(placingText){event.preventDefault();setTextPlacement(false);return;}
      if(uvSelection.cancel()){event.preventDefault();return;}
      if(uvSelection.hasSelection()){event.preventDefault();uvSelection.clear();return;}
    }
    if(key==='m'&&!event.metaKey&&!event.ctrlKey){event.preventDefault();uvSelection.choose();return;}
    if(key==='l'&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey){event.preventDefault();uvSelection.choose('lasso');return;}
    if(key==='t'&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&chooseTextTool()){
      event.preventDefault();return;
    }
  }
  if(key==='escape'&&!modeler.cancelTransform()){if(replaceProjection)$('status').textContent='';replaceProjection=null;surfaceTools.cancel();}
  if((event.metaKey||event.ctrlKey)&&key==='z'){
    event.preventDefault();$(event.shiftKey?'redo':'undo').click();return;
  }
  if(key==='f2'&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&selection.size===1&&startLayerRename(selected)){
    event.preventDefault();return;
  }
  if((event.metaKey||event.ctrlKey)&&['g','d','j'].includes(key)&&selection.size&&workArea!=='modeling'&&!uvSelection.isTransforming()){
    event.preventDefault();void run(key==='g'?groupSelection:duplicateSelection);return;
  }
  if(event.metaKey||event.ctrlKey||event.shiftKey)return;
  if(workArea==='modeling'&&modeler.isDragging())return;
  if(workArea==='modeling'&&key==='/'&&!$('viewport').hidden&&modeler.toggleLocalView()){
    event.preventDefault();return;
  }
  if(workArea==='modeling'&&key==='.'&&!$('viewport').hidden&&modeler.frameSelection()){
    event.preventDefault();return;
  }
  if(workArea==='modeling'&&key==='tab'&&event.target.matches('#viewport > canvas')){
    event.preventDefault();modeler.toggleMode();return;
  }
  if(workArea==='modeling'&&key==='b'&&toggleModelMarquee()){
    event.preventDefault();return;
  }
  const modelTool={g:'translate',r:'rotate',s:'scale'}[key];
  if(workArea==='modeling'&&modelTool){
    event.preventDefault();modeler.setTool(modelTool);return;
  }
  if(workArea==='modeling'&&!$('viewport').hidden&&$('model-mode').value==='edit'&&['1','2','3'].includes(key)){
    event.preventDefault();modeler.setElement(['vertex','edge','face'][Number(key)-1]);return;
  }
  const viewKey={'1':'three','2':'uv','3':'split'}[key];
  if(viewKey&&workArea!=='drawing'){event.preventDefault();showView(viewKey);}
  if(key==='f'){event.preventDefault();fitView();}
  if(workArea==='modeling')return;
  if(workArea==='drawing'&&event.code==='Space'&&(uvPointerInside||event.target===$('uv-view'))&&
     !surfaceTools.isEditing()&&!uvSelection.isDragging()){
    event.preventDefault();uvHandHeld=true;$('uv-view').classList.add('hand-held');return;
  }
  if(key==='h'){event.preventDefault();activateSurface('orbit');}
  if(key==='b'&&(layer()?.kind==='paint'||paintTarget==='mask'&&layer()?.kind!=='group')){
    event.preventDefault();chooseBrush(false);
  }
  if(key==='e'&&(layer()?.kind==='paint'||paintTarget==='mask'&&layer()?.kind!=='group')){
    event.preventDefault();chooseBrush(true);
  }
  if(key==='4'&&workArea==='material'&&layer()&&layer().kind!=='group'){event.preventDefault();activateSurface('fill');}
  if(key==='x')surfaceTools.invertInk();
  if(key==='l'&&workArea==='material'&&['paint','mask'].includes($('viewport').dataset.tool)){event.preventDefault();surfaceTools.toggleMirror();}
  if(['i','p'].includes(key)&&layer()?.kind==='paint'){event.preventDefault();activateSurface('sample');}
  if(['[',']'].includes(key)&&surfaceTools.adjustRadius(key==='['?-1:1,workArea==='drawing'))event.preventDefault();
});
function releaseUVHand(){uvHandHeld=false;$('uv-view').classList.remove('hand-held');}
document.addEventListener('keyup',event=>{if(event.code==='Space')releaseUVHand();});
window.addEventListener('blur',releaseUVHand);
const deliveryPreferenceKey='arachne-paint-delivery-v1';
const deliveryControls={framing:$('delivery-framing'),size:$('delivery-size'),quality:$('delivery-quality')};
const texturePresetKey='arachne-texture-output',texturePresetControl=$('delivery-texture-preset');
texturePresetControl.replaceChildren(...Object.entries(textureExportPresets).map(([value,{label}])=>new Option(label,value)));
function syncTexturePreset(value=texturePresetControl.value){
  const preset=Object.hasOwn(textureExportPresets,value)?value:'separate';
  setSelectValue(texturePresetControl,preset);
  $('delivery-texture-hint').textContent=textureExportPresets[preset].hint;
}
let savedTexturePreset;
try{savedTexturePreset=localStorage.getItem(texturePresetKey);}catch{}
syncTexturePreset(savedTexturePreset??'separate');
texturePresetControl.onchange=()=>{
  syncTexturePreset();
  try{localStorage.setItem(texturePresetKey,texturePresetControl.value);}catch{}
  $('delivery-error').textContent='';
};
function readLocalDeliveryPreferences(){
  try{return JSON.parse(localStorage.getItem(deliveryPreferenceKey));}catch{return null;}
}
const renderPreferences=createRenderPreferences(readLocalDeliveryPreferences());
const workingDeliveryPreferences=()=>renderPreferences.read(doc);
const renderSettingsListeners=new Set();
const viewportSamplingKey='arachne-cycles-viewport-v1';
function readViewportSampling(){
  try{return viewportSamplingOptions(JSON.parse(localStorage.getItem(viewportSamplingKey)));}
  catch{return viewportSamplingOptions();}
}
let viewportSampling=readViewportSampling();
function setViewportSampling(value,persist=true){
  if(JSON.stringify(viewportSampling)===JSON.stringify(value))return;
  viewportSampling=value;
  if(persist)try{localStorage.setItem(viewportSamplingKey,JSON.stringify(value));}catch{}
  for(const listener of renderSettingsListeners)listener();
}
const renderResultsListeners=new Set();
function effectiveDeliveryPreferences(){
  const preferences=workingDeliveryPreferences();
  return preferences.framing==='saved'&&!doc?.paint.renderCamera?{...preferences,framing:'auto'}:preferences;
}
function syncDeliveryPreferences(){
  const preferences=effectiveDeliveryPreferences(),values=deliveryEditorValues(preferences);
  const size=deliveryControls.size.querySelector('option[value="custom"]'),quality=deliveryControls.quality.querySelector('option[value="custom"]');
  size.hidden=preferences.size!=='custom';size.textContent=`${values.width} × ${values.height} · 自定义`;
  quality.hidden=preferences.quality!=='custom';quality.textContent=`${values.samples} 次采样 · 自定义`;
  for(const [key,control] of Object.entries(deliveryControls))setSelectValue(control,preferences[key]);
  setSelectValue($('delivery-format'),values.fileFormat==='OPEN_EXR'?'exr'+(values.bitDepth??16):'png');
}
function changeDeliveryPreferences(change,{refresh=true,persist=true}={}){
  const before=JSON.stringify(workingDeliveryPreferences()),local=JSON.stringify(renderPreferences.local());
  change();syncDeliveryPreferences();
  const changed=before!==JSON.stringify(workingDeliveryPreferences()),next=JSON.stringify(renderPreferences.local());
  if(persist&&local!==next)try{localStorage.setItem(deliveryPreferenceKey,next);}catch{}
  if(!changed)return;
  approvedPreviewId=null;approvedRenderSettings=null;
  for(const listener of renderSettingsListeners)listener();
  $('delivery-error').textContent='';if(refresh&&doc)renderJobs();
}
function applyDeliveryPreferences(raw,options){changeDeliveryPreferences(()=>renderPreferences.set(doc,raw),options);}
syncDeliveryPreferences();
for(const [key,control] of Object.entries(deliveryControls)){
  control.onchange=()=>applyDeliveryPreferences({...workingDeliveryPreferences(),[key]:control.value});
}
$('delivery-format').onchange=()=>{
  const format=$('delivery-format').value;
  applyDeliveryPreferences(updateDeliveryOptions(workingDeliveryPreferences(),format==='png'?{fileFormat:'PNG',bitDepth:8}:
    {fileFormat:'OPEN_EXR',bitDepth:format==='exr32'?32:16}));
};
window.addEventListener('storage',event=>{
  if(event.key===viewportSamplingKey||event.key===null)setViewportSampling(readViewportSampling(),false);
  if(event.key===deliveryPreferenceKey||event.key===null)
    changeDeliveryPreferences(()=>renderPreferences.setLocal(readLocalDeliveryPreferences()),{persist:false});
  if(event.key===texturePresetKey||event.key===null)syncTexturePreset(event.newValue??'separate');
});
function deliveryViewport(){return areaSystem?.deliveryViewport()||viewport;}
function visibleDeliveryCamera(){return areaSystem?!!areaSystem.deliveryViewport():workArea==='material'&&!$('viewport').hidden&&viewportReady();}
function captureRenderSettings(){
  const preferences=effectiveDeliveryPreferences();
  const camera=preferences.framing==='viewport'&&visibleDeliveryCamera()?deliveryViewport().readCamera():null;
  return captureDeliverySettings(preferences,camera,doc?.paint.renderCamera);
}
async function changeProjectCamera(save){
  if(!doc)throw Error('请先打开工程');
  if(save&&!visibleDeliveryCamera())throw Error('请先打开三维视口');
  const camera=save?deliveryViewport().readCamera():null;
  if(save&&!camera)throw Error('请等待三维模型载入');
  if(!save&&!doc.paint.renderCamera)return;
  if(save&&sameDeliveryCamera(camera,doc.paint.renderCamera)){
    applyDeliveryPreferences({...workingDeliveryPreferences(),framing:'saved'});
    return;
  }
  if(await run(()=>command([{op:'renderCamera',camera}]))&&save)
    applyDeliveryPreferences({...workingDeliveryPreferences(),framing:'saved'});
}
async function editProjectCameraLens(patch){
  const saved=doc?.paint.renderCamera;
  if(!saved)throw Error('请先保存工程的渲染相机');
  let camera=saved;
  if(patch.projection&&patch.projection!==saved.projection)camera=projectionCamera(saved,patch.projection==='orthographic');
  if(patch.fov!==undefined)camera={...camera,fov:patch.fov};
  if(patch.orthoHeight!==undefined)camera={...camera,orthoHeight:patch.orthoHeight};
  if(!sameDeliveryCamera(camera,saved))await run(()=>command([{op:'renderCamera',camera}]));
}
function renderPresetStatus(){
  if(!doc)return {saved:false,changed:false,savable:false};
  const preferences=effectiveDeliveryPreferences(),saved=doc.paint.renderPreset;
  if(preferences.framing==='viewport')return {saved:!!saved,changed:true,savable:false};
  const preset=captureRenderPreset(preferences),changed=JSON.stringify(preset)!==JSON.stringify(saved);
  return {saved:!!saved,changed,savable:changed};
}
async function changeRenderPreset(save){
  if(!doc)throw Error('请先打开工程');
  const origin=doc.id,preset=save?captureRenderPreset(effectiveDeliveryPreferences()):null;
  if(JSON.stringify(preset)===JSON.stringify(doc.paint.renderPreset??null))return;
  if(await run(()=>command([{op:'renderPreset',preset}]))&&doc?.id===origin)
    changeDeliveryPreferences(()=>renderPreferences.reset(doc));
}
async function changeRenderAppearance(patch){
  if(!doc)throw Error('请先打开工程');
  const previous=doc.paint.renderAppearance||null;
  if(patch===null&&!previous)return;
  let appearance=null;
  if(patch!==null){
    const next={...(previous||renderAppearanceDefaults),...patch};
    if(patch.viewTransform&&!renderLooks(next.viewTransform).includes(next.look))next.look='None';
    appearance=checkRenderAppearance(next);
    if(matchesRenderAppearance(appearance,previous))return;
  }
  await run(()=>command([{op:'renderAppearance',appearance}]));
}
async function changeRenderLighting(patch){
  if(!doc)throw Error('请先打开工程');
  const current=doc.paint.renderLighting||null;
  const lighting=patch===null?null:checkRenderLighting({...(current||renderLightingDefaults),...patch});
  if(JSON.stringify(lighting)===JSON.stringify(current))return;
  await run(()=>command([{op:'renderLighting',lighting}]));
}
async function changeRenderOptics(patch){
  if(!doc)throw Error('请先打开工程');
  const current=doc.paint.renderOptics||null;
  const optics=patch===null?null:checkRenderOptics({...(current||renderOpticsDefaults),...patch});
  if(JSON.stringify(optics)===JSON.stringify(current))return;
  await run(()=>command([{op:'renderOptics',optics}]));
}
async function changeRenderRegion(patch){
  if(!doc)throw Error('请先打开工程');
  const current=doc.paint.renderRegion||null;
  const region=patch===null?null:checkRenderRegion({...current,...patch});
  if(JSON.stringify(region)!==JSON.stringify(current))await run(()=>command([{op:'renderRegion',region}]));
}
async function projectCameraForViewportTool(){
  if(!doc||!areaSystem||!visibleDeliveryCamera())throw Error('请先打开三维视口');
  const projectId=doc.id;
  if(!doc.paint.renderCamera)await changeProjectCamera(true);
  if(doc?.id!==projectId||!doc.paint.renderCamera)throw Error('工程相机未保存');
  return doc.paint.renderCamera;
}
async function drawProjectRenderRegion(){
  const camera=await projectCameraForViewportTool();
  if(!await areaSystem.drawRenderRegion(camera))throw Error('请先结束当前视口操作');
  applyDeliveryPreferences({...workingDeliveryPreferences(),framing:'saved'});
}
async function pickProjectFocus(){
  const camera=await projectCameraForViewportTool();
  if(!await areaSystem.pickRenderFocus(camera))throw Error('请先结束当前视口操作');
  applyDeliveryPreferences({...workingDeliveryPreferences(),framing:'saved'});
}
const paintRenderResults=createPaintRenderResults({
  read:()=>({doc,jobs,busy}),run,post,settings:()=>deliveryEditorValues(effectiveDeliveryPreferences()),
  camera:()=>{
    const {width,height,samples,camera,maxBounces,transparent}=captureRenderSettings();
    return {width,height,samples,camera,maxBounces,transparent};
  },
  openSettings:()=>$('open-render-settings').click(),openExport:()=>$('open-delivery').click()
});
cameraBatch=setupRenderCameraBatch({
  read:()=>doc,canOpen:canOpenProjectDialog,
  settings:()=>captureDeliverySettings({...effectiveDeliveryPreferences(),framing:'auto'}),
  submit:(id,request,error)=>run(()=>api('/api/projects/'+id+'/paint/render-batch',request),error),
  onSubmitted:()=>$('open-task-monitor').click()
});
const renderResultsBridge={
  read:()=>({doc,jobs}),openJobs:paintRenderResults.open,
  subscribe(listener){renderResultsListeners.add(listener);return ()=>renderResultsListeners.delete(listener);}
};
const renderSettingsBridge={
  read:()=>deliveryEditorValues(effectiveDeliveryPreferences()),
  readViewportSampling:()=>viewportSampling,
  setViewportSampling:patch=>setViewportSampling(updateViewportSampling(viewportSampling,patch)),
  set:patch=>{
    if(patch.framing==='viewport'&&!visibleDeliveryCamera())throw Error('请先打开三维视口');
    if(patch.framing==='saved'&&!doc?.paint.renderCamera)throw Error('请先保存工程的渲染相机');
    applyDeliveryPreferences(updateDeliveryOptions(workingDeliveryPreferences(),patch));
  },
  projectPreset:renderPresetStatus,saveProjectPreset:()=>changeRenderPreset(true),
  clearProjectPreset:()=>changeRenderPreset(false),
  restoreProjectPreset:()=>changeDeliveryPreferences(()=>renderPreferences.reset(doc)),
  projectCamera:()=>doc?.paint.renderCamera||null,
  viewportCamera:()=>visibleDeliveryCamera()?deliveryViewport().readCamera():null,
  saveProjectCamera:()=>changeProjectCamera(true),
  clearProjectCamera:()=>changeProjectCamera(false),
  setCameraLens:editProjectCameraLens,
  projectAppearance:()=>doc?.paint.renderAppearance||null,
  setAppearance:changeRenderAppearance,
  projectLighting:()=>doc?.paint.renderLighting||null,
  setLighting:changeRenderLighting,
  projectOptics:()=>doc?.paint.renderOptics||null,
  setOptics:changeRenderOptics,pickFocus:pickProjectFocus,
  projectRegion:()=>doc?.paint.renderRegion||null,
  setRegion:changeRenderRegion,drawRegion:drawProjectRenderRegion,
  viewProjectCamera:()=>{
    const camera=doc?.paint.renderCamera;
    if(!camera||!visibleDeliveryCamera())return;
    if(areaSystem)areaSystem.showRenderCamera(camera);
    else deliveryViewport().applyCamera(camera);
  },
  subscribe:listener=>{renderSettingsListeners.add(listener);return ()=>renderSettingsListeners.delete(listener);},
  canUseViewport:visibleDeliveryCamera,openExport:()=>$('open-delivery').click(),openRender:paintRenderResults.open,
  openBatch:cameraBatch.open
};
function syncDeliveryControls(){
  const available=visibleDeliveryCamera();
  if(deliveryControls.framing.options[1].disabled===available)deliveryControls.framing.options[1].disabled=!available;
  deliveryControls.framing.options[2].disabled=!doc?.paint.renderCamera;
  if(!available&&workingDeliveryPreferences().framing==='viewport')applyDeliveryPreferences({...workingDeliveryPreferences(),framing:'auto'},{refresh:false});
  setSelectValue(deliveryControls.framing,effectiveDeliveryPreferences().framing);syncSelectMenu(deliveryControls.framing);
}
$('open-delivery').onclick=()=>{
  if(maskEditor.isOpen())return;
  syncDeliveryControls();$('delivery-dialog').showModal();
};
$('close-delivery').onclick=()=>$('delivery-dialog').close();
$('delivery-dialog').onclose=()=>{approvedPreviewId=null;approvedRenderSettings=null;renderJobs();};
$('delivery-preview-button').onclick=()=>run(()=>post('preview',{requestId:crypto.randomUUID()}));
$('retry-preview').onclick=()=>run(()=>post($('retry-preview').dataset.type==='paint-draft'?'draft':'preview',{requestId:crypto.randomUUID()}));
$('retry-export').onclick=()=>run(async()=>{
  const jobId=$('retry-export').dataset.job;
  if(!jobId)return;
  await post('export-retry',{jobId,requestId:crypto.randomUUID()});
  approvedPreviewId=null;approvedRenderSettings=null;
},$('delivery-error'));
$('cancel').onclick=()=>run(()=>{
  const active=deliveryJobs().find(job=>['queued','running'].includes(job.status));
  if(active)return post('cancel',{jobId:active.id});
});
$('export-textures').onclick=()=>run(async()=>{
  const previewId=current()?.id;
  if(previewId)await post('export-textures',{confirmed:true,previewId,texturePreset:texturePresetControl.value,requestId:crypto.randomUUID()});
},$('delivery-error'));
$('export-glb').onclick=()=>run(async()=>{
  const previewId=current()?.id;
  if(previewId)await post('export-glb',{confirmed:true,previewId,requestId:crypto.randomUUID()});
},$('delivery-error'));
$('delivery').onclick=()=>run(async()=>{
  if(!approvedPreviewId||approvedPreviewId!==current()?.id||!approvedRenderSettings)return;
  await post('export',{confirmed:true,previewId:approvedPreviewId,texturePreset:texturePresetControl.value,
    requestId:crypto.randomUUID(),settings:approvedRenderSettings});
  approvedPreviewId=null;
});
$('approved').onchange=()=>{
  approvedPreviewId=null;approvedRenderSettings=null;
  if($('approved').checked)try{
    approvedRenderSettings=captureRenderSettings();approvedPreviewId=current()?.id;
    $('delivery-error').textContent='';
  }catch(error){$('delivery-error').textContent=error.message;}
  renderJobs();
};
function fitView(){
  if(modeler.isDragging()||surfaceTools.isEditing()||modelMarquee)return;
  if(view==='uv')resetUV();
  else viewport.fit();
}
$('fit').onclick=fitView;
function renderProjection(position=selection.size===1?layer():null){
  const img=$('projection-art');
  if(view!=='projection')return;
  const guide=$('projection-guide').value,reference=$('projection-reference');
  reference.hidden=!guide;
  const guideUrl=route()+'/guide/'+guide;
  if(guide&&reference.getAttribute('src')!==guideUrl)reference.src=guideUrl;
  img.hidden=position?.kind!=='decal'||!!position.projector||position.space==='uv';
  if(img.hidden)return;
  const mask=inspectedMask()?.id===position.id;
  if(mask&&!position.mask){img.hidden=true;return;}
  const url=assetUrl(mask?position.mask:position.image);
  if(img.getAttribute('src')!==url)img.src=url;
  const original=mask?projectionGeometry:img;
  if(mask&&original.getAttribute('src')!==assetUrl(position.image))original.src=assetUrl(position.image);
  const ratio=original.naturalWidth&&original.naturalHeight?original.naturalWidth/original.naturalHeight:1;
  img.toggleAttribute('data-mask-inspection',mask);
  img.toggleAttribute('data-locked',!!lockOwner(position));
  img.alt=mask?'投影坐标蒙版':'当前贴花';
  Object.assign(img.style,{left:position.x*100+'%',top:position.y*100+'%',
    width:position.scale*Math.min(1,ratio)*100+'%',height:position.scale/Math.max(1,ratio)*100+'%',
    transform:`translate(-50%,-50%) rotate(${position.rotation}deg)`,
    opacity:mask ? .82 : position.opacity*(position.channelOpacity?.color??1),
    maskImage:position.mask&&!mask?`url("${assetUrl(position.mask)}")`:'none'});
}
function selectWorkArea(next){
  if(!Object.hasOwn(areaViews,next))return false;
  if(!doc||busy||document.querySelector('dialog[open]')||drag||modelMarquee||modeler.isDragging()||surfaceTools.isEditing()||uvSelection.isDragging()||maskEditor.isOpen()||$('delivery-dialog').open||$('settings-dialog').open)return false;
  if(next===workArea&&$('workspace').dataset.workArea===next)return true;
  setUVZoomTool(false);
  areaViews[workArea]=view;
  setTextPlacement(false);
  setUVLocateMode(false);
  setModelMarquee(false);
  workArea=next;
  rememberWorkbenchSession();
  $('workspace').dataset.workArea=next;
  $('uv-view').setAttribute('aria-label',next==='drawing'?'贴图画布':'UV 视图');
  $('surface-orbit').querySelector('.tool-label').textContent=next==='drawing'?'抓手':'查看';
  $('surface-orbit').title=next==='drawing'?'抓手 · H':'查看模型 · H';
  $('surface-paint').querySelector('.tool-label').textContent=next==='drawing'?'画笔':'三维画笔';
  $('surface-paint').title=next==='drawing'?'画笔 · B · Shift 拖动直线':'三维画笔 · B';
  $('surface-mask').querySelector('.tool-label').textContent=next==='drawing'?'蒙版':'三维蒙版笔刷';
  $('surface-mask').title=next==='drawing'?'蒙版笔刷 · Shift 拖动直线':'三维蒙版笔刷';
  const tools=$('surface-tool-buttons');
  if(next==='drawing')$('uv-transform-tool').after(tools);
  else $('surface-tools').prepend(tools);
  releaseUVHand();
  for(const control of areaButtons)control.setAttribute('aria-pressed',String(control.dataset.areaMode===next));
  const modeling=next==='modeling';
  if(!areaSystem)paintLayout.setWorkArea(next);
  if(modeling)clearLayerIsolation();
  if(modeling||next==='drawing'){
    inspectChannel=inspectMask=false;
    $('exit-mask-inspection').hidden=true;
  }
  if(!modeling)modeler.close();
  viewport.setWireframe(modeling&&modelWireframe);
  surfaceTools.setMode('orbit');
  uvSelection.stop();
  renderProperties();
  showView(areaViews[next]);
  renderCanvasChrome();
  shaderEditor?.sync();
  if(!areaSystem)workspaceMotion.sync(next);
  return true;
}
for(const control of areaButtons)control.onclick=async()=>{
  const next=control.dataset.areaMode;
  if(next!==workArea&&uvSelection.isTransforming()&&!await uvSelection.apply())return;
  selectWorkArea(next);
};
$('model-wireframe').onclick=()=>{
  if(workArea!=='modeling'||$('viewport').dataset.state!=='ready')return;
  modelWireframe=!modelWireframe;
  viewport.setWireframe(modelWireframe);
  $('model-wireframe').setAttribute('aria-pressed',String(modelWireframe));
};
$('model-ortho').onclick=()=>{
  if(workArea==='modeling'&&!modeler.isDragging()&&$('viewport').dataset.state==='ready')viewport.projection(!viewport.getState().orthographic);
};
$('model-export').onclick=async()=>{
  if(workArea!=='modeling'||modelExporting||!modelHasDraft)return;
  const name=doc.name.replace(/[\\/:*?"<>|]+/g,'-');
  modelExporting=true;
  $('model-export').disabled=true;
  $('status').textContent='';
  try{
    const buffer=await modeler.exportDraft();
    const url=URL.createObjectURL(new Blob([buffer],{type:'model/gltf-binary'}));
    const download=element('a');
    download.href=url;download.download=name+'-模型.glb';download.click();
    setTimeout(()=>URL.revokeObjectURL(url),30_000);
  }catch(error){$('status').textContent=error.message;}
  finally{
    modelExporting=false;
    $('model-export').disabled=!modelHasDraft||modeler.isDragging();
  }
};
$('viewport').addEventListener('viewport-camera',()=>{
  $('model-ortho').setAttribute('aria-pressed',String($('viewport').dataset.projection==='orthographic'));
  modeler.syncCamera();
  if(approvedPreviewId&&approvedRenderSettings?.camera&&visibleDeliveryCamera()&&!sameDeliveryCamera(approvedRenderSettings.camera,viewport.getRenderSettings().camera)){
    approvedPreviewId=null;approvedRenderSettings=null;renderJobs();
  }
});
function showView(id){
  if(modeler.isDragging()||surfaceTools.isEditing()||modelMarquee)return;
  if(id!=='three'&&maskEditor.isOpen()){ $('mask-status').textContent='请先保存或取消当前蒙版';return; }
  if(workArea==='drawing')id='uv';
  view=id;
  for(const mode of ['three','uv','split','projection'])$(mode).setAttribute('aria-pressed',String(mode===id));
  $('viewport').hidden=!['three','split'].includes(id);
  if($('viewport').hidden)setModelMarquee(false);
  if(id!=='split')setUVLocateMode(false);
  modelOutliner.show(workArea==='modeling'&&!$('viewport').hidden);
  $('uv-view').hidden=!['uv','split'].includes(id);
  $('view-splitter').hidden=id!=='split';
  $('projection-view').hidden=id!=='projection';
  viewport.setActive(!areaSystem&&!$('viewport').hidden);
  renderProjection();
  surfaceTools.render();
  if(doc)void renderTexture();
  if(!areaSystem&&doc&&!$('viewport').hidden)void ensureViewport();
}
async function ensureViewport(){
  const id=doc.id;
  if(!viewportReady()){
    if(viewportLoad?.id!==id){
      const task={id,promise:viewport.loadProject(doc)};
      viewportLoad=task;
      task.promise.finally(()=>{if(viewportLoad===task)viewportLoad=null;});
    }
    await viewportLoad.promise;
    if(doc?.id===id&&viewportReady())viewport.syncDocument(doc);
  }
  if(doc?.id!==id||$('viewport').hidden||!viewportReady())return;
  if(workArea==='modeling')modeler.open(viewport.modelingContext(),id);
  surfaceTools.render();
  void renderTexture();
}
for(const id of ['three','uv','split','projection'])$(id).onclick=()=>showView(id);
const projectionArt=$('projection-art'),projectionGeometry=new Image();
projectionGeometry.onload=()=>renderProjection();
$('projection-guide').onchange=()=>renderProjection();
for(const control of document.querySelectorAll('[data-transform]'))control.onclick=()=>{
  transform=control.dataset.transform;
  for(const item of document.querySelectorAll('[data-transform]'))item.setAttribute('aria-pressed',String(item===control));
};
const polar=(x,y,frame,l)=>[Math.hypot(x-frame.left-l.x*frame.width,y-frame.top-l.y*frame.height),
  Math.atan2(y-frame.top-l.y*frame.height,x-frame.left-l.x*frame.width)];
projectionArt.onload=()=>renderProjection(drag?.draft||layer());
projectionArt.onpointerdown=event=>{
  const l=layer();
  if(event.button!==0||busy||l?.kind!=='decal'||lockOwner(l))return;
  projectionArt.setPointerCapture(event.pointerId);
  drag={pointer:event.pointerId,revision:doc.revision,projectId:doc.id,layer:l,draft:l,
    mode:transform,x:event.clientX,y:event.clientY,frame:$('projection-frame').getBoundingClientRect()};
};
const clamp=value=>Math.max(0,Math.min(1,value));
const projectionFrame=$('projection-frame');
function canDropAsset(area='material',event){
  const assetDrag=currentAssetDrag();
  return workArea===area&&canAddLayer()&&!busy&&!surfaceTools.isEditing()&&!uvSelection.isTransforming()&&
    hasAssetDrag(event?.dataTransfer)&&!!assetDrag&&assetDrag.projectId===doc?.id&&assetDrag.revision===doc.revision;
}
projectionFrame.ondragover=event=>{
  if(!canDropAsset('material',event))return;
  event.preventDefault();event.dataTransfer.dropEffect='copy';projectionFrame.dataset.drop='';
};
projectionFrame.ondragleave=event=>{
  if(!projectionFrame.contains(event.relatedTarget))delete projectionFrame.dataset.drop;
};
projectionFrame.ondrop=event=>{
  delete projectionFrame.dataset.drop;
  if(!canDropAsset('material',event)||readAssetDrag(event.dataTransfer,doc)?.id!==currentAssetDrag()?.id)return;
  event.preventDefault();
  const {id}=currentAssetDrag();
  endAssetDrag();
  const frame=projectionFrame.getBoundingClientRect();
  const x=clamp((event.clientX-frame.left)/frame.width),y=clamp((event.clientY-frame.top)/frame.height);
  void run(()=>createDecal(id,{x,y}));
};
const surfaceHost=$('viewport');
const marqueeButton=$('model-box-select'),marqueeOverlay=$('model-marquee');
function setModelMarquee(armed){
  const previous=modelMarquee;
  modelMarquee=null;marqueeArmed=armed;marqueeOverlay.hidden=true;
  marqueeButton.setAttribute('aria-pressed',String(armed));
  surfaceHost.toggleAttribute('data-model-marquee',armed);
  if(previous&&surfaceHost.hasPointerCapture(previous.pointer))surfaceHost.releasePointerCapture(previous.pointer);
}
function toggleModelMarquee(){
  if(workArea!=='modeling'||busy||$('viewport').hidden||!viewportReady()||modeler.isDragging())return false;
  setModelMarquee(!marqueeArmed);
  if(marqueeArmed)surfaceHost.querySelector('canvas').focus({preventScroll:true});
  return true;
}
marqueeButton.onclick=toggleModelMarquee;
function marqueePoint(event,bounds){
  return [clamp((event.clientX-bounds.left)/bounds.width),clamp((event.clientY-bounds.top)/bounds.height)];
}
function marqueeBounds(event,drag){
  const [u,v]=marqueePoint(event,drag.bounds),[x,y]=drag.start;
  return [Math.min(u,x),Math.min(v,y),Math.max(u,x),Math.max(v,y)];
}
surfaceHost.addEventListener('pointerdown',event=>{
  if(!marqueeArmed||modelMarquee||event.button!==0||!event.target.matches('canvas'))return;
  const bounds=event.target.getBoundingClientRect();
  modelMarquee={pointer:event.pointerId,bounds,start:marqueePoint(event,bounds),
    action:event.altKey?'subtract':event.shiftKey?'extend':'replace'};
  surfaceHost.setPointerCapture(event.pointerId);
  event.preventDefault();event.stopImmediatePropagation();
},true);
surfaceHost.addEventListener('pointermove',event=>{
  if(modelMarquee?.pointer!==event.pointerId)return;
  const [left,top,right,bottom]=marqueeBounds(event,modelMarquee);
  const {width,height}=modelMarquee.bounds;
  Object.assign(marqueeOverlay.style,{left:left*width+'px',top:top*height+'px',
    width:(right-left)*width+'px',height:(bottom-top)*height+'px'});
  marqueeOverlay.hidden=false;
  event.stopImmediatePropagation();
},true);
for(const type of ['pointerup','pointercancel','lostpointercapture'])surfaceHost.addEventListener(type,event=>{
  if(modelMarquee?.pointer!==event.pointerId)return;
  const drag=modelMarquee,[left,top,right,bottom]=marqueeBounds(event,drag);
  setModelMarquee(false);
  if(type==='pointerup'&&(right-left)*drag.bounds.width>=3&&(bottom-top)*drag.bounds.height>=3)
    modeler.boxSelect([left*2-1,1-bottom*2,right*2-1,1-top*2],drag.action);
  event.preventDefault();event.stopImmediatePropagation();
},true);
surfaceHost.addEventListener('wheel',event=>{
  if(modelMarquee){event.preventDefault();event.stopImmediatePropagation();}
},{capture:true,passive:false});
window.addEventListener('blur',()=>{if(marqueeArmed)setModelMarquee(false);});
function setUVLocateMode(active){
  locatingUV=active;
  $('uv-locate').setAttribute('aria-pressed',String(active));
  surfaceHost.toggleAttribute('data-uv-locate',active);
}
$('uv-locate').onclick=()=>{
  if(locatingUV){setUVLocateMode(false);return;}
  if(!doc||busy||workArea!=='material'||surfaceTools.isEditing()||maskEditor.isOpen())return;
  surfaceTools.setMode('orbit');
  if(view!=='split')showView('split');
  setUVLocateMode(true);
};
surfaceHost.addEventListener('pointerdown',event=>{
  if(!locatingUV||event.button!==0||event.altKey||!event.target.matches('canvas')||!viewportReady())return;
  event.preventDefault();event.stopImmediatePropagation();
  const hit=viewport.pickTargetUV(event.clientX,event.clientY);
  if(!hit){$('status').textContent='请点击目标材质表面';return;}
  uvPin=[clamp(hit.u),clamp(1-hit.v)];
  $('status').textContent='';
  setUVLocateMode(false);
  centerPinnedUV();
},true);
surfaceHost.ondragover=event=>{
  if(event.target.closest('#display-sidebar,.vp-axis')){delete surfaceHost.dataset.drop;return;}
  if(!canDropAsset('material',event)||surfaceHost.dataset.state!=='ready')return;
  event.preventDefault();event.dataTransfer.dropEffect='copy';surfaceHost.dataset.drop='';
};
surfaceHost.ondragleave=event=>{
  if(!surfaceHost.contains(event.relatedTarget))delete surfaceHost.dataset.drop;
};
surfaceHost.ondrop=event=>{
  delete surfaceHost.dataset.drop;
  if(event.target.closest('#display-sidebar,.vp-axis'))return;
  if(!canDropAsset('material',event)||readAssetDrag(event.dataTransfer,doc)?.id!==currentAssetDrag()?.id||surfaceHost.dataset.state!=='ready')return;
  event.preventDefault();
  const hit=viewport.pickTargetUV(event.clientX,event.clientY);
  if(!hit){$('status').textContent='请把贴花放在目标材质的可见表面';return;}
  const {id}=currentAssetDrag();endAssetDrag();
  const projector=surfaceTools.projectorAt(hit);
  void run(()=>placeSurfaceAsset(id,projector,hit));
};
projectionArt.onpointermove=event=>{
  if(drag?.pointer!==event.pointerId)return;
  const {layer:l,frame,x,y}=drag;
  const dx=event.clientX-x,dy=event.clientY-y;
  let patch={x:clamp(l.x+dx/frame.width),y:clamp(l.y+dy/frame.height)};
  if(drag.mode!=='move'){
    const [startRadius,startAngle]=polar(x,y,frame,l);
    const [radius,angle]=polar(event.clientX,event.clientY,frame,l);
    patch=drag.mode==='scale'?{scale:Math.max(.01,Math.min(4,l.scale*(startRadius<8?Math.exp(dx/100):radius/startRadius)))}:
      {rotation:l.rotation+(startRadius<8?dx:(angle-startAngle)*180/Math.PI)};
  }
  drag.draft={...l,...patch};
  renderProjection(drag.draft);
};
projectionArt.onpointerup=event=>{
  if(drag?.pointer!==event.pointerId)return;
  const gesture=drag;drag=null;
  const patch=Object.fromEntries(['x','y','scale','rotation'].filter(key=>gesture.draft[key]!==gesture.layer[key]).map(key=>[key,gesture.draft[key]]));
  if(gesture.projectId!==doc.id||gesture.revision!==doc.revision||gesture.layer.id!==selected){
    renderProjection();$('status').textContent='工程已变化，请重新拖动';return;
  }
  if(Object.keys(patch).length)void run(async()=>{
    try{await command([{op:'update',id:gesture.layer.id,patch}]);}
    catch(error){renderProjection();throw error;}
  });
};
projectionArt.onpointercancel=()=>{drag=null;renderProjection();};
const uvPane=$('uv-view');
function canvasDropPoint(event){
  const box=$('live-uv').getBoundingClientRect();
  if(!box.width||!box.height)return null;
  const x=(event.clientX-box.left)/box.width,y=(event.clientY-box.top)/box.height;
  return x>=0&&x<=1&&y>=0&&y<=1?[x,y]:null;
}
uvPane.addEventListener('pointerdown',event=>{
  if(!placingText||!canAddLayer()||busy||event.button!==0||uvHandHeld||uvZoomTool||event.target.closest('.uv-controls,#uv-wipe-control'))return;
  const point=canvasDropPoint(event);
  if(!point)return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const [x,y]=point,parentId=selectedParent();
  setTextPlacement(false);
  paintTextEditor.open({projectId:doc.id,revision:doc.revision,placement:{x,y,parentId}});
},true);
function canPlaceCanvasFile(){
  return workArea==='drawing'&&canAddLayer()&&!busy&&!maskEditor.isOpen()&&!$('delivery-dialog').open&&
    !surfaceTools.isEditing()&&!uvSelection.isTransforming();
}
const isPNG=file=>/\.png$/i.test(file.name)||file.type==='image/png';
function placeCanvasFile(file,[x,y],name=file.name){
  return run(async()=>{
    const previous=new Set(doc.paint.layers.map(layer=>layer.id));
    const parentId=selectedParent();
    const next=await importAsset(file,name,{x,y,parentId});
    setSelection([next.paint.layers.find(layer=>!previous.has(layer.id)).id]);
    if(collapsedFolders.delete(parentId))saveCollapsedFolders();
    setSelectValue($('source'),'live');setSelectValue($('compare-preview'),'');
  });
}
function canDropCanvasFile(event){
  return canPlaceCanvasFile()&&event.dataTransfer.types.includes('Files');
}
document.addEventListener('paste',event=>{
  if(areaSystem||!canPlaceCanvasFile()||event.defaultPrevented||
     event.target.closest?.('input,textarea,select,.custom-select,[contenteditable]'))return;
  const file=[...(event.clipboardData?.files||[])].find(isPNG);
  if(!file)return;
  event.preventDefault();
  void placeCanvasFile(file,[.5,.5],'粘贴图像.png');
});
// Keep an external image drop inside this app even when it misses the texture.
for(const type of ['dragover','drop'])window.addEventListener(type,event=>{
  if(workArea==='drawing'&&event.dataTransfer?.types.includes('Files'))event.preventDefault();
});
uvPane.ondragover=event=>{
  const valid=(canDropAsset('drawing',event)||canDropCanvasFile(event))&&canvasDropPoint(event);
  uvPane.toggleAttribute('data-drop',!!valid);
  if(!valid)return;
  event.preventDefault();event.dataTransfer.dropEffect='copy';
};
uvPane.ondragleave=event=>{if(!uvPane.contains(event.relatedTarget))delete uvPane.dataset.drop;};
uvPane.ondrop=event=>{
  delete uvPane.dataset.drop;
  const point=canvasDropPoint(event);
  if(!point)return;
  if(canDropAsset('drawing',event)&&readAssetDrag(event.dataTransfer,doc)?.id===currentAssetDrag()?.id){
    event.preventDefault();
    const {id}=currentAssetDrag();
    endAssetDrag();
    void addCanvasImage(id,...point);
  }else if(canDropCanvasFile(event)){
    event.preventDefault();
    const [file,...rest]=event.dataTransfer.files;
    if(!file||rest.length||!isPNG(file)){
      $('status').textContent='每次可拖入一张 PNG 图片';return;
    }
    void placeCanvasFile(file,point);
  }
};
function renderUV(){
  const {x,y,scale}=uvPose;
  const transform=`translate(${x}px,${y}px) scale(${scale})`;
  $('texture').style.transform=transform;
  $('live-uv').style.transform=transform;
  $('uv-guide').style.transform=transform;
  $('uv-wipe-texture').style.transform=transform;
  const percent=canvasZoomPercent(uvPose,uvPane.getBoundingClientRect());
  $('uv-reset').textContent=Number(percent.toFixed(1))+'%';
  if(document.activeElement!==$('canvas-zoom-percent')&&percent>0)$('canvas-zoom-percent').value=Number(percent.toFixed(2));
  uvSelection.render();
  renderUVPin();
  renderCanvasChrome();
}
function renderCanvasChrome(){
  if(!doc)return;
  const layerActions=$('drawing-layer-actions'),rail=document.querySelector('.tool-rail');
  for(const id of ['fill','paint-layer']){
    const button=$(id);
    if(areaSystem){if(button.parentElement!==layerActions)layerActions.append(button);}
    else if(workArea==='drawing'&&button.parentElement!==layerActions)layerActions.append(button);
    else if(workArea!=='drawing'&&button.parentElement!==rail)rail.insertBefore(button,$('decal'));
  }
  $('canvas-document-name').textContent=doc.name;
  $('canvas-document-channel').textContent=paintTarget==='mask'?'蒙版 · 8 位':$('channel').value==='color'?'颜色 · RGB / 8':(names[$('channel').value]||'写入诊断')+' · 8 位';
  $('add-layer-mask').disabled=!doc||busy||selection.size!==1||!layer()||layer().kind==='group'||!!lockOwner(layer())||uvSelection.isTransforming();
  renderPaintColors();
  const kind=$('uv-view').dataset.selectionTool;
  const mode=$('viewport').dataset.tool;
  const label=uvZoomTool?'缩放':placingText?'文字':uvSelection.isTransforming()?'自由变换':
    kind==='rect'?'矩形选框':kind==='lasso'?'套索':mode==='paint'?($('brush-erase').checked?'橡皮擦':'画笔'):
    mode==='mask'?($('brush-erase').checked?'蒙版橡皮擦':'蒙版笔刷'):mode==='sample'?'吸管':'抓手';
  $('canvas-active-tool').textContent=label;
  $('uv-zoom-tool').setAttribute('aria-pressed',String(uvZoomTool));
  $('uv-text-tool').setAttribute('aria-pressed',String(placingText&&!uvZoomTool));
  $('surface-tools').dataset.zoomTool=String(uvZoomTool);
  $('canvas-zoom-directions').hidden=!uvZoomTool;
  $('canvas-navigation-options').hidden=!uvZoomTool&&label!=='抓手';
  $('canvas-navigation-hint').textContent=uvZoomTool?'单击缩放 · Option 反向 · 空格拖动':'空格拖动画布 · 双击抓手适应画布';
  if(uvZoomTool)for(const id of ['uv-select-tool','uv-lasso-tool','uv-transform-tool','surface-orbit','surface-paint','surface-mask','uv-eraser-tool','surface-sample'])
    $(id).setAttribute('aria-pressed','false');
  renderDrawingLayerSettings();
}
function setUVZoomTool(active){
  if(uvZoomTool===active)return;
  if(active&&(!doc||workArea!=='drawing'||busy||surfaceTools.isEditing()||uvSelection.isDragging()||maskEditor.isOpen()))return;
  uvZoomTool=active;
  $('uv-view').toggleAttribute('data-zoom-tool',active);
  if(active)$('uv-view').dataset.zoomTool=uvZoomDirection;
  surfaceTools.render();uvSelection.render();renderCanvasChrome();
  if(active)$('uv-view').focus({preventScroll:true});
}
function renderUVPin(){
  const marker=$('uv-pin'),width=uvPane.clientWidth,height=uvPane.clientHeight;
  marker.hidden=!uvPin||!width||!height;
  $('uv-pin-edit').hidden=!uvPin||workArea!=='material';
  $('uv-pin-clear').hidden=!uvPin;
  if(marker.hidden)return;
  const size=Math.min(width,height)*uvPose.scale;
  marker.style.left=width/2+uvPose.x+(uvPin[0]-.5)*size+'px';
  marker.style.top=height/2+uvPose.y+(uvPin[1]-.5)*size+'px';
}
function centerPinnedUV(minimumScale=1){
  const scale=Math.max(minimumScale,uvPose.scale);
  const size=Math.min(uvPane.clientWidth,uvPane.clientHeight)*scale;
  uvPose={scale,x:(.5-uvPin[0])*size,y:(.5-uvPin[1])*size};
  uvZoomMode='fixed';
  renderUV();
}
$('uv-pin-clear').onclick=()=>{uvPin=null;renderUVPin();};
$('uv-pin-edit').onclick=()=>{
  if(!uvPin||!selectWorkArea('drawing'))return;
  setSelectValue($('source'),'live');setSelectValue($('compare-preview'),'');
  if($('channel').value==='coverage')setSelectValue($('channel'),'color');
  centerPinnedUV(2);
  void renderTexture();
  uvPane.focus({preventScroll:true});
};
let previousUVSize=null,previousUVArea=null;
function syncUVSize(){
  const next={width:uvPane.clientWidth,height:uvPane.clientHeight};
  if(next.width&&next.height){
    if(uvZoomMode==='fixed'&&previousUVSize&&previousUVArea===workArea)uvPose=resizeCanvas(uvPose,previousUVSize,next);
    previousUVSize=next;previousUVArea=workArea;
  }
}
new ResizeObserver(()=>{syncUVSize();renderUV();}).observe(uvPane);
function resetUV(){syncUVSize();uvZoomMode='fit';uvPose={scale:1,x:0,y:0};renderUV();}
function zoomUV(factor,clientX,clientY){
  // A tool can resize the canvas before its ResizeObserver is delivered.
  // Consume that resize before calculating a new zoom, exactly once.
  syncUVSize();
  const bounds=uvPane.getBoundingClientRect();
  if(!bounds.width||!bounds.height)return;
  uvZoomMode='fixed';
  uvPose=zoomCanvas(uvPose,bounds,factor,{x:clientX===undefined?bounds.width/2:clientX-bounds.left,
    y:clientY===undefined?bounds.height/2:clientY-bounds.top});
  renderUV();
}
function actualUV(){setCanvasPercent(100);}
function setCanvasPercent(percent){
  syncUVSize();
  const scale=canvasScale(percent,uvPane.getBoundingClientRect());
  if(scale!==null)zoomUV(scale/uvPose.scale);
}
$('uv-in').onclick=()=>zoomUV(1.25);
$('uv-out').onclick=()=>zoomUV(.8);
$('uv-reset').onclick=resetUV;
$('canvas-fit').onclick=resetUV;$('canvas-actual').onclick=actualUV;
$('uv-zoom-tool').onclick=()=>setUVZoomTool(true);
$('uv-zoom-tool').ondblclick=actualUV;
$('surface-orbit').ondblclick=resetUV;
for(const direction of ['in','out'])$('canvas-zoom-'+direction+'-mode').onclick=()=>{
  uvZoomDirection=direction;
  for(const option of ['in','out'])$('canvas-zoom-'+option+'-mode').setAttribute('aria-pressed',String(option===direction));
  if(uvZoomTool)uvPane.dataset.zoomTool=direction;
};
$('canvas-zoom-percent').onchange=()=>{
  const field=$('canvas-zoom-percent');
  if(field.value&&Number.isFinite(field.valueAsNumber))setCanvasPercent(field.valueAsNumber);
  field.blur();renderUV();
};
$('canvas-zoom-percent').onkeydown=event=>{
  if(event.key==='Enter'){event.preventDefault();$('canvas-zoom-percent').dispatchEvent(new Event('change'));uvPane.focus({preventScroll:true});}
  if(event.key==='Escape'){event.preventDefault();$('canvas-zoom-percent').blur();renderUV();uvPane.focus({preventScroll:true});}
};
uvPane.addEventListener('pointerdown',event=>{
  if(!uvZoomTool||uvHandHeld||event.button!==0||event.target.closest('.uv-controls,#uv-wipe-control'))return;
  const out=(uvZoomDirection==='out')!==event.altKey;
  zoomUV(out?0.8:1.25,event.clientX,event.clientY);
  event.preventDefault();event.stopImmediatePropagation();
},true);
uvPane.addEventListener('pointerenter',()=>{uvPointerInside=true;});
uvPane.addEventListener('pointerleave',()=>{uvPointerInside=false;$('canvas-pointer').textContent='';});
uvPane.addEventListener('pointermove',event=>{
  const point=canvasDropPoint(event);
  $('canvas-pointer').textContent=point?`X ${Math.min(4095,Math.floor(point[0]*4096))}   Y ${Math.min(4095,Math.floor(point[1]*4096))}`:'';
  if(uvZoomTool)uvPane.dataset.zoomTool=(uvZoomDirection==='out')!==event.altKey?'out':'in';
});
new MutationObserver(renderCanvasChrome).observe(uvPane,{attributes:true,attributeFilter:['data-selection-tool','data-text-placement']});
new MutationObserver(renderCanvasChrome).observe($('viewport'),{attributes:true,attributeFilter:['data-tool']});
$('drawing-layer-blend').onchange=()=>{
  const blend=$('drawing-layer-blend').value,channel=$('layer-channel').value;
  const target=doc&&layer();
  if(selection.size!==1||!target||target.kind==='group'||lockOwner(target)||channel&&!target.channels[channel])return;
  const patch=channel&&channel!=='color'?{channelBlend:{...target.channelBlend,[channel]:blend}}:{blend};
  void run(()=>edit(patch));
};
$('drawing-layer-opacity').onchange=()=>{
  const field=$('drawing-layer-opacity'),channel=$('layer-channel').value,target=doc&&layer();
  const opacity=field.valueAsNumber/100;
  if(field.value&&field.validity.valid){
    if(selection.size!==1||!target||target.kind==='group'||lockOwner(target)||channel&&!target.channels[channel])return;
    void run(()=>edit(channel?{channelOpacity:{...target.channelOpacity,[channel]:opacity}}:{opacity}));
  }
  else{field.blur();renderDrawingLayerSettings();}
};
$('drawing-layer-opacity').onblur=renderDrawingLayerSettings;
scrubNumber($('drawing-opacity-label'),$('drawing-layer-opacity'),{speed:.5,
  canStart:()=>!busy&&!surfaceTools.isEditing()&&!uvSelection.isTransforming()});
$('uv-guide-toggle').onclick=()=>{
  showUVGuide=!showUVGuide;
  $('uv-guide-toggle').setAttribute('aria-pressed',String(showUVGuide));
  if(doc)void renderTexture();
};
uvPane.addEventListener('wheel',event=>{
  if(event.target.closest('.uv-controls,#uv-wipe-control'))return;
  event.preventDefault();
  if(surfaceTools.isEditing()||uvSelection.isDragging())return;
  zoomUV(Math.exp(-Math.max(-120,Math.min(120,event.deltaY))/280),event.clientX,event.clientY);
},{passive:false});
uvPane.onpointerdown=event=>{
  if(![0,1].includes(event.button)||event.target.closest('.uv-controls,#uv-wipe-control'))return;
  if(event.button===0&&uvPane.hasAttribute('data-brushing')&&!uvHandHeld)return;
  syncUVSize();renderUV();
  event.preventDefault();
  uvPane.setPointerCapture(event.pointerId);
  uvPan={pointer:event.pointerId,x:event.clientX-uvPose.x,y:event.clientY-uvPose.y};
  uvPane.classList.add('panning');
};
uvPane.onpointermove=event=>{
  if(uvPan?.pointer!==event.pointerId)return;
  uvPose.x=event.clientX-uvPan.x;uvPose.y=event.clientY-uvPan.y;renderUV();
};
uvPane.onpointerup=uvPane.onpointercancel=uvPane.onlostpointercapture=()=>{
  uvPan=null;uvPane.classList.remove('panning');
};
const paintLayout=setupPaintLayout({surfaceIsEditing:()=>surfaceTools.isEditing()||uvSelection.isDragging()});
const paintDisplay=setupPaintDisplay(viewport,surfaceTools.isEditing);
const settingsSnapshot=()=>({version:1,preferences:{...preferences},brush:surfaceTools.getSettings(),display:paintDisplay.getSettings()});
function applySettings(bundle){
  preferences=bundle.preferences;applyAppearance(preferences);workspaceMotion.setMotion(preferences.motion);
  surfaceTools.setSettings(bundle.brush);paintDisplay.setSettings(bundle.display);
  liveView.preferencesChanged();areaSystem?.preferencesChanged();
}
if(desktopSettings?.initial)applySettings(desktopSettings.initial);
if(desktopSettings?.migrate)void desktopSettings.save(settingsSnapshot()).catch(()=>{});
setupPaintSettings({
  snapshot:settingsSnapshot,
  canOpen:()=>!busy&&!drag&&!modelMarquee&&!modeler.isDragging()&&!surfaceTools.isEditing()&&!uvSelection.isDragging()&&!uvSelection.isTransforming()&&!propertyDraft,
  apply:applySettings,
  save:desktopSettings?.save,
  refresh:desktopSettings?.refresh,
  storageLabel:desktopSettings?'设置保存在本机':'设置保存在此浏览器'
});
decorateWorkspaceButtons(document,{
  '#model-frame-selection':'focus','#model-box-select':'marquee','#uv-select-tool':'marquee','#uv-lasso-tool':'lasso',
  '#uv-transform-tool':'transform','#uv-text-tool':'text','#surface-orbit':'hand',
  '#uv-zoom-tool':'search',
  '#surface-paint':'brush','#surface-sample':'eyedropper','#surface-mask':'mask',
  '#uv-eraser-tool':'eraser','#fill':'fillLayer','#paint-layer':'plus','#asset-view':'image',
  '#add-layer-mask':'mask',
  '#uv-locate':'focus','#uv-pin-clear':'close','#toggle-layer-search':'search'
});
document.querySelector('.canvas-document-icon').innerHTML=workspaceIcons.image;
document.querySelectorAll('select').forEach(enhanceSelectMenu);

areaSystem=setupPaintAreas({read:()=>doc,initial:workArea,restoreActive:preferences.startupArea==='last',desktopWorkspace,run,api,pngData,importAsset,importProjectPngs,busy:()=>busy,
  renderSettings:renderSettingsBridge,renderResults:renderResultsBridge,
  materialInspection:()=>{const mask=doc&&inspectedMask();return mask?{kind:'mask',id:mask.id,projectId:doc.id}:doc&&isolatedLayerId?{kind:'layer',id:isolatedLayerId,projectId:doc.id}:null;},
  clearMaterialInspection,clearLayerIsolation,
  toggleMaterialIsolation:id=>{const item=doc?.paint.layers.find(layer=>layer.id===id);if(item)toggleLayerIsolation(item);},
  openImageText:(origin,layer,placement,color,onSaved)=>paintTextEditor.open({
    projectId:origin.id,revision:origin.revision,documentId:origin.documentId,layerId:layer?.id,placement,color,onSaved
  },layer),
  draft:op=>liveView.update(op),preferences:()=>preferences,
  selectLayer:id=>{setSelection(id?[id]:[]);render();},layerId:()=>selected,
  layerSelection:()=>[...selection],openMaterialLayerMenu,bindMaterialLayerDrag:materialLayerDrag.bind,
  selectMaterialLayer:selectMaterialLayerById,materialLayerOperation,canAddMaterialLayer:canAddLayer,
  selectResource:t=>libraryUI.select(t.library,t.id),resource:()=>libraryUI.target(),
  foreground:()=>paintColors.pair('paint').foreground,setForeground:color=>changePaintColors(()=>paintColors.set('paint','foreground',color),'paint'),
  maskInk:()=>maskGray(paintColors.pair('mask').foreground),setMaskInk:value=>changePaintColors(()=>paintColors.set('mask','foreground',value?'#ffffff':'#000000'),'mask'),
  colorPair:target=>paintColors.pair(target),setColor:(target,slot,value)=>changePaintColors(()=>paintColors.set(target,slot,value),target),
  colorKey:(key,target)=>changePaintColors(target=>key==='x'?paintColors.swap(target):paintColors.reset(target),target),
  workspaceChanged:(name,animate=true)=>workspaceMotion.sync(name,{animate}),
  contextChanged:renderAssetRoles,renderProperties,propertyKey:()=>[doc?.id,doc?.revision,selected,paintTarget,selection.size,workArea],propertyTarget:()=>({layerId:selected,target:paintTarget}),
  viewAsset:showAsset,error:message=>$('status').textContent=message,remember:rememberWorkbenchSession,
  activateImage:()=>!!doc&&selectWorkArea('drawing'),
  releaseImage:()=>{surfaceTools.cancel();uvSelection.stop();},
  imageEditing:()=>surfaceTools.isEditing()||uvSelection.isDragging()||uvSelection.isTransforming()||!!propertyDraft,
  getImageState:()=>({pose:{...uvPose},zoomMode:uvZoomMode,channel:$('channel').value}),
  cameraChanged:()=>{if(workingDeliveryPreferences().framing==='viewport'&&approvedPreviewId&&approvedRenderSettings?.camera&&visibleDeliveryCamera()&&!sameDeliveryCamera(approvedRenderSettings.camera,deliveryViewport().readCamera())){approvedPreviewId=null;approvedRenderSettings=null;renderJobs();}},
  restoreImageState:state=>{if(state.pose)uvPose={...state.pose};if(state.zoomMode)uvZoomMode=state.zoomMode;if(state.channel)setSelectValue($('channel'),state.channel);renderUV();}
});
// The native host asks before quitting; no project command or direct disk
// access is exposed to it. Active edits and pending writes must finish first.
Object.defineProperty(window,'arachneNativeHost',{value:createNativeWorkbench({window,document,imageCommand:action=>areaSystem?.imageCommand(action),flush:async()=>{
  if(desktopWorkspace){areaSystem?.areas.save();await desktopWorkspace.flush();}
},status:()=>{
  if(busy||[...projectWrites.values()].some(count=>count>0))return {state:'saving'};
  if([...projectSaveErrors.values()].some(Boolean))return {state:'error'};
  if(document.querySelector('dialog[open]:not(#task-monitor),.workspace-range-field[data-dragging],.workspace-range-field[data-editing],[data-document-dirty]')||
     propertyDraft||layerRename||modelMarquee||modeler.isDragging()||surfaceTools.isEditing()||uvSelection.isDragging()||uvSelection.isTransforming()||
     areaSystem?.areas.editors().some(editor=>editor.isEditing?.()))return {state:'editing'};
  if(jobs.some(job=>['queued','running'].includes(job.status)))return {state:'jobs'};
  return {state:'ready'};
}})});

$('uv-wipe').oninput=()=>{
  $('uv-wipe-overlay').style.clipPath=`inset(0 0 0 ${$('uv-wipe').value}%)`;
};
function exitMaskForTexture(){
  if(inspectMask){inspectMask=false;render();}
}
$('source').onchange=()=>{
  if($('source').value!=='live')clearLayerIsolation();
  setTextPlacement(false);exitMaskForTexture();uvSelection.sync();surfaceTools.render();void renderTexture();
};
$('channel').onchange=()=>{
  exitMaskForTexture();
  surfaceTools.render();void renderTexture();
};
$('compare-preview').onchange=()=>{
  exitMaskForTexture();
  if($('compare-preview').value){setSelectValue($('source'),'preview');clearLayerIsolation();}
  uvSelection.sync();
  if($('compare-preview').value&&view!=='split'&&view!=='uv')showView('split');
  else void renderTexture();
};
$('inspect-channel').onclick=()=>{
  if(workArea==='drawing')return;
  exitMaskForTexture();
  inspectChannel=!inspectChannel;
  if(inspectChannel&&view==='uv')showView('split');
  else void renderTexture();
};
if(areaSystem)setupWorkspaceLayouts({areas:areaSystem.areas,canOpen:canOpenProjectDialog});
const welcome=setupProjectWelcome({list:projects,open:(id,error)=>run(()=>load(id),error)});
taskMonitor=setupTaskMonitor({project:()=>doc,jobs:()=>jobs,busy:()=>busy,canOpen:canOpenProjectDialog,
  loadLog:(id,job)=>api('/api/projects/'+id+'/jobs/'+job+'/log'),
  cancel:(job,error)=>run(()=>post('cancel',{jobId:job.id}),error),
  retry:async(job,error)=>{
    const operations={'paint-preview':'preview','paint-draft':'draft','paint-backup':'backup','paint-render':'render-retry'};
    const operation=isPaintExport(job)?'export-retry':operations[job.type];
    if(!operation)return null;
    let next;
    const ok=await run(async()=>{next=await post(operation,{jobId:job.id,requestId:crypto.randomUUID()});},error);
    return ok?next:null;
  }
});
const rememberedWorkbench=restoreWorkbenchSession();
await run(async()=>{
  const params=new URLSearchParams(location.search);
  const id=params.has('project')?params.get('project'):rememberedWorkbench.projectId;
  let problem='';
  if(id){
    try{await load(id);return;}
    catch(error){
      if(![400,404,422].includes(error.status))throw error;
      problem=error.message;
    }
  }
  render();
  void welcome.refresh(problem);
});
if(!doc)render();
const requestedArea=preferences.startupArea==='last'?rememberedWorkbench.workArea:preferences.startupArea;
if(!areaSystem&&doc&&Object.hasOwn(areaViews,requestedArea))selectWorkArea(requestedArea);
areaSystem?.sync();
async function pollProject(){
  if(document.hidden||!doc||busy||polling)return;
  polling=true;
  try{await refresh();}
  catch(error){$('status').textContent=error.message;}
  finally{polling=false;}
}
setInterval(pollProject,1500);
document.addEventListener('visibilitychange',()=>void pollProject());
installPaintTooltips();
