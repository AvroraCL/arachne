import {syncSelectMenu} from './paint-select.mjs';
import {modelTemplates} from './model-templates.mjs';

const defaultProjectName='示例模型 · PBR 涂装';
const MiB=1024*1024;

function paintableMaterials(model){
  const entries=new Map(),visited=new Set();
  const scene=model?.scenes?.[model.scene??0];
  const pending=Array.isArray(scene?.nodes)?[...scene.nodes].reverse():[];
  while(pending.length){
    const index=pending.pop(),node=model.nodes?.[index];
    if(!Number.isInteger(index)||!node||visited.has(index))continue;
    visited.add(index);
    if(Array.isArray(node.children))for(let i=node.children.length-1;i>=0;i--)pending.push(node.children[i]);
    const primitives=model.meshes?.[node.mesh]?.primitives;
    if(!Array.isArray(primitives))continue;
    for(const primitive of primitives){
      const uv=primitive?.attributes?.TEXCOORD_0;
      if((primitive?.mode??4)!==4||!Number.isInteger(uv)||model.accessors?.[uv]?.type!=='VEC2')continue;
      const index=primitive.material;
      if(index===undefined){entries.set('default','默认材质');continue;}
      const material=model.materials?.[index];
      if(!Number.isInteger(index)||!material||entries.has(String(index)))continue;
      const name=typeof material.name==='string'?material.name.trim().slice(0,100):'';
      entries.set(String(index),name||'材质 '+(index+1));
    }
  }
  const counts=new Map();
  for(const name of entries.values())counts.set(name,(counts.get(name)||0)+1);
  return [...entries].map(([value,name])=>[value,counts.get(name)>1&&value!=='default'?name+' · '+(Number(value)+1):name]);
}

async function checkGlb(file){
  if(file.size>128*MiB)throw Error('GLB 不能超过 128 MiB');
  if(file.size<20)throw Error('请选择有效的 GLB 2.0 模型');
  const header=new DataView(await file.slice(0,20).arrayBuffer()),jsonEnd=20+header.getUint32(12,true);
  if(header.getUint32(0,true)!==0x46546c67||header.getUint32(4,true)!==2||header.getUint32(8,true)!==file.size||
     header.getUint32(16,true)!==0x4e4f534a||jsonEnd>file.size)
    throw Error('请选择有效的 GLB 2.0 模型');
  let model;
  try{model=JSON.parse(await file.slice(20,jsonEnd).text());}
  catch{throw Error('GLB 场景描述无效');}
  const entries=paintableMaterials(model);
  if(!entries.length)throw Error('模型中没有使用 TEXCOORD_0 的三角网格');
  return entries;
}

async function checkArchive(file){
  if(file.size>1024*MiB)throw Error('涂装 ZIP 不能超过 1 GiB');
  if(file.size<22||new DataView(await file.slice(0,4).arrayBuffer()).getUint32(0,true)!==0x04034b50)
    throw Error('请选择有效的涂装 ZIP');
}

function fileSize(bytes){
  if(bytes<1024)return bytes+' B';
  if(bytes<MiB)return (bytes/1024).toFixed(1)+' KiB';
  return (bytes/MiB).toFixed(1)+' MiB';
}

function acceptFileDrop(host,enabled,receive){
  const hasFiles=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
  host.addEventListener('dragover',event=>{
    if(!hasFiles(event))return;
    event.preventDefault();
    const accepts=enabled();
    host.toggleAttribute('data-file-drop',accepts);
    event.dataTransfer.dropEffect=accepts?'copy':'none';
  });
  host.addEventListener('dragleave',event=>{
    if(!host.contains(event.relatedTarget))host.removeAttribute('data-file-drop');
  });
  host.addEventListener('drop',event=>{
    host.removeAttribute('data-file-drop');
    if(!hasFiles(event))return;
    event.preventDefault();
    if(enabled())receive([...event.dataTransfer.files]);
  });
}

function fileDialog({dialog,input,drop,label,size,choose,clear,close,submit,error,check,defaultLabel,defaultHint,optional,onFile,commit}){
  let selected=null,request=0,validating=false,working=false,invalid=false;
  function sync(){
    const pending=working||validating;
    close.disabled=working;
    choose.disabled=working;
    if(clear){clear.hidden=!selected&&!invalid;clear.disabled=working;}
    submit.disabled=pending||invalid||!optional&&!selected;
    label.textContent=selected?.name||defaultLabel;
    label.title=selected?.name||'';
    size.textContent=validating?'正在检查文件…':selected?fileSize(selected.size):defaultHint;
    drop.setAttribute('aria-busy',String(pending));
  }

  function reset(){
    request++;selected=null;input.value='';
    validating=false;invalid=false;error.textContent='';
    onFile?.(null);sync();
  }

  async function receive(files){
    if(!files.length||working||!dialog.open)return;
    const token=++request;
    if(files.length!==1){
      validating=false;invalid=true;
      error.textContent='一次请选择一个文件';sync();return;
    }
    const [file]=files;
    validating=true;invalid=false;error.textContent='';sync();
    try{
      const info=await check(file);
      if(token!==request||!dialog.open)return;
      selected=file;onFile?.(file,info);
    }catch(failure){
      if(token===request&&dialog.open){selected=null;onFile?.(null);invalid=true;error.textContent=failure.message;}
    }finally{
      if(token===request&&dialog.open){validating=false;sync();}
    }
  }

  choose.onclick=()=>input.click();
  input.onchange=()=>{const files=[...input.files];input.value='';void receive(files);};
  if(clear)clear.onclick=reset;
  close.onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(working)event.preventDefault();});
  dialog.addEventListener('close',()=>{
    if(!dialog.open){request++;selected=null;input.value='';drop.removeAttribute('data-file-drop');}
  });
  acceptFileDrop(drop,()=>dialog.open&&!working,files=>void receive(files));
  dialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();
    if(submit.disabled||working)return;
    working=true;error.textContent='';
    const title=submit.textContent;
    submit.textContent=optional?'正在创建…':'正在恢复…';sync();
    try{if(await commit(selected,error))dialog.close();}
    finally{working=false;submit.textContent=title;sync();}
  };
  return files=>{
    reset();dialog.showModal();
    if(files?.length)void receive(files);
  };
}

export function setupProjectFiles({canOpen,create,restore}){
  const byId=id=>document.getElementById(id);
  const name=byId('new-paint-name'),material=byId('new-paint-material'),sourceTextures=byId('new-paint-source-textures');
  const template=byId('new-paint-template'),templateRow=template.closest('label'),materialRow=material.closest('label');
  template.replaceChildren(new Option('示例模型','demo'),...Object.entries(modelTemplates).map(([id,title])=>new Option(title,id)));
  syncSelectMenu(template);
  let suggested=defaultProjectName;
  function suggest(next){
    if(!name.value.trim()||name.value===suggested)name.value=next;
    suggested=next;
  }
  function templateName(){
    return template.value==='demo'?defaultProjectName:modelTemplates[template.value]+' · PBR 涂装';
  }
  template.onchange=()=>suggest(templateName());
  const newDialog=fileDialog({
    dialog:byId('new-paint-dialog'),input:byId('new-paint-model'),drop:byId('new-paint-model-drop'),
    label:byId('new-paint-model-label'),size:byId('new-paint-model-size'),
    choose:byId('choose-new-paint-model'),clear:byId('clear-new-paint-model'),
    close:byId('new-paint-close'),submit:byId('new-paint-submit'),error:byId('new-paint-error'),
    check:checkGlb,defaultLabel:'导入自有模型',defaultHint:'拖入 GLB，或选择文件',optional:true,
    onFile(file,entries=[]){
      materialRow.hidden=!file;
      sourceTextures.closest('label').hidden=!file;
      sourceTextures.checked=true;
      templateRow.hidden=!!file;
      material.replaceChildren(new Option('自动选择','auto'),...entries.map(([id,title])=>new Option(title,id)));
      syncSelectMenu(material);
      suggest(file?.name.replace(/\.glb$/i,'').trim().slice(0,100)||templateName());
    },
    async commit(model,error){
      const value=name.value.trim();
      if(!value){error.textContent='请输入工程名称';name.focus();return false;}
      const chosen=model&&material.value!=='auto'?material.value:null;
      const modelTemplate=!model&&template.value!=='demo'?template.value:undefined;
      name.disabled=material.disabled=template.disabled=sourceTextures.disabled=true;
      syncSelectMenu(material);syncSelectMenu(template);
      try{return await create(value,model,error,chosen,modelTemplate,sourceTextures.checked);}
      finally{
        name.disabled=material.disabled=template.disabled=sourceTextures.disabled=false;
        syncSelectMenu(material);syncSelectMenu(template);
      }
    }
  });
  const importDialog=fileDialog({
    dialog:byId('paint-import-dialog'),input:byId('paint-import-file'),drop:byId('paint-import-drop'),
    label:byId('paint-import-label'),size:byId('paint-import-size'),choose:byId('choose-paint-import'),
    close:byId('paint-import-close'),submit:byId('paint-import-submit'),error:byId('paint-import-error'),
    check:checkArchive,defaultLabel:'拖入涂装 ZIP',defaultHint:'工程副本或交付包',commit:restore
  });

  function show(which,files){
    if(!canOpen())return;
    const menu=document.querySelector('.paint-menu[open]');
    if(menu){menu.open=false;menu.querySelector('summary')?.focus();}
    if(which==='glb'){
      template.value='demo';syncSelectMenu(template);
      name.value=suggested=defaultProjectName;
      newDialog(files);name.select();
    }else importDialog(files);
  }

  byId('new').onclick=()=>show('glb');
  byId('open-paint-import').onclick=()=>show('zip');
  const welcome=byId('empty'),error=byId('welcome-error');
  acceptFileDrop(welcome,canOpen,files=>{
    if(files.length!==1){error.textContent='一次请拖入一个文件';return;}
    const type=/\.(glb|zip)$/i.exec(files[0].name)?.[1]?.toLowerCase();
    if(!type){error.textContent='请拖入 GLB 模型或涂装 ZIP';return;}
    error.textContent='';show(type,files);
  });
}
