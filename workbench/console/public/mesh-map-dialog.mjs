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

export function bindNormalBakeDialog({read,refresh,assetUrl}){
  const dialog=document.getElementById('normal-bake-dialog'),form=dialog.querySelector('form');
  const {high,resolution,front,rear,createLayer}=form.elements;
  const status=form.querySelector('output'),preview=form.querySelector('img'),submit=form.querySelector('[type=submit]');
  const close=form.querySelector('[data-close]');
  let projectId,revision,controller;
  document.getElementById('open-normal-bake').onclick=()=>{
    const doc=read();
    if(!doc)return;
    projectId=doc.id;revision=doc.revision;
    form.reset();syncSelectMenu(resolution);
    form.querySelector('[data-low]').textContent='低模 · '+doc.name+' / '+doc.source.material;
    status.textContent='高模和低模须使用相同的坐标和比例。';
    preview.hidden=true;preview.removeAttribute('src');
    dialog.showModal();
  };
  close.onclick=()=>controller?controller.abort():dialog.close();
  dialog.oncancel=event=>{if(controller){event.preventDefault();controller.abort();}};
  form.onsubmit=async event=>{
    event.preventDefault();
    if(controller)return;
    if(read()?.id!==projectId||read().revision!==revision){status.textContent='工程已变化，请重新打开烘焙窗口';return;}
    if(Number(front.value)+Number(rear.value)===0){status.textContent='向内和向外距离至少一项须大于零';return;}
    const file=high.files[0];
    if(!file)return;
    const params=new URLSearchParams({revision,resolution:resolution.value,front:front.value,rear:rear.value,createLayer:createLayer.checked});
    controller=new AbortController();
    for(const input of [high,resolution,front,rear,createLayer,submit])input.disabled=true;
    syncSelectMenu(resolution);
    close.textContent='取消烘焙';status.textContent='正在将高模表面投射到低模 UV…';
    preview.hidden=true;
    try{
      const response=await fetch('/api/projects/'+projectId+'/paint/mesh-normal?'+params,{method:'POST',
        headers:{'Content-Type':'model/gltf-binary'},body:file,signal:controller.signal});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'法线烘焙失败');
      await refresh();
      if(read()?.id!==projectId||read().revision!==result.revision){status.textContent='工程已变化，请重新打开烘焙窗口';return;}
      revision=result.revision;
      preview.src=assetUrl(result.maps.normal);preview.hidden=false;
      const {hits,valid}=result.coverage;
      status.textContent='命中 '+hits+' / '+valid+' 像素（'+(100*hits/valid).toFixed(1)+'%）· '+(createLayer.checked?'已添加法线填充层':'已保存到工程素材');
    }catch(error){status.textContent=controller.signal.aborted?'已取消烘焙':error.message;}
    finally{
      controller=null;close.textContent='关闭';
      for(const input of [high,resolution,front,rear,createLayer,submit])input.disabled=false;
      syncSelectMenu(resolution);
    }
  };
}
