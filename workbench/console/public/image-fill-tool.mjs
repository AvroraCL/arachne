import {canvasPoint} from './image-canvas-coordinates.mjs';
const el=(tag,text='')=>{const node=document.createElement(tag);node.textContent=text;return node;};

export function createImageFillTool({stage,canvas,parameters,signal,settings={},context,onChange,preview,commit,sample}){
  const options=el('div');
  options.className='editor-toolbar document-bucket-options';
  function number(label,initial,max,suffix=''){
    const row=el('label',label),input=el('input');
    Object.assign(input,{type:'number',step:1,min:0,max,value:Number.isInteger(initial)&&initial>=0&&initial<=max?initial:max});
    input.setAttribute('aria-label','油漆桶'+label);
    input.dataset.scrubNumber='';input.dataset.scrubSpeed='1';input.dataset.scrubSuffix=suffix;
    input.onchange=onChange;
    row.append(input);options.append(row);
    return input;
  }
  const tolerance=number('容差',settings.tolerance??32,255),opacity=number('不透明度',settings.opacity??100,100,'%');
  const contiguousLabel=el('label','连续'),contiguous=el('input');
  contiguous.type='checkbox';contiguous.checked=settings.contiguous!==false;
  contiguous.setAttribute('aria-label','只填充连续区域');
  contiguousLabel.title='开启时只填充相连的相似颜色区域';
  contiguous.onchange=onChange;
  contiguousLabel.append(contiguous);options.append(contiguousLabel);
  parameters.append(options);
  let active=false,gesture=null;
  function finish(write){
    if(!gesture)return false;
    const {pointer,operation,origin}=gesture;gesture=null;
    if(stage.hasPointerCapture(pointer))stage.releasePointerCapture(pointer);
    const current=context().origin;
    if(write&&current.id===origin.id&&current.revision===origin.revision&&current.documentId===origin.documentId&&
       current.layerId===origin.layerId&&current.target===origin.target)void commit(operation,origin);
    else preview(null);
    return true;
  }
  function sync(){
    options.hidden=!active;
    stage.toggleAttribute('data-fill-tool',active&&context().enabled);
  }
  stage.addEventListener('pointerdown',event=>{
    if(!active||gesture||event.button!==0)return;
    const state=context();
    if(!state.enabled||!tolerance.checkValidity()||!opacity.checkValidity()||
       !Number.isFinite(tolerance.valueAsNumber)||!Number.isFinite(opacity.valueAsNumber))return;
    const point=canvasPoint(canvas,event);
    if(!point.every(n=>n>=0&&n<=1))return;
    stage.focus({preventScroll:true});
    event.preventDefault();event.stopImmediatePropagation();
    if(event.altKey){sample(point,state);return;}
    if(opacity.valueAsNumber===0)return;
    const operation={op:'image',action:'stroke',documentId:state.origin.documentId,
      layerId:state.layer.id,target:'pixels',stroke:{uv:true,color:state.color,erase:false,opacity:opacity.valueAsNumber/100,
        flood:{point,tolerance:tolerance.valueAsNumber,contiguous:contiguous.checked},...state.selection}};
    gesture={pointer:event.pointerId,origin:state.origin,operation};
    stage.setPointerCapture(event.pointerId);preview(operation);
  },{capture:true,signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,event=>{
    if(event.pointerId!==gesture?.pointer)return;
    finish(type==='pointerup');event.stopImmediatePropagation();
  },{capture:true,signal});
  sync();
  return {
    cancel:()=>finish(false),isEditing:()=>!!gesture,
    sync,
    setActive(next){active=next;if(!next)finish(false);sync();},
    getState:()=>({tolerance:tolerance.valueAsNumber,opacity:opacity.valueAsNumber,contiguous:contiguous.checked})
  };
}
