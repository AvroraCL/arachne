export function setupPaintHistory({trigger,read,load,restore,canEdit=()=>true}){
  const dialog=document.createElement('dialog');dialog.id='history-dialog';dialog.setAttribute('aria-label','历史记录');
  const header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button');title.textContent='历史记录';close.textContent='×';close.type='button';close.setAttribute('aria-label','关闭历史记录');header.append(title,close);
  const info=document.createElement('p');info.className='history-info';
  const help=document.createElement('p');help.className='history-help';help.textContent='撤销包含所选记录及之后的操作；重做执行到所选记录。';
  const columns=document.createElement('div');columns.className='history-columns';
  const error=document.createElement('output');error.id='history-error';error.setAttribute('role','alert');
  dialog.append(header,info,help,columns,error);document.body.append(dialog);
  let snapshot=null,project=null,token=0,writing=false;
  function controls(){
    const available=!writing&&canEdit()&&snapshot?.revision===read()?.revision&&project===read()?.id;
    for(const button of columns.querySelectorAll('button'))button.disabled=!available;
  }
  function render(){
    info.textContent=`可撤销 ${snapshot.undoCount} 步 · 可重做 ${snapshot.redoCount} 步`;
    columns.replaceChildren(...['undo','redo'].map(direction=>{
      const section=document.createElement('section'),heading=document.createElement('h3'),list=document.createElement('ol');heading.textContent=direction==='undo'?'撤销':'重做';
      for(const item of snapshot[direction]){
        const row=document.createElement('li'),button=document.createElement('button'),label=document.createElement('strong'),detail=document.createElement('span'),steps=document.createElement('small');
        const action=direction==='undo'?'撤销':'重做';button.type='button';button.dataset.direction=direction;button.dataset.steps=String(item.steps);button.setAttribute('aria-label',`${action} ${item.steps} 步：${item.label}`);
        label.textContent=item.label;detail.textContent=item.detail;steps.textContent=`${action} ${item.steps} 步`;button.append(label,detail,steps);row.append(button);list.append(row);
        const origin={id:project,revision:snapshot.revision};
        button.onclick=async()=>{
          if(writing||!canEdit())return;
          if(read()?.id!==origin.id||read()?.revision!==origin.revision){error.textContent='历史记录已变化，请重新选择';void refresh(true);return;}
          writing=true;error.textContent='';controls();
          try{const ok=await restore(direction,item.steps,origin);if(ok===true)dialog.close();else{if(!error.textContent)error.textContent='请先结束当前操作，再恢复历史';await refresh(true);}}
          catch(failure){error.textContent=failure.message;await refresh(true);}
          finally{writing=false;controls();}
        };
      }
      if(!snapshot[direction].length){const empty=document.createElement('p');empty.className='history-empty';empty.textContent=direction==='undo'?'还没有可撤销的操作':'没有待重做的操作';section.append(heading,empty);}
      else section.append(heading,list);
      return section;
    }));controls();
  }
  async function refresh(keepError=false){
    const id=read()?.id;if(!id)return;
    const request=++token;if(!keepError)error.textContent='';info.textContent='正在读取历史…';
    try{const next=await load(id);if(request!==token||!dialog.open||id!==read()?.id)return;snapshot=next;project=id;render();}
    catch(failure){if(request===token){error.textContent=failure.message;info.textContent='历史记录暂时不可用';}}
  }
  trigger.onclick=()=>{
    if(!read()||!canEdit()||document.querySelector('dialog[open]'))return;
    document.querySelectorAll('.paint-menu[open]').forEach(menu=>menu.open=false);
    project=read().id;snapshot=null;columns.replaceChildren();dialog.showModal();void refresh();
  };
  close.onclick=()=>dialog.close();dialog.addEventListener('cancel',event=>{if(writing)event.preventDefault();});
  dialog.addEventListener('close',()=>{token++;trigger.closest('details')?.querySelector('summary')?.focus();});
  return {isOpen:()=>dialog.open,sync(){
    trigger.disabled=!read()||!canEdit();if(!dialog.open||writing)return;
    if(project!==read()?.id){dialog.close();return;}
    if(snapshot&&snapshot.revision!==read()?.revision)void refresh();else controls();
  }};
}
