import {canvasCoordinates,canvasPoint} from './image-canvas-coordinates.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {chromeButton} from './area-chrome.mjs';
import {maskTransformIdentity} from './image-documents.mjs';
import {mapImageMaskPoint} from './image-warp.mjs';

const svgNS='http://www.w3.org/2000/svg';
const clamp=n=>Math.max(0,Math.min(1,n));
const sameOrigin=(a,b)=>a.id===b.id&&a.revision===b.revision&&a.documentId===b.documentId&&a.layerId===b.layerId&&a.target===b.target;
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const usable=gradient=>distance(gradient.start,gradient.end)>=1/4096;
const reversed=gradient=>({...gradient,colors:[...gradient.colors].reverse(),alpha:[...gradient.alpha].reverse()});
function mapPoint([u,v],from,to){
  const [a,b,d,e,x,y]=from,[A,B,D,E,X,Y]=to,determinant=a*e-b*d;
  const sx=(e*(u-x)-d*(v-y))/determinant,sy=(-b*(u-x)+a*(v-y))/determinant;
  return [A*sx+D*sy+X,B*sx+E*sy+Y];
}

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
  startNode.dataset.gradientHandle='start';endNode.dataset.gradientHandle='end';
  stroke.classList.add('gradient-guide-shadow');
  guide.append(stroke,line,startNode,endNode);
  stage.append(guide);

  let active=false,gesture=null,frame=0;
  let kind=settings.kind==='radial'?'radial':'linear',fade=settings.fade===true,flip=settings.flip===true;
  const isMask=state=>state.origin.target==='mask';
  const currentGradient=state=>isMask(state)?state.layer?.maskGradient:state.layer?.gradient;
  function displayGradient(state,gradient=currentGradient(state)){
    if(!gradient)return gradient;
    const to=state.layer?.gradientTransform;
    const point=isMask(state)?p=>mapImageMaskPoint(state.layer,gradient,p):
      to?p=>mapPoint(p,maskTransformIdentity,to):p=>p;
    return {...gradient,start:point(gradient.start),end:point(gradient.end)};
  }
  function style(state,shapeValue=kind,transparent=fade){
    const stops={kind:shapeValue,colors:[state.colors.foreground,transparent?state.colors.foreground:state.colors.background],
      alpha:[1,transparent?0:1]};
    return flip?reversed(stops):stops;
  }
  function operation(origin,layerId,gradient,insertion){
    const patch=origin.target==='mask'?{maskGradient:{...gradient},maskEnabled:true}:{gradient:{...gradient}};
    return {op:'image',action:insertion?'addLayer':'updateLayer',documentId:origin.documentId,layerId,
      ...(insertion?{kind:'gradient',...insertion}:{}),patch};
  }
  function updateSelected(change){
    const state=context(),gradient=currentGradient(state);
    if(!gradient||!state.enabled||state.layer.locked||gesture)return;
    const next=change(gradient);
    if(isMask(state)&&state.layer.maskTransform)next.maskSpace??=[...maskTransformIdentity];
    if(isMask(state)&&state.layer.maskWarpSteps?.length)next.maskWarpIndex??=0;
    void commit(operation(state.origin,state.layer.id,next),state.origin,false);
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
    if(currentGradient(state))updateSelected(reversed);
    else flip=!flip;
    onChange();sync();
  };

  function layout(){
    const state=context(),gradient=displayGradient(state,gesture?.gradient||currentGradient(state));
    const visible=active&&!!gradient&&!canvas.hidden;
    guide.toggleAttribute('hidden',!visible);
    if(!visible)return;
    const at=canvasCoordinates(canvas).toLocal(stage.getBoundingClientRect());
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
    const state=context(),current=currentGradient(state),gradient=gesture?.gradient||current||style(state);
    if(gesture&&!sameOrigin(state.origin,gesture.origin)){cancel();return;}
    const disabled=!state.enabled||!!((isMask(state)||current)&&state.layer?.locked)||!!gesture;
    shape.disabled=preset.disabled=reverse.disabled=disabled;
    shape.value=gradient.kind;
    preset.value=gradient.alpha.some(alpha=>alpha<1)?'fade':'pair';
    syncSelectMenu(shape);syncSelectMenu(preset);
    reverse.setAttribute('aria-pressed',String(!current&&flip));
    const colors=gradient.colors.map((color,i)=>color+Math.round(gradient.alpha[i]*255).toString(16).padStart(2,'0'));
    swatch.style.setProperty('--gradient-preview',`linear-gradient(90deg,${colors.join(',')})`);
    layout();
  }
  function update(event){
    const current=gesture;
    const position=canvasPoint(canvas,event).map(clamp);
    const point=event.shiftKey?snapped(position,current.anchor):position;
    current.gradient[current.handle]=current.mask?mapImageMaskPoint(current.layer,current.gradient,point,true):
      current.space?mapPoint(point,current.space,maskTransformIdentity):point;
    layout();
    if(usable(current.gradient)&&!frame)frame=requestAnimationFrame(()=>{
      frame=0;
      if(gesture===current&&usable(current.gradient)){
        current.previewed=true;
        preview(operation(current.origin,current.layerId,current.gradient,current.insertion));
      }
    });
  }
  function pointerDown(event){
    const state=context();
    if(!active||!state.enabled||event.button!==0||gesture)return;
    const box=canvasCoordinates(canvas),pointIn=box.fromClient(event.clientX,event.clientY);
    if(!box.width||!box.height||pointIn.some(n=>n<0||n>1))return;
    const previous=currentGradient(state),layer=isMask(state)||previous?state.layer:null;
    if(layer?.locked)return;
    let gradient;
    let handle='end',anchor=pointIn;
    const mask=isMask(state),space=layer?.gradientTransform;
    if(previous){
      const displayed=displayGradient(state,previous);
      const grabbed=event.target.dataset?.gradientHandle;
      const startDistance=distance(displayed.start,pointIn)*box.width,endDistance=distance(displayed.end,pointIn)*box.width;
      if(grabbed||Math.min(startDistance,endDistance)<=11){
        gradient=structuredClone(previous);
        handle=grabbed||(startDistance<=endDistance?'start':'end');
        anchor=displayed[handle==='start'?'end':'start'];
        if(mask&&layer.maskTransform)gradient.maskSpace??=[...maskTransformIdentity];
        if(mask&&layer.maskWarpSteps?.length)gradient.maskWarpIndex??=0;
      }
    }
    if(!gradient){
      const start=!mask&&space?mapPoint(pointIn,space,maskTransformIdentity):pointIn;
      const fields=previous&&(!mask||!layer.maskTransform&&!layer.maskWarpSteps?.length)?
        structuredClone(previous):{...style(state),...state.selection};
      gradient={...fields,start,end:start,
        ...(mask&&layer.maskTransform?{maskSpace:[...layer.maskTransform]}:{}),
        ...(mask&&layer.maskWarpSteps?.length?{maskWarpIndex:layer.maskWarpSteps.length}:{})};
    }
    gesture={origin:state.origin,layerId:layer?.id||crypto.randomUUID(),insertion:layer?null:state.insertion,
      before:previous,gradient,handle,anchor,space,mask,layer,pointer:event.pointerId,previewed:false};
    stage.setAttribute('data-gradient-dragging','');
    stage.focus({preventScroll:true});stage.setPointerCapture(event.pointerId);
    event.preventDefault();event.stopImmediatePropagation();
    sync();
  }
  function finish(write){
    if(!gesture)return false;
    const current=gesture;gesture=null;
    stage.removeAttribute('data-gradient-dragging');
    cancelAnimationFrame(frame);frame=0;
    if(stage.hasPointerCapture(current.pointer))stage.releasePointerCapture(current.pointer);
    if(write&&usable(current.gradient)&&JSON.stringify(current.before)!==JSON.stringify(current.gradient))
      void commit(operation(current.origin,current.layerId,current.gradient,current.insertion),current.origin,!!current.insertion);
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
