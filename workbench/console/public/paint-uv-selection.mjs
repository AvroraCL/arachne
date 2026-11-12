import {uvShapePayload,maxUVFeather} from './uv-selection-region.mjs';
import {canvasUVRect,uvBounds,uvCorners,uvSelectionModes,selectionContours,combineUVSelections,offsetUVSelection} from './uv-selection-geometry.mjs';

const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const radians=degrees=>degrees*Math.PI/180;
const rotate=([x,y],angle)=>[x*Math.cos(angle)-y*Math.sin(angle),x*Math.sin(angle)+y*Math.cos(angle)];
const normalizeAngle=angle=>((angle+180)%360+360)%360-180;
const center=([left,top,right,bottom])=>[(left+right)/2,(top+bottom)/2];
const rectFrom=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
const shapePath=(rings,map)=>rings.map(ring=>'M'+ring.map(point=>map(point).join(',')).join(' L')+' Z').join(' ');
const resolution=4096;
const ellipseUnit=Array.from({length:192},(_,i)=>{
  const angle=2*Math.PI*i/192;
  return [(1+Math.cos(angle))/2,(1+Math.sin(angle))/2];
});
const ellipse=([left,top,right,bottom])=>ellipseUnit.map(([u,v])=>[
  clamp(left+u*(right-left),left,right),clamp(top+v*(bottom-top),top,bottom)
]);

function imageBounds(image){
  const [w,h]=image.size,unit=image.scale/Math.max(w,h);
  const halfWidth=w*unit*Math.abs(image.stretch[0])/2,halfHeight=h*unit*Math.abs(image.stretch[1])/2;
  return [image.x-halfWidth,image.y-halfHeight,image.x+halfWidth,image.y+halfHeight];
}

export function createUVSelection({pane,canvas,context,isHandHeld,activate,preview,commit,fillOperation,onTransformState=()=>{},
  selectionMode='replace',selectionFeather=0,onMode=()=>{},onError=()=>{},elements=null}) {
  const $=id=>elements?.[id]||document.getElementById(id);
  const overlay=$('uv-selection-overlay'), border=$('uv-selection-border'), handles=$('uv-selection-handles');
  const lassoBorder=$('uv-lasso-border');
  const baseBorder=elements?.['uv-selection-base'];
  const modeControls=elements?.selectionModes||[];
  const inverseButton=elements?.['uv-selection-inverse'];
  const featherControl=elements?.['uv-selection-feather'];
  const selectTool=$('uv-select-tool'),lassoTool=$('uv-lasso-tool'),transformTool=$('uv-transform-tool');
  const ellipseTool=elements?.['uv-ellipse-tool'];
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
  let tool='none',region=null,owner=null,draft=null,gesture=null,lastDeselected=null;
  let combination=uvSelectionModes.includes(selectionMode)?selectionMode:'replace';
  let feather=featherControl&&Number.isInteger(selectionFeather)?clamp(selectionFeather,0,maxUVFeather):0;
  if(featherControl)featherControl.value=feather;
  const selecting=()=>['rect','ellipse','lasso'].includes(tool);
  const sameOwner=(a,b)=>!!a&&!!b&&a.projectId===b.projectId&&
    (a.imageDocumentId||b.imageDocumentId?a.imageDocumentId===b.imageDocumentId:a.id===b.id);
  const sameEditOwner=(a,b)=>sameOwner(a,b)&&a.id===b.id;
  const assign=(next,state)=>{region=next;owner=next?state:null;};
  const softened=next=>next&&feather?{...next,feather}:next;
  const selectedRegion=state=>sameOwner(owner,state)?region:null;
  function point(event){
    const box=canvas.getBoundingClientRect();
    return [(event.clientX-box.left)/box.width,(event.clientY-box.top)/box.height];
  }
  function changed(){
    return draft&&(draft.angle!==0||draft.offset.some(n=>n!==0)||draft.scale.some(n=>n!==1));
  }
  function operation(){
    const {offset,scale,angle,copy,owner,region}=draft;
    if(owner.image){
      const image=owner.image;
      return {op:'update',id:owner.id,patch:{
        x:clamp(image.x+offset[0],0,1),y:clamp(image.y+offset[1],0,1),
        rotation:normalizeAngle(image.rotation+angle),
        uvScale:image.stretch.map((n,i)=>Math.sign(n*scale[i])*clamp(Math.abs(n*scale[i]),.05,8))
      }};
    }
    return {op:'transformUV',id:owner.id,transform:{rect:region.rect,...uvShapePayload(region),offset,scale,angle,copy,
      ...(owner.imageDocumentId?{interpolation:'linear'}:{})}};
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
    const state=context(),selected=selectedRegion(state),rect=selected?.rect;
    const visible=!!(selected||draft)&&state.active;
    pane.dataset.selectionTool=state.active?tool:'none';
    if(state.active)$('surface-orbit').setAttribute('aria-pressed',
      String(tool==='none'&&$('viewport').dataset.tool==='orbit'&&!pane.matches('[data-text-placement],[data-gradient-tool],[data-shape-tool],[data-fill-tool]')));
    selectTool.setAttribute('aria-pressed',String(tool==='rect'&&state.active));
    lassoTool.setAttribute('aria-pressed',String(tool==='lasso'&&state.active));
    ellipseTool?.setAttribute('aria-pressed',String(tool==='ellipse'&&state.active));
    transformTool.setAttribute('aria-pressed',String(!!draft&&state.active));
    transformTool.disabled=$('uv-transform-start').disabled=!(selected||state.image)||!state.canTransform;
    $('uv-transform-start').title=state.maskInspection?'蒙版检查中可框选并填充蒙版':
      state.canTransform?'自由变换 · V / ⌘T':'请选择图片或已有笔触的绘制层';
    overlay.toggleAttribute('hidden',!visible);
    options.hidden=!visible||!draft;
    onTransformState(!options.hidden);
    selectionOptions.hidden=!state.active||tool==='none'||!!draft;
    for(const control of modeControls){
      control.setAttribute('aria-pressed',String(combination===control.dataset.selectionMode));
      control.disabled=!!gesture;
    }
    if(featherControl)featherControl.disabled=!!gesture||!!draft||!state.active;
    $('uv-selection-size').textContent=selected
      ? Math.round((rect[2]-rect[0])*resolution)+' × '+Math.round((rect[3]-rect[1])*resolution)+' px'
      : {lasso:'沿边缘拖动，松开闭合选区',ellipse:'拖出椭圆 · Shift 正圆',rect:'拖出矩形 · Shift 正方形'}[tool]||'';
    $('uv-selection-clear').disabled=!selected;
    if(inverseButton)inverseButton.disabled=!state.active||!!gesture||!!draft;
    if(elements?.['uv-selection-fit'])elements['uv-selection-fit'].disabled=!selected||!!gesture||!!draft;
    eraseButton.disabled=!selected||!state.canClear||!!gesture;
    fillMaterial.disabled=!selected||!state.canFillMaterial||!!gesture;
    fillMask.disabled=!selected||!state.canFillMask||!!gesture;
    if(!visible)return;

    const uv=canvas.getBoundingClientRect(),host=pane.getBoundingClientRect();
    const project=([x,y])=>[uv.left-host.left+x*uv.width,uv.top-host.top+y*uv.height];
    const bounds=draft?.region.rect||rect;
    const [cx,cy]=center(bounds);
    const transform=([x,y])=>{
      if(!draft)return project([x,y]);
      const [u,v]=rotate([(x-cx)*draft.scale[0],(y-cy)*draft.scale[1]],radians(draftAngle(draft)));
      return project([cx+u+draft.offset[0],cy+v+draft.offset[1]]);
    };
    const points=uvCorners(bounds).map(transform);
    border.setAttribute('points',points.map(p=>p.join(',')).join(' '));
    const contours=selectionContours(draft?.region||selected);
    lassoBorder.style.display=contours.length?'':'none';
    if(contours.length)lassoBorder.setAttribute('d',shapePath(contours,transform));
    const base=gesture?.combination&&gesture.combination!=='replace'?gesture.before?.region:null;
    if(baseBorder){
      baseBorder.style.display=base?'':'none';
      if(base){
        const rings=selectionContours(base);
        baseBorder.setAttribute('d',shapePath(rings.length?rings:[uvCorners(base.rect)],project));
      }
    }
    overlay.toggleAttribute('data-transforming',!!draft);
    overlay.toggleAttribute('data-polygon',contours.length>0);
    overlay.toggleAttribute('data-combining',!!base);
    overlay.toggleAttribute('data-marquee',!draft&&selecting());
    overlay.toggleAttribute('data-move-selection',!draft&&selecting()&&combination==='replace'&&!gesture);
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
    if(!draft){
      if(!gesture)return false;
      const {before,pointer}=gesture;gesture=null;
      assign(before?.region,before?.owner);
      if(pane.hasPointerCapture(pointer))pane.releasePointerCapture(pointer);
      render();return true;
    }
    tool=draft.selectionTool;
    const pointer=gesture?.pointer;
    draft=null;gesture=null;
    if(pointer!==undefined&&pane.hasPointerCapture(pointer))pane.releasePointerCapture(pointer);
    preview(null);
    render();
    return true;
  }
  function clear(remember=false){
    cancel();
    if(remember&&region&&sameOwner(owner,context()))lastDeselected={region,owner};
    assign(null,null);render();
  }
  function stop(){
    cancel();tool='none';render();
  }
  function sync(){
    const state=context();
    if(owner&&!sameOwner(owner,state))clear();
    else if(draft&&(!sameEditOwner(draft.owner,state)||draft.owner.revision!==state.revision||!state.active))cancel();
    render();
  }
  function choose(shape='rect',{focus=true}={}){
    if(gesture||!context().interactive||!activate())return false;
    cancel();tool=shape;render();if(focus)pane.focus({preventScroll:true});
    return true;
  }
  function selectAll(shape='rect'){
    if(!context().active||!choose(selecting()?tool:shape))return false;
    assign({rect:canvasUVRect},context());render();
    return true;
  }
  function invert(){
    const state=context();
    if(!state.active||!state.interactive||gesture||draft)return false;
    const selected=selectedRegion(state),full={rect:canvasUVRect};
    try{assign(selected?softened(combineUVSelections(full,selected,'subtract')):full,state);}
    catch(error){onError(error);return false;}
    render();return true;
  }
  function reselect(){
    const state=context();
    if(!state.active||!state.interactive||gesture||draft||!sameOwner(lastDeselected?.owner,state))return false;
    assign(lastDeselected.region,state);render();return true;
  }
  function setCombination(next){
    if(!uvSelectionModes.includes(next)||combination===next)return;
    combination=next;onMode(next);render();
  }
  function start(){
    if(draft)return true;
    const state=context();
    const selected=selectedRegion(state);
    if(gesture||!state.interactive||!(selected||state.image)||!state.canTransform||!activate())return false;
    draft={owner:state,region:state.image?{rect:imageBounds(state.image)}:selected,
      selectionTool:tool,offset:[0,0],scale:[1,1],angle:0,copy:false};
    tool='transform';
    render();
    pane.focus({preventScroll:true});
    return true;
  }
  async function apply(){
    if(!draft||gesture)return false;
    if(!changed()){cancel();return true;}
    const op=operation(),state=draft.owner,previous=draft,marquee=region;
    draft=null;assign(null,null);tool=previous.selectionTool;render();
    if(await commit(op,state))return true;
    const latest=context();
    if(latest.active&&sameEditOwner(state,latest)&&state.revision===latest.revision){
      assign(marquee,state);draft=previous;tool='transform';
      update();
    }
    return false;
  }
  function erase(){
    const state=context(),selected=selectedRegion(state);
    if(!selected||!state.canClear||gesture||draft)return false;
    void commit({op:'clearUV',id:state.id,rect:selected.rect.slice(),...uvShapePayload(selected)},state);
    return true;
  }
  function fill(target){
    const state=context(),selected=selectedRegion(state);
    if(!selected||gesture||draft||
       !(target==='material'?state.canFillMaterial:state.canFillMask))return false;
    const op=fillOperation(selected.rect.slice(),target,Number(maskValue.value),uvShapePayload(selected));
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
      const selected=selectedRegion(state);
      if(!selected)return false;
      const {rect}=selected;
      const shift=move.map((value,i)=>clamp(value,-rect[i],1-rect[i+2]));
      assign(offsetUVSelection(selected,shift),state);
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
  if(ellipseTool)ellipseTool.onclick=()=>choose('ellipse');
  transformTool.onclick=$('uv-transform-start').onclick=start;
  $('uv-transform-cancel').onclick=cancel;
  $('uv-selection-clear').onclick=()=>clear(true);
  if(inverseButton)inverseButton.onclick=invert;
  if(featherControl){
    featherControl.oninput=()=>{
      const value=featherControl.valueAsNumber;
      if(!featherControl.validity.valid||!Number.isFinite(value))return;
      feather=value;
      const state=context(),selected=selectedRegion(state);
      if(selected){
        const {feather:previous,...geometry}=selected;
        assign(softened(geometry),state);
      }
      render();
    };
    featherControl.onchange=onMode;
  }
  for(const control of modeControls)control.onclick=()=>setCombination(control.dataset.selectionMode);
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
    const polygon=!final&&distance>0&&distance<3?[...gesture.path,cursor]:gesture.path.slice();
    region={rect:uvBounds(polygon),polygon};
  }

  function updateMarquee(p,shift){
    const {start,kind}=gesture,end=p.map(n=>clamp(n,0,1));
    if(shift){
      const deltas=end.map((n,i)=>n-start[i]);
      const signs=deltas.map(n=>n<0?-1:1);
      const size=Math.min(Math.max(...deltas.map(Math.abs)),...start.map((n,i)=>signs[i]<0?n:1-n));
      for(let i=0;i<2;i++)end[i]=start[i]+signs[i]*size;
    }
    const rect=rectFrom(start,end);
    region=kind==='ellipse'?{rect,polygon:ellipse(rect)}:{rect};
  }
  function lockShape(event){
    if(!event.shiftKey)gesture.shiftMode=false;
    return event.shiftKey&&!gesture.shiftMode;
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
      const selected=selectedRegion(state),before={region:selected,owner:state};
      const modifier=modeControls.length&&selected&&combination==='replace'&&(event.shiftKey||event.altKey);
      const mode=modifier?(event.shiftKey&&event.altKey?'intersect':event.shiftKey?'add':'subtract'):combination;
      if((event.target===border||event.target===lassoBorder)&&selected&&mode==='replace'&&!event.shiftKey){
        gesture={kind:'move-selection',pointer:event.pointerId,start,before};
      }else{
        const rect=rectFrom(start,start);
        assign(tool==='lasso'?{rect,polygon:[start]}:{rect},state);
        gesture={kind:tool,pointer:event.pointerId,start,path:tool==='lasso'?[start]:null,
          before,combination:mode,shiftMode:!!(modifier&&event.shiftKey)};
      }
    }else if(combination==='replace')clear(true);
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
    }else if(kind==='rect'||kind==='ellipse'){
      updateMarquee(p,lockShape(event));render();
    }else if(kind==='move-selection'){
      const {rect}=before.region,shift=p.map((n,i)=>clamp(n-start[i],-rect[i],1-rect[i+2]));
      region=offsetUVSelection(before.region,shift);
      render();
    }else if(kind==='move'){
      const delta=p.map((n,i)=>n-start[i]);
      if(event.shiftKey)delta[Math.abs(delta[0])>=Math.abs(delta[1])?1:0]=0;
      draft.offset=before.offset.map((n,i)=>clamp(n+delta[i],...offsetRange(before,i)));
      update();
    }else{
      const pivot=center(draft.region.rect).map((n,i)=>n+before.offset[i]);
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
    if(event.type==='pointerup'){
      if(previous.kind==='lasso')updateLasso(point(event),true);
      else if(previous.kind==='rect'||previous.kind==='ellipse')updateMarquee(point(event),lockShape(event));
    }
    gesture=null;
    if(['rect','ellipse','lasso'].includes(previous.kind)){
      const {before,combination:mode}=previous,{rect,polygon}=region;
      if(event.type!=='pointerup'){
        assign(before.region,before.owner);
      }else if(rect[2]-rect[0]<1/resolution||rect[3]-rect[1]<1/resolution||
               polygon&&new Set(polygon.map(p=>p.join(','))).size<3){
        assign(before.region,before.owner);
        if(mode==='replace')clear(true);
      }else{
        try{assign(softened(combineUVSelections(before.region,region,mode)),owner);}
        catch(error){assign(before.region,before.owner);onError(error);}
      }
      render();
    }else if(event.type!=='pointerup'&&previous.kind==='move-selection'){
      assign(previous.before.region,previous.before.owner);render();
    }else if(event.type!=='pointerup'&&previous.before){
      draft=previous.before;update();
    }
    event.stopImmediatePropagation();
  }
  for(const name of ['pointerup','pointercancel','lostpointercapture'])pane.addEventListener(name,end,true);
  const observer=new ResizeObserver(render);observer.observe(pane);
  return {dispose(){cancel();observer.disconnect();},choose,selectAll,invert,reselect,start,clear:()=>clear(true),erase,fill,nudge,stop,cancel,apply,sync,render,
    getFeather:()=>feather,
    clip:()=>{const selected=selectedRegion(context());return selected?{clip:selected.rect.slice(),...uvShapePayload(selected)}:null;},
    getCombination:()=>combination,hasSelection:()=>!!region,isTransforming:()=>!!draft,isDragging:()=>!!gesture};
}
