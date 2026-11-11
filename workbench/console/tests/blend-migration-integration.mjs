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
import {pythonExecutable} from '../python-runtime.mjs';
import {resolveSource} from '../workspace-paths.mjs';

const root=path.resolve(import.meta.dirname,'..'),python=pythonExecutable();
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-blend-migrate-'));
const legacy=path.join(data,'legacy-input'),fixture=path.join(root,'.demo');
const hash=value=>createHash('sha256').update(value).digest('hex');
const real=blenderExecutable(),calls=path.join(data,'blender-calls');
const disabled=path.join(data,'blender-disabled'),probe=path.join(data,process.platform==='win32'?'missing-blender.exe':'blender-probe');
const env={...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_PYTHON:python};
if(process.platform!=='win32'){
  await fs.writeFile(probe,'#!/bin/sh\nprintf "%s\\n" invoked >> "$ARACHNE_TEST_BLENDER_CALLS"\n[ ! -e "$ARACHNE_TEST_BLENDER_DISABLED" ] || exit 42\nexec "$ARACHNE_TEST_REAL_BLENDER" "$@"\n',{mode:0o700});
  Object.assign(env,{ARACHNE_TEST_BLENDER_CALLS:calls,ARACHNE_TEST_BLENDER_DISABLED:disabled,ARACHNE_TEST_REAL_BLENDER:real});
}
let server,browser,origin,logs='';
async function until(check,ms=180_000){
  for(const deadline=Date.now()+ms;Date.now()<deadline;){
    const value=await check();if(value)return value;await delay(200);
  }
  throw Error('迁移验收等待超时');
}
async function start(folder=data,exe=probe){
  const socket=net.createServer().listen(0,'127.0.0.1');
  await once(socket,'listening');const {port}=socket.address();
  await new Promise(resolve=>socket.close(resolve));
  origin='http://127.0.0.1:'+port;
  server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:root,
    env:{...env,ARACHNE_DATA_DIR:folder,ARACHNE_BLENDER:exe},windowsHide:true});
  for(const stream of [server.stdout,server.stderr])stream.on('data',bytes=>{logs+=bytes;});
  await until(()=>fetch(origin+'/api/health').then(r=>r.ok,()=>false),20_000);
}
async function stop(){
  if(!server||server.exitCode!==null||server.signalCode!==null)return;
  const done=once(server,'exit');
  if(process.platform==='win32')execFileSync('taskkill.exe',['/PID',String(server.pid),'/T','/F'],{windowsHide:true});
  else server.kill();
  await done;
}
async function api(route,body,status=200){
  const r=await fetch(origin+route,body===undefined?{}:{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await r.json();assert.equal(r.status,status,JSON.stringify(result));return result;
}
const project=id=>'/api/projects/'+id,paint=id=>project(id)+'/paint';
async function job(doc,op,fields={}){
  const queued=await api(paint(doc.id)+'/'+op,{revision:doc.revision,requestId:randomUUID(),...fields},202);
  const route=project(doc.id)+'/jobs/'+queued.id;
  return until(async()=>{
    const current=await api(route);
    if(['failed','cancelled','interrupted'].includes(current.status))throw Error(current.stage+': '+await fetch(origin+route+'/files/run.log').then(r=>r.text()));
    return current.status==='completed'&&current;
  });
}

try{
  execFileSync(process.execPath,['scripts/seed-demo.mjs'],{cwd:root,env,stdio:'inherit',timeout:180_000});
  const oldProjectFile=path.join(data,'projects',demoProjectId,'project.json');
  const seed=JSON.parse(await fs.readFile(oldProjectFile,'utf8')),source=resolveSource(seed.source);
  const relocate=file=>path.join(legacy,path.relative(fixture,file));
  for(const file of Object.keys(source.files)){
    await fs.mkdir(path.dirname(relocate(file)),{recursive:true});
    await fs.copyFile(file,relocate(file));
  }
  seed.source={...source,...Object.fromEntries(['reviewSource','baseImage','cacheRun','bundle'].map(key=>[key,relocate(source[key])])),
    files:Object.fromEntries(Object.entries(source.files).map(([file,digest])=>[relocate(file),digest]))};
  await fs.writeFile(oldProjectFile,JSON.stringify(seed));
  await fs.rm(path.join(data,'viewport'),{recursive:true,force:true});
  const originalBlend=seed.source.reviewSource,blendSha=hash(await fs.readFile(originalBlend));
  const legacyUV=JSON.parse(await fs.readFile(path.join(seed.source.cacheRun,'geometry_report.json'),'utf8')).uv_before_sha256;
  await start(data,process.platform==='win32'?real:probe);
  let old=await api('/api/projects',{workflowType:'pbr_paint',name:'无视口缓存的旧涂装工程'},201);
  const fixturePng=path.join(data,'art.png');
  execFileSync(python,['-c','from PIL import Image; import sys; Image.new("RGBA",(64,64),(230,65,28,180)).save(sys.argv[1])',fixturePng],{cwd:root});
  const png=(await fs.readFile(fixturePng)).toString('base64');
  const imported=await api(paint(old.id)+'/assets',{revision:old.revision,name:'旧编号.png',data:png},201);
  old=imported.document;
  old=await api(paint(old.id)+'/commands',{revision:old.revision,operations:[
    {op:'base',patch:{color:'#365d71',metallic:.22,roughness:.57}},
    {op:'add',kind:'decal',patch:{name:'原顶视贴花',image:imported.asset.id,x:.5,y:.5,scale:1,maskEnabled:true}},
    {op:'add',kind:'fill',patch:{name:'补漆',opacity:.15,values:{color:'#92b2a6',metallic:.35,roughness:.45}}}
  ]});
  const decal=old.paint.layers.find(l=>l.kind==='decal');
  const maskPng=path.join(data,'mask.png');
  execFileSync(python,['-c','from PIL import Image; import sys; Image.new("L",(64,64),196).save(sys.argv[1])',maskPng],{cwd:root});
  const masked=await api(paint(old.id)+'/assets',{revision:old.revision,name:'旧蒙版.png',
    data:(await fs.readFile(maskPng)).toString('base64'),maskLayerId:decal.id},201);
  old=masked.document;
  const before=await job(old,'preview');
  assert.ok(before.paintReport.writtenTexels>0);
  assert.equal((await api(project(old.id)+'/viewport')).status,'idle');
  await assert.rejects(fs.stat(path.join(data,'viewport')),{code:'ENOENT'});

  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  page.on('pageerror',error=>console.error(error.message));
  await page.goto(origin+'/?project='+old.id);
  await page.getByText(/旧工程没有视口 GLB/).first().waitFor({timeout:30000});
  if(process.platform!=='win32')await assert.rejects(fs.stat(calls),{code:'ENOENT'});
  await page.getByText('文件',{exact:true}).filter({visible:true}).first().click();
  await page.locator('#open-glb-migration').click();
  const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/migrate-glb')),
    page.locator('#start-glb-migration').click()]);
  const migrationBody=await response.text();
  assert.equal(response.status(),201,migrationBody);
  let migrated=JSON.parse(migrationBody);
  assert.notEqual(migrated.id,old.id);
  assert.equal(migrated.source.format,'glb');
  assert.equal(migrated.source.preservedSurface,true);
  assert.equal(migrated.migration.legacyUvSha256,legacyUV);
  assert.deepEqual(migrated.paint,old.paint);
  await until(()=>new URL(page.url()).searchParams.get('project')===migrated.id,30_000);
  await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  assert.deepEqual(await api(project(old.id)),old);
  assert.equal(hash(await fs.readFile(originalBlend)),blendSha);
  if(process.platform!=='win32')assert.equal(await fs.readFile(calls,'utf8'),'invoked\n');
  const manifest=await api(project(migrated.id)+'/viewport');
  assert.ok(manifest.metadata.verifiedTriangles>0);
  assert.equal(manifest.metadata.legacyUvSha256,legacyUV);
  assert.equal(manifest.metadata.uv_before,manifest.metadata.uv_after);
  const glb=Buffer.from(await (await fetch(origin+manifest.modelUrl)).arrayBuffer());
  const gltf=JSON.parse(glb.toString('utf8',20,20+glb.readUInt32LE(12)));
  const materials=gltf.materials.map(m=>m.extras.sourceMaterial);
  assert.ok(materials.includes('f_16xl'));
  const pbr=gltf.materials.find(m=>m.extras.sourceMaterial==='f_16xl').pbrMetallicRoughness;
  assert.ok(Math.abs(pbr.roughnessFactor-.46)<1e-6);
  assert.ok(pbr.baseColorFactor.slice(0,3).every((v,i)=>Math.abs(v-[.18,.22,.27][i])<1e-6));
  assert.ok(gltf.nodes.filter(node=>node.mesh!==undefined).length>=2);
  assert.equal((await api(paint(old.id)+'/migrate-glb',{revision:old.revision},201)).id,migrated.id);

  // Remove access to the legacy source and make any Blender invocation fail.
  await stop();
  await fs.rename(legacy,path.join(data,'legacy-offline'));
  await fs.writeFile(disabled,'disabled');
  await start();
  await page.goto(origin+'/?project='+migrated.id);
  await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  assert.equal((await api(paint(old.id)+'/migrate-glb',{revision:old.revision},201)).id,migrated.id);
  const same=await job(migrated,'preview');
  assert.deepEqual(same.paintReport.files,before.paintReport.files);
  assert.equal(same.paintReport.writtenTexels,before.paintReport.writtenTexels);
  assert.equal(same.paintReport.protectedTexelsWritten,0);
  console.log('PASS reopened with old model offline, identical eight 4K texture hashes and identical protected coverage');

  const state=await api(project(migrated.id)+'/viewport/topology',{},202);
  const topology=state.status==='ready'?await api(state.url):await until(async()=>{
    const next=await api(project(migrated.id)+'/viewport/topology');
    return next.status==='ready'&&await api(next.url);
  });
  const target=gltf.nodes.findIndex(node=>node.name==='Housing');
  assert.ok(target>=0);
  const steps=[{matrix:[1,0,0,0,0,1,0,0,0,0,1,0,.08,0,0,1],targets:[{id:target}]}];
  migrated=await api(paint(migrated.id)+'/model',{revision:migrated.revision,modeling:{
    version:1,binding:manifest.key,modelSha256:manifest.modelSha256,steps,nativeSteps:nativeModelSteps(gltf,steps,topology)
  }});
  migrated=await api(paint(migrated.id)+'/commands',{revision:migrated.revision,operations:[
    {op:'update',id:decal.id,patch:{name:'迁移后继续编辑',opacity:.6}}
  ]});
  const edited=await job(migrated,'preview');
  assert.notDeepEqual(edited.paintReport.files,same.paintReport.files);
  assert.equal(edited.paintReport.uv_unchanged,true);
  const delivery=await job(migrated,'export',{confirmed:true,previewId:edited.id,
    settings:{width:320,height:240,samples:4,device:'cpu'}});
  assert.equal(delivery.render.engine,'PATH_TRACING');
  const zip=Buffer.from(await (await fetch(origin+delivery.packageUrl)).arrayBuffer());
  const zipFile=path.join(data,'migrated-delivery.zip');
  await fs.writeFile(zipFile,zip);
  execFileSync(python,['-c',[
    'import hashlib,json,sys,zipfile',
    'from PIL import Image',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' r=json.loads(z.read("project-report.json"))',
    ' assert not any(name.endswith(".blend") for name in z.namelist())',
    ' assert "registration/surface/cache/mapping/surface.npz" in r["delivery"]["registration"]',
    ' assert all(hashlib.sha256(z.read(name)).hexdigest()==digest for name,digest in r["fileSha256"].items())',
    ' with Image.open(z.open("render.png")) as im:',
    '  assert im.size==(320,240)',
    '  im.load()'
  ].join('\n'),zipFile],{cwd:root,stdio:'inherit'});
  await stop();
  const clean=path.join(data,'clean');await fs.mkdir(clean);
  await start(clean);
  const restored=await fetch(origin+'/api/projects/paint-import',{method:'POST',headers:{'Content-Type':'application/zip'},body:zip});
  const restoredBody=await restored.text();
  assert.equal(restored.status,201,restoredBody);
  const copy=JSON.parse(restoredBody);
  assert.deepEqual(copy.paint,migrated.paint);
  assert.deepEqual(copy.modeling,migrated.modeling);
  await page.goto(origin+'/?project='+copy.id);
  await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  const rebaked=await job(copy,'preview');
  assert.deepEqual(rebaked.paintReport.files,edited.paintReport.files);
  if(process.platform!=='win32')assert.equal(await fs.readFile(calls,'utf8'),'invoked\n');
  console.log('PASS one-time .blend migration, original material and UV, no cache, native modeling and paint edits, ZIP and clean restore:',zipFile);
}finally{
  await browser?.close();
  await stop();
  console.log(logs,'验收目录',data);
}
