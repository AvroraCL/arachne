import {headerControls,chromeButton} from './area-chrome.mjs';
import {syncSelectMenu} from './paint-select.mjs';
import {cyclesProgressLabel} from './cycles-progress-ui.mjs';
import {cyclesFormatLabel,showRenderDownload,showRenderPassDownload} from './render-output-ui.mjs';

const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const active=job=>job.status==='queued'||job.status==='running';
const supported=job=>job.type==='paint-render'||job.type==='paint-export';
const pixels=job=>job?.cycles?.resolution||[job?.paintSettings?.width||0,job?.paintSettings?.height||0];
const kind=job=>job.type==='paint-export'?'交付':'出图';
const crop=job=>job?.cycles?.render_region?.crop?[job.cycles.render_region.frame,job.cycles.render_region.pixels]:null;
const comparable=(a,b)=>!!a&&!!b&&a.id!==b.id&&JSON.stringify(pixels(a))===JSON.stringify(pixels(b))&&
  JSON.stringify(crop(a))===JSON.stringify(crop(b));
const resultLabel=item=>`r${item.revision} · ${kind(item)} · ${new Date(item.created).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;

export function createRenderResultEditor(ctx,source){
  const {host,state,onChange}=ctx,lifecycle=new AbortController(),{signal}=lifecycle;
  host.classList.add('render-result-editor');
  const tools=el('div','editor-toolbar'),select=el('select');
  select.setAttribute('aria-label','渲染结果版本');select.dataset.searchable='false';tools.append(select);
  const stage=el('div','render-result-stage'),image=el('img','render-result-image'),empty=el('p','render-result-empty');
  stage.tabIndex=0;stage.setAttribute('aria-label','渲染图像，滚轮缩放，拖动平移');
  image.alt='Cycles 渲染结果';image.draggable=false;image.decoding='async';image.hidden=true;
  const reference=el('img','render-result-image render-result-reference'),wipeHandle=el('div','render-result-wipe');
  reference.draggable=false;reference.decoding='async';reference.hidden=wipeHandle.hidden=true;
  wipeHandle.tabIndex=0;wipeHandle.setAttribute('role','slider');wipeHandle.setAttribute('aria-label','渲染对照分隔线');
  wipeHandle.setAttribute('aria-valuemin','0');wipeHandle.setAttribute('aria-valuemax','100');
  const labels=el('div','render-result-compare-labels'),left=el('span'),right=el('span');labels.hidden=true;labels.append(left,right);
  stage.append(image,reference,empty,wipeHandle,labels);
  const bar=el('div','render-result-status'),message=el('output'),meta=el('span'),zoomStatus=el('output','render-result-zoom');
  message.setAttribute('aria-live','polite');zoomStatus.setAttribute('aria-label','渲染缩放比例');
  bar.append(message,meta,zoomStatus);host.append(stage,bar);
  let projectId=state.projectId||null,selectedId=state.jobId||null,key='',job=null,drag=null,visible=true;
  let compare=state.compare===true,referenceId=state.referenceId||null,referenceJob=null,referenceKey='',wipeDrag=null;
  let wipe=Number.isFinite(state.wipe)?clamp(state.wipe,0,1):.5;
  let zoom=Number.isFinite(state.zoom)&&state.zoom>=.01&&state.zoom<=16?state.zoom:null;
  let pan=Array.isArray(state.pan)&&state.pan.length===2&&state.pan.every(Number.isFinite)?state.pan.slice():[0,0];
  const button=(label,action)=>{
    const control=el('button','',label);control.type='button';control.onclick=action;tools.append(control);return control;
  };
  const fit=button('适应',()=>reset(null));chromeButton(fit,'fit','适应渲染图像');
  const actual=button('100%',()=>reset(1));actual.title='原始像素比例 · 1';
  const tasks=button('出图任务…',()=>source.openJobs());
  const compareButton=button('对照',toggleCompare);compareButton.title='对照同尺寸渲染 · C';
  const compareSelect=el('select');compareSelect.setAttribute('aria-label','对照参考渲染');compareSelect.dataset.searchable='false';
  compareSelect.onchange=()=>{referenceId=compareSelect.value||null;sync();onChange();};
  tools.append(compareSelect);
  const download=el('a','render-result-download','下载 PNG');download.hidden=true;tools.append(download);
  const passes=el('a','render-result-download','通道 EXR');passes.hidden=true;tools.append(passes);
  headerControls(ctx,tools);
  function dimensions(){return job?pixels(job):[0,0];}
  function fitted(){
    const [width,height]=dimensions();
    if(!width||!height||!stage.clientWidth||!stage.clientHeight)return 1;
    return Math.min(1,stage.clientWidth/width,stage.clientHeight/height);
  }
  function setImagePose(){
    const [width,height]=dimensions(),scale=zoom??fitted();
    const bounds=[width*scale/2+stage.clientWidth/2-22,height*scale/2+stage.clientHeight/2-22];
    pan=pan.map((value,index)=>clamp(value,-Math.max(0,bounds[index]),Math.max(0,bounds[index])));
    image.style.width=width*scale+'px';image.style.height=height*scale+'px';
    image.style.transform=`translate(-50%, -50%) translate(${pan[0]}px, ${pan[1]}px)`;
    if(referenceJob&&!reference.hidden){
      reference.style.width=image.style.width;reference.style.height=image.style.height;reference.style.transform=image.style.transform;
      reference.style.clipPath=`inset(0 ${100-wipe*100}% 0 0)`;
      const x=stage.clientWidth/2+pan[0]+(wipe-.5)*width*scale;
      const center=stage.clientHeight/2+pan[1],top=Math.max(0,center-height*scale/2);
      const bottom=Math.min(stage.clientHeight,center+height*scale/2);
      wipeHandle.style.left=x+'px';wipeHandle.style.top=top+'px';wipeHandle.style.height=Math.max(0,bottom-top)+'px';
      wipeHandle.hidden=x<0||x>stage.clientWidth||bottom<=top;
      wipeHandle.setAttribute('aria-valuenow',String(Math.round(wipe*100)));
    }else wipeHandle.hidden=true;
    stage.toggleAttribute('data-pannable',!!job&&zoom!==null);
    zoomStatus.textContent=job?`${Number((scale*100).toFixed(1))}%`:'';
  }
  function toggleCompare(){
    if(compareButton.disabled)return;
    compare=!compare;sync();onChange();
  }
  function setWipe(value){wipe=clamp(value,0,1);setImagePose();}
  wipeHandle.addEventListener('pointerdown',event=>{
    if(event.button!==0||!referenceJob)return;
    event.preventDefault();event.stopPropagation();
    wipeDrag={id:event.pointerId,x:event.clientX,wipe};wipeHandle.focus({preventScroll:true});
    wipeHandle.setPointerCapture(event.pointerId);
  },{signal});
  wipeHandle.addEventListener('pointermove',event=>{
    if(wipeDrag?.id!==event.pointerId)return;
    setWipe(wipeDrag.wipe+(event.clientX-wipeDrag.x)/(dimensions()[0]*(zoom??fitted())));
  },{signal});
  function endWipe(event){
    if(wipeDrag?.id!==event.pointerId)return;
    wipeDrag=null;event.stopPropagation();onChange();
  }
  for(const event of ['pointerup','pointercancel','lostpointercapture'])wipeHandle.addEventListener(event,endWipe,{signal});
  wipeHandle.addEventListener('dblclick',event=>{event.stopPropagation();setWipe(.5);onChange();},{signal});
  wipeHandle.addEventListener('keydown',event=>{
    const step=event.shiftKey?.1:.02;
    if(event.key==='Home')setWipe(0);
    else if(event.key==='End')setWipe(1);
    else if(['ArrowLeft','ArrowDown','ArrowRight','ArrowUp'].includes(event.key))
      setWipe(wipe+(['ArrowLeft','ArrowDown'].includes(event.key)?-step:step));
    else return;
    event.preventDefault();event.stopPropagation();onChange();
  },{signal});
  function reset(next){
    zoom=next;pan=[0,0];setImagePose();onChange();
  }
  function zoomAt(factor,x=0,y=0){
    if(!job||!Number.isFinite(factor)||factor<=0)return;
    const current=zoom??fitted(),next=clamp(current*factor,.01,16),ratio=next/current;
    pan=[x+(pan[0]-x)*ratio,y+(pan[1]-y)*ratio];zoom=next;setImagePose();onChange();
  }
  stage.addEventListener('wheel',event=>{
    if(!job)return;
    event.preventDefault();const rect=stage.getBoundingClientRect(),unit=event.deltaMode===1?16:event.deltaMode===2?rect.height:1;
    zoomAt(Math.exp(clamp(-event.deltaY*unit*.0015,-2,2)),event.clientX-rect.left-rect.width/2,event.clientY-rect.top-rect.height/2);
  },{passive:false,signal});
  stage.addEventListener('pointerdown',event=>{
    if(!job||drag||wipeDrag||![0,1].includes(event.button))return;
    stage.focus({preventScroll:true});
    if(event.button===0&&zoom===null)return;
    if(zoom===null)zoom=fitted();
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,pan:pan.slice()};
    stage.setPointerCapture(event.pointerId);stage.dataset.dragging='';event.preventDefault();
  },{signal});
  stage.addEventListener('pointermove',event=>{
    if(drag?.id!==event.pointerId)return;
    pan=[drag.pan[0]+event.clientX-drag.x,drag.pan[1]+event.clientY-drag.y];setImagePose();
  },{signal});
  function finish(event){
    if(drag?.id!==event.pointerId)return;
    drag=null;delete stage.dataset.dragging;onChange();
  }
  for(const event of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(event,finish,{signal});
  stage.addEventListener('dblclick',()=>{if(job)reset(zoom===null?1:null);},{signal});
  stage.addEventListener('keydown',event=>{
    if(!job||event.altKey||event.ctrlKey||event.metaKey)return;
    if(event.key.toLowerCase()==='c')toggleCompare();
    else if(event.key==='0')reset(null);
    else if(event.key==='1')reset(1);
    else if(['+','=','-'].includes(event.key))zoomAt(event.key==='-'?.8:1.25);
    else return;
    event.preventDefault();event.stopPropagation();
  },{signal});
  image.addEventListener('error',()=>{image.hidden=true;empty.hidden=false;empty.textContent='无法读取渲染图像';},{signal});
  function syncReferenceImage(){
    reference.hidden=labels.hidden=!referenceJob||!reference.complete||reference.naturalWidth===0||
      reference.getAttribute('src')!==referenceJob.renderUrl;
  }
  const updateReference=()=>{syncReferenceImage();setImagePose();};
  reference.addEventListener('load',updateReference,{signal});
  reference.addEventListener('error',updateReference,{signal});
  select.onchange=()=>{selectedId=select.value||null;zoom=null;pan=[0,0];sync();onChange();};
  function sync(){
    if(!visible)return;
    const {doc,jobs}=source.read(),available=jobs.filter(job=>supported(job)&&job.status==='completed'&&job.renderUrl);
    if(doc&&projectId!==doc.id){projectId=doc.id;selectedId=null;referenceId=null;wipe=.5;zoom=null;pan=[0,0];}
    const selected=selectedId&&available.find(item=>item.id===selectedId);
    const current=selected||available[0],recent=available.slice(0,20);
    if(selected&&!recent.includes(selected))recent.push(selected);
    const selectionKey=JSON.stringify([projectId,selectedId,recent.map(item=>item.id)]);
    if(selectionKey!==key){
      key=selectionKey;
      select.replaceChildren(new Option('跟随最新结果',''),...recent.map(item=>new Option(resultLabel(item),item.id)));
      select.value=selected?.id||'';select.disabled=!available.length;syncSelectMenu(select);
    }
    const running=jobs.find(item=>supported(item)&&active(item));
    const status=running?`r${running.revision} · ${cyclesProgressLabel(running.progress)||running.stage}`:'';
    if(message.textContent!==status)message.textContent=status;
    if(current?.id!==job?.id||current&&image.getAttribute('src')!==current.renderUrl){
      if(job&&current&&job.id!==current.id&&!selected){zoom=null;pan=[0,0];}
      if(current){image.src=current.renderUrl;image.alt=`工程修订 r${current.revision} 的 Cycles 渲染`;}
      else image.removeAttribute('src');
      image.hidden=!current;empty.hidden=!!current;
    }
    job=current||null;
    const candidates=available.filter(item=>comparable(job,item));
    const selectedReference=candidates.find(item=>item.id===referenceId)||candidates[0];
    const nextKey=JSON.stringify([selectedReference?.id,candidates.slice(0,20).map(item=>item.id)]);
    if(referenceKey!==nextKey){
      referenceKey=nextKey;
      const visibleCandidates=candidates.slice(0,20);
      if(selectedReference&&!visibleCandidates.includes(selectedReference))visibleCandidates.push(selectedReference);
      compareSelect.replaceChildren(...visibleCandidates.map(item=>new Option(resultLabel(item),item.id)));
      compareSelect.value=selectedReference?.id||'';syncSelectMenu(compareSelect);
    }
    referenceJob=compare?selectedReference||null:null;
    compareButton.disabled=!compare&&!candidates.length;
    compareButton.setAttribute('aria-pressed',String(compare&&!!referenceJob));
    compareButton.title=candidates.length?'对照同尺寸渲染 · C':'没有可对照的同尺寸渲染';
    compareSelect.hidden=!referenceJob;
    const compareMenu=compareSelect.closest('.custom-select');if(compareMenu)compareMenu.hidden=!referenceJob;
    if(referenceJob){
      if(reference.getAttribute('src')!==referenceJob.renderUrl)reference.src=referenceJob.renderUrl;
      reference.alt=`对照参考 r${referenceJob.revision} 的 Cycles 渲染`;
      left.textContent='参考 r'+referenceJob.revision;right.textContent='当前 r'+job.revision;
    }else reference.removeAttribute('src');
    syncReferenceImage();
    empty.textContent=doc?'还没有渲染结果':'请先打开工程';
    actual.disabled=fit.disabled=!job;tasks.disabled=!doc;download.hidden=!job;
    showRenderPassDownload(passes,job);
    if(job){
      const [width,height]=pixels(job);
      showRenderDownload(download,job,doc.name);
      meta.textContent=[`r${job.revision}`,`${width} × ${height}`,cyclesFormatLabel(job.cycles?.render_effective?.fileFormat),job.cycles?.device||job.progress?.device].filter(Boolean).join(' · ');
    }else meta.textContent='';
    ctx.title.textContent=job?`r${job.revision} · Cycles`:'';
    setImagePose();
  }
  const observer=new ResizeObserver(setImagePose);observer.observe(stage);
  const unsubscribe=source.subscribe(sync);sync();
  return {kind:'renderResult',sync,getState:()=>({projectId,jobId:selectedId,zoom,pan:pan.slice(),compare,referenceId,wipe}),
    setVisible(value){visible=value;if(visible)sync();else{image.removeAttribute('src');reference.removeAttribute('src');}},
    dispose(){lifecycle.abort();observer.disconnect();unsubscribe();image.removeAttribute('src');reference.removeAttribute('src');}};
}
