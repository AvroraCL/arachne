import {sameDeliveryCamera,renderBookmarkLimit} from './paint-delivery-options.mjs';
import {syncSelectMenu} from './paint-select.mjs';
import {createPropertyEditorFrame} from './property-editor.mjs';
import {areaIcons,chromeButton} from './area-chrome.mjs';
import {workspaceIcons} from './workspace-icons.mjs';
import {capturePropertyTarget,propertyTargetStatus} from './property-targets.mjs';
import {createObjectPropertyEditor} from './object-property-editor.mjs';
import {createMaterialResourceProperties} from './material-resource-properties.mjs';
import {cyclesLimits,cyclesFormats,cyclesViewportLimits} from './cycles-limits.mjs';
import {viewportSamplingDefaults} from './cycles-viewport-sampling.mjs';
import {renderOpticsDefaults,renderOpticsFields} from './render-optics.mjs';
import {renderRegionPixels} from './render-region.mjs';
import {renderAppearanceDefaults,renderAppearanceLimits,renderTransforms,renderLooks} from './render-appearance.mjs';
import {presetRenderLights,renderLightingDefaults,renderLightingLimits,renderLightingPresets,renderLightLimit,renderLightRanges} from './render-lighting.mjs';

const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};

// Every instance owns its category and pins; edits still use shared project commands.
export function createRenderSettingsEditor(ctx,settings,adapters){
  const {host,project,state,onChange}=ctx;
  const frame=createPropertyEditorFrame({host,searchHost:ctx.tools,state,areaId:ctx.areaId,onChange,categories:[
    {key:'render',label:'渲染属性',icon:areaIcons.renderSettings},
    {key:'output',label:'输出属性',icon:workspaceIcons.image},
    {key:'object',label:'物体属性',icon:workspaceIcons.object},
    {key:'material',label:'材质属性',icon:workspaceIcons.material},
    {key:'drawing',label:'绘制属性',icon:workspaceIcons.brush}
  ]});
  const categories=['render','output','object','material','drawing'],pins=Object.create(null);
  if(state.pins&&typeof state.pins==='object'&&!Array.isArray(state.pins))for(const key of categories){
    const target=state.pins[key];if(target&&typeof target==='object'&&!Array.isArray(target))pins[key]=structuredClone(target);
  }
  let materialResource=null;
  const capture=category=>capturePropertyTarget(category,project,()=>materialResource?{kind:'resource',resourceId:materialResource}:adapters.propertyTarget());
  const target=category=>pins[category]||capture(category);
  const status=category=>propertyTargetStatus(category,project,target(category));
  const panels={},openSections={};
  function section(category,key,title,defaultOpen=true){
    const group=el('details','render-settings-section');group.dataset.category=category;group.dataset.searchTitle=title;
    openSections[key]=state.sections?.[key]??defaultOpen;group.open=openSections[key];
    const summary=el('summary','',title),body=el('div','render-settings-body');group.append(summary,body);frame.panel(category).append(group);
    panels[key]=group;group.addEventListener('toggle',()=>{
      if(frame.search.value.trim()||group.open===openSections[key])return;
      openSections[key]=group.open;onChange();
    });return body;
  }
  function row(parent,label,control){const item=el('label','render-settings-row'),name=el('span','',label);item.dataset.search=label;item.append(name,control);parent.append(item);return control;}
  function readout(parent,label,value){const item=el('div','render-settings-row');item.dataset.search=label+' '+value;item.append(el('span','',label),el('span','render-settings-readout',value));parent.append(item);}
  function number(parent,key,label,min,max,speed,step=1,write=settings.set){
    const input=el('input');Object.assign(input,{type:'number',min:String(min),max:String(max),step:String(step)});
    input.dataset.scrubNumber='';input.dataset.scrubSpeed=String(speed);input.setAttribute('aria-label',label);
    input.addEventListener('change',()=>{
      const value=input.valueAsNumber;
      try{if(!Number.isFinite(value)||value<min||value>max||(step===1&&!Number.isInteger(value)))throw Error(label+'范围为 '+min+'–'+max);void Promise.resolve(write({[key]:value})).catch(error=>{ctx.error(error);sync();});}
      catch(error){ctx.error(error);sync();}
    });
    return row(parent,label,input);
  }
  function check(parent,key,label,write=settings.set){
    const input=el('input');input.type='checkbox';input.setAttribute('aria-label',label);
    input.addEventListener('change',()=>{try{write({[key]:input.checked});}catch(error){ctx.error(error);sync();}});
    row(parent,label,input).closest('label').classList.add('render-settings-check');return input;
  }
  const engine=section('render','engine','渲染引擎');readout(engine,'视口','GPU 路径追踪');readout(engine,'出图','路径追踪 · PNG / EXR');
  const device=el('select');device.setAttribute('aria-label','渲染设备');
  device.append(new Option('自动','auto'),new Option('CPU · 软件渲染','cpu'));
  device.title='使用内置路径追踪器的默认图形后端，或明确使用 CPU 软件渲染';
  device.addEventListener('change',()=>{try{settings.set({device:device.value});}catch(error){ctx.error(error);sync();}});
  row(engine,'出图设备',device);
  const sampling=section('render','sampling','渲染采样');
  const samples=number(sampling,'samples','采样数',1,cyclesLimits.maxSamples,1);
  const viewportSampling=section('render','viewportSampling','视口采样',false);
  const draftSamples=number(viewportSampling,'draftSamples','快速预览采样',1,cyclesViewportLimits.draft.samples,1,1,settings.setViewportSampling);
  const detailSamples=number(viewportSampling,'detailSamples','细化预览采样',1,cyclesViewportLimits.detail.samples,1,1,settings.setViewportSampling);
  detailSamples.title='开启自动细化后，视口停止移动时累积到此采样数';
  const resetSampling=el('button','','恢复默认');resetSampling.type='button';resetSampling.title='恢复视口采样默认值';
  resetSampling.onclick=()=>settings.setViewportSampling(viewportSamplingDefaults);
  const viewportActions=el('div','render-settings-camera-actions');viewportActions.dataset.search='恢复默认 视口采样';viewportActions.append(resetSampling);
  viewportSampling.append(viewportActions);
  function syncViewportSampling(){
    const value=settings.readViewportSampling();
    for(const [key,input] of Object.entries({draftSamples,detailSamples}))
      if(!input.closest('.workspace-range-field')?.matches('[data-dragging],[data-editing]'))input.value=String(value[key]);
    resetSampling.disabled=value.draftSamples===viewportSamplingDefaults.draftSamples&&value.detailSamples===viewportSamplingDefaults.detailSamples;
  }
  const paths=section('render','paths','光线路径',false),maxBounces=number(paths,'maxBounces','最大反弹',0,64,1);
  const film=section('render','film','胶片',false),transparent=check(film,'transparent','透明背景');
  const appearancePanel=section('render','appearance','色彩管理',false);
  const override=el('input');override.type='checkbox';override.setAttribute('aria-label','覆盖源场景色彩');
  row(appearancePanel,'覆盖源场景色彩',override).closest('label').classList.add('render-settings-check');
  const appearanceFields=el('div','render-appearance-fields');appearancePanel.append(appearanceFields);
  const transform=el('select'),look=el('select');transform.setAttribute('aria-label','色彩变换');look.setAttribute('aria-label','对比度');
  transform.append(...Object.entries(renderTransforms).map(([value,label])=>new Option(label,value)));
  row(appearanceFields,'色彩变换',transform);row(appearanceFields,'对比度',look);
  const lookLabels={'None':'无','AgX - Medium Low Contrast':'中低','AgX - Medium High Contrast':'中高'};
  let colorPending=false,pendingAppearance=null,lookKey='';
  async function editAppearance(patch){
    if(colorPending)return;
    pendingAppearance=patch===null?null:{...(settings.projectAppearance?.()||renderAppearanceDefaults),...patch};
    if(pendingAppearance&&!renderLooks(pendingAppearance.viewTransform).includes(pendingAppearance.look))pendingAppearance.look='None';
    colorPending=true;syncAppearance();
    try{await settings.setAppearance(patch);}catch(error){ctx.error(error);}
    finally{colorPending=false;pendingAppearance=null;syncAppearance();}
  }
  const exposure=number(appearanceFields,'exposure','曝光',...renderAppearanceLimits.exposure,.02,.01,editAppearance);
  const gamma=number(appearanceFields,'gamma','Gamma',...renderAppearanceLimits.gamma,.01,.01,editAppearance);
  override.onchange=()=>void editAppearance(override.checked?renderAppearanceDefaults:null);
  transform.onchange=()=>void editAppearance({viewTransform:transform.value});
  look.onchange=()=>void editAppearance({look:look.value});
  function syncAppearance(){
    const chosen=colorPending?pendingAppearance:settings.projectAppearance?.(),value=chosen||renderAppearanceDefaults;
    override.checked=!!chosen;override.disabled=colorPending||!project.document;
    appearanceFields.hidden=!chosen;
    if(lookKey!==value.viewTransform){lookKey=value.viewTransform;look.replaceChildren(...renderLooks(lookKey).map(option=>new Option(lookLabels[option],option)));}
    transform.value=value.viewTransform;look.value=value.look;
    transform.disabled=colorPending;look.disabled=colorPending||look.options.length<2;
    syncSelectMenu(transform);syncSelectMenu(look);
    for(const [key,input] of Object.entries({exposure,gamma})){
      input.disabled=colorPending;
      const field=input.closest('.workspace-range-field');
      if(!field?.hasAttribute('data-dragging')&&!field?.hasAttribute('data-editing'))input.value=String(value[key]);
    }
  }
  const lightingPanel=section('render','lighting','场景布光',false);
  const lightingOverride=el('input');lightingOverride.type='checkbox';lightingOverride.setAttribute('aria-label','调整场景布光');
  row(lightingPanel,'调整场景布光',lightingOverride).closest('label').classList.add('render-settings-check');
  const lightingFields=el('div','render-lighting-fields');lightingPanel.append(lightingFields);
  const preset=el('select');preset.setAttribute('aria-label','布光预设');
  preset.append(...Object.entries(renderLightingPresets).map(([value,label])=>new Option(label,value)));row(lightingFields,'预设',preset);
  let lightingPending=false,pendingLighting=null;
  async function editLighting(patch){
    if(lightingPending)return;
    pendingLighting=patch===null?null:{...(settings.projectLighting?.()||renderLightingDefaults),...patch};
    lightingPending=true;syncLighting();
    try{await settings.setLighting(patch);}catch(error){ctx.error(error);}
    finally{lightingPending=false;pendingLighting=null;syncLighting();}
  }
  const lightStrength=number(lightingFields,'lightStrength','灯光倍率',...renderLightingLimits.lightStrength,.02,.01,editLighting);
  const environmentStrength=number(lightingFields,'environmentStrength','环境倍率',...renderLightingLimits.environmentStrength,.02,.01,editLighting);
  const studioFields=el('div');lightingFields.append(studioFields);
  const rotation=number(studioFields,'rotation','灯光旋转',...renderLightingLimits.rotation,1,1,editLighting);
  const environmentColor=el('input');environmentColor.type='color';environmentColor.setAttribute('aria-label','环境颜色');
  row(studioFields,'环境颜色',environmentColor);
  environmentColor.onchange=()=>void editLighting({environmentColor:environmentColor.value});
  preset.onchange=()=>{
    const current=settings.projectLighting?.()||renderLightingDefaults;
    void editLighting({preset:preset.value,...(preset.value==='custom'&&!current.lights?{lights:presetRenderLights(current.preset)}:{})});
  };
  lightingOverride.onchange=()=>void editLighting(lightingOverride.checked?renderLightingDefaults:null);
  const areaLights=el('div','render-area-lights');lightingFields.append(areaLights);
  const lightToolbar=el('div','render-area-light-toolbar');
  const lightSelect=el('select');lightSelect.setAttribute('aria-label','区域灯');
  const lightAdd=chromeButton(el('button'),'plus','添加区域灯');
  const lightRemove=chromeButton(el('button'),'trash','移除区域灯');
  lightAdd.type=lightRemove.type='button';
  lightToolbar.append(lightSelect,lightAdd,lightRemove);areaLights.append(lightToolbar);
  const lightFields=el('div','render-light-edit');areaLights.append(lightFields);
  let activeLight=typeof state.light==='string'?state.light:null,lightListKey='';
  function lightPatch(patch){
    const current=settings.projectLighting?.();
    if(current?.preset!=='custom'||!current.lights.some(light=>light.id===activeLight))return;
    return editLighting({lights:current.lights.map(light=>light.id===activeLight?{...light,...patch}:light)});
  }
  const lightName=el('input');lightName.type='text';lightName.maxLength=60;lightName.setAttribute('aria-label','灯光名称');
  lightName.onchange=()=>void lightPatch({name:lightName.value});
  row(lightFields,'名称',lightName);
  const lightEnabled=check(lightFields,'enabled','启用灯光',lightPatch);
  const lightColor=el('input');lightColor.type='color';lightColor.setAttribute('aria-label','灯光颜色');
  lightColor.onchange=()=>void lightPatch({color:lightColor.value});row(lightFields,'颜色',lightColor);
  const lightNumbers={
    intensity:number(lightFields,'intensity','强度',...renderLightRanges.intensity,.03,.01,lightPatch),
    width:number(lightFields,'width','灯宽',...renderLightRanges.size,.03,.01,lightPatch),
    height:number(lightFields,'height','灯高',...renderLightRanges.size,.03,.01,lightPatch)
  };
  const lightPosition=['X','Y','Z'].map((axis,i)=>number(lightFields,axis,'相对位置 '+axis,...renderLightRanges.position,.03,.01,patch=>{
    const light=settings.projectLighting?.()?.lights?.find(item=>item.id===activeLight);
    if(light)void lightPatch({position:light.position.map((value,j)=>i===j?patch[axis]:value)});
  }));
  lightSelect.onchange=()=>{activeLight=lightSelect.value;syncLighting();onChange();};
  lightAdd.onclick=()=>{
    const lights=settings.projectLighting?.()?.lights||[];
    if(lights.length>=renderLightLimit)return;
    const angle=lights.length*2.4,id=crypto.randomUUID();
    activeLight=id;
    void editLighting({lights:[...lights,{id,name:'区域灯 '+(lights.length+1),enabled:true,
      color:'#ffffff',position:[1.5*Math.cos(angle),1.5*Math.sin(angle),1.6],intensity:1,width:1,height:1}]});
    onChange();
  };
  lightRemove.onclick=()=>{
    const lights=settings.projectLighting?.()?.lights||[];
    if(activeLight)void editLighting({lights:lights.filter(light=>light.id!==activeLight)});
  };
  function syncAreaLights(value){
    areaLights.hidden=value.preset!=='custom';
    if(areaLights.hidden)return;
    const list=value.lights||[];
    const key=JSON.stringify(list.map(({id,name,enabled})=>[id,name,enabled]));
    if(key!==lightListKey){
      lightListKey=key;
      lightSelect.replaceChildren(...(list.length?list.map(light=>new Option(light.name+(light.enabled?'':' · 已停用'),light.id)):[new Option('无区域灯','')]));
    }
    const light=list.find(item=>item.id===activeLight)||list[0];
    activeLight=light?.id??null;
    lightSelect.value=activeLight||'';
    lightSelect.disabled=lightRemove.disabled=lightingPending||!light;
    lightAdd.disabled=lightingPending||list.length>=renderLightLimit;
    syncSelectMenu(lightSelect);
    lightFields.hidden=!light;
    if(!light)return;
    lightName.disabled=lightEnabled.disabled=lightColor.disabled=lightingPending;
    if(document.activeElement!==lightName||lightingPending)lightName.value=light.name;
    lightEnabled.checked=light.enabled;lightColor.value=light.color;
    function syncNumber(input,value){
      input.disabled=lightingPending;
      if(!input.closest('.workspace-range-field')?.matches('[data-dragging],[data-editing]'))input.value=String(value);
    }
    for(const [key,input] of Object.entries(lightNumbers))syncNumber(input,light[key]);
    lightPosition.forEach((input,i)=>syncNumber(input,light.position[i]));
  }
  function syncLighting(){
    const lighting=lightingPending?pendingLighting:settings.projectLighting?.(),value=lighting||renderLightingDefaults;
    lightingOverride.checked=!!lighting;lightingOverride.disabled=lightingPending||!project.document;
    lightingFields.hidden=!lighting;studioFields.hidden=value.preset==='source';
    preset.disabled=environmentColor.disabled=lightingPending;
    preset.value=value.preset;syncSelectMenu(preset);environmentColor.value=value.environmentColor;
    for(const [key,input] of Object.entries({lightStrength,environmentStrength,rotation})){
      input.disabled=lightingPending;
      const field=input.closest('.workspace-range-field');
      if(!field?.hasAttribute('data-dragging')&&!field?.hasAttribute('data-editing'))input.value=String(value[key]);
    }
    syncAreaLights(value);
  }
  const output=section('output','output','输出');
  const {minDimension,maxDimension}=cyclesLimits;
  const width=number(output,'width','分辨率 X',minDimension,maxDimension,4),height=number(output,'height','分辨率 Y',minDimension,maxDimension,4);
  const format=el('select');format.setAttribute('aria-label','渲染文件格式');
  format.append(...Object.entries(cyclesFormats).map(([value,spec])=>new Option(spec.label,value)));
  format.onchange=()=>{try{settings.set({fileFormat:format.value});}catch(error){ctx.error(error);sync();}};
  row(output,'文件格式',format);
  const bitDepth=el('select');bitDepth.setAttribute('aria-label','PNG 位深');
  let depthFormat='';
  function syncFormat(value){
    const selected=value.fileFormat;
    format.value=selected;
    if(depthFormat!==selected){
      depthFormat=selected;
      const exr=selected==='OPEN_EXR';
      bitDepth.setAttribute('aria-label',cyclesFormats[selected].label+' 位深');
      bitDepth.replaceChildren(...(exr?[new Option('16 位浮点','16'),new Option('32 位浮点','32')]:
        [new Option('8 位','8')]));
    }
    bitDepth.value=String(selected==='OPEN_EXR'?value.bitDepth??16:8);
    bitDepth.disabled=selected==='PNG';syncSelectMenu(format);syncSelectMenu(bitDepth);
  }
  bitDepth.onchange=()=>{try{settings.set({bitDepth:bitDepth.value?Number(bitDepth.value):null});}catch(error){ctx.error(error);sync();}};
  row(output,'位深',bitDepth);
  const presets=section('output','projectPreset','工程渲染预设',false);
  const presetStatus=el('p','render-camera-state'),presetActions=el('div','render-settings-camera-actions');
  presetActions.dataset.search='保存为工程预设 恢复工程预设 移除工程预设';
  presets.append(presetStatus,presetActions);
  function presetButton(label,action){
    const button=el('button','',label);button.type='button';
    button.onclick=async()=>{try{await action();}catch(error){ctx.error(error);}finally{sync();}};
    presetActions.append(button);return button;
  }
  const savePreset=presetButton('保存为工程预设',()=>settings.saveProjectPreset());
  const restorePreset=presetButton('恢复工程预设',()=>settings.restoreProjectPreset());
  const clearPreset=presetButton('移除工程预设',()=>settings.clearProjectPreset());
  function syncPreset(){
    const value=settings.projectPreset?.()||{};
    presets.hidden=!settings.projectPreset;
    savePreset.disabled=!value.savable;
    restorePreset.hidden=clearPreset.hidden=!value.saved;
    restorePreset.disabled=!value.changed;
    const message=value.saved?(value.changed?'当前设置与工程预设不同':'正在使用工程预设'):'当前使用本机设置';
    presetStatus.textContent=project.document&&settings.read().framing==='viewport'?message+'。保存当前视角为工程相机后可写入预设。':message;
  }
  const camera=section('output','camera','构图'),framing=el('select');framing.setAttribute('aria-label','渲染构图');
  framing.append(new Option('完整模型','auto'),new Option('当前三维视角','viewport'));
  framing.addEventListener('change',()=>{try{settings.set({framing:framing.value});}catch(error){ctx.error(error);sync();}});row(camera,'相机',framing);
  const cameraState=el('p','render-camera-state');
  const cameraActions=el('div','render-settings-camera-actions');
  const cameraButton=(label,action)=>{
    const button=el('button','',label);button.type='button';
    button.onclick=async()=>{try{await action();}catch(error){ctx.error(error);}};cameraActions.append(button);return button;
  };
  const saveCamera=cameraButton('保存当前视角',()=>settings.saveProjectCamera());
  const viewCamera=cameraButton('查看相机',()=>settings.viewProjectCamera());
  const clearCamera=cameraButton('清除相机',()=>settings.clearProjectCamera());
  const lens=el('div','render-camera-lens'),cameraProjection=el('select');let lensPending=false;
  cameraProjection.setAttribute('aria-label','相机投影');
  cameraProjection.append(new Option('透视','perspective'),new Option('正交','orthographic'));
  row(lens,'投影',cameraProjection);
  async function setLens(patch){
    if(lensPending)return;
    lensPending=true;syncCamera();
    try{await settings.setCameraLens(patch);}catch(error){ctx.error(error);}
    finally{lensPending=false;syncCamera();}
  }
  cameraProjection.onchange=()=>void setLens({projection:cameraProjection.value});
  const cameraFov=number(lens,'fov','垂直视角',5,120,.25,.1,setLens);
  const cameraHeight=number(lens,'orthoHeight','正交高度',.00001,1e6,.2,.00001,setLens);
  if(settings.projectCamera){
    framing.append(new Option('工程渲染相机','saved'));
    cameraActions.dataset.search='保存当前视角 查看相机 清除相机';
    camera.append(cameraState,lens,cameraActions);
  }
  function syncCamera(){
    const available=settings.canUseViewport(),saved=settings.projectCamera?.();
    framing.value=settings.read().framing;framing.options[1].disabled=!available;
    if(settings.projectCamera){
      framing.options[2].disabled=!saved;
      cameraState.textContent=saved?'工程渲染相机 · '+(saved.projection==='orthographic'?'正交':'透视'):'未保存渲染相机';
      saveCamera.disabled=!available;
      saveCamera.textContent=saved?'用当前视角替换':'保存当前视角';
      viewCamera.hidden=clearCamera.hidden=!saved;
      viewCamera.disabled=!available;
      lens.hidden=!saved;
      if(saved){
        cameraProjection.value=saved.projection;
        cameraProjection.disabled=cameraFov.disabled=cameraHeight.disabled=lensPending;
        for(const [key,input] of [['fov',cameraFov],['orthoHeight',cameraHeight]]){
          if(!input.closest('.workspace-range-field')?.matches('[data-dragging],[data-editing]'))input.value=String(Number(saved[key].toFixed(5)));
          input.closest('label').toggleAttribute('data-optics-inactive',saved.projection!==(key==='fov'?'perspective':'orthographic'));
        }
      }
      syncSelectMenu(cameraProjection);
    }
    syncSelectMenu(framing);
  }
  const bookmarks=section('output','bookmarks','相机书签',false);
  const bookmarkRow=el('div','render-bookmark-chooser render-settings-camera-actions'),bookmarkPicker=el('select');
  bookmarkRow.dataset.search='选择相机书签 添加镜头 保存视口';
  bookmarkPicker.setAttribute('aria-label','相机书签');
  const addBookmark=el('button','render-bookmark-add');addBookmark.type='button';
  addBookmark.innerHTML=workspaceIcons.plus;
  addBookmark.setAttribute('aria-label','保存视口为新镜头');addBookmark.title='保存视口为新镜头';
  bookmarkRow.append(bookmarkPicker,addBookmark);bookmarks.append(bookmarkRow);
  const bookmarkDetails=el('div','render-bookmark-details');bookmarks.append(bookmarkDetails);
  const bookmarkName=el('input');bookmarkName.type='text';bookmarkName.maxLength=80;bookmarkName.setAttribute('aria-label','镜头名称');
  row(bookmarkDetails,'镜头名称',bookmarkName);
  const bookmarkActions=el('div','render-settings-camera-actions');
  bookmarkActions.dataset.search='用作出图相机 更新镜头 删除镜头';
  bookmarkDetails.append(bookmarkActions);
  function bookmarkButton(label,action){
    const control=el('button','',label);control.type='button';control.onclick=()=>void editBookmark(action);
    bookmarkActions.append(control);return control;
  }
  const activateBookmark=bookmarkButton('用作出图相机',async origin=>{
    const {camera}=selectedBookmark();
    if(!sameDeliveryCamera(camera,settings.projectCamera?.()))await project.commands([{op:'renderCamera',camera}],origin);
    if(project.document?.id===origin.id)settings.set({framing:'saved'});
  });
  const replaceBookmark=bookmarkButton('用视口更新',origin=>{
    const camera=settings.viewportCamera?.();
    if(!camera)throw Error('请先打开三维视口');
    return project.commands([{op:'renderBookmark',action:'update',id:bookmarkId,patch:{camera}}],origin);
  });
  const deleteBookmark=bookmarkButton('删除',origin=>project.commands([{op:'renderBookmark',action:'remove',id:bookmarkId}],origin));
  deleteBookmark.setAttribute('aria-label','删除镜头');
  let bookmarkId=state.cameraBookmark||'',bookmarkListKey='',nameKey='',bookmarkPending=false;
  const listBookmarks=()=>project.document?.paint.renderBookmarks??[];
  const selectedBookmark=()=>listBookmarks().find(entry=>entry.id===bookmarkId);
  async function editBookmark(action){
    const origin=project.origin();
    if(bookmarkPending||!origin||!status('output').available)return;
    bookmarkPending=true;syncBookmarks();
    try{await action(origin);}catch(error){ctx.error(error);}
    finally{bookmarkPending=false;refresh();}
  }
  addBookmark.onclick=()=>void editBookmark(async origin=>{
    const camera=settings.viewportCamera?.();
    if(!camera)throw Error('请先打开三维视口');
    const taken=new Set(listBookmarks().map(entry=>entry.name));
    let number=1;while(taken.has('镜头 '+number))number++;
    const id=crypto.randomUUID();
    await project.commands([{op:'renderBookmark',action:'add',id,patch:{name:'镜头 '+number,camera}}],origin);
    if(project.document?.id===origin.id){bookmarkId=id;syncBookmarks();onChange();}
  });
  bookmarkPicker.onchange=()=>{bookmarkId=bookmarkPicker.value;syncBookmarks();onChange();};
  bookmarkName.onchange=()=>{
    const name=bookmarkName.value.trim(),entry=selectedBookmark();
    if(!entry||entry.name===name){bookmarkName.value=entry?.name||'';return;}
    void editBookmark(async origin=>{
      await project.commands([{op:'renderBookmark',action:'update',id:entry.id,patch:{name}}],origin);
    }).finally(()=>{bookmarkName.value=selectedBookmark()?.name||'';});
  };
  bookmarkName.onkeydown=event=>{
    if(event.key==='Enter'){event.preventDefault();bookmarkName.blur();}
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();bookmarkName.value=selectedBookmark()?.name||'';bookmarkName.blur();}
  };
  function syncBookmarks(){
    const entries=listBookmarks(),key=JSON.stringify(entries.map(({id,name})=>[id,name]));
    if(key!==bookmarkListKey){
      bookmarkListKey=key;
      bookmarkPicker.replaceChildren(...(entries.length?entries.map(({id,name})=>new Option(name,id)):[new Option('尚无相机书签','')]));
    }
    if(!selectedBookmark())bookmarkId=entries[0]?.id||'';
    const entry=selectedBookmark(),nextNameKey=JSON.stringify([project.document?.id,entry?.id,entry?.name]);
    bookmarkPicker.value=bookmarkId;
    bookmarkPicker.disabled=bookmarkPending||!entries.length;
    if(nameKey!==nextNameKey){nameKey=nextNameKey;bookmarkName.value=entry?.name||'';}
    bookmarkDetails.hidden=!entry;
    bookmarkName.disabled=deleteBookmark.disabled=bookmarkPending;
    addBookmark.disabled=bookmarkPending||entries.length>=renderBookmarkLimit||!settings.canUseViewport();
    replaceBookmark.disabled=bookmarkPending||!settings.canUseViewport();
    const active=!!entry&&sameDeliveryCamera(entry.camera,settings.projectCamera?.())&&settings.read().framing==='saved';
    activateBookmark.disabled=bookmarkPending||active;
    activateBookmark.textContent=active?'当前出图相机':'用作出图相机';
    syncSelectMenu(bookmarkPicker);
  }

  const opticsPanel=section('output','optics','景深',false),opticsMode=el('select');
  opticsMode.setAttribute('aria-label','景深模式');
  opticsMode.append(new Option('跟随源相机','source'),new Option('启用','on'),new Option('关闭','off'));
  row(opticsPanel,'景深模式',opticsMode);
  const opticsBody=el('div','render-optics-fields');opticsPanel.append(opticsBody);
  const focusMode=el('select');focusMode.setAttribute('aria-label','对焦方式');
  focusMode.append(new Option('相机目标点','target'),new Option('手动距离','distance'));row(opticsBody,'对焦方式',focusMode);
  const focusActions=el('div','render-settings-camera-actions'),focusPick=el('button','','拾取对焦距离');
  focusActions.dataset.search='拾取对焦距离';
  focusPick.type='button';focusPick.onclick=async()=>{try{await settings.pickFocus();}catch(error){ctx.error(error);}};
  focusActions.append(focusPick);
  const blades=el('select');blades.setAttribute('aria-label','光圈叶片');blades.dataset.searchable='false';
  blades.append(new Option('圆形','0'),...Array.from({length:14},(_,i)=>new Option(String(i+3),String(i+3))));
  let opticsPending=false,pendingOptics=null;
  async function setOptics(patch){
    if(opticsPending)return;
    pendingOptics=patch===null?null:{...(settings.projectOptics?.()||renderOpticsDefaults),...patch};
    opticsPending=true;syncOptics();
    try{await settings.setOptics(patch);}catch(error){ctx.error(error);}
    finally{opticsPending=false;pendingOptics=null;syncOptics();}
  }
  const opticsNumbers={
    focusDistance:number(opticsBody,'focusDistance','对焦距离',...renderOpticsFields.focusDistance,.05,.001,setOptics),
    fStop:number(opticsBody,'fStop','光圈 F 值',...renderOpticsFields.fStop,.02,.01,setOptics),
    rotation:number(opticsBody,'rotation','叶片旋转',...renderOpticsFields.rotation,1,.1,setOptics),
    ratio:number(opticsBody,'ratio','光圈比例',...renderOpticsFields.ratio,.01,.01,setOptics)
  };
  const distanceRow=opticsNumbers.focusDistance.closest('label'),rotationRow=opticsNumbers.rotation.closest('label');
  row(opticsBody,'光圈叶片',blades);rotationRow.before(blades.closest('label'));
  opticsBody.append(focusActions);
  opticsMode.onchange=()=>void setOptics(opticsMode.value==='source'?null:{enabled:opticsMode.value==='on'});
  focusMode.onchange=()=>void setOptics({focusMode:focusMode.value});
  blades.onchange=()=>void setOptics({blades:Number(blades.value)});
  function syncOptics(){
    const optics=opticsPending?pendingOptics:settings.projectOptics?.(),values=optics||renderOpticsDefaults;
    opticsMode.value=optics?optics.enabled?'on':'off':'source';opticsMode.disabled=opticsPending||!project.document;
    opticsBody.hidden=!optics?.enabled;focusMode.value=values.focusMode;blades.value=String(values.blades);
    focusMode.disabled=blades.disabled=opticsPending;
    focusPick.disabled=opticsPending||!settings.canUseViewport?.();
    for(const control of [opticsMode,focusMode,blades])syncSelectMenu(control);
    for(const [key,input] of Object.entries(opticsNumbers)){
      input.disabled=opticsPending;
      if(!input.closest('.workspace-range-field')?.matches('[data-dragging],[data-editing]'))input.value=String(values[key]);
    }
    distanceRow.toggleAttribute('data-optics-inactive',values.focusMode!=='distance');
    rotationRow.toggleAttribute('data-optics-inactive',values.blades===0);
  }
  const regionPanel=section('output','region','渲染区域',false),regionInfo=el('p','render-camera-state');
  const regionActions=el('div','render-settings-camera-actions');
  regionActions.dataset.search='框选渲染区域 清除渲染区域';
  function regionButton(label,action){
    const control=el('button','',label);control.type='button';
    control.onclick=async()=>{try{await action();}catch(error){ctx.error(error);}finally{syncRegion();}};
    regionActions.append(control);return control;
  }
  const drawRegion=regionButton('框选渲染区域',()=>settings.drawRegion());
  drawRegion.title='在相机视图拖出矩形 · Ctrl+B';
  const clearRegion=regionButton('清除区域',()=>settings.setRegion(null));
  const regionFields=el('div','render-region-fields');
  const regionControl=(label,key)=>{
    const input=el('input');input.type='checkbox';input.setAttribute('aria-label',label);
    input.onchange=async()=>{try{await settings.setRegion({[key]:input.checked});}catch(error){ctx.error(error);}finally{syncRegion();}};
    row(regionFields,label,input).closest('label').classList.add('render-settings-check');return input;
  };
  const enableRegion=regionControl('启用渲染区域','enabled'),cropRegion=regionControl('裁切输出','crop');
  regionPanel.append(regionInfo,regionFields,regionActions);
  function syncRegion(){
    const region=settings.projectRegion?.(),{width,height}=settings.read();
    const pixels=renderRegionPixels(region,width,height);
    regionFields.hidden=clearRegion.hidden=!region;
    drawRegion.disabled=!settings.canUseViewport?.();
    enableRegion.checked=!!region?.enabled;cropRegion.checked=!!region?.crop;cropRegion.disabled=!region?.enabled;
    regionInfo.textContent=pixels?(`区域 ${pixels.pixels[2]-pixels.pixels[0]} × ${pixels.pixels[3]-pixels.pixels[1]} · 输出 ${pixels.output.join(' × ')}`):
      region?'当前输出完整画面。':'在相机取景框中选择需要渲染的范围。';
  }
  const unavailable={};for(const category of categories){
    unavailable[category]=el('p','property-editor-unavailable');unavailable[category].hidden=true;frame.panel(category).prepend(unavailable[category]);
  }
  const objectHost=el('div','property-editor-object');frame.panel('object').append(objectHost);
  const objectEditor=createObjectPropertyEditor({host:objectHost,project,state:state.object,onChange,error:ctx.error,getTarget:()=>target('object')});
  const materialHost=el('div','property-editor-material');frame.panel('material').append(materialHost);
  const materialEditor=adapters.material(materialHost,state.material||{},()=>status('material').available&&target('material')?.kind!=='resource'?target('material'):null);
  const resourceHost=el('div','property-editor-material-resource');frame.panel('material').append(resourceHost);
  const resourceEditor=createMaterialResourceProperties({host:resourceHost,project,getTarget:()=>target('material'),error:ctx.error});
  const drawingHost=el('div','property-editor-drawing'),drawingTools=el('div','property-editor-drawing-tools');frame.panel('drawing').append(drawingTools,drawingHost);
  const drawingProject=new Proxy(project,{get(shared,key){
    if(key==='imageContext'){const value=target('drawing');return value?.projectId===shared.document?.id?{documentId:value.documentId,layerId:value.layerId,target:value.target}:null;}
    if(key==='selectImage')return (next,source,options)=>{if(!pins.drawing)shared.selectImage(next,source,options);};
    if(key==='commands')return (operations,origin)=>{
      if(!status('drawing').available)return Promise.reject(Error('固定的绘制目标已不可用'));
      return shared.commands(operations,origin);
    };
    return Reflect.get(shared,key,shared);
  }});
  const drawingEditor=adapters.drawing(drawingHost,drawingTools,frame.panel('drawing'),drawingProject);
  const note=el('p','','渲染设置保存在本机，用于出图与导出。');
  const open=el('button','','打开导出');open.type='button';open.onclick=()=>settings.openExport();frame.footer.append(note,open);
  if(settings.openRender){const render=el('button','','路径追踪出图');render.type='button';render.onclick=()=>settings.openRender();frame.footer.append(render);}
  let observed=null,lastContext=null;
  function selectionKeys(){
    const scene=project.scene;return {project:project.document?.id||null,
      object:JSON.stringify([scene?.projectId,scene?.binding,scene?.activeId,scene?.selectedIds,scene?.selectionVersion]),
      material:JSON.stringify(capture('material')),drawing:JSON.stringify(capture('drawing'))};
  }
  function searchText(node){return (node.textContent+' '+[...node.querySelectorAll('[aria-label]')].map(item=>item.getAttribute('aria-label')).join(' ')).toLocaleLowerCase();}
  function filter(){
    const query=frame.search.value.trim().toLocaleLowerCase(),active=frame.category,activeStatus=status(active);let matched=0;
    for(const [key,group] of Object.entries(panels)){
      const titleMatch=group.dataset.searchTitle.toLocaleLowerCase().includes(query),rows=[...group.querySelectorAll('.render-settings-row,.render-settings-hardware,.render-settings-camera-actions')];
      let found=titleMatch;
      for(const item of rows){const visible=!query||titleMatch||item.dataset.search.toLocaleLowerCase().includes(query);item.hidden=!visible;found||=visible;}
      group.hidden=!status(group.dataset.category).available||!!query&&!found;
      if(query&&found)group.open=true;else if(!query)group.open=openSections[key];
      if(group.dataset.category===active&&!group.hidden)matched++;
    }
    const generic={object:[...objectHost.querySelectorAll('.render-settings-section')],material:target('material')?.kind==='resource'?[...resourceHost.querySelectorAll('.render-settings-section')]:[...materialHost.querySelectorAll('.property-section')],drawing:[...drawingHost.querySelectorAll('.document-panel > *')]};
    for(const [category,nodes] of Object.entries(generic))for(const node of nodes){
      const show=!query||searchText(node).includes(query);node.hidden=!show;
      if(category===active&&show)matched++;
    }
    frame.empty.hidden=!activeStatus.available||!query||matched>0;
    frame.footer.hidden=!!query||!['render','output'].includes(active)||!activeStatus.available;
  }
  frame.search.addEventListener('input',filter);
  frame.onCategoryChange(()=>refresh());
  frame.onPinChange(()=>{
    const category=frame.category;if(pins[category]){delete pins[category];if(lastContext&&lastContext!==category&&capture(lastContext))frame.select(lastContext);}
    else{const value=capture(category);if(!value||!status(category).available)return;pins[category]=structuredClone(value);lastContext=null;}
    refresh();onChange();
  });
  function observe(event){
    if(observed&&observed.project!==(project.document?.id||null))materialResource=null;
    if(event?.kind==='selection')materialResource=null;
    else if(event?.kind==='resource'&&project.resource?.library==='materials')materialResource=project.resource.id;
    else if(event?.kind==='resource'&&!project.resource)materialResource=null;
    const next=selectionKeys(),previous=observed;observed=next;
    if(previous&&next.project===previous.project){
      let changed=null;
      if(event?.kind==='scene'&&next.object!==previous.object&&capture('object'))changed='object';
      else if(event?.kind==='imageSelection'&&(event.force||next.drawing!==previous.drawing)&&capture('drawing'))changed='drawing';
      else if(event?.kind==='resource'&&materialResource&&(event.force||next.material!==previous.material))changed='material';
      else if((event?.kind==='selection'||event?.kind==='sync')&&(event.force||next.material!==previous.material))changed='material';
      if(changed){lastContext=changed;if(!pins[frame.category])frame.select(changed);}
    }
    refresh();
  }
  function refresh(){
    syncCamera();syncAppearance();syncLighting();syncOptics();syncRegion();syncBookmarks();
    for(const category of categories){
      const current=status(category),value=target(category),message=unavailable[category];
      message.hidden=current.available;message.textContent=current.reason||'';
      if(category==='object'){objectHost.hidden=!current.available;objectEditor.refresh(current);}
      if(category==='material'){
        const resource=value?.kind==='resource';materialHost.hidden=!current.available||resource;resourceHost.hidden=!current.available||!resource;
        materialEditor.sync();resourceEditor.sync(current);
      }
      if(category==='drawing'){drawingHost.hidden=!current.available;drawingTools.hidden=!current.available||!!pins.drawing;drawingEditor.sync();}
      if(category===frame.category){
        const types={render:'场景',output:'场景',object:'物体',material:'材质图层',drawing:'绘制图层'};
        const icons={render:workspaceIcons.object,output:workspaceIcons.object,object:workspaceIcons.object,material:workspaceIcons.material,drawing:workspaceIcons.brush};
        frame.setContext({type:current.type||types[category],name:current.name||value?.name||'未选择',icon:icons[category]});
        frame.setPin({pinned:!!pins[category],available:current.available});
      }
    }
    filter();
  }
  function sync(event){
    const value=settings.read();
    for(const [key,input] of Object.entries({samples,width,height,maxBounces})){
      const field=input.closest('.workspace-range-field');
      if(!field?.hasAttribute('data-dragging')&&!field?.hasAttribute('data-editing'))input.value=String(value[key]);
    }
    transparent.checked=value.transparent;device.value=value.device==='cpu'?'cpu':'auto';
    syncViewportSampling();syncSelectMenu(device);syncFormat(value);syncPreset();
    open.disabled=!project.document;observe(event?.kind?event:{kind:'sync'});
  }
  const unsubscribe=settings.subscribe(sync),unsubscribeProject=project.subscribe(event=>event.kind==='project'?sync(event):observe(event));
  sync();
  return {kind:'renderSettings',sync,getState:()=>({...frame.getState(),sections:{...openSections},cameraBookmark:bookmarkId,light:activeLight,pins:structuredClone(pins),object:objectEditor.getState(),material:materialEditor.getState()}),
    dispose(){unsubscribe();unsubscribeProject();materialEditor.dispose();drawingEditor.dispose();}};
}
