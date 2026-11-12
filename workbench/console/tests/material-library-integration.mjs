import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {pythonExecutable} from '../python-runtime.mjs';
import {newMaskEffect} from '../public/paint-mask-effects.mjs';

const root=path.resolve(import.meta.dirname,'..');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-material-library-'));
const marker=path.join(data,'blender-invoked'),probe=path.join(data,'blender-probe');
if(process.platform!=='win32')await fs.writeFile(probe,'#!/bin/sh\ntouch "$(dirname "$0")/blender-invoked"\nexit 42\n',{mode:0o700});
const services=[];
let browser,logs='',origin;
async function until(check,label='material workflow'){
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    const result=await check();
    if(result)return result;
    await delay(125);
  }
  throw Error('Timed out: '+label);
}
async function start(folder){
  const socket=net.createServer().listen(0,'127.0.0.1');
  await once(socket,'listening');
  const {port}=socket.address();
  await new Promise(resolve=>socket.close(resolve));
  const url='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:root,windowsHide:true,
    env:{...process.env,ARACHNE_DATA_DIR:folder,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:probe}});
  services.push(child);
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{logs+=bytes;});
  await until(()=>fetch(url+'/api/health').then(response=>response.ok,()=>false),'service ready');
  return url;
}
async function api(route,body){
  const response=await fetch(origin+route,body===undefined?{}:{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json();
  assert.ok(response.ok,JSON.stringify(value));
  return value;
}
async function job(route,op,input){
  const accepted=await api(route+'/paint/'+op,input);
  return until(async()=>{
    const item=await api(route+'/jobs/'+accepted.id);
    if(['failed','cancelled','interrupted'].includes(item.status))throw Error(item.error||item.status);
    return item.status==='completed'&&item;
  },op);
}
try{
  origin=await start(data);
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const packProject=await api('/api/projects',{workflowType:'pbr_paint',modelTemplate:'plane'});
  const packRoute='/api/projects/'+packProject.id,packPaint=packRoute+'/paint';
  const packedFiles=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import base64,io,json',
    'from PIL import Image',
    'specs={"蓝钢_BaseColor.png":(28,126,212,255),"蓝钢_ORM.png":(48,120,200,255),"蓝钢_Normal.png":(128,51,230,255)}',
    'files={}',
    'for name,pixel in specs.items():',
    ' out=io.BytesIO();Image.new("RGBA",(4096,4096),pixel).save(out,format="PNG");files[name]=base64.b64encode(out.getvalue()).decode()',
    'print(json.dumps(files))'
  ].join('\n')],{encoding:'utf8',maxBuffer:2*1024*1024}));
  const packedPage=await browser.newPage({viewport:{width:1100,height:700}});
  await packedPage.goto(origin+'/?project='+packProject.id);
  await packedPage.locator('[data-area-mode=material]').click();
  await packedPage.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  const packedShelf=packedPage.locator('.editor-area[data-editor=library]').first();
  await packedShelf.getByRole('tab',{name:'材质',exact:true}).click();
  await packedShelf.getByRole('button',{name:'从贴图创建材质',exact:true}).click();
  const packedDialog=packedPage.getByRole('dialog',{name:'从贴图创建材质',exact:true});
  await packedDialog.getByLabel('导入材质贴图').setInputFiles(Object.entries(packedFiles).map(([name,data])=>
    ({name,mimeType:'image/png',buffer:Buffer.from(data,'base64')})));
  await packedDialog.getByRole('button',{name:'贴图通道布局',exact:true}).filter({hasText:'Unreal · ORM'}).waitFor();
  assert.equal(await packedDialog.getByLabel('材质名称').inputValue(),'蓝钢');
  await packedDialog.getByRole('button',{name:'法线方向',exact:true}).click();
  await packedPage.getByRole('option',{name:'DirectX（−Y）',exact:true}).click();
  await packedPage.screenshot({path:path.join(data,'packed-material-import.png')});
  await packedDialog.getByRole('button',{name:'创建材质',exact:true}).click();
  await packedDialog.waitFor({state:'hidden'});
  await packedShelf.getByRole('button',{name:'蓝钢',exact:true}).dblclick();
  const packedMaterial=await until(async()=>{
    const doc=await api(packRoute);
    return doc.paint.layers.some(layer=>layer.materialId)&&doc;
  });
  const packJob=await api(packPaint+'/preview',{revision:packedMaterial.revision,requestId:'packed-import-bake'});
  const packBake=await until(async()=>{
    const job=await api(packRoute+'/jobs/'+packJob.id);
    if(job.status==='failed')throw Error(job.error);
    return job.status==='completed'&&job;
  });
  const unpackedFiles=[];
  for(const [channel,url] of Object.entries({color:packBake.colorUrl,...packBake.materialUrls})){
    if(!['color','ao','roughness','metallic','normal'].includes(channel))continue;
    const file=path.join(data,'packed-material-'+channel+'.png');
    await fs.writeFile(file,Buffer.from(await (await fetch(origin+url)).arrayBuffer()));
    unpackedFiles.push(file);
  }
  const unpacked=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import json,sys', 'from pathlib import Path','from PIL import Image',
    'print(json.dumps({Path(f).stem.replace("packed-material-",""): [Image.open(f).size, Image.open(f).getpixel((2048,2048))] for f in sys.argv[1:]}))'
  ].join('\n'),...unpackedFiles],{encoding:'utf8'}));
  assert.deepEqual(unpacked,{
    color:[[4096,4096],[28,126,212]],ao:[[4096,4096],48],roughness:[[4096,4096],120],
    metallic:[[4096,4096],200],normal:[[4096,4096],[128,204,230]]
  });
  await packedPage.reload();
  await packedShelf.getByRole('button',{name:'蓝钢',exact:true}).waitFor();
  assert.deepEqual((await api(packRoute)).paint.materials,packedMaterial.paint.materials);
  console.log('PASS 4K ORM import and DirectX normal conversion from the resource library, exact linear samples and reopen');

  const libraryLayer=packedMaterial.paint.layers[0],overlayId='drawing-over-library',overlayLayer='drawing-pixels';
  const overlaySeed=await api(packPaint+'/commands',{revision:packedMaterial.revision,operations:[
    {op:'image',action:'create',documentId:overlayId,patch:{name:'蓝钢图案'}},
    {op:'image',action:'addLayer',documentId:overlayId,layerId:overlayLayer,kind:'pixel'},
    {op:'image',action:'stroke',documentId:overlayId,layerId:overlayLayer,target:'pixels',
      stroke:{uv:true,rect:[.35,.35,.65,.65],color:'#dc4214',opacity:.5,erase:false}}
  ]});
  await packedPage.reload();
  await packedPage.locator('[data-area-mode=drawing]').click();
  const packedDrawing=packedPage.locator('.editor-area[data-editor=image]').first();
  const packedCanvas=packedDrawing.getByLabel('图像文档画布');
  await packedCanvas.waitFor();
  await packedDrawing.getByRole('button',{name:'材质引用图层',exact:true}).click();
  await packedPage.getByRole('option',{name:'蓝钢 · 库材质',exact:true}).click();
  await packedDrawing.getByRole('button',{name:'应用至材质',exact:true}).click();
  const linked=await until(async()=>{
    const doc=await api(packRoute);
    return doc.paint.layers[0].documentMaps?.color===overlayId&&doc;
  });
  assert.equal(linked.revision,overlaySeed.revision+1);
  assert.equal(linked.paint.layers.length,1);
  assert.equal(linked.paint.layers[0].materialId,libraryLayer.materialId);
  await packedDrawing.getByRole('button',{name:'已应用',exact:true}).waitFor();
  await packedDrawing.getByRole('button',{name:'画笔',exact:true}).click();
  const overlayInk=packedDrawing.getByLabel('图像前景色',{exact:true});
  await overlayInk.evaluate(input=>{input.value='#16efaa';input.dispatchEvent(new Event('input',{bubbles:true}));});
  const brush=packedDrawing.getByRole('spinbutton',{name:'像素半径',exact:true});
  await brush.fill('200');
  await brush.press('Tab');
  const canvasBounds=await packedCanvas.boundingBox();
  const x=canvasBounds.x+canvasBounds.width*.75,y=canvasBounds.y+canvasBounds.height*.25;
  await packedPage.mouse.move(x-4,y);await packedPage.mouse.down();
  await packedPage.mouse.move(x+4,y,{steps:4});await packedPage.mouse.up();
  const overlayEdited=await until(async()=>{
    const doc=await api(packRoute);
    return doc.paint.imageDocuments[overlayId].layers[0].strokes.length===2&&doc;
  });
  assert.deepEqual(overlayEdited.paint.materials,packedMaterial.paint.materials);
  await packedPage.locator('[data-area-mode=material]').click();
  await packedPage.locator('[data-layer-id="'+libraryLayer.id+'"] .layer-select').click();
  await packedPage.locator('details[data-property-section=linked-drawings]').filter({visible:true}).first().waitFor();
  await packedPage.screenshot({path:path.join(data,'linked-library-drawing.png')});
  const overlayJob=await api(packPaint+'/preview',{revision:overlayEdited.revision,requestId:'library-drawing-4k'});
  const overlayBake=await until(async()=>{
    const job=await api(packRoute+'/jobs/'+overlayJob.id);
    if(job.status==='failed')throw Error(job.error);
    return job.status==='completed'&&job;
  });
  const painted=path.join(data,'packed-material-drawing.png');
  await fs.writeFile(painted,Buffer.from(await (await fetch(origin+overlayBake.colorUrl)).arrayBuffer()));
  const overlayPixels=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import json,sys','from PIL import Image',
    'im=Image.open(sys.argv[1]);print(json.dumps([im.getpixel(p) for p in [(2048,2048),(3072,1024),(512,512)]]))'
  ].join('\n'),painted],{encoding:'utf8'}));
  assert.deepEqual(overlayPixels[1],[22,239,170]);
  assert.deepEqual(overlayPixels[2],[28,126,212]);
  const decode=byte=>{const s=byte/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;};
  const encode=value=>Math.round((value<=.0031308?value*12.92:1.055*value**(1/2.4)-.055)*255);
  assert.deepEqual(overlayPixels[0],[220,66,20].map((value,channel)=>encode((decode(value)*128+decode([28,126,212][channel])*127)/255)));
  assert.equal(overlayBake.paintReport.files['f_16xl_roughness.png'],packBake.paintReport.files['f_16xl_roughness.png']);
  assert.equal(overlayBake.paintReport.uv_unchanged,true);
  await packedPage.reload();
  assert.deepEqual((await api(packRoute)).paint.imageDocuments[overlayId],overlayEdited.paint.imageDocuments[overlayId]);
  const reverted=await api(packPaint+'/undo',{revision:overlayEdited.revision});
  assert.equal(reverted.paint.imageDocuments[overlayId].layers[0].strokes.length,1);
  const unbound=await api(packPaint+'/undo',{revision:reverted.revision});
  assert.equal(unbound.paint.layers[0].documentMaps,undefined);
  console.log('PASS drawing bound onto an existing library fill, live edits, linear alpha, unchanged sibling channels, reopen and undo');


  const rebind=await api(packPaint+'/redo',{revision:unbound.revision});
  const restoredBrush=await api(packPaint+'/redo',{revision:rebind.revision});
  const newLayer=await api(packPaint+'/commands',{revision:restoredBrush.revision,operations:[
    {op:'add',kind:'fill',patch:{name:'边缘磨损',maskEnabled:true,
      values:{color:'#e5bd70',metallic:.85,roughness:.26},channels:{color:true,metallic:true,roughness:true},
      maskEffects:[{...newMaskEffect('edgeWear'),width:6}]}}
  ]});
  const smartName='蓝钢与边缘磨损';
  const grouped=await api(packPaint+'/commands',{revision:newLayer.revision,operations:[
    {op:'group',ids:newLayer.paint.layers.map(layer=>layer.id),patch:{name:smartName}}
  ]});
  const group=grouped.paint.layers[0];
  await packedPage.reload();
  await packedPage.locator('[data-area-mode=material]').click();
  await packedPage.locator('[data-layer-id="'+group.id+'"] .layer-select').click({button:'right'});
  await packedPage.getByRole('menuitem',{name:'保存为智能材质',exact:true}).click();
  await packedShelf.getByRole('tab',{name:'智能材质',exact:true}).waitFor();
  const smartTile=packedShelf.getByRole('button',{name:smartName,exact:true});
  await smartTile.waitFor();
  const saved=(await api('/api/personal-library')).items;
  const recipe=Object.values(saved).find(item=>item.name===smartName);
  assert.equal(recipe.kind,'smartMaterials');
  assert.equal(recipe.layerCount,2);
  assert.equal(Object.keys(recipe.assets).length,3);
  assert.deepEqual((await api(packRoute)).paint,grouped.paint);
  async function savedView(id){
    return packedPage.evaluate(projectId=>{
      const state=JSON.parse(localStorage.getItem('arachne-area-workspaces-v1')||'{}');
      const area=state.material?.first?.first;
      return area?.states?.viewport?.projectViews?.[projectId]??null;
    },id);
  }
  const sourceView=packedPage.locator('.editor-viewport[data-state=ready]').first();
  await sourceView.waitFor();
  const initialView=await until(()=>savedView(packProject.id),'initial project camera');
  await sourceView.locator('canvas').first().hover();
  for(let i=0;i<8;i++)await packedPage.mouse.wheel(0,-600);
  const zoomed=await until(async()=>{
    const view=await savedView(packProject.id);
    return view&&JSON.stringify(view.camera.eye)!==JSON.stringify(initialView.camera.eye)&&view;
  },'zoomed project camera saved');

  const newProject=await api('/api/projects',{workflowType:'pbr_paint',modelTemplate:'cube',name:'智能材质副本验收'});
  const newRoute='/api/projects/'+newProject.id;
  await packedPage.goto(origin+'/?project='+newProject.id);
  await packedPage.locator('[data-area-mode=material]').click();
  await packedShelf.getByRole('tab',{name:'智能材质',exact:true}).click();
  await smartTile.dblclick();
  const applied=await until(async()=>{
    const project=await api(newRoute);
    return project.paint.layers.length===3&&project;
  },'smart material applied as one revision');
  assert.equal(applied.revision,1);
  const [appliedGroup,appliedFill,appliedWear]=applied.paint.layers;
  assert.notEqual(appliedGroup.id,group.id);
  assert.equal(appliedFill.parentId,appliedGroup.id);
  assert.equal(appliedWear.parentId,appliedGroup.id);
  assert.notEqual(appliedFill.materialId,libraryLayer.materialId);
  assert.notEqual(appliedFill.documentMaps.color,overlayId);
  assert.deepEqual(applied.paint.materials[appliedFill.materialId].graph,grouped.paint.materials[libraryLayer.materialId].graph);
  assert.deepEqual(applied.paint.imageDocuments[appliedFill.documentMaps.color],overlayEdited.paint.imageDocuments[overlayId]);
  await packedPage.locator('[data-layer-id="'+appliedWear.id+'"] .layer-select').waitFor();
  await packedPage.locator('.editor-viewport[data-state=ready]').first().waitFor();
  const freshView=await until(()=>savedView(newProject.id),'new project framed independently');
  assert.notDeepEqual(freshView.camera.eye,zoomed.camera.eye);
  await packedPage.locator('.editor-viewport[data-rendered-paint-revision="'+applied.revision+'"]').first().waitFor();
  await packedPage.locator('.editor-preview-status').filter({hasText:'实时材质'}).first().waitFor();
  await packedPage.screenshot({path:path.join(data,'smart-material-workbench.png')});

  const smartBake=await job(newRoute,'preview',{revision:applied.revision,requestId:'smart-material-cube-4k'});
  assert.deepEqual(smartBake.paintReport.resolution,[4096,4096]);
  assert.equal(smartBake.paintReport.protectedTexelsWritten,0);
  assert.equal(smartBake.paintReport.uv_unchanged,true);
  const smartFile=path.join(data,'smart-material-cube.png');
  await fs.writeFile(smartFile,Buffer.from(await (await fetch(origin+smartBake.colorUrl)).arrayBuffer()));
  const smartPixels=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import json,sys','from PIL import Image',
    'im=Image.open(sys.argv[1]);print(json.dumps([im.getpixel((int(x*4096),1024)) for x in (.024,.166)]))'
  ].join('\n'),smartFile],{encoding:'utf8'}));
  assert.deepEqual(smartPixels,[[229,189,112],[28,126,212]]);

  const backup=await job(newRoute,'backup',{revision:applied.revision,requestId:'smart-material-portable'});
  const zip=await (await fetch(origin+backup.archiveUrl)).arrayBuffer();
  const clean=await start(path.join(data,'clean'));
  const imported=await fetch(clean+'/api/projects/paint-import',{method:'POST',headers:{'Content-Type':'application/zip'},body:zip});
  const importedProject=await imported.json();
  assert.equal(imported.status,201,JSON.stringify(importedProject));
  assert.deepEqual(importedProject.paint,applied.paint);
  assert.equal(importedProject.source.uvSha256,applied.source.uvSha256);
  const undo=await api(newRoute+'/paint/undo',{revision:applied.revision});
  assert.deepEqual(undo.paint,newProject.paint);
  const redo=await api(newRoute+'/paint/redo',{revision:undo.revision});
  assert.deepEqual(redo.paint,applied.paint);
  const changed=await api(newRoute+'/paint/commands',{revision:redo.revision,operations:[
    {op:'update',id:appliedWear.id,patch:{maskEffects:[{...appliedWear.maskEffects[0],width:2}]}}
  ]});
  assert.equal(changed.paint.layers.at(-1).maskEffects[0].width,2);
  assert.equal((await api(packRoute)).paint.layers.at(-1).maskEffects[0].width,6);
  assert.deepEqual((await api('/api/personal-library')).items[recipe.id],recipe);
  console.log('PASS smart material saved and applied in the browser, different model, editable copies, 4K wear, atomic undo and clean ZIP restore');

  const parentFolder=await api(newRoute+'/paint/commands',{revision:changed.revision,operations:[
    {op:'add',kind:'group',patch:{name:'拖入智能材质'}}
  ]});
  const parent=parentFolder.paint.layers.at(-1);
  await packedPage.reload();
  await packedPage.locator('[data-area-mode=material]').click();
  await packedShelf.getByRole('tab',{name:'智能材质',exact:true}).click();
  const folderRow=packedPage.locator('[data-layer-id="'+parent.id+'"]');
  const rowBounds=await folderRow.boundingBox();
  await smartTile.dragTo(folderRow,{targetPosition:{x:rowBounds.width/2,y:rowBounds.height/2}});
  const dropped=await until(async()=>{
    const project=await api(newRoute);
    return project.paint.layers.some(layer=>layer.parentId===parent.id)&&project;
  },'dragging a smart material into the target folder');
  const nested=dropped.paint.layers.find(layer=>layer.parentId===parent.id);
  assert.equal(nested.name,smartName);
  assert.equal(dropped.paint.layers.filter(layer=>layer.parentId===nested.id).length,2);
  assert.equal(dropped.revision,parentFolder.revision+1);
  const locked=await api(newRoute+'/paint/commands',{revision:dropped.revision,operations:[
    {op:'update',id:parent.id,patch:{locked:true}}
  ]});
  const rejected=await fetch(origin+newRoute+'/paint/library-import',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({revision:locked.revision,id:recipe.id,libraryRevision:1,placement:{targetId:parent.id,zone:'inside'}})
  });
  assert.equal(rejected.status,400);
  assert.deepEqual((await api(newRoute)).paint,locked.paint);
  console.log('PASS dragging smart materials into a folder with atomic placement and lock checks');

  await packedPage.goto(origin+'/?project='+packProject.id);
  await packedPage.locator('[data-area-mode=material]').click();
  await sourceView.waitFor();
  await packedPage.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  const returnedView=await savedView(packProject.id);
  assert.equal(returnedView.camera.projection,zoomed.camera.projection);
  for(const key of ['eye','target','up'])
    returnedView.camera[key].forEach((value,index)=>assert.ok(Math.abs(value-zoomed.camera[key][index])<1e-7));
  console.log('PASS independent camera framing and camera restoration across projects');

  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
}finally{
  await browser?.close();
  for(const child of services)if(child.exitCode===null&&child.signalCode===null){
    const exited=once(child,'exit');
    child.kill();
    await exited;
  }
  console.log(logs,'Material workflow verification data:',data);
}
