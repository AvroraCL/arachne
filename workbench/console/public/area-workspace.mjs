import {editorNames,workspacePreset,validateLayout,leaves,findNode,replaceNode,area,split,splitArea,changeEditor,joinAreas,joinable,adjacentAreas,swapAreas,migrateLayerEditors,workspaceNames,workspaceLayoutFile,parseWorkspaceLayoutFile} from './workspace-state.mjs';
import {areaIcons,areaCaptions,chromeMenu,openChromeMenu} from './area-chrome.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {compositionKey} from './text-input.mjs';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
const directions={left:'左侧',right:'右侧',top:'上方',bottom:'下方'};
const splitExtent=(element,axis)=>axis==='x'?element.clientWidth:element.clientHeight;
const dividerLimit=extent=>Math.max(.05,Math.min(.42,110/Math.max(1,extent)));
const limitRatio=(ratio,limit)=>Math.max(limit,Math.min(1-limit,ratio));
const showDividerRatio=(element,handle,ratio)=>{
  element.style.setProperty('--area-ratio',ratio);
  handle.setAttribute('aria-valuenow',String(Math.round(ratio*100)));
};
function enableHeaderScrolling(tools){
  const overflow=()=>tools.scrollWidth>tools.clientWidth;
  const indicate=()=>{
    tools.toggleAttribute('data-more-left',tools.scrollLeft>1);
    tools.toggleAttribute('data-more-right',tools.scrollWidth-tools.clientWidth-tools.scrollLeft>1);
  };
  const resize=new ResizeObserver(indicate);resize.observe(tools);
  const changes=new MutationObserver(indicate);
  changes.observe(tools,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden']});
  tools.addEventListener('scroll',indicate,{passive:true});
  tools.addEventListener('focusin',event=>{
    if(!overflow())return;
    const item=event.target.getBoundingClientRect(),port=tools.getBoundingClientRect();
    if(item.left<port.left)tools.scrollLeft+=item.left-port.left-2;
    else if(item.right>port.right)tools.scrollLeft+=item.right-port.right+2;
    indicate();
  });
  tools.addEventListener('wheel',event=>{
    if(event.ctrlKey||Math.abs(event.deltaX)>=Math.abs(event.deltaY)||!overflow())return;
    const left=tools.scrollLeft;
    const unit=event.deltaMode===1?16:event.deltaMode===2?tools.clientWidth:1;
    tools.scrollLeft+=event.deltaY*unit;
    if(tools.scrollLeft!==left)event.preventDefault();
  },{passive:false});
  let pan=null;
  tools.addEventListener('pointerdown',event=>{
    if(pan||event.button!==1||!overflow())return;
    pan={pointer:event.pointerId,x:event.clientX,left:tools.scrollLeft};
    tools.setPointerCapture(event.pointerId);tools.dataset.headerPanning='';event.preventDefault();
  });
  tools.addEventListener('pointermove',event=>{
    if(pan?.pointer===event.pointerId)tools.scrollLeft=pan.left+pan.x-event.clientX;
  });
  function end(event){
    if(pan?.pointer!==event.pointerId)return;
    pan=null;delete tools.dataset.headerPanning;
    if(tools.hasPointerCapture(event.pointerId))tools.releasePointerCapture(event.pointerId);
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])tools.addEventListener(type,end);
  return ()=>{resize.disconnect();changes.disconnect();};
}
export function createAreaWorkspace({host,registry,project,initial='material',restoreActive=true,desktopWorkspace=null,canChange=()=>true,onActivate=()=>{},onWorkspace=()=>{},onVisibleEditors=()=>{},onSaveState=()=>{}}){
  const key='arachne-area-workspaces-v1',views=new Map(),layouts={};let name=initial,active=null,gesture=null,maximized=null,timer=null,disposed=false,hoverPoint=null,localSaveError=null;
  try{const saved=desktopWorkspace?.initial||JSON.parse(localStorage.getItem(key));if(restoreActive&&['modeling','material','drawing'].includes(saved?.activeWorkspace))name=saved.activeWorkspace;for(const mode of Object.keys(workspaceNames))if(saved?.[mode])layouts[mode]=saved.layerEditorVersion===2?validateLayout(saved[mode]):migrateLayerEditors(validateLayout(saved[mode]),mode);}catch{}
  for(const mode of Object.keys(workspaceNames))layouts[mode]??=workspacePreset(mode);
  const root=el('div','area-layout'),notice=el('output','area-notice');notice.setAttribute('role','status');host.append(root,notice);host.classList.add('modular-workspace');
  const recovery=el('div','area-layout-save'),saveMessage=el('output'),retry=el('button','','重试保存布局'),
    useSaved=el('button','','使用已保存布局'),replace=el('button','','覆盖保存布局');
  recovery.hidden=true;retry.type=useSaved.type=replace.type='button';saveMessage.setAttribute('role','alert');
  retry.onclick=()=>desktopWorkspace?desktopWorkspace.retry():flushLocal();
  replace.onclick=()=>{if(window.confirm('用当前窗口的布局替换另一个窗口已保存的布局？'))void desktopWorkspace?.retry({replace:true});};
  useSaved.onclick=()=>{
    if(canAdjust()&&window.confirm('使用另一窗口已保存的布局？本窗口未保存的布局调整会放弃。'))
      void desktopWorkspace?.useSaved(adoptSavedLayout);
  };
  recovery.append(saveMessage,retry,useSaved,replace);host.append(recovery);
  function capture(){for(const [id,v] of views){const area=findNode(layouts[name],id);if(area?.kind==='area')area.states[area.editor]=v.instance.getState?.()||area.states[area.editor]||{};}}
  function showSaveState(message,conflict=false){
    if(disposed)return;
    recovery.hidden=!message;
    if(message)saveMessage.textContent='布局未保存。 '+message;
    replace.hidden=useSaved.hidden=!conflict;
    onSaveState();
  }
  function writeLayouts(next){
    const serialized=JSON.stringify({...next,activeWorkspace:name,layerEditorVersion:2});
    desktopWorkspace?.save(serialized,showSaveState);
    try{
      localStorage.setItem(key,serialized);
      if(localSaveError){localSaveError=null;showSaveState('');}
    }catch(error){
      if(desktopWorkspace)return true;
      localSaveError=Error(error?.name==='QuotaExceededError'?'浏览器存储空间不足，请腾出空间后重试。':'浏览器暂时无法写入本机存储，请检查站点存储权限后重试。');
      showSaveState(localSaveError.message);
      return false;
    }
    return true;
  }
  function persist(){
    if(disposed)return false;
    capture();
    return writeLayouts(layouts);
  }
  function flushLocal(){clearTimeout(timer);timer=null;return persist();}
  function replaceLayouts(file){
    if(!canAdjust())throw Error('请完成当前编辑或保存，再更换工作区布局');
    const next=parseWorkspaceLayoutFile(file);
    capture();
    for(const [workspace,tree] of Object.entries(next)){
      for(const node of leaves(tree)){
        const previous=findNode(layouts[workspace],node.id);
        if(previous?.kind==='area'&&previous.editor===node.editor)node.states=previous.states;
      }
      validateLayout(tree);
    }
    writeLayouts(next);
    Object.assign(layouts,next);
    maximized=null;
    render();
    save();
  }
  function adoptSavedLayout(saved){
    if(!canAdjust())throw Error('请完成当前编辑或保存，再更换工作区布局');
    const next=Object.fromEntries(Object.keys(workspaceNames).map(mode=>[mode,validateLayout(saved[mode])]));
    const before=name;
    clearTimeout(timer);
    for(const id of [...views.keys()])disposeView(id);
    Object.assign(layouts,next);
    name=saved.activeWorkspace;maximized=null;active=null;
    render({preserveFocus:false});
    if(before!==name)onWorkspace(name);
  }
  function save(){clearTimeout(timer);timer=setTimeout(persist,160);}
  function stateChanged(){save();}
  function activate(id,event){
    const view=views.get(id);if(!view)return;
    active=id;for(const [key,v] of views)v.section.toggleAttribute('data-active-area',key===id);
    view.instance.activate?.(event);onActivate(view.instance,id);save();
  }
  function showError(error){notice.textContent=error?.message||String(error);}
  const canAdjust=()=>canChange()&&!gesture&&![...views.values()].some(v=>v.instance.isEditing?.());
  function mutate(fn){
    if(!canAdjust()){showError('请完成当前编辑或保存，再调整区域');return false;}
    try{capture();layouts[name]=fn(layouts[name]);maximized=null;render();save();return true;}catch(error){showError(error);return false;}
  }
  function moveEditor(id,target){
    if(mutate(tree=>swapAreas(tree,id,target)))activate(id);
  }
  function disposeView(id){const view=views.get(id);if(!view)return;view.stopHeader();view.instance.dispose();view.section.remove();views.delete(id);}
  function menuFor(id){
    const menu=el('details','area-menu'),summary=el('summary');summary.innerHTML=areaIcons.more;summary.title='区域操作';summary.setAttribute('aria-label','区域操作');
    const content=el('div','area-menu-content');
    function item(label,action,icon,group=content){const b=el('button');if(icon)b.innerHTML=areaIcons[icon];b.append(el('span','',label));b.type='button';b.onclick=()=>{menu.open=false;action();};group.append(b);return b;}
    item('左右分割',()=>mutate(tree=>splitArea(tree,id,'x')),'splitX');item('上下分割',()=>mutate(tree=>splitArea(tree,id,'y')),'splitY');
    const joins=el('div','area-neighbor-options'),swaps=el('div','area-neighbor-options');content.append(joins,swaps);
    let previewed=null;
    function previewTarget(section){
      if(previewed)delete previewed.dataset.areaMenuTarget;
      previewed=section;
      if(previewed)previewed.dataset.areaMenuTarget='';
    }
    function neighborItem(label,neighbor,action,icon,group){
      const view=views.get(neighbor.id),b=item(label,action,icon,group);
      b.title=editorNames[view?.type]||'';
      b.onpointerenter=b.onfocus=()=>previewTarget(view?.section);
      b.onpointerleave=b.onblur=()=>previewTarget(null);
    }
    menu.addEventListener('toggle',()=>{
      previewTarget(null);
      if(!menu.open)return;
      const layout=layouts[name];
      joins.replaceChildren();swaps.replaceChildren();
      if(maximized)return;
      for(const neighbor of joinable(layout,id)){
        neighborItem(`与${directions[neighbor.direction]}合并`,neighbor,()=>mutate(tree=>joinAreas(tree,id,neighbor.id)),'join',joins);
      }
      const neighbors=adjacentAreas(layout,id);
      for(const neighbor of neighbors){
        const direction=directions[neighbor.direction],type=editorNames[views.get(neighbor.id)?.type];
        const multiple=neighbors.some(other=>other!==neighbor&&other.direction===neighbor.direction);
        neighborItem(`与${direction}交换编辑器${multiple?' · '+type:''}`,neighbor,()=>moveEditor(id,neighbor.id),'swap',swaps);
      }
    });
    const maximizeItem=item('最大化区域',()=>maximize(id),'maximize'),shortcut=el('kbd','','Ctrl Space');shortcut.setAttribute('aria-hidden','true');maximizeItem.append(shortcut);
    menu.addEventListener('toggle',()=>{maximizeItem.hidden=maximized===id;});
    menu.append(summary,content);chromeMenu(menu,content);return menu;
  }
  function maximize(id){
    const view=views.get(id);
    if(!view||!canAdjust())return;
    const restoreFocused=document.activeElement===view.restore;
    active=id;maximized=maximized===id?null:id;render();
    if(maximized&&!view.section.contains(document.activeElement))view.restore.focus({preventScroll:true});
    if(!maximized&&restoreFocused)view.summary.focus({preventScroll:true});
  }
  function createView(area){
    const section=el('section','editor-area');section.dataset.areaId=area.id;section.dataset.editor=area.editor;section.setAttribute('aria-label',editorNames[area.editor]);
    const header=el('header','area-header'),select=el('select'),body=el('div','area-content');
    select.setAttribute('aria-label','编辑器类型');select.dataset.searchable='false';
    for(const [label,ids] of [['视图',['viewport','image','uv','renderResult']],['制作',['shader','layers','properties','imageLayers','imageProperties']],['工程',['scene','renderSettings','library','console']]]){const group=el('optgroup');group.label=label;for(const id of ids)group.append(new Option(editorNames[id],id));select.append(group);}select.value=area.editor;
    const actions=menuFor(area.id),title=el('span','area-local-title'),caption=el('span','area-caption',areaCaptions[area.editor]),tools=el('div','area-header-tools');
    const restore=el('button','area-restore');restore.type='button';restore.title='返回布局 · Ctrl Space';restore.hidden=true;
    restore.innerHTML=areaIcons.restore;restore.append(el('span','','返回布局'));restore.onclick=()=>maximize(area.id);
    header.append(select,caption,tools,title,restore,actions);section.append(header,body);
    const corner=el('button','area-corner');corner.type='button';corner.title='拖动分割 · Ctrl 拖动交换编辑器 · Esc 取消';corner.setAttribute('aria-label','拖动分割区域');section.append(corner);
    select.title=editorNames[area.editor]+' · 切换编辑器';
    enhanceSelectMenu(select,{menuClass:'editor-type-menu',optionIcon:option=>areaIcons[option.value],iconOnly:true});
    select.closest('.custom-select').classList.add('area-editor-picker');
    const stopHeader=enableHeaderScrolling(tools);
    const context={host:body,root:section,header,tools,title,maximize:()=>maximize(area.id),areaId:area.id,workspaceName:name,state:structuredClone(area.states[area.editor]||{}),project,onChange:stateChanged,
      activate:()=>activate(area.id),error:showError};
    const instance=registry.create(area.editor,context),view={section,select,body,instance,restore,stopHeader,summary:actions.querySelector('summary'),type:area.editor};views.set(area.id,view);
    select.onchange=()=>{if(!mutate(tree=>changeEditor(tree,area.id,select.value))){select.value=area.editor;syncSelectMenu(select);}};
    section.addEventListener('pointerdown',event=>{if(!event.target.closest('.area-menu,.area-corner'))activate(area.id,event);},true);
    section.addEventListener('focusin',()=>{if(active!==area.id)activate(area.id);});
    const ownsCorner=event=>gesture?.owner===corner&&gesture.pointer===event.pointerId;
    corner.onpointerdown=event=>{
      if(event.button||!canAdjust()||event.ctrlKey&&maximized)return;
      const common={id:area.id,pointer:event.pointerId,owner:corner};
      if(event.ctrlKey){
        gesture={...common,kind:'swap',target:null};
        section.dataset.areaSwap='source';
      }else{
        const rect=body.getBoundingClientRect(),preview=el('div','area-split-preview');body.append(preview);
        gesture={...common,kind:'split',start:{x:event.clientX,y:event.clientY},rect,preview,axis:null,ratio:.5};
      }
      corner.setPointerCapture(event.pointerId);event.preventDefault();
    };
    corner.onpointermove=event=>{
      if(!ownsCorner(event))return;
      const g=gesture;
      if(g.kind==='swap'){
        const hit=document.elementFromPoint(event.clientX,event.clientY)?.closest('.editor-area'),id=hit?.dataset.areaId;
        const target=id!==g.id&&views.get(id)?.section===hit?id:null;
        if(target===g.target)return;
        clearSwapTarget(g.target);g.target=target;
        if(target)hit.dataset.areaSwap='target';
        return;
      }
      const dx=g.start.x-event.clientX,dy=event.clientY-g.start.y;
      if(Math.hypot(dx,dy)<10)return;g.axis=Math.abs(dx)>Math.abs(dy)?'x':'y';g.ratio=Math.max(.1,Math.min(.9,g.axis==='x'?(event.clientX-g.rect.left)/g.rect.width:(event.clientY-g.rect.top)/g.rect.height));
      g.preview.dataset.axis=g.axis;g.preview.style.setProperty('--split-position',g.ratio*100+'%');
    };
    corner.onpointerup=event=>{
      if(!ownsCorner(event))return;
      const g=gesture;cancelGesture();
      if(g.kind==='swap'&&g.target)moveEditor(g.id,g.target);
      if(g.kind==='split'&&g.axis)mutate(tree=>splitArea(tree,area.id,g.axis,g.ratio));
    };
    corner.onpointercancel=corner.onlostpointercapture=event=>{if(ownsCorner(event))cancelGesture();};
    corner.oncontextmenu=event=>{
      if(gesture?.owner!==corner)return;
      event.preventDefault();event.stopPropagation();
      if(gesture.kind==='split')cancelGesture();
    };
    return view;
  }
  function divider(node,element){
    const handle=el('div','area-divider'),horizontal=node.axis==='x';
    handle.dataset.splitId=node.id;handle.dataset.axis=node.axis;handle.tabIndex=0;
    handle.setAttribute('role','separator');handle.setAttribute('aria-label',horizontal?'调整区域宽度':'调整区域高度');handle.setAttribute('aria-orientation',horizontal?'vertical':'horizontal');
    handle.setAttribute('aria-valuemin','5');handle.setAttribute('aria-valuemax','95');
    handle.title='拖动调整 · Ctrl 吸附 · Esc 取消';
    showDividerRatio(element,handle,node.ratio);
    const position=event=>horizontal?event.clientX:event.clientY;
    const owns=event=>gesture?.owner===handle&&gesture.pointer===event.pointerId;
    handle.onpointerdown=event=>{
      if(event.button||!canAdjust())return;
      const extent=splitExtent(element,node.axis);
      if(!extent)return;
      gesture={kind:'resize',pointer:event.pointerId,ratio:node.ratio,previewRatio:node.ratio,start:position(event),extent,owner:handle,element};
      handle.setPointerCapture(event.pointerId);handle.dataset.resizing='';document.body.dataset.areaResizing=node.axis;event.preventDefault();
    };
    handle.onpointermove=event=>{
      if(!owns(event))return;
      const g=gesture,offset=position(event)-g.start;
      if(!offset&&g.previewRatio===g.ratio)return;
      const raw=g.ratio+offset/g.extent;
      g.previewRatio=offset?limitRatio(event.ctrlKey?Math.round(raw*20)/20:raw,dividerLimit(g.extent)):g.ratio;
      showDividerRatio(element,handle,g.previewRatio);
    };
    handle.onpointerup=event=>{
      if(!owns(event))return;
      node.ratio=gesture.previewRatio;
      gesture=null;delete handle.dataset.resizing;delete document.body.dataset.areaResizing;
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      save();
    };
    handle.onpointercancel=handle.onlostpointercapture=event=>{if(owns(event))cancelGesture();};
    handle.onkeydown=event=>{
      const back=horizontal?'ArrowLeft':'ArrowUp',forward=horizontal?'ArrowRight':'ArrowDown',key=event.key;
      if(![back,forward,'Home'].includes(key)||event.metaKey||event.altKey)return;
      event.preventDefault();event.stopPropagation();
      if(!canAdjust()){showError('请完成当前编辑或保存，再调整区域');return;}
      const step=event.shiftKey?.005:.025;
      node.ratio=key==='Home'?.5:limitRatio(node.ratio+(key===back?-step:step),dividerLimit(splitExtent(element,node.axis)));
      showDividerRatio(element,handle,node.ratio);save();
    };
    handle.oncontextmenu=event=>{
      event.preventDefault();
      const edge=handle.getBoundingClientRect(),cross=horizontal?event.clientY:event.clientX;
      const bordering=leaves(node.first).map(({id})=>views.get(id)?.section).filter(Boolean).find(section=>{
        const r=section.getBoundingClientRect();
        return horizontal?Math.abs(r.right-edge.left)<1&&cross>=r.top&&cross<=r.bottom:Math.abs(r.bottom-edge.top)<1&&cross>=r.left&&cross<=r.right;
      });
      const menu=bordering?.querySelector('.area-menu');
      if(menu)openChromeMenu(menu,{x:event.clientX,y:event.clientY});
    };
    return handle;
  }
  function build(node){
    if(node.kind==='area')return views.get(node.id).section;
    const element=el('div','area-split');element.dataset.axis=node.axis;element.style.setProperty('--area-ratio',node.ratio);element.append(build(node.first),divider(node,element),build(node.second));return element;
  }
  function render({preserveFocus=true}={}){
    const focus=preserveFocus&&root.contains(document.activeElement)?document.activeElement:null;
    const wanted=leaves(layouts[name]);for(const [id,v] of [...views])if(!wanted.some(a=>a.id===id&&a.editor===v.type))disposeView(id);
    for(const area of wanted)if(!views.has(area.id))createView(area);
    // Move existing area elements; editor DOM and view instances survive tree edits.
    const newRoot=maximized?views.get(maximized)?.section:build(layouts[name]);
    if(maximized){
      // Keep suspended editors connected: shared controls still address their DOM.
      const suspended=el('div');suspended.hidden=true;suspended.inert=true;
      for(const [id,v] of views)if(id!==maximized)suspended.append(v.section);
      root.replaceChildren(newRoot,suspended);
    }else root.replaceChildren(newRoot);
    host.dataset.workspace=name;root.toggleAttribute('data-maximized',!!maximized);
    const visibleEditors=[];
    for(const [id,v] of views){
      const visible=!maximized||id===maximized;
      v.restore.hidden=id!==maximized;
      v.instance.setVisible?.(visible);
      if(visible)visibleEditors.push(v.instance);
    }
    onVisibleEditors(visibleEditors);
    if(!active||!views.has(active))active=wanted[0]?.id;
    for(const [id,v] of views)v.section.toggleAttribute('data-active-area',id===active);
    if(focus?.isConnected&&!focus.closest('[hidden],[inert],[popover]:not(:popover-open)'))focus.focus({preventScroll:true});
    queueMicrotask(()=>{if(!disposed&&views.has(active))activate(active);});
  }
  function clearSwapTarget(id){
    const section=views.get(id)?.section;
    if(section)delete section.dataset.areaSwap;
  }
  function cancelGesture(){
    const g=gesture;if(!g)return;gesture=null;delete document.body.dataset.areaResizing;
    if(g.kind==='resize'){delete g.owner.dataset.resizing;showDividerRatio(g.element,g.owner,g.ratio);}
    else if(g.kind==='swap'){clearSwapTarget(g.id);clearSwapTarget(g.target);}
    else g.preview.remove();
    if(g.owner.hasPointerCapture(g.pointer))g.owner.releasePointerCapture(g.pointer);
  }
  const abort=new AbortController(),signal=abort.signal;
  host.addEventListener('pointermove',event=>{hoverPoint=[event.clientX,event.clientY];},{capture:true,signal});
  host.addEventListener('pointerleave',()=>{hoverPoint=null;},{signal});
  window.addEventListener('keydown',event=>{
    if(compositionKey(event))return;
    if(event.key==='Escape'&&gesture){event.preventDefault();event.stopPropagation();cancelGesture();return;}
    if(event.code!=='Space'||!event.ctrlKey||event.altKey||event.metaKey||event.shiftKey)return;
    if(event.target.closest?.('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open],.custom-select-menu,:popover-open:not(.paint-tooltip)'))return;
    const hovered=hoverPoint&&document.elementFromPoint(...hoverPoint)?.closest('.editor-area')?.dataset.areaId;
    const focused=event.target.closest?.('.editor-area')?.dataset.areaId;
    const target=maximized||hovered||focused||active;
    if(!views.has(target)||!canAdjust())return;
    event.preventDefault();event.stopPropagation();if(!event.repeat)maximize(target);
  },{capture:true,signal});
  window.addEventListener('blur',cancelGesture,{signal});window.addEventListener('pagehide',persist,{signal});
  host.addEventListener('contextmenu',event=>{if(event.target.closest('.area-header')){event.preventDefault();openChromeMenu(event.target.closest('.editor-area').querySelector('.area-menu'),{x:event.clientX,y:event.clientY});}},{signal});
  render();
  return {
    sync(){for(const view of views.values())view.instance.sync?.();},
    switchWorkspace(next){if(!Object.hasOwn(layouts,next)||next===name)return true;if(!canChange()||[...views.values()].some(v=>v.instance.isEditing?.()))return false;cancelGesture();persist();for(const id of [...views.keys()])disposeView(id);name=next;active=null;maximized=null;render();onWorkspace(next);save();return true;},
    openEditor(type,{placement}={}){
      const existing=[...views].find(([,view])=>view.type===type);
      if(existing){
        const [id,view]=existing;
        if(maximized&&maximized!==id){
          if(!canAdjust())return;
          maximized=null;active=id;render({preserveFocus:false});
        }else activate(id);
        view.summary.focus({preventScroll:true});
        return;
      }
      const target=leaves(layouts[name]).find(a=>['viewport','image','uv'].includes(a.editor))||leaves(layouts[name])[0],id=crypto.randomUUID();
      const changed=mutate(tree=>{
        if(placement==='sidebar'&&tree.kind==='split'&&tree.axis==='x'){
          const side=tree.second;return validateLayout(replaceNode(tree,side.id,split('y',side,area(type,id),.62)));
        }
        return changeEditor(splitArea(tree,target.id,'y',.62,id),id,type);
      });
      if(changed)activate(id);
    },
    reset(){mutate(()=>workspacePreset(name));},
    exportLayouts:()=>workspaceLayoutFile(layouts),replaceLayouts,
    save:flushLocal,get layoutSaveError(){return localSaveError;},getState(){capture();return {workspace:name,tree:structuredClone(layouts[name]),active};},
    editors:()=>[...views.values()].map(v=>v.instance),
    editorFor(element){
      const section=element?.closest?.('.editor-area'),view=views.get(section?.dataset.areaId);
      return view&&view.section===section&&!section.closest('[inert]')?view.instance:undefined;
    },
    get active(){return views.get(active)?.instance;},get name(){return name;},
    dispose(){if(disposed)return;persist();disposed=true;abort.abort();cancelGesture();clearTimeout(timer);for(const id of [...views.keys()])disposeView(id);root.remove();notice.remove();recovery.remove();}
  };
}
