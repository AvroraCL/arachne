const coordinates=['x0','y0','x1','y1'];
export function checkRenderRegion(region){
  if(!region||typeof region!=='object'||Array.isArray(region)||Object.keys(region).length!==6||
    typeof region.enabled!=='boolean'||typeof region.crop!=='boolean'||
    !coordinates.every(key=>Object.hasOwn(region,key)&&typeof region[key]==='number'&&Number.isFinite(region[key])&&region[key]>=0&&region[key]<=1)||
    region.x1-region.x0<.002||region.y1-region.y0<.002)throw Error('渲染区域无效');
  return {enabled:region.enabled,crop:region.crop,...Object.fromEntries(coordinates.map(key=>[key,region[key]]))};
}

export function renderRegionPixels(region,width,height){
  if(!region?.enabled)return null;
  const {x0,y0,x1,y1,crop}=checkRenderRegion(region);
  const pair=(min,max,extent)=>{
    const start=Math.min(extent-4,Math.round(min*extent));
    return [start,Math.max(start+4,Math.round(max*extent))];
  };
  const [left,right]=pair(x0,x1,width),[top,bottom]=pair(y0,y1,height);
  return {frame:[width,height],pixels:[left,top,right,bottom],crop,
    output:crop?[right-left,bottom-top]:[width,height]};
}
