import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {primitiveGlb} from '../primitive-model.mjs';
import {pythonExecutable} from '../python-runtime.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-production-'));
const evidence=process.env.ARACHNE_PRODUCTION_SCREENSHOTS||data;
await fs.mkdir(evidence,{recursive:true});
const profile=path.join(data,'工作工程'),restoredProfile=path.join(data,'恢复副本');
const probe=path.join(data,'blender-probe'),marker=path.join(data,'blender-invoked');
if(process.platform!=='win32')await fs.writeFile(probe,'#!/bin/sh\ntouch "$(dirname "$0")/blender-invoked"\nexit 42\n',{mode:0o700});
const model=primitiveGlb('cube'),modelPath=path.join(data,'实物样件 - 原 UV.glb');
const digest=value=>createHash('sha256').update(value).digest('hex');
await fs.writeFile(modelPath,model);
const services=[];
let browser,logs='';
async function until(read,label,timeout=45000){
  for(const end=Date.now()+timeout;Date.now()<end;){
    const result=await read();if(result)return result;await delay(120);
  }
  throw Error('等待超时：'+label);
}
async function start(folder,port){
  if(!port){
    const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');
    port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  }
  const origin='http://127.0.0.1:'+port;
  const service=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:new URL('..',import.meta.url),
    env:{...process.env,ARACHNE_DATA_DIR:folder,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:probe}});
  services.push(service);
  for(const stream of [service.stdout,service.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-10000);});
  await until(()=>fetch(origin+'/api/health').then(response=>response.ok,()=>false),'本机服务');
  return {origin,port,service};
}
async function stop(service){
  if(service.exitCode!==null||service.signalCode!==null)return;
  const stopped=once(service,'exit');service.kill();await stopped;
}
async function read(origin,route){
  const response=await fetch(origin+route);assert.ok(response.ok,route+': '+response.status);
  return response.json();
}
const materials=JSON.parse(execFileSync(pythonExecutable(),['-B','-X','utf8','-c',[
  'import base64,io,json',
  'from PIL import Image',
  'maps={"青灰合金_BaseColor.png":(4096,(42,103,134,255)), "青灰合金_2K_BaseColor.png":(2048,(178,44,41,255)), "青灰合金_ORM.png":(1024,(213,106,184,255)), "青灰合金_Opacity.png":(1024,(151,151,151,255))}',
  'files={}',
  'for name,(size,pixel) in maps.items():',
  ' out=io.BytesIO();Image.new("RGBA",(size,size),pixel).save(out,format="PNG");files[name]=base64.b64encode(out.getvalue()).decode()',
  'print(json.dumps(files))'
].join('\n')],{encoding:'utf8'}));

async function brush(page,canvas,start,end){
  const box=await canvas.boundingBox(),point=([u,v])=>[box.x+u*box.width,box.y+v*box.height];
  await page.mouse.move(...point(start));await page.mouse.down();
  await page.mouse.move(...point(end),{steps:8});await page.mouse.up();
}
async function ink(page,editor,color){
  const foreground=editor.getByLabel('图像前景色',{exact:true});
  await foreground.click();
  const input=page.getByRole('dialog',{name:'图像前景色选色',exact:true}).getByRole('textbox',{name:'HEX 颜色',exact:true});
  await input.fill(color);await input.press('Enter');
  assert.equal(await foreground.inputValue(),color);
}

try{
  let local=await start(profile);
  const {origin}=local;
  assert.deepEqual(await read(origin,'/api/projects'),[]);
  await assert.rejects(fs.stat(path.join(profile,'model-geometry')),{code:'ENOENT'});
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
  let page=await context.newPage();
  const pageErrors=[];
  const watch=tab=>tab.on('pageerror',error=>pageErrors.push(error.message));
  watch(page);
  await page.goto(origin);
  await page.locator('.project-welcome').getByRole('button',{name:'新建工程',exact:true}).click();
  await page.locator('#new-paint-name').fill('青灰合金 · 原 UV 验收');
  await page.locator('#new-paint-model').setInputFiles(modelPath);
  await page.getByText(path.basename(modelPath),{exact:true}).waitFor();
  await page.locator('#new-paint-submit').click();
  const id=await until(()=>new URL(page.url()).searchParams.get('project'),'登记 GLB');
  const route='/api/projects/'+id,paint=route+'/paint',readDoc=()=>read(origin,route);
  const source=(await readDoc()).source;
  const viewport=()=>page.locator('.editor-viewport[data-state=ready]').first();
  await viewport().waitFor();
  const manifest=await read(origin,route+'/viewport');
  assert.equal(source.format,'glb');assert.equal(manifest.metadata.input_sha256,digest(model));
  assert.equal(manifest.metadata.uv_before,source.uvSha256);

  await page.locator('[data-area-mode=material]').click();
  const shelf=page.locator('.editor-area[data-editor=library]').first();
  await shelf.getByRole('tab',{name:'材质',exact:true}).click();
  await shelf.getByRole('button',{name:'从贴图创建材质',exact:true}).click();
  const mapDialog=page.getByRole('dialog',{name:'从贴图创建材质',exact:true});
  await mapDialog.getByLabel('导入材质贴图').setInputFiles(Object.entries(materials).map(([name,bytes])=>({
    name,mimeType:'image/png',buffer:Buffer.from(bytes,'base64')
  })));
  await mapDialog.getByRole('button',{name:'颜色',exact:true}).filter({hasText:'2 张候选'}).click();
  const large=mapDialog.getByRole('option',{name:'青灰合金_BaseColor.png · 4096 × 4096',exact:true});
  await until(()=>large.locator('img').evaluate(img=>img.naturalWidth===128),'4K 颜色候选缩略图');
  await large.click();
  await mapDialog.getByRole('button',{name:'创建材质',exact:true}).click();
  await shelf.getByRole('button',{name:'青灰合金',exact:true}).dblclick();
  const mapped=await until(async()=>{const doc=await readDoc();return doc.paint.layers.some(layer=>layer.materialId)&&doc;},'贴图材质应用至模型');
  const surface=mapped.paint.layers.find(layer=>layer.materialId),materialId=surface.materialId;
  const commands=async(doc,operations)=>{
    const response=await fetch(origin+paint+'/commands',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({revision:doc.revision,operations})});
    const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
  };
  // The second layer changes only the finish. Base colour and transparency
  // remain independently testable after the mask and the image link.
  const setup=await commands(mapped,[{op:'add',kind:'fill',patch:{name:'旧化 · 磨痕',
    channels:{color:false,roughness:true,metallic:false},values:{color:'#808080',metallic:0,roughness:.87},
    maskEnabled:true,maskBase:1}}]);
  const wearId=setup.paint.layers.find(layer=>layer.name==='旧化 · 磨痕').id;
  const wearState=doc=>doc.paint.layers.find(layer=>layer.id===wearId);
  await page.reload();await viewport().waitFor();
  await page.getByRole('button',{name:'绘制蒙版 · 旧化 · 磨痕',exact:true}).click();
  const effects=page.getByRole('button',{name:'添加效果',exact:true});
  for(const [label,count] of [['边缘磨损',1],['表面噪声',2]]){
    await effects.click();await page.getByRole('option',{name:label,exact:true}).click();
    await until(async()=>wearState(await readDoc()).maskEffects.length===count,'添加'+label);
  }
  await page.getByRole('button',{name:'表面噪声合成',exact:true}).click();
  await page.getByRole('option',{name:'相减',exact:true}).click();
  await until(async()=>wearState(await readDoc()).maskEffects[1].blend==='subtract','噪声相减');
  await page.getByRole('button',{name:'手绘修正',exact:true}).click();
  await page.getByRole('option',{name:'在效果后',exact:true}).click();
  await until(async()=>wearState(await readDoc()).maskStrokeOrder==='after','手绘覆盖效果');
  await until(async()=>await page.locator('#project-save-state').textContent()==='已保存','材质参数已保存');
  const beforeStrokes=await readDoc(),strokeAttempts=[];
  let releaseFirst,undoGate;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  await page.route(origin+paint+'/commands',async intercepted=>{
    const request=intercepted.request().postDataJSON();
    if(request?.operations?.[0]?.op!=='stroke'){await intercepted.continue();return;}
    strokeAttempts.push(request.strokeRequestId);
    if(undoGate)await undoGate;
    if(strokeAttempts.length!==1){await intercepted.continue();return;}
    await firstGate;
    assert.equal((await intercepted.fetch()).status(),200);
    await intercepted.abort('connectionreset');
  });
  const previewStart=performance.now();
  const batchFrame=page.waitForResponse(response=>{
    if(!response.url().endsWith('/paint/live')||response.status()!==200)return false;
    const operations=response.request().postDataJSON()?.operations;
    return operations?.length===2&&operations.every(op=>op.op==='stroke'&&op.target==='mask');
  },{timeout:60000}).catch(error=>error);
  try{
    await brush(page,viewport(),[.48,.5],[.53,.5]);
    await until(()=>strokeAttempts.length===1,'第一笔正在保存');
    await brush(page,viewport(),[.49,.45],[.53,.45]);
    await until(()=>page.locator('#workspace').getAttribute('data-pending-material-strokes').then(value=>value==='2'),'连续两笔在队列中');
    const preview=await batchFrame;
    if(preview instanceof Error)throw preview;
    assert.equal(preview.headers()['x-paint-resolution'],'256');
    console.log('Material preview for two pending strokes: 256 px in '+Math.round(performance.now()-previewStart)+' ms on this runner');
  }finally{releaseFirst();}
  const recovery=page.locator('.material-stroke-recovery');
  await recovery.getByRole('alert').filter({hasText:'2 笔待保存'}).waitFor();
  assert.equal((await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync())).state,'unsaved');
  assert.equal(wearState(await readDoc()).maskStrokes.length,1);
  await page.screenshot({path:path.join(evidence,'01-material-save-recovery.png')});
  await page.reload();
  await recovery.getByRole('alert').filter({hasText:'从此窗口恢复'}).waitFor();
  await page.getByRole('button',{name:'绘制蒙版 · 旧化 · 磨痕',exact:true}).and(page.locator('[aria-pressed=true]')).waitFor();
  await recovery.getByRole('button',{name:'重试保存笔触',exact:true}).click();
  const wearing=await until(async()=>{const doc=await readDoc();return wearState(doc).maskStrokes?.length===2&&doc;},'重载后恢复三维笔触');
  assert.equal(wearing.revision,beforeStrokes.revision+2);
  assert.equal(new Set(strokeAttempts).size,2);
  assert.ok(strokeAttempts.every(id=>wearing.strokeSaveReceipts.some(receipt=>receipt.id===id)));
  assert.ok(wearState(wearing).maskStrokes[0].stamps.length>0);
  await recovery.waitFor({state:'hidden'});await viewport().waitFor();
  await page.locator('#workspace[data-preview-resolution="4096"]').waitFor({timeout:60000});
  await page.screenshot({path:path.join(evidence,'01-material-mask.png')});
  let releaseUndo;
  undoGate=new Promise(resolve=>{releaseUndo=resolve;});
  try{
    await brush(page,viewport(),[.48,.55],[.53,.55]);
    await until(()=>strokeAttempts.length===3,'第三笔还在写入');
    assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('undo')),true);
    assert.equal((await readDoc()).revision,wearing.revision);
  }finally{releaseUndo();}
  const afterQuickUndo=await until(async()=>{
    const doc=await readDoc();return doc.revision===wearing.revision+2&&doc;
  },'保存中的笔触落盘后撤销');
  assert.deepEqual(wearState(afterQuickUndo),wearState(wearing));
  await until(async()=>await page.locator('#project-save-state').textContent()==='已保存','撤销后的修订已保存');
  console.log('PASS imported uncached GLB with original UV, chose 4K texture, composed mask effects and recovered two real 3D strokes without a duplicate');

  await page.locator('[data-area-mode=drawing]').click();
  const editor=()=>page.locator('.editor-area[data-editor=image]').first();
  const panel=()=>page.locator('.editor-area[data-editor=imageLayers]').first();
  const canvas=()=>editor().getByLabel('图像文档画布');
  await editor().getByRole('button',{name:'新建贴图',exact:true}).click();
  await canvas().waitFor();
  const created=await until(async()=>{const doc=await readDoc();return Object.keys(doc.paint.imageDocuments??{}).length&&doc;},'新建图像文档');
  const documentId=Object.keys(created.paint.imageDocuments)[0];
  const image=doc=>doc.paint.imageDocuments[documentId];
  const baseId=image(created).layers[0].id;
  const row=id=>panel().locator('[data-image-layer-id="'+id+'"]');
  const select=id=>row(id).locator('.document-layer-select');
  const layer=(doc,id)=>image(doc).layers.find(item=>item.id===id);
  const paintButton=()=>editor().getByRole('button',{name:'画笔',exact:true});
  await select(baseId).click();await paintButton().click();
  await ink(page,editor(),'#f36c28');
  const radius=editor().locator('input.workspace-number-input[aria-label="像素半径"]').locator('..');
  await radius.dblclick();
  const entry=radius.getByRole('spinbutton',{name:'输入数值'});
  await entry.fill('180');await entry.press('Enter');
  await brush(page,canvas(),[.37,.5],[.63,.5]);
  const drawn=await until(async()=>{const doc=await readDoc();return layer(doc,baseId).strokes?.length===1&&doc;},'保存颜色笔触');
  assert.ok(layer(drawn,baseId).strokes[0].stamps.length>1);
  await panel().getByRole('button',{name:'添加蒙版',exact:true}).click();
  await row(baseId).getByRole('button',{name:/选择蒙版/}).and(panel().locator('[aria-pressed=true]')).waitFor();
  await canvas().focus();await page.keyboard.press('d');
  await brush(page,canvas(),[.50,.46],[.50,.54]);
  const masked=await until(async()=>{const doc=await readDoc();return layer(doc,baseId).maskStrokes?.length===1&&doc;},'绘制黑色蒙版修边');
  assert.equal(layer(masked,baseId).maskStrokes[0].value,0);

  const addPixel=panel().getByRole('button',{name:'新建像素层',exact:true});
  await addPixel.click();
  const second=await until(async()=>{const doc=await readDoc();return image(doc).layers.length===2&&doc;},'新建第二像素层');
  const secondId=image(second).layers.find(item=>item.id!==baseId).id;
  await addPixel.click();
  const third=await until(async()=>{const doc=await readDoc();return image(doc).layers.length===3&&doc;},'新建第三像素层');
  const thirdId=image(third).layers.find(item=>![baseId,secondId].includes(item.id)).id;
  const modifier=process.platform==='darwin'?'Meta':'Control';
  await select(baseId).click();await select(secondId).click({modifiers:[modifier]});
  await select(secondId).focus();await page.keyboard.press(modifier+'+j');
  const duplicate=await until(async()=>{const doc=await readDoc();return image(doc).layers.length===5&&doc;},'复制两个选中图层');
  const copies=image(duplicate).layers.filter(item=>![baseId,secondId,thirdId].includes(item.id));
  assert.ok(copies.some(item=>item.maskStrokes?.length===1));
  await until(()=>panel().locator('.document-layer-row[data-selected]').count().then(count=>count===2),'保持两个副本的选择');
  await select(copies[0].id).click({button:'right'});
  await page.getByRole('menuitem',{name:'删除 2 项',exact:true}).click();
  const deleted=await until(async()=>{const doc=await readDoc();return image(doc).layers.length===3&&doc;},'批量删除两个副本');
  assert.deepEqual(image(deleted),image(third));
  for(const [action,previous,expected] of [['undo',deleted,duplicate],['redo',{revision:deleted.revision+1},deleted]]){
    assert.equal(await page.evaluate(command=>window.arachneNativeHost.command(command),action),true);
    const result=await until(async()=>{const doc=await readDoc();return doc.revision===previous.revision+1&&doc;},'批量操作 '+action);
    assert.deepEqual(image(result),image(expected));
  }
  await editor().getByRole('button',{name:'材质引用图层',exact:true}).click();
  await page.getByRole('option',{name:'青灰合金 · 库材质',exact:true}).click();
  await editor().getByRole('button',{name:'应用至材质',exact:true}).click();
  const linked=await until(async()=>{
    const doc=await readDoc();return doc.paint.layers.find(item=>item.id===surface.id).documentMaps?.color===documentId&&doc;
  },'图像文档联动材质颜色');
  await editor().locator('.document-image-stage[data-preview-size="4096"][data-preview-revision="'+linked.revision+'"]').waitFor({timeout:60000});
  await page.screenshot({path:path.join(evidence,'02-drawing-layers.png')});
  assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('save')),true);
  await until(async()=>await page.locator('#project-save-state').textContent()==='已保存','保存反馈');
  assert.equal((await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync())).state,'ready');
  await page.close();await stop(local.service);

  local=await start(profile,local.port);
  assert.deepEqual(await readDoc(),linked);
  page=await context.newPage();watch(page);
  await page.goto(origin+'/?project='+id);
  await page.locator('[data-area-mode=material]').click();
  await viewport().waitFor();
  assert.deepEqual(image(await readDoc()).layers,image(third).layers);
  await page.getByText('文件',{exact:true}).filter({visible:true}).first().click();
  await page.locator('#open-delivery').click();
  await page.locator('#delivery-preview-button').click();
  await page.locator('#approved').check({timeout:120000});
  await page.locator('#export-textures').click();
  const archiveLink=page.getByRole('link',{name:new RegExp('工程与贴图 ZIP · r'+linked.revision)});
  await archiveLink.waitFor({timeout:120000});
  const zip=path.join(data,'青灰合金 - 工程与贴图.zip');
  const [download]=await Promise.all([page.waitForEvent('download'),archiveLink.click()]);await download.saveAs(zip);
  await page.screenshot({path:path.join(evidence,'03-texture-export.png')});

  const checked=JSON.parse(execFileSync(pythonExecutable(),['-B','-X','utf8','-c',[
    'import hashlib,io,json,sys,zipfile',
    'from PIL import Image',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' report=json.loads(z.read("project-report.json")); assert report["registration"]["uvSha256"]==sys.argv[2]',
    ' for member,expected in report["fileSha256"].items(): assert hashlib.sha256(z.read(member)).hexdigest()==expected,member',
    ' images={}',
    ' for key,suffix in {"color":"BaseColor","metallic":"metallic","roughness":"roughness","normal":"normal","height":"height","emission":"emission","alpha":"alpha","ao":"ao"}.items():',
    '  names=[name for name in report["fileSha256"] if name.startswith("textures/") and name.endswith("_"+suffix+".png")]',
    '  assert len(names)==1,(key,names); images[key]=Image.open(io.BytesIO(z.read(names[0])))',
    ' assert all(im.size==(4096,4096) for im in images.values())',
    ' def pixel(key,u,v): return images[key].getpixel((round(u*4096),round(v*4096)))',
    ' assert pixel("color",.1,.1)==(42,103,134)',
    ' assert pixel("color",.40,.50)==(243,108,40)',
    ' assert pixel("color",.50,.50)==(42,103,134)',
    ' assert all(pixel("alpha",x,.5)==151 for x in (.40,.50,.60))',
    ' assert pixel("metallic",.1,.1)==184 and pixel("ao",.1,.1)==213',
    ' print(json.dumps({"uvSha256":sys.argv[2],"files":len(report["fileSha256"]),"channels":list(images),"alpha":151}))'
  ].join('\n'),zip,source.uvSha256],{encoding:'utf8'}));
  assert.equal(checked.channels.length,8);
  const restored=await start(restoredProfile);
  assert.deepEqual(await read(restored.origin,'/api/projects'),[]);
  await page.goto(restored.origin);
  await page.locator('#welcome-import').click();
  await page.locator('#paint-import-file').setInputFiles(zip);
  await page.locator('#paint-import-submit').click();
  const restoredId=await until(()=>new URL(page.url()).searchParams.get('project'),'从 ZIP 恢复');
  const restoredRoute='/api/projects/'+restoredId;
  const recovered=await read(restored.origin,restoredRoute);
  assert.deepEqual(recovered.paint,linked.paint);
  assert.equal(recovered.source.uvSha256,source.uvSha256);
  assert.ok(recovered.paint.materials[materialId]);
  await page.locator('[data-area-mode=drawing]').click();
  await canvas().waitFor();
  await select(baseId).click();await paintButton().click();
  await brush(page,canvas(),[.2,.2],[.27,.2]);
  const continued=await until(async()=>{
    const doc=await read(restored.origin,restoredRoute);return layer(doc,baseId).strokes?.length===2&&doc;
  },'恢复后继续编辑');
  assert.equal(continued.revision,recovered.revision+1);
  assert.deepEqual(layer(continued,baseId).maskStrokes,layer(recovered,baseId).maskStrokes);
  assert.deepEqual(await readDoc(),linked);
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  assert.deepEqual(pageErrors,[]);
  await editor().locator('.document-image-stage[data-preview-size="4096"][data-preview-revision="'+continued.revision+'"]').waitFor({timeout:60000});
  await page.screenshot({path:path.join(evidence,'04-restored-continue.png')});
  console.log('PASS workbench draw, mask, batch copy/delete, undo/redo, link, save, process restart, portable 4K export and independent editable restore');
  console.log('Verified package:',JSON.stringify(checked));
}catch(error){console.error(logs);throw error;}
finally{
  await browser?.close();
  for(const service of services)await stop(service);
  console.log('Workflow verification data:',data);
}
