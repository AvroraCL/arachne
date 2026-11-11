import {workspaceIcons} from './workspace-icons.mjs';

export function createModelOutliner({select,frame,toggleVisibility,showAll,applyNumeric}) {
  const panel=document.getElementById('model-outliner');
  const toggle=document.getElementById('model-outliner-toggle');
  const search=panel.querySelector('input');
  const list=panel.querySelector('ul');
  const count=panel.querySelector('output');
  const empty=panel.querySelector('p');
  const close=panel.querySelector('#model-outliner-close');
  const show=panel.querySelector('#model-show-all');
  const numeric=panel.querySelector('#model-numeric');
  const numericFields=numeric.querySelector('fieldset');
  const numericInputs=[...numeric.querySelectorAll('input')];
  const numericStatus=numeric.querySelector('output');
  const numericLabel=numeric.querySelector('legend');
  const toolNames={translate:'移动增量',rotate:'旋转增量（°）',scale:'缩放倍数'};
  show.innerHTML=workspaceIcons.eye;
  let wanted=true, available=false, items=[], lastActive, numericTool='translate', numericTarget;
  const rows=new Map();

  function renderVisibility() {
    panel.hidden=!(available&&wanted);
    toggle.setAttribute('aria-expanded',String(!panel.hidden));
  }

  function filter() {
    const needle=search.value.trim().toLocaleLowerCase();
    let shown=0;
    for(const {id,label} of items) {
      const row=rows.get(id).button.parentElement;
      row.hidden=!label.toLocaleLowerCase().includes(needle);
      if(!row.hidden)shown++;
    }
    count.textContent=shown===items.length?String(shown):shown+' / '+items.length;
    empty.hidden=shown>0;
    empty.textContent=items.length?'没有匹配的物体':'正在载入场景…';
  }

  function resetNumeric() {
    for(const input of numericInputs)input.value=numericTool==='scale'?'1':'0';
    numericStatus.textContent='';
  }

  function update({sceneItems,selectedIds,activeId,dragging,visibility,hasHidden,tool,selectionKey,hasTransformTarget}) {
    numericFields.disabled=dragging||!hasTransformTarget;
    if(tool!==numericTool||selectionKey!==numericTarget){
      numericTool=tool;
      for(const input of numericInputs)input.dataset.scrubSpeed=tool==='rotate'?'.5':'.01';
      numericTarget=selectionKey;
      numericLabel.textContent=toolNames[tool];
      resetNumeric();
    }
    if(sceneItems!==items) {
      items=sceneItems;
      rows.clear();
      list.replaceChildren(...items.map(({id,label,depth})=>{
        const row=document.createElement('li');
        const button=document.createElement('button');
        const name=document.createElement('span');
        const eye=document.createElement('button');
        eye.type='button';
        eye.className='model-object-eye';
        eye.onclick=()=>toggleVisibility(id);
        button.type='button';
        button.className='model-object-name';
        button.title=label+' · 双击聚焦';
        button.style.setProperty('--object-depth',depth);
        button.innerHTML=workspaceIcons.object;
        name.textContent=label;
        button.append(name);
        button.onclick=event=>select(id,event.shiftKey||event.metaKey||event.ctrlKey);
        button.ondblclick=()=>frame(id);
        row.append(button,eye);
        rows.set(id,{button,eye,label});
        return row;
      }));
      filter();
    }
    const selected=new Set(selectedIds);
    show.disabled=dragging||!hasHidden;
    for(const [id,{button,eye,label}] of rows) {
      const state=visibility.get(id);
      const visible=state==='visible';
      button.disabled=dragging||!visible;
      const row=button.parentElement;
      button.setAttribute('aria-pressed',String(selected.has(id)));
      button.toggleAttribute('data-active',id===activeId);
      eye.disabled=dragging||state==='inherited'||state==='outside';
      if(row.dataset.visibility!==state){
        row.dataset.visibility=state;
        eye.innerHTML=visible?workspaceIcons.eye:workspaceIcons.hidden;
        eye.title=(visible?'隐藏 ':state==='inherited'?'父级已隐藏 · ':state==='outside'?'局部视图外 · ':'显示 ')+label;
        eye.setAttribute('aria-label',eye.title);
      }
    }
    const current=rows.get(activeId)?.button;
    if(activeId!==lastActive&&current&&!panel.hidden&&!current.parentElement.hidden){
      current.scrollIntoView({block:'nearest'});
    }
    lastActive=activeId;
  }

  search.oninput=filter;
  show.onclick=showAll;
  numeric.oninput=()=>{numericStatus.textContent='';};
  numeric.onsubmit=event=>{
    event.preventDefault();
    if(numericFields.disabled)return;
    try{
      applyNumeric(numericInputs.map(input=>input.valueAsNumber));
      resetNumeric();
    }catch(error){numericStatus.textContent=error.message;}
  };
  toggle.onclick=()=>{wanted=!wanted;renderVisibility();};
  close.onclick=()=>{wanted=false;renderVisibility();toggle.focus();};

  return {
    update,
    show(visible){available=visible;renderVisibility();}
  };
}
