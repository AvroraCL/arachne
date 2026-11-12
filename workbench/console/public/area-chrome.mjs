import {workspaceIcons} from './workspace-icons.mjs';

const svg=content=>`<svg class="chrome-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
export const areaIcons={
  viewport:workspaceIcons.object,maximize:workspaceIcons.orthographic,image:workspaceIcons.image,uv:workspaceIcons.grid,renderResult:workspaceIcons.rendered,
  restore:svg('<path d="M3 8h5V3m9 9h-5v5M8 8 3 3m9 9 5 5"/>'),
  shader:svg('<circle cx="5" cy="5" r="2.2"/><circle cx="15" cy="10" r="2.2"/><circle cx="5" cy="15" r="2.2"/><path d="m7 6 6 3M7 14l6-3"/>'),
  collection:svg('<path d="M3 7h14v9H3ZM6 7V4h8v3M3 10h14M8 12h4"/>'),
  scene:svg('<rect x="2" y="3" width="4" height="4" rx=".7"/><path d="M8 5h9M4 7v8h4M4 11h4"/><rect x="8" y="9" width="4" height="4" rx=".7"/><path d="M14 11h3M10 15h7"/>'),
  properties:svg('<path d="M3 5h14M3 10h14M3 15h14"/><rect x="6" y="3" width="3" height="4" rx=".6" fill="#303030"/><rect x="12" y="8" width="3" height="4" rx=".6" fill="#303030"/><rect x="5" y="13" width="3" height="4" rx=".6" fill="#303030"/>'),
  layers:workspaceIcons.fillLayer,library:svg('<rect x="3" y="3" width="5" height="6" rx=".7"/><rect x="12" y="3" width="5" height="6" rx=".7"/><rect x="3" y="12" width="5" height="5" rx=".7"/><rect x="12" y="12" width="5" height="5" rx=".7"/>'),
  console:svg('<path d="m4 5 5 5-5 5M11 15h5"/>'),
  pause:svg('<path d="M7 5v10m6-10v10" stroke-width="2.5"/>'),
  play:svg('<path d="m7 4 9 6-9 6Z" fill="currentColor" stroke="none"/>'),
  renderSettings:svg('<rect x="2.5" y="5" width="15" height="11" rx="1.5"/><path d="M6 5 7 3.5h6L14 5"/><circle cx="10" cy="10.5" r="3"/>'),
  splitX:svg('<rect x="2.5" y="3" width="15" height="14" rx="1"/><path d="M10 3v14"/>'),
  splitY:svg('<rect x="2.5" y="3" width="15" height="14" rx="1"/><path d="M2.5 10h15"/>'),
  join:svg('<path d="M8 3H3v14h5M12 3h5v14h-5M7 10h6m-3-3 3 3-3 3"/>'),
  swap:svg('<path d="M3 6h14m-4-4 4 4-4 4M17 14H3m4-4-4 4 4 4"/>'),
  more:svg('<circle cx="4" cy="10" r=".8" fill="currentColor"/><circle cx="10" cy="10" r=".8" fill="currentColor"/><circle cx="16" cy="10" r=".8" fill="currentColor"/>')
};
areaIcons.imageLayers=workspaceIcons.image;areaIcons.imageProperties=areaIcons.properties;
export const areaCaptions={viewport:'三维视图',image:'图像',uv:'UV',renderResult:'渲染结果',shader:'节点',scene:'大纲',properties:'材质属性',layers:'材质图层',imageProperties:'图像属性',imageLayers:'图像图层',library:'资源',renderSettings:'属性',console:'控制台'};

export function headerControls(ctx,...nodes){
  for(const node of nodes){if(!node)continue;node.classList.add('area-header-controls');ctx.tools.append(node);}
}
export function chromeButton(button,icon,label){
  label??=button.getAttribute('aria-label')||button.textContent.trim();
  button.setAttribute('aria-label',label);button.title||=label;button.classList.add('area-icon-button');button.innerHTML=areaIcons[icon]||workspaceIcons[icon];return button;
}
// Keep the original nodes and handlers when adapting the existing complete editors.
export function leaseHeader(ctx,node){
  if(!node)return ()=>{};const parent=node.parentNode,next=node.nextSibling;headerControls(ctx,node);
  return ()=>{node.classList.remove('area-header-controls');parent.insertBefore(node,next?.parentNode===parent?next:null);};
}
const menuPositions=new WeakMap();
export function openChromeMenu(menu,point){
  const state=menuPositions.get(menu);if(!state)return;
  state.point=point;menu.open=true;state.focusOnOpen='first';
  if(state.content.matches(':popover-open'))state.position();
}
export function chromeMenu(menu,content){
  const summary=menu.querySelector('summary');
  content.popover='auto';
  const items=()=>[...content.querySelectorAll('button:enabled,a[href],input:enabled,select:enabled')].filter(item=>item.getClientRects().length);
  const focusEnd=last=>{const visible=items();visible.at(last?-1:0)?.focus();};
  const state={content,point:null,focusOnOpen:null,position(){
    const r=menu.getBoundingClientRect(),height=content.getBoundingClientRect().height;
    const x=state.point?.x??r.right-content.offsetWidth;
    content.style.left=Math.max(6,Math.min(innerWidth-content.offsetWidth-6,x))+'px';
    const y=state.point?.y;
    content.style.top=(y===undefined?(r.bottom+height+6<innerHeight?r.bottom+4:Math.max(6,r.top-height-4)):Math.max(6,Math.min(innerHeight-height-6,y)))+'px';
    if(state.focusOnOpen){focusEnd(state.focusOnOpen==='last');state.focusOnOpen=null;}
  }};menuPositions.set(menu,state);
  summary?.addEventListener('pointerdown',()=>{state.point=null;});
  summary?.addEventListener('keydown',event=>{
    if(!['ArrowDown','ArrowUp'].includes(event.key)||event.altKey||event.metaKey||event.ctrlKey)return;
    event.preventDefault();event.stopPropagation();
    if(content.matches(':popover-open'))focusEnd(event.key==='ArrowUp');
    else{state.focusOnOpen=event.key==='ArrowUp'?'last':'first';menu.open=true;}
  });
  content.addEventListener('keydown',event=>{
    if(event.defaultPrevented)return;
    if(event.key==='Escape'){
      event.preventDefault();event.stopPropagation();menu.open=false;
      if(content.matches(':popover-open'))content.hidePopover();
      summary?.focus({preventScroll:true});return;
    }
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||event.target.matches('input:not([type=checkbox]),select'))return;
    const visible=items();
    if(!visible.length)return;
    event.preventDefault();event.stopPropagation();
    const index=visible.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?visible.length-1:index<0?(event.key==='ArrowUp'?visible.length-1:0):(index+(event.key==='ArrowUp'?-1:1)+visible.length)%visible.length;
    visible[next].focus();
  });
  menu.addEventListener('toggle',()=>{
    if(!menu.open){if(content.matches(':popover-open'))content.hidePopover();return;}
    if(!content.matches(':popover-open'))content.showPopover();
    state.position();
  });
  content.addEventListener('beforetoggle',event=>{if(event.newState==='closed'){menu.open=false;state.point=null;state.focusOnOpen=null;}});
}
export function createContextActions(label,onError){
  const menu=document.createElement('div');menu.className='scene-context-menu';menu.popover='auto';menu.setAttribute('role','menu');menu.setAttribute('aria-label',label);document.body.append(menu);
  const close=()=>{if(menu.matches(':popover-open'))menu.hidePopover();};
  menu.onkeydown=event=>{
    if(!['Escape','ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();
    if(event.key==='Escape'){close();return;}
    const buttons=[...menu.querySelectorAll('button:enabled')],index=buttons.indexOf(document.activeElement);
    buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();
  };
  return {open(event,title,actions){
    close();menu.replaceChildren();const heading=document.createElement('div');heading.className='scene-context-title';heading.textContent=title;menu.append(heading);
    for(const item of actions){
      if(!item){menu.append(document.createElement('hr'));continue;}
      const button=document.createElement('button'),icon=document.createElement('span'),text=document.createElement('span'),shortcut=document.createElement('kbd');
      button.type='button';button.setAttribute('role','menuitem');button.setAttribute('aria-label',item.label);button.disabled=item.enabled===false;
      if(item.title)button.title=item.title;
      icon.className='scene-menu-icon';icon.innerHTML=workspaceIcons[item.icon]||areaIcons[item.icon]||'';text.className='scene-menu-label';text.textContent=item.label;shortcut.textContent=item.shortcut||'';shortcut.setAttribute('aria-hidden','true');button.append(icon,text,shortcut);
      button.onclick=()=>{close();Promise.resolve().then(item.run).catch(onError);};menu.append(button);
    }
    menu.showPopover();const {width,height}=menu.getBoundingClientRect();menu.style.left=Math.max(6,Math.min(innerWidth-width-6,event.clientX))+'px';menu.style.top=Math.max(6,Math.min(innerHeight-height-6,event.clientY))+'px';menu.querySelector('button:enabled')?.focus();
  },close,dispose(){close();menu.remove();}};
}
export function leaseLibraryHeader(ctx,panel){
  const bar=panel.querySelector('.library-bar'),actions=bar.querySelector('.library-actions'),original=[...actions.children];
  const menu=document.createElement('details');menu.className='area-toolbar-menu';
  const summary=document.createElement('summary');summary.setAttribute('aria-label','更多资源操作');summary.title='更多资源操作';summary.innerHTML=workspaceIcons.settings;
  const content=document.createElement('div');content.className='area-toolbar-menu-content';
  for(const b of original){
    if(['保存当前','复制','重命名','删除','工程输出'].includes(b.textContent.trim()))content.append(b);
    else if(b.getAttribute('aria-label')==='显示资源节点')chromeButton(b,'shader');
  }
  menu.append(summary,content);actions.append(menu);chromeMenu(menu,content);content.addEventListener('click',event=>{if(event.target.closest('button'))menu.open=false;});
  const restore=leaseHeader(ctx,bar);return ()=>{restore();actions.replaceChildren(...original);};
}
