import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {FloatType} from 'three';
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js';
import {pythonExecutable} from '../python-runtime.mjs';
import {nativeDemoProjectId} from '../demo-source.mjs';
import {nativeModelSteps} from '../model-binding.mjs';
import {captureRenderPreset,updateDeliveryOptions} from '../public/paint-delivery-options.mjs';

const root=path.resolve(import.meta.dirname,'..');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-glb-import-'));
const fixture=path.join(data,'uncached-model.glb');
const marker=path.join(data,'blender-invoked'),probe=path.join(data,'blender-probe');
const digest=value=>createHash('sha256').update(value).digest('hex');
if(process.platform!=='win32')
  await fs.writeFile(probe,'#!/bin/sh\ntouch "$(dirname "$0")/blender-invoked"\nexit 42\n',{mode:0o700});

function sampleModel(){
  const parts=[
    new Float32Array([-1,0,-1,-1,0,1,1,0,1,1,0,-1]),
    new Float32Array([0,0,0,1,1,1,1,0]),
    new Uint16Array([0,1,2,0,2,3])
  ];
  const bins=parts.map(value=>Buffer.from(value.buffer));
  const binary=Buffer.concat(bins);
  const gltf={
    asset:{version:'2.0'},scene:0,scenes:[{nodes:[0,2]}],
    nodes:[{name:'涂装面',mesh:0},{name:'遮挡面',mesh:1,translation:[.25,.3,0],scale:[.34,1,.42]},
      {name:'缩放组',scale:[1.2,1,.85],children:[1]}],
    meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},indices:2,material:0}]},
      {primitives:[{attributes:{POSITION:0},indices:2,material:1}]}],
    materials:[{name:'表面材料',doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.03,.2,.36,1],metallicFactor:.1,roughnessFactor:.6}},
      {name:'遮挡材料',doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.6,.22,.05,1],metallicFactor:0,roughnessFactor:.7}}],
    buffers:[{byteLength:binary.length}],
    bufferViews:bins.map((buffer,i)=>({buffer:0,byteOffset:bins.slice(0,i).reduce((size,part)=>size+part.length,0),byteLength:buffer.length})),
    accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[-1,0,-1],max:[1,0,1]},
      {bufferView:1,componentType:5126,count:4,type:'VEC2'},{bufferView:2,componentType:5123,count:6,type:'SCALAR'}]
  };
  const json=Buffer.from(JSON.stringify(gltf));
  const metadata=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const header=Buffer.alloc(20),chunk=Buffer.alloc(8);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+metadata.length+binary.length,8);
  header.writeUInt32LE(metadata.length,12);header.write('JSON',16);
  chunk.writeUInt32LE(binary.length);chunk.write('BIN',4);
  return {bytes:Buffer.concat([header,metadata,chunk,binary]),binary,gltf};
}

async function until(read,timeout=120000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const value=await read();
    if(value)return value;
    await delay(200);
  }
  throw Error('验收等待超时');
}

const model=sampleModel();
await fs.writeFile(fixture,model.bytes);
const services=[];
let logs='',browser;
async function start(folder){
  const socket=net.createServer().listen(0,'127.0.0.1');
  await once(socket,'listening');
  const {port}=socket.address();
  await new Promise(resolve=>socket.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const env={...process.env,ARACHNE_DATA_DIR:folder,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:probe};
  const service=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:root,env});
  services.push(service);
  for(const stream of [service.stdout,service.stderr])stream.on('data',bytes=>{logs+=bytes;});
  await until(()=>fetch(origin+'/api/health').then(r=>r.ok,()=>false));
  return origin;
}
let origin;
async function api(route,body){
  const r=await fetch(origin+route,body===undefined?{}:{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const json=await r.json();
  assert.ok(r.ok,JSON.stringify(json));
  return json;
}
try{
  origin=await start(data);
  assert.deepEqual(await api('/api/projects'),[]);
  await assert.rejects(fs.stat(path.join(data,'model-geometry')),{code:'ENOENT'});
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  await page.goto(origin);
  const welcome=page.locator('.project-welcome');
  await welcome.getByRole('button',{name:'新建工程',exact:true}).click();
  const newDialog=page.locator('#new-paint-dialog');
  const modelInput=newDialog.locator('#new-paint-model');
  const modelName=newDialog.locator('#new-paint-name');
  await modelInput.setInputFiles({name:'not-a-model.glb',mimeType:'model/gltf-binary',buffer:Buffer.from('invalid')});
  await newDialog.getByText('请选择有效的 GLB 2.0 模型').waitFor();
  assert.equal(await newDialog.locator('#new-paint-submit').isDisabled(),true);
  await newDialog.getByRole('button',{name:'恢复示例'}).click();
  assert.equal(await newDialog.locator('#new-paint-submit').isEnabled(),true);
  await modelName.fill('手工输入的工程名');
  await modelInput.setInputFiles(fixture);
  await newDialog.getByText('uncached-model.glb',{exact:true}).waitFor();
  assert.equal(await modelName.inputValue(),'手工输入的工程名');
  await newDialog.getByRole('button',{name:'关闭',exact:true}).click();
  const transfer=await page.evaluateHandle(bytes=>{
    const data=new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)],'uncached-model.glb',{type:'model/gltf-binary'}));
    return data;
  },[...model.bytes]);
  await welcome.dispatchEvent('dragover',{dataTransfer:transfer});
  assert.equal(await welcome.getAttribute('data-file-drop'),'');
  await welcome.dispatchEvent('drop',{dataTransfer:transfer});
  await transfer.dispose();
  await newDialog.getByText('uncached-model.glb',{exact:true}).waitFor();
  assert.equal(await modelName.inputValue(),'uncached-model');
  assert.deepEqual(await api('/api/projects'),[]);
  await newDialog.locator('#new-paint-submit').click();
  const id=await until(async()=>new URL(page.url()).searchParams.get('project'));
  const route='/api/projects/'+id,paint=route+'/paint';
  const registered=await api(route),manifest=await api(route+'/viewport');
  assert.equal(registered.source.format,'glb');
  assert.equal(registered.source.material,'表面材料');
  assert.equal(manifest.metadata.input_sha256,digest(model.bytes));
  assert.equal(manifest.metadata.uv_before,registered.source.uvSha256);
  const glb=Buffer.from(await (await fetch(origin+manifest.modelUrl)).arrayBuffer());
  const length=glb.readUInt32LE(12);
  assert.deepEqual(glb.subarray(28+length),model.binary);
  const registeredGltf=JSON.parse(glb.subarray(20,20+length).toString());
  const topologyState=await api(route+'/viewport/topology',{});
  const topology=await api(topologyState.url);
  assert.equal(topology.modelSha256,manifest.modelSha256);
  assert.deepEqual(topology.primitives['0:0'].polygons,[0,1]);
  await until(async()=>(await api(paint+'/model-state')).status==='ready');
  const baseline=path.dirname(registered.source.cacheRun);
  const originalGuide=await fs.readFile(path.join(baseline,'guides','top','receiver.png'));
  // Remove the atlas and its report as if the local surface cache was cleared.
  await fs.rm(baseline,{recursive:true,force:true});
  const angle=.3,c=Math.cos(angle),s=Math.sin(angle);
  const steps=[
    {matrix:[c,0,-s,0,0,1,0,0,s,0,c,0,-.85,0,0,1],targets:[{id:1}]},
    {matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,.25,0,1],targets:[{mesh:0,vertices:[0]}]}
  ];
  let doc=await api(paint+'/model',{revision:registered.revision,modeling:{
    version:1,binding:manifest.key,modelSha256:manifest.modelSha256,steps,nativeSteps:nativeModelSteps(registeredGltf,steps,topology)
  }});
  const camera={projection:'orthographic',eye:[2,5,2],target:[0,0,0],up:[0,1,0],fov:38,orthoHeight:3.1};
  const preset=captureRenderPreset(updateDeliveryOptions({},{framing:'saved',width:384,height:288,samples:8,maxBounces:4,transparent:true}));
  doc=await api(paint+'/commands',{revision:doc.revision,operations:[
    {op:'renderCamera',camera},{op:'renderPreset',preset},{op:'base',patch:{color:'#287aab'}}
  ]});
  await page.goto(origin+'/?project='+id);
  await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  await page.getByText('渲染',{exact:true}).filter({visible:true}).first().click();
  await page.locator('#open-paint-render').click();
  await page.locator('#start-paint-render').click();
  const result=await until(async()=>{
    const job=(await api(route+'/jobs')).find(item=>item.type==='paint-render');
    if(job?.status==='failed')throw Error(await (await fetch(origin+route+'/jobs/'+job.id+'/files/run.log')).text());
    return job?.status==='completed'&&job;
  });
  assert.equal(result.render.engine,'PATH_TRACING');
  assert.equal(result.render.uvSha256,registered.source.uvSha256);
  assert.equal(result.paintReport.modelFingerprint,(await api(paint+'/model-state')).fingerprint);
  assert.equal(result.reusedPaintBake,undefined);
  assert.deepEqual(result.render.camera,camera);
  const rebuiltGuide=await fs.readFile(path.join(baseline,'guides','top','receiver.png'));
  assert.deepEqual(rebuiltGuide,originalGuide);
  const editedFolders=await fs.readdir(path.join(data,'model-geometry'));
  assert.equal(editedFolders.length,1);
  const edited=path.join(data,'model-geometry',editedFolders[0]);
  const geometry=JSON.parse(await fs.readFile(path.join(edited,'cache','geometry_report.json')));
  assert.equal(geometry.engine,'glb');
  assert.equal(geometry.uv_before_sha256,registered.source.uvSha256);
  assert.notDeepEqual(await fs.readFile(path.join(edited,'guides','top','receiver.png')),originalGuide);
  const download=page.locator('#paint-render-download');
  const [file]=await Promise.all([page.waitForEvent('download'),download.click()]);
  const pngPath=path.join(data,'render.png');
  await file.saveAs(pngPath);
  const png=await fs.readFile(pngPath);
  assert.equal(digest(png),result.render.sha256);
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[384,288]);
  await page.goto(origin+'/?project='+id);
  await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  await page.getByText('文件',{exact:true}).filter({visible:true}).first().click();
  await page.locator('#open-delivery').click();
  assert.equal(await page.locator('#delivery').isDisabled(),true);
  await page.locator('#delivery-preview-button').click();
  await page.locator('#approved').check({timeout:120000});
  await page.getByRole('button',{name:'交付渲染格式',exact:true}).click();
  await page.getByRole('option',{name:'OpenEXR · 32 位浮点',exact:true}).click();
  assert.equal(await page.locator('#approved').isChecked(),false);
  await page.locator('#approved').check();
  await page.locator('#delivery').click();
  const delivery=await until(async()=>{
    const job=(await api(route+'/jobs')).find(item=>item.type==='paint-export');
    if(job?.status==='failed')throw Error(await (await fetch(origin+route+'/jobs/'+job.id+'/files/run.log')).text());
    return job?.status==='completed'&&job;
  });
  assert.deepEqual(delivery.render.camera,camera);
  assert.equal(delivery.render.engine,'PATH_TRACING');
  assert.equal(delivery.blendUrl,undefined);
  const zip=path.join(data,'delivery.zip');
  const [archive]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'交付 ZIP · r'+doc.revision}).click()]);
  await archive.saveAs(zip);
  execFileSync(pythonExecutable(),['-c',[
    'import hashlib, io, json, sys, zipfile',
    'from PIL import Image',
    'from model_glb import Model',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' r=json.loads(z.read("project-report.json"))',
    ' assert r["bake"]["previewId"]==sys.argv[2]',
    ' assert not any(name.endswith(".blend") for name in z.namelist())',
    ' assert set(z.namelist())==set(r["fileSha256"])|{"project-report.json"}',
    ' for name,expected in r["fileSha256"].items():',
    '  data=z.read(name)',
    '  assert hashlib.sha256(data).hexdigest()==expected',
    '  if name.startswith("textures/"):',
    '   with Image.open(io.BytesIO(data)) as texture:',
    '    assert texture.size==(4096,4096)',
    '    texture.load()',
    ' mat=json.loads(z.read("materials.json"))',
    ' assert len(mat["channels"])==8 and {c["file"]:c["sha256"] for c in mat["channels"].values()}==r["bake"]["files"]',
    ' model=Model(z.extract("model.glb",sys.argv[3]))',
    ' assert model.uv_digest()==mat["uvSha256"]',
    ' assert model.primitives[0]["positions"][0,1]==0.25',
    ' assert model.primitives[0]["material"]["pbrMetallicRoughness"]["baseColorTexture"]',
    ' with Image.open(io.BytesIO(z.read("render.png"))) as frame:',
    '  assert frame.size==(384,288)',
    '  frame.load()'
  ].join('\n'),zip,delivery.paintPreviewId,data],{cwd:root,stdio:'inherit'});
  const bytes=Buffer.from(await (await fetch(origin+delivery.outputUrl)).arrayBuffer());
  assert.equal(digest(bytes),delivery.outputSha256);
  const exr=new EXRLoader().setDataType(FloatType).parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  assert.deepEqual([exr.width,exr.height],[384,288]);
  assert.ok(exr.header.channels.every(channel=>channel.pixelType===2));
  assert.ok(exr.data.every(Number.isFinite));

  const clean=path.join(data,'clean');await fs.mkdir(clean);
  const other=await start(clean);
  const reopened=await browser.newPage();
  await reopened.goto(other);
  await reopened.locator('.project-welcome').getByRole('button',{name:'打开涂装 ZIP…'}).click();
  const importDialog=reopened.locator('#paint-import-dialog');
  const archiveInput=importDialog.locator('#paint-import-file');
  const importSubmit=importDialog.locator('#paint-import-submit');
  assert.equal(await importSubmit.isDisabled(),true);
  await archiveInput.setInputFiles({name:'not-a-project.zip',mimeType:'application/zip',buffer:Buffer.from('invalid')});
  await importDialog.getByText('请选择有效的涂装 ZIP').waitFor();
  assert.equal(await importSubmit.isDisabled(),true);
  await archiveInput.setInputFiles(zip);
  await importDialog.getByText(path.basename(zip),{exact:true}).waitFor();
  await importSubmit.click();
  const restoredId=await until(async()=>new URL(reopened.url()).searchParams.get('project'));
  const restored=await fetch(other+'/api/projects/'+restoredId).then(response=>response.json());
  assert.deepEqual(restored.paint,doc.paint);
  assert.deepEqual(restored.modeling,doc.modeling);
  await reopened.reload();
  await reopened.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  console.log('PASS GLB drag and drop, invalid file validation, ZIP chooser and project reopen');
  execFileSync(process.execPath,['scripts/seed-native-demo.mjs'],{cwd:root,stdio:'inherit',
    env:{...process.env,ARACHNE_DATA_DIR:clean,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:probe},timeout:30000});
  const seed=await fetch(other+'/api/projects/'+nativeDemoProjectId).then(response=>response.json());
  assert.equal(seed.source.format,'glb');
  assert.equal(seed.source.material,'Housing');
  const created=await fetch(other+'/api/projects',{method:'POST',headers:{Origin:other,'Content-Type':'application/json'},
    body:JSON.stringify({workflowType:'pbr_paint',name:'原生示例验收'})});
  assert.equal(created.status,201);
  const sample=await created.json();
  assert.deepEqual(sample.source.files,seed.source.files);
  const nativeRoute='/api/projects/'+sample.id;
  const nativeView=await fetch(other+nativeRoute+'/viewport').then(response=>response.json());
  assert.equal(nativeView.metadata.uv_before,seed.source.uvSha256);
  const nativeBake=await fetch(other+nativeRoute+'/paint/preview',{method:'POST',
    headers:{Origin:other,'Content-Type':'application/json'},body:JSON.stringify({revision:sample.revision,requestId:'native-demo-4k'})});
  assert.equal(nativeBake.status,202);
  const {id:sampleJob}=await nativeBake.json();
  const bakedSample=await until(async()=>{
    const job=await fetch(other+nativeRoute+'/jobs/'+sampleJob).then(response=>response.json());
    if(job.status==='failed')throw Error(job.error);
    return job.status==='completed'&&job;
  });
  assert.equal(bakedSample.paintReport.uv_unchanged,true);
  assert.equal(Object.keys(bakedSample.paintReport.files).length,8);
  await assert.rejects(fs.stat(path.dirname(seed.source.cacheRun)),{code:'ENOENT'});
  assert.ok((await fs.readdir(path.join(clean,'model-geometry'))).length);
  console.log('PASS native example creation and eight-channel 4K bake without Blender or writes to sample sources');
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  console.log('PASS GLB import, cache rebuild, original UV, edited model, native PNG/EXR/4K ZIP, and clean restore without Blender');
}finally{
  await browser?.close();
  for(const service of services)if(service.exitCode===null&&service.signalCode===null){
    const done=once(service,'exit');service.kill();await done;
  }
  console.log(logs,'验收文件',data);
}
