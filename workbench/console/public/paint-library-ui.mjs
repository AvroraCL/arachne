import {createMaterialMapDialog} from './material-map-dialog.mjs';
import {chromeButton} from './area-chrome.mjs';
import {defaultLibraryMaterial,defaultBrushGraph,evaluateBrushGraph} from './paint-library.mjs';
import {createPersonalShelf} from './personal-library-client.mjs';
import {enhanceSelectMenu,setSelectValue} from './paint-select.mjs';
import {enableResourceGridKeys,resourcePreview} from './paint-library-preview.mjs';
import {matchesSearch,searchTerms} from './search-picker.mjs';

const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
export function createPaintLibrary({host,read,write,saveMap,uploadMaps,canEdit,selectedLayer,brushSettings,applyBrush,changed,applyMaterial,openNodes=null,selectedImage=()=>null,importResource,onImportedImage}){
  let kind='materials',picked=null,project=null,brushKey='',gridKey='',nodesOpen=true,selectionGeneration=0;
  let scope='project';try{scope=localStorage.getItem('arachne-library-scope')==='personal'?'personal':'project';}catch{}
  const bar=el('div','library-bar'),tabs=el('div','library-tabs'),tools=el('div','library-actions'),grid=el('div','library-grid');
  enableResourceGridKeys(grid);
  tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','资源库');
  const search=el('input');search.type='search';search.placeholder='搜索资源';search.setAttribute('aria-label','搜索资源');
  function button(text,action,label){const b=el('button','',text);b.type='button';b.onclick=action;if(label)b.setAttribute('aria-label',label);return b;}
  for(const [id,name] of [['materials','材质'],['brushes','笔刷'],['images','图片']]){
    const b=button(name,()=>{if(!canEdit())return;selectionGeneration++;kind=id;picked=null;gridKey='';remember();sync();changed();});b.dataset.library=id;b.setAttribute('role','tab');tabs.append(b);
  }
  const create=button('＋ 新建',()=>mutate('create'));
  const mapDialog=createMaterialMapDialog({
    read,origin:()=>{const doc=read();return doc&&{id:doc.id,revision:doc.revision};},upload:uploadMaps,
    save:async(patch,origin)=>{
      const id=crypto.randomUUID(),selection=selectionGeneration;
      await saveMap([{op:'library',library:'materials',id,action:'create',patch}],origin);
      if(read()?.id===origin.id&&selection===selectionGeneration){
        search.value='';
        select('materials',id);
      }
    }
  });
  const fromMaps=chromeButton(button('从贴图创建材质',()=>mapDialog.open()),'image');
  const capture=button('保存当前',()=>mutate('capture'));capture.title='将当前图层材质值或笔刷参数保存为独立资源';
  const duplicate=button('复制',()=>mutate('duplicate'));
  const rename=button('重命名',()=>{const item=current();if(!item||!canEdit())return;name.value=item.name;dialog.showModal();name.select();});
  const remove=button('删除',()=>mutate('remove'));
  const apply=button('创建填充层',()=>{if(picked&&canEdit())applyMaterial(picked);});
  const nodes=button('节点',()=>{if(!canEdit())return;if(openNodes){openNodes();return;}nodesOpen=!nodesOpen;remember();sync();changed();});nodes.setAttribute('aria-label','显示资源节点');
  const output=button('工程输出',()=>{if(!canEdit())return;picked=null;nodesOpen=false;remember();sync();changed();});output.title='查看合成后的工程输出节点';
  const scopeSelect=el('select');scopeSelect.setAttribute('aria-label','资源库范围');scopeSelect.append(new Option('当前项目','project'),new Option('个人','personal'));scopeSelect.value=scope;
  const savePersonal=button('保存到个人库',()=>void personal.save(kind,kind==='images'?selectedImage():picked));
  tools.append(create,fromMaps,capture,duplicate,rename,remove,apply,nodes,output,savePersonal);bar.append(tabs,scopeSelect,search,tools);host.append(bar,grid);enhanceSelectMenu(scopeSelect);scopeSelect.closest('.custom-select').classList.add('library-scope');
  scopeSelect.onchange=()=>{if(!canEdit()){setSelectValue(scopeSelect,scope);return;}selectionGeneration++;scope=scopeSelect.value;try{localStorage.setItem('arachne-library-scope',scope);}catch{}sync();changed();};
  const personal=createPersonalShelf({
    host,read,canEdit,
    importResource:async(item,revision)=>{
      const selection=selectionGeneration,image=selectedImage(),result=await importResource(item,revision);
      return result===false?false:{result,selection,image};
    },
    onImported:(packet,projectId)=>{
      if(read()?.id!==projectId||packet.selection!==selectionGeneration||packet.image!==selectedImage())return false;
      const result=packet.result;if(result.resource.kind==='images'){showImages();onImportedImage?.(result.resource.id);}else select(result.resource.kind,result.resource.id);
    }
  });
  const dialog=el('dialog','library-name-dialog'),form=el('form'),name=el('input'),heading=el('strong','','重命名资源'),actions=el('div','bar');
  name.required=true;name.maxLength=100;name.setAttribute('aria-label','资源名称');
  actions.append(button('取消',()=>dialog.close()));const confirm=el('button','','保存');confirm.type='submit';actions.append(confirm);form.append(heading,name,actions);dialog.append(form);document.body.append(dialog);
  form.onsubmit=async e=>{e.preventDefault();const t=target();if(!t||!canEdit())return;dialog.close();await write([{op:'library',library:t.library,id:t.id,action:'update',patch:{name:name.value.trim()}}]);};
  function remember(){try{localStorage.setItem('arachne-library:'+project,JSON.stringify({kind,picked,nodesOpen}));}catch{}}
  const current=()=>{const entries=read()?.paint[kind];return entries&&Object.hasOwn(entries,picked)?entries[picked]:null;};
  function target(){const item=current();return scope==='project'&&item?{library:kind,id:picked,...item}:null;}
  async function mutate(action){
    const doc=read();if(!doc||!canEdit())return;
    if(action==='remove')return write([{op:'library',library:kind,id:picked,action:'remove'}]);
    const id=crypto.randomUUID(),item=current(),library=kind,isBrush=library==='brushes',selection=selectionGeneration;
    const referenced=selectedLayer()?.materialId&&doc.paint.materials?.[selectedLayer().materialId];
    const graph=action==='duplicate'?structuredClone(item.graph):action==='capture'&&!isBrush&&referenced?structuredClone(referenced.graph):isBrush?defaultBrushGraph(action==='capture'?brushSettings():{}):defaultLibraryMaterial(action==='capture'?(selectedLayer()?.values||doc.paint.base):undefined);
    const patch={name:action==='duplicate'?item.name.slice(0,95)+' · 副本':isBrush?'新笔刷':'新材质',graph};
    if(await write([{op:'library',library,id,action:'create',patch}])!==false&&read()?.id===doc.id&&selection===selectionGeneration)select(library,id);
  }
  function select(library,id){
    if(!Object.hasOwn(read()?.paint[library]||{},id))return;
    selectionGeneration++;
    scope='project';setSelectValue(scopeSelect,scope);
    kind=library;picked=id;nodesOpen=true;if(library==='brushes')brushKey='';remember();sync();changed({force:true});
  }
  function sync(){
    const doc=read();if(!doc)return;
    if(project!==doc.id){selectionGeneration++;project=doc.id;picked=null;brushKey='';gridKey='';try{const saved=JSON.parse(localStorage.getItem('arachne-library:'+project));if(saved&&['materials','brushes','images'].includes(saved.kind)){kind=saved.kind;picked=saved.picked;nodesOpen=saved.nodesOpen!==false;}}catch{}}
    if(picked&&!current()){picked=null;brushKey='';}
    const item=current();
    if(scope==='project'&&kind==='brushes'&&item&&canEdit()){const key=JSON.stringify([project,picked,item.graph]);if(key!==brushKey){applyBrush(evaluateBrushGraph(item.graph));brushKey=key;}}
    const images=kind==='images',isPersonal=scope==='personal';document.getElementById('image-library').hidden=!images||isPersonal;grid.hidden=images||isPersonal;
    document.getElementById('shader-editor').toggleAttribute('data-library-open',!isPersonal&&!!item&&nodesOpen);
    personal.set({kind,query:search.value,active:isPersonal});
    for(const b of tabs.children)b.setAttribute('aria-selected',String(b.dataset.library===kind));
    for(const b of tools.querySelectorAll('button'))b.disabled=!canEdit();
    for(const b of [duplicate,rename,remove])b.disabled||=!item;
    const referenced=kind==='materials'&&doc.paint.layers.some(layer=>layer.materialId===picked);
    remove.disabled||=referenced;remove.title=referenced?'材质仍被填充层引用，请先解除引用':'删除资源';
    for(const b of [create,capture,duplicate,rename,remove,nodes,output])b.hidden=images;
    apply.hidden=fromMaps.hidden=kind!=='materials';apply.disabled||=!picked;nodes.disabled||=!item;nodes.setAttribute('aria-pressed',String(nodesOpen));
    if(isPersonal)for(const b of tools.querySelectorAll('button'))b.hidden=true;
    else savePersonal.hidden=false;
    savePersonal.disabled=!canEdit()||personal.working||!(images?selectedImage():item);
    search.hidden=images&&!isPersonal;
    if(isPersonal)return;
    const terms=searchTerms(search.value);
    const entries=Object.entries(doc.paint[kind]||{}).filter(([,item])=>matchesSearch(item.name,terms));
    const key=JSON.stringify([project,kind,entries,terms]);
    if(key!==gridKey){
      gridKey=key;
      const focused=grid.contains(document.activeElement)?document.activeElement.dataset.resourceId:null;
      grid.replaceChildren(...entries.map(([id,item])=>{
        const tile=button('',()=>{if(canEdit())select(kind,id);},item.name);
        tile.className='library-tile';tile.dataset.resourceId=id;
        if(kind==='materials')tile.ondblclick=()=>{if(canEdit())applyMaterial(id);};
        tile.title=item.name+(kind==='materials'?' · 双击创建填充层':' · 应用于后续笔触');
        tile.append(resourcePreview(kind,item,asset=>'/api/projects/'+doc.id+'/paint/assets/'+asset),el('span','library-name',item.name));
        return tile;
      }));
      if(!entries.length)grid.append(el('p','library-empty',terms.length?'没有匹配的资源':`还没有${kind==='materials'?'材质':'笔刷'}`));
      if(focused)grid.querySelector('[data-resource-id="'+CSS.escape(focused)+'"]')?.focus({preventScroll:true});
    }
    for(const tile of grid.querySelectorAll('.library-tile'))tile.setAttribute('aria-pressed',String(tile.dataset.resourceId===picked));
  }
  search.oninput=sync;
  function showImages(){selectionGeneration++;scope='project';setSelectValue(scopeSelect,scope);kind='images';picked=null;gridKey='';remember();sync();changed();}
  return {sync,select,target,showImages};
}
