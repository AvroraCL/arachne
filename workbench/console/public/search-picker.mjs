import {compositionKey} from './text-input.mjs';

export function searchTerms(value){
  return value.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}

export function matchesSearch(value,terms){
  const text=value.normalize('NFKC').toLocaleLowerCase();
  return terms.every(term=>text.includes(term));
}

export function createSearchPicker({input,list,message,onSelect,onActive=()=>{}}){
  let rows=[],active=-1;

  function select(index,{scroll=false}={}){
    if(active>=0)rows[active]?.setAttribute('aria-selected','false');
    active=index;
    const row=rows[active];
    if(row){
      row.setAttribute('aria-selected','true');
      input.setAttribute('aria-activedescendant',row.id);
      if(scroll)row.scrollIntoView({block:'nearest'});
    }else input.removeAttribute('aria-activedescendant');
    onActive(row?.dataset.value);
  }

  function setItems(items,emptyMessage){
    rows=items.map(({value,content,label},index)=>{
      const row=document.createElement('div');
      row.id=list.id+'-item-'+index;
      row.className='picker-row';
      row.dataset.value=value;
      row.setAttribute('role','option');
      row.setAttribute('aria-selected','false');
      if(label)row.setAttribute('aria-label',label);
      row.append(...content);
      return row;
    });
    list.replaceChildren(...rows);
    list.scrollTop=0;
    list.hidden=!rows.length;
    input.setAttribute('aria-expanded',String(!list.hidden));
    message.textContent=rows.length?'':emptyMessage;
    active=-1;
    select(rows.length?0:-1);
  }

  input.addEventListener('keydown',event=>{
    if(compositionKey(event)||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||!rows.length)return;
    if(event.key==='Enter'){
      event.preventDefault();
      if(active>=0)onSelect(rows[active].dataset.value);
    }else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      select(Math.max(0,Math.min(rows.length-1,active+(event.key==='ArrowDown'?1:-1))),{scroll:true});
    }
  });
  list.addEventListener('mousedown',event=>{
    if(event.button===0&&event.target.closest('.picker-row'))event.preventDefault();
  });
  list.addEventListener('click',event=>{
    const row=event.target.closest('.picker-row');
    if(!row)return;
    select(rows.indexOf(row));
    onSelect(row.dataset.value);
  });

  return {setItems,activeValue:()=>rows[active]?.dataset.value};
}
