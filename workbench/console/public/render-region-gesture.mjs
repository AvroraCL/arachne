import {checkRenderRegion} from './render-region.mjs';

export function createRenderRegionGesture({host,read,origin,commit,changed,error,signal}){
  const overlay=document.createElement('div'),box=document.createElement('div');
  overlay.className='render-region-overlay';overlay.tabIndex=-1;overlay.setAttribute('aria-label','绘制相机渲染区域');
  box.className='render-region-box';overlay.append(box);host.append(overlay);
  let framed=false,active=null,drag=null,preview=null,pending=null,disposed=false;
  const point=event=>{
    const bounds=overlay.getBoundingClientRect();
    return [(event.clientX-bounds.left)/Math.max(1,bounds.width),(event.clientY-bounds.top)/Math.max(1,bounds.height)]
      .map(value=>Math.min(1,Math.max(0,value)));
  };
  function sync(show=framed){
    framed=show;const region=preview||read();
    overlay.hidden=!framed||!active&&!region?.enabled;
    overlay.toggleAttribute('data-armed',!!active);
    box.hidden=!region;
    if(region){
      box.style.left=region.x0*100+'%';box.style.top=region.y0*100+'%';
      box.style.width=(region.x1-region.x0)*100+'%';box.style.height=(region.y1-region.y0)*100+'%';
    }
  }
  function cancel(){
    if(!active)return false;
    const pointer=drag?.pointer;active=null;drag=null;preview=null;
    if(pointer!==undefined&&overlay.hasPointerCapture(pointer))overlay.releasePointerCapture(pointer);
    sync();changed();return true;
  }
  function arm(){
    if(pending||disposed||!framed)return false;
    const next=origin();if(!next)return false;
    active=next;sync();changed();overlay.focus({preventScroll:true});return true;
  }
  function update(event){
    const [x,y]=point(event),[u,v]=drag.start;
    preview={enabled:true,crop:read()?.crop??false,x0:Math.min(x,u),y0:Math.min(y,v),x1:Math.max(x,u),y1:Math.max(y,v)};
    sync();
  }
  overlay.addEventListener('pointerdown',event=>{
    if(!active||drag||event.button!==0)return;
    event.preventDefault();event.stopPropagation();
    drag={pointer:event.pointerId,start:point(event),x:event.clientX,y:event.clientY};
    overlay.setPointerCapture(event.pointerId);update(event);
  },{signal});
  overlay.addEventListener('pointermove',event=>{if(drag?.pointer===event.pointerId)update(event);},{signal});
  overlay.addEventListener('pointerup',event=>{
    if(drag?.pointer!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();update(event);
    const snapshot=active,region=preview,moved=Math.abs(event.clientX-drag.x)>=4&&Math.abs(event.clientY-drag.y)>=4;
    active=null;drag=null;
    if(overlay.hasPointerCapture(event.pointerId))overlay.releasePointerCapture(event.pointerId);
    if(!moved){preview=null;sync();changed();return;}
    pending=Promise.resolve().then(()=>commit(checkRenderRegion(region),snapshot)).catch(error).finally(()=>{
      pending=null;preview=null;if(!disposed){sync();changed();}
    });
    changed();
  },{signal});
  overlay.addEventListener('pointercancel',cancel,{signal});
  overlay.addEventListener('lostpointercapture',event=>{if(drag?.pointer===event.pointerId)cancel();},{signal});
  overlay.addEventListener('wheel',event=>{if(active)event.preventDefault();},{signal,passive:false});
  return {sync,arm,cancel,armed:()=>!!active,editing:()=>!!active||!!pending,settled:()=>pending,dispose(){disposed=true;active=null;drag=null;overlay.remove();}};
}
