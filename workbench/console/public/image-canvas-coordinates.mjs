// A rotated bounding box keeps the canvas center, but its edges no longer track the document axes.
const orientations=new WeakMap();

export function orientImageCanvas(canvas,edge,angle,mirror,height=edge,origin=[.5,.5]){
  const radians=angle*Math.PI/180,cos=Math.cos(radians),sin=Math.sin(radians);
  orientations.set(canvas,{edge,height,origin,cos,sin,sign:mirror?-1:1});
}

export function canvasCoordinates(canvas){
  const box=canvas.getBoundingClientRect(),pose=orientations.get(canvas);
  const center=[box.left+box.width/2,box.top+box.height/2];
  const width=pose?.edge??box.width,height=pose?.height??box.height;
  const {cos,sin,sign}=pose??{cos:1,sin:0,sign:1};
  const [u0,v0]=pose?.origin??[.5,.5];
  function offset([u,v]){
    const x=(u-u0)*width*sign,y=(v-v0)*height;
    return [cos*x-sin*y,sin*x+cos*y];
  }
  function fromClient(x,y){
    x-=center[0];y-=center[1];
    return [u0+(cos*x+sin*y)*sign/width,v0+(-sin*x+cos*y)/height];
  }
  function toLocal(host){
    return point=>{
      const [x,y]=offset(point);
      return [center[0]+x-host.left,center[1]+y-host.top];
    };
  }
  const direction=degrees=>{
    const radians=degrees*Math.PI/180,x=Math.cos(radians)*sign,y=Math.sin(radians);
    return Math.atan2(sin*x+cos*y,cos*x-sin*y)*180/Math.PI;
  };
  return {width,height,center,offset,fromClient,toLocal,direction};
}

export function canvasPoint(canvas,event){
  return canvasCoordinates(canvas).fromClient(event.clientX,event.clientY);
}

export function canvasMatrix(project,size=1){
  const [x,y]=project([0,0]),[u,v]=project([1,0]),[a,b]=project([0,1]);
  return [(u-x)/size,(v-y)/size,(a-x)/size,(b-y)/size,x,y];
}

export function svgCanvasMatrix(project,size){
  return 'matrix('+canvasMatrix(project,size).join(' ')+')';
}
