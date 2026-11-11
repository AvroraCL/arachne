import * as THREE from 'three';
import {axisColors} from './viewport-colors.mjs';

const svgNode=tag=>document.createElementNS('http://www.w3.org/2000/svg',tag);
const axisNames='XYZ';
const viewNames={'X+':'右视','X-':'左视','Z+':'顶视','Z-':'底视'};
export function orderAxisItems(items){
  // Equal-depth axes occur at the common diagonal view. Floating-point drift
  // must not reorder their overlapping SVG lines from one frame to the next.
  return [...items].sort((a,b)=>Math.round(a.depth*1e6)-Math.round(b.depth*1e6)||a.order-b.order);
}

export function createAxisGizmo({root,getCamera,frameAxis,isMoving=()=>false}){
  const blenderAxes=root.dataset.axisSpace==='blender';
  // Blender world (X, Y, Z) maps to viewport (X, Z-up, -Y).
  const axes=blenderAxes?[[0,1],[2,-1],[1,1]]:[[0,1],[1,1],[2,1]];
  const svg=svgNode('svg'),items=[];
  svg.setAttribute('viewBox','0 0 72 72');
  root.replaceChildren(svg);
  root.removeAttribute('aria-hidden');
  root.setAttribute('role','group');
  root.setAttribute('aria-label','视角方向导航');

  for(const [axis,[component,orientation]] of axes.entries()){
    for(const sign of [-1,1]){
      const name=axisNames[axis],group=svgNode('g'),title=svgNode('title');
      const line=svgNode('line'),circle=svgNode('circle'),text=svgNode('text');
      const item={name,component,sign,direction:sign*orientation,group,title,line,circle,text,depth:0,order:items.length};
      group.setAttribute('role','button');
      group.tabIndex=0;
      group.dataset.axis=name+(sign>0?'+':'-');
      group.style.setProperty('--axis-color',axisColors[name]);
      line.setAttribute('x1','36');
      line.setAttribute('y1','36');
      text.setAttribute('text-anchor','middle');
      text.setAttribute('dominant-baseline','central');
      group.append(title,line,circle,text);
      svg.append(group);
      items.push(item);

      function activate(event){
        event.preventDefault();
        event.stopPropagation();
        const reverse=event.shiftKey||(blenderAxes&&!isMoving()&&item.depth>.9999);
        frameAxis(component,item.direction*(reverse?-1:1));
      }
      group.addEventListener('click',activate);
      group.addEventListener('keydown',event=>{
        if(event.key==='Enter'||event.key===' ')activate(event);
      });
    }
  }

  const projected=new THREE.Vector3();
  function draw(){
    const camera=getCamera();
    if(!camera)return;
    for(const item of items){
      const {name,component,sign,direction,group,title,line,circle,text}=item;
      projected.set(0,0,0).setComponent(component,direction).transformDirection(camera.matrixWorldInverse);
      const x=Math.round((36+projected.x*24)*1000)/1000,y=Math.round((36-projected.y*24)*1000)/1000;
      item.depth=Math.abs(projected.z)<1e-8?0:projected.z;
      const aligned=blenderAxes&&!isMoving()&&item.depth>.9999;
      const labelSign=aligned?-sign:sign;
      const label='沿 '+(labelSign>0?'+':'−')+name+' 轴观察';
      const viewName=blenderAxes&&viewNames[name+(labelSign>0?'+':'-')];
      const description=viewName?viewName+' · '+label:label;
      if(group.getAttribute('aria-label')!==description){
        group.setAttribute('aria-label',description);
        title.textContent=description+(blenderAxes?'':' · Shift 点击反向');
      }
      group.dataset.front=String(item.depth>=0);
      circle.setAttribute('r',sign>0||aligned?'7':'5');
      circle.setAttribute('cx',x);circle.setAttribute('cy',y);
      line.setAttribute('x2',x);line.setAttribute('y2',y);
      text.setAttribute('x',x);text.setAttribute('y',y);
      const marker=sign>0?name:aligned?'−'+name:'';
      if(text.textContent!==marker)text.textContent=marker;
    }
    const ordered=orderAxisItems(items);
    if(ordered.some((item,index)=>svg.children[index]!==item.group)){
      const focused=document.activeElement;
      for(const item of ordered)svg.append(item.group);
      if(svg.contains(focused))focused.focus({preventScroll:true});
    }
  }
  return {draw};
}
