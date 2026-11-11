const areas=['modeling','material','drawing'];

export function setupWorkspaceMotion({switcher,workspace,initialArea,initialMotion='system'}){
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let animations=[],mode=initialMotion;
  const isReduced=()=>mode==='reduced'||mode==='system'&&reduced.matches;
  const cancel=()=>{for(const animation of animations)animation.cancel();animations=[];};
  reduced.addEventListener('change',()=>{if(isReduced())cancel();});
  function sync(area,{animate=true}={}){
    const index=areas.indexOf(area);
    if(index<0)return;
    switcher.style.setProperty('--area-index',index);
    switcher.dataset.activeArea=area;
    cancel();
    if(!animate||isReduced()||workspace.hidden)return;
    // Fade the new layout without transforming the canvas or its input bounds.
    for(const panel of workspace.querySelectorAll('.editor-area,.work-area,.dock-zone:not([hidden])')){
      if(panel.matches('.dock-zone')&&panel.closest('.work-area')||!panel.getClientRects().length)continue;
      animations.push(panel.animate([{opacity:.72},{opacity:1}],
        {duration:180,easing:'cubic-bezier(.2,.7,.2,1)'}));
    }
  }
  sync(initialArea,{animate:false});
  requestAnimationFrame(()=>{switcher.dataset.motionReady='';});
  return {sync,setMotion(next){mode=next;if(isReduced())cancel();}};
}
