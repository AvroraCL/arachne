import {workspaceIcons} from './workspace-icons.mjs';

const el=(tag,cls)=>{const node=document.createElement(tag);if(cls)node.className=cls;return node;};

// The frame owns per-area navigation; the registered panels own their data.
export function createPropertyEditorFrame({host,searchHost,state={},areaId,onChange,categories}){
  const root=el('div','property-editor'),rail=el('div','property-editor-rail'),main=el('div','property-editor-main');
  rail.setAttribute('role','tablist');rail.setAttribute('aria-label','属性类别');rail.setAttribute('aria-orientation','vertical');
  const heading=el('div','property-editor-heading'),context=el('div','property-editor-context');
  const contextIcon=el('span','property-editor-context-icon');contextIcon.innerHTML=workspaceIcons.object;
  const contextType=el('span','property-editor-context-type');contextType.textContent='场景';
  const contextName=el('span','property-editor-context-name'),pin=el('button','property-editor-pin');
  pin.type='button';pin.innerHTML=workspaceIcons.pin;pin.setAttribute('aria-label','固定当前属性');pin.setAttribute('aria-pressed','false');pin.title='固定当前属性';
  context.append(contextIcon,contextType,contextName,pin);
  const searchWrap=el('label','property-editor-search'),searchIcon=el('span','property-editor-search-icon'),search=el('input');
  searchIcon.innerHTML=workspaceIcons.search;search.type='search';search.placeholder='搜索当前属性';search.setAttribute('aria-label','搜索当前属性');
  searchWrap.append(searchIcon,search);heading.append(context);(searchHost||heading).append(searchWrap);
  const scroll=el('div','property-editor-scroll editor-scroll'),panels=new Map(),tabs=new Map();
  const empty=el('p','property-editor-empty');empty.textContent='没有匹配的设置';empty.hidden=true;
  const footer=el('div','property-editor-footer');scroll.append(empty,footer);main.append(heading,scroll);root.append(rail,main);host.append(root);
  let active=categories.some(item=>item.key===state.category)?state.category:categories[0].key,contextIconMarkup=workspaceIcons.object;
  let categoryChanged=()=>{},pinChanged=()=>{};pin.addEventListener('click',()=>pinChanged());
  for(const item of categories){
    const tab=el('button','property-editor-tab'),panel=el('div','property-editor-panel');
    tab.type='button';tab.setAttribute('role','tab');tab.setAttribute('aria-label',item.label);tab.title=item.label;tab.innerHTML=item.icon;
    tab.id=`property-tab-${areaId}-${item.key}`;panel.id=`property-panel-${areaId}-${item.key}`;
    tab.setAttribute('aria-controls',panel.id);panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);
    tab.addEventListener('click',()=>select(item.key));rail.append(tab);scroll.insertBefore(panel,empty);tabs.set(item.key,tab);panels.set(item.key,panel);
  }
  function select(key,{persist=true,focus=false}={}){
    if(!panels.has(key))return;const changed=active!==key;active=key;
    for(const [id,tab] of tabs){const selected=id===key;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;panels.get(id).hidden=!selected;}
    if(focus)tabs.get(key).focus();if(changed){scroll.scrollTop=0;categoryChanged(key);if(persist)onChange();}
  }
  rail.addEventListener('keydown',event=>{
    if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault();const keys=[...tabs.keys()],index=keys.indexOf(active);
    const next=event.key==='Home'?0:event.key==='End'?keys.length-1:(index+(event.key==='ArrowUp'?-1:1)+keys.length)%keys.length;
    select(keys[next],{focus:true});
  });
  select(active,{persist:false});
  return {root,search,empty,footer,panel:key=>panels.get(key),select,get category(){return active;},
    onCategoryChange:fn=>{categoryChanged=fn;},onPinChange:fn=>{pinChanged=fn;},
    setPin:({pinned=false,available=true}={})=>{pin.disabled=!available&&!pinned;const pressed=String(pinned),label=pinned?'取消固定属性':'固定当前属性',hint=pinned?'取消固定，继续跟随选择':'固定当前属性';if(pin.getAttribute('aria-pressed')!==pressed)pin.setAttribute('aria-pressed',pressed);if(pin.getAttribute('aria-label')!==label)pin.setAttribute('aria-label',label);if(pin.title!==hint)pin.title=hint;},
    setContext:({type='场景',name='',icon=workspaceIcons.object}={})=>{
      if(contextType.textContent!==type)contextType.textContent=type;const label=name||'未打开工程';if(contextName.textContent!==label)contextName.textContent=label;if(contextName.title!==name)contextName.title=name;
      if(contextIconMarkup!==icon){contextIcon.innerHTML=icon;contextIconMarkup=icon;}
    },
    getState:()=>({category:active})};
}
