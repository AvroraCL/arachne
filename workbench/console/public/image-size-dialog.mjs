import {editingSide,resizedDocument} from './image-document-size.mjs';

export function editDocumentSize(action,doc,{canvas,signal}={}){
  const crop=action==='cropCanvas',resize=action==='resizeImage';
  const title={create:'新建贴图',resizeCanvas:'画布尺寸',cropCanvas:'裁切画布',resizeImage:'图像尺寸'}[action];
  const dialog=document.createElement('dialog'),form=document.createElement('form');
  dialog.className='image-size-dialog';dialog.setAttribute('aria-label',title);
  const heading=document.createElement('h3');heading.textContent=title;
  form.append(heading);dialog.append(form);
  const fields={};
  function number(key,text,value,min,max){
    const label=document.createElement('label'),input=document.createElement('input');
    Object.assign(input,{type:'number',required:true,value,min,max,step:1});
    label.append(text,input);form.append(label);fields[key]=input;return input;
  }
  const w=doc?.width??editingSide,h=doc?.height??editingSide;
  const width=number('width','宽度（像素）',w,1,crop?w:editingSide);
  const height=number('height','高度（像素）',h,1,crop?h:editingSide);
  let anchor=4;
  if(action==='resizeCanvas'){
    const grid=document.createElement('div');grid.className='image-anchor-grid';grid.setAttribute('role','group');grid.setAttribute('aria-label','保留位置');
    const names=['左上','上中','右上','左中','中心','右中','左下','下中','右下'];
    for(const [i,name] of names.entries()){
      const b=document.createElement('button');b.type='button';b.textContent=['↖','↑','↗','←','•','→','↙','↓','↘'][i];
      b.title=name;b.setAttribute('aria-label',name);b.setAttribute('aria-pressed',String(i===anchor));
      b.onclick=()=>{grid.children[anchor].setAttribute('aria-pressed','false');anchor=i;b.setAttribute('aria-pressed','true');};grid.append(b);
    }
    form.append(grid);
  }
  if(resize){
    const ratio=document.createElement('input'),label=document.createElement('label');ratio.type='checkbox';ratio.checked=true;
    label.append('锁定宽高比',ratio);form.append(label);
    width.oninput=()=>{if(ratio.checked&&width.valueAsNumber>0)height.value=Math.max(1,Math.round(width.valueAsNumber*h/w));};
    height.oninput=()=>{if(ratio.checked&&height.valueAsNumber>0)width.value=Math.max(1,Math.round(height.valueAsNumber*w/h));};
  }
  if(crop){
    number('left','左边距（像素）',0,0,w-1);number('top','上边距（像素）',0,0,h-1);
    const preview=document.createElement('div'),view=document.createElement('canvas'),box=document.createElement('div');
    preview.className='image-crop-preview';view.width=Math.max(1,Math.round(w*Math.min(1,768/w,440/h)));
    view.height=Math.max(1,Math.round(h*Math.min(1,768/w,440/h)));view.style.aspectRatio=w+'/'+h;
    view.getContext('2d').drawImage(canvas,0,0,view.width,view.height);
    preview.append(view,box);form.insertBefore(preview,width.parentNode);
    for(const edge of ['nw','n','ne','e','se','s','sw','w']){
      const handle=document.createElement('i');handle.dataset.edge=edge;box.append(handle);
    }
    function draw(){
      const {left,top}=fields;
      Object.assign(box.style,{left:100*left.valueAsNumber/w+'%',top:100*top.valueAsNumber/h+'%',
        width:100*width.valueAsNumber/w+'%',height:100*height.valueAsNumber/h+'%'});
    }
    for(const input of Object.values(fields))input.oninput=draw;
    function point(e){
      const rect=preview.getBoundingClientRect();
      return [Math.round(w*Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width))),
        Math.round(h*Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height)))];
    }
    let drag;
    preview.onpointerdown=e=>{
      if(e.button!==0)return;
      const [px,py]=point(e),edge=e.target.dataset.edge;
      const l=fields.left.valueAsNumber,t=fields.top.valueAsNumber;
      drag={edge,l:edge?l:px,t:edge?t:py,r:edge?l+width.valueAsNumber:px,b:edge?t+height.valueAsNumber:py};
      preview.setPointerCapture(e.pointerId);e.preventDefault();
    };
    preview.onpointermove=e=>{
      if(!drag)return;
      let {edge,l,t,r,b}=drag;const [px,py]=point(e);
      if(!edge){r=px;b=py;}else{
        if(edge.includes('w'))l=Math.min(px,r-1);
        if(edge.includes('e'))r=Math.max(l+1,px);
        if(edge.includes('n'))t=Math.min(py,b-1);
        if(edge.includes('s'))b=Math.max(t+1,py);
      }
      fields.left.value=Math.min(w-1,l,r);fields.top.value=Math.min(h-1,t,b);
      width.value=Math.max(1,Math.abs(r-l));height.value=Math.max(1,Math.abs(b-t));draw();
    };
    preview.onlostpointercapture=()=>{drag=null;};draw();
  }
  const error=document.createElement('output'),actions=document.createElement('footer');
  const cancel=document.createElement('button'),ok=document.createElement('button');
  cancel.type='button';cancel.textContent='取消';cancel.onclick=()=>dialog.close();
  ok.type='submit';ok.textContent=action==='create'?'创建':'应用';actions.append(cancel,ok);form.append(error,actions);
  return new Promise(resolve=>{
    let result;
    const close=()=>dialog.close();signal?.addEventListener('abort',close,{once:true});
    dialog.onclose=()=>{signal?.removeEventListener('abort',close);dialog.remove();resolve(result);};
    form.onsubmit=e=>{
      e.preventDefault();const patch=Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.valueAsNumber]));
      if(action==='resizeCanvas')patch.anchor=anchor;
      try{if(doc)resizedDocument(doc,action,patch);}catch(e){error.textContent=e.message;return;}
      result=patch;dialog.close();
    };
    document.body.append(dialog);dialog.showModal();width.select();
  });
}
