import {canvasCoordinates} from './image-canvas-coordinates.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';

const modes=[['current','当前层'],['below','当前及以下'],['visible','所有可见层']];
async function captureRepairSource(state,mode,signal){
  const response=await fetch('/api/projects/'+state.id+'/paint/image-clone-source',{
    method:'POST',headers:{'Content-Type':'application/json'},signal,
    body:JSON.stringify({revision:state.revision,documentId:state.imageDocumentId,layerId:state.layer.id,mode})
  });
  const result=await response.json();
  if(!response.ok)throw Error(result.error);
  return result.asset;
}

export function createImageCloneTool({stage,canvas,parameters,settings={},context,onChange,onError}){
  const options=document.createElement('div');
  options.className='editor-toolbar document-clone-options';
  const label=document.createElement('label'),aligned=document.createElement('input');
  label.textContent='对齐';
  label.title='沿用首次仿制的相对位置，跨笔保持连续';
  aligned.type='checkbox';
  aligned.checked=settings.aligned!==false;
  aligned.setAttribute('aria-label','对齐仿制源');
  label.append(aligned);
  const hint=document.createElement('span');
  hint.className='document-sample-status';
  hint.setAttribute('role','status');
  const mode=document.createElement('select');
  mode.setAttribute('aria-label','仿制取样范围');
  mode.append(...modes.map(([value,name])=>new Option(name,value)));
  mode.value=modes.some(([value])=>value===settings.mode)?settings.mode:'current';
  options.append(mode,label,hint);
  parameters.append(options);
  enhanceSelectMenu(mode);

  const marker=document.createElement('span');
  marker.className='document-clone-source';
  marker.setAttribute('aria-hidden','true');
  marker.hidden=true;
  stage.append(marker);
  let active='',hover=null;
  const sources={clone:null,heal:null},modesByTool={clone:mode.value,heal:settings.healMode??'below',spot:settings.spotMode??'below'};
  let picked=null,backdrop=null,backgroundTask=null;
  const alignedByTool={clone:aligned.checked,heal:settings.healAligned!==false};
  const key=state=>state?.imageDocumentId&&JSON.stringify([state.id,state.imageDocumentId,state.layer?.id]);
  const ownerOf=state=>JSON.stringify([active,key(state),state.revision,mode.value]);
  function sampleFor(state){
    const source=sources[active];
    return source?.key===key(state)?source:null;
  }
  function delta(point,state){
    const sample=sampleFor(state);
    return sample&&(aligned.checked&&sample.offset||sample.point.map((n,index)=>n-point[index]));
  }
  function layout(){
    const state=context(),sample=sampleFor(state);
    const sampling=!!backgroundTask||!!picked&&picked.key===key(state);
    const repair=active==='heal'||active==='spot';
    hint.hidden=!active||!repair&&!!sample&&!sampling;
    options.dataset.repairReady=String(!!backdrop?.asset&&backdrop.owner===ownerOf(state)&&(active==='spot'||!!sample));
    const message=backdrop?.error?'取样失败 · 点击画布重试':sampling?'正在准备 4K 取样…':active==='spot'?(backdrop?.asset?'点击或涂抹小污点':'选择可编辑像素层'):
      sample?'沿接缝绘制 · Alt / Option 重新取样':'Alt / Option 单击取样';
    if(hint.textContent!==message)hint.textContent=message;
    options.hidden=!active;label.hidden=active==='spot';
    mode.setAttribute('aria-label',active==='clone'?'仿制取样范围':'修复取样范围');
    mode.closest('.custom-select')?.querySelector('button')?.setAttribute('aria-label',mode.getAttribute('aria-label'));
    if(!active||!sample){marker.hidden=true;return;}
    const target=hover?.point;
    const offset=hover?.strokeOffset||(target&&aligned.checked?sample.offset:null);
    const position=target&&offset&&!hover.sampling?target.map((n,i)=>n+offset[i]):sample.point;
    const host=stage.getBoundingClientRect();
    const [x,y]=canvasCoordinates(canvas).toLocal(host)(position);
    marker.hidden=position.some(n=>n<0||n>1)||x<0||x>host.width||y<0||y>host.height;
    marker.style.left=x+'px';
    marker.style.top=y+'px';
  }
  aligned.onchange=()=>{
    const source=sources[active];
    if(source)source.offset=null;
    alignedByTool[active]=aligned.checked;
    onChange();layout();
  };
  function clearBackdrop(){
    backgroundTask?.controller.abort();backgroundTask=null;backdrop=null;
  }
  function prepareBackdrop(state=context(),retry=false){
    if(!['heal','spot'].includes(active)||!state.layer||!state.uvEnabled||state.maskTarget||state.layer.kind!=='paint'||state.layer.locked)return;
    const owner=ownerOf(state);
    if(!retry&&backdrop?.owner===owner)return Promise.resolve(backdrop.asset);
    if(!retry&&backgroundTask?.owner===owner)return backgroundTask.promise;
    clearBackdrop();
    const controller=new AbortController(),task={owner,controller};
    backgroundTask=task;
    task.promise=captureRepairSource(state,mode.value,controller.signal).then(asset=>{
      if(backgroundTask===task)backdrop={owner,asset};
      return asset;
    }).catch(error=>{
      if(!controller.signal.aborted){backdrop={owner,error:error.message};onError(error);}
    }).finally(()=>{
      if(backgroundTask===task)backgroundTask=null;
      layout();
    });
    return task.promise;
  }
  mode.onchange=()=>{
    modesByTool[active]=mode.value;
    picked?.controller.abort();picked=null;
    if(active!=='spot')sources[active]=null;
    clearBackdrop();prepareBackdrop();
    onChange();layout();
  };
  async function pick(point,state){
    if(!['clone','heal'].includes(active))return;
    picked?.controller.abort();picked=null;
    const tool=active,target={key:key(state),point,offset:null};
    sources[tool]=null;hover=null;
    if(tool==='clone'&&mode.value==='current'){sources[tool]=target;layout();return;}
    const controller=new AbortController(),request={controller,key:target.key};
    picked=request;
    layout();
    try{
      const asset=tool==='heal'?await prepareBackdrop(state,!!backdrop?.error):await captureRepairSource(state,mode.value,controller.signal);
      if(picked===request&&asset)sources[tool]={...target,asset};
    }catch(error){
      if(!controller.signal.aborted)onError(error);
    }finally{
      if(picked===request)picked=null;
      layout();
    }
  }
  function prepare(point,state){
    if(state.maskTarget)return null;
    if(active==='spot'||active==='heal'){
      const owner=ownerOf(state);
      if(backdrop?.owner!==owner||!backdrop.asset){
        prepareBackdrop(state,!!backdrop?.error);
        layout();return null;
      }
      if(active==='spot')return {offset:[0,0],kind:'spot',asset:backdrop.asset};
    }
    const offset=point&&delta(point,state),source=sources[active];
    if(!offset)return null;
    if(aligned.checked)source.offset=offset;
    return {offset,...(source.asset?{asset:source.asset}:{}),...(active==='heal'?{kind:'heal',backdrop:backdrop.asset}:{})};
  }
  function track(point,strokeOffset,sampling){
    hover=point?{point,strokeOffset,sampling}:null;
    layout();
  }
  layout();
  return {
    layout,pick,prepare,track,refresh(){prepareBackdrop();layout();},
    setActive(next){
      if(active!==next){
        active=next;hover=null;clearBackdrop();
        if(active){mode.value=modesByTool[active];aligned.checked=alignedByTool[active]??true;syncSelectMenu(mode);}
        prepareBackdrop();
      }
      layout();
    },
    getState:()=>({aligned:alignedByTool.clone,mode:modesByTool.clone,healAligned:alignedByTool.heal,healMode:modesByTool.heal,spotMode:modesByTool.spot}),
    dispose(){picked?.controller.abort();picked=null;clearBackdrop();}
  };
}
