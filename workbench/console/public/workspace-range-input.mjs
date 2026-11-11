export function scrubRangeValue(value,delta,span,fine=false){
  return value+delta*span/240*(fine ? .1 : 1);
}

// The native input remains the sole value, validation and application event
// source. Pointer drafts emit input; only an explicit commit emits change.
export function setupRangeInput(root=document){
  let gesture=null,editing=null;
  const fieldFor=target=>target instanceof Element?target.closest('.workspace-range-field'):null;
  const rangeFor=target=>fieldFor(target)?.querySelector(':scope > input[type=range],:scope > input[type=number][data-scrub-number]');
  const editable=input=>input&&!input.matches(':disabled')&&!input.readOnly&&input.isConnected;
  const changed=(input,a,b)=>input.type==='number'?Number(a)!==Number(b):a!==b;
  const emit=(input,type)=>input.dispatchEvent(new Event(type,{bubbles:true}));
  function assign(input,value){
    const previous=input.value;
    input.value=String(value);
    if(input.value!==previous)emit(input,'input');
  }
  function finishGesture(commit){
    const state=gesture;if(!state)return;
    gesture=null;delete state.field.dataset.dragging;
    if(state.field.hasPointerCapture(state.pointer))state.field.releasePointerCapture(state.pointer);
    if(!state.input.isConnected)return;
    if(!commit)assign(state.input,state.original);
    if(commit&&changed(state.input,state.input.value,state.original))emit(state.input,'change');
    else if(state.moved)emit(state.input,'workspace-range-cancel');
  }
  function finishEditor(commit,{focus=false,validate=false}={}){
    const state=editing;if(!state)return true;
    const value=state.editor.valueAsNumber,hasEdit=state.original===''||value!==Number(state.original);
    if(commit&&(!Number.isFinite(value)||hasEdit&&!state.editor.checkValidity())){
      if(validate){state.editor.setAttribute('aria-invalid','true');state.editor.reportValidity();return false;}
      commit=false;
    }
    editing=null;delete state.field.dataset.editing;
    state.input.tabIndex=state.tabIndex;
    if(commit&&hasEdit&&editable(state.input)){
      assign(state.input,value);
      if(state.original===''||changed(state.input,state.input.value,state.original))emit(state.input,'change');
    }
    state.editor.remove();
    if(focus&&state.input.isConnected)state.input.focus({preventScroll:true});
    return true;
  }
  function startEditor(input){
    if(!editable(input)||editing?.input===input)return;
    finishGesture(false);finishEditor(true);
    const field=fieldFor(input),editor=document.createElement('input');
    editor.type='number';editor.className='workspace-range-editor';editor.inputMode='decimal';editor.required=true;
    editor.min=input.min||(input.type==='range'?'0':'');editor.max=input.max||(input.type==='range'?'100':'');editor.step=input.step||'1';
    if(input.type==='number')editor.defaultValue=input.defaultValue;
    editor.value=input.value;
    editor.setAttribute('aria-label','输入数值');editor.title='Enter 确认 · Esc 取消';
    editing={input,field,editor,original:input.value,tabIndex:input.tabIndex};
    input.tabIndex=-1;field.dataset.editing='';field.append(editor);editor.focus({preventScroll:true});editor.select();
    editor.addEventListener('input',()=>editor.removeAttribute('aria-invalid'));
    editor.addEventListener('blur',()=>{if(editing?.editor===editor)finishEditor(true);});
  }
  root.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const input=rangeFor(event.target);
    if(editing&&!editing.field.contains(event.target))finishEditor(true);
    if(event.target.classList?.contains('workspace-range-editor')||!editable(input)||!Number.isFinite(input.valueAsNumber))return;
    finishGesture(false);
    input.focus({preventScroll:true});
    const initial=input.valueAsNumber,field=fieldFor(input);
    delete field.dataset.numberTyping;
    gesture={input,field,pointer:event.pointerId,original:input.value,initial,
      startX:event.clientX,lastX:event.clientX,raw:initial,moved:false,
      min:input.min!==''?Number(input.min):(input.type==='range'?0:-Infinity),
      max:input.max!==''?Number(input.max):(input.type==='range'?100:Infinity),
      step:input.type==='number'&&input.step!=='any'?Number(input.step||1):0,
      base:Number(input.min||input.defaultValue)||0,
      span:input.type==='range'?Math.max(0,Number(input.max||100)-Number(input.min||0)):240*(Number(input.dataset.scrubSpeed)||(Number(input.step)>0?Number(input.step):.01))};
    gesture.field.setPointerCapture(event.pointerId);
    event.preventDefault();event.stopPropagation();
  },true);
  root.addEventListener('pointermove',event=>{
    const state=gesture;if(!state||event.pointerId!==state.pointer)return;
    if(!editable(state.input)){finishGesture(false);return;}
    if(!state.moved&&Math.abs(event.clientX-state.startX)<3)return;
    state.moved=true;state.field.dataset.dragging='';
    const value=scrubRangeValue(state.raw,event.clientX-state.lastX,state.span,event.shiftKey);
    state.raw=Math.max(state.min,Math.min(state.max,value));
    let next=state.raw;
    if(state.input.type==='number'){
      if(state.step>0){
        const lowest=Math.ceil((state.min-state.base)/state.step-1e-8);
        const highest=Math.floor((state.max-state.base)/state.step+1e-8);
        const step=Math.round((next-state.base)/state.step);
        next=state.base+Math.max(lowest,Math.min(highest,step))*state.step;
      }
      const tolerance=Number.EPSILON*Math.max(Math.abs(state.initial),state.span/240)*4;
      const unchanged=Math.abs(next-state.initial)<=tolerance;
      if(unchanged)next=state.original;
      else if(next!==state.min&&next!==state.max)next=Number(next.toPrecision(15));
    }
    state.lastX=event.clientX;assign(state.input,next);
    event.preventDefault();event.stopPropagation();
  },true);
  for(const type of ['pointerup','pointercancel','lostpointercapture'])root.addEventListener(type,event=>{
    if(!gesture||event.pointerId!==gesture.pointer)return;
    finishGesture(type==='pointerup');event.preventDefault();event.stopPropagation();
  },true);
  // Prevent the label/native click activation from reapplying an absolute
  // pointer position after the relative drag, without swallowing double-click.
  root.addEventListener('click',event=>{
    if(event.detail>0&&rangeFor(event.target)&&!event.target.classList?.contains('workspace-range-editor')){
      event.preventDefault();event.stopPropagation();
    }
  },true);
  root.addEventListener('dblclick',event=>{
    const input=rangeFor(event.target);
    if(!editable(input)||event.target.classList?.contains('workspace-range-editor'))return;
    event.preventDefault();event.stopPropagation();startEditor(input);
  },true);
  root.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&(gesture||editing)){
      event.preventDefault();event.stopImmediatePropagation();finishGesture(false);finishEditor(false,{focus:true});return;
    }
    if(event.key==='F2'&&!editing&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
      const input=rangeFor(event.target);
      if(input===event.target&&editable(input)){event.preventDefault();event.stopImmediatePropagation();startEditor(input);return;}
    }
    if(!editing||event.target!==editing.editor)return;
    if(event.key==='Enter'){
      event.preventDefault();event.stopImmediatePropagation();finishEditor(true,{focus:true,validate:true});
    }else if(event.key==='Tab'){
      if(!finishEditor(true,{focus:true,validate:true}))event.preventDefault();
      event.stopPropagation();
    }
  },true);
  root.defaultView?.addEventListener('blur',()=>finishGesture(false));
}
