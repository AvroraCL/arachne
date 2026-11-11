import {paintChannels,effectiveValues} from './paint-channels.mjs';
import {Vector3} from 'three';
import {setSelectValue} from './paint-select.mjs';

const $=id=>document.getElementById(id);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const vec=v=>new Vector3(...v);

export function createSurfaceTools({viewport,host,uvHost,context,preview,commit,place,sample,isHandHeld,uvClip,swapInk,onIdle=()=>{},elements=null,settingsKey:customKey=null,preserveUnavailableMode=false,stickySample=false,sampleAnyLayer=false}){
  const $=id=>elements?.[id]||document.getElementById(id);
  const gizmo=$('projector-gizmo');
  const radiusInput=$('brush-radius'),brushCursor=$('brush-cursor');
  const mirrorButton=$('brush-mirror'),mirrorCursor=$('mirror-cursor');
  const uvCanvas=$('live-uv'),uvCursor=$('uv-brush-cursor'),uvRadius=$('brush-uv-radius');
  const pressureControl=$('brush-uv-pressure'),presetControl=$('brush-preset');
  const hardness=$('brush-hardness'),opacity=$('brush-opacity');
  const sliders=[radiusInput,uvRadius,hardness,opacity],savedControls=[...sliders,pressureControl];
  const presets={hard:[.14,32,1,1],soft:[.25,72,.2,.55],scuff:[.08,20,.5,.35]};
  const settingsKey=customKey||'arachne-paint-brush-v1';
  let mode='orbit',beforeSample='orbit',gesture=null,mirrorX=false,hover=null,hoverFrame=null;
  const brushMode=()=>mode==='paint'||mode==='mask';

  function syncPreset(){
    const match=Object.entries(presets).find(([,values])=>values.every((value,i)=>value===Number(sliders[i].value)));
    const next=match?.[0]||'';
    if(presetControl.value!==next)setSelectValue(presetControl,next);
  }
  function saveBrush(){
    const settings=Object.fromEntries(savedControls.map(control=>[control.id||control.dataset.brushSetting,
      control.type==='checkbox'?control.checked:Number(control.value)]));
    try{localStorage.setItem(settingsKey,JSON.stringify({...settings,mirrorX}));}catch{}
    syncPreset();
  }
  function restoreBrush(){
    try{
      const settings=JSON.parse(localStorage.getItem(settingsKey));
      if(settings&&typeof settings==='object'){
        for(const control of savedControls){
          const value=settings[control.id||control.dataset.brushSetting];
          if(control.type==='checkbox'){
            if(typeof value==='boolean')control.checked=value;
          }else if(Number.isFinite(value)){
            control.value=clamp(value,Number(control.min),Number(control.max));
          }
        }
        mirrorX=settings.mirrorX===true;
      }
    }catch{}
    mirrorButton.setAttribute('aria-pressed',String(mirrorX));
    uvRadius.oninput();
    syncPreset();
  }

  function hideCursors(){
    hover=null;brushCursor.hidden=mirrorCursor.hidden=uvCursor.hidden=true;
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
    if(!brushMode()||gesture)return false;
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
  uvRadius.oninput=()=>{$('brush-uv-size').textContent=uvRadius.value+' px';};
  for(const control of savedControls)control.addEventListener('change',saveBrush);
  presetControl.onchange=()=>{
    const name=presetControl.value;
    if(!Object.hasOwn(presets,name))return;
    presets[name].forEach((value,i)=>{sliders[i].value=value;});
    uvRadius.oninput();
    scheduleCursors();
    saveBrush();
  };
  restoreBrush();
  function uvPoint(x,y){
    const bounds=uvCanvas.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return null;
    const u=(x-bounds.left)/bounds.width,v=(y-bounds.top)/bounds.height;
    return u>=0&&u<=1&&v>=0&&v<=1?[u,v]:null;
  }
  function updateUVCursor(event){
    const state=context(), {clientX:x,clientY:y}=event;
    uvCursor.hidden=true;
    if(!brushMode()||!state.uvEnabled||!state.layer?.visible||state.layer.locked||(mode==='paint'&&state.layer.kind!=='paint')||isHandHeld()||event.altKey||
       (event.buttons&&!gesture?.uv)||uvControl(event)||!uvPoint(x,y))return;
    const bounds=uvHost.getBoundingClientRect();
    const diameter=2*Number(uvRadius.value)/4096*uvCanvas.getBoundingClientRect().width;
    uvCursor.style.setProperty('--brush-diameter',Math.max(3,diameter)+'px');
    uvCursor.style.left=x-bounds.left+'px';
    uvCursor.style.top=y-bounds.top+'px';
    uvCursor.hidden=false;
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
      hideCursors();return;
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
    const writable=layer&&!layer.locked,canSample=!!layer&&(sampleAnyLayer||(writable&&layer.kind==='paint'));
    const unavailable=(mode==='paint'&&(!writable||layer.kind!=='paint'))||
      (mode==='sample'&&!canSample)||
      (['mask','fill'].includes(mode)&&!writable);
    if(unavailable&&!preserveUnavailableMode)mode='orbit';
    if((!enabled&&!uvEnabled)||!brushMode()||unavailable)hideCursors();
    uvHost.toggleAttribute('data-brushing',uvEnabled&&!!layer?.visible&&!unavailable&&(brushMode()||mode==='sample'));
    host.dataset.tool=mode;
    for(const tool of ['orbit','paint','mask','fill','sample'])$('surface-'+tool).setAttribute('aria-pressed',String(mode===tool));
    if(uvHost.hasAttribute('data-text-placement')||
       uvHost.dataset.selectionTool&&uvHost.dataset.selectionTool!=='none')$('surface-orbit').setAttribute('aria-pressed','false');
    $('surface-paint').disabled=!writable||layer.kind!=='paint'&&!state.maskTarget;
    const erasing=brushMode()&&$('brush-erase').checked;
    $('uv-eraser-tool').disabled=!writable||layer.kind!=='paint'&&!state.maskTarget;
    $('uv-eraser-tool').setAttribute('aria-pressed',String(erasing));
    if(uvEnabled&&erasing)for(const id of ['surface-paint','surface-mask'])$(id).setAttribute('aria-pressed','false');
    $('surface-sample').hidden=(!sampleAnyLayer&&layer?.kind!=='paint')||state.maskTarget;
    $('surface-sample').disabled=!canSample;
    if(state.brushColor||layer?.values.color)$('brush-ink-color').value=state.brushColor||layer.values.color;
    $('surface-mask').disabled=$('surface-fill').disabled=!writable;
    $('surface-brush').hidden=!['paint','mask'].includes(mode);
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
    mode=next;render();
  }
  function cancel({preserveMode=false}={}){
    const prior=gesture;
    gesture=null;
    if(preserveMode)render();else setMode(mode==='sample'?beforeSample:'orbit');
    if(prior){preview(null,prior.state);onIdle();}
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
  function strokeOp(g){
    return {op:'stroke',id:g.layerId,target:g.target,stroke:{...g.stroke,stamps:g.stroke.stamps.slice()}};
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
    return {values,channels,erase:$('brush-erase').checked};
  }
  function fillUV(rect,target,maskValue,polygon){
    const state=context();
    if(!state.uvEnabled||!state.layer?.visible||state.layer.locked||target==='material'&&state.layer.kind!=='paint')return null;
    const params=target==='mask'?{value:maskValue}:strokeInk(state.layer,target,state);
    if(!params)return null;
    if(target==='material')params.erase=false;
    return {op:'stroke',id:state.layer.id,target,stroke:{
      uv:true,rect,...(polygon?{polygon}:{}),opacity:Number($('brush-opacity').value),...params}};
  }
  function beginStroke(event,uv=false){
    const state=context();
    if(!(uv?state.uvEnabled:state.enabled)||!state.layer||state.layer.locked||!brushMode()||(mode==='paint'&&state.layer.kind!=='paint')||state.layer.visible===false)return;
    const target=mode==='paint'?'material':'mask',params=strokeInk(state.layer,target,state);
    if(!params)return;
    const clip=uv?uvClip():null;
    const pressure=event.pointerType==='pen'&&pressureControl.checked?clamp(event.pressure,0,1):null;
    gesture={pointer:event.pointerId,state,layerId:state.layer.id,target,uv,x:event.clientX,y:event.clientY,pressure,
      axisStart:uv&&event.shiftKey?[event.clientX,event.clientY]:null,
      stroke:{radius:uv?Number(uvRadius.value)/4096:Number(radiusInput.value),hardness:Number($('brush-hardness').value),
        opacity:Number($('brush-opacity').value),stamps:[],
        ...(uv?{uv:true,...clip}:mirrorX?{mirrorX}:{}),...params}};
    hideCursors();
    stamp(event.clientX,event.clientY,pressure);
    if(gesture.stroke.stamps.length)preview(strokeOp(gesture),state);
    event.target.focus({preventScroll:true});
    event.target.setPointerCapture(event.pointerId);
    event.preventDefault();event.stopImmediatePropagation();
  }
  function beginUV(event){
    if(event.button!==0||gesture||isHandHeld()||uvControl(event))return;
    const state=context();
    if(!state.uvEnabled)return;
    const uv=uvPoint(event.clientX,event.clientY);
    if(!uv)return;
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
      if(g.uv)updateUVCursor(g.axisStart?{clientX:x,clientY:y,buttons:event.buttons,altKey:event.altKey,target:event.target}:event);
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
    const g=gesture;
    if(g?.pointer!==event.pointerId)return;
    gesture=null;render();
    if(event.type==='pointerup'){
      if(g.stroke?.stamps.length)commit(strokeOp(g),g.state);
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
  uvHost.addEventListener('pointermove',updateUVCursor,true);
  uvHost.addEventListener('pointerleave',()=>{uvCursor.hidden=true;});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])uvHost.addEventListener(name,finish,true);
  const observer=new ResizeObserver(render);observer.observe(host);
  return {dispose(){cancel();observer.disconnect();hideCursors();},render,setMode,cancel,projectorAt,toggleMirror,adjustRadius,fillUV,isEditing:()=>!!gesture,
    getSettings:()=>({worldRadius:Number(radiusInput.value),uvRadius:Number(uvRadius.value),hardness:Number(hardness.value),
      opacity:Number(opacity.value),pressure:pressureControl.checked,mirror:mirrorX}),
    setSettings(settings,{persist=true}={}){
      [settings.worldRadius,settings.uvRadius,settings.hardness,settings.opacity].forEach((value,index)=>sliders[index].value=value);
      pressureControl.checked=settings.pressure;mirrorX=settings.mirror;
      mirrorButton.setAttribute('aria-pressed',String(mirrorX));uvRadius.oninput();if(persist)saveBrush();else syncPreset();render();
    },invertInk(){
    if(!['mask','fill'].includes(mode))return;
    if(swapInk){swapInk();return;}
    const ink=$('brush-ink');setSelectValue(ink,ink.value==='0'?'1':'0');
  }};
}
