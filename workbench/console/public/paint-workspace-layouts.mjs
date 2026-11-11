import {areaRects,editorNames,parseWorkspaceLayoutFile,workspaceNames} from './workspace-state.mjs';
import {areaIcons} from './area-chrome.mjs';

export function setupWorkspaceLayouts({areas,canOpen}){
  const byId=id=>document.getElementById(id);
  const dialog=byId('workspace-layouts');
  const trigger=byId('open-workspace-layouts');
  const fileInput=byId('workspace-layout-file');
  const apply=byId('apply-workspace-layouts');
  const error=byId('workspace-layout-error');
  const source=byId('workspace-layout-source');
  const previews=byId('workspace-layout-previews');
  let pending=null,request=0;
  trigger.hidden=false;

  function render(layouts,label){
    source.textContent=label;
    apply.hidden=!pending;
    previews.replaceChildren(...Object.entries(workspaceNames).map(([name,title])=>{
      const rects=areaRects(layouts[name]);
      const card=document.createElement('div'),heading=document.createElement('div'),map=document.createElement('div');
      const label=document.createElement('strong'),count=document.createElement('small');
      card.className='workspace-layout-card';
      heading.className='workspace-layout-caption';
      label.textContent=title;count.textContent=rects.length+' 个区域';
      heading.append(label,count);
      map.className='workspace-layout-map';
      map.setAttribute('role','img');
      map.setAttribute('aria-label',rects.map(rect=>editorNames[rect.area.editor]).join('、'));
      for(const {x,y,w,h,area} of rects){
        const tile=document.createElement('div');
        tile.className='workspace-layout-tile';tile.dataset.editor=area.editor;
        tile.style.left=x*100+'%';tile.style.top=y*100+'%';tile.style.width=w*100+'%';tile.style.height=h*100+'%';
        tile.title=editorNames[area.editor];tile.innerHTML=areaIcons[area.editor]||'';
        map.append(tile);
      }
      card.append(heading,map);
      return card;
    }));
  }

  function showCurrent(){
    pending=null;
    render(areas.exportLayouts().layouts,'当前布局');
  }

  trigger.onclick=()=>{
    if(!canOpen())return;
    const menu=trigger.closest('details');
    menu.open=false;menu.querySelector('summary')?.focus();
    error.textContent='';
    showCurrent();
    dialog.showModal();
  };
  byId('close-workspace-layouts').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{if(!dialog.open)request++;});
  byId('export-workspace-layouts').onclick=()=>{
    const blob=new Blob([JSON.stringify(areas.exportLayouts(),null,2)+'\n'],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;link.download='arachne-workspaces.json';
    dialog.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  };
  byId('import-workspace-layouts').onclick=()=>fileInput.click();
  fileInput.onchange=async()=>{
    const file=fileInput.files?.[0];
    fileInput.value='';
    if(!file)return;
    const token=++request;
    showCurrent();error.textContent='';
    try{
      if(file.size>65536)throw Error('布局文件不能超过 64 KiB');
      const raw=JSON.parse(await file.text());
      const layouts=parseWorkspaceLayoutFile(raw);
      if(token!==request||!dialog.open)return;
      pending=raw;
      render(layouts,'预览 · '+file.name);
    }catch(failure){
      if(token===request&&dialog.open)error.textContent=failure instanceof SyntaxError?'布局文件不是有效的 JSON':failure.message;
    }
  };
  apply.onclick=()=>{
    if(!pending)return;
    dialog.close();
    try{areas.replaceLayouts(pending);pending=null;}
    catch(failure){error.textContent=failure.message;dialog.showModal();}
  };
}
