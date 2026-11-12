const size={width:1440,height:900};
const minimum={width:900,height:600};
const validBounds=bounds=>bounds&&
  ['x','y','width','height'].every(key=>Number.isInteger(bounds[key])&&Math.abs(bounds[key])<1_000_000)&&
  bounds.width>0&&bounds.height>0;
const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*
  Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
const clamp=(value,min,max)=>Math.max(min,Math.min(value,max));

export function restoreWindowState(saved,workAreas,primary){
  const prior=validBounds(saved?.bounds)?saved.bounds:null;
  let target=primary,largest=0;
  if(prior)for(const area of workAreas){
    const pixels=overlap(prior,area);
    if(pixels>largest){largest=pixels;target=area;}
  }
  const minWidth=Math.min(minimum.width,target.width),minHeight=Math.min(minimum.height,target.height);
  const width=clamp(prior?.width??size.width,minWidth,target.width);
  const height=clamp(prior?.height??size.height,minHeight,target.height);
  const x=largest?clamp(prior.x,target.x,target.x+target.width-width):target.x+Math.floor((target.width-width)/2);
  const y=largest?clamp(prior.y,target.y,target.y+target.height-height):target.y+Math.floor((target.height-height)/2);
  return {bounds:{x,y,width,height},minWidth,minHeight,maximized:prior!==null&&saved.maximized===true};
}
