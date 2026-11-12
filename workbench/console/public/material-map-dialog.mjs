import {channelSpecs,paintChannels} from './paint-channels.mjs';
import {groupMaterialMaps,mappedLibraryMaterial,packedMaterialLayouts} from './paint-library-maps.mjs';
import {enhanceSelectMenu,syncSelectMenu} from './paint-select.mjs';

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
  const importButton=el('button','','导入 PNG…'),file=el('input');
  file.type='file';file.accept='.png,image/png';file.multiple=true;file.hidden=true;file.setAttribute('aria-label','导入材质贴图');
  importButton.type='button';importButton.onclick=()=>file.click();
  close.type='button';close.onclick=()=>dialog.close();header.append(el('strong','','从贴图创建材质'),importButton,close);
  const content=el('div','paint-form-content'),footer=el('footer','paint-form-footer');
  const error=el('p','material-map-error'),confirm=el('button','primary','创建材质');
  error.setAttribute('role','alert');confirm.type='submit';footer.append(error,confirm);
  form.append(header,content,footer,file);dialog.append(form);document.body.append(dialog);
  function field(label,control){
    const row=el('label','material-map-row',label);
    control.setAttribute('aria-label',label);row.append(control);content.append(row);
    if(control.tagName==='SELECT')enhanceSelectMenu(control);
    return row;
  }
  const name=el('input');name.type='text';name.required=true;name.maxLength=100;
  field('材质名称',name);
  const group=el('select'),groupRow=field('贴图组',group);
  const packedFormat=el('select'),packedAsset=el('select'),packedHint=el('small','material-map-packed-hint');
  packedFormat.append(new Option('独立通道贴图',''),...Object.entries(packedMaterialLayouts).map(([id,layout])=>new Option(layout.label,id)));
  field('贴图通道布局',packedFormat);
  const packedRow=field('打包贴图',packedAsset);
  content.append(packedHint);
  const rows={},selectors=Object.fromEntries(paintChannels.map(channel=>{
    const control=el('select');
    rows[channel]=field(channelSpecs[channel].name,control);
    return [channel,control];
  }));
  const normal=el('select');
  normal.append(new Option('OpenGL（+Y）','opengl'),new Option('DirectX（−Y）','directx'));
  const normalRow=field('法线方向',normal);
  const alpha=el('select');
  alpha.append(new Option('灰度值','value'),new Option('Alpha 通道','alpha'));
  const alphaRow=field('不透明度来源',alpha);
  let start=null,assets={},groups=[],aliases=[],suggested='贴图材质',pending=false;

  function sync(){
    const layout=packedMaterialLayouts[packedFormat.value];
    packedRow.hidden=packedHint.hidden=!layout;
    packedHint.textContent=layout?.description||'';
    for(const channel of paintChannels)rows[channel].hidden=!!layout?.channels[channel];
    normalRow.hidden=!selectors.normal.value;
    const hasMaps=layout?!!packedAsset.value:Object.values(selectors).some(control=>control.value);
    alphaRow.hidden=!selectors.alpha.value;
    confirm.disabled=pending||!hasMaps||!name.value.trim();
    name.disabled=close.disabled=importButton.disabled=pending;
    for(const select of [group,packedFormat,packedAsset,normal,alpha,...Object.values(selectors)]){
      select.disabled=pending;syncSelectMenu(select);
    }
  }
  name.oninput=sync;
  packedFormat.onchange=sync;packedAsset.onchange=sync;
  for(const select of Object.values(selectors))select.onchange=sync;
  function selectGroup(){
    const chosen=groups.find(entry=>entry.key===group.value);
    if(!chosen)return;
    const packs=Object.entries(chosen.packed??{}).filter(([,id])=>id);
    packedFormat.value=packs.length===1?packs[0][0]:'';
    packedAsset.value=packs.length===1?packs[0][1]:'';
    for(const [channel,control] of Object.entries(selectors)){
      const previous=control.dataset.alias;
      if(previous&&Object.hasOwn(assets,previous)){
        const original=[...control.options].find(option=>option.value===previous);
        if(original)original.textContent=assets[previous].name;
      }
      control.value=chosen.maps[channel]||'';
      const selected=control.selectedOptions[0],alias=chosen.names[channel];
      delete control.dataset.alias;
      if(selected?.value&&alias&&alias!==assets[selected.value].name){
        selected.textContent=alias;control.dataset.alias=selected.value;
      }
    }
    if(name.value===suggested||!name.value.trim())name.value=chosen.name.slice(0,100);
    suggested=chosen.name.slice(0,100);
    sync();
  }
  group.onchange=selectGroup;
  function updateOptions(imported=[]){
    const previous=Object.fromEntries(Object.entries(selectors).map(([channel,control])=>[channel,control.value]));
    groups=groupMaterialMaps(assets,aliases);
    const selectedGroup=group.value;
    group.replaceChildren(new Option('选择贴图组',''),...groups.map(entry=>new Option(entry.name,entry.key)));
    group.value=groups.some(entry=>entry.key===selectedGroup)?selectedGroup:'';
    groupRow.hidden=!groups.length;
    const entries=Object.entries(assets).sort((a,b)=>a[1].name.localeCompare(b[1].name,'zh-CN'));
    const previousPack=packedAsset.value;
    packedAsset.replaceChildren(new Option('选择打包贴图…',''),...entries.map(([id,asset])=>new Option(asset.name,id)));
    packedAsset.value=Object.hasOwn(assets,previousPack)?previousPack:'';
    for(const [channel,control] of Object.entries(selectors)){
      control.replaceChildren(new Option('无',''),...entries.map(([id,asset])=>new Option(asset.name,id)));
      delete control.dataset.alias;
      control.value=Object.hasOwn(assets,previous[channel])?previous[channel]:'';
    }
    const suggestions=imported.length?groupMaterialMaps({},imported):groups;
    if(!packedAsset.value&&!Object.values(previous).some(id=>Object.hasOwn(assets,id))&&suggestions.length===1){
      group.value=suggestions[0].key;selectGroup();
    }else sync();
  }
  file.onchange=async()=>{
    const files=[...file.files];file.value='';
    if(!files.length||pending)return;
    error.textContent='';pending=true;sync();
    try{
      const {uploaded,failures}=await upload(files,start,(count,total)=>{importButton.textContent='导入中 '+count+' / '+total;});
      if(read()?.id!==start.id)throw Error('工程已切换，请重新打开材质窗口');
      start=origin();assets=read().paint.assets;aliases.push(...uploaded);
      updateOptions(uploaded);
      if(failures.length)error.textContent='已导入 '+uploaded.length+' / '+files.length+' 张。'+failures.join('。');
    }catch(failure){error.textContent=failure.message;}
    finally{pending=false;importButton.textContent='导入 PNG…';sync();}
  };
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  form.onsubmit=async event=>{
    event.preventDefault();
    if(confirm.disabled)return;
    const maps=Object.fromEntries(Object.entries(selectors).map(([channel,control])=>[channel,control.value]));
    error.textContent='';pending=true;sync();
    try{
      const packed=packedFormat.value?{format:packedFormat.value,asset:packedAsset.value}:null;
      const graph=mappedLibraryMaterial(maps,assets,{alphaOutput:alpha.value,packed,normalFormat:normal.value});
      await save({name:name.value.trim(),graph},start);
      dialog.close();
    }catch(failure){error.textContent=failure.message;}
    finally{pending=false;sync();}
  };
  return {
    open(){
      if(dialog.open||document.querySelector('dialog[open]'))return false;
      const doc=read();
      if(!doc)return false;
      start=origin();assets=doc.paint.assets;aliases=[];group.value='';
      for(const control of Object.values(selectors))control.value='';
      suggested=name.value='贴图材质';error.textContent='';alpha.value='value';
      packedFormat.value=packedAsset.value='';normal.value='opengl';
      updateOptions();
      dialog.showModal();name.select();
      return true;
    },
    dispose(){dialog.remove();}
  };
}
