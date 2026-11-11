import {drawBrushPreview} from './paint-library-preview.mjs';
import {evaluateBrushGraph} from './paint-library.mjs';
let state=null,pending=null;
const listeners=new Set(),channel=typeof BroadcastChannel==='function'?new BroadcastChannel('arachne-personal-library'):null;
function publish(next){if(next&&(!state||next.revision>=state.revision)){state=next;for(const listener of listeners)listener();}return state;}
export async function libraryRequest(action,data){
  const response=await fetch('/api/personal-library'+(action?'/'+action:''),data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'个人库操作失败'),{status:response.status});
  publish(result.state||result);if(data!==undefined)channel?.postMessage('changed');return result;
}
export async function refreshPersonalLibrary(){if(!pending)pending=libraryRequest('').finally(()=>pending=null);return pending;}
channel?.addEventListener('message',()=>void refreshPersonalLibrary().catch(()=>{}));
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
export function createPersonalShelf({host,read,canEdit,importResource,onImported}){
  let kind='materials',query='',active=false,picked=null,working=false,error='',notice='',key='',loaded=false;
  const panel=el('div','personal-shelf'),tools=el('div','personal-shelf-actions'),grid=el('div','library-grid'),status=el('output','personal-library-status');status.setAttribute('role','status');
  const button=(text,action)=>{const b=el('button','',text);b.type='button';b.onclick=()=>void act(action);return b;};
  const current=()=>state&&Object.hasOwn(state.items,picked)&&state.items[picked].kind===kind?state.items[picked]:null;
  async function refresh(){await refreshPersonalLibrary();loaded=true;}
  async function act(action){if(working||!canEdit())return false;working=true;error='';notice='';sync();try{return await action();}catch(e){error=e.message;if(e.status===409)await refresh().catch(()=>{});return false;}finally{working=false;key='';sync();}}
  async function importItem(item){const doc=read();if(!item||!doc)return;const result=await importResource(item,state.revision);if(result!==false&&onImported?.(result,doc.id)===false)notice='已导入项目，保留当前选择。';}
  const add=button('导入项目',()=>importItem(current()));
  const rename=button('重命名',()=>{const item=current();if(!item)return;name.value=item.name;renameId=item.id;renameRevision=state.revision;dialog.showModal();name.select();});
  const remove=button('删除',async()=>{if(!current())return;await libraryRequest('remove',{revision:state.revision,id:picked});picked=null;});
  const retry=button('刷新',refresh);tools.append(add,rename,remove,retry);panel.append(tools,grid);host.append(panel,status);panel.hidden=true;
  const dialog=el('dialog','library-name-dialog'),form=el('form'),name=el('input'),heading=el('strong','','重命名个人资源'),actions=el('div','bar');let renameId,renameRevision;
  name.required=true;name.maxLength=100;name.setAttribute('aria-label','个人资源名称');const cancel=el('button','','取消');cancel.type='button';cancel.onclick=()=>dialog.close();const confirm=el('button','','保存');confirm.type='submit';actions.append(cancel,confirm);form.append(heading,name,actions);dialog.append(form);document.body.append(dialog);
  form.onsubmit=e=>{e.preventDefault();dialog.close();void act(()=>libraryRequest('rename',{revision:renameRevision,id:renameId,name:name.value.trim()}));};
  function sync(){
    panel.hidden=!active;for(const b of [add,rename,remove])b.disabled=working||!canEdit()||!current();retry.disabled=working;
    status.hidden=!active&&!working&&!error&&!notice;
    status.textContent=error||(working?'正在处理…':notice||(!loaded&&!state?'正在载入个人库…':'导入后保存为项目副本；个人库变更不影响已有项目。'));status.dataset.error=String(!!error);
    const entries=Object.values(state?.items||{}).filter(item=>item.kind===kind&&item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const next=JSON.stringify([state?.revision,kind,query,picked,working]);if(next===key)return;key=next;grid.replaceChildren();
    for(const item of entries){
      const tile=el('button','library-tile');tile.type='button';tile.setAttribute('aria-label',item.name);tile.setAttribute('aria-pressed',String(picked===item.id));tile.disabled=working;tile.onclick=()=>{picked=item.id;key='';sync();};tile.ondblclick=()=>{picked=item.id;void act(()=>importItem(item));};
      const preview=el('div','library-preview');let assetId=item.image;
      if(kind==='materials'){const pbr=item.graph.nodes.find(n=>n.type==='pbr'),rgb=item.graph.nodes.find(n=>n.type==='color');const sphere=el('span','library-sphere');sphere.style.setProperty('--material-color',rgb?.params.color||pbr?.params.color||'#808080');assetId=item.graph.nodes.find(n=>n.type==='image'&&n.params.asset)?.params.asset;if(assetId){const img=el('img');img.alt='';img.src='/api/personal-library/'+item.id+'/assets/'+assetId;sphere.append(img);}preview.append(sphere);}
      else if(kind==='images'){const img=el('img');img.alt='';img.draggable=false;img.src='/api/personal-library/'+item.id+'/assets/'+assetId;preview.append(img);}
      else {const canvas=el('canvas');drawBrushPreview(canvas,evaluateBrushGraph(item.graph));preview.append(canvas);}
      for(const img of preview.querySelectorAll('img')){img.loading='lazy';img.decoding='async';}
      tile.title=item.name+' · 双击导入独立副本';tile.append(preview,el('span','library-name',item.name));grid.append(tile);
    }
    if(!entries.length)grid.append(el('p','library-empty',query?'没有匹配的个人资源':'个人库还没有这类资源。在当前项目选中资源后，点击“保存到个人库”。'));
  }
  const notify=()=>{key='';sync();};listeners.add(notify);const timer=setInterval(()=>{if(active&&!document.hidden&&!working)void refresh().catch(e=>{error=e.message;sync();});},4000);
  return {
    set(options){const entering=options.active&&!active;kind=options.kind;query=options.query||'';active=options.active;sync();if(entering)void refresh().catch(e=>{error=e.message;sync();});},
    async save(resourceKind,resourceId){const origin=read()&&{id:read().id,revision:read().revision};return act(async()=>{if(!origin||!resourceId)throw Error('请先选择一个项目资源');await refresh();if(read()?.id!==origin.id||read()?.revision!==origin.revision)throw Error('工程或修订已变化，请重新选择资源');const result=await libraryRequest('save',{projectId:origin.id,projectRevision:origin.revision,revision:state.revision,kind:resourceKind,resourceId});picked=result.item.id;notice='已保存到个人库：'+result.item.name;return result;});},
    get working(){return working;},
    dispose(){clearInterval(timer);listeners.delete(notify);dialog.remove();panel.remove();status.remove();}
  };
}
