import {execFileSync} from 'node:child_process';
import {mkdir,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const workbench=path.resolve(import.meta.dirname,'..');
const nativeSource=path.join(workbench,'native-paint','lib.rs');

export function paintKernelName(platform=process.platform){
  if(platform==='win32')return 'arachne_paint.dll';
  if(platform==='darwin')return 'libarachne_paint.dylib';
  return 'libarachne_paint.so';
}

export async function buildPaintKernel(destination=workbench){
  await mkdir(destination,{recursive:true});
  const library=path.join(destination,paintKernelName());
  const temporary=path.join(destination,'.paint-kernel-'+randomUUID()+path.extname(library));
  const compiler=process.env.ARACHNE_RUSTC||'rustc';
  try{
    execFileSync(compiler,[nativeSource,'--crate-name','arachne_paint','--crate-type','cdylib','--edition','2021',
      '-C','opt-level=3','-C','panic=abort','-o',temporary],{
      stdio:'inherit',windowsHide:true,env:process.platform==='darwin'?{...process.env,MACOSX_DEPLOYMENT_TARGET:'14.0'}:process.env
    });
    await rename(temporary,library);
  }catch(error){
    if(error.code==='ENOENT')throw Error('找不到 Rust 编译器 rustc，请安装 Rust 或设置 ARACHNE_RUSTC',{cause:error});
    throw error;
  }finally{await rm(temporary,{force:true});}
  return library;
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)
  console.log(await buildPaintKernel(process.argv[2]&&path.resolve(process.argv[2])));
