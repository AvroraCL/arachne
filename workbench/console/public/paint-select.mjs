// Custom select, with the existing select as the source of value and events.
const controls=new WeakMap();
let active=null,sequence=0;

function closeMenu(restoreFocus=false){
  if(!active)return;
  const {wrapper,button,menu,events,observer}=active;
  active=null;
  events.abort();observer.disconnect();menu.remove();
  wrapper.classList.remove('open');
  button.setAttribute('aria-expanded','false');
  button.removeAttribute('aria-controls');
  if(restoreFocus&&button.isConnected)button.focus({preventScroll:true});
}

function positionMenu(wrapper,menu,contentWidth){
  const rect=wrapper.getBoundingClientRect(),style=getComputedStyle(menu),gap=parseFloat(style.getPropertyValue('--select-menu-gap'))||6;
  if(!rect.width||!rect.height){closeMenu();return;}
  const width=Math.min(innerWidth-gap*2,Math.max(rect.width,parseFloat(style.getPropertyValue('--select-menu-width'))||contentWidth));
  const below=innerHeight-rect.bottom-gap,above=rect.top-gap;
  menu.style.width=Math.round(width)+'px';
  const height=Math.min(menu.scrollHeight+2,260);
  const opensAbove=below<Math.min(height,160)&&above>below;
  const room=Math.max(0,Math.min(260,(opensAbove?above:below)-gap));
  menu.style.maxHeight=Math.floor(room)+'px';
  const anchor=style.getPropertyValue('--select-menu-align').trim()==='right'?rect.right-width:rect.left;
  menu.style.left=Math.round(Math.max(gap,Math.min(anchor,innerWidth-gap-width)))+'px';
  menu.style.top=Math.round(opensAbove?rect.top-gap-Math.min(height,room):rect.bottom+gap)+'px';
}

function openMenu(select,wrapper,button){
  if(select.disabled||!select.options.length)return;
  closeMenu();
  const menu=document.createElement('div');
  menu.id='paint-select-menu-'+(++sequence);
  menu.className='custom-select-menu';
  const {menuClass,optionIcon}=controls.get(select);
  if(menuClass)menu.classList.add(menuClass);
  menu.setAttribute('role','listbox');
  menu.setAttribute('aria-label',button.getAttribute('aria-label'));
  menu.tabIndex=-1;
  const items=[],events=new AbortController(),{signal}=events;
  let focused=null,search=null,typeahead='',typedAt=0;
  const searchable=select.dataset.searchable!=='false'&&(select.options.length>8||select.dataset.searchable==='true');
  if(searchable){
    search=document.createElement('input');search.type='search';search.className='custom-select-search';
    search.placeholder='搜索…';search.setAttribute('aria-label','搜索'+button.getAttribute('aria-label'));
    menu.append(search);
  }
  const empty=document.createElement('p');empty.className='custom-select-empty';empty.textContent='没有匹配的选项';empty.hidden=true;
  function enabled(){return items.filter(item=>!item.hidden&&!item.disabled);}
  function focus(item,{scroll=true}={}){
    focused=item||null;
    for(const option of items)option.classList.toggle('active',option===focused);
    if(focused){
      menu.setAttribute('aria-activedescendant',focused.id);
      search?.setAttribute('aria-activedescendant',focused.id);
      if(scroll){
        const top=focused.offsetTop,bottom=top+focused.offsetHeight,head=search?search.offsetHeight+10:5;
        if(top<menu.scrollTop+head)menu.scrollTop=top-head;
        else if(bottom>menu.scrollTop+menu.clientHeight-5)menu.scrollTop=bottom-menu.clientHeight+5;
      }
    }else{menu.removeAttribute('aria-activedescendant');search?.removeAttribute('aria-activedescendant');}
  }
  const groups=new Map();
  for(const [index,option] of Array.from(select.options).entries()){
    if(option.hidden)continue;
    const item=document.createElement('button');
    item.id=menu.id+'-option-'+index;item.type='button';item.tabIndex=-1;
    item.className='custom-select-option';item.textContent=option.label;item.title=option.label;
    item.setAttribute('aria-label',option.label);
    if(optionIcon){const icon=document.createElement('span'),label=document.createElement('span');icon.className='select-option-icon';icon.setAttribute('aria-hidden','true');icon.innerHTML=optionIcon(option)||'';label.textContent=option.label;item.replaceChildren(icon,label);}
    if(option.dataset.shortcut){
      const label=document.createElement('span'),shortcut=document.createElement('kbd');label.className='menu-item-label';
      label.textContent=option.label.replace(' · '+option.dataset.shortcut,'');shortcut.textContent=option.dataset.shortcut;shortcut.setAttribute('aria-hidden','true');
      item.classList.add('menu-shortcut-option');item.replaceChildren(label,shortcut);
    }
    if(menuClass){const mark=document.createElement('span');mark.className='select-option-check';mark.setAttribute('aria-hidden','true');mark.textContent='✓';item.append(mark);}
    item.disabled=option.disabled||option.parentElement.disabled===true;
    item.dataset.search=[option.label,option.value,option.dataset.search||''].join(' ').toLocaleLowerCase();
    item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));
    item.classList.toggle('selected',option.selected);
    item.addEventListener('pointermove',()=>{if(!item.disabled)focus(item,{scroll:false});},{signal});
    item.onclick=()=>{
      if(select.disabled||item.disabled)return;
      closeMenu(true);
      // Re-selecting the current item is navigation, not an edit or new revision.
      if(select.selectedIndex===index)return;
      select.selectedIndex=index;syncSelectMenu(select);
      select.dispatchEvent(new Event('input',{bubbles:true}));
      select.dispatchEvent(new Event('change',{bubbles:true}));
    };
    items.push(item);
    const parent=option.parentElement;
    if(menuClass&&parent.tagName==='OPTGROUP'){
      if(!groups.has(parent)){const group=document.createElement('div'),heading=document.createElement('span');group.className='custom-select-group';group.setAttribute('role','group');group.setAttribute('aria-label',parent.label);heading.className='custom-select-group-title';heading.textContent=parent.label;heading.setAttribute('aria-hidden','true');group.append(heading);groups.set(parent,group);menu.append(group);}
      groups.get(parent).append(item);
    }else menu.append(item);
  }
  menu.append(empty);
  const observer=new MutationObserver(()=>{if(!wrapper.isConnected)closeMenu();});
  active={wrapper,button,menu,events,observer};
  const popover=wrapper.closest(':popover-open');
  const host=popover||wrapper.closest('dialog[open]')||document.body;
  if(popover)menu.popover='manual';
  host.append(menu);
  if(popover){
    menu.showPopover();
    popover.addEventListener('beforetoggle',event=>{if(event.newState==='closed')closeMenu();},{signal});
  }
  wrapper.classList.add('open');button.setAttribute('aria-expanded','true');button.setAttribute('aria-controls',menu.id);
  const preferredWidth=parseFloat(getComputedStyle(menu).getPropertyValue('--select-menu-width'));
  menu.style.width=preferredWidth?Math.min(preferredWidth,innerWidth-12)+'px':'max-content';
  const contentWidth=menu.getBoundingClientRect().width;
  const reposition=()=>positionMenu(wrapper,menu,contentWidth);reposition();
  if(!active)return;
  observer.observe(document.body,{subtree:true,childList:true});
  focus(items.find(item=>item.getAttribute('aria-selected')==='true'&&!item.disabled)||enabled()[0]);
  (search||menu).focus({preventScroll:true});
  search?.addEventListener('input',()=>{
    const query=search.value.trim().toLocaleLowerCase();
    for(const item of items)item.hidden=!item.dataset.search.includes(query);
    empty.hidden=items.some(item=>!item.hidden);
    focus(enabled()[0],{scroll:false});menu.scrollTop=0;reposition();
  },{signal});
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target)&&!wrapper.contains(event.target))closeMenu();},{capture:true,signal});
  document.addEventListener('keydown',event=>{
    if(event.key==='Tab'){closeMenu(true);return;}
    const columns=groups.size>1&&getComputedStyle(menu).gridTemplateColumns.split(' ').length>1;
    if(columns&&['ArrowLeft','ArrowRight'].includes(event.key)){
      event.preventDefault();event.stopPropagation();const columns=[...groups.values()],column=focused?.parentElement,index=columns.indexOf(column),rows=enabled().filter(item=>item.parentElement===column),row=rows.indexOf(focused);
      const target=columns[Math.max(0,Math.min(columns.length-1,index+(event.key==='ArrowLeft'?-1:1)))],choices=enabled().filter(item=>item.parentElement===target);focus(choices[Math.min(Math.max(row,0),choices.length-1)]);return;
    }
    if(['Escape','ArrowDown','ArrowUp','Home','End','Enter',' '].includes(event.key)){
      if(search&&event.target===search&&[' ','Home','End'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      if(event.key==='Escape'){closeMenu(true);return;}
      if(event.key==='Enter'||event.key===' '){focused?.click();return;}
      const choices=columns&&focused?enabled().filter(item=>item.parentElement===focused.parentElement):enabled(),index=choices.indexOf(focused);
      const next={Home:0,End:choices.length-1,ArrowDown:Math.min(choices.length-1,index+1),ArrowUp:Math.max(0,index-1)}[event.key];
      focus(choices[next]);return;
    }
    if(!search&&event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      event.preventDefault();event.stopPropagation();
      const now=Date.now();typeahead=now-typedAt<700?typeahead+event.key:event.key;typedAt=now;
      focus(enabled().find(item=>item.dataset.search.startsWith(typeahead.toLocaleLowerCase())));
    }
  },{capture:true,signal});
  window.addEventListener('resize',reposition,{signal});
  window.addEventListener('scroll',event=>{if(event.target!==menu)reposition();},{capture:true,signal});
}

export function syncSelectMenu(select){
  const control=controls.get(select);
  if(!control)return;
  const {button,wrapper,iconOnly,optionIcon,triggerIcon}=control,option=select.selectedOptions[0],value=option?.label||'';
  if(iconOnly){const icon=triggerIcon||(option?optionIcon?.(option)||'':'');if(control.icon!==icon){button.innerHTML=icon;control.icon=icon;}}
  else button.textContent=value;
  button.title=select.title||value;
  button.setAttribute('aria-description',value);
  if(select.hasAttribute('aria-label'))button.setAttribute('aria-label',select.getAttribute('aria-label'));
  button.disabled=select.disabled;
  if(select.disabled&&active?.wrapper===wrapper)closeMenu();
}

export function setSelectValue(select,value){
  select.value=value;
  syncSelectMenu(select);
}

export function enhanceSelectMenu(select,{menuClass='',optionIcon=null,iconOnly=false,triggerIcon=''}={}){
  if(controls.has(select)||select.multiple||select.size>1||select.hasAttribute('data-no-custom-select'))return;
  const wrapper=document.createElement('span'),button=document.createElement('button');
  const label=select.labels[0];
  const caption=Array.from(label?.childNodes||[])
    .filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('').trim();
  wrapper.className='custom-select';
  button.className='custom-select-button';button.type='button';
  button.setAttribute('aria-label',select.getAttribute('aria-label')||caption||select.title||'选择');
  button.setAttribute('aria-haspopup','listbox');
  button.setAttribute('aria-expanded','false');
  if(label){
    button.id='paint-select-trigger-'+(++sequence);
    label.htmlFor=button.id;
  }
  select.before(wrapper);wrapper.append(select,button);
  select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  controls.set(select,{button,wrapper,menuClass,optionIcon,iconOnly,triggerIcon});
  syncSelectMenu(select);
  select.addEventListener('change',()=>syncSelectMenu(select));
  new MutationObserver(()=>{
    if(active?.wrapper===wrapper)closeMenu(true);
    syncSelectMenu(select);
  }).observe(select,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled','selected','hidden','label','aria-label']});
  button.onclick=()=>active?.wrapper===wrapper?closeMenu():openMenu(select,wrapper,button);
  button.onkeydown=event=>{
    if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
    event.preventDefault();openMenu(select,wrapper,button);
  };
}
