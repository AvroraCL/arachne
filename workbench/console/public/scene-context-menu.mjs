import {workspaceIcons} from './workspace-icons.mjs';
import {renamedObjects} from './scene-object-names.mjs';
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
export function createSceneContextMenu({host,project,ctx,renderState,changeRendered}){
  const menu=el('div','scene-context-menu');menu.popover='auto';menu.setAttribute('role','menu');menu.setAttribute('aria-label','物体操作');host.append(menu);
  let snapshot=null;
  const close=()=>{if(menu.matches(':popover-open'))menu.hidePopover();};
  function current(){const scene=project.scene;if(project.document?.id!==snapshot?.projectId||scene?.binding!==snapshot.binding||scene.dragging||snapshot.ids.some(id=>!scene.sceneItems.some(item=>item.id===id)))throw Error('物体目标已变化，请重新打开菜单');return scene;}
  function run(action){Promise.resolve().then(()=>{current();return action();}).catch(ctx.error).finally(close);}
  function position(x,y){const r=menu.getBoundingClientRect();menu.style.left=Math.max(6,Math.min(innerWidth-r.width-6,x))+'px';menu.style.top=Math.max(6,Math.min(innerHeight-r.height-6,y))+'px';}
  function rename(){
    const items=current().sceneItems.map(item=>({...item,sourceName:item.label,label:project.document.paint.objectNames?.[item.label]||item.label})),batch=snapshot.ids.length>1;
    menu.replaceChildren();menu.setAttribute('role','dialog');menu.setAttribute('aria-label',batch?'批量重命名':'重命名物体');
    const form=el('form','scene-rename-form'),title=el('strong','',batch?'批量重命名 · '+snapshot.ids.length+' 个物体':'重命名物体'),label=el('label','',batch?'名称模板':'名称'),input=el('input');
    input.type='text';input.maxLength=200;input.required=true;input.setAttribute('aria-label',batch?'名称模板':'物体名称');input.value=batch?'{name}':items.find(item=>item.id===snapshot.ids[0]).label;label.append(input);
    const hint=el('p','',batch?'用 {name} 保留原名称，{n} 插入序号。':'名称自动保存到工程。'),preview=el('output','scene-rename-preview'),actions=el('div','scene-rename-actions'),cancel=el('button','','取消'),save=el('button','',batch?'重命名全部':'重命名');cancel.type='button';cancel.onclick=close;save.type='submit';actions.append(cancel,save);form.append(title,label,hint,preview,actions);menu.append(form);
    function update(){try{const names=renamedObjects(items,snapshot.ids,input.value);preview.textContent=Object.values(names).slice(0,3).join('、');save.disabled=false;}catch(error){preview.textContent=error.message;save.disabled=true;}}
    input.oninput=update;form.onsubmit=event=>{event.preventDefault();const names=renamedObjects(items,snapshot.ids,input.value),origin={id:snapshot.projectId,revision:snapshot.revision};save.disabled=true;run(()=>project.commands([{op:'renameObjects',names}],origin));};update();position(snapshot.x,snapshot.y);input.focus();input.select();
  }
  function open(event,id=null,outlineIds=null){
    event.preventDefault();event.stopPropagation();close();const scene=project.scene;if(!scene||scene.dragging)return;
    const selected=outlineIds||scene.selectedIds,ids=id==null?[...selected]:selected.includes(id)?[...selected]:[id];
    if(outlineIds===null&&id!=null&&!scene.selectedIds.includes(id)&&scene.visibility.get(id)==='visible')scene.select(id,false);
    snapshot={ids,projectId:project.document.id,revision:project.document.revision,binding:scene.binding,x:event.clientX,y:event.clientY};
    menu.replaceChildren();menu.setAttribute('role','menu');menu.setAttribute('aria-label','物体操作');menu.append(el('div','scene-context-title',ids.length?'物体 · '+ids.length+' 已选':'大纲'));
    function item(label,icon,action,enabled=true,shortcut=''){const button=el('button');button.type='button';button.setAttribute('role','menuitem');button.setAttribute('aria-label',label);if(shortcut)button.setAttribute('aria-keyshortcuts',shortcut);button.disabled=!enabled;const glyph=el('span','scene-menu-icon');glyph.innerHTML=workspaceIcons[icon];button.append(glyph,el('span','scene-menu-label',label),el('kbd','',shortcut));button.onclick=()=>{if(action===rename){try{rename();}catch(error){ctx.error(error);close();}}else run(action);};menu.append(button);}
    item(ids.length>1?'批量重命名…':'重命名…','text',rename,!!ids.length,'F2');
    item('聚焦选中物体','focus',()=>current().frameObjects(ids),!!ids.length);
    menu.append(el('hr'));
    const visible=ids.filter(id=>scene.visibility.get(id)==='visible'),hidden=ids.filter(id=>scene.visibility.get(id)!=='visible');
    item('隐藏选中物体','hidden',()=>current().setVisibility(visible,false),visible.length>0);
    item('显示选中物体','eye',()=>current().setVisibility(hidden,true),hidden.length>0);
    item('显示全部物体','eye',()=>current().showAll(),scene.hasHidden);
    if(renderState&&changeRendered){
      const source=ids.map(id=>scene.sceneItems.find(entry=>entry.id===id)?.label).filter(Boolean);
      menu.append(el('hr'));
      const change=visible=>changeRendered(ids,visible,{id:snapshot.projectId,revision:snapshot.revision});
      item('从渲染排除','renderCameraOff',()=>change(false),source.some(name=>renderState(name)===true));
      item('加入渲染','renderCamera',()=>change(true),source.some(name=>renderState(name)===false));
    }
    menu.showPopover();position(event.clientX,event.clientY);menu.querySelector('button:enabled')?.focus();
  }
  menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}if(event.target.closest('input')||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...menu.querySelectorAll('button:enabled')],index=buttons.indexOf(document.activeElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();});
  return {open,dispose(){close();menu.remove();}};
}
