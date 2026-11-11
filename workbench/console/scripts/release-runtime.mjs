import fs from 'node:fs/promises';
import {accessSync,constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {demoProjectId} from '../demo-source.mjs';
import {APP_VERSION} from '../public/app-version.mjs';

const consoleRoot=path.resolve(import.meta.dirname,'..'),workspace=path.resolve(consoleRoot,'../..');
const resources=path.resolve(workspace,'..');
export const userRoot=path.resolve(process.env.ARACHNE_USER_DATA_DIR||path.join(os.homedir(),'Library/Application Support/Arachne/Public Workbench'));
const data=path.join(userRoot,'data'),record=path.join(userRoot,'current-server.json');
const seedId=demoProjectId;
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function write(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n');await fs.rename(tmp,file);}
async function exists(file){return fs.access(file).then(()=>true,()=>false);}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function health(url){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1000)});return r.ok&&await r.json();}catch{return null;}}
async function portAvailable(port){const socket=net.createServer();try{socket.listen(port,'127.0.0.1');await once(socket,'listening');return true;}catch{return false;}finally{socket.close();}}

export async function startRelease({signal}={}){
  signal?.throwIfAborted();
  const build=await json(path.join(resources,'build-info.json'));
  if(build.version!==APP_VERSION||typeof build.buildId!=='string'||!/^[a-f0-9-]{36}$/i.test(build.buildId))throw Error('应用构建标识无效，请重新解压完整发布包');
  await fs.mkdir(data,{recursive:true});
  const ownerFile=path.join(data,'server-lock.json');
  if(await exists(ownerFile)){
    const owner=await json(ownerFile);
    if(alive(owner.pid)){
      const current=await health(owner.url);
      if(!current||current.version!==APP_VERSION||current.buildId!==build.buildId)throw Error('另一个构建正在使用工程目录，请先退出该版本');
      const result={url:owner.url+'/paint.html',version:APP_VERSION,data,owned:false};await write(record,result);return result;
    }
  }
  const aliasesFile=path.join(userRoot,'install-roots.json');let previous=[];
  if(await exists(aliasesFile)){const value=await json(aliasesFile);if(!Array.isArray(value.roots)||value.roots.length>32)throw Error('安装路径记录无效');previous=value.roots;}
  const roots=[...new Set([...previous,workspace])].filter(p=>typeof p==='string'&&path.isAbsolute(p)&&p!==path.parse(p).root).slice(-32);
  await write(aliasesFile,{roots});
  const python=path.join(resources,'runtime/python/bin/python3.12');
  const browser=path.join(resources,'runtime/browser/chrome-headless-shell');
  const blender=[process.env.ARACHNE_BLENDER,'/Applications/Blender.app/Contents/MacOS/Blender',path.join(os.homedir(),'Applications/Blender.app/Contents/MacOS/Blender')].find(p=>p&&execFileExists(p));
  if(!blender)throw Error('需要本机 Blender。请将 Blender 安装到「应用程序」，然后重新打开阿拉克涅。');
  if(!await exists(python)||!await exists(browser))throw Error('内置运行时不完整，请重新解压完整发布包');
  const env={...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_PATH_ALIASES:aliasesFile,ARACHNE_PYTHON:python,ARACHNE_BLENDER:blender,ARACHNE_BROWSER:browser,ARACHNE_BUILD_ID:build.buildId,PYTHONHOME:path.dirname(path.dirname(python)),PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'};
  delete env.PYTHONPATH;delete env.VIRTUAL_ENV;
  execFileSync(python,['-c','import numpy,PIL,fontTools'],{env,stdio:'pipe',timeout:15000});
  const seed=path.join(consoleRoot,'seed');
  if(!await exists(path.join(data,'projects',seedId,'project.json'))){
    await fs.mkdir(path.join(data,'projects'),{recursive:true});await fs.cp(path.join(seed,'projects',seedId),path.join(data,'projects',seedId),{recursive:true,errorOnExist:true,force:false});
  }
  if(await exists(path.join(seed,'viewport')))for(const folder of await fs.readdir(path.join(seed,'viewport'))){
    const target=path.join(data,'viewport',folder);if(!await exists(target))await fs.cp(path.join(seed,'viewport',folder),target,{recursive:true});
  }
  signal?.throwIfAborted();
  let port=Number(process.env.ARACHNE_PORT||8766);
  if(!Number.isInteger(port)||port<1024||port>65505)throw Error('启动端口无效');
  let available=false;
  for(let n=0;n<30;n++,port++)if(await portAvailable(port)){available=true;break;}
  if(!available)throw Error('本机启动端口均被占用，请退出不使用的工作台后重试');
  const url='http://127.0.0.1:'+port;
  await fs.mkdir(path.join(userRoot,'logs'),{recursive:true});const log=await fs.open(path.join(userRoot,'logs',APP_VERSION+'.log'),'a');
  const child=spawn(process.execPath,[path.join(consoleRoot,'server.mjs'),'--port',String(port)],{cwd:consoleRoot,env,stdio:['ignore',log.fd,log.fd]});await log.close();
  let failed=null;child.once('error',error=>failed=error);const exit=once(child,'exit').catch(()=>[]);
  async function stop(){if(child.exitCode===null)child.kill('SIGTERM');await exit;}
  try{
    const end=Date.now()+30000;let current;
    while(Date.now()<end){signal?.throwIfAborted();if(failed)throw failed;if(child.exitCode!==null)throw Error('本机服务启动失败，请查看日志');current=await health(url);if(current?.version===APP_VERSION&&current?.buildId===build.buildId)break;await delay(100);}
    if(current?.version!==APP_VERSION||current?.buildId!==build.buildId)throw Error('本机服务未在预期时间内启动');
    const result={url:url+'/paint.html?project='+seedId,version:APP_VERSION,data,owned:true,pid:child.pid};await write(record,result);return {...result,stop,exit};
  }catch(error){await stop();throw error;}
}
function execFileExists(file){try{accessSync(file,constants.X_OK);return true;}catch{return false;}}

if(process.argv[1]&&await fs.realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
  let result,stopping=false;const controller=new AbortController();
  async function stop(){if(stopping)return;stopping=true;controller.abort();if(result){await result.stop?.();process.exit(0);}}
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  try{
    result=await startRelease({signal:controller.signal});
    if(stopping){await result.stop?.();process.exit(0);}
    process.stdout.write('ARACHNE_READY '+JSON.stringify({url:result.url,version:result.version,data:result.data,owned:result.owned})+'\n');
    if(result.owned){await result.exit;if(!stopping)process.exitCode=1;}
    else setInterval(()=>{},60000);
  }catch(error){if(!stopping){process.stderr.write(error.message+'\n');process.exitCode=1;}}
}
