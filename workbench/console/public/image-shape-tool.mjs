import {imageShapeKinds} from './image-shapes.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';

const el=(tag,text='')=>{const node=document.createElement(tag);node.textContent=text;return node;};
const svg=tag=>document.createElementNS('http://www.w3.org/2000/svg',tag);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const resolution=4096;
const sameOrigin=(a,b)=>a.id===b.id&&a.revision===b.revision&&a.documentId===b.documentId;

function bounds(start,end,{shiftKey,altKey}){
  const signs=end.map((value,i)=>value<start[i]?-1:1);
  const limits=start.map((value,i)=>altKey?Math.min(value,1-value):signs[i]<0?value:1-value);
  const distances=end.map((value,i)=>Math.abs(value-start[i]));
  const half=shiftKey?limits.map(()=>Math.min(Math.max(...distances),...limits)):
    distances.map((value,i)=>Math.min(value,limits[i]));
  return start.map((value,i)=>[value-(altKey||signs[i]<0?half[i]:0),value+(altKey||signs[i]>0?half[i]:0)]);
}

export function createImageShapeTool({stage,canvas,parameters,signal,context,preview,commit,settings={},onChange}){
  const options=el('div');
  options.className='editor-toolbar document-shape-options';
  options.hidden=true;
  const kind=el('select');
  kind.setAttribute('aria-label','形状类型');
  kind.append(...imageShapeKinds.map(([value,label])=>new Option(label,value)));
  kind.value=imageShapeKinds.some(([value])=>value===settings.kind)?settings.kind:'rectangle';
  options.append(kind);enhanceSelectMenu(kind);
  function checkbox(name,initial){
    const row=el('label',name),input=el('input');
    input.type='checkbox';input.checked=initial;input.setAttribute('aria-label','形状'+name);
    row.append(input);options.append(row);
    return input;
  }
  function number(name,initial,max){
    const row=el('label',name),input=el('input');
    Object.assign(input,{type:'number',min:0,max,step:1,value:Number.isInteger(initial)?clamp(initial,0,max):0});
    input.setAttribute('aria-label','形状'+name);
    input.dataset.scrubNumber='';input.dataset.scrubSpeed='1';input.dataset.scrubSuffix=' px';
    row.append(input);options.append(row);
    return {row,input};
  }
  const fill=checkbox('填充',settings.fill!==false),stroke=checkbox('描边',settings.stroke===true);
  const width=number('描边宽度',settings.strokeWidth??16,512),radius=number('圆角',settings.cornerRadius??0,2048);
  parameters.append(options);
  const guide=svg('svg'),rectangle=svg('rect'),ellipse=svg('ellipse');
  guide.classList.add('document-shape-guide');guide.setAttribute('aria-hidden','true');
  guide.setAttribute('hidden','');guide.append(rectangle,ellipse);stage.append(guide);
  let active=false,gesture=null,frame=0;
  function getState(){
    return {kind:kind.value,fill:fill.checked,stroke:stroke.checked,
      strokeWidth:width.input.valueAsNumber,cornerRadius:radius.input.valueAsNumber};
  }
  function usable(state){return state.fill||state.stroke&&state.strokeWidth>0;}
  function sync(){
    const state=context();
    if(gesture&&!sameOrigin(gesture.origin,state.origin))cancel();
    options.hidden=!active;
    width.row.hidden=!stroke.checked;
    radius.row.hidden=kind.value!=='rectangle';
    stage.toggleAttribute('data-shape-tool',active&&state.enabled&&usable(getState()));
    for(const control of [kind,fill,stroke,width.input,radius.input])control.disabled=!!gesture;
    syncSelectMenu(kind);
    layout();
  }
  function layout(){
    const g=gesture,rect=g?.rect;
    guide.toggleAttribute('hidden',!rect);
    if(!rect)return;
    const box=canvas.getBoundingClientRect(),host=stage.getBoundingClientRect();
    const [[left,right],[top,bottom]]=rect;
    const x=box.left-host.left+left*box.width,y=box.top-host.top+top*box.height;
    const w=(right-left)*box.width,h=(bottom-top)*box.height;
    rectangle.style.display=g.style.kind==='rectangle'?'':'none';
    ellipse.style.display=g.style.kind==='ellipse'?'':'none';
    const round=Math.min(g.style.cornerRadius*box.width/resolution,w/2,h/2);
    for(const [key,value] of Object.entries({x,y,width:w,height:h,rx:round}))rectangle.setAttribute(key,value);
    for(const [key,value] of Object.entries({cx:x+w/2,cy:y+h/2,rx:w/2,ry:h/2}))ellipse.setAttribute(key,value);
  }
  function operation(g){
    const [[left,right],[top,bottom]]=g.rect;
    const width=Math.round((right-left)*resolution),height=Math.round((bottom-top)*resolution);
    if(width<1||height<1)return null;
    const {kind,fill,stroke,strokeWidth,cornerRadius}=g.style;
    const shape={kind,width,height,fill:fill?g.colors.foreground:null,stroke:stroke?g.colors.background:null,strokeWidth,cornerRadius};
    return {op:'image',action:'addLayer',documentId:g.origin.documentId,layerId:g.layerId,kind:'shape',index:g.index,
      patch:{name:imageShapeKinds.find(([value])=>value===kind)[1],shape,
        x:(left+right)/2,y:(top+bottom)/2,scale:Math.max(width,height)/resolution}};
  }
  function update(event){
    const box=canvas.getBoundingClientRect(),end=[(event.clientX-box.left)/box.width,(event.clientY-box.top)/box.height];
    const current=gesture;
    current.rect=bounds(current.start,end,event);
    layout();
    if(!frame)frame=requestAnimationFrame(()=>{
      frame=0;
      if(gesture!==current)return;
      const op=operation(current);
      if(op||current.previewed){current.previewed=!!op;preview(op);}
    });
  }
  function end(apply){
    const current=gesture;
    if(!current)return false;
    gesture=null;
    if(frame){cancelAnimationFrame(frame);frame=0;}
    if(stage.hasPointerCapture(current.pointer))stage.releasePointerCapture(current.pointer);
    const op=apply&&operation(current);
    if(op)void commit(op,current.origin);
    else if(current.previewed)preview(null);
    sync();
    return true;
  }
  function cancel(){return end(false);}
  stage.addEventListener('pointerdown',event=>{
    if(!active||event.button!==0||gesture)return;
    const state=context(),style=getState();
    if(!state.enabled||!usable(style)||![style.strokeWidth,style.cornerRadius].every(Number.isInteger))return;
    const box=canvas.getBoundingClientRect(),start=[(event.clientX-box.left)/box.width,(event.clientY-box.top)/box.height];
    if(!start.every(n=>n>=0&&n<=1))return;
    gesture={pointer:event.pointerId,start,rect:bounds(start,start,event),origin:state.origin,index:state.index,
      colors:state.colors,style,layerId:crypto.randomUUID(),previewed:false};
    stage.focus({preventScroll:true});stage.setPointerCapture(event.pointerId);
    event.preventDefault();event.stopImmediatePropagation();sync();
  },{capture:true,signal});
  stage.addEventListener('pointermove',event=>{
    if(gesture?.pointer!==event.pointerId)return;
    update(event);event.stopImmediatePropagation();
  },{capture:true,signal});
  for(const eventName of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(eventName,event=>{
    if(gesture?.pointer!==event.pointerId)return;
    if(eventName==='pointerup')update(event);
    end(eventName==='pointerup');event.stopImmediatePropagation();
  },{capture:true,signal});
  for(const control of [kind,fill,stroke,width.input,radius.input])control.onchange=()=>{sync();onChange();};
  sync();
  return {layout,sync,cancel,getState,isEditing:()=>!!gesture,
    setActive(next){active=next;if(!active)cancel();sync();},
    cycle(){kind.value=kind.value==='rectangle'?'ellipse':'rectangle';sync();onChange();}};
}
