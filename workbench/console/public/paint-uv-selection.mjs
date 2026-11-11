const $=id=>document.getElementById(id);
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const radians=degrees=>degrees*Math.PI/180;
const rotate=([x,y],angle)=>[x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)];
const normalizeAngle=angle=>((angle+180)%360+360)%360-180;
const center=([left,top,right,bottom])=>[(left+right)/2,(top+bottom)/2];
const rectFrom=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
const polygonBounds=points=>[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),
  Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
const corners=([l,t,r,b])=>[[l,t],[r,t],[r,b],[l,b]];
const resolution=4096;

function imageBounds(image){
  const [w,h]=image.size,unit=image.scale/Math.max(w,h);
  const halfWidth=w*unit*Math.abs(image.stretch[0])/2,halfHeight=h*unit*Math.abs(image.stretch[1])/2;
  return [image.x-halfWidth,image.y-halfHeight,image.x+halfWidth,image.y+halfHeight];
}

export function createUVSelection({pane,canvas,context,isHandHeld,activate,preview,commit,fillOperation,onTransformState=()=>{},elements=null}) {
  const $=id=>elements?.[id]||document.getElementById(id);
  const overlay=$('uv-selection-overlay'), border=$('uv-selection-border'), handles=$('uv-selection-handles');
  const lassoBorder=$('uv-lasso-border');
  const selectTool=$('uv-select-tool'),lassoTool=$('uv-lasso-tool'),transformTool=$('uv-transform-tool');
  const options=$('uv-transform-options'), selectionOptions=$('uv-selection-options');
  const eraseButton=$('uv-selection-erase'), fillMaterial=$('uv-selection-fill-material'), fillMask=$('uv-selection-fill-mask');
  const maskValue=$('uv-selection-mask-value');
  const fields=[...options.querySelectorAll('[data-transform-field]')];
  const flipButtons=[$('uv-flip-x'),$('uv-flip-y')],copy=$('uv-transform-copy');
  const circles=['nw','ne','se','sw','rotate'].map(name=>{
    const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');
    circle.dataset.handle=name;
    circle.setAttribute('r',name==='rotate'?'5':'4');
    handles.append(circle);
    return circle;
  });
  let tool='none', rect=null, polygon=null, draft=null, owner=null, gesture=null;
  const selecting=()=>tool==='rect'||tool==='lasso';
  const sameOwner=(a,b)=>a?.id===b?.id&&a?.projectId===b?.projectId&&a?.imageDocumentId===b?.imageDocumentId;
  function point(event){
    const box=canvas.getBoundingClientRect();
    return [(event.clientX-box.left)/box.width,(event.clientY-box.top)/box.height];
  }
  function changed(){
    return draft&&(draft.angle!==0||draft.offset.some(n=>n!==0)||draft.scale.some(n=>n!==1));
  }
  function operation(){
    const {offset,scale,angle,copy,owner,rect:bounds,polygon:shape}=draft;
    if(owner.image){
      const image=owner.image;
      return {op:'update',id:owner.id,patch:{
        x:clamp(image.x+offset[0],0,1),y:clamp(image.y+offset[1],0,1),
        rotation:normalizeAngle(image.rotation+angle),
        uvScale:image.stretch.map((n,i)=>Math.sign(n*scale[i])*clamp(Math.abs(n*scale[i]),.05,8))
      }};
    }
    return {op:'transformUV',id:owner.id,transform:{rect:bounds,...(shape?{polygon:shape}:{}),offset,scale,angle,copy}};
  }
  function offsetRange(state,i){
    const image=state.owner.image;
    if(!image)return [-2,2];
    const center=i===0?image.x:image.y;
    return [-center,1-center];
  }
  function scaleRange(state,i){
    const magnitude=Math.abs(state.owner.image?.stretch[i]??1);
    return [.05/magnitude,8/magnitude];
  }
  function draftAngle(state){return (state.owner.image?.rotation??0)+state.angle;}
  function relativeScale(state,i,value){
    return Math.sign(state.scale[i])*clamp(value,...scaleRange(state,i));
  }
  function render(){
    const state=context(), selected=rect&&sameOwner(owner,state);
    const visible=!!(selected||draft)&&state.active;
    pane.dataset.selectionTool=state.active?tool:'none';
    if(state.active)$('surface-orbit').setAttribute('aria-pressed',
      String(tool==='none'&&$('viewport').dataset.tool==='orbit'));
    selectTool.setAttribute('aria-pressed',String(tool==='rect'&&state.active));
    lassoTool.setAttribute('aria-pressed',String(tool==='lasso'&&state.active));
    transformTool.setAttribute('aria-pressed',String(!!draft&&state.active));
    transformTool.disabled=$('uv-transform-start').disabled=!(selected||state.image)||!state.canTransform;
    $('uv-transform-start').title=state.maskInspection?'蒙版检查中可框选并填充蒙版':
      state.canTransform?'自由变换 · V / ⌘T':'请选择图片或已有笔触的绘制层';
    overlay.toggleAttribute('hidden',!visible);
    options.hidden=!visible||!draft;
    onTransformState(!options.hidden);
    selectionOptions.hidden=!state.active||tool==='none'||!!draft;
    $('uv-selection-size').textContent=selected
      ? Math.round((rect[2]-rect[0])*resolution)+' × '+Math.round((rect[3]-rect[1])*resolution)+' px'
      : tool==='lasso'?'沿边缘拖动，松开闭合选区':'拖出矩形选区';
    $('uv-selection-clear').disabled=!selected;
    eraseButton.disabled=!selected||!state.canClear||!!gesture;
    fillMaterial.disabled=!selected||!state.canFillMaterial||!!gesture;
    fillMask.disabled=!selected||!state.canFillMask||!!gesture;
    if(!visible)return;

    const uv=canvas.getBoundingClientRect(),host=pane.getBoundingClientRect();
    const project=([x,y])=>[uv.left-host.left+x*uv.width,uv.top-host.top+y*uv.height];
    const bounds=draft?.rect||rect;
    const [cx,cy]=center(bounds);
    const transform=([x,y])=>{
      if(!draft)return project([x,y]);
      const [u,v]=rotate([(x-cx)*draft.scale[0],(y-cy)*draft.scale[1]],radians(draftAngle(draft)));
      return project([cx+u+draft.offset[0],cy+v+draft.offset[1]]);
    };
    const points=corners(bounds).map(transform);
    border.setAttribute('points',points.map(p=>p.join(',')).join(' '));
    const shape=draft?draft.polygon:polygon;
    lassoBorder.style.display=shape?'':'none';
    if(shape)lassoBorder.setAttribute('points',shape.map(transform).map(p=>p.join(',')).join(' '));
    overlay.toggleAttribute('data-transforming',!!draft);
    overlay.toggleAttribute('data-polygon',!!shape);
    overlay.toggleAttribute('data-marquee',!draft&&selecting());
    handles.style.display=draft?'':'none';
    if(!draft)return;
    const pivot=transform([cx,cy]);
    const rotationPositions=[[0,1],[2,3],[1,2],[3,0]].map(([a,b])=>{
      const midpoint=points[a].map((n,i)=>(n+points[b][i])/2);
      const [dx,dy]=midpoint.map((n,i)=>n-pivot[i]);
      const length=Math.hypot(dx,dy)||1;
      return [midpoint[0]+dx*23/length,midpoint[1]+dy*23/length];
    });
    const rotation=rotationPositions.find(([x,y])=>x>=8&&y>=8&&x<=host.width-8&&y<=host.height-8)
      || rotationPositions[0];
    [...points,rotation].forEach(([x,y],i)=>{
      circles[i].setAttribute('cx',x);circles[i].setAttribute('cy',y);
    });
    const values=[draft.offset[0]*resolution,draft.offset[1]*resolution,...draft.scale.map(n=>Math.abs(n)*100),draft.angle];
    fields.forEach((field,i)=>{
      const [min,max]=i<2?offsetRange(draft,i).map(n=>n*resolution):
        i<4?scaleRange(draft,i-2).map(n=>n*100):[-360,360];
      field.min=min;field.max=max;
      if(document.activeElement!==field)field.value=clamp(values[i],min,max);
    });
    flipButtons.forEach((button,i)=>button.setAttribute('aria-pressed',String(draft.scale[i]<0)));
    copy.checked=draft.copy;
    copy.closest('label').hidden=!!draft.owner.image;
  }
  function cancel(){
    if(!draft)return false;
    tool=draft.owner.image?'none':draft.polygon?'lasso':'rect';
    draft=null;gesture=null;
    preview(null);
    render();
    return true;
  }
  function clear(){
    cancel();rect=null;polygon=null;owner=null;gesture=null;render();
  }
  function stop(){
    cancel();tool='none';render();
  }
  function sync(){
    const state=context();
    if(owner&&!sameOwner(owner,state))clear();
    else if(draft&&(!sameOwner(draft.owner,state)||draft.owner.revision!==state.revision||!state.active))cancel();
    render();
  }
  function choose(shape='rect',{focus=true}={}){
    if(gesture||!context().interactive||!activate())return false;
    cancel();tool=shape;render();if(focus)pane.focus({preventScroll:true});
    return true;
  }
  function selectAll(){
    if(!context().active||!choose())return false;
    owner=context();rect=[0,0,1,1];polygon=null;render();
    return true;
  }
  function start(){
    if(draft)return true;
    const state=context();
    if(gesture||!state.interactive||!(rect||state.image)||!state.canTransform||!activate())return false;
    draft={owner:state,rect:state.image?imageBounds(state.image):rect,polygon:state.image?null:polygon,
      offset:[0,0],scale:[1,1],angle:0,copy:false};
    tool='transform';
    render();
    pane.focus({preventScroll:true});
    return true;
  }
  async function apply(){
    if(!draft||gesture)return false;
    if(!changed()){cancel();return true;}
    const op=operation(),state=draft.owner,previous=draft,marquee=rect,outline=polygon;
    draft=null;rect=null;polygon=null;owner=null;tool=state.image?'none':outline?'lasso':'rect';render();
    if(await commit(op,state))return true;
    const latest=context();
    if(latest.active&&sameOwner(state,latest)&&state.revision===latest.revision){
      owner=state;rect=marquee;polygon=outline;draft=previous;tool='transform';
      update();
    }
    return false;
  }
  function erase(){
    const state=context();
    if(!rect||!sameOwner(owner,state)||!state.canClear||gesture||draft)return false;
    void commit({op:'clearUV',id:state.id,rect:rect.slice(),...(polygon?{polygon}:{})},state);
    return true;
  }
  function fill(target){
    const state=context();
    if(!rect||!sameOwner(owner,state)||gesture||draft||
       !(target==='material'?state.canFillMaterial:state.canFillMask))return false;
    const op=fillOperation(rect.slice(),target,Number(maskValue.value),polygon);
    if(!op)return false;
    void commit(op,state);
    return true;
  }
  function nudge(dx,dy,step){
    const state=context();
    if(gesture||!state.interactive)return false;
    const move=[dx,dy].map(value=>value*step/resolution);
    if(draft){
      draft.offset=draft.offset.map((value,i)=>clamp(value+move[i],...offsetRange(draft,i)));
      update();
    }else{
      if(!rect||!sameOwner(owner,state))return false;
      const shift=move.map((value,i)=>clamp(value,-rect[i],1-rect[i+2]));
      rect=rect.map((value,i)=>value+shift[i%2]);
      if(polygon)polygon=polygon.map(point=>point.map((value,i)=>value+shift[i]));
      render();
    }
    return true;
  }
  function update(){
    if(changed())preview(operation());else preview(null);
    render();
  }

  selectTool.onclick=()=>choose('rect');
  lassoTool.onclick=()=>choose('lasso');
  transformTool.onclick=$('uv-transform-start').onclick=start;
  $('uv-transform-cancel').onclick=cancel;
  $('uv-selection-clear').onclick=clear;
  eraseButton.onclick=erase;
  fillMaterial.onclick=()=>fill('material');
  fillMask.onclick=()=>fill('mask');
  options.onsubmit=event=>{event.preventDefault();void apply();};
  flipButtons.forEach((button,i)=>button.onclick=()=>{
    if(!draft||gesture)return;
    draft.scale[i]*=-1;update();
  });
  copy.onchange=()=>{
    if(!draft||gesture)return;
    draft.copy=copy.checked;update();
  };
  fields.forEach((field,i)=>field.oninput=()=>{
    if(!draft||!field.validity.valid||!Number.isFinite(field.valueAsNumber))return;
    const value=field.valueAsNumber;
    if(i<2)draft.offset[i]=value/resolution;
    else if(i<4)draft.scale[i-2]=Math.sign(draft.scale[i-2])*value/100;
    else draft.angle=value;
    update();
  });

  function updateLasso(end,final=false){
    const box=canvas.getBoundingClientRect(),last=gesture.path.at(-1);
    const cursor=end.map(n=>clamp(n,0,1));
    const distance=Math.hypot((last[0]-cursor[0])*box.width,(last[1]-cursor[1])*box.height);
    if(distance&&(final||distance>=3)){
      if(gesture.path.length>=256)gesture.path=gesture.path.filter((_,i)=>i%2===0||i===255);
      gesture.path.push(cursor);
    }
    polygon=!final&&distance>0&&distance<3?[...gesture.path,cursor]:gesture.path.slice();
    rect=polygonBounds(polygon);
  }

  pane.addEventListener('pointerdown',event=>{
    const state=context();
    if(!state.interactive||gesture||tool==='none'||event.button!==0||isHandHeld()||
       event.target.closest('.uv-controls,#uv-wipe-control'))return;
    const start=point(event);
    if(draft){
      const kind=event.target.dataset.handle||(event.target===border?'move':null);
      if(kind)gesture={kind,pointer:event.pointerId,start,before:structuredClone(draft)};
    }else if(start.every(n=>n>=0&&n<=1)){
      if((event.target===border||event.target===lassoBorder)&&rect&&sameOwner(owner,state)&&!event.shiftKey){
        gesture={kind:'move-selection',pointer:event.pointerId,start,before:rect.slice(),polygon};
      }else if(tool==='lasso'){
        owner=state;rect=rectFrom(start,start);polygon=[start];
        gesture={kind:'lasso',pointer:event.pointerId,path:[start]};
      }else{
        owner=state;rect=rectFrom(start,start);polygon=null;
        gesture={kind:'rect',pointer:event.pointerId,start};
      }
    }else clear();
    if(gesture){
      pane.focus({preventScroll:true});
      pane.setPointerCapture(event.pointerId);
    }
    render();
    event.preventDefault();event.stopImmediatePropagation();
  },true);
  pane.addEventListener('pointermove',event=>{
    if(gesture?.pointer!==event.pointerId)return;
    const p=point(event),{kind,start,before}=gesture;
    if(kind==='lasso'){
      updateLasso(p);render();
    }else if(kind==='rect'){
      const end=p.map(n=>clamp(n,0,1));
      if(event.shiftKey){
        const deltas=end.map((n,i)=>n-start[i]);
        const signs=deltas.map(n=>n<0?-1:1);
        const size=Math.min(Math.max(...deltas.map(Math.abs)),...start.map((n,i)=>signs[i]<0?n:1-n));
        for(let i=0;i<2;i++)end[i]=start[i]+signs[i]*size;
      }
      rect=rectFrom(start,end);render();
    }else if(kind==='move-selection'){
      const shift=p.map((n,i)=>clamp(n-start[i],-before[i],1-before[i+2]));
      rect=before.map((n,i)=>clamp(n+shift[i%2],0,1));
      if(gesture.polygon)polygon=gesture.polygon.map(point=>point.map((n,i)=>clamp(n+shift[i],0,1)));
      render();
    }else if(kind==='move'){
      const delta=p.map((n,i)=>n-start[i]);
      if(event.shiftKey)delta[Math.abs(delta[0])>=Math.abs(delta[1])?1:0]=0;
      draft.offset=before.offset.map((n,i)=>clamp(n+delta[i],...offsetRange(before,i)));
      update();
    }else{
      const pivot=center(draft.rect).map((n,i)=>n+before.offset[i]);
      const a=start.map((n,i)=>n-pivot[i]),b=p.map((n,i)=>n-pivot[i]);
      if(kind==='rotate'){
        draft.angle=normalizeAngle(before.angle+(Math.atan2(b[1],b[0])-Math.atan2(a[1],a[0]))*180/Math.PI);
        if(event.shiftKey)draft.angle=Math.round(draft.angle/15)*15;
      }else{
        const previous=rotate(a,-radians(draftAngle(before))),next=rotate(b,-radians(draftAngle(before)));
        draft.scale=before.scale.map((n,i)=>relativeScale(before,i,Math.abs(n)*next[i]/(previous[i]||.00001)));
        if(event.shiftKey){
          const ratio=Math.min(draft.scale[0]/before.scale[0],draft.scale[1]/before.scale[1]);
          draft.scale=before.scale.map((n,i)=>relativeScale(before,i,Math.abs(n)*ratio));
        }
      }
      update();
    }
    event.stopImmediatePropagation();
  },true);
  function end(event){
    if(gesture?.pointer!==event.pointerId)return;
    const previous=gesture;
    if(previous.kind==='lasso'&&event.type==='pointerup')updateLasso(point(event),true);
    gesture=null;
    if(previous.kind==='rect'||previous.kind==='lasso'){
      if(event.type!=='pointerup'||rect[2]-rect[0]<1/resolution||rect[3]-rect[1]<1/resolution||
         (polygon&&new Set(polygon.map(p=>p.join(','))).size<3))clear();
      else render();
    }else if(event.type!=='pointerup'&&previous.kind==='move-selection'){
      rect=previous.before;polygon=previous.polygon;render();
    }else if(event.type!=='pointerup'&&previous.before){
      draft=previous.before;update();
    }
    event.stopImmediatePropagation();
  }
  for(const name of ['pointerup','pointercancel','lostpointercapture'])pane.addEventListener(name,end,true);
  const observer=new ResizeObserver(render);observer.observe(pane);
  return {dispose(){cancel();observer.disconnect();},choose,selectAll,start,clear,erase,fill,nudge,stop,cancel,apply,sync,render,
    clip:()=>rect&&sameOwner(owner,context())?{clip:rect.slice(),...(polygon?{polygon}:{})}:null,
    hasSelection:()=>!!rect,isTransforming:()=>!!draft,isDragging:()=>!!gesture};
}
