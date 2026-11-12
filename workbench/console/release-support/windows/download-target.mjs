import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

function revision(file){
  const stat=fs.lstatSync(file,{bigint:true,throwIfNoEntry:false});
  if(!stat)return null;
  if(!stat.isFile())throw Error('请选择普通文件作为下载目标');
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export function downloadTarget(destination){
  if(!path.isAbsolute(destination))throw Error('下载位置无效');
  const original=revision(destination);
  const temporary=path.join(path.dirname(destination),'.arachne-'+randomUUID()+'.download');
  return {temporary,destination,finish(){
    if(revision(destination)!==original)throw Error('目标文件在下载期间发生变化');
    if(original!==null){fs.renameSync(temporary,destination);return;}
    try{fs.linkSync(temporary,destination);}
    catch(error){
      if(!['ENOSYS','ENOTSUP','EOPNOTSUPP','EPERM','EXDEV','EMLINK','EINVAL'].includes(error.code))throw error;
      fs.copyFileSync(temporary,destination,fs.constants.COPYFILE_EXCL);
    }
    fs.unlinkSync(temporary);
  }};
}
