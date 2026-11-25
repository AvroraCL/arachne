import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {workspaceIcons} from './workspace-icons.mjs';

const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};

function row(parent,label,control){const item=el('label','render-settings-row');item.dataset.search=label;item.append(el('span','',label),control);parent.append(item);return control;}

// Both the object inspector and the viewport pick edit the same GLB material.
export function createSourceMaterialFields(sourceControls,project,readTarget,error,beginSourcePreview,viewAsset){
  sourceControls.classList.add('source-material-fields');
  sourceControls.tabIndex=-1;
  sourceControls.setAttribute('role','group');
  sourceControls.setAttribute('aria-label','原模型材质参数');
  const setHint=el('p','object-property-hint','颜色、金属度与粗糙度由「材质图层 → 纹理集」控制。');
  setHint.hidden=true;sourceControls.append(setHint);
  const users=el('details','source-material-users'),count=el('summary'),names=el('ul');
  users.hidden=true;users.append(count,names);sourceControls.append(users);
  const inputs={},labels={};
  for(const [key,title,channel] of [['color','底色','RGB'],['metallic','金属度','B'],['roughness','粗糙度','G'],['transmission','透射','R']]){
    const input=el('input');input.type=key==='color'?'color':'number';
    if(key!=='color'){input.min='0';input.max='1';input.step='any';}
    input.setAttribute('aria-label','模型材质'+title);
    if(key==='color'){
      input.beginColorPreview=close=>{
        const target=readTarget();
        if(pending||!sameTarget(target,shown)||target.locked)return;
        scrub={target,revision:project.document.revision,preview:beginSourcePreview(target.name),close};
        return value=>{
          if(value===null)endScrub();
          else if(currentScrub(readTarget()))scrub.preview({color:value});
        };
      };
    }else{
      input.addEventListener('input',()=>{
        if(!input.closest('.workspace-range-field[data-dragging]'))return;
        const target=readTarget();
        if(pending||!sameTarget(target,shown)||target.locked)return;
        scrub??={target,revision:project.document.revision,preview:beginSourcePreview(target.name)};
        if(currentScrub(target))scrub.preview({[key]:input.valueAsNumber});
      });
      input.addEventListener('workspace-range-cancel',()=>{endScrub();sync(true);});
    }
    input.addEventListener('change',()=>save({[key]:key==='color'?input.value:input.valueAsNumber}));
    inputs[key]=row(sourceControls,title,input);
    const item=input.parentElement,caption=item.firstElementChild,detail=el('small','source-texture-channel');
    labels[key]={title,channel,item,caption,detail};
  }
  const restore=el('button','','恢复材质参数'),materialMessage=el('output','editor-message');
  const markButton=row(sourceControls,'投影标记',el('button','source-mark-preview')),markName=el('span');
  markButton.type='button';markButton.innerHTML=workspaceIcons.image;markButton.append(markName);
  markButton.onclick=()=>{
    const target=readTarget(),id=project.document?.paint.sourceMaterials?.[target?.name]?.mark?.image;
    if(id&&sameTarget(target,shown))viewAsset(id,markButton,[id]);
  };
  const removeMark=el('button','','移除标记');removeMark.type='button';removeMark.onclick=()=>save({mark:null});
  sourceControls.append(removeMark);
  restore.type='button';restore.title='恢复模型原始材质参数';
  restore.onclick=()=>save(Object.fromEntries(Object.keys(inputs).filter(key=>shown?.[key]!==undefined).map(key=>[key,null])));sourceControls.append(restore,materialMessage);
  let shown=null,pending=false,scrub=null,aliases;
  function listUsers(){
    names.replaceChildren(...(shown?.users||[]).map(name=>el('li','',aliases?.[name]||name)));
  }
  users.ontoggle=()=>{if(users.open)listUsers();};
  function currentScrub(target){return sameTarget(target,scrub?.target)&&project.document?.revision===scrub.revision;}
  function endScrub(){scrub?.preview(null);scrub=null;}
  function sameTarget(a,b){
    return !!a&&!!b&&a.projectId===b.projectId&&a.binding===b.binding&&a.name===b.name;
  }
  function sync(force=false){
    const target=readTarget(),changed=!sameTarget(target,shown);
    if(scrub&&!currentScrub(target)){
      if(scrub.close)scrub.close();else scrub.preview(null);
    }
    if(changed)materialMessage.textContent='';
    shown=target;
    const nextAliases=project.document?.paint.objectNames;
    if(changed||aliases!==nextAliases){
      aliases=nextAliases;
      if(changed)users.open=false;
      const total=target?.users?.length||0;
      users.hidden=total<2;
      if(!users.hidden)count.textContent=total+' 个物体共用此材质';
      if(users.open)listUsers();
    }
    const patch=project.document?.paint.sourceMaterials?.[target?.name];
    const hasSet=Object.hasOwn(project.document?.paint.textureSets??{},target?.name);
    setHint.hidden=!hasSet;
    const locked=pending||!target||target.locked;
    for(const [key,input] of Object.entries(inputs)){
      if(changed){
        const {title,channel,item,caption,detail}=labels[key],map=target?.maps?.[key];
        item.hidden=key==='transmission'&&target?.transmission===undefined;
        caption.textContent=title;
        if(map){
          detail.replaceChildren('× ',el('span','',map),'.'+channel);
          detail.title=map+' 的 '+channel+' 通道 × '+title+'系数';
          caption.append(detail);
          input.setAttribute('aria-description',detail.title);
        }else input.removeAttribute('aria-description');
        item.dataset.search=map?detail.title:title;
      }
      if(target?.[key]!==undefined&&(force||changed||document.activeElement!==input))input.value=patch?.[key]??target[key];
      input.disabled=!!locked||target?.[key]===undefined||hasSet&&key!=='transmission';
    }
    markButton.parentElement.hidden=removeMark.hidden=!patch?.mark;
    markName.textContent=project.document?.paint.assets[patch?.mark?.image]?.name||'';
    markButton.title='查看原图 · '+markName.textContent;
    removeMark.disabled=!!locked;restore.disabled=!!locked||hasSet||!Object.keys(inputs).some(key=>patch?.[key]!==undefined);
  }
  async function save(patch){
    if(pending)return;
    const target=readTarget(),origin=project.origin();
    if(!sameTarget(target,shown)||target.locked||target.projectId!==origin?.id||(scrub&&!currentScrub(target))){
      endScrub();sync(true);error(Error('材质目标已变化，请重新选择'));return;
    }
    pending=true;
    // Disabling the edited control otherwise sends focus outside the workspace
    // and the very next undo shortcut never reaches the project history.
    if(sourceControls.contains(document.activeElement))sourceControls.focus({preventScroll:true});
    sync();materialMessage.textContent='正在保存…';
    try{await project.commands([{op:'sourceMaterial',name:target.name,patch}],origin);materialMessage.textContent='';}
    catch(failure){materialMessage.textContent=failure.message;error(failure);}
    finally{endScrub();pending=false;sync(true);}
  }
  return {sync,dispose:endScrub};
}

// Object edits use the same modeler and project revision as the 3D viewport.
export function createObjectPropertyEditor({host,project,state={},onChange,error,beginSourcePreview,viewAsset,getTarget,getPaintSelection,openPaintLayers}){
  const root=el('div','object-property-editor'),info=el('details','render-settings-section');root.tabIndex=-1;info.open=true;
  info.append(el('summary','','物体'));const infoBody=el('div','render-settings-body');info.append(infoBody);
  const name=el('span','render-settings-readout'),position=el('span','object-position');
  row(infoBody,'名称',name);row(infoBody,'世界位置',position);
  const transform=el('details','render-settings-section');transform.open=state.transformOpen!==false;
  transform.addEventListener('toggle',()=>onChange());transform.append(el('summary','','变换增量'));
  const body=el('form','render-settings-body');transform.append(body);
  const tool=el('select'),space=el('select');tool.setAttribute('aria-label','物体变换类型');space.setAttribute('aria-label','物体变换坐标系');
  for(const [value,label] of [['translate','移动'],['rotate','旋转'],['scale','缩放']])tool.append(new Option(label,value));
  for(const [value,label] of [['global','全局'],['local','局部']])space.append(new Option(label,value));
  tool.value=['translate','rotate','scale'].includes(state.tool)?state.tool:'translate';space.value=state.space==='local'?'local':'global';
  row(body,'类型',tool);row(body,'坐标系',space);
  const fields=[];for(const axis of ['X','Y','Z']){
    const input=el('input');input.type='number';input.step='any';input.dataset.scrubNumber='';input.dataset.scrubSpeed='.01';input.setAttribute('aria-label','物体变换 '+axis);fields.push(input);row(body,axis,input);
  }
  function reset(){for(const input of fields){input.value=tool.value==='scale'?'1':'0';input.dispatchEvent(new Event('range-ui'));}}
  tool.addEventListener('change',()=>{reset();onChange();});space.addEventListener('change',onChange);reset();
  const apply=el('button','','应用变换'),hint=el('p','object-property-hint','输入相对变换；修改会保存到工程。'),message=el('output','editor-message');
  apply.type='submit';body.append(apply,hint,message);root.append(info,transform);host.append(root);enhanceSelectMenu(tool);enhanceSelectMenu(space);
  const surface=el('details','render-settings-section'),surfaceBody=el('div','render-settings-body');
  const surfaceTitle=el('summary','','表面材质');
  surface.open=true;surface.append(surfaceTitle,surfaceBody);root.insertBefore(surface,transform);
  const slot=el('select');slot.setAttribute('aria-label','物体材质槽');row(surfaceBody,'材质',slot);
  const singleSlot=row(surfaceBody,'材质',el('span','render-settings-readout'));
  const paintControls=el('div'),sourceControls=el('div');
  const paintLayer=row(paintControls,'当前图层',el('span','render-settings-readout'));
  const editLayer=el('button','','查看图层属性');editLayer.type='button';editLayer.onclick=openPaintLayers;
  paintControls.append(editLayer);surfaceBody.append(paintControls,sourceControls);
  let targetKey='',pending=false,lastStatus=null;
  slot.addEventListener('change',()=>{
    const target=getTarget(),scene=project.scene;
    if(target&&scene&&target.projectId===project.document?.id&&target.binding===scene.binding)scene.setMaterialSlot(target.id,slot.value);
  });
  const sourceEditor=createSourceMaterialFields(sourceControls,project,()=>{
    const target=getTarget(),scene=project.scene;
    if(!target||target.projectId!==project.document?.id||target.binding!==scene?.binding)return null;
    const base=scene.inspectObject(target.id)?.materials.find(item=>item.name===slot.value&&!item.painted);
    return base&&{...base,projectId:target.projectId,binding:target.binding,locked:scene.dragging||scene.mode!=='object'};
  },error,beginSourcePreview,viewAsset);
  body.addEventListener('submit',event=>{
    event.preventDefault();if(pending)return;
    const target=getTarget(),origin=project.document,scene=project.scene,values=fields.map(input=>input.valueAsNumber);
    if(!target||target.projectId!==origin?.id||target.binding!==scene?.binding||!scene.inspectObject?.(target.id)){error(Error('物体目标已变化，请重新选择'));return;}
    const restoreFocus=root.contains(document.activeElement);pending=true;apply.disabled=true;message.textContent='正在保存…';
    Promise.resolve().then(()=>scene.transformObject(target.id,tool.value,values,space.value)).then(()=>{
      message.textContent='';reset();
      if(restoreFocus&&!root.closest('[hidden]')&&(document.activeElement===document.body||root.contains(document.activeElement)))root.focus({preventScroll:true});
    }).catch(failure=>{message.textContent=failure.message;error(failure);}).finally(()=>{pending=false;refresh();});
  });
  function refresh(status){
    if(status!==undefined)lastStatus=status;
    const target=getTarget(),key=JSON.stringify(target),scene=project.scene;
    const targetChanged=key!==targetKey;
    if(targetChanged){targetKey=key;reset();message.textContent='';}
    const current=lastStatus?.info||null;name.textContent=current?.label||'—';
    position.textContent=current?current.position.map((value,index)=>'XYZ'[index]+' '+Number(value.toFixed(4))).join('  '):'—';
    const slots=current?.materials||[];
    surface.hidden=!slots.length;
    if(slots.length){
      const names=slots.map(item=>item.name);
      if(JSON.stringify(names)!==JSON.stringify([...slot.options].map(option=>option.value))){
        const previous=slot.value;slot.replaceChildren(...names.map(name=>new Option(name,name)));
        if(names.includes(previous))slot.value=previous;
      }
      if(current.materialSlot)slot.value=current.materialSlot;
      else if(targetChanged)slot.selectedIndex=0;
      const base=slots.find(item=>item.name===slot.value);
      const painted=!!base.painted;
      surfaceTitle.textContent=painted?'涂装材质':'原模型材质';
      slot.closest('label').hidden=slots.length===1;
      singleSlot.parentElement.hidden=slots.length!==1;
      singleSlot.textContent=base.name;
      sourceControls.hidden=painted;paintControls.hidden=!painted;
      if(painted){
        const selected=getPaintSelection(),layer=project.document.paint.layers.find(layer=>layer.id===selected.layerId);
        paintLayer.textContent=(layer?.name||'全 UV 底层')+(selected.target==='mask'?' · 蒙版':'');
        editLayer.textContent=selected.openWorkspace?'打开材质工作区':'查看图层属性';
      }
      slot.disabled=scene?.dragging||scene?.mode!=='object'||slots.length===1;
      syncSelectMenu(slot);
    }
    sourceEditor.sync();
    const disabled=!current||pending||scene?.dragging||scene?.mode!=='object';
    apply.disabled=!!disabled;apply.title=scene?.mode==='edit'?'请先切换到物体模式':'';
    for(const input of fields)input.disabled=!!disabled;tool.disabled=space.disabled=!!disabled;syncSelectMenu(tool);syncSelectMenu(space);
  }
  return {refresh,dispose:sourceEditor.dispose,getState:()=>({tool:tool.value,space:space.value,transformOpen:transform.open})};
}
