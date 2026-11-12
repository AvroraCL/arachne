// Area = layout leaf; editor state is local, project content never enters this tree.
const clone=value=>structuredClone(value),epsilon=1e-8;
export const workspaceNames=Object.freeze({modeling:'建模',material:'材质',drawing:'绘制'});
export const editorNames={viewport:'三维视口',image:'二维图像编辑器',uv:'UV 编辑器',renderResult:'渲染结果',shader:'材质节点编辑器',scene:'大纲视图',properties:'材质属性',layers:'材质图层',imageProperties:'图像属性',imageLayers:'图像图层',library:'资源库',renderSettings:'属性编辑器',console:'AI 控制台'};
export function area(editor='viewport',id=crypto.randomUUID(),state={}){return {kind:'area',id,editor,states:{[editor]:clone(state)}};}
export function split(axis,first,second,ratio=.5,id=crypto.randomUUID()){return {kind:'split',id,axis,ratio,first,second};}
export function leaves(node){return node.kind==='area'?[node]:[...leaves(node.first),...leaves(node.second)];}
export function findNode(node,id){return node.id===id?node:node.kind==='split'?(findNode(node.first,id)||findNode(node.second,id)):null;}
export function replaceNode(node,id,replacement){if(node.id===id)return replacement;if(node.kind==='area')return node;return {...node,first:replaceNode(node.first,id,replacement),second:replaceNode(node.second,id,replacement)};}
export function validateLayout(tree){
  const ids=new Set();let count=0;
  function visit(node,depth){
    if(!node||depth>16||typeof node.id!=='string'||! /^[\w-]{1,100}$/.test(node.id)||ids.has(node.id))throw Error('区域布局编号无效');
    ids.add(node.id);
    if(node.kind==='area'){
      if(++count>24||!Object.hasOwn(editorNames,node.editor)||!node.states||Array.isArray(node.states)||typeof node.states!=='object')throw Error('编辑器类型或区域数量无效');
      return;
    }
    if(node.kind!=='split'||!['x','y'].includes(node.axis)||!Number.isFinite(node.ratio)||node.ratio<.05||node.ratio>.95)throw Error('区域分割比例无效');
    visit(node.first,depth+1);visit(node.second,depth+1);
  }
  visit(tree,0);if(JSON.stringify(tree).length>1024*1024)throw Error('布局视图状态过大');return tree;
}
// Workspace files describe the layout without including project-specific editor state.
export function workspaceLayoutFile(layouts){
  function strip(node,depth=0){
    if(!node||depth>16)throw Error('区域布局无效');
    if(node.kind==='area')return {kind:node.kind,id:node.id,editor:node.editor,states:{}};
    if(node.kind!=='split')throw Error('区域布局无效');
    return {kind:node.kind,id:node.id,axis:node.axis,ratio:node.ratio,
      first:strip(node.first,depth+1),second:strip(node.second,depth+1)};
  }
  return {format:'arachne-workspaces',version:1,layouts:Object.fromEntries(
    Object.keys(workspaceNames).map(name=>[name,validateLayout(strip(layouts?.[name]))])
  )};
}

export function parseWorkspaceLayoutFile(raw){
  if(raw?.format!=='arachne-workspaces'||raw.version!==1)throw Error('请选择受支持的阿拉克涅工作区布局文件');
  return workspaceLayoutFile(raw.layouts).layouts;
}
export function splitArea(tree,id,axis,ratio=.5,newId=crypto.randomUUID()){
  const current=findNode(tree,id);if(current?.kind!=='area'||!['x','y'].includes(axis))throw Error('请选择可分割区域');
  const next=replaceNode(tree,id,split(axis,current,{...clone(current),id:newId},ratio));return validateLayout(next);
}
export function changeEditor(tree,id,type){
  const current=findNode(tree,id);if(current?.kind!=='area'||!Object.hasOwn(editorNames,type))throw Error('未知编辑器');
  return replaceNode(tree,id,{...current,editor:type});
}
export function swapAreas(tree,firstId,secondId){
  const first=findNode(tree,firstId),second=findNode(tree,secondId);
  if(first?.kind!=='area'||second?.kind!=='area')throw Error('请选择两个编辑器区域');
  if(first===second)return tree;
  function swap(node){
    if(node===first)return second;
    if(node===second)return first;
    if(node.kind==='area')return node;
    return {...node,first:swap(node.first),second:swap(node.second)};
  }
  return swap(tree);
}
export function areaRects(tree,rect={x:0,y:0,w:1,h:1}){
  if(tree.kind==='area')return [{area:tree,...rect}];
  const x=tree.axis==='x',n=(x?rect.w:rect.h)*tree.ratio;
  return [...areaRects(tree.first,{...rect,[x?'w':'h']:n}),...areaRects(tree.second,{...rect,[x?'x':'y']:(x?rect.x:rect.y)+n,[x?'w':'h']:(x?rect.w:rect.h)-n})];
}
const equal=(a,b)=>Math.abs(a-b)<epsilon;
export function adjacentAreas(tree,id,{fullEdge=false}={}){
  const rects=areaRects(tree),a=rects.find(r=>r.area.id===id);if(!a)return [];
  const shares=(a,length,b,otherLength)=>fullEdge
    ?equal(a,b)&&equal(length,otherLength)
    :Math.min(a+length,b+otherLength)-Math.max(a,b)>epsilon;
  return rects.filter(b=>b!==a).flatMap(b=>{
    let direction;
    if(shares(a.y,a.h,b.y,b.h))direction=equal(a.x,b.x+b.w)?'left':equal(a.x+a.w,b.x)?'right':null;
    if(shares(a.x,a.w,b.x,b.w))direction=equal(a.y,b.y+b.h)?'top':equal(a.y+a.h,b.y)?'bottom':direction;
    return direction?[{id:b.area.id,direction}]:[];
  });
}
export const joinable=(tree,id)=>adjacentAreas(tree,id,{fullEdge:true});
function rebuild(rects,bounds){
  if(rects.length===1)return rects[0].area;
  for(const axis of ['x','y']){
    const length=axis==='x'?'w':'h',start=bounds[axis],end=start+bounds[length];
    const cuts=[...new Set(rects.map(r=>r[axis]+r[length]))].filter(c=>c>start+epsilon&&c<end-epsilon);
    for(const cut of cuts){
      if(rects.some(r=>r[axis]<cut-epsilon&&r[axis]+r[length]>cut+epsilon))continue;
      const first=rects.filter(r=>r[axis]+r[length]<=cut+epsilon),second=rects.filter(r=>r[axis]>=cut-epsilon);if(!first.length||!second.length)continue;
      const ratio=(cut-start)/bounds[length];if(ratio<.05||ratio>.95)continue;
      return split(axis,rebuild(first,{...bounds,[length]:cut-start}),rebuild(second,{...bounds,[axis]:cut,[length]:end-cut}),ratio);
    }
  }
  throw Error('这些区域不能组成矩形布局');
}
export function joinAreas(tree,keep,remove){
  if(!joinable(tree,keep).some(n=>n.id===remove))throw Error('只能合并共享完整边的相邻区域');
  const rects=areaRects(tree),a=rects.find(r=>r.area.id===keep),b=rects.find(r=>r.area.id===remove);
  const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);Object.assign(a,{x,y,w:Math.max(a.x+a.w,b.x+b.w)-x,h:Math.max(a.y+a.h,b.y+b.h)-y});
  return validateLayout(rebuild(rects.filter(r=>r!==b),{x:0,y:0,w:1,h:1}));
}
export function workspacePreset(name){
  const leaf=(type,id,state)=>area(type,id,state),pair=(axis,a,b,r)=>split(axis,a,b,r);
  const properties=name==='modeling'?leaf('renderSettings','side-bottom',{category:'object'}):
    leaf(name==='drawing'?'imageProperties':'properties','side-bottom');
  const side=pair('y',leaf(name==='modeling'?'scene':name==='drawing'?'imageLayers':'layers','side-top'),properties,.43);
  const main=name==='drawing'?leaf('image','main'):leaf('viewport','main',{mode:name==='modeling'?'object':'view'});
  const content=name==='modeling'?pair('y',main,leaf('shader','nodes'),.72):pair('y',main,leaf('library','assets'),.79);
  return pair('x',content,side,.79);
}

// Upgrade only editor identities; retain custom splits, ratios and every other view.
export function migrateLayerEditors(tree,workspace){
  const next=clone(tree);
  for(const node of leaves(next)){
    for(const type of ['layers','properties']){
      if(!Object.hasOwn(node.states,type))continue;
      const state=node.states[type],scope=state.domainScope;
      if(scope!==undefined||workspace==='drawing'){
        const image=scope==='image'||scope!=='material'&&workspace==='drawing';
        const target=image?(type==='layers'?'imageLayers':'imageProperties'):type;
        const clean={...state};delete clean.domainScope;
        node.states[type]=clean;
        if(target!==type&&!Object.hasOwn(node.states,target))node.states[target]=clone(clean);
        if(node.editor===type)node.editor=target;
      }
    }
  }
  return validateLayout(next);
}
