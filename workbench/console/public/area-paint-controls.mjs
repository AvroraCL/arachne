import {paintChannels} from './paint-channels.mjs';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
function button(label,action){const b=el('button','',label);b.type='button';b.onclick=action;return b;}
function choice(label,values,value,change){const s=el('select');s.setAttribute('aria-label',label);for(const [id,name] of values)s.append(new Option(name,id));s.value=value;s.onchange=()=>change(s.value);return s;}
export function surfaceControls(host,{drawing=false}={}){
  const elements={},bar=el('div','editor-toolbar'),dummy=el('div');
  const number=(id,label,value,min,max,step='any')=>{const l=el('label','',label),i=el('input');Object.assign(i,{type:'number',value,min,max,step});i.setAttribute('aria-label',label);elements[id]=i;i.dataset.brushSetting=id;l.append(i);bar.append(l);};
  const checkbox=(id,label,value)=>{const l=el('label','',label),i=el('input');i.type='checkbox';i.checked=value;elements[id]=i;i.dataset.brushSetting=id;l.append(i);bar.append(l);};
  number('brush-radius','半径',.14,.02,.65);
  number('brush-uv-radius','像素半径',32,2,256);
  if(drawing){
    number('brush-hardness','硬度',100,0,100);
    number('brush-opacity','不透明度',100,0,100);
    number('brush-flow','流量',100,1,100);
    number('brush-spacing','间距',18,5,200);
    for(const id of ['brush-hardness','brush-opacity','brush-flow','brush-spacing']){
      elements[id].dataset.brushPercent='';
      elements[id].dataset.scrubSuffix='%';
    }
    elements['brush-flow'].closest('label').title='单次笔尖盖印的浓度，重复经过时逐步加深';
    elements['brush-spacing'].closest('label').title='盖印间距，占笔尖直径的百分比';
  }else{
    number('brush-hardness','硬度',1,0,1);
    number('brush-opacity','强度',1,0,1);
  }
  checkbox('brush-uv-pressure','压感',true);checkbox('brush-mirror-enabled','镜像',false);
  for(const id of ['brush-erase',...paintChannels.map(k=>'brush-'+k)]){const i=el('input');i.type='checkbox';i.checked=!['brush-erase','brush-metallic','brush-roughness'].includes(id);elements[id]=i;}
  for(const id of ['brush-ink','fill-region','brush-preset']){const s=el('select');s.append(new Option('0','0'),new Option('1','1'));if(id==='fill-region')s.append(new Option('多边形','polygon'));if(id==='fill-region')s.value='polygon';elements[id]=s;}
  for(const id of ['surface-orbit','surface-paint','surface-mask','surface-fill','surface-sample','uv-eraser-tool','brush-mirror'])elements[id]=el('button');
  for(const id of ['surface-brush','surface-material','surface-mask-ink','surface-fill-region','surface-hint','brush-uv-size'])elements[id]=el('span');
  elements['brush-ink-color']=el('input');elements['brush-ink-color'].type='color';
  elements['live-uv']=el('canvas');elements['uv-brush-cursor']=el('span');
  for(const id of ['brush-cursor','mirror-cursor']){const cursor=el('span','brush-cursor');cursor.hidden=true;elements[id]=cursor;host.append(cursor);}
  elements['projector-gizmo']=el('div','area-projector-gizmo');for(const [tool,label] of [['move','移动'],['aim','方向'],['scale','缩放'],['rotate','旋转']]){const b=button(label,()=>{});b.dataset.projectTool=tool;elements['projector-gizmo'].append(b);}host.append(elements['projector-gizmo']);
  return {elements,bar,dummy};
}
export function selectionControls(elements,toolbar,stage){
  const svg=tag=>document.createElementNS('http://www.w3.org/2000/svg',tag),overlay=elements['uv-selection-overlay']=svg('svg');overlay.classList.add('area-selection-overlay');overlay.hidden=true;
  for(const [id,tag] of [['uv-selection-base','path'],['uv-selection-border','polygon'],['uv-lasso-border','path'],['uv-selection-handles','g']]){elements[id]=svg(tag);elements[id].classList.add(id);overlay.append(elements[id]);}stage.append(overlay);
  const options=elements['uv-transform-options']=el('form','editor-toolbar');options.hidden=true;
  for(const [key,label,min,max] of [['x','X',-8192,8192],['y','Y',-8192,8192],['sx','宽 %',5,800],['sy','高 %',5,800],['angle','旋转',-360,360]]){const l=el('label','',label),i=el('input');Object.assign(i,{type:'number',step:'any',min,max});i.dataset.transformField=key;i.setAttribute('aria-label',label);l.append(i);options.append(l);}
  for(const [id,label] of [['uv-flip-x','水平翻转'],['uv-flip-y','垂直翻转'],['uv-transform-cancel','取消']]){elements[id]=button(label,()=>{});options.append(elements[id]);}
  const copy=elements['uv-transform-copy']=el('input');copy.type='checkbox';const label=el('label','','保留原件');label.append(copy);options.append(label);const submit=button('应用',()=>{});submit.type='submit';options.append(submit);
  const selectOptions=elements['uv-selection-options']=el('div','editor-toolbar');selectOptions.hidden=true;
  for(const [id,label] of [['uv-selection-size','output'],['uv-transform-start','自由变换'],['uv-selection-fill-material','填充材质'],['uv-selection-fill-mask','填充蒙版'],['uv-selection-erase','清除内容'],['uv-selection-clear','取消选区']]){const e=id==='uv-selection-size'?el('output'):button(label,()=>{});elements[id]=e;selectOptions.append(e);}
  elements['uv-selection-mask-value']=choice('蒙版填充值',[['0','遮盖'],['1','恢复']],'0',()=>{});selectOptions.append(elements['uv-selection-mask-value']);toolbar.after(options,selectOptions);
  for(const [id,label] of [['uv-select-tool','选区'],['uv-lasso-tool','套索'],['uv-transform-tool','变换']]){elements[id]=button(label,()=>{});toolbar.append(elements[id]);}
}
