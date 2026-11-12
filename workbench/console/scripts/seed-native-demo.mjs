import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,atomic,projectDir} from '../store.mjs';
import {nativeDemoProjectId} from '../demo-source.mjs';
import {registerGlb,describeGlbRegistration} from '../model-registration.mjs';
import {pythonExecutable} from '../python-runtime.mjs';
import {portableSource} from '../workspace-paths.mjs';

const execute=promisify(execFile);
const demo=path.join(ROOT,'.demo-native');
const exists=file=>fs.access(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

export async function nativeDemoTemplate(python=pythonExecutable()){
  const template=path.join(demo,'project.json');
  if(!await exists(template)){
    const scratch=await fs.mkdtemp(path.join(ROOT,'.demo-staging-'));
    try{
      const input=path.join(scratch,'demo.glb');
      await execute(python,[path.join(import.meta.dirname,'generate-demo-glb.py'),input],{windowsHide:true,timeout:20000});
      const staging=await registerGlb(input,scratch,{python});
      const document=await describeGlbRegistration(demo,nativeDemoProjectId,staging);
      atomic(path.join(staging,'project.json'),{...document,source:portableSource(document.source),
        name:'示例模型 · PBR 涂装',revision:0,updated:new Date().toISOString()});
      try{await fs.rename(staging,demo);}
      catch(error){
        if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code)||!await exists(template))throw error;
      }
    }finally{await fs.rm(scratch,{recursive:true,force:true});}
  }
  const [document,verified]=await Promise.all([read(template),describeGlbRegistration(demo,nativeDemoProjectId)]);
  const expected=portableSource(verified.source);
  if(document.id!==nativeDemoProjectId||document.revision!==0||JSON.stringify(document.source)!==JSON.stringify(expected))
    throw Error('原生示例模型或登记文件发生变化，请使用干净副本重新生成');
  return document;
}

if(import.meta.main){
  const document=await nativeDemoTemplate(),folder=projectDir(document.id);
  if(!await exists(path.join(folder,'project.json'))){
    atomic(path.join(folder,'history.json'),{undo:[],redo:[]});
    atomic(path.join(folder,'project.json'),document);
  }
  console.log('原生 GLB 示例模型已就绪。');
}
