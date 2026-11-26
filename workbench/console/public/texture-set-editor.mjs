import {layerLockOwner} from './paint-layer-tree.mjs';
import {workspaceIcons} from './workspace-icons.mjs';
import {syncSelectMenu} from './paint-select.mjs';

// Every edit captures its material name. Browsing slots has no project history.
export function mountTextureSets(ctx,bridge){
  const {host,project}=ctx;
  const root=document.createElement('section');
  root.className='texture-set-editor';
  root.innerHTML=`<button class="texture-set-toggle" type="button" aria-expanded="false">${workspaceIcons.chevron}纹理集<span data-slot-caption aria-hidden="true"></span></button>
    <div class="texture-set-body" hidden>
      <label>材质槽<select aria-label="纹理集材质槽"></select></label>
      <label data-layer-row>图层<select aria-label="纹理集图层"></select></label>
      <div class="texture-set-actions"><button type="button" data-add>${workspaceIcons.plus}新建填充层</button><button type="button" data-remove aria-label="删除图层" title="删除图层">${workspaceIcons.trash}</button></div>
      <fieldset hidden><details open><summary>图层属性</summary><div class="texture-set-parameters">
        <label>名称<input aria-label="图层名称" name="layerName"></label><label>颜色<span class="texture-set-color"><input aria-label="颜色" name="color" type="color"><span data-hex aria-hidden="true"></span></span></label>
        <label>粗糙度<input aria-label="粗糙度" name="roughness" type="number" min="0" max="1" step=".01"></label>
        <label>颜色来源<select name="colorImage" aria-label="纹理集颜色来源"></select></label>
        <label>粗糙度来源<select name="roughnessImage" aria-label="纹理集粗糙度来源"></select></label>
      </div></details>
      <details open><summary>蒙版</summary><div class="texture-set-parameters">
        <label>笔刷模式<select name="ink" aria-label="UV 蒙版"><option value="0">遮盖</option><option value="1">恢复</option></select></label>
        <label>半径 (px)<input aria-label="笔刷半径（像素）" name="radius" required type="number" min="1" max="512" value="160"></label>
        <button type="button" data-surface aria-pressed="false">${workspaceIcons.mask}视口画蒙版</button>
        <canvas width="256" height="256" aria-label="纹理集 UV 蒙版" tabindex="0"></canvas>
      </div></details></fieldset>
      <output role="status"></output></div>`;
  host.prepend(root);
  const toggle=root.firstElementChild,body=toggle.nextElementSibling;
  const [slots,layers]=root.querySelectorAll('label>select'),canvas=root.querySelector('canvas'),context=canvas.getContext('2d');
  const field=name=>root.querySelector('[name="'+name+'"]'),status=root.querySelector('output');
  const slotCaption=root.querySelector('[data-slot-caption]'),layerRow=root.querySelector('[data-layer-row]');
  const surface=root.querySelector('[data-surface]');
  const add=root.querySelector('[data-add]'),remove=root.querySelector('[data-remove]'),fields=root.querySelector('fieldset');
  let slot,projectId,modelKey,available,key,ink,maskRequest,slotRequest,writing=false,disposed=false;
  const currentLayer=new Map();
  const stack=()=>slot===project.document.source.material?project.document.paint:project.document.paint.textureSets?.[slot];
  const item=()=>stack()?.layers.find(l=>l.id===currentLayer.get(slot));
  const message=error=>{if(!disposed)status.textContent=error.message;};
  async function command(...edits){
    const origin=project.origin(),name=slot,prior=new Set(stack()?.layers.map(l=>l.id));
    writing=true;sync();
    let failure;
    try{
      const result=await project.commands(edits.map(edit=>({op:'textureSet',name,edit})),origin);
      if(disposed||project.document?.id!==origin.id||slot!==name)return;
      if(edits[0].op==='add'){
        const next=(name===result.source.material?result.paint:result.paint.textureSets[name]).layers;
        currentLayer.set(name,next.findLast(l=>!prior.has(l.id)).id);
      }
      status.textContent='已保存 · '+name;
    }catch(error){failure=error;}
    finally{writing=false;key=null;sync();if(failure)message(failure);}
  }
  async function readSlots(doc){
    const controller=new AbortController();slotRequest?.abort();slotRequest=controller;
    try{
      const r=await fetch('/api/projects/'+doc.id+'/paint/render-objects',{signal:controller.signal});
      const info=await r.json();if(!r.ok)throw Error(info.error);
      if(controller.signal.aborted)return;
      available=info.textureSlots;
      slots.replaceChildren(...Object.keys(available).map(name=>new Option(name,name)));
      slot=Object.hasOwn(available,slot)?slot:doc.source.material;
      slots.value=slot;syncSelectMenu(slots);key=null;sync();
    }catch(error){if(!controller.signal.aborted)message(error);}
  }
  async function readMask(doc,layer){
    maskRequest?.abort();context.clearRect(0,0,256,256);
    if(!layer)return;
    const controller=new AbortController();maskRequest=controller;
    try{
      const r=await fetch('/api/projects/'+doc.id+'/paint/live',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},
        body:JSON.stringify({revision:doc.revision,textureSet:slot,inspectMask:layer.id,resolution:256})});
      if(r.status===204)return;
      if(!r.ok)throw Error((await r.json()).error);
      const pixels=new Uint8Array(await r.arrayBuffer());
      if(controller.signal.aborted||ink)return;
      const image=context.createImageData(256,256);
      for(let i=0,j=0;i<pixels.length;i+=6,j+=4){image.data.fill(pixels[i],j,j+3);image.data[j+3]=255;}
      context.putImageData(image,0,0);
    }catch(error){if(!controller.signal.aborted)message(error);}
  }
  function sync(){
    const doc=project.document;
    if(disposed||!doc)return;
    toggle.hidden=doc.source.format!=='glb';
    if(doc.id!==projectId){disarm();projectId=doc.id;slot=doc.source.material;currentLayer.clear();key=null;available=null;}
    if(ink&&ink.revision!==doc.revision){ink=null;key=null;}
    if(body.hidden||toggle.hidden)return;
    const source=doc.id+':'+doc.source.files[doc.source.reviewSource];
    if(source!==modelKey){modelKey=source;available=null;void readSlots(doc);}
    slots.disabled=writing||!!ink||!available;toggle.disabled=writing||!!ink;
    slotCaption.textContent=available?slot:'';slotCaption.title=slotCaption.textContent;
    if(!available){layerRow.hidden=fields.hidden=true;add.disabled=remove.disabled=fields.disabled=layers.disabled=true;return;}
    const stackLayers=stack()?.layers??[];
    if(!stackLayers.some(l=>l.id===currentLayer.get(slot)))currentLayer.set(slot,stackLayers.at(-1)?.id);
    const layer=item(),next=JSON.stringify([doc.id,doc.revision,slot,layer?.id]);
    const locked=layer&&layerLockOwner(stackLayers,layer);
    const reason=slot!==doc.source.material&&!stack()&&doc.paint.sourceMaterials?.[slot]?.mark?
      '此槽已有投影标记。导入时选为主涂装材质即可编辑。':'';
    add.disabled=writing||!!ink||!!reason;remove.disabled=writing||!!ink||!layer||!!locked;
    layers.disabled=writing||!!ink||!stackLayers.length;fields.disabled=writing||!layer||!!locked;
    layerRow.hidden=fields.hidden=!layer;
    if(next===key)return;key=next;
    layers.replaceChildren(...[...stackLayers].reverse().map(l=>new Option(l.name,l.id)));layers.value=layer?.id??'';syncSelectMenu(layers);
    for(const channel of ['color','roughness']){
      const select=field(channel+'Image'),bound=layer?.documentMaps?.[channel];
      select.replaceChildren(new Option(layer?.maps?.[channel]?'导入贴图':'图层数值',''),
        ...Object.entries(doc.paint.imageDocuments??{}).map(([id,image])=>new Option(image.name,id)));
      select.value=bound??'';select.disabled=layer?.kind!=='fill'||!!layer.materialId;syncSelectMenu(select);
      field(channel).disabled=!layer?.values||!!layer.maps?.[channel]||!!bound;
    }
    if(layer){field('layerName').value=layer.name;field('color').value=layer.values?.color??'#808080';field('roughness').value=layer.values?.roughness??.5;
      root.querySelector('[data-hex]').textContent=field('color').value.toUpperCase();}
    status.textContent=reason||(!layer?'在当前材质槽新建第一层。':'');
    void readMask(doc,layer);
  }
  toggle.onclick=()=>{
    body.hidden=!body.hidden;toggle.setAttribute('aria-expanded',String(!body.hidden));
    root.toggleAttribute('data-open',!body.hidden);key=null;
    if(body.hidden){maskRequest?.abort();disarm();}else sync();
  };
  slots.onchange=()=>{slot=slots.value;key=null;sync();};
  layers.onchange=()=>{currentLayer.set(slot,layers.value);sync();};
  add.onclick=()=>void command({op:'add',kind:'fill',patch:{name:'填充层 '+((stack()?.layers.length??0)+1),
    channels:{color:true,roughness:true,metallic:true},values:{color:'#808080',roughness:.5,metallic:0}}});
  remove.onclick=()=>void command({op:'remove',id:item().id});
  function update(patch){void command({op:'update',id:item().id,patch});}
  for(const channel of ['color','roughness']){
    field(channel+'Image').onchange=event=>{
      const layer=item(),documentMaps={...layer.documentMaps},id=event.target.value;
      if(id)documentMaps[channel]=id;
      else delete documentMaps[channel];
      update({documentMaps,...(id?{channels:{...layer.channels,[channel]:true}}:{})});
    };
  }
  field('layerName').onchange=e=>update({name:e.target.value});
  field('color').onchange=e=>update({channels:{...item().channels,color:true},values:{...item().values,color:e.target.value}});
  field('roughness').onchange=e=>{if(e.target.reportValidity()&&e.target.value!=='')update({channels:{...item().channels,roughness:true},values:{...item().values,roughness:e.target.valueAsNumber}});};
  function point(event){const rect=canvas.getBoundingClientRect();return [Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))];}
  function dab(p){
    ink.stamps.push(p);context.fillStyle=ink.value?'white':'black';
    context.beginPath();context.arc(p[0]*256,p[1]*256,ink.radius*256,0,Math.PI*2);context.fill();
  }
  canvas.onpointerdown=e=>{
    if(e.button!==0||!item()||fields.disabled||ink||!field('radius').reportValidity())return;
    e.preventDefault();canvas.focus();canvas.setPointerCapture(e.pointerId);
    ink={revision:project.document.revision,id:item().id,pointer:e.pointerId,value:Number(field('ink').value),radius:Number(field('radius').value)/4096,stamps:[]};
    maskRequest?.abort();dab(point(e));sync();
  };
  canvas.onpointermove=e=>{
    if(!ink||ink.view||ink.pointer!==e.pointerId)return;
    const next=point(e),prev=ink.stamps.at(-1),n=Math.ceil(Math.hypot(next[0]-prev[0],next[1]-prev[1])/(ink.radius*.45));
    for(let i=1;i<=n;i++)dab(prev.map((v,j)=>v+(next[j]-v)*i/n));
  };
  function commitInk(){
    const {id,radius,value,stamps}=ink;ink=null;
    const operations=[];
    if(item().maskEnabled!==true)operations.push({op:'update',id,patch:{maskEnabled:true}});
    for(let i=0;i<stamps.length;i+=1024)operations.push({op:'stroke',id,target:'mask',stroke:{uv:true,radius,value,hardness:.8,opacity:1,stamps:stamps.slice(i,i+1024)}});
    void command(...operations);
  }
  canvas.onpointerup=e=>{if(ink?.pointer===e.pointerId&&!ink.view){canvas.onpointermove(e);commitInk();}};
  function cancel(){if(!ink)return;ink=null;key=null;sync();}
  canvas.onpointercancel=cancel;canvas.onkeydown=e=>{if(e.key==='Escape')cancel();};
  const brush={disarm,pointer(event,view,viewport){
    if(bridge.textureSetBrush!==brush||body.hidden||!root.getClientRects().length)return false;
    const {type,pointerId,clientX,clientY}=event;
    const hitAt=(x,y)=>{
      const hit=viewport.pickTargetUV(x,y,true);
      if(!hit||(hit.sourceMaterial??project.document.source.material)!==slot||[hit.u,hit.v].some(v=>v<0||v>1))return null;
      return [hit.u,hit.v];
    };
    if(type==='pointerdown'){
      if(event.button!==0||event.altKey||event.target.tagName!=='CANVAS')return false;
      if(ink||fields.disabled||!field('radius').reportValidity())return true;
      const p=hitAt(clientX,clientY);
      if(!p){status.textContent='请在「'+slot+'」的可见表面绘制';return true;}
      ink={view,revision:project.document.revision,pointer:pointerId,id:item().id,radius:field('radius').valueAsNumber/4096,value:Number(field('ink').value),
        stamps:[],last:[clientX,clientY]};
      view.setPointerCapture(pointerId);maskRequest?.abort();dab(p);sync();return true;
    }
    if(ink?.view!==view||ink.pointer!==pointerId)return false;
    if(type==='pointercancel'||type==='lostpointercapture'){cancel();return true;}
    // Raycast along the screen path; crossing a seam never connects unrelated UVs.
    const [x,y]=ink.last,n=Math.ceil(Math.hypot(clientX-x,clientY-y)/2);
    for(let i=1;i<=n;i++){
      const p=hitAt(x+(clientX-x)*i/n,y+(clientY-y)*i/n),last=ink.stamps.at(-1);
      if(p&&Math.hypot(p[0]-last[0],p[1]-last[1])>=ink.radius*.15)dab(p);
    }
    ink.last=[clientX,clientY];
    if(type==='pointerup')commitInk();
    return true;
  }};
  function disarm(){
    if(bridge.textureSetBrush!==brush)return;
    bridge.textureSetBrush=null;surface.setAttribute('aria-pressed','false');cancel();
  }
  surface.onclick=()=>{
    if(bridge.textureSetBrush===brush){disarm();return;}
    bridge.textureSetBrush?.disarm();bridge.textureSetBrush=brush;
    surface.setAttribute('aria-pressed','true');status.textContent='在视口中绘制「'+slot+'」的蒙版';
  };
  const unsub=project.subscribe(sync);sync();
  return ()=>{disposed=true;disarm();slotRequest?.abort();maskRequest?.abort();unsub();root.remove();};
}
