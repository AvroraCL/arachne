import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {APP_VERSION} from '../public/app-version.mjs';

const root=path.resolve(import.meta.dirname,'..');
const output=path.resolve(process.env.ARACHNE_PACKAGE_OUTPUT_DIR||path.join(root,'release'));
const suffix=process.env.ARACHNE_PACKAGE_INCLUDE_BLENDER==='1'?'-with-blender':'';
const bundle=path.join(output,'Arachne-'+APP_VERSION+'-windows-x64'+suffix);
const installer=bundle+'-setup.exe';
await fs.access(path.join(bundle,'Arachne.exe'));
const pending=installer+'.'+randomUUID()+'.tmp';
const option=process.platform==='win32'?'/':'-';
try{
  execFileSync(process.env.ARACHNE_MAKENSIS||'makensis',[
    option+'V2',option+'DVERSION='+APP_VERSION,option+'DPRODUCT_VERSION='+APP_VERSION.replace(/[^\d.]/g,'').replace(/\.\.+/,'.'),
    option+'DBUNDLE='+bundle,option+'DOUTPUT='+pending,path.join(root,'release-support/windows/installer.nsi')
  ],{stdio:'inherit',windowsHide:true});
  const hash=createHash('sha256');
  for await(const part of createReadStream(pending))hash.update(part);
  await fs.rename(pending,installer);
  await fs.writeFile(installer+'.sha256',hash.digest('hex')+'  '+path.basename(installer)+'\n');
  console.log(installer);
}finally{await fs.rm(pending,{force:true});}
