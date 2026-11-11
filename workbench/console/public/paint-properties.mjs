import {workspaceIcons} from './workspace-icons.mjs';

const el=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text)node.textContent=text;return node;};

export function propertyHeading(form,{name,type,icon='fillLayer',scope}){
  form.classList.add('property-inspector');
  const header=el('div','property-target'),symbol=el('span','property-target-icon');
  symbol.innerHTML=workspaceIcons[icon];
  const text=el('div','property-target-text');
  text.append(el('span','property-target-type','属性 · '+type),el('strong','property-target-name',name));
  header.append(symbol,text);
  if(scope){const badge=el('span','property-target-scope',scope);header.append(badge);}
  form.append(header);
}

// Collapse state belongs to each editor instance, never to the paint document.
export function propertySection(form,id,title,{open=true,hint}={}){
  const states=form.propertySections??={};
  const section=el('details','property-section'),summary=el('summary','property-section-title');
  section.dataset.propertySection=id;
  section.open=typeof states[id]==='boolean'?states[id]:open;
  summary.append(el('span','',title));
  if(hint)summary.append(el('small','property-section-hint',hint));
  const body=el('div','property-section-body');
  section.append(summary,body);
  section.addEventListener('toggle',()=>{
    if(!section.isConnected)return;
    states[id]=section.open;
    form.dispatchEvent(new Event('property-section-change'));
  });
  form.append(section);
  return body;
}

export function propertyChannelSwitch(control,name){
  control.classList.add('property-channel-switch');
  const input=control.querySelector('input');
  // Retain the command-bound checkbox and its accessible name.
  for(const node of [...control.childNodes])if(node!==input)node.remove();
  control.append(el('span','',name));
  return control;
}

export function propertyColorValue(control){
  control.classList.add('property-color-control');
  const caption=el('span','property-field-caption');
  for(const node of [...control.childNodes])if(node.nodeType===Node.TEXT_NODE)caption.append(node);
  control.prepend(caption);
  const input=control.querySelector('input'),value=el('output','property-color-value',input.value.toUpperCase());
  value.setAttribute('aria-hidden','true');
  input.addEventListener('input',()=>{value.textContent=input.value.toUpperCase();});
  control.append(value);
  return control;
}
