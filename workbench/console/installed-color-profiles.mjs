import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {outputProfileLimit,outputProfileMode} from './public/image-output-profile.mjs';

export function systemProfileFolders(){
  if(process.platform==='darwin')return [
    ['个人',path.join(os.homedir(),'Library/ColorSync/Profiles')],
    ['本机','/Library/ColorSync/Profiles'],['系统','/System/Library/ColorSync/Profiles']
  ];
  if(process.platform==='win32')return [['系统',path.join(process.env.SystemRoot||'C:\\Windows','System32','spool','drivers','color')]];
  return [];
}

async function profileHeader(file){
  const stat=await file.stat();
  if(!stat.isFile()||stat.size<132||stat.size>outputProfileLimit)return null;
  const header=Buffer.alloc(128);
  if((await file.read(header,0,128,0)).bytesRead!==128)return null;
  // Device links, named-color tables and unsupported channel layouts cannot be copy targets.
  if(!['mntr','scnr','prtr','spac','abst'].includes(header.toString('ascii',12,16)))return null;
  try{return {mode:outputProfileMode(header,stat.size),size:stat.size};}
  catch{return null;}
}

export function installedProfileCatalog(folders=systemProfileFolders()){
  let listed=new Map();
  async function list(){
    const next=new Map(),choices=[];
    async function visit(group,root,dir){
      let entries;
      try{entries=await fs.readdir(dir,{withFileTypes:true});}
      catch(error){if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))return;throw error;}
      for(const entry of entries){
        const filename=path.join(dir,entry.name);
        if(entry.isDirectory()){await visit(group,root,filename);continue;}
        if(!entry.isFile()||!/\.(icc|icm)$/i.test(entry.name))continue;
        let file;
        try{
          file=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
          const info=await profileHeader(file);
          if(!info)continue;
          const id=createHash('sha256').update(filename).digest('hex');
          next.set(id,filename);
          choices.push({id,group,name:path.relative(root,filename),mode:info.mode});
        }catch(error){if(!['ENOENT','EACCES','EPERM','ELOOP'].includes(error.code))throw error;}
        finally{await file?.close();}
      }
    }
    for(const [group,root] of folders)await visit(group,root,root);
    listed=next;
    return choices.sort((a,b)=>a.name.localeCompare(b.name,'zh-Hans',{numeric:true}));
  }
  async function read(id){
    const filename=listed.get(id);
    if(!filename)throw Object.assign(Error('本机配置已变化，请重新打开配置列表'),{status:404});
    let file;
    try{
      file=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      const info=await profileHeader(file);
      if(!info)throw Error('此文件已变更或不支持颜色输出');
      const bytes=await file.readFile();
      outputProfileMode(bytes,bytes.length);
      return bytes;
    }catch(error){
      if(['ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes(error.code))throw Object.assign(Error('此本机配置已移动或无法读取，请重新选择'),{status:404});
      throw error;
    }finally{await file?.close();}
  }
  return {list,read};
}
