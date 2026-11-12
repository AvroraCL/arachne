import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const pending='.save-pending.json';
const files=['history.json','project.json'];
const hex=/^[a-f0-9]{64}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>Object.assign(Error('工程的待恢复保存记录损坏，原文件已保留'),{status:422,code:'EINVALIDPROJECT'});

function fileDigest(file){
  const fd=fs.openSync(file,'r'),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
  try{
    for(let count;(count=fs.readSync(fd,buffer,0,buffer.length,null));)
      hash.update(buffer.subarray(0,count));
    return hash.digest('hex');
  }finally{fs.closeSync(fd);}
}

function apply(folder,record,recovering){
  const stage=path.join(folder,record.stage);
  const entries=files.map(name=>{
    const source=path.join(stage,name),target=path.join(folder,name);
    return {source,target,staged:fs.existsSync(source),sha256:record.files[name]};
  });
  if(recovering){
    for(const {source,target,staged,sha256} of entries){
      try{if(fileDigest(staged?source:target)!==sha256)throw invalid();}
      catch(error){if(error.code==='ENOENT')throw invalid();throw error;}
    }
  }
  for(const {source,target,staged} of entries)if(staged)fs.renameSync(source,target);
  fs.unlinkSync(path.join(folder,pending));
  try{fs.rmdirSync(stage);}
  catch(error){if(error.code!=='ENOENT')console.warn('无法清理已完成的工程保存暂存目录',error.code);}
}

export function recoverProjectTransaction(folder){
  const marker=path.join(folder,pending);
  if(!fs.existsSync(marker))return false;
  let record;
  try{record=JSON.parse(fs.readFileSync(marker,'utf8'));}
  catch(error){
    if(error.code==='ENOENT')return false;
    if(error instanceof SyntaxError)throw invalid();
    throw error;
  }
  if(record?.version!==1||typeof record.stage!=='string'||!/^\.save-[\da-z]{6}$/i.test(record.stage)||
     !files.every(name=>typeof record.files?.[name]==='string'&&hex.test(record.files[name])))throw invalid();
  apply(folder,record,true);
  return true;
}

export function saveProjectTransaction(folder,project,history){
  // Both replacements are ready before publishing the journal. Opening the
  // project can then finish either replacement after an interrupted save.
  recoverProjectTransaction(folder);
  const stage=fs.mkdtempSync(path.join(folder,'.save-'));
  let published=false;
  try{
    const content=[JSON.stringify(history)+'\n',JSON.stringify(project,null,2)+'\n'];
    const record={version:1,stage:path.basename(stage),files:{}};
    files.forEach((name,index)=>{
      const value=content[index];
      fs.writeFileSync(path.join(stage,name),value,{flag:'wx',flush:true});
      record.files[name]=sha(value);
    });
    const marker=path.join(stage,pending);
    fs.writeFileSync(marker,JSON.stringify(record)+'\n',{flag:'wx',flush:true});
    fs.renameSync(marker,path.join(folder,pending));
    published=true;
    apply(folder,record,false);
  }finally{
    if(!published)fs.rmSync(stage,{recursive:true,force:true});
  }
}
