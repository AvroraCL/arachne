import {cyclesFormatLabel} from './render-output-ui.mjs';
import {renderRegionPixels} from './render-region.mjs';

export function setupRenderCameraBatch({read,settings,canOpen,submit:queue,onSubmitted}){
  const byId=id=>document.getElementById(id);
  const dialog=byId('render-batch-dialog'),trigger=byId('open-render-batch');
  const list=byId('render-batch-cameras'),all=byId('render-batch-all'),summary=byId('render-batch-summary');
  const submit=byId('submit-render-batch'),close=byId('close-render-batch'),error=byId('render-batch-error');
  let frozen=null,selected=new Set(),pending=false,requestId='';
  const cameras=()=>[...list.querySelectorAll('input')];
  function sync(){
    const project=read();
    trigger.disabled=!(project?.paint.renderBookmarks?.length);
    if(!dialog.open)return;
    const stale=project?.id!==frozen?.id||project?.revision!==frozen?.revision;
    close.disabled=pending;
    all.disabled=stale||pending;
    all.checked=selected.size===frozen.bookmarks.length;
    all.indeterminate=selected.size>0&&!all.checked;
    for(const camera of cameras()){
      camera.checked=selected.has(camera.value);
      camera.disabled=stale||pending;
    }
    submit.disabled=stale||pending||!selected.size;
    submit.textContent=pending?'正在提交…':selected.size?'加入队列 · '+selected.size:'加入队列';
    if(stale&&!pending)error.textContent='工程修订已更新，请重新打开批量出图。';
  }
  function changed(){
    requestId=crypto.randomUUID();
    error.textContent='';
    sync();
  }
  function open(){
    const project=read(),bookmarks=project?.paint.renderBookmarks;
    if(!bookmarks?.length||!canOpen())return;
    const output=settings(),region=renderRegionPixels(project.paint.renderRegion,output.width,output.height);
    frozen={id:project.id,revision:project.revision,bookmarks,output};
    selected=new Set(bookmarks.map(camera=>camera.id));requestId=crypto.randomUUID();error.textContent='';
    const dimensions=region?.output||[output.width,output.height];
    summary.textContent=`${dimensions.join(' × ')} · ${cyclesFormatLabel(output.fileFormat)} · ${output.samples} 次采样 · r${project.revision}`;
    list.replaceChildren(...bookmarks.map(camera=>{
      const row=document.createElement('label'),input=document.createElement('input'),name=document.createElement('span'),projection=document.createElement('small');
      input.type='checkbox';input.value=camera.id;input.setAttribute('aria-label',camera.name);
      name.textContent=name.title=camera.name;
      projection.textContent=camera.camera.projection==='orthographic'?'正交':'透视';
      input.onchange=()=>{if(input.checked)selected.add(camera.id);else selected.delete(camera.id);changed();};
      row.append(input,name,projection);return row;
    }));
    const menu=trigger.closest('details');if(menu)menu.open=false;
    dialog.showModal();sync();
  }
  all.onchange=()=>{selected=new Set(all.checked?frozen.bookmarks.map(camera=>camera.id):[]);changed();};
  trigger.onclick=open;
  close.onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  dialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();
    if(submit.disabled||pending)return;
    pending=true;error.textContent='';sync();
    try{
      const {id,revision,output,bookmarks}=frozen;
      if(await queue(id,{revision,requestId,settings:output,bookmarkIds:bookmarks.map(camera=>camera.id).filter(id=>selected.has(id))},error)){
        dialog.close();
        onSubmitted();
      }
    }catch(failure){error.textContent=failure.message;}
    finally{pending=false;sync();}
  };
  return {open,sync};
}
