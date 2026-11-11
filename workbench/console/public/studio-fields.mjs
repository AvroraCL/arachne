// Commit one undoable command after a numeric label drag.
export function scrubNumber(label,input,{key='',speed=key==='opacity'?.005:key.startsWith('scale')?.01:key==='rotation'?.5:1,
  canStart=()=>true,onDraft=()=>{}}){
  label.classList.add('studio-scrub-label');
  label.title='左右拖动调整 · Shift 精调 · Esc 取消';
  let drag=null;

  function finish(commit){
    const current=drag;
    if(!current)return;
    drag=null;
    current.events.abort();
    label.classList.remove('scrubbing');
    if(label.hasPointerCapture(current.pointerId))label.releasePointerCapture(current.pointerId);
    if(!commit||Math.abs(current.value-current.initial)<.000005){
      input.value=current.original;
      onDraft(input.value);
    }else if(input.isConnected&&input.valueAsNumber!==current.initial){
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }

  label.addEventListener('pointerdown',event=>{
    const initial=input.valueAsNumber;
    if(event.button!==0||drag||input.disabled||input.readOnly||!Number.isFinite(initial)||!canStart())return;
    event.preventDefault();
    const events=new AbortController(),{signal}=events;
    drag={pointerId:event.pointerId,x:event.clientX,original:input.value,initial,value:initial,events};
    label.setPointerCapture(event.pointerId);
    label.classList.add('scrubbing');
    document.addEventListener('keydown',key=>{
      if(key.key!=='Escape')return;
      key.preventDefault();
      key.stopPropagation();
      finish(false);
    },{capture:true,signal});
    document.addEventListener('lostpointercapture',lost=>{
      if(lost.pointerId===event.pointerId)finish(false);
    },{capture:true,signal});
  });

  label.addEventListener('pointermove',event=>{
    if(drag?.pointerId!==event.pointerId||event.clientX===drag.x)return;
    const delta=(event.clientX-drag.x)*speed*(event.shiftKey?.1:1)*(event.ctrlKey?10:1);
    const min=input.min===''?-Infinity:Number(input.min),max=input.max===''?Infinity:Number(input.max);
    drag.x=event.clientX;
    drag.value=Math.max(min,Math.min(max,drag.value+delta));
    input.value=String(Number(drag.value.toFixed(5)));
    onDraft(input.value);
  });
  label.addEventListener('pointerup',event=>{
    if(drag?.pointerId===event.pointerId)finish(true);
  });
  label.addEventListener('pointercancel',event=>{
    if(drag?.pointerId===event.pointerId)finish(false);
  });
}
