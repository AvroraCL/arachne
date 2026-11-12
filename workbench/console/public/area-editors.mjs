import {enableResourceGridKeys,resourcePreview} from './paint-library-preview.mjs';
import {matchesSearch,searchTerms} from './search-picker.mjs';
import {surfaceControls,selectionControls} from './area-paint-controls.mjs';
import {createDocumentEditor,createImagePanel} from './image-document-editors.mjs';
import {createMaterialLayerEditor} from './material-layer-editor.mjs';
import {paintChannels,channelSpecs,renderChannel,liveStride} from './paint-channels.mjs';
import {headerControls,chromeButton,areaIcons,createContextActions} from './area-chrome.mjs';
import {projectionIsCurrent} from './paint-surface-state.mjs';
import {createViewport} from './viewport3d.mjs';
import {modelPivotLabels} from './paint-model-transform.mjs';
import {createPaintModeling} from './paint-modeling.mjs';
import {createViewportMarquee} from './paint-model-marquee.mjs';
import {createViewportDisplayControls} from './viewport-display-controls.mjs';
import {createSurfaceTools} from './paint-tools.mjs';
import {createShaderEditor} from './paint-shader-editor.mjs';
import {createMaterialMapDialog} from './material-map-dialog.mjs';
import {defaultLibraryMaterial,defaultBrushGraph} from './paint-library.mjs';
import {createBrushBinding} from './paint-brush-binding.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {navigationCommand} from './viewport-navigation.mjs';
import {layerIsVisible,layerLockOwner} from './paint-layer-tree.mjs';
import {workspaceIcons} from './workspace-icons.mjs';
import {outlineBranches,outlineNameMatches,outlineRows} from './scene-outline.mjs';
import {createSceneContextMenu} from './scene-context-menu.mjs';
import {objectClickSelection} from './paint-object-selection.mjs';
import {createPersonalShelf} from './personal-library-client.mjs';
import {startAssetDrag,endAssetDrag,hasAssetDrag,readAssetDrag} from './paint-asset-drag.mjs';
import {createShaderTargets} from './shader-targets.mjs';
import {createRenderSettingsEditor} from './render-settings-editor.mjs';
import {sampleMaterialFrame} from './paint-live-view.mjs';
import {viewportSamplingDefaults} from './cycles-viewport-sampling.mjs';
import {cameraFrameSize} from './render-camera-frame.mjs';
import {renderObjectVisible} from './render-visibility.mjs';
import {createRenderRegionGesture} from './render-region-gesture.mjs';
import {createCameraFocusGesture} from './camera-focus-gesture.mjs';
import {renderOpticsDefaults} from './render-optics.mjs';
import {createRenderResultEditor} from './render-result-editor.mjs';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
function visible(control,on){control.hidden=!on;(control.closest('.custom-select')||control).hidden=!on;}
function button(text,action,title=text){const b=el('button','',text);b.type='button';b.title=title;b.onclick=action;return b;}
function choice(label,values,value,change){const s=el('select');s.setAttribute('aria-label',label);for(const [id,name] of values)s.append(new Option(name,id));s.value=value;s.onchange=()=>change(s.value);return s;}
function selectedLayer(project){return project.document?.paint.layers.find(l=>l.id===project.layerId);}
function operation(graph,origin){return origin?.target?{op:'library',library:origin.target.library,id:origin.target.id,action:'update',patch:{graph}}:{op:'shader',graph};}
function getResource(project,state){const t=state.pin||project.resource;if(!t)return null;const entries=project.document?.paint[t.library],item=entries&&Object.hasOwn(entries,t.id)?entries[t.id]:null;return item?{...t,...item}:null;}
function syncInspectionControl(control,inspection,doc){
  control.hidden=!inspection;
  if(!inspection)return;
  control.textContent=inspection.kind==='mask'?'退出蒙版查看':'退出图层独显';
  control.title=doc?.paint.layers.find(layer=>layer.id===inspection.id)?.name||control.textContent;
}
function materialPreviewText(frame,inspection,preview){
  const request=frame?.request,size=request?.size;
  const actual=size?`${size} × ${size}${size===4096?' · 4K':''}`:'等待实时预览';
  const pending=inspection&&(inspection.kind==='mask'?request?.inspectMask:request?.isolatedLayer)!==inspection.id;
  const label=pending?'正在准备临时预览…':request?.inspectMask?'蒙版 · ':request?.isolatedLayer?'独显 · ':'';
  const state=preview?.error||preview?.phase==='error'?' · 更新失败':preview?.phase==='retrying'?' · 预览暂不可用，正在重试…':preview?.phase==='refining'?' · 正在提升到 4K…':'';
  return (pending?label:label+actual)+state;
}

// Scoped controls let the existing surface painter serve independent editor instances.
export function registerAreaEditors(registry,bridge){
  const viewportControllers=new Map();
  registry.register('viewport',ctx=>{
    const {host,project,state,onChange}=ctx,lifecycle=new AbortController(),signal=lifecycle.signal;
    let mode=state.mode||'object',disposed=false,shown=true,loading=null,projectId=null,revision=-1,frame=null,modelState=null,lastScene=null,placement=null,lastPointer=null,layerGeneration=0,modeGeneration=0;
    let picking=false,sampledBrush=null,pickerMessage='',navigating=false,wheelTimer=null,display;
    let cameraFrame=state.cameraFrame===true,returnCamera=state.returnCamera||null,cyclesPaused=state.cyclesPaused===true;
    let projectCameraView=cameraFrame&&state.projectCameraView===true,projectCameraKey='';
    const inModeling=()=>mode==='object'||mode==='edit';
    const toolbar=el('div','editor-toolbar'),view=el('div','editor-viewport'),axis=el('div','vp-axis'),status=el('output','editor-message');axis.dataset.axisSpace='blender';view.append(axis);
    const stage=el('div','editor-viewport-stage'),frameCaption=el('span','camera-frame-caption');
    stage.append(view,frameCaption);frameCaption.hidden=true;
    const controls=surfaceControls(view),elements=controls.elements;elements['brush-uv-radius'].closest('label').hidden=true;
    view.addEventListener('pointermove',event=>{if(event.target.tagName==='CANVAS')lastPointer={clientX:event.clientX,clientY:event.clientY};},{signal});
    view.addEventListener('pointerleave',()=>{lastPointer=null;},{signal});
    view.addEventListener('dragover',event=>{if(hasAssetDrag(event.dataTransfer)){event.preventDefault();event.dataTransfer.dropEffect='copy';}},{signal});
    view.addEventListener('drop',event=>{
      if(!hasAssetDrag(event.dataTransfer))return;event.preventDefault();
      const dragged=readAssetDrag(event.dataTransfer,project.document);if(!dragged){ctx.error(Error('素材所属工程或修订已变化，请重新拖动'));return;}
      if(modeler.isDragging()||painter.isEditing()){ctx.error(Error('请先结束当前操作'));return;}
      const hit=viewport.pickTargetUV(event.clientX,event.clientY);if(!hit){ctx.error(Error('请把贴花放在目标材质的可见表面'));return;}
      const origin=project.origin(),selected=project.layerId,name=project.document.paint.assets[dragged.id].name,projector=painter.projectorAt(hit);setMode('view');
      void bridge.validateSurface(hit,origin).then(()=>project.commands([{op:'add',kind:'decal',patch:{image:dragged.id,name,projector}}],origin)).then(doc=>{
        const added=doc.paint.layers.at(-1);if(!disposed&&project.document?.id===origin.id&&project.layerId===selected&&project.document.paint.layers.some(l=>l.id===added?.id))project.selectLayer(added.id);
      }).catch(ctx.error);
    },{signal});
    const modes=choice('交互模式',[['view','查看'],['object','物体模式'],['edit','编辑模式'],['paint','材质绘制'],['mask','蒙版绘制'],['fill','蒙版填充'],['place','贴花放置']],mode,next=>setMode(next));
    const component=choice('选择类型',[['vertex','点'],['edge','边'],['face','面']],state.element||'vertex',value=>{modeler.setElement(value);onChange();});
    function resetNumeric(){for(const i of axes){i.value=tool.value==='scale'?'1':'0';i.dispatchEvent(new Event('range-ui'));}}
    const tool=choice('变换工具',[['translate','移动'],['rotate','旋转'],['scale','缩放']],state.tool||'translate',value=>{modeler.setTool(value);resetNumeric();onChange();});
    for(const option of tool.options)option.dataset.shortcut={translate:'G',rotate:'R',scale:'S'}[option.value];
    const orientation=choice('变换坐标系',[['global','全局'],['local','局部']],state.orientation==='local'?'local':'global',value=>{
      if(!modeler.setOrientation(value)){orientation.value=modelState?.orientation||'global';syncSelectMenu(orientation);return;}
      resetNumeric();onChange();
    });
    const transformPivot=choice('变换枢轴',Object.entries(modelPivotLabels),Object.hasOwn(modelPivotLabels,state.pivot)?state.pivot:'median',value=>{
      if(!modeler.setPivot(value)){transformPivot.value=modelState?.pivotMode||'median';syncSelectMenu(transformPivot);return;}
      resetNumeric();syncSceneCursor();onChange();
    });
    const cursorMenu=createContextActions('三维游标',ctx.error);
    const selectionMenu=createContextActions('建模选择',ctx.error);
    const selectButton=button('选择',openSelectionMenu,'建模选择');
    selectButton.setAttribute('aria-label','建模选择');
    selectButton.setAttribute('aria-haspopup','menu');
    const cursorButton=chromeButton(button('三维游标',openCursorMenu),'pivot');
    cursorButton.title='三维游标 · Shift + S · Shift + 右键放置';
    cursorButton.setAttribute('aria-haspopup','menu');
    let cursorPointer=null,cursorKey='';
    const foreground=el('input');foreground.type='color';foreground.value=bridge.foreground();foreground.setAttribute('aria-label','前景色');
    foreground.oninput=()=>{sampledBrush=null;bridge.setForeground(foreground.value);syncPicker();};
    const materialPicker=button('材质取样',()=>setPicking(!picking),'材质取样 · I');
    chromeButton(materialPicker,'eyedropper');materialPicker.setAttribute('aria-keyshortcuts','I');
    const clearSample=button('清除材质取样',()=>{sampledBrush=null;syncPicker();});
    chromeButton(clearSample,'close');
    const maskInk=choice('蒙版画笔颜色',[['0','黑色 · 遮盖'],['1','白色 · 恢复']],String(Math.round(bridge.maskInk())),value=>bridge.setMaskInk(Number(value)));
    const createPaintLayer=button('＋ 材质绘制层',async()=>{
      if(bridge.busy()||!bridge.canAddMaterialLayer())return;
      try{
        const origin=project.origin(),before=new Set(project.document.paint.layers.map(l=>l.id)),selection=layerGeneration,interaction=modeGeneration;
        const result=await project.commands([bridge.materialLayerOperation('paint')],origin),added=result.paint.layers.find(l=>!before.has(l.id));
        if(disposed||project.document?.id!==origin?.id||!added||!project.document.paint.layers.some(l=>l.id===added.id))return;
        if(selection!==layerGeneration){status.textContent='已新建材质绘制层，保留当前选择';return;}
        project.selectLayer(added.id);if(interaction===modeGeneration)setMode('paint');
      }catch(error){ctx.error(error);}
    });
    const boxSelect=button('框选',()=>marquee.toggle(),'框选 · B · Shift 或中键减选');
    chromeButton(boxSelect,'marquee','框选');boxSelect.setAttribute('aria-keyshortcuts','B');boxSelect.setAttribute('aria-pressed','false');
    const frameButton=button('相机取景框',()=>toggleCameraFrame(),'相机取景框 · 小键盘 0');
    chromeButton(frameButton,'renderSettings');frameButton.setAttribute('aria-pressed','false');
    toolbar.append(modes,component,selectButton,tool,orientation,transformPivot,cursorButton,boxSelect,foreground,materialPicker,clearSample,maskInk,createPaintLayer,
      button('适应',()=>{markCameraFree();viewport.fit();}),
      button('正交',()=>{markCameraFree();viewport.projection(!viewport.getState().orthographic);onChange();}),frameButton);
    transformPivot.dataset.searchable='false';
    enhanceSelectMenu(transformPivot,{iconOnly:true,triggerIcon:workspaceIcons.pivot});
    const numeric=el('form','editor-toolbar');numeric.setAttribute('aria-label','物体变换');const axes=[];
    for(const axis of ['X','Y','Z']){const i=el('input');Object.assign(i,{type:'number',step:'any',value:state.tool==='scale'?'1':'0'});i.setAttribute('aria-label','变换 '+axis);axes.push(i);const l=el('label','',axis);l.append(i);numeric.append(l);}
    const apply=button('应用',()=>{});apply.type='submit';numeric.append(apply);numeric.onsubmit=e=>{e.preventDefault();try{modeler.applyNumeric(axes.map(i=>i.valueAsNumber));view.querySelector('canvas')?.focus({preventScroll:true});}catch(error){ctx.error(error);}};
    const previewBar=el('div','editor-preview-status'),resolution=el('output'),retry=button('重试预览',()=>{
      if(display.mode==='cycles')syncRenderPreview(true);else void bridge.retryPreview().catch(ctx.error);
    });
    const pauseCycles=button('暂停路径追踪',()=>{
      cyclesPaused=!cyclesPaused;
      syncCyclesControl();syncRenderPreview();onChange();
    });
    pauseCycles.classList.add('cycles-pause-control','viewport-display-button');pauseCycles.hidden=true;
    function syncCyclesControl(){
      const icon=cyclesPaused?'play':'pause',label=cyclesPaused?'继续路径追踪':'暂停路径追踪';
      if(pauseCycles.getAttribute('aria-label')!==label){chromeButton(pauseCycles,icon,label);pauseCycles.title=label;}
      pauseCycles.hidden=display.mode!=='cycles';
      pauseCycles.disabled=view.dataset.state!=='ready';
    }
    const exitInspection=button('',bridge.clearMaterialInspection),pickerStatus=el('span','material-picker-status');
    pickerStatus.setAttribute('role','status');
    exitInspection.hidden=retry.hidden=pickerStatus.hidden=true;
    previewBar.append(status,pickerStatus,resolution,retry,exitInspection);host.append(numeric,controls.bar,stage,previewBar);headerControls(ctx,toolbar);for(const b of toolbar.querySelectorAll('button')){const icon={'适应':'fit','正交':'orthographic'}[b.textContent];if(icon)chromeButton(b,icon);}
    const viewport=createViewport({host:view,animateAxes:true,localUI:true,onRenderPreviewStatus:syncPreviewStatus,onStatus:(text,kind)=>{
      // Background texture updates must not erase selection or transform feedback.
      if(kind==='error'||view.dataset.state!=='ready'||!['object','edit'].includes(mode))status.textContent=text;
    },onModelingPick:event=>{if(mode==='object'||mode==='edit'){modeler.pick(event);return true;}return false;}});
    const regionGesture=createRenderRegionGesture({host:view,signal,read:()=>project.document?.paint.renderRegion,
      origin:project.origin,commit:(region,origin)=>project.commands([{op:'renderRegion',region}],origin),
      changed:syncCameraFrame,error:ctx.error});
    const focusGesture=createCameraFocusGesture({host:view,signal,origin:project.origin,
      pick:(x,y)=>viewport.focusDistanceAt(x,y,project.document?.paint.renderVisibility),
      commit:(focusDistance,origin)=>project.commands([{op:'renderOptics',optics:{
        ...(project.document?.paint.renderOptics||renderOpticsDefaults),enabled:true,focusMode:'distance',focusDistance
      }}],origin),changed:syncCameraFrame,error:ctx.error});
    function syncCameraFrame(){
      stage.toggleAttribute('data-camera-frame',cameraFrame);
      frameButton.setAttribute('aria-pressed',String(cameraFrame));
      frameButton.disabled=view.dataset.state!=='ready';
      frameCaption.hidden=!cameraFrame;
      if(cameraFrame){
        const {width=1200,height=900}=bridge.renderSettings?.read()||{};
        const fit=cameraFrameSize(stage.clientWidth,stage.clientHeight,width,height);
        if(fit){
          stage.style.setProperty('--camera-frame-w',fit[0]+'px');
          stage.style.setProperty('--camera-frame-h',fit[1]+'px');
        }
        frameCaption.textContent=regionGesture.armed()?'拖出渲染区域 · Esc 取消':
          focusGesture.armed()?(focusGesture.missed()?'未拾取到模型 · 重新点击或 Esc':'点击模型设置对焦距离 · Esc 取消'):
            (projectCameraView?'工程相机':'相机取景框')+' · '+width+' × '+height;
      }
      regionGesture.sync(cameraFrame);
      syncRenderPreview();
    }
    function toggleCameraFrame(camera,enabled=!cameraFrame){
      if(view.dataset.state!=='ready'||modeler.isDragging()||painter.isEditing()||marquee.isDragging()||regionGesture.editing()||focusGesture.editing())return false;
      if(enabled&&camera){
        if(!returnCamera)returnCamera=viewport.readCamera();
        projectCameraView=true;projectCameraKey=JSON.stringify(camera);viewport.applyCamera(camera);
      }
      if(!enabled&&returnCamera){viewport.applyCamera(returnCamera);returnCamera=null;}
      if(!enabled){projectCameraView=false;projectCameraKey='';}
      cameraFrame=enabled;syncCameraFrame();onChange();return true;
    }
    function markCameraFree(){
      if(!projectCameraView)return;
      projectCameraView=false;projectCameraKey='';syncCameraFrame();onChange();
    }
    function syncProjectCamera(){
      if(!projectCameraView||view.dataset.state!=='ready')return;
      const camera=project.document?.paint.renderCamera;
      if(!camera){regionGesture.cancel();focusGesture.cancel();toggleCameraFrame(null,false);return;}
      const key=JSON.stringify(camera);
      if(key!==projectCameraKey){regionGesture.cancel();focusGesture.cancel();projectCameraKey=key;viewport.applyCamera(camera);}
    }
    async function armCameraTool(camera,gesture){
      const id=project.document?.id,key=JSON.stringify(camera);
      await Promise.all([regionGesture.settled(),focusGesture.settled()]);
      if(disposed||!shown||id!==project.document?.id||key!==JSON.stringify(project.document?.paint.renderCamera))return false;
      if(!toggleCameraFrame(camera,true))return false;
      return gesture.arm();
    }
    const drawRenderRegion=camera=>armCameraTool(camera,regionGesture);
    const pickRenderFocus=camera=>armCameraTool(camera,focusGesture);
    view.addEventListener('pointerdown',event=>{if(event.target.closest('.vp-axis'))markCameraFree();},{capture:true,signal});
    view.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)&&event.target.closest('.vp-axis'))markCameraFree();},{capture:true,signal});
    const cameraFrameObserver=new ResizeObserver(syncCameraFrame);
    cameraFrameObserver.observe(stage);
    const modeler=createPaintModeling(next=>{
      if(next.modal&&modelState?.modal){modelState=next;status.textContent=next.summary;return;}
      modelState=next;view.dataset.objectSelection=JSON.stringify(next.selectedIds);view.dataset.activeObject=String(next.activeId??'');numeric.hidden=!['object','edit'].includes(mode);visible(component,mode==='edit');visible(tool,['object','edit'].includes(mode));
      view.dataset.transformOrientation=next.orientation;visible(orientation,['object','edit'].includes(mode));orientation.disabled=next.dragging;syncSelectMenu(orientation);
      view.dataset.transformPivot=next.pivotMode;visible(transformPivot,inModeling());transformPivot.disabled=cursorButton.disabled=next.dragging;syncSelectMenu(transformPivot);
      view.dataset.modalTransform=next.modal?.tool||'';
      previewBar.classList.toggle('is-transforming',!!next.modal);
      if(tool.value!==next.tool){tool.value=next.tool;resetNumeric();}
      for(const control of [tool,modes,component]){control.disabled=next.dragging;syncSelectMenu(control);}
      for(const field of axes)field.disabled=next.dragging;
      apply.disabled=!next.hasTransformTarget||next.dragging;selectButton.disabled=boxSelect.disabled=!canBoxSelect();
      view.toggleAttribute('data-local-view',next.localActive);
      showModelStatus();
      syncRenderPreview();
      if(next.sceneItems.length){lastScene=next;if(!project.scene||project.scene.owner===ctx.areaId)publishScene();}
    },{signal,read:()=>project.document,save:(modeling,rev,id)=>bridge.saveModel(modeling,{id,revision:rev}),travel:direction=>project.travel(direction)});
    function canBoxSelect(){
      return inModeling()&&view.dataset.state==='ready'&&!!modelState&&!modelState.dragging&&
        (mode==='object'||modelState.activeId!=null&&modelState.topologyState!=='loading');
    }
    function showModelStatus(){
      status.textContent=marquee.isArmed()?'拖动框选 · Shift 或中键减选 · Esc 取消':
        (modelState?.summary||'')+(modelState?.localActive?' · 局部视图':'');
    }
    const marquee=createViewportMarquee({host:view,button:boxSelect,canStart:canBoxSelect,
      select:(rect,action)=>modeler.boxSelect(rect,action),onChange:showModelStatus,signal});
    function frameSceneObjects(ids){
      if(mode!=='object'&&mode!=='edit')setMode('object');
      return modeler.frameObjects(ids);
    }
    function publishScene(){
      if(!lastScene||disposed)return;
      const {sceneItems,activeId,selectedIds}=lastScene;
      project.publishScene({...lastScene,owner:ctx.areaId,
        activeLabel:sceneItems.find(item=>item.id===activeId)?.label||null,
        selectedLabels:selectedIds.map(id=>sceneItems.find(item=>item.id===id)?.label).filter(Boolean),
        select:(id,extend)=>{setMode('object');modeler.selectObject(id,extend);},
        selectMany:(ids,id)=>{setMode('object');modeler.setObjectSelection(ids,id);},
        toggle:id=>{setMode('object');modeler.toggleVisibility(id);},
        frame:id=>frameSceneObjects([id]),
        frameObjects:frameSceneObjects,
        inspectObject:id=>{const info=modeler.inspectObject(id);return info?{...info,label:project.document?.paint.objectNames?.[info.label]||info.label}:null;},
        setVisibility:(ids,value)=>{setMode('object');return modeler.setObjectVisibility(ids,value);},
        transformObject:(id,kind,values,space)=>modeler.transformObject(id,kind,values,space),
        showAll:()=>{setMode('object');modeler.showAll();}
      });
    }
    function currentSample(layer){
      if(!sampledBrush||sampledBrush.id!==project.document?.id||sampledBrush.layerId!==layer?.id||
        sampledBrush.foreground!==bridge.foreground()||sampledBrush.layerValues!==JSON.stringify(layer.values))return null;
      return sampledBrush.values;
    }
    function canPickMaterial(layer){
      return shown&&mode==='paint'&&view.dataset.state==='ready'&&!bridge.busy()&&layer?.kind==='paint'&&
        bridge.layerSelection().length===1&&!layerLockOwner(project.document.paint.layers,layer)&&
        layerIsVisible(project.document.paint.layers,layer)&&paintChannels.some(name=>layer.channels[name])&&
        bridge.materialPreview().inspection?.kind!=='mask';
    }
    function currentMaterialFrame(){
      const request=frame?.request,doc=project.document,{inspection}=bridge.materialPreview();
      return !!request&&!!doc&&request.id===doc.id&&request.revision===doc.revision&&!request.operation&&!request.inspectMask&&
        (request.isolatedLayer||null)===(inspection?.id||null);
    }
    function syncPicker(){
      const layer=selectedLayer(project),values=currentSample(layer);
      if(!values)sampledBrush=null;
      const available=canPickMaterial(layer);
      if(picking&&!available){
        picking=false;pickerMessage='';painter.setMode('paint');
      }
      if(picking&&pickerMessage&&currentMaterialFrame())pickerMessage='';
      foreground.value=values?.color||bridge.foreground();
      materialPicker.hidden=mode!=='paint';materialPicker.disabled=!available;
      materialPicker.setAttribute('aria-pressed',String(picking));
      clearSample.hidden=mode!=='paint'||!values||picking;
      const summary=values&&paintChannels.filter(name=>layer.channels[name]).map(name=>
        channelSpecs[name].name+' '+(typeof values[name]==='number'?values[name].toFixed(2):values[name].toUpperCase())).join(' · ');
      pickerStatus.textContent=picking?pickerMessage||'点击模型表面取样 · Esc 取消':mode==='paint'&&summary?'已取样 · '+summary:'';
      pickerStatus.title=pickerStatus.textContent;pickerStatus.hidden=!pickerStatus.textContent;status.hidden=!pickerStatus.hidden;
    }
    function setPicking(active){
      if(active===picking||active&&(!canPickMaterial(selectedLayer(project))||painter.isEditing()))return false;
      picking=active;pickerMessage='';painter.setMode(active?'sample':'paint');syncPicker();
      if(active)view.querySelector('canvas')?.focus({preventScroll:true});
      return true;
    }
    function pickMaterial(hit){
      const layer=selectedLayer(project),doc=project.document;
      const values=canPickMaterial(layer)&&currentMaterialFrame()&&sampleMaterialFrame(frame,hit.u,hit.v);
      if(!values){
        pickerMessage='等待当前材质预览 · Esc 取消';syncPicker();return false;
      }
      sampledBrush={id:doc.id,layerId:layer.id,layerValues:JSON.stringify(layer.values),foreground:bridge.foreground(),values};
      setPicking(false);
      return true;
    }
    const painter=createSurfaceTools({viewport,host:view,uvHost:controls.dummy,elements,settingsKey:'arachne-area-brush:'+ctx.areaId,preserveUnavailableMode:true,onIdle:()=>void sync().catch(ctx.error),
      context:()=>{const doc=project.document,l=selectedLayer(project);return {id:doc?.id,revision:doc?.revision,enabled:!bridge.busy()&&!['object','edit'].includes(mode)&&view.dataset.state==='ready',uvEnabled:false,
        brushColor:bridge.foreground(),sampledMaterial:currentSample(l),maskValue:bridge.maskInk(),maskTarget:['mask','fill'].includes(mode),layer:l?{...l,projectionCurrent:projectionIsCurrent(doc,l),visible:layerIsVisible(doc.paint.layers,l),locked:!!layerLockOwner(doc.paint.layers,l)}:null};},
      preview:(op,origin)=>{if(project.document?.id===origin.id&&project.document.revision===origin.revision)project.draft(op);},
      commit:(op,origin)=>void project.commands([op],origin).catch(error=>{project.draft(null);ctx.error(error);}),
      sample:pickMaterial,place:(projector,hit)=>{const origin=placement;if(!origin||origin.layerId!==project.layerId)return;void bridge.validateSurface(hit,origin).then(()=>project.commands([{op:'update',id:origin.layerId,patch:{projector}}],origin)).then(()=>{placement=null;setMode('view');}).catch(ctx.error);},isHandHeld:()=>false,uvClip:()=>null
    });
    const brushBinding=createBrushBinding({project,painter,onApplied:settings=>{elements['brush-mirror-enabled'].checked=settings.mirror;}});
    function displayModeChanged(){syncRenderPreview();syncPreviewStatus();bridge.viewportDisplayChanged?.();}
    display=createViewportDisplayControls({ctx,view,viewport,isEditing:()=>modeler.isDragging()||painter.isEditing(),
      openRenderSettings:()=>bridge.renderSettings?.openSettings(),renderPlayback:pauseCycles,
      onMode:displayModeChanged,
      change:({mode,xray,overlays,axis:showAxis,transform})=>{
        viewport.setDisplay(mode,xray,!!frame?.request.inspectMask);
        viewport.setOverlays(overlays);
        modeler.setDisplayHelpers({overlays,transform});
        axis.hidden=!showAxis;
      }
    });
    display.refresh();
    function syncRenderPreview(retry=false){
      const doc=project.document;
      const enabled=shown&&display?.mode==='cycles'&&doc?.id===projectId&&view.dataset.state==='ready';
      const sampling=bridge.renderSettings?.readViewportSampling?.()||viewportSamplingDefaults;
      const suspended=enabled&&(!!bridge.materialPreview().inspection||modeler.isDragging()||painter.isEditing()||marquee.isDragging());
      viewport.setRenderPreview({enabled,paused:cyclesPaused,suspended,interacting:navigating||wheelTimer!==null,
        samples:bridge.preferences().autoDetail?sampling.detailSamples:sampling.draftSamples},retry);
    }
    const unsubscribeCyclesSettings=bridge.renderSettings?.subscribe(syncCameraFrame);
    function syncPreviewStatus(){
      syncCyclesControl();
      const {inspection,status:preview}=bridge.materialPreview(),cycles=viewport.renderPreviewState();
      const rendered=display.mode==='cycles'&&cycles?.phase!=='off'&&cycles;
      resolution.textContent=rendered?cycles.text:materialPreviewText(frame,inspection,preview);
      resolution.title=rendered?cycles.text:preview?.message||'';
      retry.hidden=rendered?!cycles.retry:!(preview?.error||preview?.phase==='error');
    }
    elements['brush-mirror-enabled'].onchange=()=>{const settings=painter.getSettings();painter.setSettings({...settings,mirror:elements['brush-mirror-enabled'].checked});onChange();};
    function syncSceneCursor(){
      const saved=project.document?.paint.sceneCursor;
      const position=inModeling()?(saved||(transformPivot.value==='cursor'?[0,0,0]:null)):null;
      viewport.setSceneCursor(position);
      const next=JSON.stringify(saved||null);
      if(next!==cursorKey){cursorKey=next;modeler.syncPivot();}
    }
    function canPlaceCursor(){
      return inModeling()&&view.dataset.state==='ready'&&!bridge.busy()&&!modeler.isDragging()&&
        !painter.isEditing()&&!marquee.isArmed()&&!focusGesture.armed()&&!regionGesture.armed();
    }
    async function saveSceneCursor(position){
      if(!canPlaceCursor())return;
      const previous=project.document?.paint.sceneCursor||null;
      if(JSON.stringify(previous)===JSON.stringify(position))return;
      await project.commands([{op:'sceneCursor',position}],project.origin());
    }
    function openCursorMenu(){
      if(!canPlaceCursor())return false;
      const anchor=cursorButton.getBoundingClientRect(),selected=modeler.selectionOrigin();
      cursorMenu.open({clientX:anchor.left,clientY:anchor.bottom},'三维游标',[
        {label:'游标到选中项',icon:'focus',enabled:!!selected,run:()=>saveSceneCursor(selected)},
        {label:'游标到世界原点',icon:'pivot',enabled:!!project.document?.paint.sceneCursor,run:()=>saveSceneCursor(null)}
      ]);
      return true;
    }
    function openSelectionMenu(){
      if(!canBoxSelect())return false;
      const anchor=selectButton.getBoundingClientRect(),edit=mode==='edit';
      const apply=action=>()=>{action();view.querySelector('canvas')?.focus({preventScroll:true});};
      selectionMenu.open({clientX:anchor.left,clientY:anchor.bottom},'选择',[
        {label:'全选',icon:'marquee',shortcut:'A',run:apply(()=>modeler.selectAll())},
        {label:'取消选择',icon:'close',shortcut:'Alt A',run:apply(()=>modeler.selectAll(false))},
        {label:'反选',icon:'invert',shortcut:'Ctrl I',run:apply(()=>modeler.invertSelection())},
        ...(edit?[null,{label:'选择关联',icon:'shader',shortcut:'Ctrl L',enabled:!!modelState.elementCount,run:apply(()=>modeler.selectLinked())}]:[])
      ]);
      return true;
    }
    view.addEventListener('pointerdown',event=>{
      if(event.button!==2||!event.shiftKey||!event.target.matches('canvas')||!canPlaceCursor())return;
      event.preventDefault();event.stopImmediatePropagation();
      cursorPointer=event.pointerId;
      const position=viewport.cursorPointAt(event.clientX,event.clientY);
      if(position)void saveSceneCursor(position).catch(ctx.error);
    },{capture:true,signal});
    for(const type of ['pointerup','pointercancel'])view.addEventListener(type,event=>{
      if(event.pointerId!==cursorPointer)return;
      cursorPointer=null;event.stopImmediatePropagation();
    },{capture:true,signal});
    view.addEventListener('contextmenu',event=>{
      if(event.shiftKey&&event.target.matches('canvas')&&inModeling())event.preventDefault();
    },{signal});
    function setMode(next){
      if(modeler.isDragging()||painter.isEditing()){modes.value=mode;return;}
      marquee.cancel();cursorMenu.close();selectionMenu.close();
      modeGeneration++;mode=next;modes.value=next;picking=false;pickerMessage='';syncSelectMenu(modes);painter.setMode(['paint','mask','fill','place'].includes(mode)?mode:'orbit');
      if(view.dataset.state==='ready'){
        if(['object','edit'].includes(mode)){modeler.open(viewport.modelingContext(),project.document.id);modeler.setMode(mode);modeler.setElement(component.value);modeler.setTool(tool.value);modeler.setOrientation(orientation.value);modeler.setPivot(transformPivot.value);}
        else modeler.close();
      }
      foreground.hidden=mode!=='paint';visible(maskInk,['mask','fill'].includes(mode));numeric.hidden=!inModeling();controls.bar.hidden=!['paint','mask'].includes(mode);visible(component,mode==='edit');visible(tool,inModeling());visible(orientation,inModeling());visible(transformPivot,inModeling());cursorButton.hidden=selectButton.hidden=boxSelect.hidden=!inModeling();selectButton.disabled=boxSelect.disabled=!canBoxSelect();syncPicker();onChange();
      syncSceneCursor();syncRenderPreview();
    }
    function releaseFrame(){
      if(!frame)return;
      const wasMask=!!frame.request.inspectMask;
      frame=null;delete view.dataset.materialInspection;
      viewport.showLivePaint(null);
      if(wasMask)display.refresh();
    }
    function applyFrame(current){
      if(view.dataset.state!=='ready'||current===frame)return;
      if(!current){
        if(frame?.request.inspectMask||frame?.request.isolatedLayer)releaseFrame();
        return;
      }
      if(current.request.id!==projectId)return;
      const shadeChanged=!!frame?.request.inspectMask!==!!current.request.inspectMask;
      viewport.showLivePaint(current.pixels,current.request.size,null,{revision:current.request.revision,draft:!!current.request.operation});
      frame=current;
      if(shadeChanged)display.refresh();
      view.dataset.materialInspection=current.request.inspectMask?'mask':current.request.isolatedLayer?'layer':'';
    }
    async function sync(reselect=false){
      const doc=project.document;if(disposed||!doc)return;
      createPaintLayer.disabled=!bridge.canAddMaterialLayer();
      if(projectId!==doc.id){
        marquee.cancel();
        projectId=doc.id;lastScene=null;frame=null;revision=-1;navigating=false;delete view.dataset.materialInspection;modeler.close();
        const task=loading=viewport.loadProject(doc);
        syncRenderPreview();
        try{
          await task;
          if(disposed||task!==loading||doc.id!==project.document?.id||view.dataset.state!=='ready')return;
          viewport.setActive(shown);
          if(state.camera)viewport.applyCamera(state.camera);else if(state.direction)viewport.direction(state.direction);
          syncProjectCamera();
          syncCameraFrame();
          display.refresh();displayModeChanged();revision=doc.revision;
          modeler.open(viewport.modelingContext(),doc.id);setMode(mode);
          await sync(reselect);
        }catch(error){ctx.error(error);}
        return;
      }
      if(view.dataset.state!=='ready')return;
      syncSceneCursor();
      frameButton.disabled=false;
      if(doc.revision!==revision&&!modeler.isDragging()&&!painter.isEditing()){marquee.cancel();revision=doc.revision;viewport.syncDocument(doc);modeler.syncDocument();}
      brushBinding.sync(reselect);
      maskInk.value=String(Math.round(bridge.maskInk()));elements['brush-ink'].value=maskInk.value;syncSelectMenu(maskInk);
      if(!shown)return;
      const {frame:current,inspection}=bridge.materialPreview();
      applyFrame(current);syncPicker();painter.render();syncInspectionControl(exitInspection,inspection,doc);
      syncRenderPreview();syncPreviewStatus();ctx.title.textContent=doc.name;
    }
    function navigate(command){
      if(!command||view.dataset.state!=='ready'||modeler.isDragging()||painter.isEditing())return false;
      if(command!=='local')markCameraFree();
      if(['front','back','left','right','top','bottom'].includes(command))viewport.direction(command);
      else if(command==='projection')viewport.projection(!viewport.getState().orthographic);
      else if(command==='fit')viewport.fit();
      else if(command==='focus'){if(!inModeling()||!modeler.frameSelection())viewport.focusSelected();}
      else if(command==='local')return inModeling()&&modeler.toggleLocalView();
      else if(command==='zoomIn'||command==='zoomOut')viewport.navigate('zoom',command==='zoomIn'?.82:1/.82);
      else if(['orbitLeft','orbitRight','orbitUp','orbitDown','opposite'].includes(command))viewport.navigate(command);
      else return false;
      return true;
    }
    host.addEventListener('keydown',event=>{
      if(event.defaultPrevented||event.isComposing||event.target.closest('input,select,.custom-select,textarea,[contenteditable]'))return;
      const key=event.key.toLowerCase(),mod=event.metaKey||event.ctrlKey;
      if(focusGesture.armed()){
        if(key==='escape')focusGesture.cancel();
        event.preventDefault();event.stopPropagation();return;
      }
      if(regionGesture.armed()){
        if(key==='escape')regionGesture.cancel();
        event.preventDefault();event.stopPropagation();return;
      }
      if(event.ctrlKey&&!event.metaKey&&!event.shiftKey&&key==='b'&&bridge.renderSettings?.drawRegion){
        event.preventDefault();event.stopPropagation();
        const task=event.altKey?bridge.renderSettings.setRegion(null):bridge.renderSettings.drawRegion();
        void Promise.resolve(task).catch(ctx.error);return;
      }
      if((key==='enter'||key===' ')&&event.target.closest('button,summary'))return;
      if((picking&&key==='escape')||(key==='i'&&!mod&&!event.altKey&&!event.shiftKey&&mode==='paint')){
        if(!event.repeat&&setPicking(key!=='escape'&&!picking))event.preventDefault();
        event.stopPropagation();return;
      }
      if(marquee.isArmed()){
        if(key==='escape'||key==='b'&&!event.repeat)marquee.cancel();
        event.preventDefault();event.stopPropagation();return;
      }
      if(inModeling()&&!mod&&!event.altKey&&event.shiftKey&&key==='s'&&openCursorMenu()){
        event.preventDefault();event.stopPropagation();return;
      }
      if(['object','edit'].includes(mode)&&modeler.transformKey(event,lastPointer)){event.preventDefault();event.stopPropagation();resetNumeric();onChange();return;}
      if(mod&&key==='z'){event.preventDefault();if(['object','edit'].includes(mode)){if(!modeler.cancelTransform())modeler.travel(event.shiftKey?'redo':'undo');}else void project.travel(event.shiftKey?'redo':'undo').catch(ctx.error);}
      else if(key==='tab'&&event.target.matches('canvas')&&!mod&&!event.altKey&&!event.shiftKey){event.preventDefault();setMode(mode==='edit'?'object':'edit');}
      else if(key==='escape'){modeler.cancelTransform();painter.cancel({preserveMode:true});if(placement){placement=null;setMode('view');}}
      else if(['x','d'].includes(key)&&['paint','mask','fill'].includes(mode)){sampledBrush=null;bridge.colorKey(key,['mask','fill'].includes(mode)?'mask':'paint');maskInk.value=String(Math.round(bridge.maskInk()));syncPicker();}
      else if(!mod&&!event.altKey&&['g','r','s'].includes(key)&&['object','edit'].includes(mode)){tool.value={g:'translate',r:'rotate',s:'scale'}[key];syncSelectMenu(tool);modeler.setTool(tool.value);resetNumeric();onChange();event.preventDefault();}
      else if(inModeling()&&!mod&&!event.shiftKey&&event.code==='KeyA'){if(modeler.selectAll(!event.altKey))event.preventDefault();}
      else if(inModeling()&&mod&&!event.altKey&&!event.shiftKey&&key==='i'){if(modeler.invertSelection())event.preventDefault();}
      else if(mode==='edit'&&!event.altKey&&key==='l'){
        if(!event.repeat&&(mod&&!event.shiftKey?modeler.selectLinked():!mod&&lastPointer&&modeler.selectLinked(lastPointer,event.shiftKey)))event.preventDefault();
      }
      else if(inModeling()&&!mod&&!event.altKey&&!event.shiftKey&&key==='b'){if(!event.repeat&&marquee.toggle())event.preventDefault();}
      else if(mode==='object'&&!mod&&!event.shiftKey&&event.code==='KeyH'){if(event.altKey?modeler.showAll():modeler.hideSelection())event.preventDefault();}
      else if(!mod&&!event.altKey&&!event.shiftKey&&event.code.startsWith('Digit')&&['1','2','3'].includes(key)&&mode==='edit'){component.value={1:'vertex',2:'edge',3:'face'}[key];syncSelectMenu(component);modeler.setElement(component.value);event.preventDefault();}
      else{
        const plain=!mod&&!event.altKey&&!event.shiftKey;
        if(plain&&event.code==='Numpad0'){
          if(toggleCameraFrame(cameraFrame?null:project.document?.paint.renderCamera))event.preventDefault();
          event.stopPropagation();return;
        }
        const command=plain&&key==='/'?'local':plain&&key==='.'?'focus':navigationCommand(event);
        if(navigate(command))event.preventDefault();
      }
      event.stopPropagation();
    },{signal});
    window.addEventListener('blur',()=>{painter.cancel({preserveMode:true});navigating=false;syncRenderPreview();},{signal});
    // A paused image can outlive the current pose. Allow orbiting, but never pick through the old image.
    for(const type of ['pointerdown','pointerup'])view.addEventListener(type,event=>{
      if(view.dataset.renderPhase!=='paused'||event.target.tagName!=='CANVAS'||event.button!==0||event.altKey)return;
      event.preventDefault();event.stopPropagation();
    },{capture:true,signal});
    view.addEventListener('wheel',()=>{
      if(display.mode!=='cycles')return;
      clearTimeout(wheelTimer);
      wheelTimer=setTimeout(()=>{wheelTimer=null;syncRenderPreview();},110);
      syncRenderPreview();
    },{capture:true,passive:true,signal});
    view.addEventListener('viewport-interaction',event=>{navigating=event.detail.active;if(navigating)markCameraFree();syncRenderPreview();},{signal});
    view.addEventListener('viewport-camera',()=>{modeler.syncCamera();syncRenderPreview();bridge.cameraChanged?.();onChange();},{signal});
    const subscription=project.subscribe(event=>{
      if(!shown&&(event.kind==='frame'||event.kind==='preview'))return;
      if(event.kind==='project'){syncProjectCamera();syncCameraFrame();}
      if(event.kind==='selection'){layerGeneration++;setPicking(false);}
      if(event.kind==='scene'&&project.scene?.owner&&project.scene.owner!==ctx.areaId&&['object','edit'].includes(mode)){
        const ids=(project.scene.selectedLabels||[]).map(label=>modelState?.sceneItems.find(item=>item.label===label)?.id).filter(id=>id!==undefined);
        const activeId=modelState?.sceneItems.find(item=>item.label===project.scene.activeLabel)?.id;
        if(JSON.stringify(modelState?.selectedIds||[])!==JSON.stringify(ids)||modelState?.activeId!==activeId)modeler.setObjectSelection(ids,activeId);
      }
      void sync(event.kind==='resource').catch(ctx.error);
    });
    setMode(mode);viewportControllers.set(ctx.areaId,publishScene);
    viewport.setActive(true);void sync().catch(ctx.error);
    return {kind:'viewport',viewport,showRenderCamera:camera=>toggleCameraFrame(camera,true),drawRenderRegion,pickRenderFocus,wantsLiveDetail:()=>true,preferencesChanged:()=>syncRenderPreview(),getBrushSettings:()=>painter.getSettings(),isReady:()=>view.dataset.state==='ready',setPaintMode:setMode,reproject(layerId){placement={...project.origin(),layerId};setMode('place');status.textContent='点击模型表面重新放置贴花 · Esc 取消';},sync:()=>void sync().catch(ctx.error),activate(){publishScene();},
      getState:()=>({mode,element:component.value,tool:tool.value,orientation:orientation.value,pivot:transformPivot.value,...display.getState(),
        camera:view.dataset.state==='ready'?viewport.readCamera():state.camera,cameraFrame,returnCamera,projectCameraView,cyclesPaused}),
      isEditing:()=>modeler.isDragging()||painter.isEditing()||marquee.isDragging()||regionGesture.editing()||focusGesture.editing(),
      setVisible(visible){
        if(shown===visible)return;
        shown=visible;viewport.setActive(visible);
        if(visible)void sync().catch(ctx.error);
        else{display.close();navigating=false;marquee.cancel();regionGesture.cancel();focusGesture.cancel();setPicking(false);releaseFrame();syncRenderPreview();}
      },
      dispose(){disposed=true;clearTimeout(wheelTimer);cursorMenu.dispose();selectionMenu.dispose();marquee.cancel();subscription();lifecycle.abort();regionGesture.dispose();focusGesture.dispose();cameraFrameObserver.disconnect();unsubscribeCyclesSettings?.();display.dispose();painter.dispose();modeler.close();viewport.dispose();viewportControllers.delete(ctx.areaId);if(project.scene?.owner===ctx.areaId){project.publishScene(null);viewportControllers.values().next().value?.();}}};
  });

  registry.register('shader',ctx=>{
    const {host,project,state}=ctx;const chooser=el('div','editor-toolbar'),canvas=el('section','shader-editor');canvas.id='area-shader-'+ctx.areaId;
    let disposed=false,framed=!!state.view;const targetState=createShaderTargets(state);
    const target=choice('节点编辑目标',[], '',value=>{targetState.set(project.document,value==='follow'?null:value==='output'?{library:'output',id:'output'}:JSON.parse(value));editor.sync();ctx.onChange();});
    chooser.append(target);host.append(canvas);enhanceSelectMenu(target);
    function resource(){const pin=targetState.current(project.document);if(pin?.library==='output')return null;const item=getResource(project,{pin});return item||pin&&{...pin,name:'资源不可用',missing:true};}
    const editor=createShaderEditor({host:canvas,read:()=>project.document,readTarget:resource,busy:()=>bridge.busy(),viewKey:ctx.areaId,initialView:state.view,onViewChange:ctx.onChange,
      draft:(graph,origin)=>{if(disposed)return;if(origin?.target?.library==='brushes')project.setBrushDraft(ctx.areaId,origin,graph);else project.setNodeDraft(ctx.areaId,origin,graph?operation(graph,origin):null);},
      save:async(graph,origin)=>{await project.commands([operation(graph,origin)],origin);return true;},
      importImage:(file,nodeId,origin)=>bridge.importNode(file,nodeId,origin),viewAsset:bridge.viewAsset});
    const nodeTools=canvas.querySelector('.shader-toolbar');nodeTools.querySelector('[aria-label="最大化着色器编辑器"]').onclick=ctx.maximize;headerControls(ctx,chooser,nodeTools);
    let targets='';function sync(){if(disposed)return;const doc=project.document;if(!doc)return;const pin=targetState.current(doc),missing=pin&&pin.library!=='output'&&!Object.hasOwn(doc.paint[pin.library]||{},pin.id),next=JSON.stringify([doc.id,Object.entries(doc.paint.materials||{}).map(([id,m])=>[id,m.name]),Object.entries(doc.paint.brushes||{}).map(([id,b])=>[id,b.name]),missing?pin:null]);if(next!==targets){targets=next;target.replaceChildren(new Option('跟随资源选择','follow'),new Option('工程输出','output'),...['materials','brushes'].flatMap(library=>Object.entries(doc.paint[library]||{}).map(([id,item])=>new Option((library==='materials'?'材质 · ':'笔刷 · ')+item.name,JSON.stringify({library,id})))),...(missing?[new Option((pin.library==='materials'?'材质 · ':'笔刷 · ')+(pin.name||pin.id.slice(0,8))+'（不可用）',JSON.stringify({library:pin.library,id:pin.id}))]:[]));}
      target.value=pin?(pin.library==='output'?'output':JSON.stringify({library:pin.library,id:pin.id})):'follow';syncSelectMenu(target);
      editor.sync();ctx.title.textContent=resource()?.name||'工程输出';if(!framed&&(resource()?.graph||doc.paint.materialGraph)){framed=true;requestAnimationFrame(()=>{if(!disposed)editor.frameAll();});}
    }
    const unsub=project.subscribe(sync);sync();return {kind:'shader',sync,getState:()=>({...targetState.snapshot(),view:editor.getViewState()}),isEditing:editor.isEditing,dispose(){disposed=true;unsub();project.setBrushDraft(ctx.areaId,null,null);project.setNodeDraft(ctx.areaId,null,null);editor.dispose();}};
  });

  const leased=new Set();
  function legacy(type,ctx){
    if(leased.has(type)||!bridge.legacy[type])return null;
    leased.add(type);const mount=bridge.legacy[type](ctx);ctx.host.append(...mount.nodes);
    return {...mount,legacy:true,sync(){mount.sync?.();},dispose(){mount.dispose?.();for(const node of mount.nodes)bridge.parking.append(node);leased.delete(type);}};
  }
  registry.register('image',ctx=>createDocumentEditor(ctx,bridge));
  registry.register('uv',ctx=>createImageEditor(ctx,bridge,true));
  function materialProperties(ctx,scopeTarget=null){
    const form=el('form','editor-properties editor-scroll');
    form.tabIndex=-1;
    form.propertySections={...ctx.state.sections};
    form.onsubmit=e=>e.preventDefault();
    form.addEventListener('pointerdown',event=>{
      if(!event.target.closest('input,select,button,summary,.custom-select'))form.focus({preventScroll:true});
    },true);
    form.addEventListener('click',event=>{
      // A numeric label is a scrub handle, not native input activation.
      if(event.target.closest('.studio-scrub-label')){event.preventDefault();form.focus({preventScroll:true});}
    });
    form.addEventListener('keydown',event=>{
      if(!event.target.matches('.workspace-number-input')||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=='z')return;
      event.preventDefault();event.stopPropagation();
      void ctx.project.travel(event.shiftKey?'redo':'undo').catch(ctx.error);
    });
    form.addEventListener('property-section-change',ctx.onChange);
    ctx.host.append(form);let key='',first=true;
    const sync=()=>{
      if(!ctx.project.document)return;
      const scope=scopeTarget?.();if(scopeTarget&&!scope){if(key){form.replaceChildren();key='';}return;}
      const next=JSON.stringify(scopeTarget?[ctx.project.document.id,ctx.project.document.revision,scope]:bridge.propertyKey());if(next===key)return;key=next;
      const scroll=first?ctx.state.scroll||0:form.scrollTop,focused=form.contains(document.activeElement);first=false;
      bridge.renderProperties(form,scopeTarget?scope:null);
      for(const input of form.querySelectorAll('input[type=number]'))input.dataset.scrubNumber='';
      form.scrollTop=scroll;
      if(focused)form.focus({preventScroll:true});
    };
    const unsub=ctx.project.subscribe(sync);sync();
    return {sync,getState:()=>({scroll:form.scrollTop,sections:{...form.propertySections}}),dispose:unsub};
  }
  function materialPanel(ctx,factory){
    ctx.root.dataset.layerDomain='material';const host=el('div','domain-material-pane');ctx.host.append(host);
    const editor=factory({...ctx,host});return {...editor,domain:'material',activate(){ctx.project.setEditorDomain('material');}};
  }
  registry.register('properties',ctx=>materialPanel(ctx,materialProperties));
  registry.register('layers',ctx=>materialPanel(ctx,inner=>legacy('layers',inner)||createMaterialLayerEditor(inner,bridge)));
  registry.register('imageLayers',ctx=>createImagePanel('layers',{...ctx,busy:bridge.busy,openImageText:bridge.openImageText}));
  registry.register('imageProperties',ctx=>createImagePanel('properties',{...ctx,busy:bridge.busy,openMaterial:bridge.openMaterial,openImageText:bridge.openImageText}));
  registry.register('library',ctx=>legacy('library',ctx)||createLibraryEditor(ctx,bridge));
  registry.register('scene',ctx=>createSceneEditor(ctx));
  registry.register('renderResult',ctx=>createRenderResultEditor(ctx,bridge.renderResults));
  registry.register('renderSettings',ctx=>createRenderSettingsEditor(ctx,bridge.renderSettings,{
    propertyTarget:bridge.propertyTarget,busy:bridge.busy,
    material:(host,state,scope)=>materialProperties({...ctx,host,state},scope),
    drawing:(host,tools,root,project)=>createImagePanel('properties',{...ctx,host,tools,root,project,busy:bridge.busy,openMaterial:bridge.openMaterial,openImageText:bridge.openImageText})
  }));
  registry.register('console',ctx=>createConsoleEditor(ctx));
}

// UV editors paint synchronously into their own canvases. Share only a small
// scratch buffer, so visiting another channel cannot retain a second 4K image.
let uvRasterStrip;
function drawPreviewChannel(canvas,frame,channel,guide){
  const {pixels,request:{size}}=frame,stripHeight=Math.min(128,size);
  if(canvas.width!==size||canvas.height!==size)canvas.width=canvas.height=size;
  const context=canvas.getContext('2d'),stride=liveStride(pixels,size),rowStride=size*stride;
  if(uvRasterStrip?.width!==size)uvRasterStrip=context.createImageData(size,stripHeight);
  const {data}=uvRasterStrip;
  for(let top=0;top<size;top+=stripHeight){
    const bottom=Math.min(top+stripHeight,size);
    renderChannel(pixels,size,channel,data,top*size);
    if(guide)for(let row=top;row<bottom;row++){
      const edgeRow=row===0||row===size-1;
      let source=row*rowStride+5,target=(row-top)*size*4;
      for(let col=0;col<size;col++,source+=stride,target+=4){
        if((pixels[source]&4)&&(edgeRow||col===0||col===size-1||
          !(pixels[source-stride]&4)||!(pixels[source+stride]&4)||
          !(pixels[source-rowStride]&4)||!(pixels[source+rowStride]&4))){
          data[target]=data[target+1]=data[target+2]=215;
        }
      }
    }
    context.putImageData(uvRasterStrip,0,top,0,0,size,bottom-top);
  }
}
function createImageEditor(ctx,bridge,uv){
  const {host,project,state}=ctx,lifecycle=new AbortController(),signal=lifecycle.signal;
  let disposed=false,shown=true,space=false,nav=null,zoom=state.zoom||1,pan=state.pan||[0,0],mode=state.tool||'orbit',channel=state.channel||'color',frame=null,drawnChannel=null;
  const toolbar=el('div','editor-toolbar'),stage=el('div','editor-image-stage'),canvas=el('canvas'),status=el('output','editor-message');canvas.setAttribute('aria-label',uv?'UV 画布':'图像画布');stage.tabIndex=0;stage.append(canvas);host.append(toolbar,stage,status);
  const controls=surfaceControls(controlsHost()),elements=controls.elements;elements['brush-radius'].closest('label').hidden=true;elements['uv-brush-cursor'].className='area-uv-cursor';stage.append(elements['uv-brush-cursor']);elements['live-uv']=canvas;elements['viewport']=controls.dummy;
  function controlsHost(){const dummy=el('div');return dummy;}
  toolbar.append(button('适应',()=>{zoom=1;pan=[0,0];layout();}),button('100%',()=>{zoom=4096/Math.max(1,extent());layout();}));
  const channels=choice('图像通道',paintChannels.map(k=>[k,channelSpecs[k].name]),channel,value=>{channel=value;sync();ctx.onChange();});toolbar.append(channels);
  const exitInspection=button('',bridge.clearMaterialInspection),retry=button('重试预览',()=>void bridge.retryPreview().catch(ctx.error));
  exitInspection.hidden=retry.hidden=true;if(uv)toolbar.append(exitInspection,retry);
  if(!uv){for(const [id,label] of [['orbit','抓手'],['paint','画笔'],['mask','蒙版']])toolbar.append(button(label,()=>{selection.stop();mode=id;painter.setMode(id);layout();}));toolbar.append(button('新建绘制层',async()=>{try{const before=new Set(project.document.paint.layers.map(l=>l.id));await project.commands([{op:'add',kind:'paint'}]);const added=project.document.paint.layers.find(l=>!before.has(l.id));if(added)project.selectLayer(added.id);mode='paint';painter.setMode('paint');}catch(error){ctx.error(error);}}));host.insertBefore(controls.bar,stage);}
  function extent(){return Math.max(1,Math.min(stage.clientWidth,stage.clientHeight)-32);}
  function updateStatus(size=extent()){
    const {inspection,status:preview}=uv?bridge.materialPreview():{};
    status.textContent=`${Math.round(size*zoom/4096*1000)/10}% · ${materialPreviewText(frame,inspection,preview)}`;
  }
  function layout(){
    if(!shown)return;
    const size=extent();
    canvas.style.width=canvas.style.height=size+'px';
    canvas.style.transform=`translate(-50%,-50%) translate(${pan[0]}px,${pan[1]}px) scale(${zoom})`;
    controls.bar.hidden=uv||!['paint','mask'].includes(mode);
    updateStatus(size);
    selection?.sync();ctx.onChange();
  }
  stage.addEventListener('pointerdown',event=>{if(event.button===1||event.button===0&&(space||mode==='orbit'&&!event.target.closest('svg'))){nav={pointer:event.pointerId,x:event.clientX,y:event.clientY,pan:[...pan]};stage.setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();}},{capture:true,signal});
  stage.addEventListener('pointermove',event=>{if(nav?.pointer!==event.pointerId)return;pan=[nav.pan[0]+event.clientX-nav.x,nav.pan[1]+event.clientY-nav.y];layout();},{signal});
  const end=event=>{if(nav?.pointer!==event.pointerId)return;nav=null;if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);};
  for(const name of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(name,end,{signal});
  stage.addEventListener('wheel',event=>{event.preventDefault();const before=zoom;zoom=Math.max(.03,Math.min(40,zoom*Math.exp(-event.deltaY*.001)));const r=stage.getBoundingClientRect(),x=event.clientX-r.left-r.width/2,y=event.clientY-r.top-r.height/2;pan=[x-(x-pan[0])*zoom/before,y-(y-pan[1])*zoom/before];layout();},{passive:false,signal});
  const painter=createSurfaceTools({viewport:{},host:controls.dummy,uvHost:stage,elements,settingsKey:'arachne-area-brush:'+ctx.areaId,isHandHeld:()=>space||!!nav,uvClip:()=>selection?.clip(),onIdle:()=>sync(),
    context:()=>{const doc=project.document,l=selectedLayer(project);return {id:doc?.id,revision:doc?.revision,enabled:false,uvEnabled:!uv&&!bridge.busy(),brushColor:bridge.foreground(),maskValue:bridge.maskInk(),maskTarget:mode==='mask',layer:l?{...l,visible:layerIsVisible(doc.paint.layers,l),locked:!!layerLockOwner(doc.paint.layers,l)}:null};},
    preview:(op,origin)=>project.draft(op),commit:(op,origin)=>void project.commands([op],origin).catch(error=>{project.draft(null);ctx.error(error);}),sample:()=>false,place:()=>{}});
  const brushBinding=createBrushBinding({project,painter});
  let selection=null;
  if(!uv){selectionControls(elements,toolbar,stage);selection=bridge.createSelection({pane:stage,canvas,elements,isHandHeld:()=>space||!!nav,
    context:()=>{const doc=project.document,l=selectedLayer(project),editable=!!l&&!layerLockOwner(doc.paint.layers,l)&&!bridge.busy();return {active:true,interactive:!painter.isEditing()&&!nav,id:l?.id,projectId:doc?.id,revision:doc?.revision,canTransform:editable&&l.kind==='paint'&&!!l.strokes?.length,canClear:editable&&l.kind==='paint'&&!!l.strokes?.length,canFillMaterial:editable&&l.kind==='paint',canFillMask:editable};},
    activate:()=>{mode='select';painter.setMode('orbit');return true;},preview:op=>project.draft(op),commit:(op,owner)=>project.commands([op],{id:owner.projectId,revision:owner.revision}).then(()=>true,error=>{ctx.error(error);return false;}),fillOperation:(rect,target,value,polygon)=>painter.fillUV(rect,target,value,polygon)});}
  host.addEventListener('keydown',event=>{if(event.target.closest('input,textarea,select,.custom-select'))return;const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
    if(key===' '){space=true;event.preventDefault();}else if(mod&&key==='z'){event.preventDefault();void project.travel(event.shiftKey?'redo':'undo').catch(ctx.error);}else if(key==='escape'){nav=null;painter.cancel({preserveMode:true});selection?.cancel();}else if(!uv&&key==='m')elements['uv-select-tool'].click();else if(!uv&&key==='v')selection.start();else if(!uv&&key==='enter'&&selection.isTransforming())void selection.apply();else if(!uv&&key==='b'){mode='paint';selection.stop();painter.setMode('paint');}else if(key==='h'){mode='orbit';selection?.stop();painter.setMode('orbit');}else if(key==='x'||key==='d')bridge.colorKey(key,mode==='mask'?'mask':'paint');event.stopPropagation();},{signal});
  host.addEventListener('keyup',event=>{if(event.key===' ')space=false;},{signal});window.addEventListener('blur',()=>{space=false;nav=null;painter.cancel({preserveMode:true});},{signal});
  const resize=new ResizeObserver(layout);resize.observe(stage);
  function releaseRaster(){
    frame=null;canvas.width=canvas.height=1;delete canvas.dataset.materialInspection;
  }
  function sync(reselect=false){
    if(disposed||!shown)return;
    const material=uv?bridge.materialPreview():null,current=material?material.frame:project.frame;
    if(frame&&(frame.request.id!==project.document?.id||!current&&(frame.request.inspectMask||frame.request.isolatedLayer))){
      releaseRaster();
    }
    const mask=!!current?.request.inspectMask,nextChannel=mask?'color':channel;
    if(current&&current.request.id===project.document?.id&&(current!==frame||nextChannel!==drawnChannel)){
      drawPreviewChannel(canvas,current,nextChannel,uv&&!mask);
      frame=current;drawnChannel=nextChannel;
      canvas.dataset.materialInspection=mask?'mask':current.request.isolatedLayer?'layer':'';
    }
    if(uv){
      syncInspectionControl(exitInspection,material.inspection,project.document);
      const disabled=material.inspection?.kind==='mask';
      if(channels.disabled!==disabled){channels.disabled=disabled;syncSelectMenu(channels);}
      retry.hidden=!(material.status?.error||material.status?.phase==='error');
    }
    updateStatus();
    brushBinding.sync(reselect);
    painter.render();selection?.sync();ctx.title.textContent=project.document?.name||'';}
  const unsub=project.subscribe(event=>sync(event.kind==='resource'));sync();painter.setMode(mode);layout();
  headerControls(ctx,toolbar);
  return {kind:uv?'uv':'image',sync,getBrushSettings:()=>painter.getSettings(),setPaintMode(next){selection?.stop();mode=next;painter.setMode(next);layout();},getState:()=>({zoom,pan,channel,tool:mode}),isEditing:()=>!!nav||painter.isEditing()||selection?.isTransforming()||selection?.isDragging(),
    setVisible(visible){
      if(shown===visible)return;
      shown=visible;
      if(visible)sync();
      else releaseRaster();
    },
    dispose(){disposed=true;unsub();lifecycle.abort();resize.disconnect();painter.dispose();selection?.dispose();releaseRaster();}};
}

function createLibraryEditor(ctx,bridge){
  const {host,project,state}=ctx,toolbar=el('div','editor-toolbar'),body=el('div','editor-scroll'),status=el('output','editor-message');host.append(toolbar,body,status);
  let key='',kind=state.kind||'materials',query=state.query||'',scope=state.scope==='personal'?'personal':'project',pickedAsset=null,personal,scopeSelect,createResource,savePersonal,selectionGeneration=0,viewGeneration=0,disposed=false;
  enableResourceGridKeys(body);
  const search=el('input');search.type='search';search.placeholder='搜索';search.setAttribute('aria-label','搜索资源');search.value=query;search.oninput=()=>{query=search.value;key='';sync();ctx.onChange();};toolbar.append(search);
  function execute(ops,origin){return project.commands(ops,origin).catch(error=>{status.textContent=error.message;ctx.error(error);return false;});}
  function matching(doc){
    const terms=searchTerms(query);
    return Object.entries(doc.paint[kind]||{}).filter(([,item])=>matchesSearch(item.name,terms));
  }
  const personalHost=el('div','editor-scroll personal-editor-host');host.insertBefore(personalHost,status);
  personal=createPersonalShelf({
    host:personalHost,read:()=>project.document,canEdit:()=>!bridge.busy(),
    importResource:async(item,revision)=>{
      const view=viewGeneration,selection=selectionGeneration,result=await bridge.importPersonal(item,revision);
      return result===false?false:{result,view,selection};
    },
    onImported:(packet,projectId)=>{
      if(disposed||project.document?.id!==projectId||packet.view!==viewGeneration||packet.selection!==selectionGeneration)return false;
      const result=packet.result;scope='project';scopeSelect.value=scope;syncSelectMenu(scopeSelect);
      kind=result.resource.kind==='images'?'assets':result.resource.kind;tabs.value=kind;syncSelectMenu(tabs);
      if(kind==='assets')pickedAsset=result.resource.id;else project.selectResource({library:kind,id:result.resource.id});
      key='';sync();ctx.onChange();
    }
  });
  scopeSelect=choice('资源库范围',[['project','当前项目'],['personal','个人']],scope,value=>{scope=value;viewGeneration++;key='';sync();ctx.onChange();});toolbar.prepend(scopeSelect);enhanceSelectMenu(scopeSelect);
  const tabs=choice('资源类型',[['materials','材质'],['brushes','笔刷'],['assets','图片']],kind,value=>{kind=value;viewGeneration++;key='';sync();ctx.onChange();});toolbar.prepend(tabs);enhanceSelectMenu(tabs);
  createResource=button('＋ 新建',async()=>{
    if(kind==='assets'){file.click();return;}
    const id=crypto.randomUUID(),library=kind,origin=project.origin(),selection=selectionGeneration,view=viewGeneration;
    const patch={name:library==='materials'?'新材质':'新笔刷',graph:library==='materials'?defaultLibraryMaterial():defaultBrushGraph()};
    const result=await execute([{op:'library',library,id,action:'create',patch}],origin);
    if(result===false||disposed)return;
    if(project.document?.id===origin?.id&&scope==='project'&&kind===library&&view===viewGeneration&&selection===selectionGeneration&&Object.hasOwn(project.document.paint[library]||{},id))project.selectResource({library,id});
    else status.textContent='资源已新建，保留当前选择。';
  });toolbar.append(createResource);
  const mapDialog=createMaterialMapDialog({
    read:()=>project.document,origin:()=>project.origin(),upload:bridge.importProjectPngs,
    save:async(patch,origin)=>{
      const id=crypto.randomUUID(),view=viewGeneration,selection=selectionGeneration;
      await project.commands([{op:'library',library:'materials',id,action:'create',patch}],origin);
      if(!disposed&&project.document?.id===origin.id&&scope==='project'&&kind==='materials'&&
        view===viewGeneration&&selection===selectionGeneration){
        search.value=query='';key='';project.selectResource({library:'materials',id});ctx.onChange();
      }
    }
  });
  const fromMaps=chromeButton(button('从贴图创建材质',()=>mapDialog.open()),'image');
  toolbar.append(fromMaps);
  savePersonal=button('保存到个人库',()=>void personal.save(kind==='assets'?'images':kind,kind==='assets'?pickedAsset:project.resource?.library===kind?project.resource.id:null));toolbar.append(savePersonal);
  const selectedMaterial=()=>project.resource?.library==='materials'?project.resource.id:null;
  function applyMaterial(id){
    const material=project.document?.paint.materials?.[id];
    if(!material||bridge.busy())return;
    void execute([{op:'add',kind:'fill',patch:{materialId:id,name:material.name,channels:Object.fromEntries(paintChannels.map(key=>[key,true]))}}]);
  }
  const fill=button('创建填充层',()=>applyMaterial(selectedMaterial()));
  const preview=button('查看大图',()=>viewAsset(pickedAsset,preview));
  toolbar.append(fill,preview);
  function viewAsset(id,from){
    if(id&&project.document?.paint.assets[id])bridge.viewAsset(id,from,matching(project.document).map(([asset])=>asset));
  }
  const file=el('input');file.type='file';file.accept='image/png';file.hidden=true;file.onchange=()=>{if(file.files[0])void bridge.importAsset(file.files[0]);file.value='';};host.append(file);
  function sync(){
    const doc=project.document;if(!doc)return;
    if(pickedAsset&&!doc.paint.assets[pickedAsset])pickedAsset=null;
    const projectScope=scope==='project',image=kind==='assets';
    personal.set({kind:image?'images':kind,query,active:!projectScope});
    body.hidden=!projectScope;
    createResource.hidden=savePersonal.hidden=!projectScope;
    fromMaps.hidden=!projectScope||kind!=='materials';
    fromMaps.disabled=bridge.busy();
    savePersonal.disabled=bridge.busy()||!(image?pickedAsset:project.resource?.library===kind);
    fill.hidden=!projectScope||kind!=='materials';fill.disabled=bridge.busy()||!selectedMaterial();
    preview.hidden=!projectScope||!image;preview.disabled=!pickedAsset;
    ctx.title.textContent=doc.name;
    if(!projectScope)return;

    const entries=matching(doc);
    const next=JSON.stringify([doc.id,kind,entries,searchTerms(query)]);
    if(next!==key){
      key=next;
      const focused=body.contains(document.activeElement)?document.activeElement.dataset.resourceId:null;
      body.classList.add('library-grid');
      body.replaceChildren(...entries.map(([id,item])=>{
        const card=button('',()=>{
          if(image){pickedAsset=id;sync();}
          else project.selectResource({library:kind,id});
        },item.name);
        card.className='library-tile';card.dataset.resourceId=id;card.setAttribute('aria-label',item.name);
        card.append(resourcePreview(image?'images':kind,item,asset=>'/api/projects/'+doc.id+'/paint/assets/'+asset),el('span','library-name',item.name));
        if(image){
          card.ondblclick=()=>viewAsset(id,card);
          card.draggable=true;
          card.dataset.assetId=id;
          card.ondragstart=event=>{
            const current=project.document;
            if(current?.id!==doc.id||!Object.hasOwn(current.paint.assets,id)){
              event.preventDefault();ctx.error(Error('素材已变化，请重新拖动'));return;
            }
            startAssetDrag(event.dataTransfer,{id,projectId:current.id,revision:current.revision});
          };
          card.ondragend=endAssetDrag;
        }else if(kind==='materials')card.ondblclick=()=>applyMaterial(id);
        return card;
      }));
      if(!entries.length)body.append(el('p','library-empty',searchTerms(query).length?'没有匹配的资源':'当前项目还没有这类资源'));
      if(focused)body.querySelector('[data-resource-id="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
    }
    const selected=image?pickedAsset:project.resource?.library===kind?project.resource.id:null;
    for(const tile of body.querySelectorAll('.library-tile'))tile.setAttribute('aria-pressed',String(tile.dataset.resourceId===selected));
  }
  const unsub=project.subscribe(event=>{if(event.kind==='resource')selectionGeneration++;sync();});sync();headerControls(ctx,toolbar);return {sync,getState:()=>({query,kind,scope,scroll:body.scrollTop}),dispose(){disposed=true;unsub();mapDialog.dispose();personal.dispose();}};
}
function createSceneEditor(ctx){
  const {host,project,state}=ctx,toolbar=el('div','editor-toolbar editor-scene-tools'),search=el('input'),searchField=el('div','editor-scene-search'),list=el('div','editor-scroll editor-list editor-scene-list'),status=el('output','editor-scene-status');
  const closed=new Set(Array.isArray(state.collapsed)?state.collapsed.slice(0,1000):[]);let rootClosed=state.rootCollapsed===true,structureKey='',treeSelection=null,treeActive=null,restoredScroll=false;
  const empty=[],rowViews=new Map();let sourceItems=null,names=null,items=empty,itemKey='',itemVersion=0,matches=0,lastScene=null,lastTree=null,lastActive=null,sceneRoot=null;
  let renderFlags=null,renderSource=null,renderPending=false,renderDisposed=false,lastRenderKey='',renderRetryAt=0;
  const arrow='<svg class="chrome-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  search.type='search';search.placeholder='搜索物体';search.setAttribute('aria-label','搜索物体');search.value=state.query||'';
  const clear=button('清除物体搜索',clearSearch);
  chromeButton(clear,'close','清除物体搜索');clear.classList.add('outline-search-clear');
  searchField.innerHTML=workspaceIcons.search;searchField.append(search,clear);
  const show=button('显示全部',()=>project.scene?.showAll?.());chromeButton(show,'eye','显示全部');show.title='显示全部物体';
  const locate=button('定位活动物体',locateActive);chromeButton(locate,'focus','定位活动物体');locate.title='定位活动物体 · .';
  const filters=[['all','全部物体'],['visible','可见物体'],['hidden','隐藏物体'],['selected','选中物体'],['active','活动物体']];
  const filter=choice('筛选物体',filters,filters.some(([id])=>id===state.objectFilter)?state.objectFilter:'all',changed);
  enhanceSelectMenu(filter,{menuClass:'outline-filter-menu',iconOnly:true,triggerIcon:workspaceIcons.filter});
  const filterControl=filter.closest('.custom-select');filterControl.classList.add('outline-filter');
  const filtering=()=>!!search.value.trim()||filter.value!=='all';
  list.tabIndex=0;list.setAttribute('aria-label','场景物体列表');toolbar.append(searchField,locate,show,filterControl);host.append(toolbar,list,status);
  const renderState=name=>renderObjectVisible(renderFlags,project.document?.paint.renderVisibility,name);
  async function changeRendered(ids,visible,origin=project.origin()){
    if(!origin||renderPending)return;
    const visibility=Object.fromEntries((project.scene?.sceneItems||[]).filter(item=>{
      const current=renderState(item.label);
      return ids.includes(item.id)&&current!==null&&current!==visible;
    }).map(item=>[item.label,visible]));
    if(!Object.keys(visibility).length)return;
    renderPending=true;sync();
    try{await project.commands([{op:'renderVisibility',visibility}],origin);}
    finally{renderPending=false;if(!renderDisposed)sync();}
  }
  function loadRenderFlags(){
    const doc=project.document,sha=doc?.source?.files?.[doc.source.reviewSource];
    if(!doc||!sha||!project.scene||renderSource===sha||Date.now()<renderRetryAt)return;
    renderFlags=null;renderSource=sha;
    const unavailable=()=>{if(renderSource===sha){renderSource=null;renderRetryAt=Date.now()+5000;}};
    void fetch('/api/projects/'+doc.id+'/paint/render-objects').then(async response=>{
      if(!response.ok){unavailable();return;}
      const payload=await response.json();
      if(payload.sourceSha256!==sha){unavailable();return;}
      if(!renderDisposed&&renderSource===sha){renderFlags=payload.visibility;sync();}
    }).catch(unavailable);
  }
  const contextMenu=createSceneContextMenu({host,project,ctx,renderState,changeRendered});
  list.addEventListener('contextmenu',event=>{const row=event.target.closest('[data-scene-object-id]');contextMenu.open(event,row?Number(row.dataset.sceneObjectId):null,treeSelection);});
  const rowFor=id=>rowViews.get(id)?.row;
  const rowIds=()=>[...rowViews.keys()];
  const activeId=()=>treeSelection?treeActive:project.scene?.activeId;
  function passesFilter(id,scene,selection){
    const visibility=scene?.visibility.get(id);
    switch(filter.value){
      case 'visible':return visibility==='visible';
      case 'hidden':return visibility==='hidden'||visibility==='inherited';
      case 'selected':return selection.has(id);
      case 'active':return id===activeId();
      default:return true;
    }
  }
  function focusRow(id,{center=false}={}){const row=rowFor(id);if(!row){list.focus({preventScroll:true});return;}row.querySelector('.editor-layer-name')?.focus({preventScroll:true});row.scrollIntoView({block:center?'center':'nearest',inline:'nearest'});}
  function locateActive(){
    const scene=project.scene,id=activeId();if(!scene||id==null)return;
    const byId=new Map(items.map(item=>[item.id,item])),visited=new Set(),target=byId.get(id);
    if(!target)return;
    for(let item=target;item&&!visited.has(item.id);item=byId.get(item.parentId)){visited.add(item.id);closed.delete(item.parentId);}
    if(!outlineNameMatches(target,search.value))search.value='';
    if(!passesFilter(id,scene,new Set(treeSelection||scene.selectedIds))){filter.value='all';syncSelectMenu(filter);}
    rootClosed=false;changed();focusRow(id,{center:true});
  }
  function selectRows(ids,id){
    const scene=project.scene;if(!scene||scene.dragging)return;
    if(ids.some(item=>scene.visibility.get(item)!=='visible')){treeSelection=ids;treeActive=id;sync();}
    else{treeSelection=null;treeActive=null;scene.selectMany(ids,id);}
    focusRow(id);
  }
  function setFold(id,collapse,recursive=false){
    if(id===null)rootClosed=collapse;
    const branches=recursive?outlineBranches(items,id):id===null?[]:[id];
    for(const branch of branches){if(collapse)closed.add(branch);else closed.delete(branch);}
    changed();
  }
  function foldLevel(expand){
    if(rootClosed){if(expand)setFold(null,false);return;}
    const branches=outlineRows(items,{collapsed:[...closed]}).filter(row=>row.hasChildren);
    if(expand)for(const {item} of branches)closed.delete(item.id);
    else{
      const depth=branches.reduce((deepest,row)=>row.expanded?Math.max(deepest,row.depth):deepest,-1);
      if(depth===-1){setFold(null,true);return;}
      for(const row of branches)if(row.depth===depth&&row.expanded)closed.add(row.item.id);
    }
    changed();
  }
  list.addEventListener('keydown',event=>{
    const scene=project.scene;if(!scene||scene.dragging||event.metaKey||event.ctrlKey||event.isComposing)return;
    const row=event.target.closest('[data-scene-object-id]'),id=row?Number(row.dataset.sceneObjectId):activeId(),keyName=event.key;
    const stop=()=>{event.preventDefault();event.stopPropagation();};
    if(keyName==='F2'&&!event.altKey){stop();const rect=(row||list).getBoundingClientRect();contextMenu.open({preventDefault(){},stopPropagation(){},clientX:rect.x+30,clientY:rect.y+24},id,treeSelection);host.querySelector('.scene-context-menu [role=menuitem]')?.click();return;}
    if(!event.altKey&&(keyName==='Home'||event.shiftKey&&keyName.toLowerCase()==='a'||['NumpadAdd','NumpadSubtract'].includes(event.code))){
      stop();
      if(filtering())return;
      if(keyName==='Home')setFold(null,false,true);
      else if(event.code==='NumpadAdd'||event.code==='NumpadSubtract')foldLevel(event.code==='NumpadAdd');
      else setFold(null,!rootClosed&&![...outlineBranches(items)].some(branch=>closed.has(branch)),true);
      return;
    }
    if(keyName.toLowerCase()==='a'){stop();const ids=event.altKey?[]:rowIds().filter(item=>scene.visibility.get(item)==='visible');selectRows(ids,ids.includes(id)?id:ids[0]??null);return;}
    if(event.altKey)return;
    if(keyName==='.'||event.code==='NumpadDecimal'){stop();locateActive();return;}
    if(['ArrowUp','ArrowDown'].includes(keyName)){
      stop();const ids=rowIds(),index=ids.indexOf(id),next=ids[index<0?(keyName==='ArrowUp'?ids.length-1:0):Math.max(0,Math.min(ids.length-1,index+(keyName==='ArrowUp'?-1:1)))];if(next===undefined)return;
      const selected=treeSelection||scene.selectedIds;selectRows(event.shiftKey?[...new Set([...selected,next])]:[next],next);return;
    }
    if(!['ArrowLeft','ArrowRight'].includes(keyName))return;
    const item=scene.sceneItems.find(item=>item.id===id);if(!item)return;stop();
    const children=scene.sceneItems.filter(entry=>entry.parentId===id),fold=rowFor(id)?.querySelector('.outline-disclosure'),opened=fold?.matches('[aria-expanded=true],[data-expanded]');
    if(keyName==='ArrowLeft'&&opened&&!filtering()){closed.add(id);changed();focusRow(id);}
    else if(keyName==='ArrowRight'&&children.length&&!opened){closed.delete(id);changed();focusRow(id);}
    else{const next=keyName==='ArrowLeft'?item.parentId:children.find(entry=>rowFor(entry.id))?.id;if(next!=null&&rowFor(next))selectRows([next],next);}
  });
  function changed(){sync();ctx.onChange();}
  function clearSearch(){
    search.value='';changed();search.focus({preventScroll:true});
  }
  function rebuildRows(query,filterIds){
    const focus=document.activeElement,rootFocused=!!sceneRoot&&focus===sceneRoot,previousRow=focus?.closest('[data-scene-object-id]'),focused=previousRow?.parentElement===list?Number(previousRow.dataset.sceneObjectId):null;
    const focusSelector=focus?.matches('button.outline-disclosure')?'button.outline-disclosure':focus?.matches('.editor-render-visibility')?'.editor-render-visibility':focus?.matches('.editor-visibility')?'.editor-visibility:not(.editor-render-visibility)':'.editor-layer-name';
    const scroll=restoredScroll?list.scrollTop:state.scroll||0;restoredScroll||=items.length>0;list.replaceChildren();rowViews.clear();sceneRoot=null;
    const filtered=filtering(),rows=outlineRows(items,{query,filterIds,collapsed:[...closed]}),expanded=!rootClosed||filtered;
    if(items.length){
      const root=sceneRoot=filtered?el('div'):button('',event=>setFold(null,expanded,event.shiftKey));root.className='editor-outline-root';root.toggleAttribute('data-expanded',expanded);
      if(!filtered){root.setAttribute('aria-expanded',String(expanded));root.setAttribute('aria-label',expanded?'折叠场景':'展开场景');root.title='Shift + 单击递归展开或折叠';}
      const disclosure=el('span','outline-disclosure');disclosure.innerHTML=arrow;
      const icon=el('span','editor-object-icon');icon.innerHTML=areaIcons.collection;
      root.append(disclosure,icon,el('span','','场景集合'));list.append(root);
    }
    if(expanded)for(const {item,depth,ancestorGuides,hasNext,hasChildren,expanded:open,matched} of rows){
      const row=el('div','editor-layer-row'),name=button('',event=>{
        const scene=project.scene;if(!scene||scene.dragging)return;
        const extend=event?.shiftKey||event?.metaKey||event?.ctrlKey;
        if(scene.visibility.get(item.id)==='visible'&&(!extend||treeSelection===null)){treeSelection=null;scene.select(item.id,extend);}
        else{const next=objectClickSelection(treeSelection||scene.selectedIds,treeSelection?treeActive:scene.activeId,item.id,extend);treeSelection=next.selected;treeActive=next.active;sync();}
        rowFor(item.id)?.querySelector('.editor-layer-name')?.focus({preventScroll:true});
      }),eye=button('',()=>project.scene?.toggle(item.id)),render=button('',()=>{
        const scene=project.scene,value=renderState(item.sourceLabel),selected=treeSelection||scene?.selectedIds||[];
        if(scene&&value!==null)void changeRendered(selected.includes(item.id)?selected:[item.id],!value).catch(ctx.error);
      });
      row.toggleAttribute('data-ancestor-match',!matched);row.dataset.outlineDepth=String(depth);row.dataset.sceneObjectId=String(item.id);
      const indent=el('span','outline-indent');indent.setAttribute('aria-hidden','true');
      const guides=ancestorGuides.slice(-19);
      indent.style.setProperty('--outline-depth',String(guides.length+1));
      for(const continues of guides)indent.append(el('span',continues?'outline-guide continues':'outline-guide'));
      indent.append(el('span',hasNext?'outline-guide branch continues':'outline-guide branch'));row.append(indent);
      if(hasChildren&&!filtered){const fold=button('',event=>setFold(item.id,open,event.shiftKey));fold.className='outline-disclosure';fold.innerHTML=arrow;fold.setAttribute('aria-expanded',String(open));fold.setAttribute('aria-label',(open?'折叠 ':'展开 ')+item.label);fold.title='Shift + 单击递归展开或折叠';row.append(fold);}
      else{const slot=el('span','outline-disclosure-space');if(hasChildren){slot.classList.add('outline-disclosure');slot.dataset.expanded='';slot.innerHTML=arrow;}row.append(slot);}
      name.classList.add('editor-layer-name');name.setAttribute('aria-label',item.label);const icon=el('span','editor-object-icon');icon.innerHTML=workspaceIcons.meshObject;name.append(icon,el('span','editor-object-label',item.label));name.ondblclick=()=>project.scene?.frame(item.id);
      eye.classList.add('editor-visibility');render.classList.add('editor-visibility','editor-render-visibility');
      row.append(name,eye,render);list.append(row);rowViews.set(item.id,{row,name,eye,render,label:item.label,sourceLabel:item.sourceLabel,visibility:null,rendered:undefined,signature:''});
    }
    matches=filtered?rows.filter(row=>row.matched).length:items.length;
    if(!items.length||filtered&&!matches)list.append(el('p','editor-message',project.scene?'没有匹配的物体':'三维视口载入后显示场景物体'));
    list.scrollTop=scroll;ctx.title.textContent=items.length+' 个物体';
    if(rootFocused||focused!==null){
      const nextFocus=focused!==null?rowFor(focused)?.querySelector(focusSelector):null;
      (nextFocus||(sceneRoot?.matches('button')?sceneRoot:list)).focus({preventScroll:true});
    }
  }
  function sync(){
    const scene=project.scene,source=scene?.sceneItems||empty,aliases=project.document?.paint.objectNames,query=search.value.trim();
    loadRenderFlags();
    clear.hidden=!search.value;
    if(sourceItems!==source||names!==aliases){
      sourceItems=source;names=aliases;const next=source.map(item=>({...item,sourceLabel:item.label,label:aliases?.[item.label]||item.label})),serialized=JSON.stringify(next);
      if(serialized!==itemKey){items=next;itemKey=serialized;itemVersion++;}
    }
    // Selection and visibility updates should keep row identity, scroll and keyboard focus.
    const selection=new Set(treeSelection||scene?.selectedIds||empty),active=activeId();
    const filterIds=filter.value==='all'?null:items.filter(item=>passesFilter(item.id,scene,selection)).map(item=>item.id);
    const structure=JSON.stringify([scene?.projectId,scene?.binding,!!scene,itemVersion,query,rootClosed,[...closed],filterIds]),rebuilt=structure!==structureKey;
    filterControl.toggleAttribute('data-filter-active',filterIds!==null);
    if(rebuilt){structureKey=structure;rebuildRows(query,filterIds===null?null:new Set(filterIds));}
    const renderKey=JSON.stringify([renderSource,!!renderFlags,renderPending,project.document?.paint.renderVisibility]);
    if(!rebuilt&&lastScene===scene&&lastTree===treeSelection&&lastActive===treeActive&&lastRenderKey===renderKey)return;
    lastRenderKey=renderKey;
    lastScene=scene;lastTree=treeSelection;lastActive=treeActive;
    show.disabled=!scene||scene.dragging||!scene.hasHidden;locate.disabled=!scene||scene.dragging||activeId()==null;
    for(const [id,view] of rowViews){
      const selected=selection.has(id),current=selected&&id===active,visibility=scene.visibility.get(id),visible=visibility==='visible',dragging=!!scene.dragging;
      const rendered=renderState(view.sourceLabel),signature=String(selected)+current+visibility+dragging+rendered+renderPending;
      if(signature===view.signature)continue;view.signature=signature;
      const {row,name,eye,render,label}=view;row.toggleAttribute('data-active-object',current);row.toggleAttribute('data-selected-object',selected);row.toggleAttribute('data-object-hidden',!visible);
      if(current)name.setAttribute('aria-current','true');else name.removeAttribute('aria-current');name.setAttribute('aria-pressed',String(selected));name.disabled=dragging;name.title=label;
      if(view.visibility!==visibility){view.visibility=visibility;eye.innerHTML=workspaceIcons[visible?'eye':'hidden'];eye.setAttribute('aria-label',(visible?'隐藏 ':'显示 ')+label);eye.title=(visibility==='inherited'?'父级已隐藏 · ':visibility==='outside'?'局部视图外 · ':visible?'隐藏 ':'显示 ')+label;}
      eye.disabled=dragging||visibility==='inherited'||visibility==='outside';
      if(view.rendered!==rendered){
        view.rendered=rendered;row.toggleAttribute('data-render-excluded',rendered===false);
        render.innerHTML=workspaceIcons[rendered===false?'renderCameraOff':'renderCamera'];
        render.setAttribute('aria-label',(rendered===true?'从渲染排除 ':rendered===false?'加入渲染 ':'渲染显隐 ')+label);
        render.setAttribute('aria-pressed',String(rendered===true));
        render.title=render.getAttribute('aria-label');
      }
      render.disabled=dragging||renderPending||rendered===null;
    }
    status.textContent=scene?(filtering()?matches+' / '+items.length:items.length)+' 个物体 · '+selection.size+' 已选':'等待三维视口';
  }
  search.oninput=changed;
  search.onkeydown=event=>{if(event.key==='Escape'&&search.value){event.preventDefault();event.stopPropagation();clearSearch();}};
  const unsub=project.subscribe(event=>{
    const scene=project.scene;
    if(event.kind==='scene'&&(scene?.owner!==lastScene?.owner||scene?.binding!==lastScene?.binding||scene?.selectionKey!==lastScene?.selectionKey)){
      treeSelection=null;treeActive=null;
    }
    sync();
  });
  sync();headerControls(ctx,toolbar);
  return {sync,getState:()=>({query:search.value,objectFilter:filter.value,scroll:list.scrollTop,rootCollapsed:rootClosed,collapsed:[...closed]}),dispose(){renderDisposed=true;unsub();contextMenu.dispose();}};
}
function createConsoleEditor(ctx){
  const {host,project,state}=ctx,toolbar=el('div','editor-toolbar'),input=el('textarea','editor-console-input'),log=el('div','editor-console-log');host.classList.add('editor-console');input.setAttribute('aria-label','工程命令 JSON');input.spellcheck=false;input.value=state.text||JSON.stringify([{op:'base',patch:{color:'#637e89',metallic:.15,roughness:.62}}],null,2);
  let records=state.records||[],pending=false;
  function record(text){records.push(new Date().toLocaleTimeString()+' '+text);records=records.slice(-40);log.textContent=records.join('\n');ctx.onChange();}
  const run=button('执行命令',async()=>{if(pending)return;const origin=project.origin();try{const ops=JSON.parse(input.value);if(!Array.isArray(ops))throw Error('请输入制作命令数组');pending=true;run.disabled=true;const doc=await project.commands(ops,origin);record(`已保存 ${ops.length} 条命令 · r${doc?.revision??project.document.revision}`);}catch(error){record('失败：'+error.message);}finally{pending=false;run.disabled=false;}});
  toolbar.append(button('读取工程',()=>record(JSON.stringify({id:project.document?.id,revision:project.document?.revision,layers:project.document?.paint.layers.length,materials:Object.keys(project.document?.paint.materials||{}),brushes:Object.keys(project.document?.paint.brushes||{})},null,2))),run,button('撤销',()=>project.travel('undo').catch(error=>record(error.message))),button('清空日志',()=>{records=[];log.textContent='';ctx.onChange();}));
  const hint=el('p','editor-message','本机工程命令与 MCP 共用修订和撤销。输入制作命令数组后执行。');host.append(toolbar,hint,input,log);input.oninput=ctx.onChange;log.textContent=records.join('\n');
  function sync(){ctx.title.textContent=project.document?'r'+project.document.revision+' · 本机命令':'未打开工程';}
  const unsub=project.subscribe(sync);sync();headerControls(ctx,toolbar);return {sync,isEditing:()=>pending,getState:()=>({text:input.value,records}),dispose:unsub};
}
