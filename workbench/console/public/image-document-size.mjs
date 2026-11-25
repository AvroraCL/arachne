// Brush strokes, paths and raster checkpoints share the original 4K editing grid.
// The frame is an unrotated, top-left pixel box on that grid. Document dimensions
// describe the output pixel grid, independently of the material bake.
export const editingSide=4096;
export function validDimensions(width,height){
  return [width,height].every(value=>Number.isInteger(value)&&value>=1&&value<=editingSide);
}
export function initialFrame(width,height){
  return [Math.floor((editingSide-width)/2),Math.floor((editingSide-height)/2),width,height];
}
export function documentFrame(doc){
  return doc?.frame??initialFrame(doc?.width??editingSide,doc?.height??editingSide);
}
export function documentClip(doc){
  const [x,y,w,h]=documentFrame(doc);
  return [x/editingSide,y/editingSide,(x+w)/editingSide,(y+h)/editingSide];
}
export function validFrame(frame){
  return Array.isArray(frame)&&frame.length===4&&frame.every(Number.isFinite)&&
    frame[2]>0&&frame[3]>0&&frame[0]>=0&&frame[1]>=0&&
    frame[0]+frame[2]<=editingSide+1e-7&&frame[1]+frame[3]<=editingSide+1e-7;
}
export function resizedDocument(doc,action,patch){
  const {width,height,anchor,left,top}=patch;
  if(!validDimensions(width,height))throw Error('宽高须为 1 至 4096 的整数像素');
  const frame=documentFrame(doc);
  if(action==='resizeImage')return {width,height,frame:[...frame]};
  let dx,dy;
  if(action==='cropCanvas'){
    if(![left,top].every(Number.isInteger)||left<0||top<0||left+width>doc.width||top+height>doc.height)
      throw Error('裁切框应位于画布内');
    dx=left;dy=top;
  }else{
    if(!Number.isInteger(anchor)||anchor<0||anchor>8)throw Error('请选择画布锚点');
    dx=Math.floor((doc.width-width)*(anchor%3)/2);
    dy=Math.floor((doc.height-height)*Math.floor(anchor/3)/2);
  }
  const sx=frame[2]/doc.width,sy=frame[3]/doc.height;
  const next=[frame[0]+dx*sx,frame[1]+dy*sy,width*sx,height*sy];
  if(!validFrame(next))throw Error('此方向超出可绘制范围，请调整锚点或扩边尺寸');
  return {width,height,frame:next};
}

export function imageViewGeometry(doc){
  if(!doc.frame&&doc.width===editingSide&&doc.height===editingSide)return undefined;
  return {width:doc.width,height:doc.height,frame:documentFrame(doc)};
}

export function previewDimensions(doc,resolution){
  if(!doc)return [resolution,resolution];
  if(resolution===editingSide)return [doc.width,doc.height];
  const [,,w,h]=documentFrame(doc);
  const scale=Math.min(1,resolution/editingSide*Math.max(w,h)/Math.max(doc.width,doc.height));
  return [Math.max(1,Math.round(doc.width*scale)),Math.max(1,Math.round(doc.height*scale))];
}
