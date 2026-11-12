import {channelSpecs,paintChannels} from './paint-channels.mjs';
import {groupMaterialMaps,mappedLibraryMaterial,packedMaterialLayouts} from './paint-library-maps.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';

const skip='@skip',chooseLayout='@layout';
const layoutChoices=Object.entries(packedMaterialLayouts).map(([id,layout])=>[id,layout.label]);

function el(tag,className,text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text)node.textContent=text;
  return node;
}

export function createMaterialMapDialog({read,origin,save,upload}){
  const dialog=el('dialog','paint-form-dialog material-map-dialog');
  dialog.setAttribute('aria-label','从贴图创建材质');
  const form=el('form'),header=el('header'),close=el('button','','关闭');
  const importButton=el('button','','导入贴图…'),file=el('input');
  importButton.title='选择或拖入 PNG、JPEG、WebP 或 TGA';
  file.type='file';file.accept='.png,.jpg,.jpeg,.webp,.tga,image/png,image/jpeg,image/webp';file.multiple=true;file.hidden=true;file.setAttribute('aria-label','导入材质贴图');
  importButton.type='button';importButton.onclick=()=>file.click();
  close.type='button';close.onclick=()=>dialog.close();header.append(el('strong','','从贴图创建材质'),importButton,close);
  const content=el('div','paint-form-content'),footer=el('footer','paint-form-footer');
  const error=el('p','material-map-error'),confirm=el('button','primary','创建材质');
  error.setAttribute('role','alert');confirm.type='submit';footer.append(error,confirm);
  form.append(header,content,footer,file);dialog.append(form);document.body.append(dialog);
  function field(label,control,maps=false){
    const row=el('label','material-map-row',label);
    control.setAttribute('aria-label',label);row.append(control);content.append(row);
    if(control.tagName==='SELECT')enhanceSelectMenu(control,maps?{
      menuClass:'material-map-select-menu',optionDetail:describeOption
    }:undefined);
    return row;
  }
  const name=el('input');name.type='text';name.required=true;name.maxLength=100;
  field('材质名称',name);
  const group=el('select'),groupRow=field('贴图组',group);
  const matchStatus=el('small','material-map-match-status');
  matchStatus.setAttribute('role','status');content.append(matchStatus);
  const packedFormat=el('select'),packedAsset=el('select'),packedHint=el('small','material-map-packed-hint');
  field('贴图通道布局',packedFormat);
  const packedRow=field('打包贴图',packedAsset,true);
  content.append(packedHint);
  const rows={},selectors=Object.fromEntries(paintChannels.map(channel=>{
    const control=el('select');
    rows[channel]=field(channelSpecs[channel].name,control,true);
    return [channel,control];
  }));
  const normal=el('select');
  normal.append(new Option('OpenGL（+Y）','opengl'),new Option('DirectX（−Y）','directx'));
  const normalRow=field('法线方向',normal);
  const alpha=el('select');
  alpha.append(new Option('灰度值','value'),new Option('Alpha 通道','alpha'));
  const alphaRow=field('不透明度来源',alpha);
  let start=null,assets={},groups=[],aliases=[],suggested='贴图材质',pending=false,chosen=null,
    packedOverride,normalSource=null;
  const manualMaps=new Map(),manualPacks=new Map();

  function describeOption(option){
    const asset=Object.hasOwn(assets,option.value)?assets[option.value]:null;
    if(!asset)return null;
    const dims=asset.width&&asset.height?asset.width+' × '+asset.height:'尺寸未知';
    const format=option.dataset.normalFormat;
    return {text:format?dims+' · '+(format==='directx'?'DirectX（−Y）':'OpenGL（+Y）'):dims,
      image:option.dataset.preview&&start?'/api/projects/'+encodeURIComponent(start.id)+'/paint/assets/'+encodeURIComponent(option.value)+'/preview':null};
  }
  function selectedAsset(control){return Object.hasOwn(assets,control.value)?control.value:null;}
  function sync(){
    const layout=packedMaterialLayouts[packedFormat.value];
    packedRow.hidden=packedHint.hidden=!layout;
    packedHint.textContent=layout?.description||'';
    let unresolved=packedFormat.value===chooseLayout?1:0,assigned=0;
    for(const channel of paintChannels){
      const row=rows[channel],control=selectors[channel];
      row.hidden=!!layout?.channels[channel];
      const waiting=!row.hidden&&!control.value&&(chosen?.candidates[channel]?.length||0)>1;
      row.toggleAttribute('data-map-pending',waiting);
      if(waiting)unresolved++;
      if(!row.hidden&&selectedAsset(control))assigned++;
    }
    const missingPack=!!layout&&!selectedAsset(packedAsset);
    packedRow.toggleAttribute('data-map-pending',missingPack);
    if(layout){if(missingPack)unresolved++;else assigned++;}
    const normalId=selectedAsset(selectors.normal);
    if(normalSource!==normalId){
      normalSource=normalId;
      normal.value=selectors.normal.selectedOptions[0]?.dataset.normalFormat||'opengl';
    }
    normalRow.hidden=!normalId;
    alphaRow.hidden=!selectedAsset(selectors.alpha);
    matchStatus.toggleAttribute('data-map-pending',unresolved>0);
    matchStatus.textContent=unresolved?unresolved+' 项待选择。可比较文件尺寸和预览，或明确跳过通道。':
      assigned?'已选择 '+assigned+' 张贴图':Object.keys(assets).length?'没有自动匹配的贴图，可手动选择通道。':'没有贴图。可导入文件或拖到此窗口。';
    confirm.disabled=pending||unresolved>0||!assigned||!name.value.trim();
    name.disabled=close.disabled=importButton.disabled=pending;
    for(const select of [group,packedFormat,packedAsset,normal,alpha,...Object.values(selectors)]){
      select.disabled=pending;syncSelectMenu(select);
    }
  }
  name.oninput=sync;
  packedFormat.onchange=()=>{packedOverride=packedFormat.value;rebuildPackedAsset();sync();};
  packedAsset.onchange=()=>{manualPacks.set(packedFormat.value,packedAsset.value);sync();};
  for(const [channel,control] of Object.entries(selectors))control.onchange=()=>{manualMaps.set(channel,control.value);sync();};
  function selectGroup(){
    manualMaps.clear();manualPacks.clear();packedOverride=undefined;normalSource=null;
    applyGroup();
  }
  group.onchange=selectGroup;
  function makeMapOption(asset,candidate=false){
    const option=new Option(asset.name,asset.id);
    if(candidate)option.dataset.preview='true';
    if(asset.normalFormat)option.dataset.normalFormat=asset.normalFormat;
    const stored=assets[asset.id];
    if(stored?.width&&stored.height)option.dataset.search=stored.width+'x'+stored.height+' '+stored.width+' × '+stored.height;
    return option;
  }
  function fillMapOptions(control,candidates,{previous,required=false}={}){
    const candidateIds=new Set(candidates.map(asset=>asset.id));
    const empty=!Object.keys(assets).length?'没有贴图':required?'选择打包贴图…':'未匹配 · 选择贴图…';
    const options=[new Option(candidates.length>1?candidates.length+' 张候选 · 待选择':empty,'')];
    if(!required)options.push(new Option('不使用此通道',skip));
    if(candidates.length){
      const matched=el('optgroup');matched.label='匹配候选';matched.append(...candidates.map(asset=>makeMapOption(asset,true)));options.push(matched);
    }
    const other=Object.entries(assets).filter(([id])=>!candidateIds.has(id)).sort((a,b)=>a[1].name.localeCompare(b[1].name,'zh-CN',{numeric:true}));
    if(other.length){
      const manual=el('optgroup');manual.label=candidates.length?'项目其他贴图':'项目贴图';
      manual.append(...other.map(([id,asset])=>makeMapOption({...asset,id})));options.push(manual);
    }
    control.replaceChildren(...options);
    control.value=previous===skip&&!required||Object.hasOwn(assets,previous)?previous:candidates.length===1?candidates[0].id:'';
  }
  function rebuildPackedAsset(){
    const format=packedFormat.value;
    fillMapOptions(packedAsset,chosen?.packedCandidates[format]||[],{required:true,previous:manualPacks.get(format)});
  }
  function applyGroup(){
    chosen=groups.find(entry=>entry.key===group.value)||null;
    const formats=Object.keys(chosen?.packedCandidates||{});
    packedFormat.replaceChildren(
      ...(formats.length>1?[new Option(formats.length+' 种布局 · 待选择',chooseLayout)]:[]),
      new Option('独立通道贴图',''),...layoutChoices.map(([id,label])=>new Option(label,id))
    );
    packedFormat.value=packedOverride??(formats.length===1?formats[0]:formats.length>1?chooseLayout:'');
    rebuildPackedAsset();
    for(const [channel,control] of Object.entries(selectors))
      fillMapOptions(control,chosen?.candidates[channel]||[],{previous:manualMaps.get(channel)});
    if(chosen){
      const label=chosen.name.slice(0,100);
      if(name.value===suggested||!name.value.trim())name.value=label;
      suggested=label;
    }
    sync();
  }
  function updateOptions(imported=[]){
    aliases=aliases.filter(item=>Object.hasOwn(assets,item.id));
    groups=groupMaterialMaps(assets,aliases);
    const selectedGroup=group.value;
    group.replaceChildren(new Option('选择贴图组',''),...groups.map(entry=>new Option(entry.name,entry.key)));
    group.value=groups.some(entry=>entry.key===selectedGroup)?selectedGroup:'';
    groupRow.hidden=!groups.length;
    const suggestions=imported.length?groupMaterialMaps({},imported):groups;
    if(!group.value&&!manualMaps.size&&!manualPacks.size&&packedOverride===undefined&&suggestions.length===1)
      group.value=suggestions[0].key;
    applyGroup();
  }
  async function addFiles(files){
    if(!files.length||pending)return;
    error.textContent='';pending=true;sync();
    importButton.textContent='正在导入 '+files.length+' 张…';
    try{
      const uploaded=await upload(files,start);
      if(read()?.id!==start.id)throw Error('工程已切换，请重新打开材质窗口');
      start=origin();assets=read().paint.assets;aliases.push(...uploaded);
      updateOptions(uploaded);
    }catch(failure){
      error.textContent=failure.message;
      if(failure.status===409&&read()?.id===start.id){start=origin();assets=read().paint.assets;updateOptions();}
    }
    finally{pending=false;importButton.textContent='导入贴图…';sync();}
  }
  file.onchange=()=>{const files=[...file.files];file.value='';void addFiles(files);};
  dialog.addEventListener('dragover',event=>{
    if(!event.dataTransfer?.types.includes('Files'))return;
    event.preventDefault();event.dataTransfer.dropEffect=pending?'none':'copy';
    dialog.toggleAttribute('data-file-drop',!pending);
  });
  dialog.addEventListener('dragleave',event=>{if(!dialog.contains(event.relatedTarget))dialog.removeAttribute('data-file-drop');});
  dialog.addEventListener('drop',event=>{
    dialog.removeAttribute('data-file-drop');
    if(!event.dataTransfer?.types.includes('Files'))return;
    event.preventDefault();void addFiles([...event.dataTransfer.files]);
  });
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  form.onsubmit=async event=>{
    event.preventDefault();
    if(confirm.disabled)return;
    const maps=Object.fromEntries(Object.entries(selectors).map(([channel,control])=>[channel,selectedAsset(control)]));
    error.textContent='';pending=true;sync();
    try{
      const packed=packedFormat.value?{format:packedFormat.value,asset:packedAsset.value}:null;
      const graph=mappedLibraryMaterial(maps,assets,{alphaOutput:alpha.value,packed,normalFormat:normal.value});
      await save({name:name.value.trim(),graph},start);
      dialog.close();
    }catch(failure){
      error.textContent=failure.message;
      if(failure.status===409&&read()?.id===start.id){
        start=origin();assets=read().paint.assets;updateOptions();
        error.textContent='工程已更新。请复核贴图，再创建材质。';
      }
    }
    finally{pending=false;sync();}
  };
  return {
    open(){
      if(dialog.open||document.querySelector('dialog[open]'))return false;
      const doc=read();
      if(!doc)return false;
      start=origin();assets=doc.paint.assets;aliases=[];group.value='';chosen=null;
      manualMaps.clear();manualPacks.clear();packedOverride=undefined;normalSource=null;
      suggested=name.value='贴图材质';error.textContent='';alpha.value='value';
      packedFormat.value=packedAsset.value='';normal.value='opengl';
      updateOptions();
      dialog.showModal();name.select();
      return true;
    },
    dispose(){dialog.remove();}
  };
}
