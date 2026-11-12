import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

if(process.platform!=='darwin')throw Error('Run the native WebKit verification from a logged-in macOS desktop');
const root=new URL('..',import.meta.url),data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-native-mac-'));
const profile=path.join(data,'隔离 工程');
const tests=['macos-window-state','macos-editor-focus','macos-workbench-recovery'];
for(const test of tests)execFileSync('swiftc',[
  '-D','ARACHNE_DEV','-module-cache-path',path.join(data,'swift-modules'),
  'release-support/NativeWorkbench.swift','tests/'+test+'.swift','-o',path.join(data,test)
],{cwd:root,stdio:'inherit'});

const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const {port}=socket.address();await new Promise(resolve=>socket.close(resolve));
const origin='http://127.0.0.1:'+port;
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:root,stdio:'inherit',
  env:{...process.env,ARACHNE_DATA_DIR:profile,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:path.join(data,'no-blender')}});
function run(name,...args){
  return new Promise((resolve,reject)=>{
    const test=spawn(path.join(data,name),args,{stdio:'inherit'});
    const timer=setTimeout(()=>test.kill(),120000).unref();
    test.once('error',error=>{clearTimeout(timer);reject(error);});
    test.once('exit',(code,signal)=>{
      clearTimeout(timer);
      if(code!==0)reject(Error(name+' exited with '+(signal??code)));
      else resolve();
    });
  });
}
try{
  let healthy=false;
  for(let i=0;i<100;i++){
    healthy=await fetch(origin+'/api/health').then(response=>response.ok,()=>false);
    if(healthy)break;await delay(200);
  }
  assert.equal(healthy,true);
  await run(tests[0]);
  const response=await fetch(origin+'/api/projects',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({workflowType:'pbr_paint',modelTemplate:'cube',name:'Mac 原生验收'})});
  assert.equal(response.status,201,response.ok?'':await response.text());
  const {id}=await response.json(),url=origin+'/paint.html?project='+id;
  await run(tests[1],url);
  const {revision}=await fetch(origin+'/api/projects/'+id).then(response=>response.json());
  await run(tests[2],url,id,String(revision),'--draft');
}finally{
  if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
  console.log('Isolated macOS verification:',data);
}
