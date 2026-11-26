import {enhanceSelectMenu} from './paint-select.mjs';
import {canvasCoordinates,canvasPoint} from './image-canvas-coordinates.mjs';

export function createImageEdgeTool({stage,canvas,parameters,signal,settings={},context,apply,travel,loadMask,saveMask,onChange,onError}){
  const tools=document.createElement('div');tools.className='editor-toolbar document-edge-options';tools.hidden=true;
  const notice=document.createElement('span');notice.className='document-pen-notice';
  function number(label,min,max,value){
    const row=document.createElement('label'),input=document.createElement('input');
    row.textContent=label;input.setAttribute('aria-label',label);
    Object.assign(input,{type:'number',min,max,step:1,value});
    input.dataset.scrubNumber='';input.dataset.scrubSuffix=' px';
    input.onchange=onChange;row.append(input);tools.append(row);
    return input;
  }
  const radius=number('修边半径',2,512,settings.radius??140);
  const amount=number('边缘位移',-64,64,settings.amount??-20);
  amount.title='负值收边 · 正值扩边 · 0 软化';
  const select=(label,choices,initial)=>{
    const input=document.createElement('select');
    input.setAttribute('aria-label',label);
    for(const [id,name] of choices)input.append(new Option(name,id));
    input.value=initial;tools.append(input);enhanceSelectMenu(input);
    return input;
  };
  const method=select('修边方式',[['coverage','调整覆盖'],['guided','颜色引导']],settings.method??'coverage');
  const view=select('边缘检查',[['canvas','画布'],['original','原图'],['black','黑底'],['white','白底'],['overlay','红色叠加'],['mask','蒙版']],settings.view??'canvas');
  const iconButton=(text,action)=>{
    const button=document.createElement('button');button.type='button';button.textContent=text;button.onclick=action;tools.append(button);return button;
  };
  const foreground=iconButton('取样前景',()=>setSample('foreground')),background=iconButton('取样背景',()=>setSample('background'));
  const read=iconButton('读取蒙版',()=>void editMask(loadMask)),write=iconButton('应用到蒙版',()=>void editMask(saveMask));
  const inspection=document.createElement('img');inspection.className='document-edge-inspection';inspection.alt='';inspection.hidden=true;
  stage.append(inspection);
  let previewRequest=null,previewKey='',previewUrl=null,owner=null;
  let sample=null,references={};
  function setSample(target){sample=sample===target?null:target;sync();}
  method.onchange=view.onchange=()=>{sync();onChange();};
  function clearPreview(){
    previewRequest?.abort();previewRequest=null;previewKey='';inspection.hidden=true;stage.removeAttribute('data-edge-inspecting');
    if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;inspection.removeAttribute('src');}
  }
  signal.addEventListener('abort',clearPreview,{once:true});
  async function updateInspection(state){
    const source=active?state.source:state.coverageSource;
    const display=active?view.value:'coverage';
    if(!source||display==='canvas'){clearPreview();return;}
    const {origin,layerId,region}=source,selection=region&&{...region};
    if(selection)delete selection.outline;
    const key=JSON.stringify([origin.id,origin.revision,origin.documentId,layerId,display,selection]);
    inspection.style.width=canvas.style.width;inspection.style.height=canvas.style.height;
    inspection.style.transform=canvas.style.transform;
    inspection.style.imageRendering=canvas.style.imageRendering;
    if(key===previewKey)return;
    previewKey=key;previewRequest?.abort();
    const request=new AbortController();previewRequest=request;
    try{
      const response=await fetch('/api/projects/'+origin.id+'/paint/image-edge-view',{
        method:'POST',signal:request.signal,headers:{'Content-Type':'application/json'},
        body:JSON.stringify({revision:origin.revision,documentId:origin.documentId,layerId,view:display,selection})
      });
      if(!response.ok)throw Error((await response.json()).error);
      const blob=await response.blob();
      if(request!==previewRequest)return;
      if(previewUrl)URL.revokeObjectURL(previewUrl);
      previewUrl=URL.createObjectURL(blob);inspection.src=previewUrl;inspection.hidden=false;inspection.classList.toggle('selection-coverage',display==='coverage');stage.toggleAttribute('data-edge-inspecting',display!=='coverage');
    }catch(error){if(request===previewRequest&&!request.signal.aborted){inspection.hidden=true;stage.removeAttribute('data-edge-inspecting');onError(error);}}
  }
  async function editMask(action){
    try{
      const pending=action();
      sampling=true;sync();
      await pending;
    }
    catch(error){onError(error);}
    finally{sampling=false;sync();onChange();}
  }
  const undo=document.createElement('button'),redo=document.createElement('button');
  for(const [node,text,direction] of [[undo,'撤销修边','undo'],[redo,'重做修边','redo']]){
    node.type='button';node.textContent=text;node.onclick=()=>{travel(direction);stage.focus({preventScroll:true});sync();};
  }
  tools.append(undo,redo,notice);parameters.append(tools);
  const cursor=document.createElement('span');cursor.className='document-edge-cursor';cursor.hidden=true;stage.append(cursor);
  const ns='http://www.w3.org/2000/svg',guide=document.createElementNS(ns,'svg'),line=document.createElementNS(ns,'polyline');
  guide.setAttribute('class','document-edge-guide');guide.setAttribute('aria-hidden','true');guide.append(line);stage.append(guide);
  let active=false,gesture=null,sampling=false,lastPointer=null;
  const brush=()=>({radius:radius.valueAsNumber||140,amount:Number.isFinite(amount.valueAsNumber)?amount.valueAsNumber:-20});
  const getState=()=>({...brush(),method:method.value,view:view.value});
  function sync(){
    const state=context(),guided=method.value==='guided',available=state.usable&&state.selection&&(!guided||state.source);
    const target=state.source&&JSON.stringify([state.source.origin.id,state.source.origin.documentId,state.source.layerId]);
    if(target!==owner){owner=target;sample=null;references={};}
    foreground.hidden=background.hidden=!guided;
    foreground.setAttribute('aria-pressed',String(sample==='foreground'));
    background.setAttribute('aria-pressed',String(sample==='background'));
    foreground.textContent=references.foreground?'前景已取样':'取样前景';
    background.textContent=references.background?'背景已取样':'取样背景';
    foreground.disabled=background.disabled=!state.source||sampling||!!gesture;
    read.disabled=!state.hasMask||!state.usable||sampling||!!gesture;
    write.disabled=!state.canSaveMask||!available||sampling||!!gesture;
    void updateInspection(state);
    tools.hidden=!active;stage.toggleAttribute('data-edge-refine',active);
    notice.textContent=sampling?'正在处理…':sample?'在原图上单击取样':guided&&!state.source?'请选择要修边的图层':
      available?(guided?'沿局部边缘拖动 · 位移控制搜索范围':'沿边缘拖动 · 位移 0 可软化'):'先建立选区或读取当前蒙版';
    radius.disabled=amount.disabled=!!gesture||sampling;
    undo.disabled=sampling||!!gesture||!state.canUndo;redo.disabled=sampling||!!gesture||!state.canRedo;
    guide.toggleAttribute('hidden',!active||!gesture);
    cursor.hidden=!active||!available||sampling||!lastPointer;
    const host=stage.getBoundingClientRect(),coordinates=canvasCoordinates(canvas);
    const diameter=2*getState().radius*coordinates.width/4096;
    if(!cursor.hidden){
      cursor.style.left=lastPointer[0]-host.left+'px';cursor.style.top=lastPointer[1]-host.top+'px';
      cursor.style.width=cursor.style.height=diameter+'px';
    }
    if(gesture){
      const points=gesture.points.map(coordinates.toLocal(host));
      line.setAttribute('points',points.map(point=>point.join(',')).join(' '));
      line.setAttribute('stroke-width',diameter*1.6/2);
    }
  }
  function start(event){
    const state=context();
    if(!active||!state.usable||sampling||gesture||event.button!==0||event.target!==canvas)return;
    const point=canvasPoint(canvas,event);
    if(!point.every(n=>n>=0&&n<=1))return;
    if(sample&&state.source){
      references[sample]=point;sample=null;
      event.preventDefault();event.stopImmediatePropagation();sync();return;
    }
    if(!state.selection||method.value==='guided'&&!state.source)return;
    gesture={pointer:event.pointerId,points:[point],
      ...(method.value==='guided'?{guided:{layerId:state.source.layerId,...references}}:{})};
    stage.focus({preventScroll:true});stage.setPointerCapture(event.pointerId);
    event.preventDefault();event.stopImmediatePropagation();sync();
  }
  function move(event){
    if(!active)return;
    lastPointer=[event.clientX,event.clientY];
    if(gesture?.pointer===event.pointerId){
      const point=canvasPoint(canvas,event).map(n=>Math.max(0,Math.min(1,n))),previous=gesture.points.at(-1);
      if(Math.hypot(point[0]-previous[0],point[1]-previous[1])*4096>=2){
        if(gesture.points.length===2048)gesture.points=gesture.points.filter((_,index)=>index%2===0);
        gesture.points.push(point);
      }
      event.stopImmediatePropagation();
    }
    sync();
  }
  function cancel(){
    if(!gesture)return false;
    const {pointer}=gesture;gesture=null;
    if(stage.hasPointerCapture(pointer))stage.releasePointerCapture(pointer);
    sync();onChange();return true;
  }
  async function finish(event){
    if(gesture?.pointer!==event.pointerId)return;
    if(event.type!=='pointerup'){cancel();return;}
    move(event);
    const {points,guided}=gesture;
    gesture=null;
    if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);
    const pending=apply({points,...brush(),...guided});
    if(!pending){sync();return;}
    sampling=true;sync();
    try{await pending;}finally{sampling=false;sync();onChange();}
  }
  stage.addEventListener('pointerdown',start,{signal,capture:true});
  stage.addEventListener('pointermove',move,{signal,capture:true});
  stage.addEventListener('pointerleave',()=>{lastPointer=null;sync();},{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,finish,{signal,capture:true});
  function setActive(value){active=value;if(!active){cancel();sample=null;}sync();}
  return {sync,setActive,cancel,getState,isEditing:()=>!!gesture||sampling};
}
