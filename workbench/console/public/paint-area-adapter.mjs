import {leaseHeader,leaseLibraryHeader,chromeButton} from './area-chrome.mjs';
import {compositionKey} from './text-input.mjs';
import {enhanceSelectMenu} from './paint-select.mjs';
import {createPaintColors,maskGray} from './paint-colors.mjs';
import {createProjectState} from './project-state.mjs';
import {createEditorRegistry} from './editor-registry.mjs';
import {createAreaWorkspace} from './area-workspace.mjs';
import {registerAreaEditors} from './area-editors.mjs';
import {createLiveView} from './paint-live-view.mjs';
import {createUVSelection} from './paint-uv-selection.mjs';
import {createMaterialStrokeSave} from './material-stroke-save.mjs';
import {addImageAsset as addImageAssetToDocument,imageSelectionOrigin} from './image-document-editors.mjs';
const $=id=>document.getElementById(id);
export function setupPaintAreas(hooks){
  const workspace=$('workspace'),parking=document.createElement('div');parking.id='editor-parking';parking.setAttribute('aria-hidden','true');
  const panels=Object.fromEntries([...workspace.querySelectorAll('[data-panel]')].map(p=>[p.dataset.panel,p]));
  const rail=workspace.querySelector('.tool-rail'),viewTools=workspace.querySelector('.view-tools'),surfaceTools=$('surface-tools'),status=workspace.querySelector('.view-status');
  const uv=$('uv-view');
  for(const id of ['drawing-layer-settings','drawing-layer-actions','uv-add-image'])$(id).removeAttribute('data-drawing-only');
  for(const id of ['fill','paint-layer'])$('drawing-layer-actions').append($(id));
  $('apply-asset').textContent='应用到材质图层';
  for(const child of [...workspace.children])parking.append(child);workspace.append(parking);
  let applying=false,lastProject=null,preferredViewport=null,preferredCanvas=null;
  let materialVisible=false,materialDetail=false,visibleEditors=[],inspection=null,inspectionFrame=null,inspectionStatus=null;
  let adjustmentPreview=null;
  let materialStrokes;
  const write=async(action)=>{
    let value,failure;const ok=await hooks.run(async()=>{try{value=await action();}catch(error){failure=error;throw error;}});
    if(ok!==true)throw failure||Error('操作未完成，请结束当前编辑后重试');return value;
  };
  const project=createProjectState({
    write:(operations,origin)=>write(()=>hooks.api('/api/projects/'+origin.id+'/paint/commands',{revision:origin.revision,operations,
      ...(origin.strokeRequestId?{strokeRequestId:origin.strokeRequestId}:{})})),
    beforeTravel:async()=>{
      if(materialStrokes.editing)throw Error('请先完成当前材质笔触');
      if(materialStrokes.size&&!await materialStrokes.flush())throw Error('请先保存或放弃待保存的材质笔触');
    },
    travel:async(direction,origin)=>{const until=Date.now()+30000;while(hooks.busy()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));const doc=hooks.read();if(doc?.id!==origin?.id)throw Error('工程已切换，撤销未执行');return write(()=>hooks.api('/api/projects/'+doc.id+'/paint/'+direction,{revision:doc.revision}));},
    draft:op=>{activePreview().update(op);hooks.draft(op);},
    selectLayer:id=>{if(applying)return;applying=true;try{hooks.selectLayer(id);}finally{applying=false;}},
    selectResource:t=>{if(applying)return;applying=true;try{if(t?.library==='materials'||t?.library==='brushes')hooks.selectResource(t);}finally{applying=false;}}
  });
  project.subscribe(event=>{if(['editorDomain','imageSelection'].includes(event.kind))hooks.contextChanged?.();});
  function previewContext(target=null){
    const doc=project.document;if(!doc)return null;
    const prefs=hooks.preferences(),inspectMask=target?.kind==='mask'?target.id:undefined,isolatedLayer=target?.kind==='layer'?target.id:undefined;
    return {id:doc.id,revision:doc.revision,inspectMask,isolatedLayer,modeling:!!doc.modeling?.steps?.length,
      detail:prefs.autoDetail&&(!!target||materialDetail),detailDelay:prefs.detailDelay,key:JSON.stringify([doc.id,doc.revision,inspectMask,isolatedLayer])};
  }
  const offscreen=()=>({viewport:{showLivePaint(){}},canvas:document.createElement('canvas'),guide:document.createElement('canvas'),renderCanvas:false});
  const sharedPreview=createLiveView({...offscreen(),context:previewContext,
    onFrame:frame=>project.publishFrame(frame),onStatus:(text,error,detail)=>{if(detail)workspace.dataset.previewResolution=String(detail.size||0);project.publishPreviewStatus({...detail,error:!!error,message:detail?.message||text});}
  });
  const inspectionPreview=createLiveView({...offscreen(),context:()=>inspection&&previewContext(inspection),
    onFrame(frame){inspectionFrame=frame;project.notifyView('materialInspection');},
    onStatus(text,error,detail){
      if(!inspection||!detail||detail.phase==='hidden')return;
      inspectionStatus={...detail,error:!!error,message:detail.message||text};
      project.notifyView('materialInspection');
    }
  });
  const activePreview=()=>inspection?inspectionPreview:sharedPreview;
  materialStrokes=createMaterialStrokeSave({workspace,project,readLatest:hooks.readStrokeProject,
    onSettled:hooks.strokeSaveSettled,onChange:()=>{hooks.saveStateChanged();project.notifyView('materialStrokeSave');},onError:error=>hooks.error(error.message),
    updatePreview:operation=>project.draft(operation)});
  function syncPreviews(detailChanged=false){
    const next=hooks.materialInspection();
    const changed=next?.kind!==inspection?.kind||next?.id!==inspection?.id||next?.projectId!==inspection?.projectId;
    if(changed){
      inspection=next;inspectionFrame=null;inspectionStatus=null;inspectionPreview.clear();
    }
    sharedPreview.setVisible(materialVisible&&!inspection);
    inspectionPreview.setVisible(materialVisible&&!!inspection);
    if(changed)materialStrokes.syncPreview();
    if(changed)project.notifyView('materialInspection');
    if(detailChanged&&!inspection)sharedPreview.preferencesChanged();
    activePreview().refresh();
  }
  function updateMaterialDemand(){
    materialVisible=visibleEditors.some(editor=>editor.kind==='viewport'||editor.kind==='uv');
    const detail=visibleEditors.some(editor=>editor.kind==='uv'||editor.kind==='viewport'&&editor.wantsLiveDetail?.()!==false);
    const changed=detail!==materialDetail;materialDetail=detail;syncPreviews(changed);
  }
  let savedColors;try{savedColors=JSON.parse(localStorage.getItem('arachne-image-colors-v1'));}catch{}
  const imagePalette=createPaintColors(savedColors);
  function changeImageColors(change){change();try{localStorage.setItem('arachne-image-colors-v1',JSON.stringify(imagePalette.snapshot()));}catch{}project.notifyView('imageColors');}
  const imageColors={foreground:()=>imagePalette.pair('paint').foreground,maskInk:()=>maskGray(imagePalette.pair('mask').foreground),colorPair:target=>imagePalette.pair(target),
    setForeground:value=>changeImageColors(()=>imagePalette.set('paint','foreground',value)),setColor:(target,slot,value)=>changeImageColors(()=>imagePalette.set(target,slot,value)),
    colorKey:(key,target)=>changeImageColors(()=>key==='x'?imagePalette.swap(target):imagePalette.reset(target))};
  const registry=createEditorRegistry({decorate:ctx=>{ctx.root.querySelectorAll('select').forEach(select=>{enhanceSelectMenu(select);if(select.hidden)select.closest('.custom-select').hidden=true;});for(const input of ctx.root.querySelectorAll('input[type=number]')){input.dataset.scrubNumber='';input.dataset.scrubSpeed??=input.max==='1'?'.01':'1';}}});
  const bridge={imageColors,materialStrokes,readStrokeProject:hooks.readStrokeProject,strokeSaveSettled:hooks.strokeSaveSettled,
    saveStateChanged:hooks.saveStateChanged,legacyCameraProject:hooks.legacyCameraProject,renderSettings:hooks.renderSettings,renderResults:hooks.renderResults,openMaterial:layerId=>{if(areas.switchWorkspace('material')){project.selectLayer(layerId);project.setEditorDomain('material');}},renderProperties:hooks.renderProperties,propertyKey:hooks.propertyKey,propertyTarget:hooks.propertyTarget,parking,busy:hooks.busy,foreground:hooks.foreground,setForeground:hooks.setForeground,maskInk:hooks.maskInk,setMaskInk:hooks.setMaskInk,colorKey:hooks.colorKey,colorPair:hooks.colorPair,setColor:hooks.setColor,preferences:hooks.preferences,viewAsset:hooks.viewAsset,
    importPersonal:async(item,libraryRevision)=>{const origin=project.origin();if(!origin)throw Error('请先打开工程');const result=await write(()=>hooks.api('/api/projects/'+origin.id+'/paint/library-import',{revision:origin.revision,libraryRevision,id:item.id}));if(project.document?.id!==origin.id)throw Error('资源已导入原工程，请打开原工程查看');project.publish(result.document);return result;},
    createSelection:createUVSelection,openImageText:hooks.openImageText,
    imageSelection(origin){
      const editors=areas.editors();
      const editor=preferredCanvas?.kind==='image'&&editors.includes(preferredCanvas)?preferredCanvas:editors.find(item=>item.kind==='image');
      return editor?.getSelection?.(origin)||null;
    },
    imageAdjustment(owner,origin,operation){
      if(operation){
        if(project.document?.id!==origin.id||project.document.revision!==origin.revision)return;
        adjustmentPreview={owner,origin};
      }else{
        if(adjustmentPreview?.owner!==owner)return;
        origin=adjustmentPreview.origin;
        adjustmentPreview=null;
      }
      for(const editor of areas.editors())editor.previewAdjustment?.(origin,operation);
      project.draft(operation);
    },
    layerSelection:hooks.layerSelection,selectMaterialLayer:hooks.selectMaterialLayer,openMaterialLayerMenu:hooks.openMaterialLayerMenu,bindMaterialLayerDrag:hooks.bindMaterialLayerDrag,cameraChanged:hooks.cameraChanged,viewportDisplayChanged:updateMaterialDemand,
    selectSurfaceTarget:hooks.selectSurfaceTarget,
    materialPreview:()=>({inspection,frame:inspectionFrame||project.frame,status:inspection?inspectionStatus:project.previewStatus}),
    clearMaterialInspection:hooks.clearMaterialInspection,toggleMaterialIsolation:hooks.toggleMaterialIsolation,
    clearLayerIsolation:hooks.clearLayerIsolation,
    retryPreview:async()=>{const doc=project.document;if(doc.modeling?.steps?.length)await write(()=>hooks.api('/api/projects/'+doc.id+'/paint/model-prepare',{revision:doc.revision}));activePreview().retryDetail();},
    materialLayerOperation:hooks.materialLayerOperation,canAddMaterialLayer:hooks.canAddMaterialLayer,
    validateSurface:async(hit,origin)=>{const r=await fetch('/api/projects/'+origin.id+'/paint/live',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:origin.revision,pickUv:[hit.u,hit.v]})});if(!r.ok)throw Error('工程表面已变化，请重新放置贴花');const [code]=new Uint8Array(await r.arrayBuffer());if(code!==0)throw Error('此落点属于保护区、共享 UV 或不可写区域');},
    saveModel:(modeling,origin)=>write(()=>hooks.api('/api/projects/'+origin.id+'/paint/model',{revision:origin.revision,modeling})),
    importNode:async(file,nodeId,origin)=>{
      const data=await hooks.pngData(file);await write(()=>hooks.api('/api/projects/'+origin.id+'/paint/assets',{revision:origin.revision,nodeId,...(origin.target?{materialId:origin.target.id}:{}),name:file.name,data}));return true;
    },
    importAsset:file=>write(()=>hooks.importAsset(file,file.name)),
    importProjectMaps:hooks.importProjectMaps,
    importDocumentAsset:async(file,origin,layerId,position)=>{
      const data=await hooks.pngData(file);
      const check=()=>{
        if(project.document?.id!==origin.id)throw Error('工程已切换，未导入图片');
        if(project.document.revision!==origin.revision)throw Error('工程修订已变化，请重新导入图片');
      };
      check();return write(()=>{check();return hooks.api('/api/projects/'+origin.id+'/paint/assets',{revision:origin.revision,name:file.name||'粘贴图像',data,imageLayer:{documentId:origin.documentId,layerId,...position}});});
    },
    legacy:{
      image:ctx=>{
        const top=document.createElement('div');top.className='legacy-editor-tools';top.dataset.legacyImage='';parking.append(top);top.append(viewTools,surfaceTools);
        const restore=leaseHeader(ctx,viewTools);ctx.host.dataset.legacyCanvas='';const nodes=[top,rail,uv,status];uv.hidden=false;
        let restoredProject=null;return {nodes,kind:'image',activate:()=>{hooks.activateImage();uv.hidden=false;},sync(){uv.hidden=false;if(uv.isConnected&&hooks.read()?.id&&restoredProject!==hooks.read().id){if(hooks.activateImage()){restoredProject=hooks.read().id;hooks.restoreImageState(ctx.state);}}},
          isEditing:hooks.imageEditing,getState:hooks.getImageState,
          dispose(){restore();hooks.releaseImage();for(const node of [viewTools,surfaceTools])parking.append(node);top.remove();},
          restored:false,
          setVisible(visible){uv.hidden=!visible;}
        };
      },
      properties:()=>({nodes:[panels.properties],kind:'properties'}),
      layers:ctx=>{const controls=panels.layers.querySelector('.layer-heading'),restore=leaseHeader(ctx,controls);chromeButton(controls.querySelector('#add-folder'),'plus');return {nodes:[panels.layers],kind:'layers',dispose:restore};},
      library:ctx=>({nodes:[panels.assets],kind:'library',dispose:leaseLibraryHeader(ctx,panels.assets)})
    }
  };
  registerAreaEditors(registry,bridge);
  const areas=createAreaWorkspace({host:workspace,registry,project,initial:hooks.initial,restoreActive:hooks.restoreActive!==false,desktopWorkspace:hooks.desktopWorkspace,
    onSaveState:hooks.saveStateChanged,
    canChange:()=>!hooks.busy()&&!materialStrokes.size&&!document.querySelector('dialog[open]')&&!hooks.imageEditing(),
    onVisibleEditors:editors=>{visibleEditors=editors;updateMaterialDemand();},
    onActivate:instance=>{if(instance?.domain)project.setEditorDomain(instance.domain);if(instance?.kind==='viewport'){preferredViewport=instance;project.setEditorDomain('material');}if(['viewport','image','uv'].includes(instance?.kind))preferredCanvas=instance;syncWorkspaceButtons();hooks.cameraChanged?.();},onWorkspace:()=>{project.setEditorDomain(areas.name==='drawing'?'image':'material');syncWorkspaceButtons();hooks.workspaceChanged?.(areas.name);hooks.remember();}
  });
  function syncWorkspaceButtons(){for(const b of document.querySelectorAll('[data-area-mode]'))b.setAttribute('aria-pressed',String(b.dataset.areaMode===areas.name));}
  for(const b of document.querySelectorAll('[data-area-mode]'))b.onclick=()=>{if(areas.switchWorkspace(b.dataset.areaMode)){syncWorkspaceButtons();hooks.remember();}};
  $('open-render-settings').onclick=()=>areas.openEditor('renderSettings',{placement:'sidebar'});
  $('open-render-results').onclick=()=>areas.openEditor('renderResult');
  $('reset-docks').onclick=()=>areas.reset();for(const label of $('window-menu').querySelectorAll('label'))label.hidden=true;
  const imageMenuActions=[
    [$('cut-image-selection'),'canCut','cutSelection'],
    [$('copy-merged-image'),'canCopyMerged','copyMerged'],
    [$('paste-image-in-place'),'canPasteInPlace','pasteInPlace']
  ];
  function imageEditor(){
    const editors=areas.editors();
    return preferredCanvas?.kind==='image'&&editors.includes(preferredCanvas)?preferredCanvas:editors.find(item=>item.kind==='image');
  }
  for(const [control,,action] of imageMenuActions)control.onclick=()=>{
    if(project.editorDomain==='image')imageEditor()?.[action]?.();
  };
  imageMenuActions[0][0].closest('details').addEventListener('toggle',event=>{
    if(!event.currentTarget.open)return;
    const editor=project.editorDomain==='image'?imageEditor():null;
    for(const [control,enabled,action] of imageMenuActions){
      control.hidden=!editor?.[action];
      control.disabled=!editor?.[enabled]?.();
    }
  });
  workspace.addEventListener('keydown',event=>{
    if(event.defaultPrevented||compositionKey(event)||event.target.closest('input,textarea,select,[contenteditable]')||areas.active?.legacy&&areas.active.kind==='image')return;
    if(project.editorDomain==='image'&&imageEditor()?.handleKey?.(event))return;
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.stopPropagation();void project.travel(event.shiftKey?'redo':'undo').catch(error=>hooks.error(error.message));}
  });
  syncWorkspaceButtons();hooks.workspaceChanged?.(areas.name,false);
  function materialViewport(){const editors=areas.editors();return preferredViewport&&editors.includes(preferredViewport)?preferredViewport:editors.find(e=>e.kind==='viewport');}
  function targetViewport(){const target=materialViewport();return target?.isReady()?target:areas.editors().find(e=>e.kind==='viewport'&&e.isReady());}
  return {project,areas,
    editorCommand(action,focused){
      const editor=areas.editorFor(focused)??areas.active;
      const handled=editor?.editCommand?.(action);
      if(handled!==undefined)return handled;
      if(editor?.kind==='imageLayers'&&action==='selectAll')return false;
      if(!['image','imageLayers','imageProperties'].includes(editor?.kind))return undefined;
      return imageEditor()?.editCommand?.(action);
    },
    imageCommand(action){
      if(project.editorDomain!=='image')return false;
      return imageEditor()?.[action]?.()??false;
    },
    travelHistory(direction){
      const editor=project.editorDomain==='image'&&imageEditor();
      if(editor?.travelHistory)return editor.travelHistory(direction);
      void project.travel(direction).catch(error=>hooks.error(error.message));
      return true;
    },
    materialSelectionChanged(){project.selectedLayer(hooks.layerId(),undefined,{force:true});},
    brushSettings(){const editors=areas.editors(),target=preferredCanvas&&editors.includes(preferredCanvas)?preferredCanvas:editors.find(editor=>['viewport','image','uv'].includes(editor.kind));return target?.getBrushSettings?.()||null;},
    maskTarget({openViewport=true,mode='mask'}={}){if(openViewport&&!materialViewport())areas.openEditor('viewport');materialViewport()?.setPaintMode(mode);project.setEditorDomain('material');},
    reproject(layerId){const target=targetViewport();if(!target)throw Error('请先打开三维视口');target.reproject(layerId);},
    openImage(documentId){if(documentId&&!areas.switchWorkspace('drawing'))return;areas.openEditor('image');if(documentId)project.selectImage({documentId,layerId:null,target:'pixels'});project.setEditorDomain('image');},
    openMaterialPainting(){areas.openEditor('viewport');materialViewport()?.setPaintMode('paint');project.setEditorDomain('material');},
    async addImageAsset(asset){const origin=imageSelectionOrigin(project),item=project.document?.paint.assets?.[asset];if(!project.document?.paint.imageDocuments?.[origin.documentId])throw Error('请先新建或打开图像文档');if(!item)throw Error('图片素材不存在');await addImageAssetToDocument(project,origin,asset,item.name);},
    sync(){const doc=hooks.read();if(!doc)return;const opening=lastProject!==doc.id;if(opening){lastProject=doc.id;sharedPreview.clear();}project.publish(doc);if(opening&&(areas.active?.kind==='image'||areas.name==='drawing'))project.setEditorDomain('image');project.selectedLayer(hooks.layerId());const t=hooks.resource();project.selectedResource(t?{library:t.library,id:t.id}:null);syncPreviews();areas.sync();},
    materialDraftContext:()=>materialVisible?previewContext(inspection):null,
    acceptExternalDraft:operation=>project.acceptExternalDraft(operation),draftPreview:operation=>activePreview().update(operation),
    busyChanged(){
      for(const editor of areas.editors()){
        if(['shader','layers','imageLayers','imageProperties'].includes(editor.kind))editor.sync?.();
      }
    },
    resourceChanged(options){if(applying)return;const t=hooks.resource();project.selectedResource(t?{library:t.library,id:t.id}:null,undefined,options);},
    preferencesChanged(){activePreview().preferencesChanged();for(const editor of areas.editors())editor.preferencesChanged?.();},
    imageActivate(){hooks.activateImage();syncWorkspaceButtons();},
    isEditing:()=>hooks.imageEditing()||areas.editors().some(editor=>editor.isEditing?.()),
    strokeSaveStatus:()=>[materialStrokes.status(),...areas.editors().flatMap(editor=>editor.strokeSaveStatus?[editor.strokeSaveStatus()]:[])],
    async retryStrokeSaves(){if(materialStrokes.status().failure)await materialStrokes.retrySave();for(const editor of areas.editors())if(editor.strokeSaveStatus?.().failure)await editor.retryStrokeSave();},
    deliveryViewport:()=>targetViewport()?.viewport,
    showRenderCamera:camera=>targetViewport()?.showRenderCamera(camera)??false,
    drawRenderRegion:camera=>targetViewport()?.drawRenderRegion(camera)??false,
    pickRenderFocus:camera=>targetViewport()?.pickRenderFocus(camera)??false,
    get workspace(){return areas.name;},
    legacyKeyboard:event=>!!event.target.closest('#uv-view,#uv-transform-options,#surface-tools,.tool-rail')&&!!areas.active?.legacy,
    dispose(){areas.dispose();materialStrokes.dispose();registry.dispose();sharedPreview.dispose();inspectionPreview.dispose();}
  };
}
