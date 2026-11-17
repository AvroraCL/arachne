import {setSelectValue,syncSelectMenu} from './paint-select.mjs';
import {isSelectionAsset} from './uv-selection-region.mjs';

export function createMeshMapDialog({read,api,refresh,assetUrl}){
  const dialog=document.getElementById('mesh-map-dialog'),form=dialog.querySelector('form');
  const {resolution,idSource,mode,image,pick}=form.elements;
  const bake=form.querySelector('[data-bake]'),apply=form.querySelector('[type=submit]');
  const preview=form.querySelector('img'),status=form.querySelector('output'),pickRow=form.querySelector('[data-pick]');
  const group=()=>mode.value==='cavity'?'ao':mode.value==='id'?'id':'curvature';
  let origin,layerId,controller,maps;
  function showPreview(){
    const id=image.value;
    preview.hidden=!id;
    if(id)preview.src=assetUrl(id);else preview.removeAttribute('src');
    pickRow.hidden=mode.value!=='id';
    preview.toggleAttribute('data-pickable',!pickRow.hidden);
    apply.disabled=!id||!!controller;
  }
  function chooseMap(){
    const kind=group(),prefix={ao:'环境遮蔽 AO',curvature:'曲率',id:'ID.png'};
    const options=[...image.options];
    const preferred=maps[kind]||options.findLast(option=>option.text.includes(prefix[kind]))?.value;
    setSelectValue(image,preferred||'');
    showPreview();
  }
  function listAssets(){
    const assets=Object.values(read().paint.assets).filter(item=>!isSelectionAsset(item));
    image.replaceChildren(new Option('选择工程图片',''),...assets.map(item=>new Option(item.name,item.id)));
    chooseMap();
  }
  mode.onchange=chooseMap;image.onchange=showPreview;
  preview.onclick=event=>{
    if(pickRow.hidden||!preview.complete||!preview.naturalWidth)return;
    const rect=preview.getBoundingClientRect(),scale=Math.min(rect.width/preview.naturalWidth,rect.height/preview.naturalHeight);
    const x=Math.floor((event.clientX-rect.left-(rect.width-preview.naturalWidth*scale)/2)/scale);
    const y=Math.floor((event.clientY-rect.top-(rect.height-preview.naturalHeight*scale)/2)/scale);
    if(x<0||y<0||x>=preview.naturalWidth||y>=preview.naturalHeight)return;
    const pixel=document.createElement('canvas');pixel.width=pixel.height=1;
    const ctx=pixel.getContext('2d');ctx.drawImage(preview,x,y,1,1,0,0,1,1);
    const [r,g,b,a]=ctx.getImageData(0,0,1,1).data;
    if(!a){status.textContent='这里没有有效的 ID';return;}
    pick.value='#'+[r,g,b].map(n=>n.toString(16).padStart(2,'0')).join('');
    status.textContent='已取样 '+pick.value.toUpperCase();
  };
  async function execute(action,payload){
    if(controller)return;
    if(read().id!==origin.id||read().revision!==origin.revision){
      status.textContent='工程已变化，请重新打开网格贴图';return;
    }
    controller=new AbortController();
    for(const field of [resolution,idSource,mode,image,pick,bake,apply])field.disabled=true;
    status.textContent=action==='mesh-bake'?'正在烘焙网格贴图…':'正在提取蒙版…';
    try{
      const result=await api('/api/projects/'+origin.id+'/paint/'+action,{revision:origin.revision,...payload},controller.signal);
      await refresh();
      if(read().id!==origin.id||read().revision!==result.revision){status.textContent='工程已变化，请重新打开网格贴图';return;}
      origin.revision=result.revision;
      if(action==='mesh-mask'){dialog.close();return;}
      maps=result.maps;listAssets();status.textContent='三张贴图已保存到当前工程';
    }catch(error){
      status.textContent=controller.signal.aborted?'已取消':error.message;
    }finally{
      controller=null;
      for(const field of [resolution,idSource,mode,image,pick,bake])field.disabled=false;
      apply.disabled=!image.value;
    }
  }
  bake.onclick=()=>execute('mesh-bake',{resolution:Number(resolution.value),idSource:idSource.value});
  form.onsubmit=event=>{
    event.preventDefault();
    void execute('mesh-mask',{image:image.value,layerId,mode:mode.value,...(mode.value==='id'?{color:pick.value}:{})});
  };
  const close=()=>{if(controller)controller.abort();else dialog.close();};
  form.querySelector('[data-close]').onclick=close;
  dialog.oncancel=event=>{if(controller){event.preventDefault();close();}};
  return {open(layer){
    origin={id:read().id,revision:read().revision};layerId=layer.id;maps={};
    form.reset();
    for(const field of [resolution,idSource,mode])syncSelectMenu(field);
    listAssets();status.textContent='目标图层 · '+layer.name;
    dialog.showModal();
  }};
}
