import {canvasCoordinates,canvasPoint} from './image-canvas-coordinates.mjs';
import {createSmoothMesh,dragWarpPoint,imagePlacement,meshTriangles,smoothMesh,smoothMeshSteps,validImageWarp,warpBase,warpMesh,warpModes,warpPoint} from './image-warp.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';

const svgNS='http://www.w3.org/2000/svg';
const svg=(tag,cls)=>{const element=document.createElementNS(svgNS,tag);element.setAttribute('class',cls);return element;};
const button=(label,action)=>{const element=document.createElement('button');element.type='button';element.textContent=label;element.onclick=action;return element;};

export function createImageWarpTool({stage,canvas,parameters,signal,context,preview,commit,onError}){
  const toolbar=document.createElement('div');
  toolbar.className='editor-toolbar document-warp-options';
  const mode=document.createElement('select');
  mode.setAttribute('aria-label','变形方式');
  for(const [value,label] of warpModes)mode.append(new Option(label,value));
  const notice=document.createElement('span');
  notice.className='document-sample-status';
  notice.setAttribute('role','status');
  const applyButton=button('应用变形',()=>void apply());
  const resetButton=button('重置变形',reset);
  const cancelButton=button('取消变形',cancel);
  const startButton=button('编辑变形',begin);
  const density=document.createElement('select');
  density.setAttribute('aria-label','网格密度');
  for(const n of smoothMeshSteps)density.append(new Option(n+' × '+n,n));
  density.append(new Option('自定义','custom'));density.lastChild.disabled=true;
  const insertColumn=button('插入列',()=>insert('u')),insertRow=button('插入行',()=>insert('v'));
  const coords=['X','Y'].map((axis,i)=>{
    const input=document.createElement('input');
    input.type='number';input.step='any';input.min=-32768;input.max=32768;input.dataset.scrubNumber='';
    input.dataset.scrubSpeed='1';input.dataset.scrubSuffix=' px';input.setAttribute('aria-label','控制点 '+axis);
    input.onchange=()=>{
      if(!draft||!input.validity.valid)return;
      const point=draft.warp.points[draft.index].slice();
      point[i]=input.valueAsNumber/4096;editPoint(draft.warp,draft.index,point);
    };
    input.onkeydown=event=>{if(event.key==='Enter'){event.stopPropagation();input.blur();}};
    return input;
  });
  toolbar.append(startButton,mode,density,insertColumn,insertRow,...coords,applyButton,resetButton,cancelButton,notice);
  parameters.append(toolbar);enhanceSelectMenu(mode);enhanceSelectMenu(density);
  const overlay=svg('svg','document-layout-overlay document-warp-overlay');
  const grid=svg('path','document-warp-grid'),influence=svg('path','document-warp-influence');
  const handles=[];
  overlay.append(influence,grid);stage.append(overlay);
  function fitHandles(count){
    while(handles.length>count)handles.pop().remove();
    while(handles.length<count){
      const handle=svg('circle','document-layout-handle');
      handle.dataset.warpHandle=handles.length;
      handles.push(handle);overlay.append(handle);
    }
  }

  let active=false,draft=null,gesture=null;
  let hint='';
  const initial=kind=>kind==='smooth'?createSmoothMesh(2):{mode:kind,points:warpBase(kind).map(point=>[...point])};
  const owner=state=>JSON.stringify([state.origin.id,state.origin.revision,state.origin.documentId,state.layer?.id,state.origin.target,state.layerIds]);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const result=()=>draft.reset?null:draft.warp;
  const snapshot=()=>({warp:draft.warp,index:draft.index,reset:draft.reset});
  function remember(previous){
    if(!same(previous.warp,draft.warp)||previous.reset!==draft.reset){draft.undo.push(previous);draft.redo=[];}
  }
  function travel(direction){
    if(!draft||gesture)return false;
    const [from,to]=direction==='undo'?[draft.undo,draft.redo]:[draft.redo,draft.undo];
    if(!from.length)return true;
    to.push(snapshot());Object.assign(draft,from.pop());
    mode.value=draft.warp.mode;syncSelectMenu(mode);hint='';
    showPreview();layout();return true;
  }
  function command(){
    return {op:'image',action:'updateLayer',documentId:draft.state.origin.documentId,layerId:draft.state.layer.id,
      patch:{warp:result()}};
  }
  function changed(){
    return draft&&(draft.reset?!!draft.original:!same(draft.original,draft.warp)&&
      (!!draft.original||!same(initial(draft.warp.mode),draft.warp)));
  }
  function showPreview(){preview(changed()?command():null);}
  function layout(){
    const state=context();
    if(draft&&owner(draft.state)!==owner(state))discard();
    toolbar.hidden=!active;
    overlay.toggleAttribute('hidden',!active||!draft);
    stage.toggleAttribute('data-image-warp',active);
    if(!active)return;
    const working=!!draft;
    startButton.hidden=working;startButton.disabled=!state.enabled;
    mode.disabled=resetButton.disabled=!working;
    cancelButton.disabled=!working;
    applyButton.disabled=!changed();
    notice.textContent=working?hint||'拖动控制点 · Enter 应用 · Esc 取消':state.reason;
    const smooth=working&&draft.warp.mode==='smooth';
    density.disabled=!smooth;syncSelectMenu(density);
    density.parentElement.hidden=!smooth;
    insertColumn.hidden=insertRow.hidden=!smooth;
    for(const input of coords)input.hidden=!working;
    if(!working)return;
    const {warp,placement,index}=draft,project=canvasCoordinates(canvas).toLocal(stage.getBoundingClientRect());
    const toScreen=point=>project(placement.toCanvas(point));
    const points=warp.points.map(toScreen);
    fitHandles(points.length);
    if(smooth){
      const n=warp.u.length-1;
      const uniform=values=>values.every((value,i)=>value===i/(values.length-1));
      density.value=n===warp.v.length-1&&smoothMeshSteps.includes(n)&&uniform(warp.u)&&uniform(warp.v)?String(n):'custom';
      syncSelectMenu(density);
      const line=(axis,k)=>Array.from({length:33},(_,i)=>toScreen(warpPoint(warp,axis==='u'?[k,i/32]:[i/32,k])).join(','));
      grid.setAttribute('d',['u','v'].flatMap(axis=>warp[axis].map(k=>'M'+line(axis,k).join(' L'))).join(' '));
      const [column,row]=[index%warp.u.length,Math.floor(index/warp.u.length)];
      const [u0,u1]=[warp.u[Math.max(0,column-2)],warp.u[Math.min(warp.u.length-1,column+2)]];
      const [v0,v1]=[warp.v[Math.max(0,row-2)],warp.v[Math.min(warp.v.length-1,row+2)]];
      const ring=[[u0,v0],[u1,v0],[u1,v1],[u0,v1]];
      const edge=ring.flatMap((p,i)=>{
        const q=ring[(i+1)%ring.length];
        return Array.from({length:17},(_,j)=>toScreen(warpPoint(warp,p.map((n,axis)=>n+(q[axis]-n)*j/17))).join(','));
      });
      influence.setAttribute('d','M'+edge.join(' L')+' Z');
    }else{
      influence.removeAttribute('d');
      const paths=warp.mode==='mesh'?meshTriangles:[[0,1,2,3]];
      grid.setAttribute('d',paths.map(indices=>'M'+indices.map(i=>points[i].join(',')).join(' L')+' Z').join(' '));
    }
    for(const [i,handle] of handles.entries()){
      handle.setAttribute('r',i===index?'6':'4');
      handle.classList.toggle('is-active',i===index);
      handle.setAttribute('cx',points[i][0]);handle.setAttribute('cy',points[i][1]);
    }
    for(const [i,input] of coords.entries()){
      if(document.activeElement!==input)input.value=String(Math.round(warp.points[index][i]*409600)/100);
    }
  }
  function installWarp(warp,index=0){
    if(validImageWarp(warp)){
      const previous=snapshot();
      draft.warp=warp;draft.index=index;draft.reset=false;hint='';if(!gesture)remember(previous);showPreview();
    }else hint='控制点不能交叉或使网格折叠';
    layout();
  }
  function editPoint(base,index,point){installWarp(dragWarpPoint(base,index,point),index);}
  function insert(axis){
    const {warp,index}=draft;
    const values=warp[axis],k=axis==='u'?index%warp.u.length:Math.floor(index/warp.u.length);
    const after=Math.min(k,values.length-2)+1,value=(values[after-1]+values[after])/2;
    const knots=values.toSpliced(after,0,value);
    const next=smoothMesh(axis==='u'?knots:warp.u,axis==='v'?knots:warp.v,warp);
    const selected=axis==='u'?Math.floor(index/warp.u.length)*knots.length+after:after*warp.u.length+index%warp.u.length;
    installWarp(next,selected);
  }
  density.onchange=()=>{if(draft&&density.value!=='custom')installWarp(createSmoothMesh(Number(density.value),draft.warp));};

  function begin(){
    if(draft)return;
    const state=context();
    if(!state.enabled){layout();return;}
    const original=state.layer.warp;
    draft={state,original,warp:original??initial(mode.value),placement:imagePlacement(state.layer,state.assets),reset:false,index:0,undo:[],redo:[]};
    mode.value=draft.warp.mode;syncSelectMenu(mode);
    hint='';layout();
  }
  function release(){
    const pointer=gesture?.pointer;gesture=null;
    if(pointer!==undefined&&stage.hasPointerCapture(pointer))stage.releasePointerCapture(pointer);
  }
  function discard(){
    if(!draft)return;
    release();draft=null;hint='';preview(null);
  }
  function cancel(){
    if(!draft)return false;
    discard();layout();return true;
  }
  function reset(){
    if(!draft)return;
    const previous=snapshot();
    draft.warp=initial(mode.value);draft.index=0;draft.reset=true;hint='';remember(previous);
    showPreview();layout();
  }
  async function apply(){
    if(!draft)return false;
    const operation=changed()?command():null,origin=draft.state.origin;
    release();draft=null;
    try{if(operation)await commit(operation,origin);}
    catch(error){onError(error);}
    finally{preview(null);layout();}
    return true;
  }
  mode.onchange=()=>{
    if(!draft)return;
    const old=draft.warp;
    const kind=mode.value;
    const corners=warpBase('distort').map(point=>warpPoint(old,point));
    if(kind==='smooth')installWarp(createSmoothMesh(2,old));
    else installWarp({mode:kind,points:kind==='mesh'?warpMesh(corners):corners});
    mode.value=draft.warp.mode;syncSelectMenu(mode);

  };
  function local(event){
    return draft.placement.toLayer(canvasPoint(canvas,event));
  }
  stage.addEventListener('pointerdown',event=>{
    const handle=event.target.dataset.warpHandle;
    if(!active||event.button!==0||handle===undefined)return;
    begin();
    if(!draft)return;
    event.preventDefault();event.stopImmediatePropagation();
    stage.focus({preventScroll:true});
    draft.index=Number(handle);layout();
    gesture={pointer:event.pointerId,index:draft.index,base:draft.warp,previous:snapshot(),initial:local(event)};
    stage.setPointerCapture(event.pointerId);
  },{capture:true,signal});
  stage.addEventListener('pointermove',event=>{
    if(gesture?.pointer!==event.pointerId)return;
    event.stopImmediatePropagation();
    const {base,index,initial}=gesture;
    let next=local(event).map((value,axis)=>base.points[index][axis]+value-initial[axis]);
    if(event.shiftKey){
      const delta=next.map((value,axis)=>value-base.points[index][axis]);
      const axis=Math.abs(delta[0])>Math.abs(delta[1])?1:0;
      next[axis]=base.points[index][axis];
    }
    editPoint(base,index,next);
  },{capture:true,signal});
  stage.addEventListener('pointerup',event=>{
    if(gesture?.pointer!==event.pointerId)return;
    event.preventDefault();event.stopImmediatePropagation();remember(gesture.previous);release();
  },{capture:true,signal});
  for(const type of ['pointercancel','lostpointercapture'])stage.addEventListener(type,event=>{
    if(gesture?.pointer===event.pointerId)cancel();
  },{signal});
  return {layout,cancel,travel,isEditing:()=>!!draft,
    setActive(value){if(active&&!value)discard();active=value;layout();},
    begin,
    key(event){
      if(!active)return false;
      if(event.key==='Escape')return cancel();
      if(draft&&(event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='z')
        return travel(event.shiftKey?'redo':'undo');
      if(event.key==='Enter'&&draft){void apply();return true;}
      return false;
    }
  };
}
