// Delegate to live title attributes so dynamic editor instances share one tooltip.
export function installPaintTooltips(root=document){
  const tip=document.createElement('div');tip.className='paint-tooltip';tip.id='paint-tool-tip';
  tip.setAttribute('role','tooltip');tip.popover='manual';
  let target=null,title='',timer=null,point=null,description=false,dismissed=false;
  const events=new AbortController(),{signal}=events;
  function hide(){
    clearTimeout(timer);timer=null;
    if(tip.matches(':popover-open'))tip.hidePopover();
    if(description&&target){
      const ids=(target.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==tip.id);
      if(ids.length)target.setAttribute('aria-describedby',ids.join(' '));else target.removeAttribute('aria-describedby');
    }
    description=false;
  }
  function release(){
    hide();observer.disconnect();
    if(target&&target.getAttribute('title')==='')target.setAttribute('title',title);
    target=null;title='';dismissed=false;
  }
  function dismiss(){hide();dismissed=true;}
  function show(){
    timer=null;if(!target?.isConnected||dismissed||!title.trim()){if(!target?.isConnected)release();return;}
    const r=target.getBoundingClientRect();if(!r.width||!r.height)return;
    tip.textContent=title;const host=target.closest('dialog[open]')||document.body;if(tip.parentElement!==host)host.append(tip);
    tip.showPopover();
    const box=tip.getBoundingClientRect(),x=point?.x??r.left,y=point?.y??r.bottom;
    tip.style.left=Math.max(6,Math.min(innerWidth-box.width-6,x+10))+'px';
    tip.style.top=Math.max(6,y+18+box.height<=innerHeight-6?y+18:y-box.height-10)+'px';
    const ids=(target.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean);
    if(!ids.includes(tip.id))ids.push(tip.id);target.setAttribute('aria-describedby',ids.join(' '));description=true;
  }
  const observer=new MutationObserver(records=>{
    if(!target?.isConnected){release();return;}
    if(records.some(r=>r.type==='attributes')){
      const next=target.getAttribute('title');
      if(next!==''&&next!==null){title=next;target.setAttribute('title','');if(tip.matches(':popover-open'))show();}
      else if(next===null)release();
    }
  });
  function enter(element,event){
    if(target===element)return;
    release();if(!element||element.tagName==='SELECT')return;
    title=element.getAttribute('title')||'';if(!title.trim())return;
    target=element;point=event?.clientX===undefined?null:{x:event.clientX,y:event.clientY};
    // Suppress only this native title, and restore it when the pointer leaves.
    target.setAttribute('title','');observer.observe(target,{attributes:true,attributeFilter:['title']});
    observer.observe(root===document?document.body:root,{childList:true,subtree:true});
    timer=setTimeout(show,event?500:350);
  }
  root.addEventListener('pointerover',event=>{if(event.pointerType==='touch'||event.buttons)return;const element=event.target.closest?.('[title]');if(element)enter(element,event);},{signal});
  root.addEventListener('pointerout',event=>{if(target?.contains(event.target)&&!target.contains(event.relatedTarget))release();},{signal});
  root.addEventListener('focusin',event=>{if(event.target.matches?.(':focus-visible'))enter(event.target.closest('[title]'));},{signal});
  root.addEventListener('focusout',event=>{if(target?.contains(event.target))release();},{signal});
  root.addEventListener('pointerdown',dismiss,{capture:true,signal});
  root.addEventListener('keydown',dismiss,{capture:true,signal});
  root.addEventListener('contextmenu',dismiss,{capture:true,signal});
  window.addEventListener('scroll',dismiss,{capture:true,signal});window.addEventListener('resize',dismiss,{signal});
  window.addEventListener('blur',release,{signal});
  return ()=>{release();events.abort();tip.remove();};
}
