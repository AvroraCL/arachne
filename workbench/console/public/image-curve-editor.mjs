import {enhanceSelectMenu} from './paint-select.mjs';
import {curveChannels,curveSlopes,maxCurvePoints} from './image-adjustments.mjs';
import {imageLayersBeforeAdjustment,visibleImageLayers} from './image-documents.mjs';

const svgNS='http://www.w3.org/2000/svg';
const el=(tag,className)=>{const node=document.createElement(tag);if(className)node.className=className;return node;};
const svg=(tag,attrs)=>{const node=document.createElementNS(svgNS,tag);for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);return node;};
const byte=(value,min=0,max=255)=>Math.max(min,Math.min(max,Math.round(value)));
const completedHistograms=new Map(),pendingHistograms=new Map();

function histograms(pixels){
  const counts=Object.fromEntries(curveChannels.map(([id])=>[id,new Float32Array(256)]));
  for(let i=0;i<pixels.length;i+=4){
    const alpha=pixels[i+3]/255;
    if(!alpha)continue;
    const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    counts.rgb[Math.round(.2126*r+.7152*g+.0722*b)]+=alpha;
    counts.red[r]+=alpha;counts.green[g]+=alpha;counts.blue[b]+=alpha;
  }
  return counts;
}

function loadHistogram({id,revision,documentId},image,layerId){
  const input=visibleImageLayers(imageLayersBeforeAdjustment(image.layers,layerId)||[]);
  const key=JSON.stringify([id,documentId,image.colorSpace,input]);
  if(completedHistograms.has(key))return Promise.resolve(completedHistograms.get(key));
  if(!input.length)return Promise.resolve(histograms([]));
  const pendingKey=key+'@'+revision,existing=pendingHistograms.get(pendingKey);
  if(existing)return existing;
  const request=(async()=>{
    const response=await fetch('/api/projects/'+id+'/paint/image-live',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,documentId,beforeImageLayer:layerId,resolution:256})});
    if(response.status!==200)return null;
    const pixels=new Uint8Array(await response.arrayBuffer());
    if(pixels.length!==256*256*4)return null;
    const counts=histograms(pixels);
    completedHistograms.set(key,counts);
    if(completedHistograms.size>8)completedHistograms.delete(completedHistograms.keys().next().value);
    return counts;
  })().catch(()=>null).finally(()=>pendingHistograms.delete(pendingKey));
  pendingHistograms.set(pendingKey,request);
  return request;
}

function histogramPath(counts){
  const smoothed=Array.from(counts,(count,x)=>(counts[x-1]||0)+2*count+(counts[x+1]||0));
  const peak=Math.max(1,...smoothed);
  return 'M0 255'+smoothed.map((count,x)=>' L'+x+' '+(255-238*Math.sqrt(count/peak)).toFixed(1)).join('')+' L255 255Z';
}

function curvesPath(points){
  const slopes=curveSlopes(points);
  let path='M'+points[0][0]+' '+(255-points[0][1]);
  for(let i=1;i<points.length;i++){
    const [x,y]=points[i-1],[nextX,nextY]=points[i],span=(nextX-x)/3;
    path+=` C${x+span} ${255-y-span*slopes[i-1]} ${nextX-span} ${255-nextY+span*slopes[i]} ${nextX} ${255-nextY}`;
  }
  return path;
}

export function createCurveEditor(parent,{layer,image,origin,channel:initialChannel,point:initialPoint,disabled,onChannel,onPoint,onPreview,onCommit}){
  let channel=curveChannels.some(([id])=>id===initialChannel)?initialChannel:'rgb';
  let points=structuredClone(layer.adjustment.points),selected=-1,counts=null,gesture=null,change=null,pending=false,disposed=false,frame=0;
  if(Number.isInteger(initialPoint)&&points[channel][initialPoint])selected=initialPoint;
  const channelSelect=el('select');
  channelSelect.setAttribute('aria-label','曲线通道');
  channelSelect.append(...curveChannels.map(([value,label])=>new Option(label,value)));
  channelSelect.value=channel;
  parent.append(channelSelect);
  enhanceSelectMenu(channelSelect);
  const graph=svg('svg',{viewBox:'-8 -8 271 271',tabindex:'0',role:'group','aria-label':'曲线控制点'});
  graph.classList.add('document-curves-graph');
  graph.append(svg('rect',{class:'document-curves-background',width:255,height:255}));
  const histogram=svg('path',{class:'document-curves-histogram'});
  graph.append(histogram,svg('path',{class:'document-curves-grid',d:'M63.75 0V255 M127.5 0V255 M191.25 0V255 M0 63.75H255 M0 127.5H255 M0 191.25H255'}),
    svg('path',{class:'document-curves-diagonal',d:'M0 255L255 0'}));
  const line=svg('path',{class:'document-curves-line'}),nodes=svg('g',{});
  graph.append(line,nodes);
  parent.append(graph);
  const values=el('div','document-curves-values');
  const fields=['输入','输出'].map(label=>{
    const row=el('label'),input=el('input');
    row.textContent=label;
    Object.assign(input,{type:'number',step:1,min:0,max:255});
    input.setAttribute('aria-label','曲线'+label);
    input.dataset.scrubNumber='';input.dataset.scrubSpeed='1';
    row.append(input);values.append(row);
    return input;
  });
  parent.append(values);

  function sync(){
    const current=points[channel],value=current[selected];
    graph.dataset.channel=channel;
    graph.toggleAttribute('data-disabled',disabled||pending);
    line.setAttribute('d',curvesPath(current));
    histogram.setAttribute('d',counts?histogramPath(counts[channel]):'');
    graph.toggleAttribute('data-histogram-ready',!!counts);
    nodes.replaceChildren(...current.map(([x,y],index)=>svg('circle',{
      class:index===selected?'document-curve-point is-selected':'document-curve-point',
      'data-point':index,cx:x,cy:255-y,r:index===selected?5.8:5
    })));
    fields.forEach((field,index)=>{
      const unavailable=disabled||pending||!value||index===0&&(selected===0||selected===current.length-1);
      field.disabled=unavailable;
      if(index===0&&value){
        field.min=(current[selected-1]?.[0]??-1)+1;
        field.max=(current[selected+1]?.[0]??256)-1;
      }
      if(!field.hasAttribute('data-document-dirty'))field.value=value?.[index]??'';
    });
  }
  function position(event){
    const transform=graph.getScreenCTM();
    if(!transform)return [0,0];
    const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(transform.inverse());
    return [point.x,255-point.y];
  }
  function begin(element){
    if(change)return;
    change={before:structuredClone(points),element,selected};
    element.dataset.documentDirty='';
  }
  function preview(){
    if(frame)return;
    frame=requestAnimationFrame(()=>{
      frame=0;
      if(change&&!disposed)onPreview(structuredClone(points));
    });
  }
  function finish(commit){
    if(!change)return;
    const {before,element,selected:previousPoint}=change;
    change=null;
    delete element.dataset.documentDirty;
    if(frame)cancelAnimationFrame(frame);
    frame=0;
    const changed=JSON.stringify(before)!==JSON.stringify(points);
    if(!commit||!changed){
      points=before;
      if(!commit)selected=previousPoint;
      onPoint(selected);
      onPreview(null);sync();return;
    }
    onPoint(selected);
    pending=true;sync();
    void Promise.resolve(onCommit(structuredClone(points))).finally(()=>{
      pending=false;
      onPreview(null);
      if(!disposed)sync();
    });
  }
  function movePoint(x,y){
    const current=points[channel],old=current[selected];
    if(!old)return;
    const bounded=selected===0||selected===current.length-1?old[0]:byte(x,current[selected-1][0]+1,current[selected+1][0]-1);
    const next=[bounded,byte(y)];
    if(next[0]===old[0]&&next[1]===old[1])return;
    current[selected]=next;
    sync();preview();
  }
  function removePoint(){
    if(selected<=0||selected>=points[channel].length-1||disabled||pending)return false;
    begin(graph);
    points[channel].splice(selected,1);selected=-1;
    finish(true);
    return true;
  }
  function endPointer(commit){
    if(gesture===null)return;
    const pointer=gesture;gesture=null;
    if(graph.hasPointerCapture(pointer))graph.releasePointerCapture(pointer);
    finish(commit);
  }
  graph.onpointerdown=event=>{
    if(event.button!==0||gesture!==null||disabled||pending)return;
    const [x,y]=position(event),current=points[channel];
    const hit=event.target.getAttribute('data-point');
    if(hit===null&&(x<0||x>255||y<0||y>255))return;
    begin(graph);
    if(hit!==null)selected=Number(hit);
    else{
      const bx=byte(x),existing=current.findIndex(([old])=>old===bx);
      if(existing>=0)selected=existing;
      else if(current.length<maxCurvePoints){
        selected=current.findIndex(([old])=>old>bx);
        current.splice(selected,0,[bx,byte(y)]);
        preview();
      }else{finish(false);return;}
    }
    gesture=event.pointerId;
    graph.focus({preventScroll:true});graph.setPointerCapture(event.pointerId);
    sync();event.preventDefault();
  };
  graph.onpointermove=event=>{if(gesture===event.pointerId)movePoint(...position(event));};
  graph.onpointerup=event=>{if(gesture===event.pointerId)endPointer(true);};
  graph.onpointercancel=graph.onlostpointercapture=event=>{if(gesture===event.pointerId)endPointer(false);};
  graph.ondblclick=event=>{
    const point=event.target.getAttribute('data-point');
    if(point!==null){selected=Number(point);removePoint();}
  };
  graph.onkeydown=event=>{
    if(event.key==='Escape'&&gesture!==null){endPointer(false);event.preventDefault();event.stopPropagation();return;}
    if(disabled||pending||gesture!==null)return;
    if((event.key==='Delete'||event.key==='Backspace')&&removePoint()){
      event.preventDefault();event.stopPropagation();return;
    }
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowDown:[0,-1],ArrowUp:[0,1]}[event.key];
    const value=points[channel][selected];
    if(!delta||!value)return;
    begin(graph);movePoint(...value.map((n,i)=>n+delta[i]*(event.shiftKey?10:1)));finish(true);
    event.preventDefault();event.stopPropagation();
  };
  fields.forEach((field,index)=>{
    field.oninput=()=>{
      if(!field.validity.valid||!Number.isFinite(field.valueAsNumber))return;
      const value=points[channel][selected];
      if(!value)return;
      begin(field);movePoint(...value.map((n,i)=>i===index?field.valueAsNumber:n));
    };
    field.onchange=()=>finish(true);
    field.addEventListener('workspace-range-cancel',()=>finish(false));
    field.onkeydown=event=>{
      if(event.key==='Enter'){event.preventDefault();field.blur();}
      else if(event.key==='Escape'){finish(false);field.blur();event.stopPropagation();}
    };
  });
  channelSelect.onchange=()=>{
    endPointer(false);channel=channelSelect.value;selected=-1;onChannel(channel);onPoint(selected);sync();
  };
  void loadHistogram(origin,image,layer.id).then(data=>{if(!disposed){counts=data;sync();}});
  sync();
  return {dispose(){
    if(disposed)return;
    disposed=true;
    endPointer(false);finish(false);
    if(frame)cancelAnimationFrame(frame);
  }};
}
