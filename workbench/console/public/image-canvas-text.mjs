import {canvasCoordinates,canvasPoint,canvasMatrix} from './image-canvas-coordinates.mjs';
import {paragraphOrigin,textDefaults,textPreviewStyle,loadProjectFont} from './image-text-style.mjs';
import {compositionKey} from './text-input.mjs';
import {imagePlacement,imageQuadTransform,isMeshWarp,warpPoint} from './image-warp.mjs';

const limit=n=>Math.min(1,Math.max(0,n));
const inside=point=>point.every(n=>n>=0&&n<=1);

export function createImageCanvasText({stage,canvas,parameters,signal,context,preview,save,onChange,openProperties}){
  const form=document.createElement('form'),input=document.createElement('textarea'),status=document.createElement('output');
  form.className='document-inline-text';form.hidden=true;
  input.rows=1;input.maxLength=480;input.spellcheck=false;
  input.setAttribute('aria-label','画布文字');input.placeholder='输入文字';
  status.setAttribute('role','alert');status.className='document-inline-text-status';status.hidden=true;
  const overflow=document.createElement('span');
  overflow.className='document-inline-text-overflow';overflow.textContent='＋';overflow.hidden=true;
  overflow.title='文字超出段落框，请在文字设置中加高段落框';
  const resize=document.createElement('span');
  resize.className='document-inline-text-resize';resize.title='拖动调整段落框';
  resize.setAttribute('aria-hidden','true');resize.hidden=true;
  form.append(input,overflow,resize);stage.append(form,status);
  const tools=document.createElement('div');tools.className='editor-toolbar document-type-tools';tools.hidden=true;
  const hint=document.createElement('span');hint.textContent='单击输入文字 · 拖动建立段落框';
  const meshHint=document.createElement('span');meshHint.textContent='在输入框修改文字，画布实时预览网格变形';
  meshHint.hidden=true;
  function button(label,action){
    const item=document.createElement('button');item.type='button';item.textContent=label;item.onclick=action;return item;
  }
  const apply=button('应用文字',commit),cancel=button('取消文字',close);
  const properties=button('文字设置…',()=>{
    const state=context();
    if(state.layer?.text)openProperties(state.origin,state.layer);
  });
  tools.append(hint,apply,cancel,properties,meshHint);parameters.append(tools);
  let session=null,drag=null,resizing=null,previewTimer=null,composing=false;
  const meshEditing=()=>isMeshWarp(session?.layer?.warp);
  function queueMeshPreview(){
    clearTimeout(previewTimer);
    if(!meshEditing()||composing)return;
    const current=session;
    previewTimer=setTimeout(()=>{
      if(session===current&&!current.saving)preview({textDraft:{
        layerId:current.layer.id,content:input.value,box:current.style.box
      }});
    },120);
  }
  signal.addEventListener('abort',()=>clearTimeout(previewTimer),{once:true});
  function layout(){
    const state=context();
    tools.hidden=!state.active&&!session;
    apply.hidden=cancel.hidden=!session;
    hint.hidden=!!session;
    meshHint.hidden=!meshEditing();
    properties.hidden=!!session||!state.layer?.text;
    properties.disabled=!state.editable;
    form.hidden=!session&&!drag?.box;
    if(!session&&!drag?.box)return;
    const box=session?.style.box??drag?.box,style=session?.style??textDefaults;
    const at=canvasCoordinates(canvas).toLocal(stage.getBoundingClientRect());
    const origin=session?.point??drag.point;
    const warp=session?.layer?.warp,mesh=meshEditing();
    const width=box?.width??(warp&&!mesh?session.dimensions.width:Math.min(1600,Math.max(440,session?.dimensions?.width??0)));
    const height=box?.height??Math.max(style.fontSize*1.4,input.scrollHeight);
    const project=session?.placement
      ?pixels=>at(session.placement.toCanvas(sourcePoint(pixels)))
      :([x,y])=>at([origin[0]+x/4096,origin[1]+y/4096]);
    if(warp&&!mesh){
      const {dimensions,offset}=session;
      const screen=uv=>at(session.placement.toCanvas(warpPoint(warp,uv)));
      form.style.transform='matrix3d('+imageQuadTransform(screen,dimensions.width,dimensions.height).join(',')+') translate('+offset[0]+'px,'+offset[1]+'px)';
    }else if(mesh){
      const bounds=stage.getBoundingClientRect(),corners=warp.points.map(session.placement.toCanvas).map(at);
      const x=Math.min(...corners.map(p=>p[0])),top=Math.min(...corners.map(p=>p[1])),bottom=Math.max(...corners.map(p=>p[1]));
      const scale=Math.min(24/style.fontSize,(bounds.width-28)/width,(bounds.height-28)/height);
      const left=Math.max(14,Math.min(x,bounds.width-width*scale-14));
      const y=top>height*scale+28?top-height*scale-14:Math.min(bottom+14,bounds.height-height*scale-14);
      form.style.transform='translate('+left+'px,'+Math.max(14,y)+'px) scale('+scale+')';
      session.inputScale=scale;
    }else{
      form.style.transform='matrix('+canvasMatrix(project).join(',')+')';
    }
    form.toggleAttribute('data-mesh-edit',mesh);
    form.style.width=width+'px';form.style.height=height+'px';
    form.toggleAttribute('data-paragraph',!!box);
    input.hidden=!session;resize.hidden=!box||!session;
    input.wrap=box?'soft':'off';
    const {backgroundClip,backgroundImage,...ink}=textPreviewStyle(style,1,session?.state.fonts);
    Object.assign(input.style,ink,{color:style.effects?.gradient?.start??ink.color});
    input.style.height=box?'100%':'auto';
    if(!box&&session)input.style.height=Math.max(style.fontSize*1.4,input.scrollHeight)+'px';
    overflow.hidden=!box||!session||input.scrollHeight<=input.clientHeight+1;
    form.classList.toggle('is-sizing',!session);
  }
  function sourcePoint(pixels){
    const {offset,dimensions}=session;
    return pixels.map((value,i)=>(value+offset[i])/(i?dimensions.height:dimensions.width));
  }
  async function open(state,layer,point,box){
    const style={...textDefaults,color:state.color,...layer?.text,...(box?{box}:{})};
    if(state.fonts[style.font]){
      try{await loadProjectFont(state.origin.id,style.font,state.fonts[style.font]);}
      catch(error){status.textContent=error.message;status.hidden=false;return;}
      const current=context();
      if(signal.aborted||session||!current.usable||!current.active||current.origin.revision!==state.origin.revision||
         current.origin.id!==state.origin.id||current.layer?.id!==layer?.id)return;
    }
    const dimensions=layer&&state.assets[layer.asset],placement=layer&&imagePlacement(layer,state.assets);
    const offset=layer?.textOrigin??(layer?.text.box?paragraphOrigin(layer.text):[0,0]);
    session={state,layer,point,style,dimensions,placement,offset,saving:false};
    input.value=style.content;
    status.hidden=true;
    if(layer&&!meshEditing())preview({op:'image',action:'updateLayer',documentId:state.origin.documentId,layerId:layer.id,patch:{visible:false}});
    layout();
    input.focus({preventScroll:true});
    if(layer)input.select();
    onChange();
  }
  function close(){
    if(!session||session.saving)return false;
    clearTimeout(previewTimer);composing=false;
    const edited=session.layer,pointer=resizing?.pointer;
    session=null;resizing=null;status.hidden=true;
    if(pointer!==undefined&&stage.hasPointerCapture(pointer))stage.releasePointerCapture(pointer);
    if(edited)preview(null);
    layout();stage.focus({preventScroll:true});onChange();
    return true;
  }
  async function commit(){
    if(!session||session.saving)return;
    if(!input.value.trim()){
      if(!session.layer)close();
      else{status.textContent='请输入文字，或按 Esc 保留原文字';status.hidden=false;}
      return;
    }
    const {state,style,point,layer}=session;
    clearTimeout(previewTimer);
    status.hidden=true;
    session.saving=true;input.disabled=apply.disabled=cancel.disabled=true;
    try{
      if(layer&&input.value===layer.text.content&&JSON.stringify(style.box)===JSON.stringify(layer.text.box)){
        session.saving=false;close();return;
      }
      await save(state.origin,layer,layer?undefined:{...state.insertion,x:point[0],y:point[1],anchor:'start'},
        {...style,content:input.value});
      session.saving=false;close();
    }catch(error){
      session.saving=false;status.textContent=error.message;status.hidden=false;
      queueMeshPreview();
    }finally{
      input.disabled=apply.disabled=cancel.disabled=false;
      if(session)input.focus({preventScroll:true});
    }
  }
  form.onsubmit=event=>{event.preventDefault();void commit();};
  input.oninput=()=>{status.hidden=true;layout();queueMeshPreview();};
  input.addEventListener('compositionstart',()=>{composing=true;clearTimeout(previewTimer);},{signal});
  input.addEventListener('compositionend',()=>{composing=false;queueMeshPreview();},{signal});
  input.addEventListener('keydown',event=>{
    if(composing||compositionKey(event))return;
    if(event.key==='Escape'||event.key==='Enter'&&(event.metaKey||event.ctrlKey)){
      event.preventDefault();event.stopPropagation();
      if(event.key==='Escape')close();else void commit();
    }
  },{signal});
  resize.addEventListener('pointerdown',event=>{
    if(event.button!==0||session?.saving)return;
    const {placement,dimensions,style,layer,offset,inputScale}=session;
    const warp=layer?.warp;
    const pixels=inputScale?event=>[event.clientX/inputScale,event.clientY/inputScale]:event=>{
      const uv=canvasPoint(canvas,event);
      if(!placement)return uv.map(n=>n*4096);
      let local=placement.toLayer(uv);
      if(warp)local=warpPoint(warp,local,true,true);
      return local?.map((n,i)=>n*(i?dimensions.height:dimensions.width)-offset[i]);
    };
    const start=pixels(event);
    if(!start)return;
    resizing={pointer:event.pointerId,pixels,start,box:{...style.box}};
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();event.stopPropagation();
  },{signal});
  function resizeBox(event){
    if(resizing?.pointer!==event.pointerId)return;
    const {start,pixels,box}=resizing;
    const position=pixels(event);
    if(!position)return;
    const [dx,dy]=position.map((n,i)=>n-start[i]);
    const size=n=>Math.min(4096,Math.max(16,Math.round(n)));
    session.style.box={width:size(box.width+dx),height:size(box.height+dy)};
    layout();
    queueMeshPreview();
  }
  stage.addEventListener('pointermove',resizeBox,{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,event=>{
    if(resizing?.pointer!==event.pointerId)return;
    if(type==='pointerup')resizeBox(event);
    else{session.style.box=resizing.box;layout();queueMeshPreview();}
    resizing=null;
    if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);
  },{signal});
  stage.addEventListener('pointerdown',event=>{
    const state=context();
    if(!state.active||session||!state.usable||event.button!==0||event.target!==canvas)return;
    const start=canvasPoint(canvas,event);
    if(!inside(start))return;
    const layer=state.layer;
    if(!event.shiftKey&&state.editable&&layer?.visible&&layer.text){
      const placement=imagePlacement(layer,state.assets);
      const target=placement&&warpPoint(layer.warp,placement.toLayer(start),true);
      if(target&&inside(target)){open(state,layer,start);event.preventDefault();event.stopImmediatePropagation();return;}
    }
    if(!state.canInsert)return;
    drag={start,point:start,client:[event.clientX,event.clientY],pointer:event.pointerId};
    stage.setPointerCapture(event.pointerId);
    stage.focus({preventScroll:true});
    event.preventDefault();event.stopImmediatePropagation();
  },{signal});
  function updateDrag(event){
    if(drag?.pointer!==event.pointerId)return;
    const point=canvasPoint(canvas,event).map(limit),start=drag.start;
    const width=Math.round(Math.abs(point[0]-start[0])*4096),height=Math.round(Math.abs(point[1]-start[1])*4096);
    if(width>=16&&height>=16&&Math.hypot(event.clientX-drag.client[0],event.clientY-drag.client[1])>5){
      drag.point=point.map((n,i)=>Math.min(n,start[i]));drag.box={width,height};
    }else{drag.point=start;drag.box=null;}
    layout();
  }
  stage.addEventListener('pointermove',updateDrag,{signal});
  function endDrag(event){
    if(drag?.pointer!==event.pointerId)return;
    if(event.type==='pointerup')updateDrag(event);
    const {point,box}=drag;drag=null;
    if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);
    const state=context();
    if(event.type==='pointerup'&&state.active&&state.usable&&state.canInsert)open(state,null,point,box);
    else layout();
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,endDrag,{signal});
  return {layout,cancel:close,isEditing:()=>!!session||!!drag};
}
