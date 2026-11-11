import {syncSelectMenu} from './paint-select.mjs';
import {createPropertyEditorFrame} from './property-editor.mjs';
import {areaIcons} from './area-chrome.mjs';
import {workspaceIcons} from './workspace-icons.mjs';
import {capturePropertyTarget,propertyTargetStatus} from './property-targets.mjs';
import {createObjectPropertyEditor} from './object-property-editor.mjs';
import {createMaterialResourceProperties} from './material-resource-properties.mjs';
import {cyclesDeviceText,cyclesDeviceBlocked} from './paint-cycles-devices.mjs';
import {cyclesLimits,cyclesFormats,cyclesViewportLimits} from './cycles-limits.mjs';
import {viewportSamplingDefaults} from './cycles-viewport-sampling.mjs';
import {cyclesLightPaths,cyclesLightPathDefaults} from './cycles-light-paths.mjs';
import {cyclesRenderPasses,renderPassBytes} from './cycles-render-passes.mjs';
import {renderOpticsDefaults,renderOpticsFields} from './render-optics.mjs';
import {renderRegionPixels} from './render-region.mjs';
import {renderAppearanceDefaults,renderAppearanceLimits,renderTransforms,renderLooks} from './render-appearance.mjs';
import {renderLightingDefaults,renderLightingLimits,renderLightingPresets} from './render-lighting.mjs';

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
  const engine=section('render','engine','渲染引擎');readout(engine,'引擎','Cycles');
  const device=el('select');device.setAttribute('aria-label','渲染设备');
  device.append(new Option('自动 · 优先 GPU','auto'),new Option('CPU','cpu'),new Option('GPU','gpu'));
  device.title='自动模式在 GPU 不可用时使用 CPU；指定 GPU 时失败不会自动切换';
  device.addEventListener('change',()=>{try{settings.set({device:device.value});}catch(error){ctx.error(error);sync();}});row(engine,'设备',device);
  const hardwareRow=el('div','render-settings-hardware'),hardware=el('p','',''),detect=el('button','','重新检测');
  hardwareRow.dataset.search='Blender Cycles CPU GPU Metal CUDA 渲染设备';hardware.setAttribute('role','status');
  detect.type='button';detect.onclick=()=>void settings.devices.check(true);
  hardwareRow.append(hardware,detect);if(settings.devices)engine.append(hardwareRow);
  function syncHardware(){
    if(!settings.devices)return;
    const info=settings.devices.read(),deviceMode=settings.read().device;
    const version=info.value?.version;
    const message=[version?'Blender '+version:null,cyclesDeviceText(info),
      deviceMode==='gpu'&&info.value?.available&&cyclesDeviceBlocked(info,deviceMode)?'请选择自动或 CPU。':null].filter(Boolean).join('\n');
    if(hardware.textContent!==message)hardware.textContent=message;
    detect.disabled=info.status==='checking';
    detect.textContent=info.status==='checking'?'检测中…':'重新检测';
  }
  const sampling=section('render','sampling','渲染采样');
  const adaptive=check(sampling,'adaptive','自适应采样');
  const noiseThreshold=number(sampling,'noiseThreshold','噪波阈值',0,1,.001,.0001);
  noiseThreshold.title='0 自动选择；数值越低，通常耗时越长';
  const samples=number(sampling,'samples','最大采样数',1,cyclesLimits.maxSamples,1);
  const denoise=check(sampling,'denoise','渲染降噪');
  const viewportSampling=section('render','viewportSampling','视口采样',false);
  const viewportAdaptive=check(viewportSampling,'adaptive','视口自适应采样',settings.setViewportSampling);
  const viewportNoise=number(viewportSampling,'noiseThreshold','视口噪波阈值',0,1,.001,.0001,settings.setViewportSampling);
  const draftSamples=number(viewportSampling,'draftSamples','快速预览采样',1,cyclesViewportLimits.draft.samples,1,1,settings.setViewportSampling);
  const detailSamples=number(viewportSampling,'detailSamples','细化预览采样',1,cyclesViewportLimits.detail.samples,1,1,settings.setViewportSampling);
  detailSamples.title='开启自动细化后，使用 4K 贴图和此处的采样上限';
  const viewportDenoise=check(viewportSampling,'denoise','视口降噪',settings.setViewportSampling);
  const resetSampling=el('button','','恢复默认');resetSampling.type='button';resetSampling.title='恢复视口采样默认值';
  resetSampling.onclick=()=>settings.setViewportSampling(viewportSamplingDefaults);
  const viewportActions=el('div','render-settings-camera-actions');viewportActions.dataset.search='恢复默认 视口采样';viewportActions.append(resetSampling);
  viewportSampling.append(viewportActions);
  function syncViewportSampling(){
    const value=settings.readViewportSampling();
    viewportAdaptive.checked=value.adaptive;viewportDenoise.checked=value.denoise;
    viewportNoise.closest('label').toggleAttribute('data-viewport-adaptive-off',!value.adaptive);
    for(const [key,input] of Object.entries({draftSamples,detailSamples,noiseThreshold:viewportNoise}))
      if(!input.closest('.workspace-range-field')?.matches('[data-dragging],[data-editing]'))input.value=String(value[key]);
    resetSampling.disabled=Object.keys(viewportSamplingDefaults).every(key=>value[key]===viewportSamplingDefaults[key]);
  }
  const paths=section('render','paths','光线路径',false),maxBounces=number(paths,'maxBounces','最大反弹',0,64,1);
  const customPaths=el('input');customPaths.type='checkbox';customPaths.setAttribute('aria-label','自定义光线路径');
  row(paths,'自定义光线路径',customPaths).closest('label').classList.add('render-settings-check');
  const pathFields=el('div','render-path-fields'),pathInputs={};paths.append(pathFields);
  function setLightPaths(patch){
    settings.set({lightPaths:patch===null?null:{...(settings.read().lightPaths||cyclesLightPathDefaults),...patch}});
  }
  customPaths.onchange=()=>{try{setLightPaths(customPaths.checked?{}:null);}catch(error){ctx.error(error);sync();}};
  for(const [heading,keys] of [
    ['反弹次数',['diffuseBounces','glossyBounces','transmissionBounces','volumeBounces','transparentBounces']],
    ['亮度限制',['directClamp','indirectClamp']],
    ['焦散',['glossyFilter','reflectiveCaustics','refractiveCaustics']]
  ]){
    pathFields.append(el('p','render-path-heading',heading));
    for(const key of keys){
      const {label,min,max,step,default:initial}=cyclesLightPaths[key];
      if(typeof initial==='boolean'){
        const input=el('input');input.type='checkbox';input.setAttribute('aria-label',label);
        input.onchange=()=>{try{setLightPaths({[key]:input.checked});}catch(error){ctx.error(error);sync();}};
        row(pathFields,label,input).closest('label').classList.add('render-settings-check');pathInputs[key]=input;
      }else{
        pathInputs[key]=number(pathFields,key,label,min,max,step===1?1:.02,step,setLightPaths);
        if(heading==='亮度限制')pathInputs[key].title='0 表示不限制';
      }
    }
  }
  function syncPaths(value){
    customPaths.checked=!!value.lightPaths;pathFields.hidden=!value.lightPaths;
    for(const [key,input] of Object.entries(pathInputs)){
      const next=(value.lightPaths||cyclesLightPathDefaults)[key];
      if(input.type==='checkbox')input.checked=next;
      else if(!input.closest('.workspace-range-field')?.matches('[data-dragging],[data-editing]'))input.value=String(next);
    }
  }
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
  preset.onchange=()=>void editLighting({preset:preset.value});
  lightingOverride.onchange=()=>void editLighting(lightingOverride.checked?renderLightingDefaults:null);
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
        [new Option('跟随源场景',''),new Option('8 位','8'),new Option('16 位','16')]));
    }
    bitDepth.value=String(value.bitDepth??'');syncSelectMenu(format);syncSelectMenu(bitDepth);
  }
  bitDepth.onchange=()=>{try{settings.set({bitDepth:bitDepth.value?Number(bitDepth.value):null});}catch(error){ctx.error(error);sync();}};
  row(output,'位深',bitDepth);
  const passesPanel=section('output','passes','渲染通道',false),passInputs={};
  const passSummary=el('p','render-camera-state');passesPanel.append(passSummary);
  for(const [key,{label}] of Object.entries(cyclesRenderPasses)){
    const input=el('input');input.type='checkbox';input.setAttribute('aria-label','渲染通道：'+label);
    input.onchange=()=>{
      const values=new Set(settings.read().renderPasses||[]);
      if(input.checked)values.add(key);else values.delete(key);
      try{settings.set({renderPasses:[...values]});}catch(error){ctx.error(error);sync();}
    };
    row(passesPanel,label,input).closest('label').classList.add('render-settings-check');passInputs[key]=input;
  }
  function syncPasses(value){
    const selected=value.renderPasses||[],detected=settings.devices?.read().value;
    const unavailable=detected?.available&&detected.renderPasses===false;
    for(const [key,input] of Object.entries(passInputs)){input.checked=selected.includes(key);input.disabled=!!unavailable&&!input.checked;}
    passSummary.textContent=unavailable?'当前 Blender 不支持多层 EXR；可清除已选通道。':selected.length?
      `合成图＋${selected.length} 个通道 · 32 位浮点 EXR · 未压缩约 ${Math.ceil(renderPassBytes(selected,value.width,value.height)/1048576)} MiB`:
      '勾选后从同一帧输出多层 EXR。';
  }
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
  if(settings.openRender){const render=el('button','','Cycles 出图');render.type='button';render.onclick=()=>settings.openRender();frame.footer.append(render);}
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
    if(frame.category==='render'&&project.document)void settings.devices?.check();
    syncCamera();syncAppearance();syncLighting();syncOptics();syncRegion();
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
    for(const [key,input] of Object.entries({samples,width,height,noiseThreshold,maxBounces})){
      const field=input.closest('.workspace-range-field');
      if(!field?.hasAttribute('data-dragging')&&!field?.hasAttribute('data-editing'))input.value=String(value[key]);
    }
    denoise.checked=value.denoise;adaptive.checked=value.adaptive;transparent.checked=value.transparent;
    noiseThreshold.disabled=!value.adaptive;device.value=value.device;
    syncViewportSampling();syncSelectMenu(device);syncFormat(value);syncHardware();syncPreset();syncPaths(value);syncPasses(value);
    open.disabled=!project.document;observe(event?.kind?event:{kind:'sync'});
  }
  const unsubscribe=settings.subscribe(sync),unsubscribeProject=project.subscribe(event=>event.kind==='project'?sync(event):observe(event));
  const unsubscribeHardware=settings.devices?.subscribe(()=>{syncHardware();syncPasses(settings.read());});sync();
  return {kind:'renderSettings',sync,getState:()=>({...frame.getState(),sections:{...openSections},pins:structuredClone(pins),object:objectEditor.getState(),material:materialEditor.getState()}),
    dispose(){unsubscribe();unsubscribeProject();unsubscribeHardware?.();materialEditor.dispose();drawingEditor.dispose();}};
}
