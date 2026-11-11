import {setSelectValue} from './paint-select.mjs';

const $=id=>document.getElementById(id);
const defaults={left:[],right:['layers','properties'],bottom:['assets']};
const panelNames={layers:'图层',properties:'属性',assets:'素材库'};
const areaNames={left:'左侧',right:'右侧',bottom:'底部'};
const defaultWeights={layers:2,properties:4,assets:3};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

function read(key){
  try{return localStorage.getItem('arachne-paint-'+key);}catch{return null;}
}
function write(key,value){
  try{
    const name='arachne-paint-'+key;
    if(value===null)localStorage.removeItem(name);
    else localStorage.setItem(name,value);
  }catch{}
}
function savedDocks(raw){
  try{
    const {areas,weights}=JSON.parse(raw);
    const dockAreas=Object.keys(defaults);
    if(dockAreas.some(area=>!Array.isArray(areas[area])))throw Error();
    const all=dockAreas.flatMap(area=>areas[area]);
    if(all.length!==3||new Set(all).size!==3||all.some(id=>!Object.hasOwn(panelNames,id)))throw Error();
    return {areas:Object.fromEntries(dockAreas.map(area=>[area,areas[area]])),weights:Object.fromEntries(all.map(id=>[id,
      Number.isFinite(weights?.[id])?clamp(weights[id],.05,9):defaultWeights[id]]))};
  }catch{return {areas:structuredClone(defaults),weights:{...defaultWeights}};}
}
function migrateDrawingDocks(){
  if(read('drawing-layout-v1'))return;
  for(const key of ['shelf','hidden-panels','left-splitter','inspector-splitter','bottom-splitter']){
    const stored=read(key);
    if(stored!==null&&read('drawing-'+key)===null)write('drawing-'+key,stored);
  }
  write('drawing-layout-v1','1');
}

function bindSplitter(handle,{axis,measure,range,set,save,reset,sign=1}){
  const coordinate=event=>axis==='x'?event.clientX:event.clientY;
  let drag=null;
  function update(){
    const [min,max]=range();
    for(const [name,value] of [['min',min],['max',max],['now',measure()]])
      handle.setAttribute('aria-value'+name,String(Math.round(value)));
  }
  function resize(value){
    const [min,max]=range();
    if(max<min)return;
    set(clamp(value,min,max));update();
  }
  handle.onpointerdown=event=>{
    if(event.button!==0)return;
    drag={id:event.pointerId,start:coordinate(event),size:measure()};
    handle.setPointerCapture(event.pointerId);handle.dataset.dragging='';
    event.preventDefault();
  };
  handle.onpointermove=event=>{
    if(drag?.id===event.pointerId)resize(drag.size+sign*(coordinate(event)-drag.start));
  };
  handle.onlostpointercapture=()=>{
    if(!drag)return;
    drag=null;delete handle.dataset.dragging;save();
  };
  function cancel(){
    if(!drag)return;
    const {id}=drag;
    drag=null;delete handle.dataset.dragging;
    if(handle.hasPointerCapture(id))handle.releasePointerCapture(id);
  }
  handle.onkeydown=event=>{
    const [min,max]=range(),[before,after]=axis==='x'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];
    const value={Home:min,End:max,[before]:measure()-16*sign,[after]:measure()+16*sign}[event.key];
    if(value===undefined)return;
    event.preventDefault();resize(value);save();
  };
  handle.ondblclick=()=>{reset();update();};
  update();
  return {update,cancel};
}

export function setupPaintLayout({surfaceIsEditing}){
  const workspace=$('workspace'),guide=$('dock-guide'),views=document.querySelector('.view-panes');
  const focusButton=$('focus-views'),windowMenu=$('window-menu'),uv=$('uv-view');
  const zones={left:$('left-dock'),right:$('paint-inspector'),bottom:$('bottom-dock')};
  const splitters={left:$('left-splitter'),right:$('inspector-splitter'),bottom:$('bottom-splitter')};
  const panels=Object.fromEntries([...workspace.querySelectorAll('[data-panel]')].map(p=>[p.dataset.panel,p]));
  const menus={};
  migrateDrawingDocks();
  let workArea='drawing';
  const scope=key=>workArea==='drawing'?'drawing-'+key:key;
  const readMode=key=>read(scope(key)),writeMode=(key,value)=>write(scope(key),value);
  function loadLayout(){
    const result={...savedDocks(readMode('docks')),collapsed:readMode('shelf')==='closed',hiddenPanels:new Set()};
    try{
      const saved=JSON.parse(readMode('hidden-panels'));
      if(Array.isArray(saved))result.hiddenPanels=new Set(saved.filter(id=>Object.hasOwn(panelNames,id)));
    }catch{}
    return result;
  }
  let {areas,weights,collapsed,hiddenPanels}=loadLayout();
  let gesture=null,focused=false,pointerView=null,docksAvailable=true;
  const panelChoices=[...windowMenu.querySelectorAll('[data-show-panel]')];
  const store=()=>writeMode('docks',JSON.stringify({areas,weights}));
  const measure=(node,axis)=>node.getBoundingClientRect()[axis==='x'?'width':'height'];
  const resets=[],restoreRegions=[];
  const updates=[];
  let panelUpdates=[];

  function bindRegion(handle,pane,axis,range,target,style,sign,encode,unit){
    const key=handle.id;
    let size=null;
    const restore=()=>{
      const raw=readMode(key);
      size=raw!==null&&Number.isFinite(Number(raw))?Number(raw):null;
      if(size===null)target.style.removeProperty(style);
      else target.style.setProperty(style,size+unit);
    };
    const reset=()=>{writeMode(key,null);restore();};
    restore();restoreRegions.push(restore);
    resets.push(reset);
    updates.push(bindSplitter(handle,{axis,range,sign,measure:()=>measure(pane,axis),reset,
      set:value=>{size=encode(value);target.style.setProperty(style,size+unit);},
      save:()=>{if(size!==null)writeMode(key,size);}}));
  }

  const sideRange=()=>innerWidth<=650?[85,Math.max(85,innerWidth*.25)]:[150,Math.min(520,innerWidth*.35)];
  bindRegion(splitters.left,zones.left,'x',sideRange,workspace,'--left-width',1,Math.round,'px');
  bindRegion(splitters.right,zones.right,'x',sideRange,workspace,'--inspector-width',-1,Math.round,'px');
  bindRegion(splitters.bottom,zones.bottom,'y',()=>[90,Math.max(90,innerHeight*.42)],
    zones.bottom,'--bottom-height',-1,Math.round,'px');
  const viewWidth=()=>Math.max(0,views.clientWidth-5);
  bindRegion($('view-splitter'),$('viewport'),'x',()=>[viewWidth()*.2,viewWidth()*.8],
    views,'--view-share',1,width=>width/Math.max(1,viewWidth()),'');
  const updateSizes=()=>[...updates,...panelUpdates].forEach(({update})=>update());
  const observer=new ResizeObserver(updateSizes);
  for(const node of [workspace,views,...Object.values(zones),...Object.values(panels)])observer.observe(node);

  function setWeight(id,value){
    weights[id]=value;panels[id].style.setProperty('--dock-weight',value);
  }
  function panelDivider(first,second,area){
    const axis=area==='bottom'?'x':'y';
    const handle=document.createElement('div');
    handle.className='dock-splitter';
    handle.tabIndex=0;
    handle.setAttribute('role','separator');
    handle.setAttribute('aria-label','调整'+panelNames[first]+'与'+panelNames[second]+'大小');
    handle.setAttribute('aria-orientation',axis==='x'?'vertical':'horizontal');
    const size=()=>measure(panels[first],axis);
    const total=()=>size()+measure(panels[second],axis);
    const minimum=axis==='x'?90:38;
    panelUpdates.push(bindSplitter(handle,{axis,measure:size,range:()=>[minimum,total()-minimum],
      set:value=>{
        const sum=weights[first]+weights[second],fraction=value/total();
        setWeight(first,sum*fraction);setWeight(second,sum*(1-fraction));
      },
      save:store,
      reset:()=>{setWeight(first,defaultWeights[first]);setWeight(second,defaultWeights[second]);store();}}));
    return handle;
  }

  function arrange(){
    const focus=document.activeElement;
    panelUpdates=[];
    for(const input of panelChoices){
      input.checked=!hiddenPanels.has(input.dataset.showPanel);
      input.disabled=!docksAvailable;
    }
    $('reset-docks').disabled=!docksAvailable;
    workspace.toggleAttribute('data-focus-views',focused);
    focusButton.setAttribute('aria-pressed',String(focused));
    for(const [area,ids] of Object.entries(areas)){
      const zone=zones[area];
      for(const divider of zone.querySelectorAll(':scope > .dock-splitter'))divider.remove();
      const visible=ids.filter(id=>!hiddenPanels.has(id));
      const shelfStrip=area==='bottom'&&collapsed&&visible.length===1&&visible[0]==='assets';
      zone.hidden=!docksAvailable||focused||!visible.length;
      splitters[area].hidden=zone.hidden||shelfStrip;
      zone.toggleAttribute('data-shelf-strip',shelfStrip);
      let previous=null;
      for(const id of ids){
        const panel=panels[id];
        panel.hidden=hiddenPanels.has(id);
        setSelectValue(menus[id],area);
        if(panel.hidden){
          zone.append(panel);continue;
        }
        const isCollapsed=id==='assets'&&collapsed;
        if(previous&&!isCollapsed)zone.append(panelDivider(previous,id,area));
        zone.append(panel);
        setWeight(id,weights[id]);
        previous=isCollapsed?null:id;
      }
    }
    if(focus instanceof HTMLElement&&workspace.contains(focus))focus.focus({preventScroll:true});
    updateSizes();
  }

  function dock(id,area,before=null){
    if(before===id||!docksAvailable||surfaceIsEditing())return;
    for(const ids of Object.values(areas)){
      const index=ids.indexOf(id);
      if(index>=0)ids.splice(index,1);
    }
    const list=areas[area],index=list.indexOf(before);
    list.splice(index<0?list.length:index,0,id);
    arrange();store();
  }

  function dropTarget(x,y){
    const bounds=workspace.getBoundingClientRect();
    if(x<bounds.left||x>bounds.right||y<bounds.top||y>bounds.bottom)return null;
    const hit=document.elementFromPoint(x,y);
    const target=hit?.closest('.dock-panel'),zone=hit?.closest('.dock-zone');
    if(zone){
      const area=zone.dataset.area;
      if(!target)return {area,rect:zone.getBoundingClientRect()};
      const id=target.dataset.panel,rect=target.getBoundingClientRect();
      if(id===gesture.id)return {area,before:id,rect};
      const horizontal=area==='bottom';
      const isBefore=horizontal?x<rect.left+rect.width/2:y<rect.top+rect.height/2;
      const list=areas[area].filter(item=>item!==gesture.id&&!hiddenPanels.has(item));
      const before=isBefore?id:list[list.indexOf(id)+1];
      return {area,before,rect:horizontal?
        {left:isBefore?rect.left:rect.right-7,top:rect.top,width:7,height:rect.height}:
        {left:rect.left,top:isBefore?rect.top:rect.bottom-7,width:rect.width,height:7}};
    }
    const work=views.getBoundingClientRect();
    const insideTools=x<work.left&&hit?.closest('.tool-rail');
    const width=Math.min(105,work.width*.28);
    if(insideTools||x<work.left+width)return {area:'left',rect:{left:work.left,top:work.top,width,height:work.height}};
    if(x>work.right-width)return {area:'right',rect:{left:work.right-width,top:work.top,width,height:work.height}};
    if(y>work.bottom-95)return {area:'bottom',rect:{left:work.left,top:work.bottom-95,width:work.width,height:95}};
    return null;
  }

  function highlight(target){
    guide.hidden=!target;
    if(!target)return;
    const base=workspace.getBoundingClientRect(),{left,top,width,height}=target.rect;
    Object.assign(guide.style,{left:left-base.left+'px',top:top-base.top+'px',width:width+'px',height:height+'px'});
  }

  function buildTitle(id,panel){
    const title=panel.querySelector('.dock-title');
    const heading=document.createElement('h2');
    const handle=document.createElement('button');
    handle.type='button';handle.className='dock-handle';handle.textContent='⠿ '+panelNames[id];
    handle.title='拖动到左侧、右侧或底部停靠';
    handle.setAttribute('aria-label','拖动'+panelNames[id]+'面板');
    heading.append(handle);title.append(heading);
    const menu=document.createElement('select');
    menu.setAttribute('aria-label',panelNames[id]+'停靠位置');
    for(const [area,label] of Object.entries(areaNames))menu.append(new Option(label,area));
    menu.onchange=()=>dock(id,menu.value);
    menus[id]=menu;title.append(menu);
    handle.onpointerdown=event=>{
      if(event.button!==0||!docksAvailable||surfaceIsEditing())return;
      gesture={id,pointer:event.pointerId,x:event.clientX,y:event.clientY,target:null};
      handle.setPointerCapture(event.pointerId);
    };
    handle.onpointermove=event=>{
      if(gesture?.pointer!==event.pointerId)return;
      if(!gesture.active&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<5)return;
      gesture.active=true;
      gesture.target=dropTarget(event.clientX,event.clientY);
      highlight(gesture.target);
    };
    handle.onpointerup=event=>{
      if(gesture?.pointer!==event.pointerId)return;
      const target=gesture.active?dropTarget(event.clientX,event.clientY):null;
      gesture=null;highlight(null);
      if(target)dock(id,target.area,target.before);
    };
    handle.onlostpointercapture=()=>{gesture=null;highlight(null);};
    handle.onkeydown=event=>{
      const area={ArrowLeft:'left',ArrowRight:'right',ArrowDown:'bottom'}[event.key];
      if(!area)return;
      event.preventDefault();dock(id,area);
    };
  }
  for(const [id,panel] of Object.entries(panels))buildTitle(id,panel);

  const toggle=document.createElement('button');
  toggle.id='toggle-shelf';toggle.type='button';toggle.setAttribute('aria-controls','assets');
  panels.assets.querySelector('.dock-title').append(toggle);
  function shelf(){
    toggle.textContent=collapsed?'▸':'▾';
    toggle.title=collapsed?'展开素材库':'收起素材库';
    toggle.setAttribute('aria-label',toggle.title);
    toggle.setAttribute('aria-expanded',String(!collapsed));
    panels.assets.toggleAttribute('data-collapsed',collapsed);
    panels.assets.querySelector('.dock-content').hidden=collapsed;
    for(const id of ['assets','asset-search','shelf-actions'])$(id).hidden=collapsed;
    arrange();
  }
  toggle.onclick=()=>{collapsed=!collapsed;writeMode('shelf',collapsed?'closed':null);shelf();};
  const toggleFocus=()=>{if(docksAvailable&&!surfaceIsEditing()){focused=!focused;arrange();}};
  focusButton.onclick=toggleFocus;
  for(const input of panelChoices)input.onchange=()=>{
    const id=input.dataset.showPanel;
    if(input.checked){hiddenPanels.delete(id);focused=false;}
    else hiddenPanels.add(id);
    writeMode('hidden-panels',JSON.stringify([...hiddenPanels]));arrange();
  };
  document.addEventListener('pointerdown',event=>{
    for(const menu of document.querySelectorAll('.paint-menu[open]')){
      if(!menu.contains(event.target)&&!event.target.closest('.custom-select-menu'))menu.open=false;
    }
    const target=event.target;
    pointerView=target.matches('#viewport canvas[tabindex]')?target:
      uv.contains(target)&&!target.closest('button,input')?uv:null;
    pointerView?.focus({preventScroll:true});
  },true);
  for(const menu of document.querySelectorAll('.paint-menu')){
    const trigger=menu.querySelector('summary');
    menu.onclick=event=>{
      if(!menu.open||!event.target.closest('.paint-menu-content button:enabled,.paint-menu-content a'))return;
      if(menu.contains(document.activeElement))trigger.focus({preventScroll:true});
      menu.open=false;
    };
    menu.onkeydown=event=>{
      if(event.key!=='Escape'||!menu.open)return;
      event.preventDefault();menu.open=false;trigger.focus({preventScroll:true});
    };
  }
  views.addEventListener('focusout',event=>{if(event.target===pointerView)pointerView=null;});
  $('reset-docks').onclick=()=>{
    areas=structuredClone(defaults);weights={...defaultWeights};collapsed=false;focused=false;hiddenPanels.clear();
    for(const key of ['docks','shelf','hidden-panels'])writeMode(key,null);
    resets.forEach(reset=>reset());shelf();windowMenu.open=false;windowMenu.querySelector('summary').focus();
  };
  workspace.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&gesture){gesture=null;highlight(null);}
    if(docksAvailable&&event.key==='Tab'&&!event.shiftKey&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&event.target===pointerView){
      event.preventDefault();
      if(!event.repeat)toggleFocus();
    }
  });
  shelf();
  return {
    setWorkArea(next){
      if(next===workArea){arrange();return;}
      for(const {cancel} of [...updates,...panelUpdates])cancel();
      gesture=null;highlight(null);focused=false;
      workArea=next;
      docksAvailable=next!=='modeling';
      focusButton.hidden=!docksAvailable;
      if(docksAvailable){
        ({areas,weights,collapsed,hiddenPanels}=loadLayout());
        restoreRegions.forEach(restore=>restore());
        shelf();
      }else arrange();
    }
  };
}
