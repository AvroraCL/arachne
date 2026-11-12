export function viewportPixelRatio(value){
  return Number.isFinite(value)&&value>0?Math.min(2,value):1;
}

// Moving between displays may change devicePixelRatio without resizing the
// viewport's CSS box. Renew the resolution query at each physical scale.
export function watchViewportScale(win,onChange){
  let current=null,query=null;
  function update(){
    const ratio=Number.isFinite(win.devicePixelRatio)&&win.devicePixelRatio>0?win.devicePixelRatio:1;
    if(ratio===current)return;
    query?.removeEventListener('change',update);
    current=ratio;
    query=win.matchMedia('(resolution: '+ratio+'dppx)');
    query.addEventListener('change',update);
    onChange(viewportPixelRatio(ratio));
  }
  win.addEventListener('resize',update);
  update();
  return ()=>{
    win.removeEventListener('resize',update);
    query?.removeEventListener('change',update);
  };
}
