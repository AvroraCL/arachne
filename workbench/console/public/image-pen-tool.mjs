import {canvasCoordinates,canvasPoint} from './image-canvas-coordinates.mjs';
import {maxPathAnchors,penHandle,penSegments} from './image-pen-path.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';

const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
const svg=(tag,cls)=>{const node=document.createElementNS('http://www.w3.org/2000/svg',tag);if(cls)node.setAttribute('class',cls);return node;};
const copy=geometry=>structuredClone(geometry);
const inside=point=>point.every(n=>n>=0&&n<=1);
const clamp=n=>Math.min(1,Math.max(0,n));
const offset=(point,origin)=>point.map((n,i)=>n-origin[i]);
const negate=pair=>pair.map(n=>-n);
const modifier=event=>event.metaKey||event.ctrlKey;

export function createImagePenTool({stage,canvas,parameters,signal,context,save,remove,select,onError,onChange}){
  const tools=el('div','editor-toolbar document-pen-options'),notice=el('output','document-pen-notice');
  const saved=el('select');saved.setAttribute('aria-label','钢笔路径');
  const name=el('input');name.type='text';name.maxLength=100;name.placeholder='路径名称';name.setAttribute('aria-label','路径名称');
  const selectionMode=el('select');selectionMode.setAttribute('aria-label','路径选区模式');
  selectionMode.append(new Option('新建选区','replace'),new Option('添加到选区','add'),
    new Option('从选区减去','subtract'),new Option('与选区相交','intersect'));
  function button(label,action){
    const node=el('button','',label);node.type='button';node.onclick=action;return node;
  }
  const create=button('新建路径',()=>{finish();load('');stage.focus({preventScroll:true});});
  const end=button('结束开放路径',finish),close=button('闭合路径',closePath);
  const store=button('保存路径',storePath),trash=button('删除路径',deletePath);
  const convert=button('转为选区',makeSelection);
  tools.append(saved,create,name,end,close,store,trash,selectionMode,convert,notice);parameters.append(tools);
  enhanceSelectMenu(saved);enhanceSelectMenu(selectionMode);
  const overlay=svg('svg','document-pen-overlay'),outline=svg('path','document-pen-line'),handles=svg('g');
  overlay.setAttribute('aria-hidden','true');
  overlay.append(outline,handles);stage.append(overlay);
  let active=false,working=null,pathId='',selected=-1,building=false,drag=null,cursor=null,owner='',writing=false,savedKey='',lastError='';
  const scratch=new Map(),histories=new Map();
  let baseline=null;
  function memory(){return {geometry:working,id:pathId,name:name.value,selected,building,baseline};}
  function remember(){if(owner&&owner!=='null')scratch.set(owner,memory());}
  function history(){
    if(!histories.has(owner))histories.set(owner,{undo:[],redo:[]});
    return histories.get(owner);
  }
  function addHistory(before){
    const {undo,redo}=history();
    undo.push(before);if(undo.length>64)undo.shift();redo.length=0;
  }
  function travel(direction){
    const state=history(),from=state[direction],to=state[direction==='undo'?'redo':'undo'];
    if(!active||writing||drag||!from.length)return false;
    to.push({...memory(),geometry:working&&copy(working)});adopt(from.pop());remember();layout();onChange();return true;
  }
  function adopt(entry){
    working=entry?.geometry?copy(entry.geometry):null;
    pathId=entry?.id??'';name.value=entry?.name??'';selected=entry?.selected??-1;building=entry?.building??false;
    baseline=entry?.baseline??(pathId?JSON.stringify([name.value,working]):null);
  }
  function load(id){
    const entry=context().paths.find(path=>path.id===id);
    adopt(entry);histories.delete(owner);lastError='';remember();layout();onChange();
  }
  saved.onchange=()=>load(saved.value);
  name.oninput=()=>{remember();layout();};
  function layout(){
    const state=context(),key=JSON.stringify(state.owner);
    if(owner!==key){
      remember();owner=key;adopt(scratch.get(key));drag=null;lastError='';
    }
    const keyForPaths=JSON.stringify(state.paths.map(({id,name})=>[id,name]));
    if(keyForPaths!==savedKey){
      savedKey=keyForPaths;saved.replaceChildren(new Option('工作路径',''),...state.paths.map(({id,name})=>new Option(name,id)));
    }
    const persisted=state.paths.find(path=>path.id===pathId);
    const nextBaseline=persisted?JSON.stringify([persisted.name,persisted.geometry]):null;
    if(pathId&&!drag&&!writing&&baseline!==nextBaseline&&baseline===JSON.stringify([name.value,working])){
      adopt(persisted);remember();
    }
    saved.value=persisted&&pathId?pathId:'';syncSelectMenu(saved);
    tools.hidden=!active;
    overlay.toggleAttribute('hidden',!active||!working||!state.owner);
    stage.toggleAttribute('data-image-pen',active);
    if(!active)return;
    const usable=state.enabled&&!writing;
    saved.disabled=create.disabled=!usable||!!drag;
    name.disabled=!usable||!working||!!drag;
    end.disabled=!usable||!building||!!drag;
    close.disabled=!usable||working?.closed||!working||working.anchors.length<2||!!drag;
    trash.disabled=!usable||!saved.value||!!drag;
    store.disabled=!usable||!working||!!drag;
    convert.disabled=selectionMode.disabled=!usable||!working?.closed||!!drag;
    syncSelectMenu(saved);syncSelectMenu(selectionMode);
    notice.textContent=lastError||(working?.closed?'拖动锚点或方向柄修整轮廓':building?
      '点起点或 Enter 闭合 · ⌘ / Ctrl + Enter 保留开放路径':'单击加点 · 拖动拉出曲线');
    if(!working)return;
    const at=canvasCoordinates(canvas).toLocal(stage.getBoundingClientRect());
    const last=working.anchors.at(-1);
    const next=building&&cursor&&!drag?' C'+[penHandle(last,'outgoing'),cursor,cursor].map(p=>at(p).join(',')).join(' '):'';
    outline.setAttribute('d','M'+at(working.anchors[0].point).join(',')+
      penSegments(working).map(([,b,c,d])=>' C'+[b,c,d].map(p=>at(p).join(',')).join(' ')).join('')+(working.closed?' Z':next));
    handles.replaceChildren();
    for(const [i,anchor] of working.anchors.entries()){
      const [x,y]=at(anchor.point);
      if(i===selected)for(const key of ['incoming','outgoing']){
        if(!anchor[key]||!anchor[key].some(n=>n))continue;
        const [u,v]=at(penHandle(anchor,key)),line=svg('line','document-pen-handle-line'),handle=svg('circle','document-pen-handle');
        for(const [attr,value] of Object.entries({x1:x,y1:y,x2:u,y2:v}))line.setAttribute(attr,value);
        for(const [attr,value] of Object.entries({cx:u,cy:v,r:4}))handle.setAttribute(attr,value);
        handle.dataset.anchor=i;handle.dataset.handle=key;handles.append(line,handle);
      }
      const node=svg('rect','document-pen-anchor');
      for(const [attr,value] of Object.entries({x:x-3,y:y-3,width:6,height:6}))node.setAttribute(attr,value);
      node.dataset.anchor=i;node.toggleAttribute('data-selected',i===selected);
      node.toggleAttribute('data-close',building&&i===0&&working.anchors.length>=2);
      handles.append(node);
    }
  }
  function finish(){
    if(!building||drag)return false;
    addHistory({...memory(),geometry:copy(working)});building=false;cursor=null;remember();layout();onChange();return true;
  }
  function closePath(){
    if(!working||working.closed||working.anchors.length<2||drag)return false;
    addHistory({...memory(),geometry:copy(working)});working.closed=true;building=false;selected=0;remember();layout();onChange();return true;
  }
  async function storePath(){
    if(!working||writing||drag)return;
    finish();
    const state=context(),id=pathId||crypto.randomUUID(),label=name.value.trim()||'路径 '+(state.paths.length+1);
    writing=true;lastError='';layout();
    try{
      await save(state.origin,{id,name:label,geometry:copy(working)});
      pathId=id;name.value=label;baseline=JSON.stringify([label,working]);histories.delete(owner);remember();
    }catch(error){lastError=error.message;onError(error);}
    finally{writing=false;layout();onChange();}
  }
  async function deletePath(){
    if(!saved.value||writing)return;
    const state=context();
    writing=true;lastError='';layout();
    try{await remove(state.origin,pathId);load('');}
    catch(error){lastError=error.message;onError(error);}
    finally{writing=false;layout();onChange();}
  }
  async function makeSelection(){
    if(!working?.closed||writing||drag)return;
    const geometry=copy(working);
    lastError='';
    // The selection compositor captures the current document revision and
    // owns its async request. Keep the curve available for further editing.
    const pending=select(geometry,selectionMode.value);
    if(!pending)return;
    writing=true;layout();
    try{await pending;}finally{writing=false;layout();onChange();}
  }
  function cancelDrag(){
    if(!drag)return false;
    const {before,pointer}=drag;
    drag=null;adopt(before);
    if(stage.hasPointerCapture(pointer))stage.releasePointerCapture(pointer);
    remember();layout();onChange();return true;
  }
  stage.addEventListener('pointerdown',event=>{
    const state=context();
    if(!active||!state.enabled||writing||drag||event.button!==0)return;
    const point=canvasPoint(canvas,event),handle=event.target.dataset.handle;
    const index=event.target.dataset.anchor===undefined?-1:Number(event.target.dataset.anchor);
    if(index===-1&&(!inside(point)||event.target!==canvas))return;
    const before=memory();
    before.geometry=working&&copy(working);
    if(index===0&&!handle&&!event.altKey&&building&&working.anchors.length>=2){
      closePath();stage.focus({preventScroll:true});event.preventDefault();event.stopImmediatePropagation();return;
    }
    let kind='point';
    if(index>=0){
      selected=index;kind=handle||'point';
      if(event.altKey&&!handle){
        const anchor=working.anchors[selected];delete anchor.incoming;delete anchor.outgoing;
        kind='new';
      }
    }else{
      if(!building){working={closed:false,anchors:[]};pathId='';name.value='';baseline=null;building=true;}
      if(working.anchors.length>=maxPathAnchors){lastError='路径已达到 '+maxPathAnchors+' 个锚点';layout();return;}
      const previous=working.anchors.at(-1);
      const constrained=event.shiftKey&&previous?snap(point,previous.point).map(clamp):point;
      selected=working.anchors.length;working.anchors.push({point:constrained});
      kind='new';
    }
    lastError='';
    drag={pointer:event.pointerId,before,kind,point,original:copy(working.anchors[selected]),moved:false,client:[event.clientX,event.clientY]};
    stage.focus({preventScroll:true});stage.setPointerCapture(event.pointerId);
    event.preventDefault();event.stopImmediatePropagation();layout();
  },{signal,capture:true});
  function snap(point,origin){
    const [x,y]=offset(point,origin),angle=Math.round(Math.atan2(y,x)/(Math.PI/4))*Math.PI/4,len=Math.hypot(x,y);
    return [origin[0]+len*Math.cos(angle),origin[1]+len*Math.sin(angle)];
  }
  function update(event){
    if(drag?.pointer!==event.pointerId){
      if(active&&building&&!drag){
        const point=canvasPoint(canvas,event);
        cursor=inside(point)?point:null;
        if(cursor&&event.shiftKey)cursor=snap(point,working.anchors.at(-1).point).map(clamp);
        layout();
      }
      return;
    }
    if(!drag.moved&&Math.hypot(event.clientX-drag.client[0],event.clientY-drag.client[1])<3)return;
    drag.moved=true;
    const {kind,point:initial,original}=drag,point=canvasPoint(canvas,event),anchor=working.anchors[selected];
    if(kind==='point'){
      const next=offset(point,initial).map((n,i)=>n+original.point[i]);
      anchor.point=(event.shiftKey?snap(next,original.point):next).map(clamp);
    }else{
      const direction=offset(event.shiftKey?snap(point,anchor.point):point,anchor.point).map(n=>Math.max(-2,Math.min(2,n)));
      const key=kind==='new'?'outgoing':kind,opposite=key==='outgoing'?'incoming':'outgoing';
      anchor[key]=direction;
      if(kind==='new'||!event.altKey)anchor[opposite]=negate(direction);
    }
    layout();event.stopImmediatePropagation();
  }
  stage.addEventListener('pointermove',update,{signal,capture:true});
  stage.addEventListener('pointerleave',()=>{if(cursor){cursor=null;layout();}},{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,event=>{
    if(drag?.pointer!==event.pointerId)return;
    if(type!=='pointerup'){cancelDrag();return;}
    update(event);
    if(drag.moved||JSON.stringify(drag.before.geometry)!==JSON.stringify(working))addHistory(drag.before);
    drag=null;
    if(stage.hasPointerCapture(event.pointerId))stage.releasePointerCapture(event.pointerId);
    remember();layout();onChange();
  },{signal,capture:true});
  function setActive(next){
    if(active&&!next)cancelDrag();
    active=next;if(!active)cursor=null;layout();
  }
  function key(event){
    if(!active||writing)return false;
    if(event.key==='Escape'){
      if(cancelDrag())return true;
      if(finish())return true;
      return false;
    }
    if(event.key==='Enter'){
      if(modifier(event)&&building)return finish();
      if(working&&!working.closed)return closePath();
      if(working?.closed){void makeSelection();return true;}
    }
    if(['Delete','Backspace'].includes(event.key)&&selected>=0&&working&&!drag&&!modifier(event)){
      addHistory({...memory(),geometry:copy(working)});
      working.anchors.splice(selected,1);
      selected=Math.min(selected,working.anchors.length-1);
      if(working.anchors.length<2)working.closed=false;
      if(!working.anchors.length){working=null;building=false;}
      remember();layout();onChange();return true;
    }
    return false;
  }
  return {layout,setActive,key,cancelDrag,travel,isEditing:()=>!!drag||writing};
}
