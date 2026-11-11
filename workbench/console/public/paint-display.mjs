import {sceneOptions} from './scene-options.mjs';
import {setSelectValue} from './paint-select.mjs';

export function setupPaintDisplay(viewport,surfaceIsEditing,config={}){
  const lifecycle=new AbortController(),signal=lifecycle.signal;
  const storageKey=config.storageKey||'arachne-paint-display';
  const host=config.host||document.getElementById('viewport'),sidebar=config.sidebar||document.getElementById('display-sidebar');
  const toggle=config.toggle||document.getElementById('display-toggle');
  const options=config.options||document.getElementById('display-options');
  const fields=[...options.querySelectorAll('[data-scene]')];
  function toggleSidebar(){
    const opening=options.inert;
    if(!opening&&options.contains(document.activeElement))toggle.focus({preventScroll:true});
    options.inert=!opening;
    toggle.setAttribute('aria-expanded',String(opening));
    toggle.setAttribute('aria-label',(opening?'收起':'展开')+'视口显示侧栏');
  }
  if(surfaceIsEditing){
    toggle.onclick=toggleSidebar;
    sidebar.onkeydown=event=>{
      if(event.key!=='Escape'||options.inert)return;
      event.preventDefault();event.stopPropagation();toggleSidebar();
    };
    (config.host||document).addEventListener('keydown',event=>{
      if(event.key.toLowerCase()!=='n'||event.repeat||event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey||
         event.target.closest?.('input,textarea,select,[contenteditable],.custom-select')||document.querySelector('dialog[open],.custom-select-menu')||
         !host.getClientRects().length||surfaceIsEditing()||(!host.contains(event.target)&&!host.matches(':hover')))return;
      event.preventDefault();toggleSidebar();
    },{signal});
  }
  let settings=sceneOptions(),frame=null;
  try{settings=sceneOptions(JSON.parse(localStorage.getItem(storageKey))||{});}catch{}
  if(config.initial)try{settings=sceneOptions(config.initial);}catch{}
  function store(){
    config.onChange?.();
    try{localStorage.setItem(storageKey,JSON.stringify(settings));}catch{}
  }
  function update(){
    for(const field of fields){
      const key=field.dataset.scene,value=settings[key];
      if(field.type==='checkbox')field.checked=value;
      else if(field.tagName==='SELECT')setSelectValue(field,value);
      else field.value=value;
      const readout=field.nextElementSibling;
      if(readout?.tagName==='OUTPUT'){
        readout.value=key==='rotation'?value+'°':value.toFixed(key==='exposure'?1:2);
      }
    }
    if(frame===null)frame=requestAnimationFrame(()=>{
      frame=null;viewport.setEnvironment(settings);
    });
  }
  for(const field of fields){
    const key=field.dataset.scene;
    field.oninput=()=>{
      const value=field.type==='checkbox'?field.checked:field.type==='range'?field.valueAsNumber:field.value;
      settings=sceneOptions({...settings,[key]:value});update();
    };
    field.onchange=store;
  }
  (config.reset||document.getElementById('reset-display')).onclick=()=>{settings=sceneOptions();store();update();};
  update();
  return {dispose(){lifecycle.abort();if(frame!==null)cancelAnimationFrame(frame);},getSettings:()=>({...settings}),setSettings(raw){settings=sceneOptions(raw);store();update();}};
}
