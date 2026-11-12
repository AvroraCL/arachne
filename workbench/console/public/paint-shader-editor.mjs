import {channelSpecs} from './paint-channels.mjs';
import {libraryNodeTypes,compileLibraryMaterial,defaultLibraryMaterial,defaultBrushGraph,evaluateBrushGraph} from './paint-library.mjs';
import {editMaterialLinks,materialLinkKey,insertMaterialNode,rerouteMaterialLinks,copyMaterialNodes,pasteMaterialNodes,duplicateMaterialNodes,removeMaterialNodes,vacantMaterialPosition,parseMaterialClipboard,materialClipboardPrefix} from './material-graph-edit.mjs';
import {polylinesIntersect,closestPolylinePoint,polylineCrossing} from './node-link-geometry.mjs';
import {scrubNumber} from './studio-fields.mjs';
import {nodeTypes as materialNodeTypes,portNames as materialPortNames,makeGraphNode,defaultMaterialGraph as defaultOutputGraph,compileNodeGraph,resolveGraphSockets} from './material-graph.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';
import {workspaceIcons} from './workspace-icons.mjs';

const labels={...Object.fromEntries(Object.entries(channelSpecs).map(([k,s])=>[k,s.name])),color:'颜色',value:'数值',a:'A',b:'B',factor:'系数',low:'起点颜色',high:'终点颜色',metallic:'金属度',roughness:'粗糙度',x:'偏移 X',y:'偏移 Y',scale:'缩放',rotation:'旋转',operation:'运算',asset:'图像',colorSpace:'颜色空间',worldRadius:'三维半径',uvRadius:'二维半径（px）',hardness:'硬度',opacity:'不透明度',pressure:'压感',mirror:'镜像 X',red:'红色',green:'绿色',blue:'蓝色'};
const operations={add:'加',subtract:'减',multiply:'乘',divide:'除',minimum:'最小值',maximum:'最大值'};
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
export function createShaderEditor({host,read,save,draft:onDraft,busy,importImage,viewAsset,readTarget=()=>null,onIdle=()=>{},viewKey='',initialView=null,onViewChange=()=>{}}){
  const lifecycle=new AbortController(),signal=lifecycle.signal;let disposed=false;host.classList.add('shader-editor');
  let target=null,nodeTypes=materialNodeTypes,socketSpecs=new Map();
  const nodeWidth=node=>node.type==='reroute'?20:224;
  const portNames={...materialPortNames,brush:'笔刷',worldRadius:'三维半径',uvRadius:'二维半径',hardness:'硬度',opacity:'不透明度'};
  const draft=(graph,at=origin)=>onDraft(graph,at);
  const compileMaterialGraph=(graph,assets)=>target?.library==='materials'?compileLibraryMaterial(graph,assets):target?.library==='brushes'?(evaluateBrushGraph(graph),compileNodeGraph(graph,assets)):compileNodeGraph(graph,assets);
  const defaultMaterialGraph=()=>target?.library==='brushes'?defaultBrushGraph():target?.library==='materials'?defaultLibraryMaterial():defaultOutputGraph();
  const makeNode=(type,x,y)=>makeGraphNode(graph,type,x,y);
  const currentOrigin=()=>{const doc=read(),t=readTarget();return doc?{id:doc.id,revision:doc.revision,...(t?{target:{library:t.library,id:t.id}}:{})}:null;};
  const originCurrent=value=>JSON.stringify(currentOrigin())===JSON.stringify(value);
  let origin=null,graph=null,key='',selected=null,selection=new Set(),gesture=null,writing=false,clipboard=null,cursor=null,scope='示例模型 · 共用材质';
  const toolbar=el('div','shader-toolbar'),toggle=el('button','shader-collapse','▾'),title=el('strong','shader-editor-title','着色器编辑器');
  toggle.type='button';toggle.title='折叠着色器编辑器';
  const material=el('span','shader-material',scope),enable=el('button','','启用节点材质'),add=el('select'),frame=el('button','','全部显示'),actions=el('select');
  function iconButton(button,icon,label){button.type='button';button.classList.add('shader-icon-button');button.innerHTML=workspaceIcons[icon];button.setAttribute('aria-label',label);button.title=label;return button;}
  iconButton(frame,'fit','全部显示');
  const focus=iconButton(el('button'),'focus','聚焦所选节点'),maximize=iconButton(el('button'),'orthographic','最大化着色器编辑器');
  maximize.setAttribute('aria-pressed','false');
  add.setAttribute('aria-label','添加材质节点');add.append(new Option('添加',''));
  for(const [type,spec] of Object.entries(nodeTypes))if(type!=='output')add.append(new Option(spec.name,type));
  actions.setAttribute('aria-label','节点操作');actions.append(new Option('节点',''),new Option('复制所选节点 · Shift D','duplicate'),new Option('删除所选节点 · Delete','remove'),new Option('还原涂装连接','reset'));actions.options[0].disabled=true;
  actions.options[1].dataset.shortcut='Shift D';actions.options[2].dataset.shortcut='Delete';
  frame.title='显示所有节点 · Home';
  toolbar.append(toggle,title,add,actions,material,enable,frame,focus,maximize);
  add.dataset.searchable='true';
  const stage=el('div','shader-stage'),world=el('div','shader-world'),wires=document.createElementNS('http://www.w3.org/2000/svg','svg');wires.classList.add('shader-wires');
  world.append(wires);stage.append(world);stage.tabIndex=0;stage.setAttribute('aria-label','材质节点画布');
  const hint=el('div','shader-status'),summary=el('span','shader-summary'),help=el('span','shader-hint','中键平移 · 滚轮缩放 · Shift A 添加'),zoom=el('div','shader-zoom');
  help.title='拖动输入线头改接，放空断开 · Ctrl 拖输出换源 · 拖线时 Alt 交换 · Shift 右键划线重定向 · Ctrl 右键划线切断 · 节点拖到亮线自动插入，Alt 仅移动 · Esc / 右键取消 · Alt 点击输入断开 · Shift 多选 · Shift D 复制 · Home 全部显示';
  const zoomOut=el('button','','−'),zoomValue=el('button','','100%'),zoomIn=el('button','','＋');
  for(const [button,label] of [[zoomOut,'缩小节点画布'],[zoomValue,'节点画布缩放'],[zoomIn,'放大节点画布']]){button.type='button';button.setAttribute('aria-label',label);}
  zoomValue.title='恢复 100%';zoom.append(zoomOut,zoomValue,zoomIn);hint.append(summary,help,zoom);
  const empty=el('div','shader-welcome'),emptyTitle=el('strong','','从涂装结果开始'),emptyHelp=el('span','','启用节点，将当前图层接入 PBR 材质。');empty.append(emptyTitle,emptyHelp);
  const error=el('output','shader-error');error.id=host.id==='shader-editor'?'shader-error':(host.id||crypto.randomUUID())+'-error';error.setAttribute('role','status');
  const marquee=el('div','shader-marquee');marquee.hidden=true;world.append(marquee);
  const splitter=el('div','shader-splitter');splitter.tabIndex=0;splitter.setAttribute('role','separator');splitter.setAttribute('aria-label','着色器编辑器高度');splitter.setAttribute('aria-orientation','horizontal');
  host.append(splitter,toolbar,empty,stage,hint,error);enhanceSelectMenu(add);enhanceSelectMenu(actions);
  const imageFile=el('input');imageFile.type='file';imageFile.accept='image/png';imageFile.hidden=true;host.append(imageFile);let imageTarget=null;
  imageFile.oncancel=()=>{imageTarget=null;};
  imageFile.onchange=async()=>{
    const file=imageFile.files[0],target=imageTarget;imageFile.value='';imageTarget=null;
    if(!file||!target)return;
    try{
      if(!originCurrent(target.origin)||!allowed())throw Error('工程已变化，请重新选择节点图像');
      if(file.size>24*1024*1024)throw Error('PNG 不能超过 24 MiB');
      const ok=await importImage(file,target.node,target.origin);if(ok!==false){key='';sync();showError('');}
    }catch(error){showError(error);}
  };
  let pose={x:16,y:10,scale:1},space=false,collapsed=false,poseProject=null,poseTimer=null;
  try{collapsed=!viewKey&&localStorage.getItem('arachne-shader-collapsed')==='true';const h=Number(localStorage.getItem('arachne-shader-height'));if(h>=160&&h<=700)host.style.height=h+'px';}catch{}
  function rememberPose(){
    clearTimeout(poseTimer);poseTimer=null;if(!poseProject||disposed)return;onViewChange({pose:{...pose},collapsed});
    try{localStorage.setItem('arachne-shader-view-v1:'+poseProject+(viewKey?':'+viewKey:''),JSON.stringify(pose));}catch{}
  }
  function syncPose(){
    world.style.transform=`translate(${pose.x}px,${pose.y}px) scale(${pose.scale})`;
    stage.style.backgroundSize=`${Math.max(10,20*pose.scale)}px ${Math.max(10,20*pose.scale)}px`;
    stage.style.backgroundPosition=`${pose.x}px ${pose.y}px`;zoomValue.textContent=Math.round(pose.scale*100)+'%';
    clearTimeout(poseTimer);poseTimer=setTimeout(rememberPose,160);
  }
  function loadPose(project){
    if(project===poseProject)return;
    rememberPose();poseProject=project;pose={x:16,y:10,scale:1};cursor=null;selection=new Set();selected=null;
    try{
      const saved=JSON.parse(localStorage.getItem('arachne-shader-view-v1:'+project+(viewKey?':'+viewKey:'')));
      if(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y)&&Number.isFinite(saved.scale)&&Math.abs(saved.x)<=30000&&Math.abs(saved.y)<=30000&&saved.scale>=.01&&saved.scale<=2)pose={x:saved.x,y:saved.y,scale:saved.scale};
    }catch{}
    if(initialView?.pose&&!loadPose.applied){pose={...initialView.pose};collapsed=!!initialView.collapsed;loadPose.applied=true;}
  }
  window.addEventListener('pagehide',rememberPose,{signal});

  function point(e){const r=stage.getBoundingClientRect();return {x:(e.clientX-r.left-pose.x)/pose.scale,y:(e.clientY-r.top-pose.y)/pose.scale};}
  function showError(e){error.textContent=e?.message||e||'';error.dataset.tone=e instanceof Error?'error':'info';}
  function allowed(){return !!read()&&!busy()&&!writing&&!readTarget()?.missing;}
  function portCenter(node,port,direction){const b=world.querySelector(`[data-node="${node}"] [data-port="${port}"][data-direction="${direction}"]`);if(!b)return null;const r=b.getBoundingClientRect(),w=stage.getBoundingClientRect();return {x:(r.x+r.width/2-w.x-pose.x)/pose.scale,y:(r.y+r.height/2-w.y-pose.y)/pose.scale};}
  function curve(a,b){const bend=Math.max(36,Math.min(180,Math.abs(b.x-a.x)*.45));return `M${a.x},${a.y} C${a.x+bend},${a.y} ${b.x-bend},${b.y} ${b.x},${b.y}`;}
  function lines(extra){
    wires.replaceChildren();if(!graph)return;
    const detached=new Set((gesture?.detached||[]).map(materialLinkKey));
    for(const link of graph.links){
      const key=materialLinkKey(link);if(detached.has(key)&&gesture?.moved)continue;
      const a=portCenter(link.from.node,link.from.port,'out'),b=portCenter(link.to.node,link.to.port,'in');
      if(a&&b){const path=document.createElementNS(wires.namespaceURI,'path');path.setAttribute('d',curve(a,b));path.dataset.link=key;path.dataset.type=socketSpecs.get(link.from.node).outputs[link.from.port];path.classList.toggle('selected',selection.has(link.from.node)||selection.has(link.to.node));path.classList.toggle('cut',gesture?.cut?.has(key)||false);path.classList.toggle('inserting',!!gesture?.insertion&&materialLinkKey(gesture.insertion.link)===key);wires.append(path);}
    }
    for(const line of extra?(Array.isArray(extra)?extra:[extra]):[]){const path=document.createElementNS(wires.namespaceURI,'path');path.setAttribute('d',curve(line.a,line.b));path.classList.add('pending');wires.append(path);}
    if(['cut','reroute-cut'].includes(gesture?.kind)&&gesture.points.length>1){const path=document.createElementNS(wires.namespaceURI,'path');path.setAttribute('d',gesture.points.map((p,i)=>`${i?'L':'M'}${p.x},${p.y}`).join(' '));path.classList.add('cut-stroke');wires.append(path);}
  }
  async function commit(next,expected=origin){
    if(!allowed())return false;
    try{if(!originCurrent(expected))throw Error('工程修订或编辑目标已变化，请重新编辑');compileMaterialGraph(next,read().paint.assets);writing=true;controls();showError('正在保存节点材质…');const ok=await save(next,expected);if(ok===false)throw Error(error.textContent||'节点材质未保存');writing=false;key='';sync();showError('');return true;}
    catch(e){showError(e);writing=false;key='';sync();draft(null,expected);return false;}
    finally{writing=false;controls();onIdle();}
  }
  function canRemove(){return selection.size>0&&!graph?.nodes.some(node=>selection.has(node.id)&&node.type==='output');}
  function controls(){
    const on=!!graph;enable.hidden=on||!!target?.missing;
    for(const c of [enable,add,frame,focus,actions])c.disabled=!allowed()||(!on&&c!==enable)||(collapsed&&c!==enable);
    for(const c of world.querySelectorAll('.shader-node input,.shader-node select,.shader-port,.shader-image-open')){
      c.disabled=!allowed()||(c.classList.contains('shader-image-open')&&!importImage);
      if(c.tagName==='SELECT')syncSelectMenu(c);
    }
    actions.options[1].disabled=!graph?.nodes.some(node=>selection.has(node.id)&&node.type!=='output');
    actions.options[2].disabled=!canRemove();
    focus.disabled||=!selection.size;maximize.disabled=!read();
    summary.textContent=graph?(selection.size?`已选择 ${selection.size} 个节点`:`${graph.nodes.length} 个节点 · ${graph.links.length} 条连线`):'';
    material.title=material.textContent;syncSelectMenu(actions);
  }
  function select(ids,primary=null){
    selection=new Set(ids);selected=primary||[...selection].at(-1)||null;
    for(const box of world.querySelectorAll('.shader-node'))box.classList.toggle('selected',selection.has(box.dataset.node));
    controls();lines();
  }
  function sizes(){return Object.fromEntries([...world.querySelectorAll('.shader-node')].map(box=>[box.dataset.node,box.offsetHeight]));}
  function reveal(ids){
    const nodes=graph?.nodes.filter(node=>ids.includes(node.id));if(!nodes?.length)return;
    const height=sizes(),left=Math.min(...nodes.map(n=>n.x)),top=Math.min(...nodes.map(n=>n.y)),right=Math.max(...nodes.map(n=>n.x+nodeWidth(n))),bottom=Math.max(...nodes.map(n=>n.y+(height[n.id]||240)));
    if(left*pose.scale+pose.x<16||right*pose.scale+pose.x>stage.clientWidth-16)pose.x=16-left*pose.scale;
    if(top*pose.scale+pose.y<16||bottom*pose.scale+pose.y>stage.clientHeight-16)pose.y=16-top*pose.scale;
    syncPose();
  }
  async function cloneSelection(){
    if(!allowed()||!graph)return;
    try{const result=duplicateMaterialNodes(graph,selection,read().paint.assets);select(result.selection);if(await commit(result.graph))reveal(result.selection);}catch(e){showError(e);}
  }
  function copySelection(){
    if(!graph||!selection.size)return;
    const fragment=copyMaterialNodes(graph,selection);if(!fragment.nodes.length)return;
    clipboard=materialClipboardPrefix+JSON.stringify(fragment);
    navigator.clipboard?.writeText(clipboard).catch(()=>{});
    showError(`已复制 ${fragment.nodes.length} 个节点`);
  }
  async function pasteSelection(){
    if(!allowed()||!graph)return;
    try{
      const target={...origin};
      let text=clipboard;try{text=await navigator.clipboard.readText();}catch{}
      if(!originCurrent(target)||!allowed())throw Error('工程已变化，请在当前工程重新粘贴');
      const result=pasteMaterialNodes(graph,parseMaterialClipboard(text),read().paint.assets,cursor||{x:(stage.clientWidth/2-pose.x)/pose.scale,y:(50-pose.y)/pose.scale});
      select(result.selection);if(await commit(result.graph))reveal(result.selection);
    }catch(e){showError(e);}
  }

  function socket(node,port,direction,type,linked=false){
    const dot=el('button','shader-port');dot.type='button';dot.dataset.port=port;dot.dataset.direction=direction;dot.dataset.type=type;
    dot.toggleAttribute('data-linked',linked||direction==='out');
    dot.title=`${nodeTypes[node.type].name} · ${portNames[port]}${direction==='in'?'输入':'输出'}`;dot.setAttribute('aria-label',dot.title);return dot;
  }
  function draw(){
    for(const node of world.querySelectorAll('.shader-node'))node.remove();
    host.classList.toggle('shader-empty',!graph);stage.hidden=!graph||collapsed;empty.hidden=!!graph||collapsed;hint.hidden=!graph||collapsed;host.classList.toggle('shader-collapsed',collapsed);
    toggle.textContent=collapsed?'▸':'▾';toggle.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-label',collapsed?'展开着色器编辑器':'折叠着色器编辑器');
    toggle.title=toggle.getAttribute('aria-label');
    socketSpecs=graph?resolveGraphSockets(graph):new Map();
    if(graph)for(const node of graph.nodes){
      const spec=socketSpecs.get(node.id),box=el('section','shader-node');box.dataset.node=node.id;box.dataset.type=node.type;box.style.left=node.x+'px';box.style.top=node.y+'px';box.classList.toggle('selected',selection.has(node.id));box.setAttribute('aria-label',spec.name+'节点');
      if(node.type==='reroute'){
        box.classList.add('shader-reroute');box.dataset.move=node.id;box.title='重定向 · 拖动移动，单输入可分支输出';
        box.append(socket(node,'input','in',spec.inputs.input,graph.links.some(l=>l.to.node===node.id)),socket(node,'output','out',spec.outputs.output));world.append(box);continue;
      }
      const header=el('div','shader-node-title'),symbol=el('span','shader-node-icon'),name=el('span','shader-node-name',spec.name),grip=el('span','shader-node-grip');
      symbol.innerHTML=workspaceIcons[{paint:'fillLayer',image:'image',uv:'grid',mapping:'transform',output:'return',pbr:'material',color:'rendered',value:'settings',math:'settings',mix:'material',ramp:'rendered',brush:'brush'}[node.type]]||workspaceIcons.settings;
      symbol.setAttribute('aria-hidden','true');grip.setAttribute('aria-hidden','true');header.dataset.move=node.id;header.append(symbol,name,grip);box.append(header);
      const values={...spec.defaults,...node.params},inlineOutputs=new Set(Object.keys(spec.outputs).filter(port=>Object.hasOwn(values,port)&&!Object.hasOwn(spec.inputs,port)));
      const outputs=el('div','shader-outputs');
      for(const [port,type] of Object.entries(spec.outputs))if(!inlineOutputs.has(port)){
        const row=el('div','shader-port-row out');row.append(el('span','',portNames[port]),socket(node,port,'out',type));outputs.append(row);
      }
      if(outputs.children.length)box.append(outputs);
      const params=el('div','shader-params'),incoming=new Map(graph.links.filter(link=>link.to.node===node.id).map(link=>[link.to.port,link.from]));
      for(const param of ['operation','asset','colorSpace'])if(Object.hasOwn(values,param))params.append(parameterRow(param,values[param]));
      for(const [port,type] of Object.entries(spec.inputs)){
        if(!incoming.has(port)&&Object.hasOwn(values,port)){params.append(parameterRow(port,values[port]));continue;}
        const row=el('div','shader-input-row'),caption=el('span','shader-param-name',portNames[port]),from=incoming.get(port);
        row.append(socket(node,port,'in',type,!!from),caption);
        if(from){
          row.classList.add('shader-linked');const source=graph.nodes.find(n=>n.id===from.node),text=nodeTypes[source.type].name;
          const reference=el('span','shader-link-source',text);reference.title=`来自 ${text} · ${portNames[from.port]}；拖动输入线头改接，放空断开`;row.append(reference);
        }else row.append(el('span','shader-unlinked','未连接'));
        params.append(row);
      }
      for(const [param,value] of Object.entries(values))if(!Object.hasOwn(spec.inputs,param)&&!['operation','asset','colorSpace'].includes(param))params.append(parameterRow(param,value));
      function parameterRow(param,value){
        const row=el('div','shader-parameter-row'),caption=el('span','shader-param-name',labels[param]),inputOrigin=origin&&structuredClone(origin);let input;
        if(['asset','operation','colorSpace'].includes(param)){
          input=el('select');
          if(param==='asset'){input.append(new Option('选择素材…',''));for(const [id,asset] of Object.entries(read().paint.assets))input.append(new Option(asset.name,id));}
          else if(param==='colorSpace')input.append(new Option('颜色（sRGB）','srgb'),new Option('数据（线性）','linear'));
          else for(const [id,text] of Object.entries(operations))input.append(new Option(text,id));
        }else{
          input=el('input');input.type=typeof value==='boolean'?'checkbox':typeof value==='string'?'color':'number';
          if(input.type==='number'){input.step='any';input.dataset.scrubSpeed=param==='rotation'?'.5':'.01';if(['factor','metallic','roughness','height','alpha','ao','hardness','opacity','red','green','blue'].includes(param)){input.min='0';input.max='1';}if(param==='worldRadius'){input.min='.02';input.max='.65';}if(param==='uvRadius'){input.min='2';input.max='256';input.dataset.scrubSpeed='1';}}
        }
        input.value=value;if(input.type==='checkbox')input.checked=value;input.setAttribute('aria-label',`${spec.name} ${labels[param]}`);input.dataset.param=param;row.append(caption,input);
        if(Object.hasOwn(spec.inputs,param))row.append(socket(node,param,'in',spec.inputs[param]));
        if(inlineOutputs.has(param)){row.classList.add('out');row.append(socket(node,param,'out',spec.outputs[param]));}
        input.oninput=()=>{try{if(!input.isConnected||!originCurrent(inputOrigin))throw Error('工程已在其他客户端更新，请重新编辑当前修订');const next=structuredClone(graph),n=next.nodes.find(n=>n.id===node.id);if(!n)throw Error('节点已变化，请重新编辑');n.params[param]=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;compileMaterialGraph(next,read().paint.assets);draft(JSON.stringify(next)===JSON.stringify(graph)?null:next,inputOrigin);showError('');}catch(e){showError(e);}};
        input.onchange=()=>{if(!input.isConnected||!originCurrent(inputOrigin))return;const next=structuredClone(graph),n=next.nodes.find(n=>n.id===node.id);if(!n)return;n.params[param]=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;void commit(next,inputOrigin);};
        if(input.type==='number')scrubNumber(caption,input,{key:param,speed:param==='rotation'?.5:.01,canStart:allowed,onDraft:()=>input.oninput()});
        if(input.tagName==='SELECT')enhanceSelectMenu(input);
        return row;
      }
      if(node.type==='image'){
        const asset=read().paint.assets[node.params.asset];
        if(asset){
          const preview=el('button','shader-image-preview');preview.type='button';preview.setAttribute('aria-label','查看节点图像 '+asset.name);
          const image=el('img');image.src='/api/projects/'+read().id+'/paint/assets/'+node.params.asset;image.alt='';image.draggable=false;
          const caption=el('span','',asset.name),dimensions=el('small','',`${asset.width} × ${asset.height}`);preview.append(image,caption,dimensions);preview.title=`${asset.name} · ${asset.width} × ${asset.height}`;
          preview.onclick=()=>viewAsset?.(node.params.asset,preview);params.append(preview);
        }
        const open=el('button','shader-image-open',asset?'替换图像…':'打开图像…');open.type='button';open.disabled=!importImage;
        open.onclick=()=>{if(!allowed())return;imageTarget={node:node.id,origin:{...origin}};imageFile.click();};params.append(open);
      }
      if(params.children.length)box.append(params);world.append(box);
    }
    syncPose();requestAnimationFrame(()=>lines());controls();
  }
  function sync(){
    if(disposed)return;
    const doc=read(),resource=readTarget(),next=JSON.stringify([doc?.id,doc?.revision,resource||doc?.paint.materialGraph,doc?.paint.assets]);
    if(next===key||gesture||writing){controls();return;}
    const previousOrigin=origin;
    key=next;target=resource;nodeTypes=target?libraryNodeTypes(target.library):materialNodeTypes;
    emptyTitle.textContent=target?.missing?'资源不可用':'从涂装结果开始';emptyHelp.textContent=target?.missing?'资源已删除，请撤销删除或选择其他节点目标。':'启用节点，将当前图层接入 PBR 材质。';
    add.setAttribute('aria-label',target?.library==='brushes'?'添加笔刷节点':'添加材质节点');
    add.replaceChildren(new Option('添加',''),...Object.entries(nodeTypes).filter(([type])=>type!=='output').map(([type,spec])=>new Option(spec.name,type)));syncSelectMenu(add);
    title.textContent=target?.library==='brushes'?'笔刷节点编辑器':'着色器编辑器';
    material.textContent=target?target.name:scope;material.title=material.textContent;
    actions.options[3].textContent=target?'重置节点':'还原涂装连接';
    host.dataset.resource=target?.library||'output';
    stage.setAttribute('aria-label',target?.library==='brushes'?'笔刷节点画布':'材质节点画布');
    loadPose(doc?doc.id+(target?':'+target.library+':'+target.id:''):null);origin=currentOrigin();
    const selectedGraph=resource?resource.graph:doc?.paint.materialGraph;graph=selectedGraph?structuredClone(selectedGraph):null;
    selection=new Set([...selection].filter(id=>graph?.nodes.some(n=>n.id===id)));if(!selection.has(selected))selected=[...selection].at(-1)||null;draw();
    if(previousOrigin&&JSON.stringify(previousOrigin)!==JSON.stringify(origin))draft(null,previousOrigin);
  }
  enable.onclick=()=>{collapsed=false;try{localStorage.setItem('arachne-shader-collapsed','false');}catch{}void commit(defaultMaterialGraph());};
  add.onchange=async()=>{
    const type=add.value;add.value='';syncSelectMenu(add);if(!type||!allowed())return;
    try{
      const next=structuredClone(graph),position=vacantMaterialPosition(next.nodes,cursor||{x:(stage.clientWidth/2-pose.x)/pose.scale,y:(60-pose.y)/pose.scale},sizes());
      const node=makeNode(type,position.x,position.y);next.nodes.push(node);select([node.id]);
      if(await commit(next))reveal([node.id]);
    }catch(e){showError(e);}
  };
  function removeSelection(){if(!allowed()||!canRemove())return;try{void commit(removeMaterialNodes(graph,selection,read().paint.assets));}catch(e){showError(e);}}
  actions.onchange=()=>{
    const action=actions.value;actions.value='';syncSelectMenu(actions);if(!allowed())return;
    if(action==='duplicate')void cloneSelection();else if(action==='remove')removeSelection();else if(action==='reset')void commit(defaultMaterialGraph());
  };
  function frameNodes(ids){
    const nodes=graph?.nodes.filter(node=>!ids||ids.has(node.id));if(!nodes?.length||!stage.clientWidth||!stage.clientHeight)return;
    const height=sizes(),left=Math.min(...nodes.map(n=>n.x)),top=Math.min(...nodes.map(n=>n.y)),right=Math.max(...nodes.map(n=>n.x+nodeWidth(n))),bottom=Math.max(...nodes.map(n=>n.y+(height[n.id]||160)));
    pose.scale=Math.max(.01,Math.min(1,(stage.clientWidth-80)/(right-left),(stage.clientHeight-64)/(bottom-top)));
    pose.x=(stage.clientWidth-(right-left)*pose.scale)/2-left*pose.scale;pose.y=(stage.clientHeight-(bottom-top)*pose.scale)/2-top*pose.scale;syncPose();
  }
  function zoomAtCenter(scale){
    const next=Math.max(.01,Math.min(1.6,scale)),x=stage.clientWidth/2,y=stage.clientHeight/2,ratio=next/pose.scale;
    pose={x:x+(pose.x-x)*ratio,y:y+(pose.y-y)*ratio,scale:next};syncPose();
  }
  frame.onclick=()=>frameNodes();focus.onclick=()=>frameNodes(selection);
  zoomOut.onclick=()=>zoomAtCenter(pose.scale/1.2);zoomIn.onclick=()=>zoomAtCenter(pose.scale*1.2);zoomValue.onclick=()=>zoomAtCenter(1);
  maximize.onclick=()=>{
    if(collapsed){collapsed=false;try{localStorage.setItem('arachne-shader-collapsed','false');}catch{}draw();}
    const before={width:stage.clientWidth,height:stage.clientHeight};
    const on=host.toggleAttribute('data-maximized');maximize.setAttribute('aria-pressed',String(on));maximize.setAttribute('aria-label',on?'还原着色器编辑器':'最大化着色器编辑器');maximize.title=maximize.getAttribute('aria-label');
    if(before.width&&before.height){pose.x+=(stage.clientWidth-before.width)/2;pose.y+=(stage.clientHeight-before.height)/2;syncPose();}
    lines();
  };
  toggle.onclick=()=>{if(host.hasAttribute('data-maximized'))maximize.click();collapsed=!collapsed;try{localStorage.setItem('arachne-shader-collapsed',String(collapsed));}catch{}draw();};
  stage.addEventListener('wheel',e=>{
    if(gesture){e.preventDefault();return;}
    if(e.target.closest('input,.custom-select'))return;
    e.preventDefault();const p=point(e);pose.scale=Math.max(.01,Math.min(1.6,pose.scale*Math.exp(-e.deltaY*.0015)));
    const r=stage.getBoundingClientRect();pose.x=e.clientX-r.x-p.x*pose.scale;pose.y=e.clientY-r.y-p.y*pose.scale;syncPose();
  },{passive:false});
  function cancelGesture(){
    if(!gesture)return;
    const previous=gesture,pointer=gesture.pointer;gesture=null;marquee.hidden=true;
    stage.removeAttribute('data-panning');
    stage.removeAttribute('data-cutting');
    connectionHint();
    if(previous.kind==='pan'){pose=previous.pose;syncPose();}
    if(pointer!==undefined&&stage.hasPointerCapture(pointer))stage.releasePointerCapture(pointer);
    if(previous.kind!=='pan')key='';
    sync();
  }
  function connectionHint(g){
    stage.toggleAttribute('data-connecting',!!g);
    for(const port of world.querySelectorAll('.shader-port')){
      port.toggleAttribute('data-compatible',!!g?.valid?.has(port));port.removeAttribute('data-link-target');port.removeAttribute('data-link-invalid');
    }
  }
  const endpoint=port=>({node:port.closest('.shader-node').dataset.node,port:port.dataset.port});
  function linkGraph(g,end){
    const add=!end?[]:g.kind==='output-link'?g.tos.map(to=>({from:end,to})):g.from?[{from:g.from,to:end}]:[{from:end,to:g.to}];
    if(end&&g.swap&&g.from&&g.detached.length===1){
      const other=graph.links.find(link=>link.to.node===end.node&&link.to.port===end.port);
      const original=g.detached[0];
      if(other&&materialLinkKey(other)!==materialLinkKey(original))add.push({from:other.from,to:original.to});
    }
    return editMaterialLinks(graph,g.detached,add,g.assets);
  }
  function linkTargets(g){
    g.valid=new Set();
    for(const port of world.querySelectorAll('.shader-port'))if(port.dataset.direction===g.direction){
      try{linkGraph(g,endpoint(port));g.valid.add(port);}catch{}
    }
    connectionHint(g);
  }
  function linkTarget(g,e){
    const direct=document.elementFromPoint(e.clientX,e.clientY)?.closest('.shader-port');
    if(direct&&world.contains(direct))return direct;
    let nearest=null,distance=16;
    for(const port of world.querySelectorAll('.shader-port')){const r=port.getBoundingClientRect();if(!r.width||!r.height)continue;const d=Math.hypot(e.clientX-r.x-r.width/2,e.clientY-r.y-r.height/2);if(d<distance){distance=d;nearest=port;}}
    return nearest;
  }
  function previewLink(g,e){
    if(g.swap!==e.altKey){g.swap=e.altKey;linkTargets(g);}
    const target=linkTarget(g,e),valid=target&&g.valid.has(target);
    for(const port of world.querySelectorAll('.shader-port')){port.toggleAttribute('data-link-target',port===target&&!!valid);port.toggleAttribute('data-link-invalid',port===target&&!valid);}
    const end=valid?portCenter(target.closest('.shader-node').dataset.node,target.dataset.port,g.direction):point(e);
    lines(g.kind==='output-link'?g.tos.map(to=>({a:end,b:portCenter(to.node,to.port,'in')})):g.from?{a:g.a,b:end}:{a:end,b:g.b});
  }
  function saveLinks(next){
    if(JSON.stringify(next)===JSON.stringify(graph)){lines();return;}
    void commit(next);
  }
  function cutCurves(){
    return [...wires.querySelectorAll('[data-link]')].map(path=>{
      const length=path.getTotalLength(),count=Math.min(8192,Math.max(2,Math.ceil(length*pose.scale/4)));
      return {key:path.dataset.link,points:Array.from({length:count+1},(_,i)=>{const p=path.getPointAtLength(length*i/count);return {x:p.x,y:p.y};})};
    });
  }
  function moveCut(g,p){
    const last=g.points.at(-1);if(Math.hypot(p.x-last.x,p.y-last.y)*pose.scale<1)return;
    for(const wire of g.curves)if(!g.cut.has(wire.key)&&polylinesIntersect([last,p],wire.points,2/pose.scale)){g.cut.add(wire.key);if(g.kind==='reroute-cut')g.crossings.push({key:wire.key,point:polylineCrossing([last,p],wire.points)||closestPolylinePoint(p,wire.points)});}
    g.points.push(p);if(g.points.length>2048)g.points.shift();lines();
  }
  function nodeInsertion(g){
    if(g.starts.length!==1)return null;
    const node=graph.nodes.find(n=>n.id===g.starts[0].id),box=world.querySelector(`[data-node="${node.id}"]`),width=nodeWidth(node),height=box.offsetHeight;
    const center={x:node.x+width/2,y:node.y+height/2};let best=null;
    for(const wire of g.curves){
      const p=closestPolylinePoint(center,wire.points);if(!p||p.x<node.x-5||p.x>node.x+width+5||p.y<node.y-5||p.y>node.y+height+5)continue;
      const link=graph.links.find(l=>materialLinkKey(l)===wire.key);if(!link)continue;
      try{insertMaterialNode(graph,node.id,link,read().paint.assets);if(!best||p.distance<best.distance)best={node:node.id,link,distance:p.distance};}catch{}
    }
    return best;
  }
  function startPan(e){
    gesture={kind:'pan',pointer:e.pointerId,buttonMask:e.button===1?4:1,x:e.clientX,y:e.clientY,pose:{...pose}};
    stage.setAttribute('data-panning','');
    // MMB navigation must not blur/commit a text field or activate a node UI.
    e.preventDefault();e.stopPropagation();if(e.button===0)stage.focus();stage.setPointerCapture(e.pointerId);
  }
  function finishPan(){
    const pointer=gesture.pointer;gesture=null;stage.removeAttribute('data-panning');
    if(stage.hasPointerCapture(pointer))stage.releasePointerCapture(pointer);
    sync();
  }
  let suppressContextUntil=0;
  stage.addEventListener('contextmenu',e=>{if(gesture&&['link','reverse-link','output-link','node'].includes(gesture.kind)){if(!e.ctrlKey)cancelGesture();suppressContextUntil=performance.now()+500;}if(performance.now()<suppressContextUntil||['cut','reroute-cut'].includes(gesture?.kind)){e.preventDefault();e.stopPropagation();}});
  // A second mouse button does not emit pointerdown while LMB is held.
  stage.addEventListener('mousedown',e=>{if(e.button===2&&gesture&&!['cut','reroute-cut'].includes(gesture.kind)){suppressContextUntil=performance.now()+500;cancelGesture();e.preventDefault();e.stopPropagation();}},true);
  stage.addEventListener('pointerdown',e=>{
    if(e.button===2&&gesture){suppressContextUntil=performance.now()+500;cancelGesture();e.preventDefault();e.stopPropagation();return;}
    if(e.button===2&&(e.ctrlKey||e.shiftKey)&&!e.altKey&&graph&&!gesture&&allowed()&&!e.target.closest('.shader-node')){
      suppressContextUntil=performance.now()+500;gesture={kind:e.ctrlKey?'cut':'reroute-cut',pointer:e.pointerId,points:[point(e)],curves:cutCurves(),cut:new Set(),crossings:[]};
      stage.dataset.cutting='';e.preventDefault();e.stopPropagation();stage.focus();stage.setPointerCapture(e.pointerId);return;
    }
    if(e.button===1&&graph&&!gesture)startPan(e);
  },true);
  stage.addEventListener('auxclick',e=>{if(e.button===1){e.preventDefault();e.stopPropagation();}},true);
  stage.addEventListener('pointerdown',e=>{
    if(!graph||gesture||e.defaultPrevented||e.target.closest('input,select,.custom-select,.workspace-range-field,.shader-image-open,.shader-image-preview'))return;
    if(e.button===0&&space){startPan(e);return;}
    if(e.button!==0||!allowed())return;
    cursor=point(e);
    const node=e.target.closest('.shader-node'),port=e.target.closest('.shader-port'),move=e.target.closest('[data-move]');
    if(port){
      select([node.dataset.node]);
      if(e.altKey&&port.dataset.direction==='in'){
        e.preventDefault();try{saveLinks(editMaterialLinks(graph,graph.links.filter(l=>l.to.node===selected&&l.to.port===port.dataset.port),[],read().paint.assets));}catch(error){showError(error);}return;
      }
      const end=endpoint(port),incoming=graph.links.find(l=>l.to.node===end.node&&l.to.port===end.port),outgoing=graph.links.filter(l=>l.from.node===end.node&&l.from.port===end.port);
      if(port.dataset.direction==='out'&&e.ctrlKey&&outgoing.length)gesture={kind:'output-link',tos:outgoing.map(l=>l.to),detached:outgoing,direction:'out'};
      else if(port.dataset.direction==='out'||incoming){const from=incoming?.from||end;gesture={kind:'link',from,a:portCenter(from.node,from.port,'out'),detached:incoming?[incoming]:[],direction:'in'};}
      else gesture={kind:'reverse-link',to:end,b:portCenter(end.node,end.port,'in'),detached:[],direction:'out'};
      Object.assign(gesture,{type:port.dataset.type,assets:read().paint.assets,swap:false,start:{x:e.clientX,y:e.clientY},moved:false});linkTargets(gesture);
    }else if(node){
      const id=node.dataset.node;
      if(e.shiftKey){const next=new Set(selection);next.has(id)?next.delete(id):next.add(id);select(next,next.has(id)?id:null);}
      else if(!selection.has(id))select([id]);
      if(move&&selection.has(id))gesture={kind:'node',starts:graph.nodes.filter(n=>selection.has(n.id)).map(n=>({id:n.id,x:n.x,y:n.y})),point:point(e),curves:cutCurves(),insertion:null};
    }else gesture={kind:'marquee',start:point(e),initial:e.shiftKey?new Set(selection):new Set()};
    if(!gesture)return;
    gesture.pointer=e.pointerId;e.preventDefault();stage.focus();stage.setPointerCapture(e.pointerId);
  });
  stage.onpointermove=e=>{
    cursor=point(e);if(!gesture||gesture.pointer!==e.pointerId)return;
    if(['link','reverse-link','output-link','node'].includes(gesture.kind)&&(e.buttons&2)){suppressContextUntil=performance.now()+500;cancelGesture();e.preventDefault();return;}
    if(gesture.kind==='pan'){
      if(!(e.buttons&gesture.buttonMask)){finishPan();return;}
      pose.x=gesture.pose.x+e.clientX-gesture.x;pose.y=gesture.pose.y+e.clientY-gesture.y;syncPose();
    }
    else if(gesture.kind==='node'){
      let dx=cursor.x-gesture.point.x,dy=cursor.y-gesture.point.y;
      if(e.ctrlKey){dx=Math.round(dx/20)*20;dy=Math.round(dy/20)*20;}
      for(const start of gesture.starts){const node=graph.nodes.find(n=>n.id===start.id);node.x=Math.round(start.x+dx);node.y=Math.round(start.y+dy);const box=world.querySelector(`[data-node="${node.id}"]`);box.style.left=node.x+'px';box.style.top=node.y+'px';}
      gesture.insertion=e.altKey?null:nodeInsertion(gesture);lines();
    }else if(gesture.kind==='marquee'){
      const left=Math.min(gesture.start.x,cursor.x),top=Math.min(gesture.start.y,cursor.y),right=Math.max(gesture.start.x,cursor.x),bottom=Math.max(gesture.start.y,cursor.y),height=sizes();
      marquee.hidden=false;Object.assign(marquee.style,{left:left+'px',top:top+'px',width:(right-left)+'px',height:(bottom-top)+'px'});
      select(new Set([...gesture.initial,...graph.nodes.filter(n=>n.x<right&&n.x+nodeWidth(n)>left&&n.y<bottom&&n.y+(height[n.id]||240)>top).map(n=>n.id)]));
    }else if(['cut','reroute-cut'].includes(gesture.kind))moveCut(gesture,cursor);
    else {gesture.moved||=Math.hypot(e.clientX-gesture.start.x,e.clientY-gesture.start.y)>3;if(gesture.moved)previewLink(gesture,e);}
  };
  stage.onpointerup=e=>{
    if(!gesture||gesture.pointer!==e.pointerId)return;
    if(gesture.kind==='pan'){finishPan();return;}
    if(['cut','reroute-cut'].includes(gesture.kind)&&e.button!==2||['link','reverse-link','output-link'].includes(gesture.kind)&&e.button!==0)return;
    if(['cut','reroute-cut'].includes(gesture.kind))moveCut(gesture,point(e));
    const g=gesture;gesture=null;marquee.hidden=true;
    stage.removeAttribute('data-cutting');
    connectionHint();
    if(stage.hasPointerCapture(e.pointerId))stage.releasePointerCapture(e.pointerId);
    if(g.kind==='node'){
      if(g.starts.some(start=>{const n=graph.nodes.find(n=>n.id===start.id);return n.x!==start.x||n.y!==start.y;})){
        try{void commit(!e.altKey&&g.insertion?insertMaterialNode(graph,g.insertion.node,g.insertion.link,read().paint.assets):graph);}catch(error){showError(error);key='';sync();}
      }
    }else if(['link','reverse-link','output-link'].includes(g.kind)){
      if(!g.moved&&Math.hypot(e.clientX-g.start.x,e.clientY-g.start.y)<=3){lines();return;}
      const target=linkTarget(g,e);g.swap=e.altKey;
      try{if(target&&(target.dataset.direction!==g.direction))throw Error('节点插口类型或方向不匹配');saveLinks(linkGraph(g,target?endpoint(target):null));}catch(error){showError(error);lines();}
    }else if(['cut','reroute-cut'].includes(g.kind)){
      suppressContextUntil=performance.now()+500;
      try{saveLinks(g.kind==='reroute-cut'?rerouteMaterialLinks(graph,g.crossings,read().paint.assets):editMaterialLinks(graph,graph.links.filter(l=>g.cut.has(materialLinkKey(l))),[],read().paint.assets));}catch(error){showError(error);lines();}
    }else if(g.kind==='marquee'&&Math.hypot(cursor.x-g.start.x,cursor.y-g.start.y)<3)select(g.initial);
  };
  stage.onpointercancel=e=>{if(gesture?.pointer===e.pointerId)cancelGesture();};
  stage.onlostpointercapture=e=>{if(e.target===stage&&gesture?.pointer===e.pointerId)cancelGesture();};
  stage.onkeydown=e=>{
    if(e.target.closest('input,select,.custom-select,.workspace-range-field,.shader-image-open,.shader-image-preview'))return;
    const k=e.key.toLowerCase(),modifier=e.metaKey||e.ctrlKey;
    if(gesture&&k!=='escape'){if(modifier&&k==='z'){cancelGesture();return;}e.preventDefault();e.stopPropagation();return;}
    if(k===' '){space=true;e.preventDefault();}
    if(k==='escape'){cancelGesture();key='';sync();draft(null);e.preventDefault();}
    if(k==='delete'||k==='backspace'){removeSelection();e.preventDefault();}
    if(k==='home'){frame.click();e.preventDefault();}
    if(modifier&&k==='a'){select(graph.nodes.map(node=>node.id));e.preventDefault();}
    if(modifier&&k==='c'){copySelection();e.preventDefault();}
    if(modifier&&k==='v'){void pasteSelection();e.preventDefault();}
    if(e.shiftKey&&!modifier&&k==='d'){void cloneSelection();e.preventDefault();}
    if(e.shiftKey&&!modifier&&k==='a'){add.closest('.custom-select').querySelector('button').click();e.preventDefault();}
    if(e.defaultPrevented||!modifier)e.stopPropagation();
  };
  stage.onkeyup=e=>{if(e.key===' ')space=false;};
  stage.onblur=()=>{space=false;};
  window.addEventListener('blur',()=>{space=false;cancelGesture();},{signal});
  window.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&gesture?.kind==='pan'){e.preventDefault();e.stopPropagation();cancelGesture();}
  },{capture:true,signal});
  let resize=null;
  const resizeBounds=()=>[160,Math.max(160,Math.floor(window.innerHeight*.7))];
  function resizeHeight(height){
    const [min,max]=resizeBounds();host.style.height=Math.max(min,Math.min(max,height))+'px';
    splitter.setAttribute('aria-valuemin',String(min));splitter.setAttribute('aria-valuemax',String(max));splitter.setAttribute('aria-valuenow',String(host.offsetHeight));
  }
  function rememberHeight(){try{localStorage.setItem('arachne-shader-height',String(host.offsetHeight));}catch{}}
  splitter.onpointerdown=e=>{if(e.button)return;resize={pointer:e.pointerId,y:e.clientY,h:host.offsetHeight};splitter.setPointerCapture(e.pointerId);e.preventDefault();};
  splitter.onpointermove=e=>{if(resize)resizeHeight(resize.h+resize.y-e.clientY);};
  splitter.onpointerup=e=>{if(!resize)return;resize=null;rememberHeight();if(splitter.hasPointerCapture(e.pointerId))splitter.releasePointerCapture(e.pointerId);};
  function cancelResize(){if(!resize)return;const initial=resize;resize=null;resizeHeight(initial.h);if(splitter.hasPointerCapture(initial.pointer))splitter.releasePointerCapture(initial.pointer);}
  splitter.onpointercancel=cancelResize;splitter.onlostpointercapture=cancelResize;
  splitter.ondblclick=()=>{resizeHeight(310);rememberHeight();};
  splitter.onkeydown=e=>{
    if(e.key==='Escape'&&resize){cancelResize();e.preventDefault();e.stopPropagation();return;}
    const [min,max]=resizeBounds(),target={ArrowUp:host.offsetHeight+24,ArrowDown:host.offsetHeight-24,Home:min,End:max}[e.key];
    if(target===undefined)return;e.preventDefault();e.stopPropagation();resizeHeight(target);rememberHeight();
  };
  const observer=new ResizeObserver(()=>lines());observer.observe(stage);
  return {sync,frameAll:()=>frameNodes(),getViewState:()=>({pose:{...pose},collapsed}),dispose(){rememberPose();cancelGesture();cancelResize();disposed=true;lifecycle.abort();clearTimeout(poseTimer);observer.disconnect();host.replaceChildren();},setScope(text){scope=text;if(!target){material.textContent=text;material.title=text;}controls();},isEditing:()=>!!gesture||writing};
}
