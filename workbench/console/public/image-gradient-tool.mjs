import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {chromeButton} from './area-chrome.mjs';

const svgNS='http://www.w3.org/2000/svg';
const clamp=n=>Math.max(0,Math.min(1,n));
const sameOrigin=(a,b)=>a.id===b.id&&a.revision===b.revision&&a.documentId===b.documentId&&a.layerId===b.layerId&&a.target===b.target;
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const usable=gradient=>distance(gradient.start,gradient.end)>=1/4096;
const reversed=gradient=>({...gradient,colors:[...gradient.colors].reverse(),alpha:[...gradient.alpha].reverse()});

function snapped(point,anchor){
  const [dx,dy]=point.map((value,i)=>value-anchor[i]);
  const increment=Math.PI/4,angle=Math.round(Math.atan2(dy,dx)/increment)*increment;
  const direction=[Math.cos(angle),Math.sin(angle)];
  const length=Math.min(Math.hypot(dx,dy),...direction.map((n,i)=>Math.abs(n)<1e-9?Infinity:
    (n>0?1-anchor[i]:anchor[i])/Math.abs(n)));
  return direction.map((n,i)=>clamp(anchor[i]+n*length));
}

export function createImageGradientTool({stage,canvas,parameters,signal,context,preview,commit,settings={},onChange}){
  const options=document.createElement('div');
  options.className='editor-toolbar document-gradient-options';
  options.hidden=true;
  function select(label,entries){
    const control=document.createElement('select');
    control.setAttribute('aria-label',label);
    control.append(...entries.map(([value,text])=>new Option(text,value)));
    options.append(control);
    enhanceSelectMenu(control);
    return control;
  }
  const swatch=document.createElement('span');
  swatch.className='document-gradient-swatch';swatch.setAttribute('aria-hidden','true');
  options.append(swatch);
  const shape=select('渐变形状',[['linear','线性'],['radial','径向']]);
  const preset=select('渐变颜色',[['pair','前景色到背景色'],['fade','前景色到透明']]);
  const reverse=chromeButton(document.createElement('button'),'invert','反转渐变');
  reverse.type='button';options.append(reverse);
  parameters.append(options);

  const guide=document.createElementNS(svgNS,'svg');
  guide.classList.add('document-gradient-guide');
  guide.setAttribute('aria-hidden','true');
  guide.setAttribute('hidden','');
  const line=document.createElementNS(svgNS,'path');
  const stroke=line.cloneNode(),startNode=document.createElementNS(svgNS,'circle'),endNode=startNode.cloneNode();
  for(const node of [startNode,endNode])node.setAttribute('r','5');
  stroke.classList.add('gradient-guide-shadow');
  guide.append(stroke,line,startNode,endNode);
  stage.append(guide);

  let active=false,gesture=null,frame=0;
  let kind=settings.kind==='radial'?'radial':'linear',fade=settings.fade===true,flip=settings.flip===true;
  const selected=state=>state.origin.target==='pixels'&&state.layer?.kind==='gradient'?state.layer:null;
  function style(state,shapeValue=kind,transparent=fade){
    const stops={kind:shapeValue,colors:[state.colors.foreground,transparent?state.colors.foreground:state.colors.background],
      alpha:[1,transparent?0:1]};
    return flip?reversed(stops):stops;
  }
  function operation(origin,layerId,gradient,index){
    return {op:'image',action:index===undefined?'updateLayer':'addLayer',documentId:origin.documentId,layerId,
      ...(index===undefined?{}:{kind:'gradient',index}),patch:{gradient:{...gradient}}};
  }
  function updateSelected(change){
    const state=context(),layer=selected(state);
    if(!layer||!state.enabled||layer.locked||gesture)return;
    void commit(operation(state.origin,layer.id,change(layer.gradient)),state.origin,false);
  }
  shape.onchange=()=>{
    kind=shape.value;
    updateSelected(gradient=>({...gradient,kind}));
    onChange();sync();
  };
  preset.onchange=()=>{
    fade=preset.value==='fade';
    updateSelected(gradient=>({...gradient,...style(context(),gradient.kind)}));
    onChange();sync();
  };
  reverse.onclick=()=>{
    const state=context();
    if(selected(state))updateSelected(reversed);
    else flip=!flip;
    onChange();sync();
  };

  function layout(){
    const state=context(),gradient=gesture?.gradient||selected(state)?.gradient;
    const visible=active&&state.origin.target==='pixels'&&!!gradient&&!canvas.hidden;
    guide.toggleAttribute('hidden',!visible);
    if(!visible)return;
    const rect=canvas.getBoundingClientRect(),box=stage.getBoundingClientRect();
    const at=([x,y])=>[rect.left-box.left+x*rect.width,rect.top-box.top+y*rect.height];
    const [a,b]=[at(gradient.start),at(gradient.end)];
    const path='M'+a.join(' ')+'L'+b.join(' ');
    for(const pathElement of [line,stroke])pathElement.setAttribute('d',path);
    [startNode,endNode].forEach((node,i)=>{
      const [x,y]=i?b:a;
      node.setAttribute('cx',x);node.setAttribute('cy',y);
      node.style.fill=gradient.colors[i];
    });
  }
  function sync(){
    const state=context(),layer=selected(state),gradient=gesture?.gradient||layer?.gradient||style(state);
    if(gesture&&!sameOrigin(state.origin,gesture.origin)){cancel();return;}
    const disabled=!state.enabled||!!layer?.locked||!!gesture;
    shape.disabled=preset.disabled=reverse.disabled=disabled;
    shape.value=gradient.kind;
    preset.value=gradient.alpha.some(alpha=>alpha<1)?'fade':'pair';
    syncSelectMenu(shape);syncSelectMenu(preset);
    reverse.setAttribute('aria-pressed',String(!layer&&flip));
    const colors=gradient.colors.map((color,i)=>color+Math.round(gradient.alpha[i]*255).toString(16).padStart(2,'0'));
    swatch.style.setProperty('--gradient-preview',`linear-gradient(90deg,${colors.join(',')})`);
    layout();
  }
  function point(event,box){
    return [(event.clientX-box.left)/box.width,(event.clientY-box.top)/box.height];
  }
  function update(event){
    const current=gesture;
    const position=point(event,canvas.getBoundingClientRect()).map(clamp);
    current.gradient[current.handle]=event.shiftKey?snapped(position,current.anchor):position;
    layout();
    if(usable(current.gradient)&&!frame)frame=requestAnimationFrame(()=>{
      frame=0;
      if(gesture===current&&usable(current.gradient)){
        current.previewed=true;
        preview(operation(current.origin,current.layerId,current.gradient,current.index));
      }
    });
  }
  function pointerDown(event){
    const state=context();
    if(!active||!state.enabled||event.button!==0||gesture)return;
    const box=canvas.getBoundingClientRect(),pointIn=point(event,box);
    if(!box.width||!box.height||pointIn.some(n=>n<0||n>1))return;
    const layer=selected(state);
    if(layer?.locked)return;
    const gradient=layer?structuredClone(layer.gradient):{...style(state),...state.selection};
    let handle='end',anchor=pointIn;
    if(layer){
      const nearStart=distance(gradient.start,pointIn)*box.width<=11;
      const nearEnd=distance(gradient.end,pointIn)*box.width<=11;
      if(nearStart||nearEnd){
        handle=nearStart?'start':'end';
        anchor=gradient[nearStart?'end':'start'];
      }else{
        gradient.start=pointIn;gradient.end=pointIn;
      }
    }else{
      gradient.start=pointIn;gradient.end=pointIn;
    }
    gesture={origin:state.origin,layerId:layer?.id||crypto.randomUUID(),index:layer?undefined:state.index,
      before:layer?.gradient,gradient,handle,anchor,pointer:event.pointerId,previewed:false};
    stage.focus({preventScroll:true});stage.setPointerCapture(event.pointerId);
    event.preventDefault();event.stopImmediatePropagation();
    sync();
  }
  function finish(write){
    if(!gesture)return false;
    const current=gesture;gesture=null;
    cancelAnimationFrame(frame);frame=0;
    if(stage.hasPointerCapture(current.pointer))stage.releasePointerCapture(current.pointer);
    if(write&&usable(current.gradient)&&JSON.stringify(current.before)!==JSON.stringify(current.gradient))
      void commit(operation(current.origin,current.layerId,current.gradient,current.index),current.origin,current.index!==undefined);
    else if(current.previewed)preview(null);
    sync();return true;
  }
  function cancel(){return finish(false);}
  stage.addEventListener('pointerdown',pointerDown,{signal,capture:true});
  stage.addEventListener('pointermove',event=>{
    if(event.pointerId!==gesture?.pointer)return;
    update(event);event.stopImmediatePropagation();
  },{signal,capture:true});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,event=>{
    if(event.pointerId!==gesture?.pointer)return;
    if(type==='pointerup')update(event);
    finish(type==='pointerup');event.stopImmediatePropagation();
  },{signal,capture:true});
  return {setActive(value){
    active=value;options.hidden=!active;stage.toggleAttribute('data-gradient-tool',active);
    if(!active)cancel();
    sync();
  },sync,layout,cancel,isEditing:()=>!!gesture,getState:()=>({kind,fade,flip})};
}
