import {paintHistoryEntries,travelPaintHistory} from './public/paint-history-state.mjs';
import {dataDirectory} from './release-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {clone,validate} from './public/model.mjs';
import {resolveSource,portableSource} from './workspace-paths.mjs';

export const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const DATA=dataDirectory(ROOT);
fs.mkdirSync(path.join(DATA,'projects'),{recursive:true});
const writeProject=(file,doc)=>atomic(file,{...doc,source:portableSource(doc.source)});
export const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file);}
const projectIdPattern=/^[\w-]{1,100}$/;
export function projectDir(id){
  if(!projectIdPattern.test(id))throw Error('工程 ID 无效');
  return path.join(DATA,'projects',id);
}
const projectFile=id=>path.join(projectDir(id),'project.json');
export function projectFileVersion(id){
  const stat=fs.statSync(projectFile(id),{bigint:true,throwIfNoEntry:false});
  return stat?.isFile()?`${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`:null;
}
function readProjectFile(id){
  const file=projectFile(id);
  let doc;
  try{doc=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){
    if(['ENOENT','ENOTDIR'].includes(error.code))
      throw Object.assign(Error('找不到该工程'),{status:404,code:'ENOENT'});
    if(!(error instanceof SyntaxError))throw error;
  }
  if(doc?.id!==id||typeof doc.name!=='string'||!doc.source||typeof doc.source!=='object'||Array.isArray(doc.source))
    throw Object.assign(Error('工程文件损坏，无法打开'),{status:422,code:'EINVALIDPROJECT'});
  return doc;
}
export function read(id){
  const doc=readProjectFile(id);
  doc.source=resolveSource(doc.source);
  return doc;
}
export function list(){
  const projects=[];
  for(const entry of fs.readdirSync(path.join(DATA,'projects'),{withFileTypes:true})){
    if(!projectIdPattern.test(entry.name)||!entry.isDirectory()&&!entry.isSymbolicLink())continue;
    try{
      const {id,name,workflowType,revision,updated}=readProjectFile(entry.name);
      const created=fs.statSync(projectDir(id)).birthtimeMs;
      projects.push({id,name,workflowType,revision,updated,created});
    }catch(error){
      if(!['ENOENT','EINVALIDPROJECT'].includes(error.code))throw error;
    }
  }
  return projects.sort((a,b)=>a.created-b.created);
}
function history(id){const file=path.join(projectDir(id),'history.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{undo:[],redo:[]};}
function content(p){const q=clone(p);delete q.revision;delete q.updated;return q;}
export function commit(id,expected,mutator,summary){
  const before=read(id);if(expected!==before.revision){const e=Error('项目已被修改，请读取最新版本再操作');e.status=409;throw e;}
  const next=mutator(clone(before));validate(next);const h=history(id);h.undo.push(content(before));h.undo=h.undo.slice(-50);h.redo=[];
  next.revision=before.revision+1;next.updated=new Date().toISOString();
  atomic(path.join(projectDir(id),'history.json'),h);writeProject(path.join(projectDir(id),'project.json'),next);
  fs.appendFileSync(path.join(projectDir(id),'operations.jsonl'),JSON.stringify({revision:next.revision,time:next.updated,summary})+'\n');return next;
}
export function projectHistory(id){const current=read(id);return paintHistoryEntries(current,history(id));}
export function travel(id,expected,direction,steps=1){
  const p=read(id);if(expected!==p.revision){const e=Error('版本已改变');e.status=409;throw e;}
  const result=travelPaintHistory(p,history(id),direction,steps);if(!result.changed)return p;
  const restored=result.restored;restored.revision=p.revision+1;restored.updated=new Date().toISOString();validate(restored);
  atomic(path.join(projectDir(id),'history.json'),result.history);writeProject(path.join(projectDir(id),'project.json'),restored);
  fs.appendFileSync(path.join(projectDir(id),'operations.jsonl'),JSON.stringify({revision:restored.revision,time:restored.updated,summary:direction,...(steps>1?{steps}:{})})+'\n');return restored;
}
export async function forkProject(sourceId,snapshot,name,prepareAssets){
  const sourceDir=projectDir(sourceId);const id=crypto.randomUUID(),dir=projectDir(id),doc=clone(snapshot);
  doc.id=id;doc.name=name;doc.revision=0;doc.updated=new Date().toISOString();doc.source=resolveSource(doc.source);
  validate(doc);const assets=Object.values(doc.assets).map(a=>({a,file:path.join(sourceDir,'assets',path.basename(a.file))}));
  for(const {a,file} of assets)if(hash(file)!==a.sha256)throw Error('基线素材不完整或已改变');
  fs.mkdirSync(dir);
  try{
    const folder=path.join(dir,'assets');
    fs.mkdirSync(folder);
    for(const {a,file} of assets){fs.copyFileSync(file,path.join(folder,path.basename(a.file)));if(fs.existsSync(file+'.ttf'))fs.copyFileSync(file+'.ttf',path.join(folder,path.basename(a.file)+'.ttf'));}
    if(prepareAssets)await prepareAssets(folder);
    atomic(path.join(dir,'history.json'),{undo:[],redo:[]});
    writeProject(path.join(dir,'project.json'),doc);
    return doc;
  }catch(error){
    fs.rmSync(dir,{recursive:true,force:true});
    throw error;
  }
}
