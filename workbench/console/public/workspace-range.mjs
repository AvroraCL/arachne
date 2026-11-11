import {setupRangeInput} from './workspace-range-input.mjs';
export function rangePercent(value,min=0,max=100){
  const low=Number(min),high=Number(max),number=Number(value);
  if(!Number.isFinite(number)||!Number.isFinite(low)||!Number.isFinite(high)||high<=low)return 0;
  return Math.max(0,Math.min(100,(number-low)/(high-low)*100));
}

export function numericReadout(value){
  if(!Number.isFinite(value))return '';
  const magnitude=Math.abs(value);
  if(magnitude>=1e7||magnitude>0&&magnitude<.0001)return Number(value.toPrecision(5)).toExponential();
  return String(Number(value.toFixed(4)));
}

export function setupRangeControls(root=document){
  const inputs=new WeakMap();
  const native=HTMLInputElement.prototype;
  const numeric=input=>input.type==='number'&&!input.classList.contains('workspace-range-editor')&&(input.hasAttribute('data-scrub-number')||input.matches('#properties input,#model-numeric input,.shader-params input,#drawing-layer-opacity'));
  const supported=input=>input.type==='range'||numeric(input);
  function sync(input){
    if(!supported(input))return;
    const fill=numeric(input)&&(input.min===''||input.max==='')?0:rangePercent(input.value,input.min===''?0:input.min,input.max===''?100:input.max);
    const value=Number(fill.toFixed(4))+'%';
    if(input.style.getPropertyValue('--range-fill')!==value)input.style.setProperty('--range-fill',value);
    const presentation=inputs.get(input);
    if(!presentation)return;
    presentation.field.style.setProperty('--range-fill',value);
    if(numeric(input)){
      const label=numericReadout(input.valueAsNumber);
      if(presentation.readout.textContent!==label)presentation.readout.textContent=label;
    }else if(presentation.owned){
      const step=input.step||'1',places=step.includes('e-')?Number(step.split('e-')[1]):(step.split('.')[1]||'').length;
      presentation.readout.textContent=Number(input.value).toFixed(Math.min(4,places));
    }
  }
  function enhance(input){
    if(!supported(input))return;
    if(!inputs.has(input)){
      const number=numeric(input);
      input.classList.add(number?'workspace-number-input':'workspace-range');
      if(number)input.dataset.scrubNumber='';
      const field=input.parentElement?.classList.contains('workspace-range-field')?input.parentElement:document.createElement('span');
      field.classList.add('workspace-range-field');field.dataset.kind=number?'number':'range';
      field.title='左右拖动调整 · Shift 精调 · 双击或 F2 输入 · Esc 取消';
      const sibling=input.nextElementSibling;
      let readout=number?null:sibling?.matches('output,#zoom-label,.workspace-range-value')?sibling:input.closest('.vp-setting')?.querySelector('output');
      const owned=!readout||readout.dataset.rangeOwned==='true';
      if(!readout){readout=document.createElement('span');readout.className='workspace-range-value';readout.dataset.rangeOwned='true';readout.setAttribute('aria-hidden','true');}
      readout?.classList.add('workspace-range-value');
      if(field!==input.parentElement){input.before(field);field.append(input);if(readout)field.append(readout);}
      else if(readout&&readout.parentElement!==field)field.append(readout);
      // Keep existing outputs immediately after the native input: application
      // readout formatters and IDs continue working, now inside the numeric bar.
      inputs.set(input,{field,readout,owned});
      if(number){
        input.addEventListener('beforeinput',event=>{if(event.inputType)field.dataset.numberTyping='';});
        input.addEventListener('blur',()=>delete field.dataset.numberTyping);
      }
      // Restore/default/preset code often assigns values without emitting input.
      // Update only presentation; never synthesize edits or save events.
      for(const key of ['value','valueAsNumber']){
        const descriptor=Object.getOwnPropertyDescriptor(native,key);
        if(!descriptor?.set||Object.hasOwn(input,key))continue;
        Object.defineProperty(input,key,{configurable:true,enumerable:descriptor.enumerable,
          get(){return descriptor.get.call(this);},set(value){descriptor.set.call(this,value);sync(this);}});
      }
    }
    sync(input);
  }
  function scan(node){
    if(node instanceof HTMLInputElement)enhance(node);
    node.querySelectorAll?.('input[type=range],input[type=number]').forEach(enhance);
  }
  scan(root);
  setupRangeInput(root);
  root.addEventListener('input',event=>{if(event.target instanceof HTMLInputElement)enhance(event.target);},true);
  root.addEventListener('change',event=>{if(event.target instanceof HTMLInputElement)enhance(event.target);},true);
  root.addEventListener('reset',event=>queueMicrotask(()=>scan(event.target)));
  new MutationObserver(records=>{
    for(const record of records){
      if(record.type==='attributes'&&record.target instanceof HTMLInputElement)enhance(record.target);
      else for(const node of record.addedNodes)scan(node);
    }
  }).observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['min','max','step','value','disabled','type']});
}

if(typeof document!=='undefined')setupRangeControls(document);
