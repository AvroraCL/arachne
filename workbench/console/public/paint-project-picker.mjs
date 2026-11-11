import {createSearchPicker,searchTerms,matchesSearch} from './search-picker.mjs';

const dateFormat=new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'short',hour12:false});
function updatedAt(project){
  return Date.parse(project.updated)||Number(project.created)||0;
}

export function recentProjects(items){
  return [...items].sort((a,b)=>updatedAt(b)-updatedAt(a)||a.name.localeCompare(b.name));
}

export function projectDate(project){
  const time=updatedAt(project);
  return time?dateFormat.format(time):'';
}

export function setupProjectPicker({list,current,open,canOpen}){
  const dialog=document.getElementById('open-project-dialog');
  const search=document.getElementById('project-search');
  const results=document.getElementById('project-results');
  const close=document.getElementById('cancel-open-project');
  const confirm=document.getElementById('confirm-open-project');
  const error=document.getElementById('open-project-error');
  let projects=[],request=0,opening=false;
  const picker=createSearchPicker({
    input:search,list:results,message:document.getElementById('project-results-message'),onSelect:activate,
    onActive:id=>{confirm.disabled=opening||!id;}
  });

  function render(){
    const terms=searchTerms(search.value);
    const items=projects.filter(project=>matchesSearch(project.name+' '+project.id,terms)).map(project=>{
      const name=document.createElement('span');
      name.className='picker-row-name';
      name.textContent=name.title=project.name;
      const detail=document.createElement('span');
      detail.className='picker-row-detail';
      detail.textContent=[project.id===current()?'当前工程':'',projectDate(project)].filter(Boolean).join(' · ');
      return {value:project.id,content:[name,detail]};
    });
    picker.setItems(items,terms.length?'没有匹配的工程':'还没有涂装工程');
  }

  async function activate(id){
    if(!id||opening||!dialog.open)return;
    if(id===current()){dialog.close();return;}
    opening=search.disabled=close.disabled=confirm.disabled=true;
    results.setAttribute('aria-busy','true');
    error.textContent='';
    try{
      if(await open(id,error))dialog.close();
      else if(!error.textContent)error.textContent='请结束当前操作，再打开工程';
    }finally{
      opening=search.disabled=close.disabled=false;
      confirm.disabled=!picker.activeValue();
      results.removeAttribute('aria-busy');
      if(dialog.open)search.focus();
    }
  }

  search.oninput=render;
  close.onclick=()=>dialog.close();
  confirm.onclick=()=>void activate(picker.activeValue());
  dialog.addEventListener('cancel',event=>{if(opening)event.preventDefault();});
  return function show(){
    if(!canOpen())return false;
    const token=++request;
    projects=[];
    search.value=error.textContent='';
    search.disabled=true;
    picker.setItems([],'正在读取工程…');
    const menu=document.querySelector('.paint-menu[open]');
    if(menu){menu.open=false;menu.querySelector('summary')?.focus();}
    dialog.showModal();
    void list().then(items=>{
      if(!dialog.open||token!==request)return;
      projects=recentProjects(items);
      render();
      search.disabled=false;
      if(document.activeElement===close||document.activeElement===dialog)search.focus();
    }).catch(failure=>{
      if(!dialog.open||token!==request)return;
      picker.setItems([],'工程列表暂时不可用');
      error.textContent=failure.message;
    });
    return true;
  };
}
