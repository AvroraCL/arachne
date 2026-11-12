import {grayColor,normalizePaintHex,paintHsv,paintHex} from './paint-colors.mjs';

const paletteKey='arachne-recent-colors-v1',maxRecent=10;
const clamp=n=>Math.min(1,Math.max(0,n));
const el=(tag,cls='',text='')=>Object.assign(document.createElement(tag),{className:cls,textContent:text});

export function setupPaintColorPicker(root=document){
  let active=null,recent=[];
  try{
    const entries=JSON.parse(localStorage.getItem(paletteKey));
    if(Array.isArray(entries))recent=[...new Set(entries.map(normalizePaintHex).filter(Boolean))].slice(0,maxRecent);
  }catch{}
  const popover=el('div','paint-color-picker');
  if(typeof popover.showPopover!=='function')return;
  popover.popover='auto';popover.setAttribute('role','dialog');
  const header=el('div','paint-color-heading'),title=el('strong'),sample=el('span','paint-color-sample');
  sample.setAttribute('aria-hidden','true');header.append(title,sample);
  const field=el('div','paint-color-sv'),marker=el('span','paint-color-marker');
  field.tabIndex=0;field.setAttribute('aria-label','饱和度和明度，方向键调节');field.setAttribute('role','group');
  marker.setAttribute('aria-hidden','true');field.append(marker);
  const hue=el('input','paint-color-hue'),brightness=el('input','paint-color-brightness');
  for(const [slider,label,maximum] of [[hue,'色相',360],[brightness,'灰度',255]]){
    slider.type='range';slider.min='0';slider.max=String(maximum);slider.step='1';
    slider.setAttribute('data-native-range','');slider.setAttribute('aria-label',label);
  }
  const textRow=el('label','paint-color-text','HEX'),hex=el('input');
  hex.type='text';hex.maxLength=7;hex.autocomplete='off';hex.spellcheck=false;hex.setAttribute('aria-label','HEX 颜色');
  textRow.append(hex);
  const swatches=el('div','paint-color-recent');
  swatches.setAttribute('aria-label','最近颜色');swatches.setAttribute('role','group');
  const footer=el('div','paint-color-footer'),error=el('span','paint-color-error');
  error.setAttribute('role','status');
  const cancel=el('button','','取消'),apply=el('button','primary','确定');
  cancel.type=apply.type='button';
  footer.append(error,cancel,apply);
  popover.append(header,field,hue,brightness,textRow,swatches,footer);

  function position(){
    if(!active)return;
    const anchor=active.input.getBoundingClientRect(),box=popover.getBoundingClientRect(),gap=7;
    if(!active.input.isConnected||!anchor.width||!anchor.height){dismiss(false);return;}
    const left=anchor.left+anchor.width/2-box.width/2;
    const top=anchor.bottom+gap+box.height<=innerHeight?anchor.bottom+gap:anchor.top-gap-box.height;
    popover.style.left=Math.max(gap,Math.min(left,innerWidth-box.width-gap))+'px';
    popover.style.top=Math.max(gap,Math.min(top,innerHeight-box.height-gap))+'px';
  }
  function dismissed(state,focus){
    if(active!==state)return;
    active=null;state.events.abort();state.observer.disconnect();
    state.input.removeAttribute('data-color-open');
    popover.remove();
    if(focus&&state.input.isConnected&&!state.input.disabled)state.input.focus({preventScroll:true});
  }
  function dismiss(focus=true){
    const state=active;
    if(!state)return;
    if(popover.matches(':popover-open'))popover.hidePopover();
    dismissed(state,focus);
  }
  popover.addEventListener('toggle',event=>{
    if(event.newState==='closed'&&!popover.matches(':popover-open')&&active)dismissed(active,false);
  });
  function render(updateText=true){
    if(!active)return;
    const {h,s,v}=active.color,chosen=paintHex(active.color);
    if(updateText)hex.value=chosen;
    field.style.setProperty('--picker-hue',String(h));
    marker.style.left=s*100+'%';marker.style.top=(1-v)*100+'%';
    marker.style.background=chosen;sample.style.background=chosen;
    field.setAttribute('aria-description',`饱和度 ${Math.round(s*100)}%，明度 ${Math.round(v*100)}%`);
    hue.value=String(Math.round(h));brightness.value=String(Math.round(v*255));
    apply.disabled=active.input.disabled;
    hex.removeAttribute('aria-invalid');error.textContent='';
  }
  function editHex(value,updateText){
    const parsed=normalizePaintHex(value);
    if(!active||!parsed)return false;
    active.color=paintHsv(active.gray?grayColor(parsed):parsed);
    render(updateText);return true;
  }
  function recentButtons(){
    swatches.replaceChildren(...recent.filter(color=>!active.gray||grayColor(color)===color).map(color=>{
      const button=el('button','paint-color-swatch');
      button.type='button';button.style.background=color;button.title=color.toUpperCase();
      button.setAttribute('aria-label','使用 '+color.toUpperCase());
      button.onclick=()=>editHex(color,true);
      return button;
    }));
    swatches.hidden=!swatches.childElementCount;
  }
  function open(input){
    dismiss(false);
    if(input.disabled||!input.isConnected)return;
    const gray=input.hasAttribute('data-color-gray'),color=normalizePaintHex(input.value)||'#000000';
    const events=new AbortController();
    const observer=new MutationObserver(()=>{if(input.disabled||!input.isConnected)dismiss(false);});
    active={input,gray,color:paintHsv(gray?grayColor(color):color),events,observer,pointer:null};
    input.setAttribute('data-color-open','');
    title.textContent=input.getAttribute('aria-label')||input.title||'颜色';
    popover.setAttribute('aria-label',title.textContent+'选色');
    field.hidden=hue.hidden=gray;brightness.hidden=!gray;
    (input.closest('dialog[open]')||document.body).append(popover);
    recentButtons();render();popover.showPopover();
    position();hex.focus({preventScroll:true});hex.select();
    window.addEventListener('resize',position,{signal:events.signal});
    window.addEventListener('scroll',position,{capture:true,signal:events.signal});
    observer.observe(input,{attributes:true,attributeFilter:['disabled']});
    observer.observe(document.body,{childList:true,subtree:true});
  }
  function commit(){
    if(!active)return;
    if(!editHex(hex.value,true)){
      hex.setAttribute('aria-invalid','true');error.textContent='请输入有效的 HEX 颜色。';
      hex.focus();return;
    }
    const {input}=active,value=paintHex(active.color);
    if(input.disabled||!input.isConnected){dismiss(false);return;}
    dismiss(true);
    recent=[value,...recent.filter(color=>color!==value)].slice(0,maxRecent);
    try{localStorage.setItem(paletteKey,JSON.stringify(recent));}catch{}
    if(input.value===value)return;
    input.value=value;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function adjust(event){
    const {left,top,width,height}=field.getBoundingClientRect();
    active.color.s=clamp((event.clientX-left)/width);
    active.color.v=1-clamp((event.clientY-top)/height);
    render();
  }
  field.addEventListener('pointerdown',event=>{
    if(!active||event.button!==0||active.pointer!==null)return;
    active.pointer=event.pointerId;field.setPointerCapture(event.pointerId);
    field.focus({preventScroll:true});adjust(event);event.preventDefault();
  });
  field.addEventListener('pointermove',event=>{if(active?.pointer===event.pointerId)adjust(event);});
  for(const eventName of ['pointerup','pointercancel','lostpointercapture'])field.addEventListener(eventName,event=>{
    if(active?.pointer!==event.pointerId)return;
    if(event.type==='pointerup')adjust(event);
    active.pointer=null;
  });
  field.addEventListener('keydown',event=>{
    if(!active)return;
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowDown:[0,-1],ArrowUp:[0,1]}[event.key];
    if(!delta)return;
    const step=event.shiftKey?.002:.01;
    active.color.s=clamp(active.color.s+step*delta[0]);active.color.v=clamp(active.color.v+step*delta[1]);
    render();event.preventDefault();event.stopPropagation();
  });
  hue.oninput=()=>{if(active){active.color.h=Number(hue.value);render();}};
  brightness.oninput=()=>{if(active){active.color.v=Number(brightness.value)/255;render();}};
  hex.oninput=()=>{if(!editHex(hex.value,false)){hex.setAttribute('aria-invalid','true');error.textContent='';}};
  cancel.onclick=()=>dismiss();
  apply.onclick=commit;
  popover.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();}
    if(event.key==='Enter'&&event.target===hex){event.preventDefault();event.stopPropagation();commit();}
  });
  root.addEventListener('click',event=>{
    const input=event.target;
    if(!input.matches?.('input[type=color]:not([data-native-color])')||input.disabled)return;
    event.preventDefault();
    if(active?.input===input)dismiss();else open(input);
  },true);
}
