import {setSelectValue} from './paint-select.mjs';

const defaults={content:'',fontSize:128,weight:700,align:'center',color:'#e6e3d7'};

export function createPaintTextEditor(save){
  const dialog=document.getElementById('paint-text-dialog'),form=dialog.querySelector('form');
  const title=dialog.querySelector('h2'),preview=dialog.querySelector('.paint-text-sample');
  const close=dialog.querySelector('[data-close-text]'),apply=dialog.querySelector('[type=submit]');
  const error=dialog.querySelector('[role=alert]'),content=dialog.querySelector('fieldset');
  const fields=Object.fromEntries(['content','fontSize','weight','align','color'].map(name=>[name,form.elements[name]]));
  let context=null,saving=false;

  function read(){
    return {content:fields.content.value,fontSize:fields.fontSize.valueAsNumber,weight:Number(fields.weight.value),
      align:fields.align.value,color:fields.color.value};
  }
  function draw(){
    const style=read();
    preview.textContent=style.content||'Aa 071';
    Object.assign(preview.style,{color:style.color,fontSize:Math.max(12,Math.min(44,(style.fontSize||128)/4))+'px',
      fontWeight:style.weight,textAlign:style.align});
  }

  close.onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  dialog.addEventListener('close',()=>{if(!dialog.open)context=null;});
  form.oninput=form.onchange=()=>{error.textContent='';draw();};
  form.onsubmit=async event=>{
    event.preventDefault();
    if(!context||saving)return;
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
      const style=layer?.text||{...defaults,color:target.color||defaults.color};
      for(const [name,field] of Object.entries(fields)){
        if(field.tagName==='SELECT')setSelectValue(field,String(style[name]));
        else field.value=style[name];
      }
      title.textContent=layer?'编辑文字':'添加文字';
      error.textContent='';
      draw();
      dialog.showModal();
      fields.content.focus();
      if(layer)fields.content.select();
    }
  };
}
