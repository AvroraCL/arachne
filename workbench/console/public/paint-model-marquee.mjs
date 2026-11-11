// Project mesh vertices to the current camera's clip volume once per selection.
export function projectMarqueeVertices(position,matrix){
  const m=matrix.elements,points=new Float32Array(position.count*2).fill(NaN);
  for(let i=0;i<position.count;i++){
    const x=position.getX(i),y=position.getY(i),z=position.getZ(i);
    const w=m[3]*x+m[7]*y+m[11]*z+m[15],depth=m[2]*x+m[6]*y+m[10]*z+m[14];
    if(w<=0||depth<-w||depth>w)continue;
    points[i*2]=(m[0]*x+m[4]*y+m[8]*z+m[12])/w;
    points[i*2+1]=(m[1]*x+m[5]*y+m[9]*z+m[13])/w;
  }
  return points;
}

function contains(x,y,[left,bottom,right,top]){
  return x>=left&&x<=right&&y>=bottom&&y<=top;
}

export function vertexInMarquee(points,i,rect){
  return contains(points[2*i],points[2*i+1],rect);
}

export function edgeInMarquee(points,a,b,[left,bottom,right,top]){
  const ax=points[2*a],ay=points[2*a+1],bx=points[2*b],by=points[2*b+1];
  if(Math.max(ax,bx)<left||Math.min(ax,bx)>right||Math.max(ay,by)<bottom||Math.min(ay,by)>top)return false;
  const dx=bx-ax,dy=by-ay;
  const x0=-dy*(left-ax),x1=-dy*(right-ax),y0=dx*(bottom-ay),y1=dx*(top-ay);
  return Math.min(x0,x1)+Math.min(y0,y1)<=0&&Math.max(x0,x1)+Math.max(y0,y1)>=0;
}

export function faceCenterInMarquee(points,vertices,rect){
  let x=0,y=0;
  for(const i of vertices){x+=points[2*i];y+=points[2*i+1];}
  return contains(x/vertices.length,y/vertices.length,rect);
}

export function visitTriangles(geometry,visit){
  const index=geometry.index,count=index?.count??geometry.attributes.position.count;
  for(let start=0;start+2<count;start+=3){
    const a=index?index.getX(start):start,b=index?index.getX(start+1):start+1,c=index?index.getX(start+2):start+2;
    if(visit(a,b,c,start/3))return true;
  }
  return false;
}

export function meshInMarquee(points,geometry,rect){
  for(let i=0;i<points.length/2;i++)if(vertexInMarquee(points,i,rect))return true;
  const x=(rect[0]+rect[2])/2,y=(rect[1]+rect[3])/2;
  return visitTriangles(geometry,(a,b,c)=>{
    if(edgeInMarquee(points,a,b,rect)||edgeInMarquee(points,b,c,rect)||edgeInMarquee(points,c,a,rect))return true;
    const ax=points[2*a],ay=points[2*a+1],bx=points[2*b],by=points[2*b+1],cx=points[2*c],cy=points[2*c+1];
    if(!Number.isFinite(ax+ay+bx+by+cx+cy))return false;
    const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
    if(Math.abs(area)<1e-12)return false;
    const first=(bx-ax)*(y-ay)-(by-ay)*(x-ax);
    const second=(cx-bx)*(y-by)-(cy-by)*(x-bx);
    const third=(ax-cx)*(y-cy)-(ay-cy)*(x-cx);
    return area>0?Math.min(first,second,third)>=0:Math.max(first,second,third)<=0;
  });
}
export function createViewportMarquee({host,button,canStart,select,onChange,signal}){
  const overlay=document.createElement('span');
  overlay.className='editor-model-marquee';
  overlay.hidden=true;
  overlay.setAttribute('aria-hidden','true');
  host.append(overlay);
  let armed=false,drag=null;
  const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
  const point=(event,bounds)=>[
    Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),
    Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))
  ];
  function setArmed(next){
    const previous=drag;
    drag=null;armed=next;
    overlay.hidden=true;
    host.toggleAttribute('data-model-marquee',armed);
    button.setAttribute('aria-pressed',String(armed));
    if(previous&&host.hasPointerCapture(previous.pointer))host.releasePointerCapture(previous.pointer);
    onChange(armed);
  }
  function boundsFor(event){
    const [x,y]=point(event,drag.bounds),[startX,startY]=drag.start;
    return [Math.min(x,startX),Math.min(y,startY),Math.max(x,startX),Math.max(y,startY)];
  }
  const cancel=()=>{if(!armed)return false;setArmed(false);return true;};
  host.addEventListener('pointerdown',event=>{
    if(!armed||drag||!canStart()||![0,1].includes(event.button)||!event.target.matches('canvas'))return;
    const bounds=event.target.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return;
    drag={pointer:event.pointerId,bounds,start:point(event,bounds),action:event.shiftKey||event.button===1?'subtract':'extend'};
    host.setPointerCapture(event.pointerId);
    stop(event);
  },{capture:true,signal});
  host.addEventListener('pointermove',event=>{
    if(drag?.pointer!==event.pointerId)return;
    const [left,top,right,bottom]=boundsFor(event),{width,height}=drag.bounds;
    Object.assign(overlay.style,{left:left*width+'px',top:top*height+'px',width:(right-left)*width+'px',height:(bottom-top)*height+'px'});
    overlay.hidden=false;
    stop(event);
  },{capture:true,signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])host.addEventListener(type,event=>{
    if(drag?.pointer!==event.pointerId)return;
    const [left,top,right,bottom]=boundsFor(event),{bounds,action}=drag;
    setArmed(false);
    if(type==='pointerup'&&(right-left)*bounds.width>=3&&(bottom-top)*bounds.height>=3)
      select([left*2-1,1-bottom*2,right*2-1,1-top*2],action);
    stop(event);
  },{capture:true,signal});
  host.addEventListener('contextmenu',event=>{if(cancel())stop(event);},{capture:true,signal});
  host.addEventListener('wheel',event=>{if(drag)stop(event);},{capture:true,passive:false,signal});
  window.addEventListener('blur',cancel,{signal});
  window.addEventListener('resize',cancel,{signal});
  return {
    cancel,isArmed:()=>armed,isDragging:()=>!!drag,
    toggle(){
      if(cancel())return true;
      if(!canStart())return false;
      setArmed(true);host.querySelector('canvas')?.focus({preventScroll:true});
      return true;
    }
  };
}
