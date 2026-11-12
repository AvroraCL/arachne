import {syncSelectMenu} from './paint-select.mjs';
import {modelTemplates} from './model-templates.mjs';
import {parseGltf,resolveGltfFiles} from './gltf-files.mjs';

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

const modelExtension=/\.(glb|gltf|obj)$/i;
const fileNameKey=name=>name.normalize('NFC').toLowerCase();

async function objMaterials(file){
  const probe=await file.slice(0,256*1024).arrayBuffer();
  let encoding='utf-8';
  try{new TextDecoder(encoding,{fatal:true}).decode(probe,{stream:probe.byteLength<file.size});}
  catch{encoding='gb18030';}
  const materials=new Set();
  let pending='',continued='',material='默认材质';
  const read=line=>{
    const value=continued+line.split('#',1)[0].trim();
    if(value.length>65536)throw Error('OBJ 中有过长的指令');
    if(value.endsWith('\\')){continued=value.slice(0,-1)+' ';return;}
    continued='';
    const match=/^(usemtl|f)\s+(.+)$/.exec(value);
    if(!match)return;
    if(match[1]==='usemtl')material=match[2].replace(/^"|"$/g,'')||'默认材质';
    else if(/\s/.test(match[2])&&match[2].trim().split(/\s+/).every(corner=>/^[^/]+\/[^/]+/.test(corner)))
      materials.add(material);
  };
  const reader=file.stream().pipeThrough(new TextDecoderStream(encoding,{fatal:true})).getReader();
  try{
    for(let chunk=await reader.read();!chunk.done;chunk=await reader.read()){
      const lines=(pending+chunk.value).split('\n');
      pending=lines.pop();
      if(pending.length>65536)throw Error('OBJ 中有过长的指令');
      for(const line of lines)read(line);
    }
    if(pending)read(pending);
  }finally{await reader.cancel().catch(()=>{});}
  if(!materials.size)throw Error('OBJ 网格没有可用的 UV，请先展开 UV');
  return [...materials].map(name=>[name,name]);
}

async function checkModel(files){
  const models=files.filter(file=>modelExtension.test(file.name));
  if(models.length!==1)throw Error('请选择一个 GLB、glTF 或 OBJ 模型');
  const [file]=models;
  if(/\.glb$/i.test(file.name)){
    if(files.length!==1)throw Error('GLB 请单独选择，模型已包含配套文件');
    return {file,format:'glb',entries:await checkGlb(file),attachments:[],size:file.size};
  }
  const format=/\.gltf$/i.test(file.name)?'gltf':'obj',label=format==='obj'?'OBJ':'glTF';
  const sidecarExtension=format==='obj'?/\.(mtl|png|jpe?g|webp)$/i:/\.(bin|png|jpe?g|webp)$/i;
  const attachments=files.filter(item=>item!==file);
  if(attachments.length>24||attachments.some(item=>!sidecarExtension.test(item.name)))
    throw Error(label+' 可同时选择最多 24 个 '+(format==='obj'?'MTL':'BIN')+'、PNG、JPEG 或 WebP 文件');
  if(new Set(attachments.map(item=>fileNameKey(item.name))).size!==attachments.length)
    throw Error('配套文件不能重名');
  const size=files.reduce((bytes,item)=>bytes+item.size,0);
  if(size>128*MiB)throw Error(label+' 和配套文件合计不能超过 128 MiB');
  if(format==='obj')return {file,format,entries:await objMaterials(file),attachments,size};
  const model=parseGltf(await file.text()),entries=paintableMaterials(model);
  if(!entries.length)throw Error('模型中没有使用 TEXCOORD_0 的三角网格');
  resolveGltfFiles(model,attachments);
  return {file,format,entries,attachments,size};
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
  let selected=null,request=0,validating=false,working=false,invalid=false,staged=[];
  const chooseLabel=choose.textContent;
  function sync(){
    const pending=working||validating;
    close.disabled=working;
    choose.disabled=working;
    if(clear){clear.hidden=!selected&&!invalid;clear.disabled=working;}
    submit.disabled=pending||invalid||!optional&&!selected;
    const file=selected?.file||(!validating&&staged.find(item=>modelExtension.test(item.name)));
    label.textContent=file?.name||defaultLabel;
    label.title=file?.name||'';
    if(optional)choose.textContent=file&&!/\.glb$/i.test(file.name)?'添加文件…':chooseLabel;
    size.textContent=validating?'正在检查文件…':selected?
      [fileSize(selected.size),selected.attachments?.length?selected.attachments.length+' 个配套文件':''].filter(Boolean).join(' · '):defaultHint;
    size.title=selected?.attachments?.map(file=>file.name).join('\n')||'';
    drop.setAttribute('aria-busy',String(pending));
  }

  function reset(){
    request++;selected=null;staged=[];input.value='';
    validating=false;invalid=false;error.textContent='';
    onFile?.(null);sync();
  }

  async function receive(files){
    if(!files.length||working||!dialog.open)return;
    const token=++request;
    if(optional){
      const adding=staged.some(file=>modelExtension.test(file.name)&&!/\.glb$/i.test(file.name))&&
        !files.some(file=>modelExtension.test(file.name));
      const keys=new Set(files.map(file=>fileNameKey(file.name)));
      staged=adding?[...staged.filter(file=>!keys.has(fileNameKey(file.name))),...files]:files;
      files=staged;
    }
    validating=true;invalid=false;error.textContent='';sync();
    try{
      const next=await check(files);
      if(token!==request||!dialog.open)return;
      selected=next;onFile?.(next);
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
    if(!dialog.open){request++;selected=null;staged=[];input.value='';drop.removeAttribute('data-file-drop');}
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

export function setupProjectFiles({canOpen,create,restore,notice}){
  const byId=id=>document.getElementById(id);
  const name=byId('new-paint-name'),material=byId('new-paint-material'),sourceTextures=byId('new-paint-source-textures');
  const template=byId('new-paint-template'),templateRow=template.closest('label'),materialRow=material.closest('label');
  const upAxis=byId('new-paint-up-axis'),upAxisRow=upAxis.closest('label'),modelHint=byId('new-paint-sidecar-hint');
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
    check:checkModel,defaultLabel:'导入自有模型',defaultHint:'拖入 GLB、glTF 或 OBJ 及配套文件',optional:true,
    onFile(model){
      materialRow.hidden=!model;
      upAxisRow.hidden=model?.format!=='obj';
      modelHint.hidden=!model||model.format==='glb';
      modelHint.textContent=model?.format==='obj'?'可同时选择 OBJ、MTL 和引用的图片。':'请一并选择 glTF 引用的 BIN 和图片。';
      sourceTextures.closest('label').hidden=!model;
      sourceTextures.checked=true;
      upAxis.value='y';syncSelectMenu(upAxis);
      templateRow.hidden=!!model;
      material.replaceChildren(new Option('自动选择',''),...(model?.entries||[]).map(([id,title])=>new Option(title,id)));
      syncSelectMenu(material);
      suggest(model?.file.name.replace(modelExtension,'').trim().slice(0,100)||templateName());
    },
    async commit(model,error){
      const value=name.value.trim();
      if(!value){error.textContent='请输入工程名称';name.focus();return false;}
      const chosen=model&&material.value!==''?material.value:null;
      const modelTemplate=!model&&template.value!=='demo'?template.value:undefined;
      name.disabled=material.disabled=template.disabled=sourceTextures.disabled=upAxis.disabled=true;
      syncSelectMenu(material);syncSelectMenu(template);syncSelectMenu(upAxis);
      try{return await create(value,model,error,chosen,modelTemplate,sourceTextures.checked,upAxis.value);}
      finally{
        name.disabled=material.disabled=template.disabled=sourceTextures.disabled=upAxis.disabled=false;
        syncSelectMenu(material);syncSelectMenu(template);syncSelectMenu(upAxis);
      }
    }
  });
  const importDialog=fileDialog({
    dialog:byId('paint-import-dialog'),input:byId('paint-import-file'),drop:byId('paint-import-drop'),
    label:byId('paint-import-label'),size:byId('paint-import-size'),choose:byId('choose-paint-import'),
    close:byId('paint-import-close'),submit:byId('paint-import-submit'),error:byId('paint-import-error'),
    async check(files){
      if(files.length!==1)throw Error('一次请选择一个涂装 ZIP');
      const [file]=files;
      await checkArchive(file);
      return {file,size:file.size};
    },
    defaultLabel:'拖入涂装 ZIP',defaultHint:'工程副本或交付包',commit:(archive,error)=>restore(archive.file,error)
  });

  function show(which,files){
    if(!canOpen())return;
    const menu=document.querySelector('.paint-menu[open]');
    if(menu){menu.open=false;menu.querySelector('summary')?.focus();}
    if(which==='model'){
      template.value='demo';syncSelectMenu(template);
      name.value=suggested=defaultProjectName;
      newDialog(files);name.select();
    }else importDialog(files);
  }

  byId('new').onclick=()=>show('model');
  byId('open-paint-import').onclick=()=>show('zip');
  const welcome=byId('empty'),error=byId('welcome-error'),workspace=byId('workspace');
  const importType=files=>files.some(file=>modelExtension.test(file.name))?'model':
    files.some(file=>/\.zip$/i.test(file.name))?'zip':'';
  acceptFileDrop(welcome,canOpen,files=>{
    const type=importType(files);
    if(!type){error.textContent='请拖入 GLB、glTF、OBJ 或涂装 ZIP';return;}
    error.textContent='';show(type,files);
  });
  workspace.addEventListener('dragover',event=>{
    if(!event.defaultPrevented&&event.dataTransfer?.types.includes('Files')){
      event.preventDefault();event.dataTransfer.dropEffect=canOpen()?'copy':'none';
    }
  });
  workspace.addEventListener('drop',event=>{
    const files=[...(event.dataTransfer?.files||[])],type=importType(files);
    if(!type)return;
    event.preventDefault();event.stopPropagation();
    if(!canOpen()){notice?.('请结束当前操作后再导入工程或模型');return;}
    show(type,files);
  },{capture:true});
}
