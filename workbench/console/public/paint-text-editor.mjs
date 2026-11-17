import {setSelectValue} from './paint-select.mjs';
import {textFonts,textDefaults,textEffects,textPreviewStyle,loadProjectFont} from './image-text-style.mjs';
import {compositionKey} from './text-input.mjs';

const defaults={...textDefaults,align:'center'};

export function createPaintTextEditor(save,{readFonts,importFont}){
  const dialog=document.getElementById('paint-text-dialog'),form=dialog.querySelector('form');
  const title=dialog.querySelector('h2'),preview=dialog.querySelector('.paint-text-sample');
  const close=dialog.querySelector('[data-close-text]'),apply=dialog.querySelector('[type=submit]');
  const error=dialog.querySelector('[role=alert]'),content=dialog.querySelector('fieldset');
  const fields=Object.fromEntries(['content','fontSize','weight','align','color','font','tracking','leading','boxWidth','boxHeight'].map(name=>[name,form.elements[name]]));
  const fontFile=form.elements.fontFile;
  const effectsHost=dialog.querySelector('.paint-text-effects'),effectControls={};
  for(const [id,{label,fields:spec}] of Object.entries(textEffects)){
    const section=document.createElement('details'),summary=document.createElement('summary'),toggle=document.createElement('input'),parameters=document.createElement('div');
    summary.textContent=label;toggle.type='checkbox';toggle.setAttribute('aria-label','启用'+label);
    summary.prepend(toggle);toggle.onclick=event=>event.stopPropagation();
    toggle.onchange=()=>{section.open=toggle.checked;};
    section.append(summary,parameters);parameters.className='paint-text-fields';effectsHost.append(section);
    const values={};
    for(const [key,{label,value,min,max}] of Object.entries(spec)){
      const row=document.createElement('label'),input=document.createElement('input');
      row.textContent=label;
      Object.assign(input,typeof value==='string'?{type:'color'}:{type:'number',min,max,step:1,required:true});
      input.setAttribute('aria-label',label);
      input.value=value;row.append(input);parameters.append(row);values[key]=input;
    }
    effectControls[id]={toggle,values,section};
  }
  let context=null,saving=false,fontReady=false,loadingFont=false;
  let fontRequest=0;

  function populateWeights(id,requested){
    const weights=textFonts[id]?.weights??readFonts()[id]?.weights??[[400,'常规'],[700,'粗体']];
    const selected=weights.some(([value])=>value===requested)?requested:(readFonts()[id]?.weight??400);
    fields.weight.replaceChildren(...weights.map(([value,label])=>new Option(label+' · '+value,value)));
    setSelectValue(fields.weight,String(selected));
  }
  function populateFonts(id,weight){
    const items=Object.entries(textFonts).map(([value,{label}])=>new Option(label,value));
    for(const [value,{family,style}] of Object.entries(readFonts()).sort((a,b)=>a[1].family.localeCompare(b[1].family)))
      items.push(new Option(family+' · '+style,value));
    if(!items.some(item=>item.value===id))items.push(new Option('缺少工程字体',id));
    fields.font.replaceChildren(...items);
    setSelectValue(fields.font,id);
    populateWeights(id,weight);
  }
  async function prepareFont(){
    const id=fields.font.value,entry=readFonts()[id],request=++fontRequest;
    fontReady=false;apply.disabled=true;preview.textContent='';
    try{
      await loadProjectFont(context.projectId,id,entry);
      if(request!==fontRequest)return;
      fontReady=true;draw();
    }catch(cause){
      if(request===fontRequest){error.textContent=cause.message;preview.textContent='';}
    }finally{
      if(request===fontRequest)apply.disabled=saving||loadingFont||!fontReady;
    }
  }
  fontFile.onchange=async()=>{
    const [file]=fontFile.files;
    if(!file||!context||loadingFont)return;
    loadingFont=true;content.disabled=apply.disabled=close.disabled=true;
    error.textContent='';
    try{
      const result=await importFont(context,file);
      context.revision=result.document.revision;
      populateFonts(result.id,readFonts()[result.id].weight);
      await prepareFont();
    }catch(cause){error.textContent=cause.message;}
    finally{
      loadingFont=false;content.disabled=close.disabled=false;
      apply.disabled=!fontReady;fontFile.value='';
    }
  };

  function read(){
    const effects=Object.fromEntries(Object.entries(effectControls).filter(([,item])=>item.toggle.checked)
      .map(([id,{values}])=>[id,Object.fromEntries(Object.entries(values)
        .map(([key,input])=>[key,input.type==='number'?input.valueAsNumber:input.value]))]));
    const {boxWidth,boxHeight}=fields;
    return {content:fields.content.value,fontSize:fields.fontSize.valueAsNumber,weight:Number(fields.weight.value),
      align:fields.align.value,color:fields.color.value,font:fields.font.value,tracking:fields.tracking.valueAsNumber,
      leading:fields.leading.valueAsNumber,...(boxWidth.value?{box:{width:boxWidth.valueAsNumber,height:boxHeight.valueAsNumber||fields.fontSize.valueAsNumber}}:{}),
      ...(Object.keys(effects).length?{effects}:{})};
  }
  function draw(){
    const style=read(),scale=Math.min(.25,44/(style.fontSize||128));
    preview.textContent=fontReady?(style.content||'Aa 071'):'';
    Object.assign(preview.style,textPreviewStyle(style,scale,readFonts()),{width:style.box?Math.max(1,style.box.width*scale)+'px':'',
      minHeight:style.box?Math.min(140,style.box.height*scale)+'px':''});
    for(const {toggle,values} of Object.values(effectControls))for(const input of Object.values(values))input.disabled=!toggle.checked;
  }
  fields.content.addEventListener('keydown',event=>{
    if(!compositionKey(event)&&event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();form.requestSubmit();}
  });

  close.onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(saving||loadingFont)event.preventDefault();});
  dialog.addEventListener('close',()=>{if(!dialog.open){context=null;fontRequest++;}});
  form.oninput=event=>{if(event.target!==fontFile){if(fontReady)error.textContent='';draw();}};
  form.onchange=event=>{
    if(event.target!==fields.font)return;
    error.textContent='';
    populateWeights(fields.font.value,Number(fields.weight.value));
    void prepareFont();
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    if(!context||saving||loadingFont||!fontReady)return;
    saving=true;
    close.disabled=apply.disabled=content.disabled=true;
    apply.textContent='生成中…';
    error.textContent='';
    try{
      if(await save(context,read(),error))dialog.close();
      else if(!error.textContent)error.textContent='请结束当前编辑后再应用文字';
    }catch(cause){
      error.textContent=cause.message;
    }finally{
      saving=false;
      close.disabled=apply.disabled=content.disabled=false;
      apply.textContent='应用';
    }
  };

  return {
    get isOpen(){return dialog.open;},
    open(target,layer=null){
      if(dialog.open)return;
      context=target;
      const style={...defaults,color:target.color||defaults.color,...layer?.text};
      style.boxWidth=style.box?.width??'';style.boxHeight=style.box?.height??'';
      for(const [id,{toggle,values,section}] of Object.entries(effectControls)){
        toggle.checked=!!style.effects?.[id];section.open=toggle.checked;
        for(const [key,input] of Object.entries(values))input.value=style.effects?.[id]?.[key]??textEffects[id].fields[key].value;
      }
      populateFonts(style.font,style.weight);
      for(const [name,field] of Object.entries(fields)){
        if(name==='font'||name==='weight')continue;
        if(field.tagName==='SELECT')setSelectValue(field,String(style[name]));
        else field.value=style[name];
      }
      title.textContent=layer?'编辑文字':'添加文字';
      error.textContent='';
      dialog.showModal();
      draw();
      void prepareFont();
      fields.content.focus();
      if(layer)fields.content.select();
    }
  };
}
