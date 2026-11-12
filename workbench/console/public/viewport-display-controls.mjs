import {areaIcons,chromeMenu,openChromeMenu} from './area-chrome.mjs';
import {setupPaintDisplay} from './paint-display.mjs';

const icon=content=>`<svg class="chrome-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
const icons={
  gizmos:icon('<path d="M5 15 15 5m-5 0h5v5M5 15V8m0 7h7"/><circle cx="5" cy="15" r="1.5" fill="currentColor"/>'),
  overlays:icon('<circle cx="8" cy="8" r="5"/><path d="M11.3 6.8a5 5 0 1 1-4.5 4.5"/>'),
  xray:icon('<rect x="3" y="3" width="10" height="10" rx="1"/><rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" fill-opacity=".15"/>'),
  wire:icon('<circle cx="10" cy="10" r="7.4"/><ellipse cx="10" cy="10" rx="3.6" ry="7.4"/><path d="M2.8 10h14.4"/>'),
  solid:icon('<circle cx="10" cy="10" r="7.4" fill="currentColor"/>'),
  material:icon('<circle cx="10" cy="10" r="7.4"/><path d="M10 2.6v14.8a7.4 7.4 0 0 1 0-14.8Z" fill="currentColor"/>'),
  cycles:icon('<circle cx="10" cy="10" r="7.4"/><path d="m4.2 14.5 10.3-10.3M6.8 16.6l9.8-9.8M11.2 17.3l6.1-6.1M2.7 8.8l6.1-6.1m-5.4 9.5 8.8-8.8" opacity=".65"/>'),
  chevron:icon('<path d="m6 8 4 4 4-4"/>')
};
const modes={wire:'线框',solid:'实体',material:'材质预览',cycles:'渲染预览'};
const el=(tag,cls)=>Object.assign(document.createElement(tag),{className:cls});
function toggle(label,graphic,click){
  const button=el('button','viewport-display-button');button.type='button';
  button.setAttribute('aria-label',label);button.title=label;button.innerHTML=graphic;button.onclick=click;
  return button;
}
function pressed(button,value){button.setAttribute('aria-pressed',String(value));}
function menu(group,label){
  const details=el('details','viewport-display-menu'),summary=el('summary','viewport-display-arrow');
  summary.title=label;summary.setAttribute('aria-label',label);summary.setAttribute('role','button');summary.innerHTML=icons.chevron;
  const content=el('div','viewport-display-popover');
  content.setAttribute('role','group');content.setAttribute('aria-label',label);
  const heading=el('div','viewport-display-heading');heading.textContent=label;content.append(heading);
  details.append(summary,content);group.append(details);chromeMenu(details,content);
  summary.setAttribute('aria-expanded','false');
  details.addEventListener('toggle',()=>summary.setAttribute('aria-expanded',String(details.open)));
  return {details,content};
}
function check(parent,label,value,onChange){
  const row=el('label','viewport-display-check'),input=document.createElement('input');input.type='checkbox';input.checked=value;
  input.onchange=()=>onChange(input.checked);row.append(input,label);parent.append(row);
  return row;
}
function field(source,key){
  const label=source.querySelector(`[data-scene="${key}"]`).closest('label');
  label.className=label.querySelector('input[type=checkbox]')?'viewport-display-check':'viewport-display-field';
  return label;
}

export function createViewportDisplayControls({ctx,view,viewport,change,onMode,openRenderSettings,isEditing,renderPlayback}){
  const {state,areaId,tools}=ctx,lifecycle=new AbortController(),signal=lifecycle.signal;
  const root=el('div','viewport-display-controls');root.setAttribute('role','group');root.setAttribute('aria-label','视口显示');
  tools.after(root);
  const group=label=>{
    const container=el('div','viewport-display-group');container.setAttribute('role','group');container.setAttribute('aria-label',label);
    root.append(container);return container;
  };
  let mode=Object.hasOwn(modes,state.display)?state.display:'material',xray=state.xray===true,projectLighting=state.projectLighting!==false;
  let overlays=state.overlays!==false,gizmos=state.gizmos!==false,axis=state.axis!==false,transform=state.transformGizmo!==false;
  const gizmoGroup=group('操纵器');
  const gizmoButton=toggle('显示操纵器',icons.gizmos,()=>{gizmos=!gizmos;update();});
  gizmoGroup.append(gizmoButton);
  const gizmoMenu=menu(gizmoGroup,'操纵器设置');
  check(gizmoMenu.content,'导航坐标轴',axis,value=>{axis=value;update();});
  check(gizmoMenu.content,'物体变换手柄',transform,value=>{transform=value;update();});

  const overlayGroup=group('叠加层');
  const overlayButton=toggle('显示叠加层',icons.overlays,()=>{overlays=!overlays;update();});
  overlayGroup.append(overlayButton);
  const overlayMenu=menu(overlayGroup,'叠加层设置');
  const source=document.getElementById('display-options').cloneNode(true);
  for(const wrapper of source.querySelectorAll('.custom-select')){
    const select=wrapper.querySelector('select');
    select.removeAttribute('aria-hidden');select.removeAttribute('tabindex');wrapper.replaceWith(select);
  }
  overlayMenu.content.append(field(source,'grid'));

  const xrayButton=toggle('透视（X-Ray）',icons.xray,()=>{xray=!xray;update();});
  root.append(xrayButton);
  const shading=group('着色方式'),buttons=new Map();
  for(const [value,label] of Object.entries(modes)){
    const button=toggle(label,icons[value],()=>{
      if(mode===value)return;
      mode=value;update();onMode();
    });
    if(value==='cycles')button.title='渲染预览 · 路径追踪';
    buttons.set(value,button);shading.append(button);
  }
  const shadingMenu=menu(shading,'着色设置');
  const useProject=check(shadingMenu.content,'使用工程布光',projectLighting,value=>{projectLighting=value;update();onMode();});
  root.append(renderPlayback);
  const fields=el('div','viewport-display-fields');
  for(const key of ['environment','rotation','exposure','environmentStrength','background','ground'])fields.append(field(source,key));
  const reset=source.querySelector('#reset-display');reset.removeAttribute('id');fields.append(reset);
  const renderSettings=toggle('打开渲染设置',areaIcons.renderSettings,()=>{shadingMenu.details.open=false;openRenderSettings();});
  renderSettings.className='viewport-display-render-settings';renderSettings.append('打开渲染设置');
  shadingMenu.content.append(fields,renderSettings);
  const scene=setupPaintDisplay(viewport,null,{options:root,reset,storageKey:'arachne-area-display:'+areaId,initial:state.scene,onChange:ctx.onChange});

  function refresh(){
    const canXray=mode==='wire'||mode==='solid';
    pressed(gizmoButton,gizmos);pressed(overlayButton,overlays);pressed(xrayButton,canXray&&xray);
    xrayButton.disabled=!canXray;
    for(const [value,button] of buttons)pressed(button,mode===value);
    renderSettings.hidden=useProject.hidden=mode!=='cycles';
    fields.hidden=mode==='cycles'&&projectLighting;
    view.dataset.shading=mode;
    change({mode,xray:canXray&&xray,overlays,axis:gizmos&&axis,transform:gizmos&&transform});
  }
  function update(){refresh();ctx.onChange();}
  view.addEventListener('keydown',event=>{
    if(event.key.toLowerCase()!=='n'||event.defaultPrevented||event.repeat||event.altKey||event.shiftKey||event.metaKey||event.ctrlKey||
       event.target.closest('input,select,textarea,[contenteditable]')||document.querySelector('dialog[open],.custom-select-menu')||isEditing())return;
    event.preventDefault();
    if(shadingMenu.details.open)shadingMenu.details.open=false;
    else openChromeMenu(shadingMenu.details);
  },{signal});
  return {get mode(){return mode;},get projectLighting(){return projectLighting;},refresh,getState:()=>({display:mode,xray,overlays,gizmos,axis,transformGizmo:transform,projectLighting,scene:scene.getSettings()}),
    close(){for(const details of root.querySelectorAll('details[open]'))details.open=false;},
    dispose(){lifecycle.abort();scene.dispose();root.remove();}};
}
