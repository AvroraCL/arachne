// Image inspection is read-only. Source pixels and design exports are untouched.
export function createImageViewer({resolve,comparison=()=>[]}){
 const dialog=document.createElement('dialog');dialog.className='image-viewer';dialog.setAttribute('aria-labelledby','viewer-title');
 dialog.innerHTML=`<header class="viewer-header"><div><span class="viewer-kicker">IMAGE INSPECTOR</span><h2 id="viewer-title">查看大图</h2></div><div class="viewer-actions"><button data-viewer="compare">双图对照</button><button data-viewer="fullscreen" aria-label="切换全屏">全屏</button><button data-viewer="close" aria-label="关闭大图">关闭 <kbd>Esc</kbd></button></div></header><div class="viewer-stage"></div><footer class="viewer-footer"><div class="viewer-actions"><button data-viewer="previous" aria-label="上一张">←</button><span class="viewer-counter"></span><button data-viewer="next" aria-label="下一张">→</button></div><div class="viewer-actions viewer-zoom"><button data-viewer="out" aria-label="缩小图片">−</button><output aria-label="图片缩放比例">100%</output><button data-viewer="in" aria-label="放大图片">＋</button><button data-viewer="fit">适应窗口</button><button data-viewer="actual">原始尺寸</button></div><span class="viewer-help">滚轮缩放 · 放大后拖动 · 双击切换 · ← → 切图</span><a class="viewer-original" target="_blank" rel="noopener">打开原图 ↗</a></footer><p class="viewer-announcement" aria-live="polite"></p>`;
 document.body.append(dialog);const stage=dialog.querySelector('.viewer-stage'),title=dialog.querySelector('h2'),output=dialog.querySelector('output'),counter=dialog.querySelector('.viewer-counter'),original=dialog.querySelector('.viewer-original'),announcement=dialog.querySelector('.viewer-announcement');
 let items=[],index=0,pair=[],paired=false,scale=1,pan=[0,0],trigger=null,drag=null,previousOverflow='';
 const controls=action=>dialog.querySelector(`[data-viewer="${action}"]`);
 const current=()=>paired?pair:[items[index]];
 function reset(){scale=1;pan=[0,0];paint();}
 function zoomBounds(){
   const fit=Number(stage.querySelector('img')?.dataset.fit);
   const actual=fit>0?1/fit:1;
   return [Math.min(.5,actual),Math.max(16,actual)];
 }
 function paint(){
   stage.dataset.zoomed=String(scale>1.01);
   for(const frame of stage.querySelectorAll('.viewer-frame')){const img=frame.querySelector('img');if(!img.naturalWidth)continue;const fit=Math.min(frame.clientWidth/img.naturalWidth,frame.clientHeight/img.naturalHeight)*.96;img.style.width=img.naturalWidth*fit+'px';img.style.height=img.naturalHeight*fit+'px';img.style.transform=`translate(-50%,-50%) translate(${pan[0]*frame.clientWidth}px,${pan[1]*frame.clientHeight}px) scale(${scale})`;img.dataset.fit=fit;}
   const [min,max]=zoomBounds();
   output.value=Math.round(scale*100)+'%';controls('out').disabled=scale<=min;controls('in').disabled=scale>=max;
 }
 function zoom(next,x=0,y=0){const [min,max]=zoomBounds();next=Math.max(min,Math.min(max,next));const factor=next/scale;pan=[x-(x-pan[0])*factor,y-(y-pan[1])*factor];scale=next;boundPan();paint();}
 function boundPan(){pan=pan.map(v=>Math.max(-scale*.55,Math.min(scale*.55,v)));}
 function render(){
   scale=1;pan=[0,0];stage.replaceChildren();stage.classList.toggle('is-pair',paired);title.textContent=paired?'当前最优 / 本轮方案':items[index]?.title||'查看大图';
   controls('compare').hidden=pair.length!==2;controls('compare').textContent=paired?'单张查看':'双图对照';controls('compare').setAttribute('aria-pressed',String(paired));
   for(const action of ['previous','next'])controls(action).disabled=paired||items.length<2;
   counter.textContent=paired?'同步视图':`${index+1} / ${items.length}`;original.hidden=paired;if(!paired)original.href=items[index].url;
   announcement.textContent='正在加载图片…';
   for(const item of current()){
     const pane=document.createElement('section');pane.className='viewer-pane';const label=document.createElement('div');label.className='viewer-label';label.textContent=item.title;
     const frame=document.createElement('div');frame.className='viewer-frame';frame.setAttribute('aria-label',item.title);
     const img=new Image();img.alt=item.title;img.draggable=false;img.src=item.url;img.onload=()=>{paint();announcement.textContent='图片已加载';};img.onerror=()=>{img.hidden=true;const error=document.createElement('p');error.className='viewer-error';error.textContent='图片暂不可用，请关闭后刷新重试。';frame.append(error);announcement.textContent='图片读取失败';};
     frame.append(img);pane.append(label,frame);stage.append(pane);
     frame.addEventListener('wheel',e=>{e.preventDefault();const r=frame.getBoundingClientRect();zoom(scale*Math.exp(-e.deltaY*.0015),(e.clientX-r.left)/r.width-.5,(e.clientY-r.top)/r.height-.5);},{passive:false});
     frame.addEventListener('pointerdown',e=>{if(e.button!==0||scale<=1)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,pan:[...pan],frame};frame.setPointerCapture(e.pointerId);frame.classList.add('dragging');});
     frame.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;pan=[drag.pan[0]+(e.clientX-drag.x)/frame.clientWidth,drag.pan[1]+(e.clientY-drag.y)/frame.clientHeight];boundPan();paint();});
     const end=()=>{drag=null;frame.classList.remove('dragging');};frame.addEventListener('pointerup',end);frame.addEventListener('pointercancel',end);
     frame.addEventListener('dblclick',e=>{e.preventDefault();if(scale>1)reset();else{const r=frame.getBoundingClientRect();zoom(2,(e.clientX-r.left)/r.width-.5,(e.clientY-r.top)/r.height-.5);}});
   }
   requestAnimationFrame(paint);
 }
 function open(id,{compare=false,from=null,galleryIds=null}={}){
   const seen=new Set();items=(galleryIds||[...document.querySelectorAll('#content [data-preview-id]')].map(el=>el.dataset.previewId)).map(resolve).filter(item=>item&&!seen.has(item.id)&&seen.add(item.id));
   const requested=resolve(id);if(requested&&!items.some(item=>item.id===id))items.unshift(requested);if(!items.length)return;
   index=Math.max(0,items.findIndex(item=>item.id===id));pair=comparison().map(resolve).filter(Boolean).slice(0,2);paired=compare&&pair.length===2;trigger=from||document.activeElement;
   previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';render();if(!dialog.open)dialog.showModal();controls('close').focus();
 }
 function move(delta){if(paired||items.length<2)return;index=(index+delta+items.length)%items.length;render();}
 async function action(name){
   if(name==='close')dialog.close();if(name==='in')zoom(scale*1.25);if(name==='out')zoom(scale/1.25);if(name==='fit')reset();
   if(name==='actual'){const img=stage.querySelector('img');if(img?.dataset.fit)zoom(1/Number(img.dataset.fit));}
   if(name==='previous')move(-1);if(name==='next')move(1);if(name==='compare'){paired=!paired;render();}
   if(name==='fullscreen'){try{if(document.fullscreenElement)await document.exitFullscreen();else await dialog.requestFullscreen();}catch{announcement.textContent='浏览器未允许系统全屏；当前已使用窗口最大查看区域。';}}
 }
 dialog.addEventListener('click',e=>{const button=e.target.closest('[data-viewer]');if(button)void action(button.dataset.viewer);});
 dialog.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const keys={ArrowLeft:'previous',ArrowRight:'next','+':'in','=':'in','-':'out','0':'fit'};if(keys[e.key]){e.preventDefault();void action(keys[e.key]);}});
 dialog.addEventListener('close',()=>{document.body.style.overflow=previousOverflow;if(document.fullscreenElement===dialog)void document.exitFullscreen().catch(()=>{});if(trigger?.isConnected)trigger.focus({preventScroll:true});});
 document.addEventListener('click',e=>{const el=e.target.closest('[data-preview-id]');if(!el||el.closest('.diagnostic'))return;e.preventDefault();e.stopPropagation();const viewport=el.closest('.art-viewport');if(viewport&&performance.now()-Number(viewport.dataset.draggedAt||-1000)<300)return;open(el.dataset.previewId,{from:el});},true);
 document.addEventListener('keydown',e=>{const el=e.target.closest('[data-preview-id]');if(el&&['Enter',' '].includes(e.key)){e.preventDefault();open(el.dataset.previewId,{from:el});}});
 new ResizeObserver(()=>{if(dialog.open)paint();}).observe(stage);
 return {open,get isOpen(){return dialog.open;}};
}
