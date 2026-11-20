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
import {mappedLibraryMaterial} from '../public/paint-library-maps.mjs';

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
    'specs={"蓝钢_BaseColor.webp":((28,126,212,255),"WEBP",dict(lossless=True),4096),"蓝钢_ORM.tga":((48,120,200,255),"TGA",dict(compression="tga_rle"),4096),"蓝钢_Normal.png":((128,51,230,255),"PNG",{},4096),"蓝钢_2K_BaseColor.webp":((144,47,39,255),"WEBP",dict(lossless=True),2048),"蓝钢_ORM_1K.tga":((160,40,8,255),"TGA",dict(compression="tga_rle"),1024)}',
    'files={}',
    'for name,(pixel,kind,settings,size) in specs.items():',
    ' out=io.BytesIO();Image.new("RGBA",(size,size),pixel).save(out,format=kind,**settings);files[name]=base64.b64encode(out.getvalue()).decode()',
    'print(json.dumps(files))'
  ].join('\n')],{encoding:'utf8',maxBuffer:4*1024*1024}));
  const packedPage=await browser.newPage({viewport:{width:1100,height:700}});
  const pageErrors=[];
  packedPage.on('pageerror',error=>pageErrors.push(error.message));
  await packedPage.goto(origin+'/?project='+packProject.id);
  await packedPage.locator('[data-area-mode=material]').click();
  await packedPage.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  const packedShelf=packedPage.locator('.editor-area[data-editor=library]').first();
  await packedShelf.getByRole('tab',{name:'材质',exact:true}).click();
  await packedShelf.getByRole('button',{name:'从贴图创建材质',exact:true}).click();
  const packedDialog=packedPage.getByRole('dialog',{name:'从贴图创建材质',exact:true});
  await packedDialog.getByRole('status').filter({hasText:'没有贴图'}).waitFor();
  const mixedFiles=Object.entries(packedFiles).map(([name,data])=>({name,mimeType:'application/octet-stream',buffer:Buffer.from(data,'base64')}));
  await packedDialog.getByLabel('导入材质贴图').setInputFiles([mixedFiles[0],
    {name:'无效贴图.tga',mimeType:'application/octet-stream',buffer:Buffer.from('unreadable')}]);
  await packedDialog.getByRole('alert').filter({hasText:'无法读取贴图：无效贴图.tga'}).waitFor();
  assert.deepEqual((await api(packRoute)).paint.assets,{});
  assert.equal((await api(packRoute)).revision,packProject.revision);
  await packedDialog.getByLabel('导入材质贴图').setInputFiles(mixedFiles);
  await packedDialog.getByRole('button',{name:'贴图通道布局',exact:true}).filter({hasText:'Unreal · ORM'}).waitFor();
  assert.equal((await api(packRoute)).revision,packProject.revision+1);
  assert.equal(await packedDialog.getByLabel('材质名称').inputValue(),'蓝钢');
  const confirmMap=packedDialog.getByRole('button',{name:'创建材质',exact:true});
  assert.equal(await confirmMap.isEnabled(),false);
  await packedDialog.getByRole('status').filter({hasText:'2 项待选择'}).waitFor();
  await packedDialog.getByRole('button',{name:'颜色',exact:true}).filter({hasText:'2 张候选'}).click();
  const largeColor=packedDialog.getByRole('option',{name:'蓝钢_BaseColor.webp · 4096 × 4096',exact:true});
  const smallColor=packedDialog.getByRole('option',{name:'蓝钢_2K_BaseColor.webp · 2048 × 2048',exact:true});
  await smallColor.waitFor();
  await until(()=>largeColor.locator('img').evaluate(img=>img.naturalWidth===128),'preview for the large color candidate');
  await until(()=>smallColor.locator('img').evaluate(img=>img.naturalWidth===128),'preview for the small color candidate');
  await packedPage.screenshot({path:path.join(data,'material-map-candidates.png')});
  await largeColor.click();
  assert.equal(await confirmMap.isEnabled(),false);
  await packedDialog.getByRole('button',{name:'打包贴图',exact:true}).filter({hasText:'2 张候选'}).click();
  await packedDialog.getByRole('option',{name:'蓝钢_ORM_1K.tga · 1024 × 1024',exact:true}).waitFor();
  await packedDialog.getByRole('option',{name:'蓝钢_ORM.tga · 4096 × 4096',exact:true}).click();
  await packedDialog.getByRole('button',{name:'法线方向',exact:true}).click();
  await packedPage.getByRole('option',{name:'DirectX（−Y）',exact:true}).click();
  await packedPage.screenshot({path:path.join(data,'packed-material-import.png')});
  await confirmMap.click();
  await packedDialog.waitFor({state:'hidden'});
  await packedShelf.getByRole('button',{name:'＋ 新建',exact:true}).click();
  await packedShelf.getByRole('button',{name:'新材质',exact:true}).waitFor();
  await packedShelf.getByRole('button',{name:'蓝钢',exact:true}).click();
  const desktopSize=packedPage.viewportSize(),sideShelf=packedPage.locator('[data-area-id=side-bottom]');
  const sidePicker=sideShelf.getByRole('button',{name:'编辑器类型',exact:true});
  const originalType=await sideShelf.locator('.area-editor-picker select option:checked').innerText();
  await packedPage.setViewportSize({width:1000,height:680});
  await sidePicker.click();
  await packedPage.getByRole('option',{name:'资源库',exact:true}).click();
  const sideSearch=sideShelf.getByRole('searchbox',{name:'搜索资源'});
  const sideApply=sideShelf.getByRole('button',{name:'创建填充层',exact:true});
  for(const control of [sideShelf.getByRole('button',{name:'资源库范围'}),sideSearch,sideApply]){
    assert.ok(await control.evaluate(node=>{
      const r=node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    }),'library scope, search and apply are reachable without panning the compact header');
  }
  await sideSearch.fill('蓝钢');
  await sideSearch.press('ArrowDown');
  await packedPage.keyboard.press('Enter');
  assert.ok(await sideApply.isEnabled());
  await sidePicker.click();
  await packedPage.getByRole('option',{name:originalType,exact:true}).click();
  await packedPage.setViewportSize(desktopSize);
  const searchResource=packedShelf.getByRole('searchbox',{name:'搜索资源'});
  const createFill=packedShelf.getByRole('button',{name:'创建填充层',exact:true});
  await searchResource.fill('新材质');
  assert.deepEqual(await packedShelf.locator('.library-tile:visible').allTextContents(),['新材质']);
  assert.equal(await createFill.isDisabled(),true);
  assert.equal(await packedShelf.getByRole('button',{name:'保存到个人库'}).isDisabled(),true);
  await searchResource.dispatchEvent('keydown',{key:'ArrowDown',isComposing:true});
  assert.ok(await searchResource.evaluate(el=>el===document.activeElement));
  await searchResource.press('ArrowDown');
  assert.ok(await packedShelf.getByRole('button',{name:'新材质',exact:true}).evaluate(el=>el===document.activeElement));
  assert.equal(await createFill.isDisabled(),true);
  await packedPage.keyboard.press('Enter');
  assert.equal(await createFill.isEnabled(),true);
  await searchResource.fill('蓝钢');
  assert.equal(await createFill.isDisabled(),true);
  const blueTile=packedShelf.getByRole('button',{name:'蓝钢',exact:true});
  const emptyStack=await api(packRoute);
  assert.equal(emptyStack.paint.layers.length,0);
  const firstDrop=packedPage.waitForResponse(r=>r.url().endsWith('/paint/commands')&&r.request().method()==='POST');
  await blueTile.dragTo(packedPage.locator('#base'));
  assert.ok((await firstDrop).ok());
  const firstLayer=(await api(packRoute)).paint.layers[0];
  assert.equal(firstLayer.materialId,await blueTile.getAttribute('data-resource-id'));
  await packedPage.locator('[data-layer-id="'+firstLayer.id+'"] .layer-select[aria-pressed=true]').waitFor();
  await packedPage.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();
  const undoFirst=packedPage.waitForResponse(r=>r.url().endsWith('/paint/undo')&&r.request().method()==='POST');
  await packedPage.locator('#undo').click();
  assert.ok((await undoFirst).ok());
  assert.deepEqual((await api(packRoute)).paint,emptyStack.paint);
  await blueTile.dblclick();
  await searchResource.fill('');
  let packedMaterial=await until(async()=>{
    const doc=await api(packRoute);
    return doc.paint.layers.some(layer=>layer.materialId)&&doc;
  });
  const beforeDrop=packedMaterial.paint;
  const blueRow=packedPage.locator('[data-layer-id="'+beforeDrop.layers.at(-1).id+'"]');
  const otherTile=packedShelf.getByRole('button',{name:'新材质',exact:true});
  const otherId=await otherTile.getAttribute('data-resource-id');
  async function dropBelow(tile){
    const {width,height}=await blueRow.boundingBox();
    const commit=packedPage.waitForResponse(r=>r.request().method()==='POST'&&
      (r.url().endsWith('/paint/commands')||r.url().endsWith('/paint/library-import')));
    await tile.dragTo(blueRow,{targetPosition:{x:width/2,y:height-3}});
    const result=await commit;
    assert.equal(result.ok(),true,await result.text());
    const next=await api(packRoute),layer=next.paint.layers[0];
    assert.equal(next.paint.layers[1].id,beforeDrop.layers[0].id);
    assert.equal(layer.name,'新材质');
    await packedPage.locator('[data-layer-id="'+layer.id+'"] .layer-select[aria-pressed=true]').waitFor();
    return {next,layer};
  }
  async function undoDrop(){
    await packedPage.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();
    const update=packedPage.waitForResponse(r=>r.url().endsWith('/paint/undo')&&r.request().method()==='POST');
    await packedPage.locator('#undo').click();
    assert.ok((await update).ok());
    const next=await api(packRoute);
    assert.deepEqual(next.paint,beforeDrop);
    return next;
  }
  const swatch=await otherTile.boundingBox(),targetBounds=await blueRow.boundingBox();
  const dropX=targetBounds.x+targetBounds.width/2,dropY=targetBounds.y+3;
  await packedPage.mouse.move(swatch.x+swatch.width/2,swatch.y+swatch.height/2);
  await packedPage.mouse.down();
  await packedPage.mouse.move(dropX,dropY,{steps:12});
  await packedPage.mouse.move(dropX+1,dropY);
  assert.equal(await blueRow.getAttribute('data-layer-drop'),'above');
  const destination=packedPage.locator('.material-drop-location');
  assert.deepEqual(await destination.locator('span').allTextContents(),
    ['图层栈顶层','上方 · '+beforeDrop.layers.at(-1).name]);
  await packedPage.keyboard.press('Escape');
  await packedPage.mouse.up();
  assert.equal(await blueRow.getAttribute('data-layer-drop'),null);
  assert.equal(await destination.count(),0);
  assert.equal((await api(packRoute)).revision,packedMaterial.revision);
  const layerSearch=packedPage.locator('#layer-search');
  await packedPage.locator('#toggle-layer-search').click();
  await layerSearch.fill('蓝钢');
  const placed=await dropBelow(otherTile);
  assert.equal(await layerSearch.inputValue(),'蓝钢');
  const placedRow=packedPage.locator('[data-layer-id="'+placed.layer.id+'"]');
  await packedPage.reload();
  await placedRow.locator('.layer-select[aria-pressed=true]').waitFor();
  assert.equal(await layerSearch.inputValue(),'蓝钢');
  assert.ok(await layerSearch.isVisible());
  assert.deepEqual((await api(packRoute)).paint,placed.next.paint);
  await layerSearch.fill('蓝钢 2');
  await placedRow.waitFor({state:'detached'});
  await layerSearch.fill('蓝钢');
  assert.equal(await placedRow.count(),0);
  await layerSearch.press('Escape');
  assert.equal(placed.layer.materialId,otherId);
  assert.equal(placed.next.revision,packedMaterial.revision+1);
  packedMaterial=await undoDrop();
  await packedPage.locator('#toggle-layer-search').click();
  await layerSearch.fill('蓝钢');
  await blueRow.locator('.layer-select').click();
  const doubleClick=packedPage.waitForResponse(r=>r.url().endsWith('/paint/commands')&&r.request().method()==='POST');
  await otherTile.dblclick();
  assert.ok((await doubleClick).ok());
  const top=(await api(packRoute)).paint.layers.at(-1);
  assert.equal(top.materialId,otherId);
  await packedPage.locator('[data-layer-id="'+top.id+'"] .layer-select[aria-pressed=true]').waitFor();
  assert.equal(await layerSearch.inputValue(),'蓝钢');
  assert.ok(await otherTile.evaluate(el=>el===document.activeElement));
  await layerSearch.press('Escape');
  packedMaterial=await undoDrop();
  await blueTile.click();
  const savePersonal=packedShelf.getByRole('button',{name:'保存到个人库'});
  await savePersonal.click();
  const personalBlue=await until(async()=>Object.values((await api('/api/personal-library')).items).find(item=>item.name==='蓝钢'));
  await otherTile.click();
  await savePersonal.click();
  const personalItem=await until(async()=>Object.values((await api('/api/personal-library')).items).find(item=>item.name==='新材质'));
  await packedShelf.getByRole('button',{name:'资源库范围'}).click();
  await packedPage.getByRole('option',{name:'个人',exact:true}).click();
  const personalTile=packedShelf.locator('[data-resource-id="'+personalItem.id+'"]:visible');
  const personalBlueTile=packedShelf.locator('[data-resource-id="'+personalBlue.id+'"]:visible');
  await personalBlueTile.click();
  await packedPage.reload();
  await personalTile.waitFor();
  assert.equal(await personalBlueTile.getAttribute('aria-pressed'),'true');
  assert.equal(await personalTile.getAttribute('aria-pressed'),'false');
  const importedDrop=await dropBelow(personalTile);
  assert.equal(await personalTile.getAttribute('aria-pressed'),'true');
  assert.equal(importedDrop.next.revision,packedMaterial.revision+1);
  assert.notEqual(importedDrop.layer.materialId,otherId);
  assert.deepEqual(importedDrop.next.paint.materials[importedDrop.layer.materialId].graph,beforeDrop.materials[otherId].graph);
  await packedPage.reload();
  await packedShelf.locator('.personal-shelf [data-resource-id="'+personalItem.id+'"][aria-pressed=true]').waitFor();
  assert.equal(await packedShelf.locator('select[aria-label="资源库范围"]').inputValue(),'personal');
  packedMaterial=await undoDrop();
  assert.deepEqual((await api('/api/personal-library')).items[personalItem.id],personalItem);
  assert.equal(await packedShelf.locator('select[aria-label="资源库范围"]').inputValue(),'personal');
  console.log('PASS project and personal materials drop below the selected layer, select the new fill, and undo in one step');
  await packedShelf.getByRole('button',{name:'编辑个人资源'}).click();
  const metadata=packedPage.getByRole('dialog',{name:'编辑个人资源'});
  await metadata.getByLabel('资源标签').fill('试色备选');
  await metadata.getByRole('button',{name:'保存',exact:true}).click();
  await metadata.waitFor({state:'hidden'});
  await searchResource.fill('试色备选');
  await searchResource.press('ArrowDown');
  assert.ok(await personalTile.evaluate(el=>el===document.activeElement));
  const importByTag=packedPage.waitForResponse(r=>r.url().endsWith('/paint/library-import')&&r.request().method()==='POST');
  await personalTile.dblclick();
  const importedByTag=await (await importByTag).json();
  const copyId=importedByTag.resource.id;
  const importedTile=packedShelf.locator('[data-resource-id="'+copyId+'"][aria-pressed=true]:visible');
  await importedTile.waitFor();
  assert.ok(await importedTile.evaluate(el=>el===document.activeElement),'focus follows the imported shelf item');
  assert.equal(await searchResource.inputValue(),personalItem.name);
  await createFill.click();
  await until(async()=>(await api(packRoute)).paint.layers.some(layer=>layer.materialId===copyId),'using the tagged import immediately');
  await packedPage.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();
  await packedPage.locator('#undo').click();
  await until(async()=>(await api(packRoute)).paint.layers.length===beforeDrop.layers.length);
  packedMaterial=await undoDrop();
  await searchResource.fill('');
  console.log('PASS a tag-only personal search reveals the imported project copy ready for use');
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
  console.log('PASS atomic 4K WebP/TGA/PNG import, candidate dimensions and previews, explicit ORM selection, DirectX normals and reopen');

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
      maskStrokeOrder:'after',maskEffects:[{...newMaskEffect('edgeWear'),width:6},
        {...newMaskEffect('surfaceNoise'),blend:'subtract',opacity:.4}]}}
  ]});
  const originalWear=newLayer.paint.layers.at(-1);
  const fixedWear=await api(packPaint+'/commands',{revision:newLayer.revision,operations:[
    {op:'stroke',id:originalWear.id,target:'mask',stroke:{uv:true,rect:[.02,.71,.031,.79],value:0,opacity:1}}
  ]});
  const smartName='蓝钢与边缘磨损';
  const grouped=await api(packPaint+'/commands',{revision:fixedWear.revision,operations:[
    {op:'group',ids:fixedWear.paint.layers.map(layer=>layer.id),patch:{name:smartName}}
  ]});
  const group=grouped.paint.layers[0];
  await packedPage.reload();
  await packedPage.locator('[data-area-mode=material]').click();
  await packedPage.locator('[data-layer-id="'+group.id+'"] .layer-select').click({button:'right'});
  await packedPage.getByRole('menuitem',{name:'保存为智能材质',exact:true}).click();
  await packedShelf.getByRole('tab',{name:'智能材质',exact:true}).waitFor();
  const smartTile=packedShelf.getByRole('button',{name:smartName,exact:true});
  await smartTile.waitFor();
  const {items:saved,revision:recipeRevision}=await api('/api/personal-library');
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
  assert.equal(appliedWear.maskStrokeOrder,'after');
  assert.deepEqual(appliedWear.maskEffects,originalWear.maskEffects);
  assert.deepEqual(appliedWear.maskStrokes,fixedWear.paint.layers.at(-1).maskStrokes);
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
    'im=Image.open(sys.argv[1]);print(json.dumps([im.getpixel((int(x*4096),int(y*4096))) for x,y in ((.024,.75),(.166,.25),(.024,.32))]))'
  ].join('\n'),smartFile],{encoding:'utf8'}));
  assert.deepEqual(smartPixels.slice(0,2),[[28,126,212],[28,126,212]]);
  assert.notDeepEqual(smartPixels[2],[28,126,212]);

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
    {op:'update',id:appliedWear.id,patch:{maskEffects:[{...appliedWear.maskEffects[0],width:2},...appliedWear.maskEffects.slice(1)]}}
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
  await folderRow.locator('.layer-select').click();
  const folderArrow=folderRow.locator('.layer-disclosure');
  if(await folderArrow.getAttribute('aria-expanded')==='true')await folderArrow.click();
  const directImport=packedPage.waitForResponse(r=>r.url().endsWith('/paint/library-import')&&r.request().method()==='POST');
  await smartTile.dblclick();
  const direct=await (await directImport).json();
  const directRoot=direct.document.paint.layers.find(layer=>layer.id===direct.resource.id);
  assert.equal(directRoot.parentId,parent.id);
  assert.equal(direct.document.paint.layers.filter(layer=>layer.parentId===directRoot.id).length,2);
  await packedPage.locator('[data-layer-id="'+directRoot.id+'"] .layer-select[aria-pressed=true]').waitFor();
  assert.equal(await folderArrow.getAttribute('aria-expanded'),'true');
  await packedPage.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();
  const undoApply=packedPage.waitForResponse(r=>r.url().endsWith('/paint/undo')&&r.request().method()==='POST');
  await packedPage.locator('#undo').click();
  const undone=await (await undoApply).json();
  assert.deepEqual(undone.paint,parentFolder.paint);
  await folderRow.locator('.layer-select[aria-pressed=true]').waitFor();
  const rowBounds=await folderRow.boundingBox();
  await smartTile.dragTo(folderRow,{targetPosition:{x:rowBounds.width/2,y:rowBounds.height/2}});
  const dropped=await until(async()=>{
    const project=await api(newRoute);
    return project.paint.layers.some(layer=>layer.parentId===parent.id)&&project;
  },'dragging a smart material into the target folder');
  const nested=dropped.paint.layers.find(layer=>layer.parentId===parent.id);
  assert.equal(nested.name,smartName);
  assert.equal(dropped.paint.layers.filter(layer=>layer.parentId===nested.id).length,2);
  assert.equal(dropped.revision,undone.revision+1);
  await packedPage.locator('[data-layer-id="'+nested.id+'"] .layer-select').click();
  const actions=packedPage.locator('details[data-property-section=actions]').filter({visible:true}).first();
  if(!await actions.evaluate(node=>node.open))await actions.locator('summary').click();
  await actions.getByRole('button',{name:'所属文件夹'}).click();
  await packedPage.getByRole('option',{name:'顶层',exact:true}).click();
  const ungrouped=await until(async()=>{
    const project=await api(newRoute);
    return project.revision>dropped.revision&&project;
  },'moving a nested smart material to the root with its folder selector');
  assert.equal(ungrouped.paint.layers.find(layer=>layer.id===nested.id).parentId,null);
  assert.deepEqual(ungrouped.paint.layers.filter(layer=>layer.parentId===nested.id),
    dropped.paint.layers.filter(layer=>layer.parentId===nested.id));
  const restoredPlacement=await api(newRoute+'/paint/undo',{revision:ungrouped.revision});
  assert.deepEqual(restoredPlacement.paint,dropped.paint);
  const locked=await api(newRoute+'/paint/commands',{revision:restoredPlacement.revision,operations:[
    {op:'update',id:parent.id,patch:{locked:true}}
  ]});
  const rejected=await fetch(origin+newRoute+'/paint/library-import',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({revision:locked.revision,id:recipe.id,libraryRevision:recipeRevision,placement:{targetId:parent.id,zone:'inside'}})
  });
  assert.equal(rejected.status,400);
  assert.deepEqual((await api(newRoute)).paint,locked.paint);
  await packedPage.reload();
  await packedPage.locator('[data-layer-id="'+nested.id+'"] .layer-select').click();
  await packedShelf.getByRole('tab',{name:'智能材质',exact:true}).click();
  await smartTile.click();
  assert.ok(await packedShelf.getByRole('button',{name:'文件夹已锁定'}).isDisabled());
  await smartTile.dblclick();
  await packedShelf.getByRole('status').filter({hasText:'「'+parent.name+'」已锁定'}).waitFor();
  assert.equal((await api(newRoute)).revision,locked.revision);
  await packedShelf.getByRole('button',{name:'资源库范围'}).click();
  await packedPage.getByRole('option',{name:'当前项目',exact:true}).click();
  await packedShelf.getByRole('tab',{name:'材质',exact:true}).click();
  const swatchInLockedFolder=packedShelf.locator('.library-tile:visible').first();
  await swatchInLockedFolder.click();
  assert.ok(await packedShelf.getByRole('button',{name:'文件夹已锁定'}).isDisabled());
  assert.equal(await swatchInLockedFolder.getAttribute('draggable'),'true');
  await swatchInLockedFolder.dblclick();
  await packedPage.locator('#status').filter({hasText:'「'+parent.name+'」已锁定'}).waitFor();
  assert.equal((await api(newRoute)).revision,locked.revision);
  await packedPage.locator('#base').click();
  assert.ok(await createFill.isEnabled());
  console.log('PASS dragging smart materials into a folder with atomic placement and lock checks');

  async function travelTrial(direction='undo'){
    await packedPage.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();
    const response=packedPage.waitForResponse(r=>r.url().endsWith('/paint/'+direction)&&r.request().method()==='POST');
    await packedPage.locator('#'+direction).click();
    assert.ok((await response).ok());
  }
  await travelTrial(); // Unlock the folder.
  const nestedSelect=packedPage.locator('[data-layer-id="'+nested.id+'"] .layer-select');
  const fold=folderRow.locator('.layer-disclosure');
  await fold.click();
  await nestedSelect.waitFor({state:'detached'});
  const swatchBox=await swatchInLockedFolder.boundingBox(),foldBox=await fold.boundingBox();
  await packedPage.mouse.move(swatchBox.x+swatchBox.width/2,swatchBox.y+swatchBox.height/2);
  await packedPage.mouse.down();
  await packedPage.mouse.move(foldBox.x+foldBox.width/2,foldBox.y+foldBox.height/2,{steps:12});
  await packedPage.mouse.move(foldBox.x+foldBox.width/2+1,foldBox.y+foldBox.height/2);
  await nestedSelect.waitFor();
  await packedPage.keyboard.press('Escape');
  await packedPage.mouse.up();
  assert.deepEqual((await api(newRoute)).paint,dropped.paint);
  const firstFold=packedPage.locator('[data-layer-id="'+nested.id+'"] .layer-disclosure');
  if(await firstFold.getAttribute('aria-expanded')==='true')await firstFold.click();
  await sidePicker.click();
  await packedPage.getByRole('option',{name:'材质图层',exact:true}).click();
  const secondFolder=sideShelf.locator('[data-material-layer-id="'+nested.id+'"]');
  await secondFolder.locator('.editor-layer-name').click();
  const secondFold=secondFolder.locator('.material-tree-fold');
  if(await secondFold.getAttribute('aria-expanded')==='true')await secondFold.click();
  const outerFold=sideShelf.locator('[data-material-layer-id="'+parent.id+'"] .material-tree-fold');
  await outerFold.click();
  await secondFolder.waitFor({state:'detached'});
  await swatchInLockedFolder.dblclick();
  const trial=await until(async()=>{
    const doc=await api(newRoute);
    return doc.paint.layers.find(layer=>!dropped.paint.layers.some(old=>old.id===layer.id));
  },'trying a shelf material in the nested folder');
  assert.equal(trial.parentId,nested.id);
  await sideShelf.locator('[data-material-layer-id="'+trial.id+'"] .editor-layer-name[aria-pressed=true]').waitFor();
  assert.equal(await outerFold.getAttribute('aria-expanded'),'true');
  assert.equal(await firstFold.getAttribute('aria-expanded'),'false');
  await travelTrial();
  await packedPage.locator('[data-layer-id="'+nested.id+'"] .layer-select[aria-pressed=true]').waitFor();
  assert.deepEqual((await api(newRoute)).paint,dropped.paint);
  const secondQuery=sideShelf.getByRole('searchbox',{name:'搜索图层'});
  await secondQuery.fill(nested.name);
  await createFill.click();
  const nextTrial=await until(async()=>{
    const doc=await api(newRoute);
    return doc.paint.layers.find(layer=>layer.parentId===nested.id&&!dropped.paint.layers.some(old=>old.id===layer.id));
  },'applying another shelf fill at the same level directly after undo');
  await sideShelf.locator('[data-material-layer-id="'+nextTrial.id+'"] .editor-layer-name').waitFor();
  assert.equal(await secondFold.getAttribute('aria-expanded'),'true');
  assert.equal(await firstFold.getAttribute('aria-expanded'),'false');
  const secondTrial=sideShelf.locator('[data-material-layer-id="'+nextTrial.id+'"] .editor-layer-name[aria-pressed=true]');
  const kept=await api(newRoute);
  await travelTrial();
  await secondFolder.locator('.editor-layer-name[aria-pressed=true]').waitFor();
  await travelTrial('redo');
  await secondTrial.waitFor();
  await packedPage.reload();
  await secondTrial.waitFor();
  assert.equal(await secondQuery.inputValue(),nested.name);
  assert.equal(await firstFold.getAttribute('aria-expanded'),'false');
  const trialOpacity=packedPage.locator('#drawing-layer-opacity');
  await trialOpacity.fill('42');
  const changeOpacity=packedPage.waitForResponse(r=>r.url().endsWith('/paint/commands')&&r.request().method()==='POST');
  await trialOpacity.press('Enter');
  const adjusted=await (await changeOpacity).json();
  assert.deepEqual(adjusted.paint.layers,kept.paint.layers.map(layer=>layer.id===nextTrial.id?{...layer,opacity:.42}:layer));
  const historyDialog=packedPage.locator('#history-dialog');
  for(const direction of ['undo','redo']){
    await packedPage.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();
    await packedPage.locator('#open-history').click();
    await historyDialog.locator('[data-direction="'+direction+'"][data-steps="2"]').click();
    await historyDialog.waitFor({state:'hidden'});
    await (direction==='undo'?secondFolder.locator('.editor-layer-name[aria-pressed=true]'):secondTrial).waitFor();
  }
  assert.equal(await trialOpacity.inputValue(),'42');
  assert.deepEqual((await api(newRoute)).paint,adjusted.paint);
  await travelTrial(); // Undo the opacity change.
  await travelTrial(); // Remove the trial again, then choose a different target.
  await folderRow.locator('.layer-select').click();
  await travelTrial('redo');
  await folderRow.locator('.layer-select[aria-pressed=true]').waitFor();
  assert.deepEqual((await api(newRoute)).paint,kept.paint);
  await sidePicker.click();
  await packedPage.getByRole('option',{name:originalType,exact:true}).click();
  console.log('PASS nested shelf trials keep their parent on undo and reveal the next choice in the originating layer tree');

  await packedPage.goto(origin+'/?project='+packProject.id);
  await packedPage.locator('[data-area-mode=material]').click();
  await sourceView.waitFor();
  await packedPage.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  const returnedView=await savedView(packProject.id);
  assert.equal(returnedView.camera.projection,zoomed.camera.projection);
  for(const key of ['eye','target','up'])
    returnedView.camera[key].forEach((value,index)=>assert.ok(Math.abs(value-zoomed.camera[key][index])<1e-7));
  console.log('PASS independent camera framing and camera restoration across projects');

  const maskingProject=await api('/api/projects',{workflowType:'pbr_paint',modelTemplate:'plane',name:'材质文件夹蒙版'});
  const maskingRoute='/api/projects/'+maskingProject.id,maskingPaint=maskingRoute+'/paint';
  const outer=await api(maskingPaint+'/commands',{revision:maskingProject.revision,operations:[
    {op:'base',patch:{color:'#000000',roughness:.2}},
    {op:'add',kind:'group',patch:{name:'外壳涂层'}}
  ]});
  const folder=outer.paint.layers[0];
  const inside=await api(maskingPaint+'/commands',{revision:outer.revision,operations:[
    {op:'add',kind:'fill',parentId:folder.id,patch:{name:'粗糙度底层',channels:{color:false,roughness:true,metallic:false},
      values:{color:'#000000',roughness:.6,metallic:0}}},
    {op:'add',kind:'group',parentId:folder.id,patch:{name:'局部反光',opacity:.5}}
  ]});
  const inner=inside.paint.layers.find(layer=>layer.name==='局部反光');
  const maskSeed=await api(maskingPaint+'/commands',{revision:inside.revision,operations:[
    {op:'add',kind:'fill',parentId:inner.id,patch:{name:'白色面漆',channels:{color:true,roughness:true,metallic:false},
      values:{color:'#ffffff',roughness:1,metallic:0}}}
  ]});
  const maskPng=execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import base64,io','from PIL import Image',
    'im=Image.new("L",(32,32),0);im.paste(255,(0,0,32,16))',
    'out=io.BytesIO();im.save(out,format="PNG");print(base64.b64encode(out.getvalue()).decode())'
  ].join('\n')],{encoding:'utf8'}).trim();
  const bitmap=await api(maskingPaint+'/assets',{revision:maskSeed.revision,maskLayerId:inner.id,name:'顶部范围.png',data:maskPng});
  await packedPage.goto(origin+'/?project='+maskingProject.id);
  await packedPage.locator('[data-area-mode=material]').click();
  const outerRow=packedPage.locator('[data-layer-id="'+folder.id+'"]');
  const outerMask=outerRow.getByRole('button',{name:'绘制蒙版 · 外壳涂层',exact:true});
  assert.equal(await outerMask.count(),0);
  await outerRow.locator('.layer-select').click({button:'right'});
  await packedPage.getByRole('menuitem',{name:'添加黑色蒙版',exact:true}).click();
  await outerMask.waitFor();
  const addedMask=await until(async()=>{
    const doc=await api(maskingRoute);
    return doc.paint.layers[0].maskEnabled&&doc;
  },'create a folder mask from its context menu');
  assert.equal(addedMask.revision,bitmap.document.revision+1);
  assert.equal(addedMask.paint.layers[0].maskBase,0);
  const groupMask=await api(maskingPaint+'/commands',{revision:addedMask.revision,operations:[
    {op:'stroke',id:folder.id,target:'mask',stroke:{uv:true,rect:[0,0,.5,1],value:1,opacity:1}},
    {op:'update',id:folder.id,patch:{opacity:.5}}
  ]});
  await packedPage.reload();
  await sourceView.waitFor();
  await outerMask.click({modifiers:['Alt']});
  await packedPage.locator('.editor-viewport[data-material-inspection=mask]').first().waitFor();
  const titleBox=await outerRow.locator('.layer-select').boundingBox();
  const maskBox=await outerMask.boundingBox();
  assert.ok(titleBox.width>65&&maskBox.x>titleBox.x&&Math.abs(maskBox.y-titleBox.y)<5);
  await packedPage.screenshot({path:path.join(data,'material-folder-mask.png')});
  const inspected=await fetch(origin+maskingPaint+'/live',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({revision:groupMask.revision,inspectMask:folder.id,resolution:256,format:'pbr8'})});
  assert.equal(inspected.status,200);
  const maskBytes=Buffer.from(await inspected.arrayBuffer());
  assert.equal(maskBytes[(128*256+64)*15],255);
  assert.equal(maskBytes[(128*256+192)*15],0);
  await outerMask.click({modifiers:['Alt']});
  const folderPreview=await job(maskingRoute,'preview',{revision:groupMask.revision,requestId:'folder-mask-4k'});
  const folderMaps=await Promise.all([folderPreview.colorUrl,folderPreview.materialUrls.roughness].map(async(url,i)=>{
    const target=path.join(data,'folder-mask-'+i+'.png');
    await fs.writeFile(target,Buffer.from(await (await fetch(origin+url)).arrayBuffer()));
    return target;
  }));
  const folderPixels=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import json,sys','from PIL import Image','points=((1024,1024),(1024,3072),(3072,1024))',
    'print(json.dumps([[[*im.size],[im.getpixel(p) for p in points]] for im in map(Image.open,sys.argv[1:])]))'
  ].join('\n'),...folderMaps],{encoding:'utf8'}));
  assert.deepEqual(folderPixels,[[[4096,4096],[[137,137,137],[0,0,0],[0,0,0]]],[[4096,4096],[128,102,51]]]);
  await outerMask.click({modifiers:['Shift']});
  const disabled=await until(async()=>{
    const doc=await api(maskingRoute);return doc.paint.layers[0].maskEnabled===false&&doc;
  },'temporarily disable a folder mask');
  assert.equal(disabled.paint.layers[0].maskStrokes.length,1);
  const undoMask=await api(maskingPaint+'/undo',{revision:disabled.revision});
  assert.deepEqual(undoMask.paint,groupMask.paint);
  const maskBackup=await job(maskingRoute,'backup',{revision:undoMask.revision,requestId:'folder-mask-backup'});
  const restoredMask=await fetch(clean+'/api/projects/paint-import',{method:'POST',headers:{'Content-Type':'application/zip'},
    body:await (await fetch(origin+maskBackup.archiveUrl)).arrayBuffer()});
  const restoredFolder=await restoredMask.json();
  assert.equal(restoredMask.status,201,JSON.stringify(restoredFolder));
  assert.deepEqual(restoredFolder.paint.layers,groupMask.paint.layers);
  console.log('PASS nested material folder masks, color and roughness at 4K, mask inspection, disable, undo and clean restore');

  await packedPage.setViewportSize({width:1100,height:940});
  await packedPage.reload();
  const maskTarget=packedPage.locator('[data-layer-id="'+inside.paint.layers.find(layer=>layer.name==='粗糙度底层').id+'"]');
  const targetMask=maskTarget.getByRole('button',{name:'绘制蒙版 · 粗糙度底层',exact:true});
  await outerMask.waitFor();
  await packedPage.keyboard.down('Alt');
  await outerMask.dragTo(maskTarget.locator('.layer-select'));
  await packedPage.keyboard.up('Alt');
  await targetMask.waitFor();
  const copiedMask=await api(maskingRoute);
  const targetId=await maskTarget.getAttribute('data-layer-id');
  const maskedTarget=copiedMask.paint.layers.find(layer=>layer.id===targetId);
  assert.deepEqual(maskedTarget.maskStrokes,groupMask.paint.layers[0].maskStrokes);
  assert.equal(maskedTarget.opacity,1);
  assert.deepEqual(copiedMask.paint.layers[0],groupMask.paint.layers[0]);
  const innerRow=packedPage.locator('[data-layer-id="'+inner.id+'"]');
  await targetMask.dragTo(innerRow.locator('.layer-select'));
  const movedMask=await until(async()=>{
    const doc=await api(maskingRoute);
    return doc.paint.layers.find(layer=>layer.id===inner.id).maskStrokes?.length===1&&doc;
  },'moving a material mask over the previous bitmap');
  assert.equal(movedMask.paint.layers.find(layer=>layer.id===targetId).maskEnabled,undefined);
  await innerRow.locator('.layer-mask').click({button:'right'});
  await packedPage.getByRole('menuitem',{name:'删除蒙版',exact:true}).click();
  const deletedMask=await until(async()=>{
    const doc=await api(maskingRoute);
    return doc.paint.layers.find(layer=>layer.id===inner.id).maskEnabled===undefined&&doc;
  },'removing the selected material mask');
  const undeleted=await api(maskingPaint+'/undo',{revision:deletedMask.revision,steps:2});
  assert.deepEqual(undeleted.paint.layers,copiedMask.paint.layers);
  console.log('PASS material mask drag copy and move across folders, replacement, deletion and multi-step undo');

  const tiled=await api('/api/projects',{workflowType:'pbr_paint',modelTemplate:'plane',name:'库材质 UV 平铺'});
  const tiledRoute='/api/projects/'+tiled.id,tiledPaint=tiledRoute+'/paint';
  const pattern=execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import base64,io','from PIL import Image','im=Image.new("RGB",(32,32))',
    'for x,y,color in ((0,0,"red"),(16,0,"lime"),(0,16,"blue"),(16,16,"yellow")): im.paste(color,(x,y,x+16,y+16))',
    'out=io.BytesIO();im.save(out,format="PNG");print(base64.b64encode(out.getvalue()).decode())'
  ].join('\n')],{encoding:'utf8'}).trim();
  const patternUpload=await api(tiledPaint+'/assets',{revision:tiled.revision,name:'四色标记.png',data:pattern});
  const normalUpload=await api(tiledPaint+'/assets',{revision:patternUpload.document.revision,name:'切线法线.png',data:packedFiles['蓝钢_Normal.png']});
  const tiledGraph=mappedLibraryMaterial({color:patternUpload.asset.id,normal:normalUpload.asset.id},normalUpload.document.paint.assets,{normalFormat:'directx'});
  const tilingSeed=await api(tiledPaint+'/commands',{revision:normalUpload.document.revision,operations:[
    {op:'library',library:'materials',id:'pattern',action:'create',patch:{name:'四色材质',graph:tiledGraph}},
    {op:'add',kind:'fill',patch:{name:'四色填充',materialId:'pattern',channels:{color:true,normal:true,roughness:true,metallic:true}}},
    {op:'image',action:'create',documentId:'center',patch:{name:'固定在 UV 中心的标记'}},
    {op:'image',action:'addLayer',documentId:'center',layerId:'center-pixels',kind:'pixel'},
    {op:'image',action:'stroke',documentId:'center',layerId:'center-pixels',target:'pixels',
      stroke:{uv:true,rect:[.42,.42,.58,.58],color:'#aa55ff',opacity:1,erase:false}}
  ]});
  const targetFill=tilingSeed.paint.layers[0];
  await api(tiledPaint+'/commands',{revision:tilingSeed.revision,operations:[
    {op:'image',action:'bind',documentId:'center',materialLayerId:targetFill.id,channel:'color'}
  ]});
  await packedPage.goto(origin+'/?project='+tiled.id);
  await packedPage.locator('[data-area-mode=material]').click();
  await packedPage.getByRole('button',{name:'四色填充',exact:true}).click();
  const tilingPanel=packedPage.locator('details[data-property-section=uv]').filter({visible:true}).first();
  if(await tilingPanel.getAttribute('open')===null)await tilingPanel.locator('summary').click();
  await tilingPanel.getByRole('checkbox',{name:'重复平铺',exact:true}).check();
  await tilingPanel.getByRole('checkbox',{name:'独立控制 X / Y',exact:true}).check();
  for(const [label,value,key] of [['横向重复','2','repeat'],['旋转角度','90','rotation']]){
    await tilingPanel.locator('xpath=ancestor::form[@aria-busy="false"]').waitFor();
    const input=tilingPanel.getByRole('spinbutton',{name:label,exact:true});
    await input.fill(value);
    await input.press('Tab');
    await until(async()=>(await api(tiledRoute)).paint.layers[0].tiling?.[key]===Number(value),label+'已保存');
  }
  const turned=await api(tiledRoute);
  assert.deepEqual(turned.paint.layers[0].tiling,{repeat:2,repeatY:1,rotation:90,offsetX:0,offsetY:0});
  assert.deepEqual(turned.paint.materials,tilingSeed.paint.materials);
  await packedPage.reload();
  await packedPage.getByRole('button',{name:'四色填充',exact:true}).click();
  assert.equal(await tilingPanel.getByRole('spinbutton',{name:'旋转角度',exact:true}).inputValue(),'90');
  await sourceView.waitFor();
  await packedPage.locator('.editor-viewport[data-rendered-paint-revision="'+turned.revision+'"]').first().waitFor();
  await packedPage.screenshot({path:path.join(data,'material-instance-tiling.png')});
  const turnedBake=await job(tiledRoute,'preview',{revision:turned.revision,requestId:'tiled-material-4k'});
  const turnedMaps=await Promise.all([turnedBake.colorUrl,turnedBake.materialUrls.normal].map(async(url,index)=>{
    const file=path.join(data,'turned-'+index+'.png');
    await fs.writeFile(file,Buffer.from(await (await fetch(origin+url)).arrayBuffer()));
    return file;
  }));
  const turnedPixels=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import json,sys','from PIL import Image','points=((1024,409),(3072,409),(1024,1433),(3072,1433),(2048,2048))',
    'print(json.dumps([[im.getpixel(p) for p in points] for im in map(Image.open,sys.argv[1:])]))'
  ].join('\n'),...turnedMaps],{encoding:'utf8'}));
  assert.deepEqual(turnedPixels[0],[[255,255,0],[0,255,0],[0,0,255],[255,0,0],[170,85,255]]);
  assert.ok(turnedPixels[1].every(([x,y,z])=>x===204&&Math.abs(y-128)<=1&&z===230));
  const activeViewport=packedPage.locator('.editor-viewport[data-state=ready]').first();
  const viewportCanvas=activeViewport.locator('canvas').first();
  const inspectedChannel=channel=>activeViewport.and(packedPage.locator('[data-inspected-channel="'+channel+'"]'));
  await viewportCanvas.press('c');
  await inspectedChannel('color').waitFor();
  await viewportCanvas.press('c');
  await inspectedChannel('metallic').waitFor();
  await viewportCanvas.press('Shift+c');
  await inspectedChannel('color').waitFor();
  await viewportCanvas.press('m');
  await inspectedChannel('color').waitFor({state:'hidden'});
  const viewportHeader=activeViewport.locator('xpath=ancestor::section[contains(@class,"editor-area")]').locator('.area-header');
  await viewportHeader.getByRole('button',{name:'着色设置',exact:true}).click();
  await viewportHeader.getByRole('button',{name:'视口材质通道',exact:true}).click();
  await packedPage.getByRole('option',{name:'法线',exact:true}).click();
  await inspectedChannel('normal').waitFor();
  await viewportHeader.getByRole('button',{name:'着色设置',exact:true}).click();
  await packedPage.screenshot({path:path.join(data,'material-channel-normal.png')});
  await packedPage.reload();
  await inspectedChannel('normal').waitFor();
  await viewportCanvas.press('m');
  await inspectedChannel('normal').waitFor({state:'hidden'});
  assert.equal((await api(tiledRoute)).revision,turned.revision);
  const untilted=await api(tiledPaint+'/undo',{revision:turned.revision});
  assert.equal(untilted.paint.layers[0].tiling.rotation,0);
  console.log('PASS independent UV tiling, rotated normal, fixed drawing overlay, channel inspection shortcuts and reopen');

  await packedPage.reload();
  await packedShelf.getByRole('tab',{name:'图片',exact:true}).click();
  await packedShelf.locator('[data-asset-id="'+patternUpload.asset.id+'"]').click();
  await packedShelf.getByRole('button',{name:'素材用途',exact:true}).click();
  await packedPage.getByRole('option',{name:'新建蒙版填充层',exact:true}).click();
  const createdFill=packedPage.waitForResponse(response=>response.url().endsWith(tiledPaint+'/commands'));
  await packedShelf.getByRole('button',{name:'创建填充层',exact:true}).click();
  const createdResponse=await createdFill;
  assert.ok(createdResponse.ok(),await createdResponse.text());
  const withMask=await createdResponse.json(),added=withMask.paint.layers.at(-1);
  assert.equal(withMask.revision,untilted.revision+1);
  assert.deepEqual(withMask.paint.layers.slice(0,-1),untilted.paint.layers);
  assert.deepEqual([added.kind,added.mask,added.maskEnabled],['fill',patternUpload.asset.id,true]);
  const unmaskedFill=await api(tiledPaint+'/undo',{revision:withMask.revision});
  assert.deepEqual(unmaskedFill.paint.layers,untilted.paint.layers);
  console.log('PASS a shelf image creates an independently editable masked fill in one undo step');

  assert.deepEqual(pageErrors,[]);
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
