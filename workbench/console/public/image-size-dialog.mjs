import {fillWorkingSpaces} from './image-color-spaces.mjs';
import {displayColorCss,imageDisplaySpace,preferredDisplaySpace,setWorkingSwatch} from './image-display-rgb.mjs';
import {enhanceSelectMenu} from './paint-select.mjs';
import {editingSide,resizedDocument} from './image-document-size.mjs';

const presets=[
  ['4K 方形',editingSide,editingSide],['2K 方形',2048,2048],['1K 方形',1024,1024],
  ['全高清',1920,1080],['横幅',2048,512],['手机屏幕',1170,2532]
];

function aspectLabel(w,h){
  let a=w,b=h;
  while(b){const remainder=a%b;a=b;b=remainder;}
  return w/a+' : '+h/a;
}

function newImageSettings(form,width,height,defaultName){
  const layout=document.createElement('div');
  layout.className='new-image-layout';
  layout.innerHTML=`
    <section class="new-image-presets" aria-label="画布预设">
      <h4>画布预设</h4><div class="new-image-grid"></div>
    </section>
    <section class="new-image-preview" aria-label="画布预览">
      <div class="new-image-preview-title"><strong></strong><span></span></div>
      <div class="new-image-preview-stage"><div class="new-image-paper" aria-hidden="true"><i></i><b></b></div></div>
      <div class="new-image-caption"><span>画布预览</span><output></output></div>
    </section>
    <section class="new-image-details" aria-label="图像设置">
      <h4>图像设置</h4>
      <label>名称<input type="text" required maxlength="100" autocomplete="off"></label>
      <div class="new-image-size"></div>
      <div role="group" aria-label="方向" class="new-image-orientation">
        <span>方向</span><button type="button">横向</button><button type="button">纵向</button>
      </div>
      <label>颜色空间<select class="working-color-space"></select></label>
      <p class="new-image-profile-note"></p>
      <label>背景内容<select class="new-image-background"><option value="">透明</option><option value="#ffffff">白色</option><option value="#000000">黑色</option><option value="custom">自定颜色</option></select></label>
      <label class="new-image-color" hidden>背景颜色<input type="color" value="#808080"></label>
    </section>`;
  layout.querySelector('.new-image-size').append(width.parentElement,height.parentElement);
  form.append(layout);
  const name=layout.querySelector('input[type=text]'),space=layout.querySelector('select');
  fillWorkingSpaces(space);
  const background=layout.querySelector('.new-image-background'),color=layout.querySelector('input[type=color]');
  const profileNote=layout.querySelector('.new-image-profile-note');
  const paper=layout.querySelector('.new-image-paper'),preview=layout.querySelector('.new-image-preview');
  const readColor=()=>background.value==='custom'?color.value:background.value;
  name.value=defaultName;
  name.oninput=()=>name.setCustomValidity(name.value.trim()?'':'请输入图像名称');
  const grid=layout.querySelector('.new-image-grid');
  const orientations=layout.querySelectorAll('.new-image-orientation button');
  function sync(){
    const w=width.valueAsNumber,h=height.valueAsNumber;
    const valid=width.validity.valid&&height.validity.valid;
    const preset=presets.find(([,pw,ph])=>(pw===w&&ph===h)||(pw===h&&ph===w));
    presets.forEach((entry,i)=>grid.children[i].setAttribute('aria-pressed',String(entry===preset)));
    preview.querySelector('strong').textContent=preset?.[0]??'自定尺寸';
    paper.hidden=!valid;
    preview.querySelector('output').textContent=valid?w+' × '+h+' px':'宽高须为 1 至 '+editingSide+' 像素';
    preview.querySelector('.new-image-preview-title span').textContent=valid?aspectLabel(w,h):'';
    if(valid){
      paper.style.setProperty('--paper-w',String(w/h));
      paper.style.setProperty('--paper-h',String(h/w));
      paper.querySelector('i').textContent=w+' px';
      paper.querySelector('b').textContent=h+' px';
    }
    const hex=readColor(),profiled=!['linear','srgb'].includes(space.value);
    const usage={
      'gray-g22':'单通道灰度和透明度，使用 Gamma 2.2 曲线。',
      'gray-linear':'按线性光混合，保留灰度和透明度。',
      'acescg':'使用 AP1 线性 RGB，PNG 保存 0–1 范围的 8 位颜色。',
      'aces2065-1':'使用 AP0 线性 RGB，PNG 保存 0–1 范围的 8 位颜色。',
      'linear-srgb':'按线性光处理颜色，预览会校正亮度。',
      'rec709':'使用 Rec.709 摄像传递曲线。',
      'rec2020':'使用 Rec.2020 摄像传递曲线。',
      'rec2020-g24':'使用 Rec.2020 原色和 2.4 显示伽马。',
      'dci-p3':'使用影院 P3 白点和 2.6 伽马。'
    };
    const displaySpace=imageDisplaySpace(space.value,preferredDisplaySpace());
    profileNote.textContent=profiled?(usage[space.value]||('画布按 '+(displaySpace==='display-p3'?'Display P3':'sRGB')+' 预览。'))+' PNG 嵌入此 ICC 配置。'
      :space.value==='linear'?'保留通道数值，适用于粗糙度、法线和蒙版。':'适用于网页图像和常规彩色贴图。';
    setWorkingSwatch(color,space.value);
    paper.style.background=hex?displayColorCss(hex,space.value):'';
    color.parentElement.hidden=background.value!=='custom';
    orientations.forEach((button,i)=>{
      button.disabled=!width.validity.valid||!height.validity.valid||w===h;
      button.setAttribute('aria-pressed',String(i===0?w>h:h>w));
    });
  }
  function setSize(w,h){width.value=w;height.value=h;sync();}
  for(const [label,w,h] of presets){
    const button=document.createElement('button');
    button.type='button';button.className='new-image-preset';
    const outline=document.createElement('i'),title=document.createElement('strong'),size=document.createElement('small');
    outline.setAttribute('aria-hidden','true');
    outline.style.aspectRatio=w+' / '+h;
    outline.style.width=Math.round(27*Math.min(1,w/h))+'px';
    title.textContent=label;size.textContent=w+' × '+h;
    button.append(outline,title,size);grid.append(button);
    button.onclick=()=>setSize(w,h);
  }
  orientations.forEach((button,i)=>button.onclick=()=>{
    const w=width.valueAsNumber,h=height.valueAsNumber;
    setSize(i===0?Math.max(w,h):Math.min(w,h),i===0?Math.min(w,h):Math.max(w,h));
  });
  space.onchange=background.onchange=color.oninput=width.oninput=height.oninput=sync;sync();
  return {name,space,readColor};
}

export function editDocumentSize(action,doc,{canvas,signal,defaultName}={}){
  const crop=action==='cropCanvas',resize=action==='resizeImage';
  const title={create:'新建图像',resizeCanvas:'画布尺寸',cropCanvas:'裁切画布',resizeImage:'图像尺寸'}[action];
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
  const creation=action==='create'?newImageSettings(form,width,height,defaultName??'未命名图像'):null;
  if(creation)dialog.classList.add('new-image-dialog');
  let anchor=4;
  if(action==='resizeCanvas'){
    const grid=document.createElement('div');grid.className='image-anchor-grid';grid.setAttribute('role','group');grid.setAttribute('aria-label','保留位置');
    const names=['左上','上中','右上','左中','中心','右中','左下','下中','右下'];
    for(const [i,name] of names.entries()){
      const b=document.createElement('button');b.type='button';b.textContent=['↖','↑','↗','←','•','→','↙','↓','↘'][i];
      b.title=name;b.setAttribute('aria-label',name);b.setAttribute('aria-pressed',String(i===anchor));
      b.onclick=()=>{grid.children[anchor].setAttribute('aria-pressed','false');anchor=i;b.setAttribute('aria-pressed','true');};grid.append(b);
    }
    const row=document.createElement('div'),caption=document.createElement('span');
    row.className='image-anchor-row';caption.textContent='保留位置';row.append(caption,grid);form.append(row);
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
    view.getContext('2d',{colorSpace:preferredDisplaySpace()}).drawImage(canvas,0,0,view.width,view.height);
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
  ok.type='submit';ok.className='primary';ok.textContent=action==='create'?'创建':'应用';actions.append(cancel,ok);form.append(error,actions);
  return new Promise(resolve=>{
    let result;
    const close=()=>dialog.close();signal?.addEventListener('abort',close,{once:true});
    dialog.onclose=()=>{signal?.removeEventListener('abort',close);dialog.remove();resolve(result);};
    form.onsubmit=e=>{
      e.preventDefault();const patch=Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.valueAsNumber]));
      if(creation){patch.name=creation.name.value.trim();patch.colorSpace=creation.space.value;patch.background=creation.readColor();}
      if(action==='resizeCanvas')patch.anchor=anchor;
      try{if(doc)resizedDocument(doc,action,patch);}catch(e){error.textContent=e.message;return;}
      result=patch;dialog.close();
    };
    document.body.append(dialog);
    if(creation)for(const select of dialog.querySelectorAll('select'))enhanceSelectMenu(select,{menuClass:select.matches('.working-color-space')?'image-profile-menu':''});
    dialog.showModal();const first=creation?.name??width;first.focus();first.select();
  });
}
