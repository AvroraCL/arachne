import {enableResourceGridKeys,resourcePreview} from './paint-library-preview.mjs';
import {matchesSearch,searchTerms} from './search-picker.mjs';
import {workspaceIcons} from './workspace-icons.mjs';
import {smartMaterialDragType} from './smart-material-placement.mjs';
let state=null,pending=null;
const listeners=new Set(),channel=typeof BroadcastChannel==='function'?new BroadcastChannel('arachne-personal-library'):null;
function publish(next){if(next&&(!state||next.revision>state.revision)){state=next;for(const listener of listeners)listener();}return state;}
export async function libraryRequest(action,data){
  const response=await fetch('/api/personal-library'+(action?'/'+action:''),data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'个人库操作失败'),{status:response.status});
  publish(result.state||result);if(data!==undefined)channel?.postMessage('changed');return result;
}
export async function refreshPersonalLibrary(){if(!pending)pending=libraryRequest('').finally(()=>pending=null);return pending;}
channel?.addEventListener('message',()=>void refreshPersonalLibrary().catch(()=>{}));
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
export function createPersonalShelf({host,read,canEdit,importResource,onImported}){
  let kind='materials',query='',active=false,picked=null,working=false,error='',notice='',key='',loaded=false,favoritesOnly=false;
  const panel=el('div','personal-shelf'),tools=el('div','personal-shelf-actions'),grid=el('div','library-grid'),status=el('output','personal-library-status');status.setAttribute('role','status');
  enableResourceGridKeys(grid);
  const button=(text,action)=>{const b=el('button','',text);b.type='button';b.onclick=()=>void act(action);return b;};
  const matches=(item,terms)=>item.kind===kind&&(!favoritesOnly||item.favorite)&&
    matchesSearch([item.name,...(item.tags||[])].join(' '),terms);
  const current=()=>{
    const item=state&&Object.hasOwn(state.items,picked)?state.items[picked]:null;
    return item&&matches(item,searchTerms(query))?item:null;
  };
  async function refresh(){await refreshPersonalLibrary();loaded=true;}
  async function act(action){if(working||!canEdit())return false;working=true;error='';notice='';sync();try{return await action();}catch(e){error=e.message;if(e.status===409)await refresh().catch(()=>{});return false;}finally{working=false;sync();}}
  async function importItem(item){
    const doc=read();if(!item||!doc)return;
    const result=await importResource(item,state.revision);
    if(result===false)return;
    const selected=onImported?.(result,doc.id)!==false;
    notice=item.kind==='smartMaterials'?'已应用到工程 · '+item.name:
      selected?'':'已导入项目，保留当前选择。';
  }
  function icon(control,key,label){
    if(control.dataset.icon!==key){control.innerHTML=workspaceIcons[key];control.dataset.icon=key;}
    control.title=label;control.setAttribute('aria-label',label);
    return control;
  }
  const add=button('导入项目',()=>importItem(current()));
  const edit=icon(button('',openEditor),'pen','编辑个人资源');
  const star=icon(button('',async()=>{
    const item=current();if(!item)return;
    await libraryRequest('update',{revision:state.revision,id:item.id,patch:{favorite:!item.favorite}});
  }),'star','收藏资源');
  const remove=icon(button('',async()=>{if(!current())return;await libraryRequest('remove',{revision:state.revision,id:picked});picked=null;}),'trash','删除个人资源');
  const only=icon(el('button'),'star','仅显示收藏');
  only.type='button';only.onclick=()=>{favoritesOnly=!favoritesOnly;sync();};
  const retry=icon(button('',refresh),'refresh','刷新个人库');
  const viewTools=el('div','personal-shelf-view');viewTools.append(only,retry);
  tools.append(add,edit,star,remove,viewTools);panel.append(tools,grid);host.append(panel,status);panel.hidden=true;

  const dialog=el('dialog','library-name-dialog'),form=el('form'),name=el('input'),tagInput=el('input');
  const heading=el('strong','','编辑个人资源'),actions=el('div','bar'),editError=el('p','library-edit-error');
  dialog.setAttribute('aria-label','编辑个人资源');editError.setAttribute('role','alert');
  let editTarget=null;
  name.required=true;name.maxLength=100;name.setAttribute('aria-label','个人资源名称');
  tagInput.maxLength=300;tagInput.placeholder='用逗号分隔标签';tagInput.setAttribute('aria-label','资源标签');
  const nameRow=el('label','','名称'),tagRow=el('label','','标签');
  nameRow.append(name);tagRow.append(tagInput);
  const cancel=el('button','','取消');cancel.type='button';cancel.onclick=()=>dialog.close();
  const confirm=el('button','','保存');confirm.type='submit';
  actions.append(cancel,confirm);form.append(heading,nameRow,tagRow,editError,actions);dialog.append(form);document.body.append(dialog);
  function openEditor(){
    const item=current();if(!item)return;
    editTarget={id:item.id,revision:state.revision,name:item.name,tags:(item.tags||[]).join('，')};
    name.value=editTarget.name;tagInput.value=editTarget.tags;editError.textContent='';
    dialog.showModal();name.select();
  }
  dialog.addEventListener('cancel',event=>{if(confirm.disabled)event.preventDefault();});
  form.onsubmit=async event=>{
    event.preventDefault();
    if(confirm.disabled||!editTarget)return;
    const patch={};
    if(name.value.trim()!==editTarget.name)patch.name=name.value.trim();
    if(tagInput.value!==editTarget.tags)patch.tags=tagInput.value.split(/[,，、;；]/).map(value=>value.trim()).filter(Boolean);
    if(!Object.keys(patch).length){dialog.close();return;}
    let conflict=false;
    confirm.disabled=cancel.disabled=name.disabled=tagInput.disabled=true;
    try{
      const {id,revision}=editTarget;
      const result=await act(()=>libraryRequest('update',{id,revision,patch}).catch(failure=>{
        conflict=failure.status===409;throw failure;
      }));
      if(result)dialog.close();
      else{
        const latest=conflict&&state?.items[id];
        if(latest){
          editTarget={id,revision:state.revision,name:latest.name,tags:(latest.tags||[]).join('，')};
          if(!Object.hasOwn(patch,'name'))name.value=editTarget.name;
          if(!Object.hasOwn(patch,'tags'))tagInput.value=editTarget.tags;
        }
        editError.textContent=latest?'资源已在其他窗口修改。核对当前输入后可再次保存。':error||'请结束当前编辑后重试';
      }
    }finally{confirm.disabled=cancel.disabled=name.disabled=tagInput.disabled=false;}
  };
  function sync(){
    panel.hidden=!active;
    const selected=current();
    add.textContent=kind==='smartMaterials'?'应用到工程':'导入项目';
    for(const control of [add,edit,star,remove])control.disabled=working||!canEdit()||!selected;
    icon(star,selected?.favorite?'starFilled':'star',selected?.favorite?'取消收藏':'收藏资源');
    star.setAttribute('aria-pressed',String(!!selected?.favorite));
    icon(only,favoritesOnly?'starFilled':'star','仅显示收藏');
    only.setAttribute('aria-pressed',String(favoritesOnly));
    retry.disabled=working;
    status.textContent=error||(working?'正在处理…':notice||(active&&!loaded&&!state?'正在载入个人库…':''));
    status.hidden=!status.textContent;status.dataset.error=String(!!error);
    const next=JSON.stringify([state?.revision,kind,query,favoritesOnly]);
    if(next!==key){
      key=next;
      const focused=grid.contains(document.activeElement)?document.activeElement.dataset.resourceId:null;
      const terms=searchTerms(query);
      const entries=Object.values(state?.items||{}).filter(item=>matches(item,terms));
      grid.replaceChildren(...entries.map(item=>{
        const tile=el('button','library-tile');
        tile.type='button';tile.dataset.resourceId=item.id;tile.setAttribute('aria-label',item.name);
        tile.onclick=()=>{picked=item.id;sync();};
        tile.ondblclick=()=>{picked=item.id;void act(()=>importItem(item));};
        if(item.kind==='smartMaterials'){
          tile.draggable=true;
          tile.ondragstart=event=>{
            if(working||!canEdit()||!Object.hasOwn(state?.items??{},item.id)){event.preventDefault();return;}
            event.dataTransfer.setData(smartMaterialDragType,JSON.stringify({id:item.id,revision:state.revision}));
            event.dataTransfer.effectAllowed='copy';
          };
        }
        tile.title=[item.name,...(item.tags||[]),item.kind==='smartMaterials'?'双击应用到工程':'双击导入项目'].join(' · ');
        tile.append(resourcePreview(kind,item,id=>'/api/personal-library/'+item.id+'/assets/'+id),el('span','library-name',item.name));
        if(item.favorite){
          const badge=el('span','personal-favorite-badge');
          badge.innerHTML=workspaceIcons.starFilled;badge.setAttribute('aria-hidden','true');tile.append(badge);
        }
        return tile;
      }));
      if(!entries.length&&state)grid.append(el('p','library-empty',terms.length?'没有匹配的个人资源':
        favoritesOnly?'没有已收藏的资源':kind==='smartMaterials'?'在材质图层中右击文件夹即可保存智能材质。':'个人库还没有这类资源'));
      if(focused)grid.querySelector('[data-resource-id="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
    }
    for(const tile of grid.querySelectorAll('.library-tile')){
      tile.disabled=working;
      tile.setAttribute('aria-pressed',String(tile.dataset.resourceId===picked));
    }
  }
  const notify=sync;listeners.add(notify);const timer=setInterval(()=>{if(active&&!document.hidden&&!working)void refresh().catch(e=>{error=e.message;sync();});},4000);
  return {
    set(options){const entering=options.active&&!active;kind=options.kind;query=options.query||'';active=options.active;sync();if(entering)void refresh().catch(e=>{error=e.message;sync();});},
    async save(resourceKind,resourceId){const origin=read()&&{id:read().id,revision:read().revision};return act(async()=>{if(!origin||!resourceId)throw Error('请先选择一个项目资源');await refresh();if(read()?.id!==origin.id||read()?.revision!==origin.revision)throw Error('工程或修订已变化，请重新选择资源');const result=await libraryRequest('save',{projectId:origin.id,projectRevision:origin.revision,revision:state.revision,kind:resourceKind,resourceId});picked=result.item.id;notice='已保存到个人库：'+result.item.name;return result;});},
    get working(){return working;},
    dispose(){clearInterval(timer);listeners.delete(notify);dialog.remove();panel.remove();status.remove();}
  };
}
