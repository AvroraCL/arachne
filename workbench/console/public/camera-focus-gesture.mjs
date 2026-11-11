export function createCameraFocusGesture({host,origin,pick,commit,changed,error,signal}){
  const overlay=document.createElement('div');
  overlay.className='camera-focus-overlay';overlay.tabIndex=-1;
  overlay.setAttribute('aria-label','拾取相机对焦距离');overlay.hidden=true;host.append(overlay);
  let active=null,pending=null,missed=false,disposed=false;
  function arm(){
    if(pending||disposed)return false;
    active=origin();if(!active)return false;
    missed=false;overlay.hidden=false;changed();overlay.focus({preventScroll:true});return true;
  }
  function cancel(){
    if(!active)return false;
    active=null;missed=false;overlay.hidden=true;changed();return true;
  }
  overlay.addEventListener('pointerdown',event=>{
    if(!active||event.button!==0)return;
    event.preventDefault();event.stopPropagation();
    const distance=pick(event.clientX,event.clientY);
    if(!Number.isFinite(distance)||distance<.001||distance>1e6){missed=true;changed();return;}
    const snapshot=active;active=null;overlay.hidden=true;
    pending=Promise.resolve().then(()=>commit(distance,snapshot)).catch(error).finally(()=>{
      pending=null;if(!disposed)changed();
    });
    changed();
  },{signal});
  overlay.addEventListener('wheel',event=>event.preventDefault(),{signal,passive:false});
  return {arm,cancel,armed:()=>!!active,editing:()=>!!active||!!pending,settled:()=>pending,missed:()=>missed,
    dispose(){disposed=true;active=null;overlay.remove();}};
}
