import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {describePaintChange,paintHistoryEntries} from './public/paint-history-state.mjs';

const limit=50;
const directions=['undo','redo'];
const snapshotName=/^([a-f0-9]{64})\.json\.gz$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
const empty=()=>({version:2,undo:[],redo:[]});
const snapshotFolder=folder=>path.join(folder,'history-snapshots');
const snapshotFile=(folder,hash)=>path.join(snapshotFolder(folder),hash+'.json.gz');
const invalid=()=>Object.assign(Error('工程历史记录无法读取，已保存的工程内容仍可打开'),{status:422,code:'EINVALIDHISTORY'});

function readIndex(folder){
  let index;
  try{index=JSON.parse(fs.readFileSync(path.join(folder,'history.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return empty();if(error instanceof SyntaxError)throw invalid();throw error;}
  if(!index||!directions.every(direction=>Array.isArray(index[direction])))throw invalid();
  if(index.version===undefined)return index;
  // Older releases can still save the current project after a downgrade.
  // A legacy edit writes these compatibility stacks, which then take priority.
  if(index.version===2&&directions.some(direction=>index[direction].length))return {undo:index.undo,redo:index.redo};
  const snapshots=index.snapshots;
  if(index.version!==2||!directions.every(direction=>Array.isArray(snapshots?.[direction])&&snapshots[direction].length<=limit&&snapshots[direction].every(entry=>
    entry&&typeof entry.hash==='string'&&/^[a-f0-9]{64}$/.test(entry.hash)&&
    typeof entry.label==='string'&&typeof entry.detail==='string')))throw invalid();
  return {version:2,undo:snapshots.undo,redo:snapshots.redo};
}

function saveSnapshot(folder,project){
  const {revision,updated,strokeSaveReceipts,...content}=project;
  const json=JSON.stringify(content),hash=digest(json),file=snapshotFile(folder,hash);
  if(fs.existsSync(file))return hash;
  fs.mkdirSync(snapshotFolder(folder),{recursive:true});
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{
    fs.writeFileSync(temporary,gzipSync(json,{level:1}),{flag:'wx',flush:true});
    fs.renameSync(temporary,file);
  }finally{fs.rmSync(temporary,{force:true});}
  return hash;
}

function loadSnapshot(folder,entry){
  try{
    const bytes=gunzipSync(fs.readFileSync(snapshotFile(folder,entry.hash)));
    if(digest(bytes)!==entry.hash)throw invalid();
    return JSON.parse(bytes.toString('utf8'));
  }catch(error){
    if(error.code==='EINVALIDHISTORY')throw error;
    if(error instanceof SyntaxError||['ENOENT','Z_DATA_ERROR','Z_BUF_ERROR'].includes(error.code))throw invalid();
    throw error;
  }
}

function migrate(folder,index,current){
  if(index.version===2)return index;
  const next=empty();
  for(const direction of directions){
    const states=index[direction].slice(-limit);
    next[direction]=states.map((state,i)=>{
      if(state?.id!==current.id)throw invalid();
      const neighbor=states[i+1]??current;
      const change=direction==='undo'?describePaintChange(state,neighbor):describePaintChange(neighbor,state);
      return {hash:saveSnapshot(folder,state),...change};
    });
  }
  return next;
}

export function appendProjectHistory(folder,before,after){
  const index=migrate(folder,readIndex(folder),before);
  const entry={hash:saveSnapshot(folder,before),...describePaintChange(before,after)};
  return {...index,undo:[...index.undo,entry].slice(-limit),redo:[]};
}

export function storedProjectHistory(index){
  return {version:2,undo:[],redo:[],snapshots:{undo:index.undo,redo:index.redo}};
}

export function listProjectHistory(folder,current){
  const index=readIndex(folder);
  if(index.version!==2)return paintHistoryEntries(current,index);
  const entries=direction=>index[direction].slice().reverse().map(({label,detail},i)=>({steps:i+1,label,detail}));
  return {revision:current.revision,undoCount:index.undo.length,redoCount:index.redo.length,undo:entries('undo'),redo:entries('redo')};
}

export function restoreProjectHistory(folder,current,direction,steps=1){
  if(!directions.includes(direction)||!Number.isInteger(steps)||steps<1||steps>limit)throw Error('历史操作需要 1–50 个完整步骤');
  const prior=readIndex(folder),from=prior[direction];
  if(!from.length&&steps===1)return null;
  if(steps>from.length)throw Error(`当前只能${direction==='undo'?'撤销':'重做'} ${from.length} 步`);
  const index=migrate(folder,prior,current),entries=index[direction];
  const start=entries.length-steps,target=entries[start],restored=loadSnapshot(folder,target);
  if(restored?.id!==current.id)throw invalid();
  restored.source=structuredClone(current.source);
  const reverse=direction==='undo'?'redo':'undo';
  let hash=saveSnapshot(folder,current);
  const returning=[];
  for(const entry of entries.slice(start).reverse()){
    returning.push({...entry,hash});
    hash=entry.hash;
  }
  return {restored,index:{...index,[direction]:entries.slice(0,start),[reverse]:[...index[reverse],...returning].slice(-limit)}};
}

export function pruneHistorySnapshots(folder,index){
  const store=snapshotFolder(folder);
  const retained=new Set(directions.flatMap(direction=>index[direction].map(entry=>entry.hash)));
  try{
    for(const name of fs.readdirSync(store)){
      const match=snapshotName.exec(name);
      if(match&&!retained.has(match[1]))fs.unlinkSync(path.join(store,name));
    }
  }catch(error){if(error.code!=='ENOENT')console.warn('无法清理已移出撤销历史的快照',error.code);}
}
