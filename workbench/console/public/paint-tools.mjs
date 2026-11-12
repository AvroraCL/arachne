import {paintChannels,effectiveValues} from './paint-channels.mjs';
import {Vector3} from 'three';
import {setSelectValue} from './paint-select.mjs';

const $=id=>document.getElementById(id);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const vec=v=>new Vector3(...v);

export function createSurfaceTools({viewport,host,uvHost,context,preview,commit,place,sample,isHandHeld,uvClip,swapInk,
  onIdle=()=>{},elements=null,settingsKey:customKey=null,preserveUnavailableMode=false,stickySample=false,sampleAnyLayer=false,
  cloneTool=()=>null}){
  const $=id=>elements?.[id]||document.getElementById(id);
  const gizmo=$('projector-gizmo');
  const radiusInput=$('brush-radius'),brushCursor=$('brush-cursor');
  const mirrorButton=$('brush-mirror'),mirrorCursor=$('mirror-cursor');
  const uvCanvas=$('live-uv'),uvCursor=$('uv-brush-cursor'),uvRadius=$('brush-uv-radius');
  const pressureControl=$('brush-uv-pressure'),presetControl=$('brush-preset');
  const hardness=$('brush-hardness'),opacity=$('brush-opacity'),eraseControl=$('brush-erase');
  const flow=elements?.['brush-flow'],spacingControl=elements?.['brush-spacing'];
  const drawingBrush=!!flow;
  const tipNotice=drawingBrush?document.createElement('output'):null;
  if(tipNotice){
    tipNotice.className='document-brush-tip-readout';tipNotice.hidden=true;
    tipNotice.setAttribute('aria-label','笔尖调节');
    uvHost.append(tipNotice);
  }
  const sliders=[radiusInput,uvRadius,hardness,opacity];
  const savedControls=[...sliders,pressureControl,...(drawingBrush?[flow,spacingControl]:[])];
  const factor=control=>control.hasAttribute('data-brush-percent')?100:1;
  const amount=control=>Number(control.value)/factor(control);
  const readControl=control=>control.type==='checkbox'?control.checked:amount(control);
  const writeControl=(control,value)=>{
    if(control.type==='checkbox')control.checked=value;
    else control.value=clamp(value*factor(control),Number(control.min),Number(control.max));
  };
  const initialControls=savedControls.map(readControl);
  const presets={hard:[.14,32,1,1],soft:[.25,72,.2,.55],scuff:[.08,20,.5,.35]};
  const settingsKey=customKey||'arachne-paint-brush-v1';
  let profile=drawingBrush&&eraseControl.checked?'eraser':'paint',brushAnchor=null;
  const profileKey=()=>settingsKey+(profile==='paint'?'':':'+profile);
  let mode='orbit',beforeSample='orbit',gesture=null,tipGesture=null,mirrorX=false,hover=null,hoverFrame=null,uvHover=null;
  const brushMode=()=>mode==='paint'||mode==='mask'||mode==='clone';
  const pixelBrush=()=>mode==='paint'||mode==='clone';
  uvCursor.hidden=true;
  uvCursor.setAttribute('aria-hidden','true');

  function syncPreset(){
    const match=Object.entries(presets).find(([,values])=>values.every((value,i)=>value===amount(sliders[i])));
    const next=match?.[0]||'';
    if(presetControl.value!==next)setSelectValue(presetControl,next);
  }
  function saveBrush(){
    const settings=Object.fromEntries(savedControls.map(control=>[control.id||control.dataset.brushSetting,readControl(control)]));
    try{localStorage.setItem(profileKey(),JSON.stringify({...settings,mirrorX}));}catch{}
    syncPreset();
  }
  function restoreBrush(){
    savedControls.forEach((control,index)=>writeControl(control,initialControls[index]));
    mirrorX=false;
    try{
      const settings=JSON.parse(localStorage.getItem(profileKey()));
      if(settings&&typeof settings==='object'){
        for(const control of savedControls){
          const value=settings[control.id||control.dataset.brushSetting];
          if(control.type==='checkbox'?typeof value==='boolean':Number.isFinite(value))writeControl(control,value);
        }
        mirrorX=settings.mirrorX===true;
      }
    }catch{}
    mirrorButton.setAttribute('aria-pressed',String(mirrorX));
    uvRadius.oninput();
    syncPreset();
  }

  function hideSurfaceCursors(){
    hover=null;brushCursor.hidden=mirrorCursor.hidden=true;
  }
  function setUVCursorVisible(visible){
    uvCursor.hidden=!visible;
    uvHost.toggleAttribute('data-uv-brush-cursor',visible);
  }
  function clearUVCursor(){
    uvHover=null;
    if(tipGesture){drawTipGesture();return;}
    setUVCursorVisible(false);
    if(mode==='clone')cloneTool()?.track(null);
  }
  function hideCursors(){
    hideSurfaceCursors();
    clearUVCursor();
  }
  function toggleMirror(){
    if(!brushMode()||gesture)return;
    mirrorX=!mirrorX;
    mirrorButton.setAttribute('aria-pressed',String(mirrorX));
    scheduleCursors();
    saveBrush();
  }
  mirrorButton.onclick=toggleMirror;
  function adjustRadius(direction,uv=false){
    if(!brushMode()||gesture||tipGesture)return false;
    if(uv){
      const value=Number(uvRadius.value);
      uvRadius.value=clamp(value+direction*Math.max(1,Math.round(value*.15)),Number(uvRadius.min),Number(uvRadius.max));
      uvRadius.oninput();
      saveBrush();
      return true;
    }
    const value=Number(radiusInput.value);
    const delta=Math.max(.01,Math.round(value*.15*100)/100);
    radiusInput.value=clamp(value+direction*delta,Number(radiusInput.min),Number(radiusInput.max)).toFixed(2);
    scheduleCursors();saveBrush();return true;
  }
  radiusInput.oninput=scheduleCursors;
  uvRadius.oninput=()=>{
    $('brush-uv-size').textContent=uvRadius.value+' px';
    refreshUVCursor();
  };
  for(const control of savedControls)control.addEventListener('change',saveBrush);
  presetControl.onchange=()=>{
    const name=presetControl.value;
    if(!Object.hasOwn(presets,name))return;
    presets[name].forEach((value,i)=>writeControl(sliders[i],value));
    uvRadius.oninput();
    scheduleCursors();
    saveBrush();
  };
  restoreBrush();
  function uvPoint(x,y,bounds=uvCanvas.getBoundingClientRect()){
    if(!bounds.width||!bounds.height)return null;
    const u=(x-bounds.left)/bounds.width,v=(y-bounds.top)/bounds.height;
    return u>=0&&u<=1&&v>=0&&v<=1?[u,v]:null;
  }
  function trackUVCursor(event,x=event.clientX,y=event.clientY){
    uvHover={x,y,buttons:event.buttons,sampling:event.altKey,overControls:uvControl(event)};
    refreshUVCursor();
  }
  function refreshUVCursor(state){
    if(tipGesture){drawTipGesture();return;}
    if(!uvHover||!brushMode())return setUVCursorVisible(false);
    state??=context();
    const {x,y,buttons,sampling,overControls}=uvHover;
    if(!state.uvEnabled||!state.layer?.visible||state.layer.locked||
       (pixelBrush()&&state.layer.kind!=='paint')||isHandHeld()||
       (buttons&&!gesture?.uv)||overControls){
      if(mode==='clone')cloneTool()?.track(null);
      return setUVCursorVisible(false);
    }
    const canvasBounds=uvCanvas.getBoundingClientRect(),bounds=uvHost.getBoundingClientRect();
    const point=uvPoint(x,y,canvasBounds);
    if(mode==='clone')cloneTool()?.track(point,gesture?.stroke?.clone?.offset,sampling);
    if(!point||sampling||x<bounds.left||x>bounds.right||y<bounds.top||y>bounds.bottom)
      return setUVCursorVisible(false);
    const radius=gesture?.uv?gesture.stroke.radius:Number(uvRadius.value)/4096;
    const diameter=2*radius*canvasBounds.width;
    uvCursor.style.setProperty('--brush-diameter',Math.max(3,diameter)+'px');
    uvCursor.toggleAttribute('data-small',diameter<6);
    uvCursor.style.left=x-bounds.left+'px';
    uvCursor.style.top=y-bounds.top+'px';
    setUVCursorVisible(true);
  }
  function uvControl(event){return event.target.closest('.uv-controls,#uv-wipe-control');}
  function showCursor(node,point,anchor,radius){
    const right=vec(viewport.viewFrame().right);
    const edge=viewport.screenPoint(vec(point).addScaledVector(right,radius).toArray())||
      viewport.screenPoint(vec(point).addScaledVector(right,-radius).toArray());
    const diameter=edge?2*Math.hypot(edge[0]-anchor[0],edge[1]-anchor[1]):2*host.clientWidth;
    node.style.setProperty('--brush-diameter',Math.max(5,diameter)+'px');
    node.style.left=anchor[0]+'px';node.style.top=anchor[1]+'px';
    node.hidden=false;
  }
  function updateCursors(event){
    if(!brushMode()||gesture||event.buttons||!event.target.matches('canvas')){
      hideSurfaceCursors();return;
    }
    hover=[event.clientX,event.clientY];
    scheduleCursors();
  }
  function scheduleCursors(){
    if(hoverFrame!==null)return;
    hoverFrame=requestAnimationFrame(()=>{
      hoverFrame=null;brushCursor.hidden=mirrorCursor.hidden=true;
      const state=context();
      if(!hover||!state.enabled||!state.layer?.visible||state.layer.locked||(mode==='paint'&&state.layer.kind!=='paint'))return;
      const hit=viewport.pickTargetUV(...hover);
      if(!hit)return;
      const radius=Number(radiusInput.value),source=viewport.screenPoint(hit.point);
      if(source)showCursor(brushCursor,hit.point,source,radius);
      if(!mirrorX||Math.abs(hit.point[0])<.0005)return;
      const point=[-hit.point[0],hit.point[1],hit.point[2]];
      const normal=[-hit.normal[0],hit.normal[1],hit.normal[2]];
      const anchor=viewport.screenPoint(point);
      if(!anchor)return;
      const bounds=host.getBoundingClientRect();
      const counterpart=viewport.pickTargetUV(bounds.left+anchor[0],bounds.top+anchor[1]);
      const tolerance=Math.min(.02,radius*.15);
      if(!counterpart||vec(counterpart.point).distanceTo(vec(point))>tolerance||
         vec(counterpart.normal).dot(vec(normal))<.6)return;
      showCursor(mirrorCursor,point,anchor,radius);
    });
  }

  function render(){
    const state=context(),{layer,enabled,uvEnabled}=state;
    const writable=layer&&!layer.locked&&!state.busy,canSample=!!layer&&!state.busy&&(sampleAnyLayer||(writable&&layer.kind==='paint'));
    const unavailable=(pixelBrush()&&(!writable||layer.kind!=='paint'))||
      (mode==='sample'&&!canSample)||
      (['mask','fill'].includes(mode)&&!writable);
    if(unavailable&&!preserveUnavailableMode)mode='orbit';
    if((!enabled&&!uvEnabled)||!brushMode()||unavailable)hideSurfaceCursors();
    refreshUVCursor(state);
    uvHost.toggleAttribute('data-brushing',uvEnabled&&!!layer?.visible&&!unavailable&&(brushMode()||mode==='sample'));
    host.dataset.tool=mode;
    for(const tool of ['orbit','paint','mask','fill','sample'])$('surface-'+tool).setAttribute('aria-pressed',String(mode===tool));
    if(uvHost.matches('[data-text-placement],[data-gradient-tool],[data-shape-tool],[data-fill-tool]')||
       uvHost.dataset.selectionTool&&uvHost.dataset.selectionTool!=='none')$('surface-orbit').setAttribute('aria-pressed','false');
    $('surface-paint').disabled=!writable||layer.kind!=='paint'&&!state.maskTarget;
    const erasing=brushMode()&&$('brush-erase').checked;
    $('uv-eraser-tool').disabled=!writable||!state.maskTarget&&(layer.kind!=='paint'||drawingBrush&&!!layer.alphaLocked);
    $('uv-eraser-tool').setAttribute('aria-pressed',String(erasing));
    if(uvEnabled&&erasing)for(const id of ['surface-paint','surface-mask'])$(id).setAttribute('aria-pressed','false');
    $('surface-sample').hidden=(!sampleAnyLayer&&layer?.kind!=='paint')||state.maskTarget;
    $('surface-sample').disabled=!canSample;
    if(state.brushColor||layer?.values?.color)$('brush-ink-color').value=state.brushColor||layer.values.color;
    $('surface-mask').disabled=$('surface-fill').disabled=!writable;
    $('surface-brush').hidden=!brushMode();
    $('surface-material').hidden=mode!=='paint';
    $('surface-mask-ink').hidden=!['mask','fill'].includes(mode);
    $('surface-fill-region').hidden=mode!=='fill';
    $('surface-hint').textContent=mode==='sample'?(stickySample?'点击取样':'点击取样 · Esc 返回'):
      mode==='place'?'点选机体表面放置贴花 · Esc 取消':
      mode==='fill'?'点击表面填充 · X 切换遮盖与恢复':'';
    const projector=gesture?.projector||layer?.projector;
    const anchor=projector&&layer.projectionCurrent!==false&&enabled&&writable&&mode==='orbit'&&
      (gesture?.projector||vec(viewport.viewFrame().normal).dot(vec(projector.normal))>-.25)&&viewport.screenPoint(projector.center);
    gizmo.hidden=!anchor;
    if(anchor){
      gizmo.style.left=anchor[0]+'px';
      gizmo.style.top=anchor[1]+'px';
    }
  }
  function setMode(next){
    if(next==='sample'&&!stickySample){
      if(mode==='sample')next=beforeSample;
      else beforeSample=mode;
    }
    const nextProfile=next==='clone'?'clone':eraseControl.checked?'eraser':'paint';
    if(drawingBrush&&profile!==nextProfile){
      profile=nextProfile;
      restoreBrush();
    }
    mode=next;render();
  }
  function cancel({preserveMode=false}={}){
    const prior=gesture;
    gesture=null;
    const adjusting=finishTipGesture(false);
    clearUVCursor();
    if(preserveMode)render();else setMode(mode==='sample'?beforeSample:'orbit');
    if(prior){preview(null,prior.state);onIdle();}
    return !!prior||adjusting;
  }
  function projectorAt(hit){
    const view=viewport.viewFrame();
    const normal=vec(view.normal).normalize(),up=vec(view.up).normalize();
    const size=clamp(view.radius*.16,.1,4);
    return {center:hit.point,normal:normal.toArray(),up:up.toArray(),size,depth:size*.32,rotation:0};
  }
  function stamp(x,y,pressure){
    const stamps=gesture.stroke.stamps;
    if(stamps.length>=1024)return;
    let sample;
    if(gesture.uv){
      const uv=uvPoint(x,y);
      if(!uv)return;
      sample=uv.map(n=>+n.toFixed(6));
    }else{
      const hit=viewport.pickTargetUV(x,y);
      if(!hit)return;
      const previous=stamps.at(-1);
      if(previous&&(pressure===null||Math.abs(pressure-previous[6])<.03)&&
         vec(previous.slice(0,3)).distanceTo(vec(hit.point))<gesture.stroke.radius*.12)return;
      sample=[...hit.point,...hit.normal].map(n=>+n.toFixed(5));
    }
    if(pressure!==null)sample.push(+pressure.toFixed(4));
    stamps.push(sample);
  }
  function drawingStamp(g,x,y,pressure){
    const {stamps}=g.stroke,uv=uvPoint(x,y);
    if(!uv){g.lifted=true;return false;}
    const sample=uv.map(value=>+value.toFixed(6)),last=stamps.at(-1);
    if(pressure!==null)sample.push(+pressure.toFixed(4));
    if(!g.lifted&&last&&Math.hypot(sample[0]-last[0],sample[1]-last[1])<.25/4096&&
       Math.abs((sample[2]??1)-(last[2]??1))<.01)return false;
    if(stamps.length>=2048){
      // Keep the ends of every subpath while thinning unusually long gestures.
      const starts=new Set(g.stroke.breaks),compacted=[],breaks=[];
      for(let i=0;i<stamps.length;i++){
        if(starts.has(i))breaks.push(compacted.length);
        if(i%2===0||starts.has(i)||starts.has(i+1)||i===stamps.length-1)compacted.push(stamps[i]);
      }
      g.stroke.stamps=compacted;
      g.stroke.breaks=breaks;
    }
    if(g.lifted&&g.stroke.stamps.length&&g.stroke.breaks.length<64)g.stroke.breaks.push(g.stroke.stamps.length);
    g.lifted=false;
    g.stroke.stamps.push(sample);
    return true;
  }
  function strokeOp(g){
    const {breaks,...stroke}=g.stroke;
    return {op:'stroke',id:g.layerId,target:g.target,stroke:{...stroke,stamps:stroke.stamps.slice(),...(breaks?.length?{breaks:breaks.slice()}:{})}};
  }
  function transformOp(g){
    return {op:'update',id:g.layerId,patch:{projector:g.projector}};
  }
  function strokeInk(layer,target,state=context()){
    if(target==='mask')return {value:state.maskValue??Number($('brush-ink').value)};
    const sampled=state.sampledMaterial;
    const channels=Object.fromEntries(paintChannels.map(name=>[name,layer.channels[name]===true&&(!!sampled||($('brush-'+name)?.checked??true))]));
    if(!Object.values(channels).some(Boolean))return null;
    const values=sampled||{...effectiveValues(layer.values),color:state.brushColor||layer.values.color};
    return {values,channels,erase:eraseControl.checked};
  }
  function fillUV(rect,target,maskValue,shape={},options={}){
    const state=context();
    if(!state.uvEnabled||!state.layer?.visible||state.layer.locked||target==='material'&&state.layer.kind!=='paint')return null;
    const params=target==='mask'?{value:maskValue}:strokeInk(state.layer,target,state);
    if(!params)return null;
    if(target==='material')params.erase=false;
    if(target==='material'&&options.color)params.values={...params.values,color:options.color};
    return {op:'stroke',id:state.layer.id,target,stroke:{
      uv:true,rect,...shape,opacity:options.opacity??amount(opacity),...params}};
  }
  function beginStroke(event,uv=false){
    const state=context();
    if(!(uv?state.uvEnabled:state.enabled)||!state.layer||state.layer.locked||!brushMode()||(pixelBrush()&&state.layer.kind!=='paint')||state.layer.visible===false)return;
    const target=pixelBrush()?'material':'mask',params=strokeInk(state.layer,target,state);
    if(!params)return;
    const isDrawing=uv&&drawingBrush;
    if(isDrawing&&(amount(opacity)===0||target==='material'&&params.erase&&state.layer.alphaLocked))return;
    const clone=mode==='clone'?cloneTool()?.prepare(uvPoint(event.clientX,event.clientY),state):null;
    if(mode==='clone'&&!clone)return;
    const clip=uv?uvClip():null;
    const pressure=event.pointerType==='pen'&&pressureControl.checked?clamp(event.pressure,0,1):null;
    const anchorKey=isDrawing&&!clone?JSON.stringify([state.id,state.imageDocumentId,state.layer.id,target,eraseControl.checked]):null;
    gesture={pointer:event.pointerId,state,layerId:state.layer.id,target,uv,x:event.clientX,y:event.clientY,pressure,
      isDrawing,anchorKey,
      anchor:event.shiftKey&&anchorKey&&brushAnchor?.key===anchorKey?brushAnchor.point:null,
      axisStart:uv&&event.shiftKey?[event.clientX,event.clientY]:null,
      stroke:{radius:uv?Number(uvRadius.value)/4096:Number(radiusInput.value),hardness:amount(hardness),
        opacity:amount(opacity),stamps:[],
        ...(isDrawing?{flow:amount(flow),spacing:amount(spacingControl),breaks:[]}:{}),
        ...(clone?{clone:{offset:clone}}:{}),
        ...(uv?{uv:true,...clip}:mirrorX?{mirrorX}:{}),...params}};
    hideCursors();
    if(uv)trackUVCursor(event);
    if(isDrawing)drawingStamp(gesture,event.clientX,event.clientY,pressure);
    else stamp(event.clientX,event.clientY,pressure);
    if(gesture.stroke.stamps.length){
      const operation=strokeOp(gesture);
      if(gesture.anchor)operation.stroke.stamps.unshift(gesture.anchor);
      preview(operation,state);
    }
    event.target.focus({preventScroll:true});
    event.target.setPointerCapture(event.pointerId);
    event.preventDefault();event.stopImmediatePropagation();
  }
  function drawTipGesture(){
    const bounds=uvHost.getBoundingClientRect(),diameter=Math.max(3,2*amount(uvRadius)*uvCanvas.getBoundingClientRect().width/4096);
    const x=tipGesture.x-bounds.left,y=tipGesture.y-bounds.top;
    uvCursor.style.setProperty('--brush-diameter',diameter+'px');
    uvCursor.style.setProperty('--brush-hardness',Math.round(100*amount(hardness))+'%');
    uvCursor.removeAttribute('data-small');uvCursor.setAttribute('data-tip-adjust','');
    uvCursor.style.left=x+'px';uvCursor.style.top=y+'px';
    setUVCursorVisible(true);
    const label=tipNotice.textContent=`半径 ${uvRadius.value} px · 硬度 ${Math.round(amount(hardness)*100)}%`;
    if(tipNotice.getAttribute('aria-label')!==label)tipNotice.setAttribute('aria-label',label);
    tipNotice.style.left=clamp(x+16,4,Math.max(4,bounds.width-160))+'px';
    tipNotice.style.top=clamp(y+16,4,Math.max(4,bounds.height-32))+'px';
    tipNotice.hidden=false;
  }
  function startTipGesture(event){
    tipGesture={pointer:event.pointerId,x:event.clientX,y:event.clientY,radius:amount(uvRadius),hardness:amount(hardness)};
    uvHover=null;
    event.target.focus({preventScroll:true});
    uvHost.setPointerCapture(event.pointerId);
    drawTipGesture();
    event.preventDefault();event.stopImmediatePropagation();
  }
  function moveTipGesture(event){
    const precision=event.shiftKey ? .25 : 1;
    const dx=(event.clientX-tipGesture.x)*precision,dy=(event.clientY-tipGesture.y)*precision;
    writeControl(uvRadius,Math.round(tipGesture.radius*Math.exp(dx/105)));
    writeControl(hardness,Math.round((tipGesture.hardness-dy/160)*100)/100);
    uvRadius.oninput();
    event.preventDefault();event.stopImmediatePropagation();
  }
  function finishTipGesture(commit){
    const current=tipGesture;
    if(!current)return false;
    tipGesture=null;
    if(uvHost.hasPointerCapture(current.pointer))uvHost.releasePointerCapture(current.pointer);
    uvCursor.removeAttribute('data-tip-adjust');
    tipNotice.hidden=true;
    if(commit)saveBrush();
    else{writeControl(uvRadius,current.radius);writeControl(hardness,current.hardness);}
    uvRadius.oninput();clearUVCursor();
    return true;
  }
  function beginUV(event){
    if(gesture||tipGesture||isHandHeld()||uvControl(event))return;
    const state=context();
    if(!state.uvEnabled)return;
    const uv=uvPoint(event.clientX,event.clientY);
    if(!uv)return;
    if(drawingBrush&&brushMode()&&state.layer?.visible&&!state.layer.locked&&event.altKey&&
       (event.button===2||event.button===0&&event.ctrlKey)){
      startTipGesture(event);
      return;
    }
    if(event.button!==0)return;
    if(mode==='clone'&&event.altKey&&state.layer?.kind==='paint'&&!state.layer.locked){
      cloneTool()?.pick(uv,state);
      event.target.focus({preventScroll:true});
      event.preventDefault();event.stopImmediatePropagation();
      return;
    }
    if(mode==='sample'||event.altKey&&mode==='paint'){
      if(state.layer&&(sampleAnyLayer||(state.layer.kind==='paint'&&!state.layer.locked))&&sample({u:uv[0],v:uv[1]},state)&&mode==='sample'&&!stickySample)setMode(beforeSample);
      event.preventDefault();event.stopImmediatePropagation();
      return;
    }
    if(!event.altKey)beginStroke(event,true);
  }
  function begin(event){
    if(event.button!==0||event.altKey||gesture||!event.target.matches('canvas'))return;
    if(mode==='sample'){
      const state=context();
      if(state.enabled&&state.layer?.kind==='paint'&&!state.layer.locked){
        const hit=viewport.pickTargetUV(event.clientX,event.clientY);
        if(hit&&sample(hit,state)&&!stickySample)setMode(beforeSample);
      }
      event.preventDefault();event.stopImmediatePropagation();
      return;
    }
    if(mode==='fill'){
      const state=context();
      if(!state.enabled||!state.layer?.visible||state.layer.locked)return;
      event.target.focus({preventScroll:true});
      const hit=viewport.pickTargetUV(event.clientX,event.clientY);
      if(hit){
        const stroke={region:$('fill-region').value,hit:[...hit.point,...hit.normal],value:Number($('brush-ink').value),opacity:1};
        commit({op:'stroke',id:state.layer.id,target:'mask',stroke},state);
      }
      event.preventDefault();event.stopImmediatePropagation();
      return;
    }
    if(mode!=='place'){beginStroke(event);return;}
    const state=context();
    if(!state.enabled)return;
    const hit=viewport.pickTargetUV(event.clientX,event.clientY);
    if(hit)place(projectorAt(hit),hit);
    event.preventDefault();event.stopImmediatePropagation();
  }
  function move(event){
    if(tipGesture?.pointer===event.pointerId){moveTipGesture(event);return;}
    const g=gesture;
    if(g?.pointer!==event.pointerId)return;
    let x=event.clientX,y=event.clientY;
    if(g.axisStart){
      const [originX,originY]=g.axisStart,deltaX=x-originX,deltaY=y-originY;
      if(g.axis===undefined&&Math.hypot(deltaX,deltaY)>=2)g.axis=Math.abs(deltaX)>=Math.abs(deltaY)?'x':'y';
      if(g.axis!=='x')x=originX;
      if(g.axis!=='y')y=originY;
    }
    const dx=x-g.x,dy=y-g.y;
    if(g.stroke){
      if(g.uv)trackUVCursor(event,x,y);
      if(g.isDrawing){
        const pressure=g.pressure===null?null:clamp(event.pressure,0,1);
        const events=g.axisStart?[]:event.getCoalescedEvents?.()||[];
        let added=false;
        if(g.anchor&&Math.hypot(event.clientX-g.x,event.clientY-g.y)>=3)g.anchor=null;
        if(!g.anchor){
          for(const point of events)added=drawingStamp(g,point.clientX,point.clientY,
            pressure===null?null:clamp(point.pressure,0,1))||added;
          added=drawingStamp(g,x,y,pressure)||added;
        }
        g.pressure=pressure;
        if(added)preview(strokeOp(g),g.state);
        event.preventDefault();event.stopImmediatePropagation();
        return;
      }
      const spacing=g.uv?Math.max(.35,g.stroke.radius*uvCanvas.getBoundingClientRect().width*.35):3;
      const distance=Math.hypot(dx,dy);
      const pressure=g.pressure===null?null:clamp(event.pressure,0,1);
      if(g.uv&&distance<spacing&&(pressure===null||Math.abs(pressure-g.pressure)<.03))return;
      const steps=Math.max(1,Math.min(1024,Math.ceil(distance/spacing)));
      const length=g.stroke.stamps.length;
      for(let i=1;i<=steps;i++){
        const fraction=i/steps;
        const strength=pressure===null?null:g.pressure+(pressure-g.pressure)*fraction;
        stamp(g.x+dx*fraction,g.y+dy*fraction,strength);
      }
      g.x=x;g.y=y;g.pressure=pressure;
      if(length!==g.stroke.stamps.length)preview(strokeOp(g),g.state);
    }else{
      const original=g.original;
      const patch={};
      if(g.tool==='move'){
        const hit=viewport.pickTargetUV(event.clientX-g.offset[0],event.clientY-g.offset[1]);
        if(hit)patch.center=hit.point;
        else return;
      }else if(g.tool==='scale')patch.size=clamp(original.size*Math.exp(dx/130),.02,40);
      else if(g.tool==='rotate')patch.rotation=clamp(original.rotation+dx,-36000,36000);
      else{
        const frame=viewport.viewFrame();
        const yaw=vec(frame.up).normalize(),pitch=vec(frame.right).normalize();
        const turn=v=>vec(v).applyAxisAngle(yaw,dx*.009).applyAxisAngle(pitch,dy*.009).normalize().toArray();
        patch.normal=turn(original.normal);patch.up=turn(original.up);
      }
      g.projector={...original,...patch};
      preview(transformOp(g),g.state);render();
    }
    event.preventDefault();event.stopImmediatePropagation();
  }
  function finish(event){
    if(tipGesture?.pointer===event.pointerId){
      finishTipGesture(event.type==='pointerup');onIdle();event.preventDefault();event.stopImmediatePropagation();
      return;
    }
    const g=gesture;
    if(g?.pointer!==event.pointerId){
      if(event.currentTarget===uvHost&&event.type==='pointerup')trackUVCursor(event);
      return;
    }
    gesture=null;
    if(g.uv){
      if(event.type==='pointerup')trackUVCursor(event);
      else clearUVCursor();
    }
    render();
    if(event.type==='pointerup'){
      if(g.stroke?.stamps.length){
        if(g.anchorKey){
          brushAnchor={key:g.anchorKey,point:g.stroke.stamps.at(-1)};
          if(g.anchor)g.stroke.stamps.unshift(g.anchor);
        }
        commit(strokeOp(g),g.state);
      }
      else if(g.projector!==undefined&&g.projector!==g.original)commit(transformOp(g),g.state);
    }else preview(null,g.state);
    onIdle();
    event.preventDefault();event.stopImmediatePropagation();
  }
  gizmo.addEventListener('pointerdown',event=>{
    const tool=event.target.dataset.projectTool;
    const state=context(),original=state.layer?.projector;
    if(event.button!==0||!tool||!state.enabled||!original||state.layer.locked||gesture)return;
    const anchor=viewport.screenPoint(original.center);
    const bounds=host.getBoundingClientRect();
    gesture={pointer:event.pointerId,state,layerId:state.layer.id,tool,original,projector:original,
      x:event.clientX,y:event.clientY,offset:[event.clientX-anchor[0]-bounds.left,event.clientY-anchor[1]-bounds.top]};
    event.target.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  host.addEventListener('pointerdown',begin,true);
  host.addEventListener('pointermove',move,true);
  host.addEventListener('pointermove',updateCursors,true);
  host.addEventListener('pointerleave',hideCursors);
  for(const name of ['pointerup','pointercancel','lostpointercapture'])host.addEventListener(name,finish,true);
  host.addEventListener('viewport-camera',()=>{hideCursors();render();});
  uvHost.addEventListener('pointerdown',beginUV,true);
  uvHost.addEventListener('pointermove',move,true);
  uvHost.addEventListener('pointerenter',event=>trackUVCursor(event));
  uvHost.addEventListener('pointermove',event=>{if(!gesture?.uv)trackUVCursor(event);},true);
  uvHost.addEventListener('pointerleave',clearUVCursor);
  if(drawingBrush)uvHost.addEventListener('contextmenu',event=>{
    if(brushMode()&&(event.altKey||tipGesture))event.preventDefault();
  });
  for(const name of ['pointerup','pointercancel','lostpointercapture'])uvHost.addEventListener(name,finish,true);
  const observer=new ResizeObserver(render);observer.observe(host);
  return {dispose(){cancel();observer.disconnect();hideCursors();},render,setMode,cancel,projectorAt,toggleMirror,adjustRadius,fillUV,refreshUVCursor,isEditing:()=>!!gesture||!!tipGesture,
    getSettings:()=>({worldRadius:Number(radiusInput.value),uvRadius:Number(uvRadius.value),hardness:amount(hardness),
      opacity:amount(opacity),pressure:pressureControl.checked,mirror:mirrorX}),
    setSettings(settings,{persist=true}={}){
      [settings.worldRadius,settings.uvRadius,settings.hardness,settings.opacity].forEach((value,index)=>writeControl(sliders[index],value));
      pressureControl.checked=settings.pressure;mirrorX=settings.mirror;
      mirrorButton.setAttribute('aria-pressed',String(mirrorX));uvRadius.oninput();if(persist)saveBrush();else syncPreset();render();
    },invertInk(){
    if(!['mask','fill'].includes(mode))return;
    if(swapInk){swapInk();return;}
    const ink=$('brush-ink');setSelectValue(ink,ink.value==='0'?'1':'0');
  }};
}
