import {headerControls} from './area-chrome.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {layerLockOwner,layerParent,materialLayerRows} from './paint-layer-tree.mjs';
import {workspaceIcons} from './workspace-icons.mjs';

function element(tag,className,text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text)node.textContent=text;
  return node;
}

function action(text,handler,className){
  const control=element('button',className,text);
  control.type='button';
  control.onclick=handler;
  return control;
}

export function createMaterialLayerEditor(ctx,bridge){
  const {host,project,state}=ctx;
  const tools=element('div','editor-toolbar editor-material-layer-tools');
  const body=element('div','editor-scroll editor-list editor-material-tree');
  const status=element('output','editor-message');
  const search=element('input');
  search.type='search';
  search.placeholder='搜索';
  search.setAttribute('aria-label','搜索图层');
  search.value=state.query||'';
  const add=element('select');
  add.setAttribute('aria-label','新建材质图层');
  add.title='新建材质图层';
  for(const [value,label] of [['','＋'],['paint','材质绘制层'],['fill','填充层'],['group','文件夹']]){
    add.append(new Option(label,value));
  }
  add.options[0].hidden=true;
  tools.append(search,add);
  host.append(body,status);
  headerControls(ctx,tools);
  enhanceSelectMenu(add);

  const collapsedByProject=new Map(Object.entries(state.collapsedByProject||{}).slice(-12)
    .filter(([,ids])=>Array.isArray(ids)).map(([id,ids])=>[id,new Set(ids)]));
  const views=new Map();
  const base=action('全 UV 底层',()=>project.selectLayer(null),'editor-layer-base');
  const empty=element('p','document-muted','没有匹配的图层');
  body.append(empty,base);
  let activeProject,structureKey='',selectionKey='',visibleRows=[],rename=null,disposed=false,selectionGeneration=0;

  function execute(operations,origin=project.origin()){
    return project.commands(operations,origin).catch(error=>{
      status.textContent=error.message;
      ctx.error(error);
      return false;
    });
  }
  function changed(){
    structureKey='';
    sync();
    ctx.onChange();
  }
  search.oninput=changed;
  search.onkeydown=event=>{
    if(event.key!=='Escape'||!search.value)return;
    event.preventDefault();
    event.stopPropagation();
    search.value='';
    changed();
  };
  add.onchange=()=>{
    const kind=add.value;
    add.value='';
    syncSelectMenu(add);
    if(kind&&!bridge.busy()&&bridge.canAddMaterialLayer())void createLayer(kind);
  };
  async function createLayer(kind){
    status.textContent='';
    const origin=project.origin(),generation=selectionGeneration;
    const operation=bridge.materialLayerOperation(kind);
    const existing=new Set(project.document.paint.layers.map(layer=>layer.id));
    const result=await execute([operation],origin);
    if(disposed||!result||project.document?.id!==origin.id)return;
    const created=result.paint.layers.find(layer=>!existing.has(layer.id));
    if(!created||!project.document.paint.layers.some(layer=>layer.id===created.id))return;
    if(generation!==selectionGeneration){status.textContent='已新建材质图层，保留当前选择';return;}
    if(collapsedByProject.get(activeProject).delete(operation.parentId))changed();
    project.selectLayer(created.id);
  }
  function finishRename(save,restoreFocus=false){
    const edit=rename;
    if(!edit)return;
    rename=null;
    const {view,input,original,origin}=edit,name=input.value.trim();
    input.remove();
    view.label.hidden=false;
    if(restoreFocus&&view.row.isConnected)view.label.focus({preventScroll:true});
    if(save&&name&&name!==original&&project.document?.id===origin.id){
      void execute([{op:'update',id:view.layer.id,patch:{name}}],origin);
    }
  }
  function beginRename(id){
    const view=views.get(id),doc=project.document;
    if(!view||rename||!doc||bridge.busy()||layerLockOwner(doc.paint.layers,view.layer))return false;
    const input=element('input','layer-inline-name');
    input.value=view.layer.name;
    input.maxLength=100;
    input.setAttribute('aria-label','材质图层名称');
    rename={view,input,original:view.layer.name,origin:project.origin()};
    view.label.after(input);
    view.label.hidden=true;
    input.onblur=()=>finishRename(true);
    input.onkeydown=event=>{
      if(event.isComposing||!['Enter','Escape'].includes(event.key))return;
      event.preventDefault();
      event.stopPropagation();
      finishRename(event.key==='Enter',true);
    };
    input.focus();
    input.select();
    return true;
  }
  body.oncontextmenu=event=>{
    const id=event.target.closest('[data-material-layer-id]')?.dataset.materialLayerId;
    if(id)bridge.openMaterialLayerMenu?.(event,id,beginRename);
  };
  body.onkeydown=event=>{
    if(event.key==='F2'&&!event.target.closest('input')&&(bridge.layerSelection?.().length??1)===1&&beginRename(project.layerId)){
      event.preventDefault();
      event.stopPropagation();
    }
  };

  function makeRow(id){
    const row=element('div','editor-layer-row'),indent=element('span','material-tree-indent');
    const view={row,indent,layer:null};
    const eye=action('',event=>{
      if(event.altKey){bridge.toggleMaterialIsolation(id);return;}
      bridge.clearLayerIsolation();
      void execute([{op:'update',id,patch:{visible:!view.layer.visible}}]);
    },'editor-visibility');
    const fold=action('',()=>{
      const collapsed=collapsedByProject.get(activeProject);
      if(!collapsed.delete(id))collapsed.add(id);
      changed();
    },'material-tree-fold');
    fold.innerHTML=workspaceIcons.chevron;
    const spacer=element('span','material-tree-fold-space');
    const icon=element('span','material-tree-icon'),name=element('span','material-tree-name');
    const label=action('',event=>{
      if(bridge.selectMaterialLayer)bridge.selectMaterialLayer(id,event);
      else project.selectLayer(id);
    },'editor-layer-name');
    label.append(icon,name);
    label.ondblclick=()=>beginRename(id);
    const lock=element('span','material-tree-lock');
    lock.innerHTML=workspaceIcons.lock;
    lock.setAttribute('role','img');
    row.dataset.materialLayerId=id;
    row.append(eye,indent,fold,spacer,label,lock);
    bridge.bindMaterialLayerDrag?.(label,row,id,folderId=>{
      if(collapsedByProject.get(activeProject).delete(folderId))changed();
    });
    return Object.assign(view,{eye,fold,spacer,icon,name,label,lock});
  }
  function updateRow(view,entry,filtering){
    const {layer,depth,open,visible,lockOwner}=entry;
    const {row,fold,spacer,eye,lock,name,icon}=view;
    view.layer=layer;
    row.style.setProperty('--material-depth',depth);
    row.toggleAttribute('data-inherited-hidden',layer.visible&&!visible);
    row.dataset.materialDepth=String(depth);
    fold.hidden=layer.kind!=='group'||filtering;
    spacer.hidden=!fold.hidden;
    spacer.toggleAttribute('data-open',layer.kind==='group'&&filtering);
    if(spacer.hasAttribute('data-open')&&!spacer.firstChild)spacer.innerHTML=workspaceIcons.chevron;
    else if(!spacer.hasAttribute('data-open')&&spacer.firstChild)spacer.replaceChildren();
    fold.setAttribute('aria-expanded',String(open));
    fold.title=(open?'折叠 ':'展开 ')+layer.name;
    fold.setAttribute('aria-label',fold.title);
    const visibility=visible?'eye':'hidden';
    if(eye.dataset.icon!==visibility){eye.dataset.icon=visibility;eye.innerHTML=workspaceIcons[visibility];}
    eye.title=(layer.visible&&!visible?'上级文件夹已隐藏 · '+layer.name:(layer.visible?'隐藏 ':'显示 ')+layer.name)+' · Option 点击独显';
    eye.setAttribute('aria-label',(layer.visible?'隐藏 ':'显示 ')+layer.name);
    lock.hidden=!lockOwner;
    view.locked=!!lockOwner;
    if(lockOwner){lock.title=lockOwner.id===layer.id?'已锁定':'由「'+lockOwner.name+'」锁定';lock.setAttribute('aria-label',lock.title);}
    if(name.textContent!==layer.name)name.textContent=layer.name;
    const kind=layer.kind==='group'?'folder':layer.kind==='paint'?'brush':layer.kind==='decal'?'image':layer.materialId?'material':'fillLayer';
    if(icon.dataset.icon!==kind){icon.dataset.icon=kind;icon.innerHTML=workspaceIcons[kind];}
  }
  function syncRows(doc,collapsed,filtering){
    const nextRows=materialLayerRows(doc.paint.layers,{query:search.value,collapsed});
    const visibleIds=new Set(nextRows.map(({layer})=>layer.id));
    for(const [id,view] of views){
      if(visibleIds.has(id))continue;
      if(rename?.view===view)finishRename(false);
      view.row.remove();
      views.delete(id);
    }
    let cursor=body.firstChild;
    for(const entry of nextRows){
      const {id}=entry.layer;
      if(!views.has(id))views.set(id,makeRow(id));
      const view=views.get(id);
      if(view.row!==cursor)body.insertBefore(view.row,cursor);
      cursor=view.row.nextSibling;
      updateRow(view,entry,filtering);
    }
    visibleRows=nextRows;
    empty.hidden=!filtering||nextRows.length!==0;
  }
  function sync(){
    const doc=project.document;
    if(disposed||!doc)return;
    if(activeProject!==doc.id){
      finishRename(false);
      for(const view of views.values())view.row.remove();
      views.clear();
      activeProject=doc.id;
      if(!collapsedByProject.has(doc.id))collapsedByProject.set(doc.id,new Set());
      structureKey='';
    }
    const collapsed=collapsedByProject.get(doc.id),filtering=!!search.value.trim();
    const structure=JSON.stringify([doc.revision,search.value,[...collapsed]]);
    const rebuilt=structure!==structureKey;
    if(rebuilt){structureKey=structure;syncRows(doc,collapsed,filtering);}
    const active=project.layerId,selected=new Set(bridge.layerSelection?.()||[active]),busy=bridge.busy();
    const {inspection}=bridge.materialPreview(),isolated=inspection?.kind==='layer'?inspection.id:null;
    const nextSelection=JSON.stringify([active,[...selected],busy,isolated]);
    if(!rebuilt&&nextSelection===selectionKey)return;
    selectionKey=nextSelection;
    add.disabled=busy||!bridge.canAddMaterialLayer();
    syncSelectMenu(add);
    base.setAttribute('aria-pressed',String(active==null));
    const selectedAncestors=new Set();
    const byId=new Map(doc.paint.layers.map(layer=>[layer.id,layer]));
    for(const id of selected){
      for(let layer=byId.get(id);layer&&layerParent(layer);layer=byId.get(layerParent(layer))){
        selectedAncestors.add(layerParent(layer));
      }
    }
    function isolatedBranch(layer){
      for(let item=layer;item;item=byId.get(layerParent(item)))if(item.id===isolated)return true;
      return false;
    }
    for(const {layer,open} of visibleRows){
      const {row,label,eye,locked}=views.get(layer.id),current=layer.id===active;
      label.setAttribute('aria-pressed',String(selected.has(layer.id)));
      if(current)label.setAttribute('aria-current','true');
      else label.removeAttribute('aria-current');
      row.toggleAttribute('data-active-layer',current);
      row.toggleAttribute('data-folded-selection',!open&&selectedAncestors.has(layer.id));
      row.toggleAttribute('data-isolated-layer',layer.id===isolated);
      row.toggleAttribute('data-isolated-away',!!isolated&&!isolatedBranch(layer));
      eye.disabled=busy;
      label.draggable=!busy&&!locked;
    }
    ctx.title.textContent=doc.name;
  }
  const unsubscribe=project.subscribe(event=>{
    if(event.kind==='selection')selectionGeneration++;
    sync();
  });
  sync();
  if(state.scroll)queueMicrotask(()=>{if(!disposed)body.scrollTop=state.scroll;});
  return {
    kind:'layers',sync,isEditing:()=>!!rename,
    getState:()=>({query:search.value,scroll:body.scrollTop,collapsedByProject:Object.fromEntries(
      [...collapsedByProject].filter(([,ids])=>ids.size).slice(-12).map(([id,ids])=>[id,[...ids]])
    )}),
    dispose(){disposed=true;unsubscribe();finishRename(false);}
  };
}
