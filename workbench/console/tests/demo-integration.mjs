import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {blenderExecutable} from '../blender-runtime.mjs';
import {demoProjectId} from '../demo-source.mjs';
import {nativeModelSteps} from '../model-binding.mjs';

const root=path.resolve(import.meta.dirname,'..');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-public-test-'));
const env={...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1'};
const python=env.ARACHNE_PYTHON||'python3';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let server,browser,base,log='';
async function waitFor(read,description){
  for(let i=0;i<600;i++){
    const value=await read();
    if(value)return value;
    await delay(200);
  }
  throw Error('等待超时：'+description);
}
async function start(blender){
  const socket=net.createServer();
  socket.listen(0,'127.0.0.1');
  await once(socket,'listening');
  const {port}=socket.address();
  await new Promise((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
  base='http://127.0.0.1:'+port;
  server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:root,env:{...env,ARACHNE_BLENDER:blender}});
  for(const stream of [server.stdout,server.stderr])stream.on('data',bytes=>{log=(log+bytes).slice(-8000);});
  await waitFor(async()=>await fetch(base+'/api/health').then(r=>r.ok,()=>{if(server.exitCode!==null)throw Error('本机服务提前退出：'+server.exitCode);return false;}),'本机服务');
}
async function stop(){
  if(!server||server.exitCode!==null)return;
  const done=once(server,'exit');
  server.kill('SIGTERM');
  await done;
}
async function api(route,input,expected=200){
  const r=await fetch(base+route,input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','Origin':base},body:JSON.stringify(input)});
  const value=await r.json();
  assert.equal(r.status,expected,JSON.stringify(value));
  return value;
}
const project=id=>'/api/projects/'+id;
const paint=id=>project(id)+'/paint';
const result=(id,job)=>waitFor(async()=>{
  const value=await api(project(id)+'/jobs/'+job.id);
  if(['failed','cancelled','interrupted'].includes(value.status)){
    const details=await fetch(base+project(id)+'/jobs/'+job.id+'/files/run.log').then(r=>r.text());
    throw Error((value.error||value.stage)+'\n'+details);
  }
  return value.status==='completed'&&value;
},job.type);
const preview=async doc=>result(doc.id,await api(paint(doc.id)+'/preview',{revision:doc.revision,requestId:randomUUID()},202));
try{
  execFileSync(process.execPath,['scripts/seed-demo.mjs'],{cwd:root,env,stdio:'inherit',timeout:180_000});
  await start(path.join(data,'blender-unavailable'));
  const demo=await api(project(demoProjectId));
  const manifest=await api(project(demo.id)+'/viewport');
  assert.equal(manifest.status,'ready');
  assert.equal(manifest.metadata.uv_before,manifest.metadata.uv_after);
  assert.ok(manifest.metadata.mesh_count>=2);
  browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/?project='+demo.id);
  try{await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});}
  catch(error){throw Error(error.message+'\n'+errors.join('\n')+'\n'+(await page.locator('body').innerText()).slice(0,1800));}
  assert.deepEqual(errors,[]);
  await browser.close();
  browser=null;

  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'公开示例验收'},201);
  doc=await api(paint(doc.id)+'/commands',{revision:doc.revision,operations:[
    {op:'base',patch:{color:'#386d87'}},{op:'add',kind:'fill',patch:{name:'示例填充'}}
  ]});
  const baked=await preview(doc);
  assert.equal(Object.keys(baked.paintReport.files).length,8);
  assert.equal(baked.paintReport.protectedTexelsWritten,0);
  const archive=await result(doc.id,await api(paint(doc.id)+'/export-textures',{
    revision:doc.revision,previewId:baked.id,confirmed:true,requestId:randomUUID()
  },202));
  const zip=Buffer.from(await (await fetch(base+archive.packageUrl)).arrayBuffer());
  const zipPath=path.join(data,'textures.zip');
  await fs.writeFile(zipPath,zip);
  execFileSync(python,['-c',[
    'import hashlib,json,struct,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' r=json.loads(z.read("project-report.json"))',
    ' assert len(r["bake"]["files"]) == 8',
    ' for name,digest in r["fileSha256"].items():',
    '  data=z.read(name)',
    '  assert hashlib.sha256(data).hexdigest()==digest',
    '  if name.startswith("textures/"): assert struct.unpack(">II",data[16:24])==(4096,4096)'
  ].join('\n'),zipPath],{stdio:'inherit'});
  const reopened=await fetch(base+'/api/projects/paint-import',{method:'POST',headers:{'Content-Type':'application/zip'},body:zip});
  const restored=await reopened.json();
  assert.equal(reopened.status,201,JSON.stringify(restored));
  assert.deepEqual(restored.paint,doc.paint);
  const glb=Buffer.from(await (await fetch(base+manifest.modelUrl)).arrayBuffer());
  assert.equal(hash(glb),manifest.modelSha256);
  console.log('PASS web viewport, eight 4K textures and editable ZIP round trip without Blender');

  await stop();
  await start(blenderExecutable());
  const json=JSON.parse(glb.toString('utf8',20,20+glb.readUInt32LE(12)));
  const index=json.nodes.findIndex(node=>node.name==='Housing');
  assert.ok(index>=0);
  const steps=[{matrix:[1,0,0,0,0,1,0,0,0,0,1,0,.25,0,0,1],targets:[{id:index}]}];
  doc=await api(paint(doc.id)+'/model',{revision:doc.revision,modeling:{
    version:1,binding:manifest.key,modelSha256:manifest.modelSha256,steps,nativeSteps:nativeModelSteps(json,steps)
  }});
  assert.deepEqual((await api(project(doc.id))).modeling.steps,steps);
  const modeled=await preview(doc);
  assert.ok(modeled.paintReport.modelFingerprint);
  assert.equal(modeled.paintReport.uv_unchanged,true);
  const rendered=await result(doc.id,await api(paint(doc.id)+'/render',{
    revision:doc.revision,requestId:randomUUID(),settings:{width:320,height:256,samples:2,device:'cpu'}
  },202));
  assert.equal(rendered.cycles.engine,'CYCLES');
  assert.equal(rendered.cycles.uv_before,rendered.cycles.uv_after);
  assert.equal(rendered.cycles.document_revision,doc.revision);
  const delivery=await result(doc.id,await api(paint(doc.id)+'/export',{
    revision:doc.revision,previewId:modeled.id,confirmed:true,requestId:randomUUID(),
    settings:{width:320,height:256,samples:2,device:'cpu'}
  },202));
  const delivered=Buffer.from(await (await fetch(base+delivery.packageUrl)).arrayBuffer());
  const deliveryPath=path.join(data,'delivery.zip');
  await fs.writeFile(deliveryPath,delivered);
  execFileSync(python,['-c',[
    'import hashlib,json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' r=json.loads(z.read("delivery-report.json"))',
    ' assert {"preview.blend", "cycles.png", "projection-report.json"} <= set(r["fileSha256"])',
    ' assert r["uv"]["uv_before"] == r["uv"]["uv_after"]',
    ' for name,digest in r["fileSha256"].items():',
    '  assert hashlib.sha256(z.read(name)).hexdigest()==digest'
  ].join('\n'),deliveryPath],{stdio:'inherit'});
  console.log('PASS same-revision Blender and Cycles delivery ZIP with verified hashes');
  console.log('PASS geometry rebuild, original UV and real Cycles render of the edited demo');
}catch(error){console.error(log);throw error;}
finally{if(browser)await browser.close();await stop();console.log('Demo verification data:',data);}
