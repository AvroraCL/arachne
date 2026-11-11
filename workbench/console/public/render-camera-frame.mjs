export function cameraFrameSize(viewWidth,viewHeight,width,height){
  if(![viewWidth,viewHeight,width,height].every(value=>Number.isFinite(value)&&value>0))return null;
  const inset=Math.min(25,viewWidth*.06,viewHeight*.07);
  const scale=Math.min((viewWidth-2*inset)/width,(viewHeight-2*inset)/height);
  return [width*scale,height*scale];
}
