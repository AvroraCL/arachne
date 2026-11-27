import {canvasCoordinates,canvasPoint} from './image-canvas-coordinates.mjs';
import {boundsCenter,imageLayoutTargets,layoutBounds,layoutKinds,layoutPoint,placedImageBounds,rootLayoutBounds,unionImageBounds,alignImageBounds} from './image-layout.mjs';
import {layerIsVisible} from './paint-layer-tree.mjs';
import {createContextActions,chromeButton} from './area-chrome.mjs';

const alignments=[
  ['startX','左对齐'],['centerX','水平居中对齐'],['endX','右对齐'],
  ['startY','顶对齐'],['centerY','垂直居中对齐'],['endY','底对齐'],
  ['spaceX','水平等距分布'],['spaceY','垂直等距分布']
];
const svgNS='http://www.w3.org/2000/svg';
const element=(tag,cls)=>{const node=document.createElement(tag);if(cls)node.className=cls;return node;};
const svg=(tag,cls)=>{const node=document.createElementNS(svgNS,tag);if(cls)node.setAttribute('class',cls);return node;};
const button=(label,action)=>{const node=element('button');node.type='button';node.textContent=label;node.onclick=action;return node;};
const guidesFrom=value=>Object.fromEntries(['x','y'].map(axis=>[axis,Array.isArray(value?.[axis])
  ?value[axis].filter(n=>Number.isFinite(n)&&n>=0&&n<=1):[]]));

export function createImageMoveTool({stage,canvas,parameters,signal,settings={},context,select,preview,continueSelection,commit,onError,onChange}){
  const options=element('div','editor-toolbar document-move-options');
  const overlay=svg('svg','document-layout-overlay'),guides=svg('g','document-layout-guides');
  const box=svg('g','document-layout-handles'),outline=svg('polygon','document-layout-outline');
  const arm=svg('line','document-layout-arm'),handleNames=['nw','ne','se','sw','rotate'];
  const handles=handleNames.map(name=>{
    const handle=svg('circle','document-layout-handle');
    handle.dataset.layoutHandle=name;handle.setAttribute('r',name==='rotate'?'5':'4');return handle;
  });
  box.append(outline,arm,...handles);overlay.append(guides,box);stage.append(overlay);

  const snap=element('input');snap.type='checkbox';snap.checked=settings.snap!==false;
  const snapLabel=element('label');snapLabel.textContent='吸附';snapLabel.append(snap);
  snap.setAttribute('aria-label','吸附参考线');
  const transformButton=button('联合变换',()=>startTransform());
  const arrangeButton=button('对齐与分布',openAlign);
  const guideButton=chromeButton(button('参考线',openGuides),'grid','参考线');
  const count=element('span','document-sample-status');
  const transformOptions=element('div','editor-toolbar document-layout-options');
  const values={};
  for(const [key,label,step,suffix] of [['x','水平位移',1,' px'],['y','垂直位移',1,' px'],['scale','等比缩放',.1,'%'],['angle','旋转',.1,'°']]){
    const field=element('label'),input=element('input');
    field.textContent=label;input.type='number';input.step=step;input.setAttribute('aria-label',label);
    input.dataset.scrubNumber='';input.dataset.scrubSuffix=suffix;
    if(key==='scale'){input.min=5;input.max=800;}
    if(key==='angle'){input.min=-360;input.max=360;}
    input.onchange=()=>{
      if(!draft)return;
      const n=input.valueAsNumber;
      if(!Number.isFinite(n)){syncFields();return;}
      const next={...draft.transform,offset:[...draft.transform.offset]};
      if(key==='scale')next.scale=n/100;
      else if(key==='angle')next.angle=n;
      else next.offset[key==='x'?0:1]=n/4096;
      update(next);
    };
    values[key]=input;field.append(input);transformOptions.append(field);
  }
  transformOptions.append(button('应用',apply),button('取消',()=>cancel()));
  const arrangeMenu=createContextActions('对齐与分布',onError);
  const guideMenu=createContextActions('参考线操作',onError);
  options.append(count,snapLabel,transformButton,arrangeButton,guideButton);
  parameters.append(options,transformOptions);

  let active=false,gesture=null,draft=null,pick=null,boundsRequest=null,inputSequence=0;
  let requestedTransform=null;
  const clicks=[];
  let drainingClicks=false,applyingClick=false;
  let measurements=new Map(),measurementKey='',measurementError=null;
  const referenceLines=guidesFrom(settings.guides);
  let guidesVisible=settings.showGuides!==false;
  let snapped=[null,null],lastPointer=null;
  const idKey=state=>JSON.stringify([state.origin?.id,state.origin?.revision,state.origin?.documentId]);
  const current=state=>idKey(state)===idKey(context());
  const selectionKey=state=>JSON.stringify([state.origin?.id,state.origin?.revision,state.origin?.documentId,
    state.ids,state.origin?.layerId,state.origin?.target]);
  const identity=(pivot=[0,0])=>({pivot,offset:[0,0],scale:1,angle:0});
  const plan=state=>state.mask?{roots:[state.mask],targets:[]}:imageLayoutTargets(state.image.layers,state.ids);
  const boundsFor=(state,layer)=>placedImageBounds(layer,state.assets)??measurements.get(layer.id);
  const selectedBounds=(state,roots)=>state.mask?[{id:state.mask.id,bounds:[0,0,1,1]}]:
    roots.map(root=>({id:root.id,bounds:rootLayoutBounds(state.image.layers,root,layer=>boundsFor(state,layer))})).filter(item=>item.bounds);
  const point=event=>{
    return canvasPoint(canvas,event);
  };
  const command=(state,transforms)=>{
    if(state.mask){
      const {pivot,offset,scale,angle}=transforms[0];
      return {op:'image',action:'transformMask',documentId:state.origin.documentId,layerId:state.mask.id,
        transform:{pivot,offset,scale:[scale,scale],angle}};
    }
    return {op:'image',action:'layoutLayers',documentId:state.origin.documentId,transforms};
  };
  const isChanged=transform=>transform.angle!==0||transform.scale!==1||transform.offset.some(n=>Math.abs(n)>1e-8);
  snap.onchange=()=>{snapped=[null,null];onChange();layout();};

  async function probe(state,fields,controller){
    const response=await fetch('/api/projects/'+state.origin.id+'/paint/image-layout-probe',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
      body:JSON.stringify({revision:state.probeRevision??state.origin.revision,documentId:state.origin.documentId,layerIds:[],...fields})
    });
    const result=await response.json();
    if(!response.ok)throw Error(result.error);
    return result;
  }
  function measure(state){
    const key=idKey(state);
    if(key!==measurementKey){
      boundsRequest?.abort();boundsRequest=null;measurements=new Map();measurementError=null;measurementKey=key;
    }
    const layers=state.image?.layers.filter(layer=>layer.kind==='pixel'&&!measurements.has(layer.id)&&
      (layer.raster||layer.strokes?.length))??[];
    if(!layers.length||boundsRequest||measurementError)return;
    const controller=new AbortController();boundsRequest=controller;
    void probe(state,{layerIds:layers.map(layer=>layer.id)},controller).then(({bounds})=>{
      if(boundsRequest!==controller||!current(state))return;
      measurements=new Map(Object.entries(bounds));
    }).catch(error=>{
      if(!controller.signal.aborted){measurementError=error.message;onError(error);}
    }).finally(()=>{
      if(boundsRequest!==controller)return;
      boundsRequest=null;
      const request=requestedTransform;
      requestedTransform=null;
      const next=context();
      if(request&&active&&request.sequence===inputSequence&&current(request.state)&&
         request.state.ids.join()===next.ids.join()&&request.state.mask?.id===next.mask?.id&&startTransform())return;
      layout();
    });
  }
  function addLine(host,a,b,cls){
    const line=svg('line',cls);
    line.setAttribute('x1',a[0]);line.setAttribute('y1',a[1]);
    line.setAttribute('x2',b[0]);line.setAttribute('y2',b[1]);host.append(line);
  }
  function syncFields(){
    if(!draft)return;
    const {offset,scale,angle}=draft.transform;
    for(const [key,value] of Object.entries({x:offset[0]*4096,y:offset[1]*4096,scale:scale*100,angle})){
      if(document.activeElement!==values[key])values[key].value=Number(value.toFixed(2));
    }
  }
  function layout(){
    const state=context();
    if(!applyingClick&&clicks.length&&clicks[0].selection!==selectionKey(state))clearClicks();
    if(draft&&(!current(draft.state)||state.ids.join()!==draft.state.ids.join()||state.mask?.id!==draft.state.mask?.id)){
      release();draft=null;preview(null);
    }
    options.hidden=!active||!!draft;
    transformOptions.hidden=!active||!draft;
    overlay.toggleAttribute('hidden',!active);
    stage.toggleAttribute('data-image-move',active);
    if(!active)return;
    measure(state);
    let roots=[],reason='';
    if(!state.enabled)reason=state.reason;
    else try{({roots}=plan(state));}
    catch(error){reason=error.message;}
    const items=selectedBounds(state,roots);
    const bounds=draft?.bounds??unionImageBounds(items.map(item=>item.bounds));
    const ready=!!bounds&&items.length===roots.length&&!reason;
    count.textContent=reason||(state.mask?'拖动移动蒙版':boundsRequest&&!ready?'正在读取图层边界…':
      measurementError&&!ready?measurementError:state.ids.length?state.ids.length+' 层已选':'单击画布选择图层');
    transformButton.textContent=state.mask?'变换蒙版':'联合变换';
    transformButton.disabled=!ready;transformButton.title=reason;
    snapLabel.hidden=arrangeButton.hidden=!!state.mask;
    arrangeButton.disabled=!ready||items.length<2;
    guideButton.disabled=!state.image;
    const svgPoint=canvasCoordinates(canvas).toLocal(stage.getBoundingClientRect());
    guides.replaceChildren();
    for(const [i,axis] of ['x','y'].entries()){
      for(const value of guidesVisible?referenceLines[axis]:[]){
        const ends=i?[[0,value],[1,value]]:[[value,0],[value,1]];
        addLine(guides,...ends.map(svgPoint),'document-reference-line');
      }
      if(snapped[i]!==null){
        const value=snapped[i],ends=i?[[0,value],[1,value]]:[[value,0],[value,1]];
        addLine(guides,...ends.map(svgPoint),'document-snap-line');
      }
    }
    box.toggleAttribute('hidden',!bounds);
    if(!bounds)return;
    const [l,t,r,b]=bounds,transform=draft?.transform??identity();
    const corners=[[l,t],[r,t],[r,b],[l,b]].map(p=>svgPoint(layoutPoint(p,transform)));
    outline.setAttribute('points',corners.map(p=>p.join(',')).join(' '));
    box.toggleAttribute('data-transforming',!!draft);
    const top=corners[0].map((v,i)=>(v+corners[1][i])/2),edge=corners[1].map((v,i)=>v-corners[0][i]);
    const length=Math.hypot(...edge)||1;
    const rotation=[top[0]+edge[1]/length*22,top[1]-edge[0]/length*22];
    for(const [i,[x,y]] of [...corners,rotation].entries()){
      handles[i].setAttribute('cx',x);handles[i].setAttribute('cy',y);
    }
    arm.setAttribute('x1',top[0]);arm.setAttribute('y1',top[1]);arm.setAttribute('x2',rotation[0]);arm.setAttribute('y2',rotation[1]);
    syncFields();
  }
  function openAlign(event){
    const state=context();
    const {roots}=plan(state),items=selectedBounds(state,roots);
    const rect=event.currentTarget.getBoundingClientRect();
    arrangeMenu.open({clientX:rect.left,clientY:rect.bottom},'对齐与分布',alignments.map(([action,label])=>({
      label,enabled:items.length>=(action.startsWith('space')?3:2),run:()=>{
        const transforms=alignImageBounds(items,action);
        if(transforms.length)return commit(command(state,transforms),state.origin);
      }
    })));
  }
  function openGuides(event){
    const rect=event.currentTarget.getBoundingClientRect(),point=lastPointer??[.5,.5];
    const actions=['x','y'].map((axis,i)=>({
      label:(i?'水平':'垂直')+'参考线 · '+Math.round(point[i]*4096)+' px',
      run(){const position=Math.round(Math.min(1,Math.max(0,point[i]))*4096)/4096;
        if(!referenceLines[axis].includes(position))referenceLines[axis].push(position);
        guidesVisible=true;onChange();layout();}
    }));
    guideMenu.open({clientX:rect.left,clientY:rect.bottom},'参考线',[
      ...actions,null,
      {label:guidesVisible?'隐藏参考线':'显示参考线',run(){guidesVisible=!guidesVisible;onChange();layout();}},
      {label:'清除参考线',enabled:referenceLines.x.length+referenceLines.y.length>0,
        run(){referenceLines.x=[];referenceLines.y=[];onChange();layout();}}
    ]);
  }
  function makeDraft(state){
    if(!state.enabled){if(state.reason)onError(Error(state.reason));return null;}
    let roots;
    try{({roots}=plan(state));}catch(error){onError(error);return null;}
    const items=selectedBounds(state,roots);
    if(!items.length||items.length!==roots.length){onError(Error('请等待所选图层的边界就绪'));return null;}
    const bounds=unionImageBounds(items.map(item=>item.bounds));
    return {state,bounds,transform:{...identity(boundsCenter(bounds)),layerIds:state.ids}};
  }
  function startTransform(){
    if(!active||draft||gesture)return false;
    const state=context();
    clearClicks();
    if(state.enabled&&!state.mask&&boundsRequest){
      requestedTransform={state,sequence:inputSequence};
      return true;
    }
    draft=makeDraft(state);
    if(draft)stage.focus({preventScroll:true});
    layout();return !!draft;
  }
  function update(transform){
    if(!draft)return;
    if(transform.scale<.05||transform.scale>8||Math.abs(transform.angle)>360||transform.offset.some(value=>Math.abs(value)>8))return;
    const {targets}=plan(draft.state);
    if(targets.some(layer=>layer.scale!==undefined&&(layer.scale*transform.scale<1/4096||layer.scale*transform.scale>4)))return;
    draft.transform=transform;
    preview(isChanged(transform)?command(draft.state,[transform]):null);
    layout();
  }
  function release(){
    const pointer=gesture?.pointer;
    gesture=null;snapped=[null,null];
    if(pointer!==undefined&&stage.hasPointerCapture(pointer))stage.releasePointerCapture(pointer);
  }
  function clearClicks(){
    for(const click of clicks)click.controller.abort();
    clicks.length=0;
  }
  function cancel(){
    if(!draft&&!gesture&&!pick&&!requestedTransform&&!clicks.length)return false;
    requestedTransform=null;
    inputSequence++;
    clearClicks();
    pick?.abort();pick=null;
    const restore=!!draft||gesture?.continued;
    release();draft=null;
    if(restore)preview(null);
    layout();return true;
  }
  async function apply(){
    if(!draft)return;
    const {state,transform}=draft;
    release();draft=null;
    try{if(isChanged(transform))await commit(command(state,[transform]),state.origin);}
    finally{if(!isChanged(transform))preview(null);layout();}
  }
  function translate(base,delta,shift,allowSnap){
    const offset=base.offset.map((n,i)=>n+delta[i]);
    const axis=Math.abs(delta[0])>Math.abs(delta[1])?0:1;
    if(shift)offset[1-axis]=base.offset[1-axis];
    const transform={...base,offset};
    snapped=[null,null];
    if(draft.state.mask||!snap.checked||!allowSnap)return transform;
    const bounds=layoutBounds(draft.bounds,transform);
    const rect=canvasCoordinates(canvas),state=draft.state;
    const ignored=new Set(plan(state).targets.map(layer=>layer.id));
    const nearby=state.image.layers.filter(layer=>layoutKinds.includes(layer.kind)&&!ignored.has(layer.id)&&layerIsVisible(state.image.layers,layer))
      .map(layer=>boundsFor(state,layer)).filter(Boolean);
    for(let i=0;i<2;i++){
      if(shift&&i!==axis)continue;
      const limit=6/(i?rect.height:rect.width);
      const positions=[bounds[i],bounds[i+2],boundsCenter(bounds)[i]];
      const candidates=[...(guidesVisible?referenceLines[i?'y':'x']:[]),0,.5,1,
        ...nearby.flatMap(box=>[box[i],box[i+2],boundsCenter(box)[i]])];
      let best=limit;
      for(const candidate of candidates)for(const position of positions){
        if(Math.abs(candidate-position)>=Math.abs(best))continue;
        best=candidate-position;snapped[i]=candidate;
      }
      if(snapped[i]!==null)offset[i]+=best;
    }
    return transform;
  }
  function capture(event,kind,working,operation){
    gesture={pointer:event.pointerId,start:point(event),startClient:[event.clientX,event.clientY],kind,base:working?.transform,
      operation,state:context(),moved:false,sequence:++inputSequence};
    stage.setPointerCapture(event.pointerId);
  }
  function probeHit(state,point,controller){
    const width=canvasCoordinates(canvas).width;
    const resolution=width>=1024?1024:width>=512?512:256;
    return probe(state,{point,resolution},controller).then(({hit})=>hit).catch(error=>{
      if(!controller.signal.aborted&&current(state))onError(error);
      return null;
    });
  }
  stage.addEventListener('pointerdown',event=>{
    const state=context();
    if(!active||!state.enabled||event.button!==0||gesture||state.space||event.target.closest('button,input,.document-save-recovery'))return;
    const at=point(event),handle=event.target.dataset.layoutHandle;
    if(!draft&&at.some(n=>n<0||n>1))return;
    event.preventDefault();event.stopImmediatePropagation();stage.focus({preventScroll:true});
    pick?.abort();pick=null;
    if(draft){capture(event,handle==='rotate'?'rotate':handle?'scale':'move',draft,'transform');return;}
    capture(event,'move',null,event.shiftKey||event.metaKey||event.ctrlKey?'extend':'replace');
    // In an existing selection, preserve the whole set for a drag. Outside it,
    // resolve the hit on pointer-down so an unselected layer can be dragged.
    const items=state.ids.length?selectedBounds(state,planIfAvailable(state)):[];
    if(!items.some(({bounds})=>at[0]>=bounds[0]&&at[0]<=bounds[2]&&at[1]>=bounds[1]&&at[1]<=bounds[3])){
      if(state.selectedOnly){release();return;}
      const g=gesture;
      const controller=new AbortController();pick=controller;
      g.controller=controller;
      g.hit=probeHit(g.state,at,controller).finally(()=>{if(pick===controller)pick=null;});
    }else gesture.continued=continueSelection?.();
  },{capture:true,signal});
  function planIfAvailable(state){
    try{return plan(state).roots;}catch{return [];}
  }
  function movePointer(g,event,at){
    const delta=at.map((v,i)=>v-g.start[i]);
    update(translate(g.base,delta,event.shiftKey,!event.altKey));
  }
  function updatePointer(g,event,at){
    if(g.kind==='move'){movePointer(g,event,at);return;}
    const base=g.base,center=base.pivot.map((v,i)=>v+base.offset[i]);
    const from=g.start.map((v,i)=>v-center[i]),to=at.map((v,i)=>v-center[i]);
    if(g.kind==='scale'){
      const factor=Math.hypot(...to)/Math.max(1e-6,Math.hypot(...from));
      update({...base,scale:Math.max(.05,Math.min(8,base.scale*factor))});
    }else{
      let angle=base.angle+(Math.atan2(to[1],to[0])-Math.atan2(from[1],from[0]))*180/Math.PI;
      if(event.shiftKey)angle=Math.round(angle/15)*15;
      update({...base,angle:((angle+180)%360+360)%360-180});
    }
  }
  function startDraggedLayer(g,hit){
    if(!hit||!active||g.sequence!==inputSequence||!current(g.state))return false;
    select(hit,false);
    const working=makeDraft(context());
    if(!working)return false;
    g.base=working.transform;draft=working;return true;
  }
  stage.addEventListener('pointermove',event=>{
    if(!active)return;
    const at=point(event);
    if(at.every(n=>n>=0&&n<=1))lastPointer=at;
    if(gesture?.pointer!==event.pointerId)return;
    event.stopImmediatePropagation();
    const g=gesture;
    if(!g.moved&&Math.hypot(event.clientX-g.startClient[0],event.clientY-g.startClient[1])<3)return;
    g.last={event,at};
    if(!g.moved){
      g.moved=true;
      clearClicks();
      if(!draft){
        if(g.hit){
          void g.hit.then(hit=>{
            if(gesture===g&&startDraggedLayer(g,hit))movePointer(g,g.last.event,g.last.at);
          });
          return;
        }
        const working=makeDraft(g.state);
        if(!working){release();return;}
        g.base=working.transform;draft=working;
      }
    }
    if(draft)updatePointer(g,event,at);
  },{capture:true,signal});
  function enqueueClick(g,at){
    if(!current(g.state)){
      g.controller?.abort();
      return;
    }
    const controller=g.controller??new AbortController();
    if(pick===controller)pick=null;
    const extend=g.operation==='extend';
    if(!extend)clearClicks();
    clicks.push({controller,result:g.hit??probeHit(g.state,at,controller),extend,selection:selectionKey(context())});
    if(!drainingClicks)void applyClicks();
  }
  async function applyClicks(){
    drainingClicks=true;
    try{
      while(clicks.length){
        const click=clicks[0],hit=await click.result;
        if(clicks[0]!==click)continue;
        if(!active||click.selection!==selectionKey(context())){clearClicks();break;}
        clicks.shift();
        if(!hit)continue;
        // Network replies can arrive out of order. Apply each modifier to the
        // selection produced by the preceding click.
        applyingClick=true;
        try{select(hit,click.extend);}
        finally{applyingClick=false;}
        const selected=selectionKey(context());
        for(const pending of clicks)pending.selection=selected;
      }
    }finally{drainingClicks=false;}
  }
  stage.addEventListener('pointerup',event=>{
    if(gesture?.pointer!==event.pointerId)return;
    event.preventDefault();event.stopImmediatePropagation();
    const g=gesture,at=point(event);
    const moved=g.moved||Math.hypot(event.clientX-g.startClient[0],event.clientY-g.startClient[1])>=3;
    if(moved&&!g.moved&&g.operation!=='transform'){
      clearClicks();
      if(!g.hit){
        const working=makeDraft(g.state);
        if(working){g.base=working.transform;draft=working;}
      }
    }
    if(draft&&moved)updatePointer(g,event,at);
    release();
    if(g.operation==='transform'){layout();return;}
    if(moved){
      if(draft)void apply().catch(onError);
      else if(g.hit)void g.hit.then(hit=>{
        if(!gesture&&!draft&&startDraggedLayer(g,hit)){
          movePointer(g,event,at);
          return apply();
        }
      }).catch(onError);
      return;
    }
    if(g.continued)preview(null);
    if(!g.state.mask&&at.every(n=>n>=0&&n<=1))enqueueClick(g,at);
  },{capture:true,signal});
  for(const name of ['pointercancel','lostpointercapture'])stage.addEventListener(name,event=>{
    if(gesture?.pointer===event.pointerId)cancel();
  },{signal});
  function key(event){
    if(!active)return false;
    if(event.key==='Escape')return cancel();
    if(event.key==='Enter'&&draft){void apply().catch(onError);return true;}
    const axis={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(!axis||gesture||event.metaKey||event.ctrlKey||event.altKey)return false;
    const n=event.shiftKey?10:1;
    const delta=axis.map(value=>value*n/4096);
    if(draft)update(translate(draft.transform,delta,false,false));
    else{
      const state=context();
      if(!state.enabled||!state.ids.length)return false;
      try{plan(state);void commit(command(state,[{...identity(),offset:delta,layerIds:state.ids}]),state.origin).catch(onError);}
      catch(error){onError(error);}
    }
    return true;
  }
  return {
    layout,startTransform,key,cancel,
    setActive(next){if(active&&!next)cancel();active=next;layout();},
    isEditing:()=>!!(draft||gesture),
    getState:()=>({snap:snap.checked,guides:guidesFrom(referenceLines),showGuides:guidesVisible}),
    dispose(){cancel();boundsRequest?.abort();arrangeMenu.dispose();guideMenu.dispose();}
  };
}
