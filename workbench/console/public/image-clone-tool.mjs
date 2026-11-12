export function createImageCloneTool({stage,canvas,parameters,settings={},context,onChange}){
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
  hint.textContent='Alt / Option 单击取样';
  options.append(label,hint);
  parameters.append(options);

  const marker=document.createElement('span');
  marker.className='document-clone-source';
  marker.setAttribute('aria-hidden','true');
  marker.hidden=true;
  stage.append(marker);
  let active=false,source=null,hover=null;
  const key=state=>state?.imageDocumentId&&JSON.stringify([state.id,state.imageDocumentId,state.layer?.id]);
  function sampleFor(state){
    return source?.key===key(state)?source:null;
  }
  function delta(point,state){
    const sample=sampleFor(state);
    return sample&&(aligned.checked&&sample.offset||sample.point.map((n,index)=>n-point[index]));
  }
  function layout(){
    const state=context(),sample=sampleFor(state);
    hint.hidden=!!sample;
    options.hidden=!active;
    if(!active||!sample){marker.hidden=true;return;}
    const target=hover?.point;
    const offset=hover?.strokeOffset||(target&&aligned.checked?sample.offset:null);
    const position=target&&offset&&!hover.sampling?target.map((n,i)=>n+offset[i]):sample.point;
    const bounds=canvas.getBoundingClientRect(),host=stage.getBoundingClientRect();
    const x=bounds.left-host.left+position[0]*bounds.width,y=bounds.top-host.top+position[1]*bounds.height;
    marker.hidden=position.some(n=>n<0||n>1)||x<0||x>host.width||y<0||y>host.height;
    marker.style.left=x+'px';
    marker.style.top=y+'px';
  }
  aligned.onchange=()=>{
    if(source)source.offset=null;
    onChange();layout();
  };
  function pick(point,state){
    source={key:key(state),point,offset:null};
    hover=null;
    layout();
  }
  function prepare(point,state){
    const offset=delta(point,state);
    if(!offset)return null;
    if(aligned.checked)source.offset=offset;
    return offset;
  }
  function track(point,strokeOffset,sampling){
    hover=point?{point,strokeOffset,sampling}:null;
    layout();
  }
  layout();
  return {
    layout,pick,prepare,track,
    setActive(next){active=next;hover=null;layout();},
    getState:()=>({aligned:aligned.checked})
  };
}
