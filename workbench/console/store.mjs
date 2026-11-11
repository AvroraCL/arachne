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
export function projectDir(id){if(!/^[\w-]{1,100}$/.test(id))throw Error('项目ID无效');return path.join(DATA,'projects',id);}
export const read=id=>{const doc=JSON.parse(fs.readFileSync(path.join(projectDir(id),'project.json'),'utf8'));doc.source=resolveSource(doc.source);return doc;};
export const list=()=>fs.readdirSync(path.join(DATA,'projects')).filter(id=>fs.existsSync(path.join(projectDir(id),'project.json'))).map(id=>{const p=read(id);return {id:p.id,name:p.name,workflowType:p.workflowType,revision:p.revision,updated:p.updated,created:fs.statSync(projectDir(id)).birthtimeMs};}).sort((a,b)=>a.created-b.created);
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
export function forkProject(sourceId,snapshot,name,prepareAssets){
  const sourceDir=projectDir(sourceId);const id=crypto.randomUUID(),dir=projectDir(id),doc=clone(snapshot);
  doc.id=id;doc.name=name;doc.revision=0;doc.updated=new Date().toISOString();doc.source=resolveSource(doc.source);
  validate(doc);const assets=Object.values(doc.assets).map(a=>({a,file:path.join(sourceDir,'assets',path.basename(a.file))}));
  for(const {a,file} of assets)if(hash(file)!==a.sha256)throw Error('基线素材不完整或已改变');
  fs.mkdirSync(dir);
  try{
    const folder=path.join(dir,'assets');
    fs.mkdirSync(folder);
    for(const {a,file} of assets){fs.copyFileSync(file,path.join(folder,path.basename(a.file)));if(fs.existsSync(file+'.ttf'))fs.copyFileSync(file+'.ttf',path.join(folder,path.basename(a.file)+'.ttf'));}
    prepareAssets?.(folder);
    atomic(path.join(dir,'history.json'),{undo:[],redo:[]});
    writeProject(path.join(dir,'project.json'),doc);
    return doc;
  }catch(error){
    fs.rmSync(dir,{recursive:true,force:true});
    throw error;
  }
}
