import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {compileLibraryMaterial,evaluateBrushGraph,libraryOperation} from './public/paint-library.mjs';

const kinds=['materials','brushes','images'],sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const failure=(message,status=400,extra={})=>Object.assign(Error(message),{status,...extra});
const label=value=>{if(typeof value!=='string'||!value.trim()||value.length>100)throw failure('资源名称须为 1–100 个字符');return value.trim();};
function tags(value){
  if(!Array.isArray(value)||value.length>12)throw failure('每项资源最多 12 个标签');
  const seen=new Set(),result=[];
  for(const item of value){
    const tag=typeof item==='string'?item.trim():'';
    if(!tag||tag.length>24||/[\u0000-\u001f\u007f,，、;；]/.test(tag))throw failure('标签须为 1–24 个字符');
    const canonical=tag.normalize('NFKC').toLowerCase();
    if(!seen.has(canonical)){seen.add(canonical);result.push(tag);}
  }
  return result;
}
const key=value=>{if(typeof value!=='string'||!/^[\w-]{1,100}$/.test(value))throw failure('资源编号无效');return value;};
export function createPersonalLibrary({root,readProject,projectFolder,commitProject}){
  const index=path.join(root,'index.json'),blobs=path.join(root,'assets');
  function read(){if(!fs.existsSync(index))return {schemaVersion:1,revision:0,items:{}};const state=JSON.parse(fs.readFileSync(index,'utf8'));if(state.schemaVersion!==1||!Number.isInteger(state.revision)||!state.items)throw failure('个人库索引损坏',500);return state;}
  function expected(revision){const state=read();if(state.revision!==revision)throw failure('个人库已被其他窗口修改，请刷新后重试',409,{currentRevision:state.revision});return state;}
  function write(state){fs.mkdirSync(root,{recursive:true});const temporary=index+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify({...state,revision:state.revision+1},null,2)+'\n');fs.renameSync(temporary,index);return read();}
  function project(id,revision){const doc=readProject(key(id));if(doc.workflowType!=='pbr_paint')throw failure('请选择涂装工程');if(doc.revision!==revision)throw failure('工程修订已变化',409,{currentRevision:doc.revision});return doc;}
  function resource(state,id){const item=Object.hasOwn(state.items,key(id))&&state.items[id];if(!item)throw failure('个人资源不存在',404);return item;}
  function assetBytes(asset,file){
    if(!asset||!/^[a-f0-9]{64}$/.test(asset.id)||asset.sha256!==asset.id||asset.file!=='paint-'+asset.id+'.png')throw failure('图片素材记录无效');
    const bytes=fs.readFileSync(file);if(bytes.length>64*1024*1024||bytes.length<24||sha(bytes)!==asset.sha256||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(16)!==asset.width||bytes.readUInt32BE(20)!==asset.height)throw failure('图片素材指纹或尺寸已改变');return bytes;
  }
  function ensure(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file)){if(sha(fs.readFileSync(file))!==sha(bytes))throw failure('资源文件指纹变化');return;}const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,bytes,{flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
  function save({projectId,projectRevision,revision,kind,resourceId,name}){
    const state=expected(revision),doc=project(projectId,projectRevision);if(!kinds.includes(kind))throw failure('资源类型无效');if(Object.keys(state.items).length>=1000)throw failure('个人库最多 1000 项');
    key(resourceId);const source=kind==='images'?doc.paint.assets[resourceId]:doc.paint[kind]?.[resourceId];if(!source)throw failure('项目资源不存在',404);
    const entry={id:crypto.randomUUID(),kind,name:label(name??source.name),assets:{},updated:new Date().toISOString()},dependencies=new Set();
    if(kind==='images'){entry.image=resourceId;dependencies.add(resourceId);}else{entry.graph=structuredClone(source.graph);if(kind==='materials'){compileLibraryMaterial(entry.graph,doc.paint.assets);for(const node of entry.graph.nodes)if(node.type==='image'&&node.params.asset)dependencies.add(node.params.asset);}else evaluateBrushGraph(entry.graph);}
    const copies=[];for(const id of dependencies){const asset=doc.paint.assets[id];if(!asset)throw failure('材质图片依赖不存在');const bytes=assetBytes(asset,path.join(projectFolder(doc.id),'assets',path.basename(asset.file)));entry.assets[id]=structuredClone(asset);copies.push([path.join(blobs,asset.file),bytes]);}
    for(const [file,bytes] of copies)ensure(file,bytes);state.items[entry.id]=entry;return {state:write(state),item:entry};
  }
  function importResource({projectId,projectRevision,revision,id}){
    const state=expected(revision),entry=resource(state,id),doc=project(projectId,projectRevision),copies=[];
    for(const asset of Object.values(entry.assets)){const bytes=assetBytes(asset,path.join(blobs,path.basename(asset.file)));const existing=doc.paint.assets[asset.id];if(existing&&(existing.sha256!==asset.sha256||existing.file!==asset.file))throw failure('项目素材编号冲突');copies.push([entry.kind==='images'?{...asset,name:entry.name}:asset,bytes]);}
    const resourceId=entry.kind==='images'?entry.image:crypto.randomUUID();
    const document=commitProject(doc.id,projectRevision,next=>{
      for(const [asset] of copies)next.paint.assets[asset.id]??=structuredClone(asset);
      if(entry.kind!=='images')libraryOperation(next.paint,{library:entry.kind,id:resourceId,action:'create',patch:{name:entry.name,graph:structuredClone(entry.graph)}});
      for(const [asset,bytes] of copies)ensure(path.join(projectFolder(doc.id),'assets',asset.file),bytes);
      return next;
    },'从个人库导入独立资源副本');
    return {document,resource:{kind:entry.kind,id:resourceId}};
  }
  function update({revision,id,patch}){
    const state=expected(revision),entry=resource(state,id);
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||
       Object.keys(patch).some(field=>!['name','tags','favorite'].includes(field)))throw failure('个人资源属性无效');
    const next={...entry};
    if(Object.hasOwn(patch,'name'))next.name=label(patch.name);
    if(Object.hasOwn(patch,'tags')){
      const checked=tags(patch.tags);
      if(checked.length)next.tags=checked;else delete next.tags;
    }
    if(Object.hasOwn(patch,'favorite')){
      if(typeof patch.favorite!=='boolean')throw failure('收藏状态无效');
      if(patch.favorite)next.favorite=true;else delete next.favorite;
    }
    if(JSON.stringify(next)===JSON.stringify(entry))return state;
    state.items[entry.id]={...next,updated:new Date().toISOString()};
    return write(state);
  }
  function rename({revision,id,name}){return update({revision,id,patch:{name}});}
  function remove({revision,id}){const state=expected(revision);resource(state,id);delete state.items[id];return write(state);}
  function assetFile(id,assetId){const entry=resource(read(),id);key(assetId);const asset=Object.hasOwn(entry.assets,assetId)&&entry.assets[assetId];if(!asset)throw failure('资源图片不存在',404);const file=path.join(blobs,path.basename(asset.file));assetBytes(asset,file);return file;}
  return {read,save,importResource,rename,update,remove,assetFile};
}
