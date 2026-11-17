import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';

const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};

// Object edits use the same modeler and project revision as the 3D viewport.
export function createObjectPropertyEditor({host,project,state={},onChange,error,getTarget}){
  const root=el('div','object-property-editor'),info=el('details','render-settings-section');root.tabIndex=-1;info.open=true;
  info.append(el('summary','','物体'));const infoBody=el('div','render-settings-body');info.append(infoBody);
  const name=el('span','render-settings-readout'),position=el('span','object-position');
  function row(parent,label,control){const item=el('label','render-settings-row');item.dataset.search=label;item.append(el('span','',label),control);parent.append(item);return control;}
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
  surface.open=true;surface.append(el('summary','','原模型材质'),surfaceBody);root.insertBefore(surface,transform);
  const slot=el('select');slot.setAttribute('aria-label','物体材质槽');row(surfaceBody,'材质',slot);
  const inputs={};
  for(const [key,title] of [['color','底色'],['metallic','金属度'],['roughness','粗糙度']]){
    const input=el('input');input.type=key==='color'?'color':'number';
    if(key!=='color'){input.min='0';input.max='1';input.step='any';}
    input.setAttribute('aria-label','模型材质'+title);
    input.addEventListener('change',()=>saveMaterial({[key]:key==='color'?input.value:input.valueAsNumber}));
    inputs[key]=row(surfaceBody,title,input);
  }
  const restore=el('button','','恢复源材质'),materialMessage=el('output','editor-message');
  restore.type='button';restore.onclick=()=>saveMaterial(null);surfaceBody.append(restore,el('p','object-property-hint','共用此材质的物体会同步更新。'),materialMessage);
  let targetKey='',pending=false,lastStatus=null,materialPending=false;
  slot.addEventListener('change',()=>refresh());
  async function saveMaterial(patch){
    if(materialPending)return;
    const target=getTarget(),origin=project.origin(),scene=project.scene;
    if(!origin||target?.projectId!==origin.id||target.binding!==scene?.binding||
      !scene.inspectObject(target.id)?.materials?.some(item=>item.name===slot.value)){
      refresh();error(Error('物体材质目标已变化，请重新选择'));return;
    }
    const name=slot.value;materialPending=true;refresh();materialMessage.textContent='正在保存…';
    try{await project.commands([{op:'sourceMaterial',name,patch}],origin);materialMessage.textContent='';}
    catch(failure){materialMessage.textContent=failure.message;error(failure);}
    finally{materialPending=false;refresh(undefined,true);}
  }
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
  function refresh(status,updateInputs=false){
    if(status!==undefined)lastStatus=status;
    const target=getTarget(),key=JSON.stringify(target),scene=project.scene;
    if(key!==targetKey){targetKey=key;reset();message.textContent='';}
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
      const base=slots.find(item=>item.name===slot.value),patch=project.document.paint.sourceMaterials?.[slot.value];
      const locked=materialPending||scene?.dragging||scene?.mode!=='object';
      for(const [key,input] of Object.entries(inputs)){
        if(!materialPending&&(updateInputs||document.activeElement!==input))input.value=patch?.[key]??base[key];
        input.disabled=!!locked;
      }
      restore.disabled=!!locked||!patch;slot.disabled=!!locked||slots.length===1;
    }
    const disabled=!current||pending||scene?.dragging||scene?.mode!=='object';
    apply.disabled=!!disabled;apply.title=scene?.mode==='edit'?'请先切换到物体模式':'';
    for(const input of fields)input.disabled=!!disabled;tool.disabled=space.disabled=!!disabled;syncSelectMenu(tool);syncSelectMenu(space);
  }
  return {refresh,getState:()=>({tool:tool.value,space:space.value,transformOpen:transform.open})};
}
