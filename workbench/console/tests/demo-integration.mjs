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
import {defaultLibraryMaterial} from '../public/paint-library.mjs';
import {nativeModelSteps} from '../model-binding.mjs';
import {pythonExecutable} from '../python-runtime.mjs';
import {captureRenderPreset,updateDeliveryOptions} from '../public/paint-delivery-options.mjs';

const root=path.resolve(import.meta.dirname,'..');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-public-test-'));
const env={...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1'};
const windows=process.platform==='win32';
const python=pythonExecutable();
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
  const entry=windows?['scripts/windows-workbench.mjs','start']:['server.mjs'];
  server=spawn(process.execPath,[...entry,'--port',String(port)],{
    cwd:root,env:{...env,ARACHNE_PYTHON:python,ARACHNE_BLENDER:blender},windowsHide:true
  });
  for(const stream of [server.stdout,server.stderr])stream.on('data',bytes=>{log=(log+bytes).slice(-8000);});
  await waitFor(async()=>await fetch(base+'/api/health').then(r=>r.ok,()=>{if(server.exitCode!==null)throw Error('本机服务提前退出：'+server.exitCode);return false;}),'本机服务');
}
async function stop(){
  if(!server||server.exitCode!==null||server.signalCode!==null)return;
  const done=once(server,'exit');
  if(windows){
    try{execFileSync('taskkill.exe',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});}
    catch{server.kill();}
  }else server.kill('SIGTERM');
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
  const noBlender=path.join(data,'blender-unavailable'),blenderMarker=path.join(data,'blender-invoked');
  if(!windows)await fs.writeFile(noBlender,'#!/bin/sh\ntouch "$(dirname "$0")/blender-invoked"\nexit 42\n',{mode:0o700});
  const projectFolders=path.join(data,'projects');
  for(const id of ['broken-project','incomplete-project','invalid name'])
    await fs.mkdir(path.join(projectFolders,id));
  await fs.writeFile(path.join(projectFolders,'broken-project','project.json'),'{broken');
  await start(noBlender);
  const demo=await api(project(demoProjectId));
  assert.deepEqual((await api('/api/projects')).map(item=>item.id),[demo.id]);
  assert.deepEqual(await api(project('broken-project'),undefined,422),{error:'工程文件损坏，无法打开'});
  assert.deepEqual(await api(project('incomplete-project'),undefined,404),{error:'找不到该工程'});
  const manifest=await api(project(demo.id)+'/viewport');
  assert.equal(manifest.status,'ready');
  assert.equal(manifest.metadata.uv_before,manifest.metadata.uv_after);
  assert.ok(manifest.metadata.mesh_count>=2);
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const blenderRequests=[];
  page.on('request',request=>{
    if(/\/(?:render-view|render-session|cycles-session|cycles-devices)(?:\/|$)/.test(new URL(request.url()).pathname))blenderRequests.push(request.url());
  });
  page.on('console',message=>{if(message.type()==='error'&&message.text().includes('Shader Error'))errors.push(message.text());});
  await page.goto(base+'/?project=broken-project');
  const welcome=page.locator('.project-welcome');
  await welcome.getByText('工程文件损坏，无法打开').waitFor();
  const recent=welcome.getByRole('button',{name:new RegExp(demo.name)});
  await recent.waitFor();
  await page.screenshot({path:path.join(data,'project-welcome.png')});
  await welcome.getByRole('button',{name:'打开工程…',exact:true}).click();
  await page.locator('#open-project-dialog').waitFor();
  await page.keyboard.press('Escape');
  await recent.click();
  await page.waitForURL(url=>url.searchParams.get('project')===demo.id);
  await welcome.waitFor({state:'hidden'});
  console.log('PASS startup recovery and recent projects with an incomplete folder and a damaged project');
  try{await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});}
  catch(error){throw Error(error.message+'\n'+errors.join('\n')+'\n'+(await page.locator('body').innerText()).slice(0,1800));}
  const viewport=page.locator('.editor-viewport[data-state=ready]').first();
  const render=page.getByRole('button',{name:'渲染预览',exact:true}).first();
  await render.click();
  const canvas=viewport.locator('canvas').first();
  const phase=value=>viewport.locator('xpath=self::*[@data-render-phase="'+value+'"]');
  try{
    await phase('ready').waitFor({timeout:90000});
  }catch(error){
    throw Error(error.message+'\n'+(await page.locator('.editor-preview-status').allTextContents()).join('\n')+'\n'+errors.join('\n'));
  }
  assert.ok(Number(await viewport.getAttribute('data-render-samples'))>1);
  const before=await canvas.screenshot();
  await page.getByRole('button',{name:'暂停路径追踪',exact:true}).first().click();
  await phase('paused').waitFor();
  const bounds=await canvas.boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  await page.mouse.down({button:'middle'});
  await page.mouse.move(bounds.x+bounds.width*.61,bounds.y+bounds.height*.52,{steps:4});
  await page.mouse.up({button:'middle'});
  await page.getByRole('button',{name:'继续路径追踪',exact:true}).first().click();
  await phase('ready').waitFor({timeout:90000});
  assert.notDeepEqual(await canvas.screenshot(),before,'Rotating the viewport must update the path traced image');
  const rotated=await canvas.screenshot();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  await page.keyboard.down('Shift');
  await page.mouse.down({button:'middle'});
  await page.mouse.move(bounds.x+bounds.width*.54,bounds.y+bounds.height*.62,{steps:4});
  await phase('waiting').waitFor();
  await page.mouse.up({button:'middle'});
  await page.keyboard.up('Shift');
  await phase('ready').waitFor({timeout:90000});
  const panned=await canvas.screenshot();
  assert.notDeepEqual(panned,rotated,'Panning must update the path traced image');
  for(let i=0;i<3;i++)await page.mouse.wheel(0,-80);
  await phase('ready').waitFor({timeout:90000});
  assert.notDeepEqual(await canvas.screenshot({path:path.join(data,'path-traced-viewport.png')}),panned,'Wheel zoom must update the path traced image');
  assert.deepEqual(blenderRequests,[]);
  await assert.rejects(fs.stat(blenderMarker),{code:'ENOENT'});
  assert.deepEqual(errors,[]);
  console.log('PASS progressive path tracing, orbit, pan, wheel zoom and pause/resume without starting Blender');
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'公开示例验收'},201);
  await page.keyboard.press('F3');
  const commands=page.locator('#command-picker');
  await commands.waitFor();
  await page.locator('#command-search').fill('open project');
  assert.equal(await commands.getByRole('option').count(),1);
  await page.screenshot({path:path.join(data,'command-picker.png')});
  await page.keyboard.press('Enter');
  const picker=page.locator('#open-project-dialog');
  const projectSearch=picker.locator('#project-search');
  await projectSearch.locator('xpath=self::*[not(@disabled)]').waitFor();
  assert.equal(await picker.getByRole('option').count(),2);
  assert.match(await picker.getByRole('option').first().textContent(),/公开示例验收/);
  assert.match(await picker.getByRole('option').last().textContent(),/当前工程/);
  await page.keyboard.press('ArrowDown');
  assert.match(await picker.locator('[aria-selected=true]').textContent(),/当前工程/);
  await projectSearch.fill('找不到的工程');
  assert.equal(await picker.getByRole('option').count(),0);
  assert.equal(await picker.getByRole('button',{name:'打开工程'}).isDisabled(),true);
  await projectSearch.fill(doc.id.slice(0,8).toUpperCase());
  assert.equal(await picker.getByRole('option').count(),1);
  await page.screenshot({path:path.join(data,'project-picker.png')});
  await page.keyboard.press('Enter');
  await page.waitForURL(url=>url.searchParams.get('project')===doc.id);
  await picker.waitFor({state:'hidden'});
  await page.keyboard.press('Control+o');
  await projectSearch.locator('xpath=self::*[not(@disabled)]').waitFor();
  await page.keyboard.press('Escape');
  await picker.waitFor({state:'hidden'});
  assert.equal(new URL(page.url()).searchParams.get('project'),doc.id);
  await page.keyboard.press('Control+k');
  await page.locator('#command-search').fill('修订号');
  await page.keyboard.press('Enter');
  const details=page.locator('#project-dialog');
  await details.waitFor();
  assert.equal(await details.locator('#project-detail-name').textContent(),doc.name);
  assert.equal(await details.locator('select').count(),0);
  await page.keyboard.press('Escape');
  console.log('PASS keyboard command search, recent project sorting, ID filtering, project switch and separate project details');
  await page.keyboard.press('F3');
  await page.locator('#command-search').fill('workspace layout');
  await page.keyboard.press('Enter');
  const layouts=page.locator('#workspace-layouts');
  await layouts.waitFor();
  assert.equal(await layouts.getByRole('img').count(),3);
  const [layoutDownload]=await Promise.all([page.waitForEvent('download'),layouts.locator('#export-workspace-layouts').click()]);
  const layoutFile=JSON.parse(await fs.readFile(await layoutDownload.path(),'utf8'));
  assert.equal(layoutFile.format,'arachne-workspaces');
  const modeling=layoutFile.layouts.modeling;
  modeling.ratio=.67;
  modeling.second.first.editor='console';
  const layoutInput=layouts.locator('#workspace-layout-file');
  await layoutInput.setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{}')});
  await layouts.getByText('请选择受支持的阿拉克涅工作区布局文件').waitFor();
  assert.equal(await layouts.locator('#apply-workspace-layouts').isVisible(),false);
  await layoutInput.setInputFiles({name:'test-layout.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(layoutFile))});
  await layouts.getByText('预览 · test-layout.json').waitFor();
  assert.equal(await page.locator('.editor-area[data-editor=console]').count(),0);
  await page.screenshot({path:path.join(data,'workspace-layouts.png')});
  await layouts.locator('#apply-workspace-layouts').click();
  await layouts.waitFor({state:'hidden'});
  await page.locator('[data-area-id=side-top][data-editor=console]').waitFor();
  const workspaceRoot=page.locator('.area-layout > .area-split').first();
  assert.equal(await workspaceRoot.evaluate(node=>node.style.getPropertyValue('--area-ratio')),'0.67');
  await page.reload();
  await page.locator('[data-area-id=side-top][data-editor=console]').waitFor();
  assert.equal(await workspaceRoot.evaluate(node=>node.style.getPropertyValue('--area-ratio')),'0.67');
  assert.equal((await api(project(doc.id))).revision,doc.revision);
  console.log('PASS portable workspace layouts, validated import, explicit apply and persistence without changing the project');
  doc=await api(paint(doc.id)+'/commands',{revision:doc.revision,operations:[
    {op:'base',patch:{color:'#386d87',metallic:.2,roughness:.6,alpha:.8,emission:'#000000'}},
    {op:'baseChannels',patch:{normal:true,ao:true}},{op:'add',kind:'fill',patch:{name:'示例填充',values:{color:'#386d87',metallic:.2,roughness:.6}}}
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
  const exported=await result(doc.id,await api(paint(doc.id)+'/export-glb',{
    revision:doc.revision,previewId:baked.id,confirmed:true,requestId:randomUUID()
  },202));
  const response=await fetch(base+exported.glbUrl);
  assert.equal(response.headers.get('content-type'),'model/gltf-binary');
  const paintedGlb=Buffer.from(await response.arrayBuffer());
  assert.equal(hash(paintedGlb),exported.glbSha256);
  const originalJsonSize=glb.readUInt32LE(12),paintedJsonSize=paintedGlb.readUInt32LE(12);
  const original=JSON.parse(glb.subarray(20,20+originalJsonSize));
  const painted=JSON.parse(paintedGlb.subarray(20,20+paintedJsonSize));
  assert.deepEqual(painted.meshes,original.meshes);
  assert.deepEqual(painted.accessors,original.accessors);
  const originalBinary=glb.subarray(28+originalJsonSize);
  assert.deepEqual(paintedGlb.subarray(28+paintedJsonSize,28+paintedJsonSize+originalBinary.length),originalBinary);
  assert.equal(painted.asset.extras.arachne.uvSha256,manifest.metadata.uv_before);
  const maps=await page.evaluate(async url=>{
    const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
    const model=await new GLTFLoader().loadAsync(url);
    const material=model.scene.getObjectByName('Housing').material;
    return {
      transparent:material.transparent,
      sizes:[material.map,material.roughnessMap,material.metalnessMap,material.normalMap,material.aoMap,material.emissiveMap]
        .map(map=>[map.image.width,map.image.height])
    };
  },exported.glbUrl);
  assert.equal(maps.transparent,true);
  assert.deepEqual(maps.sizes,Array.from({length:6},()=>[4096,4096]));
  const lighting={preset:'soft',lightStrength:1.5,environmentStrength:1.1,rotation:33,environmentColor:'#a1a8bb'};
  const camera={projection:'orthographic',eye:[4,3,5],target:[0,0,0],up:[0,1,0],fov:38,orthoHeight:5};
  const preset=captureRenderPreset(updateDeliveryOptions({},{
    framing:'saved',width:384,height:272,samples:8,maxBounces:4,transparent:true
  }));
  doc=await api(paint(doc.id)+'/commands',{revision:doc.revision,operations:[
    {op:'renderCamera',camera},{op:'renderLighting',lighting},{op:'renderPreset',preset}
  ]});
  await page.goto(base+'/?project='+doc.id);
  await page.locator('.editor-viewport[data-state=ready]').first().waitFor();
  await page.getByText('渲染',{exact:true}).filter({visible:true}).first().click();
  await page.locator('#open-paint-render').click();
  await page.locator('#start-paint-render').click();
  const submitted=await waitFor(async()=>(
    await api(project(doc.id)+'/jobs')).find(job=>job.type==='paint-render'),'正式出图任务');
  const rendered=await result(doc.id,submitted);
  assert.equal(rendered.render.engine,'PATH_TRACING');
  assert.deepEqual(rendered.render.camera,camera);
  assert.deepEqual(rendered.render.lighting,lighting);
  assert.equal(rendered.render.revision,doc.revision);
  assert.equal(rendered.render.samples,8);
  assert.deepEqual(rendered.render.resolution,[384,272]);
  assert.equal(rendered.render.uvSha256,manifest.metadata.uv_before);
  assert.equal(rendered.render.textures.color,baked.paintReport.files['f_16xl_BaseColor.png']);
  await page.locator('#paint-render-download').waitFor();
  const download=await page.locator('#paint-render-download').getAttribute('href');
  assert.equal(download,rendered.renderUrl);
  const [file]=await Promise.all([page.waitForEvent('download'),page.locator('#paint-render-download').click()]);
  const imagePath=path.join(data,'formal-render.png');
  await file.saveAs(imagePath);
  const png=await fs.readFile(imagePath);
  assert.equal(hash(png),rendered.render.sha256);
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20),png[24],png[25]],[384,272,8,6]);
  execFileSync(python,['-c',[
    'from PIL import Image',
    'import sys',
    'im=Image.open(sys.argv[1])',
    'assert im.getchannel("A").getextrema() == (0,255)',
    'assert len({p[:3] for p in im.get_flattened_data() if p[3] == 255}) > 20'
  ].join('\n'),imagePath],{stdio:'inherit'});
  const dimmed={...lighting,lightStrength:0,environmentStrength:0};
  const changed=await api(paint(doc.id)+'/commands',{revision:doc.revision,operations:[
    {op:'update',id:doc.paint.layers[0].id,patch:{values:{color:'#913813',metallic:.2,roughness:.6}}},
    {op:'renderLighting',lighting:dimmed}
  ]});
  const cold=await result(doc.id,await api(paint(doc.id)+'/render',{
    revision:changed.revision,requestId:randomUUID(),useProjectCamera:true,
    settings:{width:384,height:272,samples:8,transparent:false}
  },202));
  assert.equal(cold.reusedPaintBake,undefined);
  assert.notEqual(cold.render.textures.color,rendered.render.textures.color);
  const dimmedPath=path.join(data,'formal-render-lights-off.png');
  const dimmedPng=Buffer.from(await (await fetch(base+cold.renderUrl)).arrayBuffer());
  assert.equal(dimmedPng[24],8);
  await fs.writeFile(dimmedPath,dimmedPng);
  execFileSync(python,['-c',[
    'from PIL import Image',
    'import sys',
    'a,b=(Image.open(p).convert("RGBA") for p in sys.argv[1:])',
    'assert b.getchannel("A").getextrema() == (255,255)',
    'lit=[p[:3] for p in a.get_flattened_data() if p[3]==255]',
    'dark=[q[:3] for p,q in zip(a.get_flattened_data(),b.get_flattened_data()) if p[3]==255]',
    'assert sum(map(sum,lit)) > sum(map(sum,dark))*2'
  ].join('\n'),imagePath,dimmedPath],{stdio:'inherit'});
  assert.deepEqual(blenderRequests,[]);
  await assert.rejects(fs.stat(blenderMarker),{code:'ENOENT'});
  console.log('PASS formal PNG from saved camera, project lighting and both fresh and reused 4K textures without starting Blender');
  doc=changed;
  await browser.close();
  browser=null;
  console.log('PASS web viewport, eight 4K textures and editable ZIP round trip without Blender');
  console.log('PASS Blender-free GLB with embedded PBR maps and byte-identical mesh/UV buffers');

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
  if(process.env.ARACHNE_VERIFY_LEGACY_CYCLES==='1'){
    await stop();
    await start(blenderExecutable());
    if(windows)assert.equal((await api('/api/health')).interactiveCycles,false);
    const frame=await fetch(base+paint(doc.id)+'/render-view',{
      method:'POST',headers:{'Content-Type':'application/json','Origin':base},
      body:JSON.stringify({revision:doc.revision,quality:'detail',settings:{
        width:256,height:192,samples:2,device:'cpu',
        camera:{projection:'perspective',eye:[5,-7,5],target:[0,0,0],up:[0,0,1]}
      }})
    });
    assert.equal(frame.status,200,frame.ok?'':await frame.text());
    const pixels=Buffer.from(await frame.arrayBuffer());
    assert.equal(frame.headers.get('x-cycles-device'),'CPU');
    assert.equal(frame.headers.get('x-cycles-revision'),String(doc.revision));
    assert.equal(frame.headers.get('x-cycles-map-resolution'),'4096');
    assert.equal(frame.headers.get('x-cycles-sha256'),hash(pixels));
    assert.equal(pixels.readUInt32BE(16),256);
    assert.equal(pixels.readUInt32BE(20),192);
    console.log('PASS same-revision Cycles viewport frame with 4K textures');
    await stop();
    await start(noBlender);
  }
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
    ' r=json.loads(z.read("project-report.json"))',
    ' assert {"model.glb", "materials.json", "render.png", "render-report.json", "projection-report.json"} <= set(r["fileSha256"])',
    ' assert r["delivery"]["render"]["engine"] == "PATH_TRACING"',
    ' assert not any(name.endswith(".blend") for name in z.namelist())',
    ' assert r["delivery"]["model"]["uvSha256"] == json.loads(z.read("materials.json"))["uvSha256"]',
    ' for name,digest in r["fileSha256"].items():',
    '  assert hashlib.sha256(z.read(name)).hexdigest()==digest'
  ].join('\n'),deliveryPath],{stdio:'inherit'});
  await assert.rejects(fs.stat(blenderMarker),{code:'ENOENT'});
  console.log('PASS native delivery of edited legacy model with verified hashes and Blender unavailable');
  const libraryOrigin=await api('/api/projects',{workflowType:'pbr_paint',name:'资源库原始工程'},201);
  const resources=[['aluminum','Aluminum 7075','#627b90'],['primer','Matte Primer','#929171']];
  const librarySource=await api(paint(libraryOrigin.id)+'/commands',{revision:libraryOrigin.revision,operations:resources.map(([id,name,color])=>({
    op:'library',library:'materials',id,action:'create',patch:{name,graph:defaultLibraryMaterial({color,metallic:.7,roughness:.32})}
  }))});
  let personal=await api('/api/personal-library');
  for(const [id] of resources){
    const saved=await api('/api/personal-library/save',{revision:personal.revision,projectId:libraryOrigin.id,
      projectRevision:librarySource.revision,kind:'materials',resourceId:id});
    personal=saved.state;
  }
  const libraryTarget=await api('/api/projects',{workflowType:'pbr_paint',name:'资源库导入工程'},201);
  await page.goto(base+'/?project='+libraryTarget.id);
  await page.locator('.area-switch [data-area-mode=material]:enabled').click();
  const primary=page.locator('.editor-area[data-editor=library]').first();
  await primary.getByRole('button',{name:'资源库范围',exact:true}).click();
  await page.getByRole('option',{name:'个人',exact:true}).click();
  const shelf=primary.locator('.personal-shelf');
  const aluminum=shelf.getByRole('button',{name:'Aluminum 7075',exact:true});
  const primer=shelf.getByRole('button',{name:'Matte Primer',exact:true});
  await aluminum.waitFor();
  await aluminum.click();
  assert.equal(await aluminum.getAttribute('aria-pressed'),'true');
  await page.keyboard.press('End');
  assert.equal(await primer.evaluate(node=>document.activeElement===node),true);
  await primary.getByRole('searchbox',{name:'搜索资源'}).fill('ＡＬＵ  7075');
  assert.equal(await shelf.locator('.library-tile').count(),1);
  await aluminum.dblclick();
  const imported=await waitFor(async()=>{
    const value=await api(project(libraryTarget.id));
    return Object.keys(value.paint.materials||{}).length===1&&value;
  },'从个人库双击导入');
  const [materialId]=Object.keys(imported.paint.materials);
  assert.notEqual(materialId,'aluminum');
  await shelf.waitFor({state:'hidden'});
  await primary.locator('[data-resource-id='+JSON.stringify(materialId)+']').dblclick();
  const applied=await waitFor(async()=>{
    const value=await api(project(libraryTarget.id));
    return value.paint.layers.some(layer=>layer.materialId===materialId)&&value;
  },'从项目库双击创建填充层');
  assert.equal(applied.paint.layers.length,1);
  assert.deepEqual((await api(project(libraryOrigin.id))).paint.materials,librarySource.paint.materials);
  assert.deepEqual(await api('/api/personal-library'),personal);
  console.log('PASS resource grid keyboard focus, normalized search, double-click personal import and double-click material application');
  await page.locator('.area-switch [data-area-mode=material]:enabled').waitFor();
  await page.keyboard.press('F3');
  await page.locator('#command-search').fill('后台任务');
  await page.keyboard.press('Enter');
  const monitor=page.locator('#task-monitor');
  await monitor.waitFor();
  await monitor.getByRole('button',{name:'进行中',exact:true}).click();
  const running=await api(paint(libraryTarget.id)+'/render',{revision:applied.revision,requestId:randomUUID(),
    settings:{width:320,height:256,samples:128,device:'cpu'}},202);
  const taskPath=project(libraryTarget.id)+'/jobs/';
  const taskRow=monitor.locator('[data-job-id='+JSON.stringify(running.id)+']');
  await taskRow.waitFor();
  await monitor.getByRole('button',{name:'取消任务',exact:true}).click();
  await waitFor(async()=>(await api(taskPath+running.id)).status==='cancelled','取消后台出图');
  await monitor.getByRole('button',{name:'已中止',exact:true}).click();
  await taskRow.getByText('已取消').waitFor();
  const jobLog=path.join(data,'projects',libraryTarget.id,'jobs',running.id,'run.log');
  await fs.appendFile(jobLog,'TEST OLDEST\n'+'过程\n'.repeat(7000)+'TEST END\n');
  const tail=await api(taskPath+running.id+'/log');
  assert.equal(tail.truncated,true);
  assert.ok(Buffer.byteLength(tail.text)<=32768);
  assert.doesNotMatch(tail.text,/TEST OLDEST/);
  assert.match(tail.text,/TEST END/);
  await monitor.getByText('运行日志',{exact:true}).click();
  await monitor.getByText('显示日志末尾 32 KiB').waitFor();
  assert.match(await monitor.locator('pre').textContent(),/TEST END/);
  await page.screenshot({path:path.join(data,'task-monitor.png')});
  await monitor.getByRole('button',{name:'重试任务',exact:true}).click();
  const retried=await waitFor(async()=>(await api(project(libraryTarget.id)+'/jobs')).find(job=>job.retryOf===running.id),'重试后台出图');
  await monitor.locator('[data-job-id='+JSON.stringify(retried.id)+'][aria-pressed=true]').waitFor();
  await monitor.getByRole('button',{name:'取消任务',exact:true}).click();
  await waitFor(async()=>(await api(taskPath+retried.id)).status==='cancelled','取消验收任务');
  await page.keyboard.press('Escape');
  await monitor.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
  console.log('PASS background task filters, bounded inline logs, cancellation and retry selection');
}catch(error){console.error(log);throw error;}
finally{if(browser)await browser.close();await stop();console.log('Demo verification data:',data);}
