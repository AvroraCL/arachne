import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {pythonExecutable} from '../python-runtime.mjs';
import {imageStackBase} from '../public/image-layer-tree.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-layer-batch-'));
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const {port}=socket.address();
await new Promise(resolve=>socket.close(resolve));
const origin='http://127.0.0.1:'+port;
const headers={Origin:origin,'Content-Type':'application/json'};
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:new URL('..',import.meta.url),windowsHide:true,
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:path.join(data,'no-blender')}});
let browser,logs='';
for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-8000);});
async function until(read,label,timeout=18000){
  for(const end=Date.now()+timeout;Date.now()<end;){
    const result=await read();if(result)return result;await delay(100);
  }
  throw Error('等待超时：'+label);
}
async function api(route,body){
  const response=await fetch(origin+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
  const json=await response.json();assert.ok(response.ok,JSON.stringify(json));return json;
}

try{
  await until(()=>fetch(origin+'/api/health').then(response=>response.ok,()=>false),'本机服务');
  const project=await api('/api/projects',{workflowType:'pbr_paint',modelTemplate:'plane',name:'图层批量验收'});
  const route='/api/projects/'+project.id,paint=route+'/paint',documentId='batch';
  const op=(action,fields={})=>({op:'image',action,documentId,...fields});
  const add=(layerId,name,kind='pixel',parentId,patch={})=>op('addLayer',{layerId,parentId,kind,patch:{name,...patch}});
  const ink=(layerId,color,rect)=>op('stroke',{layerId,target:'pixels',stroke:{uv:true,rect,color,opacity:1,erase:false}});
  const seed=await api(paint+'/commands',{revision:project.revision,operations:[
    op('create',{patch:{name:'组合图层'}}),
    add('base','底层'),ink('base','#ba422d',[.08,.1,.55,.9]),
    op('createMask',{layerId:'base',reveal:false,rect:[.2,.1,.29,.9]}),
    add('clip','剪贴层','pixel',undefined,{clipped:true}),ink('clip','#337bcc',[.13,.15,.47,.85]),
    add('source','原图层组','group'),add('child','子图层','pixel','source'),ink('child','#35a66c',[.62,.2,.82,.8]),
    add('child2','子图层二','pixel','source'),
    add('target','目标图层组','group'),add('target-child','目标子图层','pixel','target'),ink('target-child','#cfa638',[.86,.3,.94,.7])
  ]});
  const list=project=>project.paint.imageDocuments[documentId].layers;
  const layerBy=(layers,id)=>layers.find(layer=>layer.id===id);
  const baseOf=(layers,id)=>imageStackBase(layers,layers.findIndex(layer=>layer.id===id))?.id;
  const atRevision=(revision,label)=>until(async()=>{
    const current=await api(route);return current.revision===revision&&current;
  },label);
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/?project='+project.id);
  await page.locator('[data-area-mode=drawing]').click();
  const panel=page.locator('.editor-area[data-editor=imageLayers]').first();
  const row=id=>panel.locator('[data-image-layer-id="'+id+'"]');
  const select=id=>row(id).locator('.document-layer-select');
  const modifier=process.platform==='darwin'?'Meta':'Control';
  await select('source').waitFor();
  await row('target').getByRole('button',{name:'收起 目标图层组'}).click();
  await select('target-child').waitFor({state:'hidden'});
  await select('source').click();
  for(const id of ['child','base','clip'])await select(id).click({modifiers:[modifier]});
  assert.deepEqual(await panel.locator('.document-layer-row[data-selected]').evaluateAll(rows=>rows.map(row=>row.dataset.imageLayerId).sort()),
    ['base','child','clip','source']);

  await row('child2').getByRole('button',{name:'锁定 子图层二'}).click();
  const locked=await atRevision(seed.revision+1,'锁定组内未单独选中的子层');
  const deleteSelected=panel.getByRole('button',{name:'删除 5 项',exact:true});
  await until(async()=>await deleteSelected.isDisabled(),'锁定使整批删除不可用');
  await row('child2').getByRole('button',{name:'解锁 子图层二'}).click();
  const unlocked=await atRevision(locked.revision+1,'解除锁定');
  await until(async()=>await deleteSelected.isEnabled(),'重新允许整批操作');

  const bounds=await select('clip').boundingBox(),destination=await row('target').boundingBox();
  const mouse=page.mouse,sx=bounds.x+bounds.width/2,sy=bounds.y+bounds.height/2,
    tx=destination.x+destination.width/2,ty=destination.y+destination.height/2;
  await mouse.move(sx,sy);await mouse.down();await mouse.move(sx,sy-8,{steps:4});
  await mouse.move(tx,ty,{steps:12});await mouse.move(tx+1,ty);
  await panel.getByRole('status').filter({hasText:'移动 5 项 · 放入「目标图层组」'}).waitFor();
  assert.equal(await row('target').getAttribute('data-drop-edge'),'inside');
  await page.screenshot({path:path.join(data,'batch-drop.png')});
  await mouse.up();
  const moved=await atRevision(unlocked.revision+1,'一次性移动选中组和剪贴组');
  assert.deepEqual(list(moved).map(layer=>layer.id),['target','target-child','base','clip','source','child','child2']);
  assert.equal(baseOf(list(moved),'clip'),'base');
  for(const id of ['base','clip','source'])assert.equal(layerBy(list(moved),id).parentId,'target');
  assert.equal(layerBy(list(moved),'child').parentId,'source');
  assert.deepEqual(layerBy(list(moved),'base').maskStrokes,layerBy(list(seed),'base').maskStrokes);
  await select('clip').waitFor();
  await until(async()=>await panel.locator('.document-layer-row[data-selected]').count()===4,'移动后仍保留选择');

  await select('clip').focus();
  await page.keyboard.press(modifier+'+j');
  const copied=await atRevision(moved.revision+1,'通过快捷键复制同一组选中层');
  const copies=list(copied).filter(layer=>!layerBy(list(moved),layer.id));
  assert.equal(copies.length,5);
  const copy=(name)=>copies.find(layer=>layer.name===name+' 副本');
  assert.equal(baseOf(list(copied),copy('剪贴层').id),copy('底层').id);
  assert.equal(baseOf(list(copied),'clip'),'base');
  assert.equal(copies.filter(layer=>layer.parentId===copy('原图层组').id).length,2);
  assert.deepEqual(copy('底层').maskStrokes,layerBy(list(moved),'base').maskStrokes);
  await until(async()=>await panel.locator('.document-layer-row[data-selected]').count()===3,'复制后选择三个副本根');
  await select(copy('剪贴层').id).click({button:'right'});
  await page.getByRole('menuitem',{name:'删除 5 项',exact:true}).click();
  await page.getByRole('dialog',{name:'确认图层组操作'}).getByRole('button',{name:'删除所选图层',exact:true}).click();
  const removed=await atRevision(copied.revision+1,'右键整批删除副本');
  assert.deepEqual(list(removed),list(moved));
  assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('undo')),true);
  const undo=await atRevision(removed.revision+1,'一次撤销恢复全部副本');
  assert.deepEqual(list(undo),list(copied));
  assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('redo')),true);
  const redo=await atRevision(undo.revision+1,'一次重做删除全部副本');
  assert.deepEqual(list(redo),list(moved));

  await page.reload();await select('clip').waitFor();
  assert.deepEqual(list(await api(route)),list(moved));
  const exportResult=await fetch(origin+paint+'/image-export',{method:'POST',headers,
    body:JSON.stringify({revision:redo.revision,documentId})});
  assert.equal(exportResult.status,200);
  const file=path.join(data,'batch-4k.png');await fs.writeFile(file,Buffer.from(await exportResult.arrayBuffer()));
  const pixels=JSON.parse(execFileSync(pythonExecutable(),['-B','-X','utf8','-c',[
    'import json,sys','from PIL import Image','im=Image.open(sys.argv[1])',
    'print(json.dumps([im.size,im.mode,[im.getpixel((int(4096*x),2048)) for x in (.06,.18,.24,.5,.7,.9)]]))'
  ].join('\n'),file],{encoding:'utf8'}));
  assert.deepEqual(pixels,[[4096,4096],'RGBA',[
    [0,0,0,0],[51,123,204,255],[0,0,0,0],[186,66,45,255],[53,166,108,255],[207,166,56,255]
  ]]);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(data,'batch-restored.png')});
  console.log('PASS batch move with drop feedback, group and clip order, inherited locks, keyboard copy, menu delete, undo/redo, reopen and exact 4K alpha');
}catch(error){console.error(logs);throw error;}
finally{
  await browser?.close();
  if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
  console.log('Batch verification data:',data);
}
