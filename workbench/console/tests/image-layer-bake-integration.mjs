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

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-layer-bake-'));
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const {port}=socket.address();
await new Promise(resolve=>socket.close(resolve));
const origin='http://127.0.0.1:'+port;
const headers={Origin:origin,'Content-Type':'application/json'};
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{
  cwd:new URL('..',import.meta.url),stdio:'inherit',windowsHide:true,
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',PYTHONDONTWRITEBYTECODE:'1'}
});
let browser;
async function until(read,label){
  for(let attempt=0;attempt<250;attempt++){
    const result=await read();
    if(result)return result;
    await delay(120);
  }
  throw Error('等待超时：'+label);
}
async function api(route,body,status=200){
  const response=await fetch(origin+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
  const json=await response.json();
  assert.equal(response.status,status,JSON.stringify(json).slice(0,500));
  return json;
}
const op=(action,fields={})=>({op:'image',action,documentId:'art',...fields});
const add=(layerId,name,kind,patch={})=>op('addLayer',{layerId,kind,patch:{name,...patch}});
const shape={kind:'rectangle',width:1600,height:950,fill:'#c86b2d',stroke:'#97411a',strokeWidth:60,cornerRadius:170};
try{
  await until(()=>fetch(origin+'/api/health').then(response=>response.ok,()=>false),'启动');
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'栅格化与图层合成',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  const layers=value=>value.paint.imageDocuments.art.layers;
  async function write(endpoint,body){
    doc=await api(paint+'/'+endpoint,{revision:doc.revision,...body});
    return doc;
  }
  const commands=(...operations)=>write('commands',{operations});
  const bake=(action,layerIds,newLayerId)=>write('image-layer-bake',{documentId:'art',action,layerIds,newLayerId});
  const undo=()=>write('undo',{});
  const redo=()=>write('redo',{});
  async function exportPng(name){
    const response=await fetch(origin+paint+'/image-export',{method:'POST',headers,
      body:JSON.stringify({revision:doc.revision,documentId:'art'})});
    assert.equal(response.status,200,response.ok?'':await response.text());
    const file=path.join(data,name+'.png');
    await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));
    return file;
  }
  function compare(a,b,limit=2){
    execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import numpy as np, sys
a,b=(np.asarray(Image.open(p)) for p in sys.argv[1:3])
assert a.shape==b.shape==(4096,4096,4)
assert np.count_nonzero(a[:,:,3])>5000
for start in range(0,len(a),64):
    x,y=a[start:start+64].astype('int32'),b[start:start+64].astype('int32')
    assert np.abs(x[:,:,3]-y[:,:,3]).max()<=int(sys.argv[3])
    assert np.abs(x[:,:,:3]*x[:,:,3:]-y[:,:,:3]*y[:,:,3:]).max()<=int(sys.argv[3])*255
`,a,b,String(limit)],{stdio:'inherit'});
  }
  await commands(op('create'),add('under','底色','pixel'),
    op('stroke',{layerId:'under',target:'pixels',stroke:{uv:true,rect:[.1,.18,.75,.68],opacity:.65,color:'#6895ba',erase:false}}));
  const sourcePng=execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image,ImageDraw
import sys
im=Image.new('RGBA',(240,160))
d=ImageDraw.Draw(im)
d.rounded_rectangle((4,10,224,150),radius=20,fill=(224,196,64,200))
d.ellipse((25,20,130,108),fill=(18,89,112,255))
im.save(sys.stdout.buffer,format='PNG')
`]).toString('base64');
  const placed=await api(paint+'/assets',{revision:doc.revision,name:'贴片.png',data:sourcePng,
    imageLayer:{documentId:'art',layerId:'artwork',x:.42,y:.4,scale:.42}},201);
  doc=placed.document;
  await commands(op('updateLayer',{layerId:'artwork',patch:{stretch:[1.1,.73],rotation:13,opacity:.73,blend:'multiply'}}),
    op('createMask',{layerId:'artwork',reveal:false,rect:[.33,.34,.4,.46]}),
    add('shape','装饰条','shape',{shape,x:.65,y:.6,scale:.45,rotation:-12,opacity:.74,clipped:true}));
  const text=await api(paint+'/text',{revision:doc.revision,documentId:'art',placement:{x:.71,y:.74},
    text:{content:'A-12',fontSize:240,weight:700,align:'center',color:'#e6e3d7'}},201);
  doc=text.document;
  const before=await exportPng('placed');
  const prior=structuredClone(layers(doc));

  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const panel=page.locator('.editor-area[data-editor=imageLayers]').first();
  const row=id=>panel.locator('[data-image-layer-id="'+id+'"]');
  const select=id=>row(id).locator('.document-layer-select');
  async function menu(id,name){
    const revision=doc.revision;
    await select(id).click({button:'right'});
    await page.getByRole('menuitem',{name,exact:true}).click();
    doc=await until(async()=>{
      const current=await api(route);return current.revision===revision+1&&current;
    },name);
  }
  const editor=page.locator('.editor-area[data-editor=image]').first();
  const canvas=editor.getByLabel('图像文档画布');
  const modifier=process.platform==='darwin'?'Meta':'Control';
  await select('artwork').click();
  await canvas.focus();await page.keyboard.press('m');
  const selectBox=await canvas.boundingBox();
  await page.mouse.move(selectBox.x+.3*selectBox.width,selectBox.y+.3*selectBox.height);
  await page.mouse.down();
  await page.mouse.move(selectBox.x+.56*selectBox.width,selectBox.y+.53*selectBox.height,{steps:7});
  await page.mouse.up();
  const transformButton=editor.getByRole('complementary',{name:'图像绘制工具'}).getByRole('button',{name:'自由变换',exact:true});
  assert.equal(await transformButton.isDisabled(),true);
  assert.match(await transformButton.getAttribute('title'),/栅格化/);
  await page.keyboard.press(modifier+'+t');
  assert.equal((await api(route)).revision,doc.revision);
  assert.equal(await editor.locator('.area-selection-overlay').getAttribute('data-transforming'),null);
  await page.keyboard.press('v');
  await page.keyboard.press(modifier+'+t');
  assert.equal(await editor.locator('.area-selection-overlay').getAttribute('data-transforming'),null);
  assert.equal(await editor.locator('.document-layout-handles[data-transforming]').count(),0);
  await menu('artwork','栅格化图层');
  assert.equal(await transformButton.isEnabled(),true);
  await canvas.focus();await page.keyboard.press(modifier+'+t');
  await editor.locator('.area-selection-overlay[data-transforming]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal((await api(route)).revision,doc.revision);
  await page.keyboard.press(modifier+'+d');
  await menu('shape','栅格化图层');
  await menu(text.layerId,'栅格化图层');
  assert.ok(layers(doc).slice(1).every(layer=>layer.kind==='pixel'&&layer.raster));
  assert.equal(layers(doc)[1].blend,'multiply');
  assert.deepEqual(layers(doc)[1].maskStrokes,prior[1].maskStrokes);
  assert.equal(layers(doc)[2].clipped,true);
  compare(before,await exportPng('rasterized'));

  await row('artwork').getByRole('button',{name:'选择蒙版 贴片.png',exact:true}).click();
  await editor.locator('.document-edit-target').getByText('蒙版',{exact:true}).waitFor();
  await select('artwork').click();
  await editor.locator('.document-edit-target').getByText('图层内容',{exact:true}).waitFor();
  await editor.getByRole('button',{name:'橡皮擦',exact:true}).click();
  const revision=doc.revision,box=await canvas.boundingBox();
  const point=([x,y])=>[box.x+x*box.width,box.y+y*box.height];
  await page.mouse.move(...point([.43,.41]));await page.mouse.down();
  await page.mouse.move(...point([.51,.43]),{steps:12});await page.mouse.up();
  doc=await until(async()=>{const next=await api(route);return next.revision>revision&&next;},'擦除栅格内容');
  assert.equal(layers(doc)[1].strokes.at(-1).erase,true);
  const erased=await exportPng('erased');
  assert.notDeepEqual(await fs.readFile(erased),await fs.readFile(path.join(data,'rasterized.png')));

  const beforeMerge=structuredClone(layers(doc));
  await select('shape').click();
  await menu('shape','向下合并');
  const mergedClip=layers(doc).find(layer=>layer.id==='artwork');
  assert.equal(mergedClip.blend,'multiply');
  assert.equal(mergedClip.opacity,.73);
  assert.equal(layers(doc).some(layer=>layer.id==='shape'),false);
  compare(erased,await exportPng('clipping-merged-with-live-backdrop'));
  await undo();
  assert.deepEqual(layers(doc),beforeMerge);
  await page.reload();
  await select('under').click();
  for(const id of ['artwork','shape'])await row(id).locator('.document-layer-name').click({modifiers:[modifier]});
  await menu('shape','合并所选图层');
  assert.deepEqual(layers(doc).map(layer=>layer.id),['under',text.layerId]);
  await row('under').locator('xpath=self::*[@data-active]').waitFor();
  compare(erased,await exportPng('merged'));
  await select(text.layerId).click();
  await canvas.focus();
  const mergeRevision=doc.revision;
  await page.keyboard.press(modifier+'+e');
  doc=await until(async()=>{
    const current=await api(route);return current.revision===mergeRevision+1&&current;
  },'向下合并快捷键');
  assert.deepEqual(layers(doc).map(layer=>layer.id),['under']);
  await row('under').locator('xpath=self::*[@data-active]').waitFor();
  assert.equal(await page.locator('#delivery-dialog').evaluate(dialog=>dialog.open),false);
  compare(erased,await exportPng('merged-down'),3);
  await undo();await undo();
  assert.deepEqual(layers(doc),beforeMerge);
  await redo();
  assert.deepEqual(layers(doc).map(layer=>layer.id),['under',text.layerId]);
  await undo();
  await select('shape').click();
  await canvas.focus();
  const stampRevision=doc.revision;
  await page.keyboard.press(modifier+'+Alt+Shift+KeyE');
  doc=await until(async()=>{
    const current=await api(route);return current.revision===stampRevision+1&&current;
  },'盖印可见快捷键');
  assert.equal(layers(doc).length,beforeMerge.length+1);
  assert.ok(layers(doc).slice(0,-1).every(layer=>!layer.visible));
  const stampId=layers(doc).at(-1).id;
  await row(stampId).locator('xpath=self::*[@data-active]').waitFor();
  const stamped=await exportPng('stamp');
  compare(erased,stamped);
  await page.reload();
  await select(stampId).waitFor();
  assert.deepEqual(await fs.readFile(await exportPng('stamp-reopened')),await fs.readFile(stamped));
  await undo();
  assert.deepEqual(layers(doc),beforeMerge);
  for(let i=0;i<4;i++)await undo();
  assert.deepEqual(layers(doc),prior);
  assert.deepEqual(await fs.readFile(await exportPng('restored-original')),await fs.readFile(before));
  await page.reload();
  await select('shape').waitFor();
  assert.deepEqual(layers(await api(route)),prior);
  await page.setViewportSize({width:960,height:650});
  await page.screenshot({path:path.join(data,'raster-workspace.png')});

  await commands(add('repair','修补层','pixel'),add('above','上方色块','pixel'),
    op('stroke',{layerId:'above',target:'pixels',stroke:{uv:true,rect:[.18,.56,.25,.64],opacity:1,color:'#db3320',erase:false}}));
  await page.setViewportSize({width:1440,height:960});
  await page.reload();
  await select('repair').click();
  await editor.getByRole('button',{name:'仿制图章',exact:true}).click();
  await editor.locator('.document-image-stage[data-preview-size="4096"]').waitFor({timeout:65000});
  const cloneMode=editor.getByRole('button',{name:'仿制取样范围',exact:true});
  const canvasBounds=await canvas.boundingBox();
  const at=([x,y])=>[canvasBounds.x+x*canvasBounds.width,canvasBounds.y+y*canvasBounds.height];
  async function clone(mode,target,source=[.21,.6]){
    await cloneMode.click();
    await page.getByRole('option',{name:mode,exact:true}).click();
    await page.keyboard.down('Alt');
    await page.mouse.click(...at(source));
    await page.keyboard.up('Alt');
    await editor.locator('.document-clone-source').waitFor();
    const revision=doc.revision;
    await page.mouse.click(...at(target));
    doc=await until(async()=>{const next=await api(route);return next.revision===revision+1&&next;},mode);
  }
  await clone('当前及以下',[.9,.25]);
  await clone('所有可见层',[.9,.36]);
  const repaired=layers(doc).find(layer=>layer.id==='repair');
  assert.equal(repaired.cloneSources.length,2);
  assert.ok(repaired.strokes.every(stroke=>repaired.cloneSources.includes(stroke.clone.asset)));
  await clone('当前层',[.9,.46],[.9,.36]);
  assert.equal(layers(doc).find(layer=>layer.id==='repair').strokes.at(-1).clone.asset,undefined);
  function checkRepairs(file){
    execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import sys
with Image.open(sys.argv[1]) as im:
    blue=im.getpixel((int(.9*4096),int(.25*4096)))
    red=im.getpixel((int(.9*4096),int(.36*4096)))
    copied=im.getpixel((int(.9*4096),int(.46*4096)))
    assert blue[2]>blue[0]+40 and blue[3]>100, blue
    assert red[0]>red[2]+140 and red[3]>220, red
    assert copied[0]>copied[2]+140 and copied[3]>220, copied
`,file],{stdio:'inherit'});
  }
  checkRepairs(await exportPng('clone-repairs'));
  await commands(op('updateLayer',{layerId:'above',patch:{visible:false}}),op('updateLayer',{layerId:'under',patch:{visible:false}}));
  checkRepairs(await exportPng('clone-repairs-after-source-edits'));
  await undo();
  await undo();
  assert.equal(layers(doc).find(layer=>layer.id==='repair').strokes.length,2);
  await redo();
  checkRepairs(await exportPng('clone-redone'));
  const beforeRepairMerge=structuredClone(layers(doc));
  const repairedPng=await exportPng('repair-before-merge');
  await bake('mergeSelected',beforeRepairMerge.map(layer=>layer.id));
  compare(repairedPng,await exportPng('repair-merged'));
  await undo();
  assert.deepEqual(layers(doc),beforeRepairMerge);
  await commands(add('gap','备用隐藏层','pixel',{visible:false}),
    op('moveLayer',{layerId:'gap',index:3}),
    op('stroke',{layerId:'gap',target:'pixels',stroke:{uv:true,rect:[.02,.02,.10,.10],opacity:1,color:'#00ff00',erase:false}}));
  const layoutIds=['under','artwork','shape',text.layerId];
  await commands(op('updateLayer',{layerId:'gap',patch:{visible:true}}));
  const visibleGap=await api(paint+'/image-layer-bake',{revision:doc.revision,documentId:'art',action:'mergeSelected',layerIds:layoutIds},400);
  assert.match(visibleGap.error,/可见图层/);
  assert.equal((await api(route)).revision,doc.revision);
  await commands(op('updateLayer',{layerId:'gap',patch:{visible:false}}));
  const beforeGapMerge=structuredClone(layers(doc));
  const gapPng=await exportPng('hidden-gap');
  await bake('mergeSelected',layoutIds);
  assert.ok(layers(doc).some(layer=>layer.id==='gap'&&!layer.visible&&layer.strokes.length===1));
  compare(gapPng,await exportPng('hidden-gap-merged'));
  await undo();
  assert.deepEqual(layers(doc),beforeGapMerge);

  const blendIf={source:[0,0,255,255],backdrop:[24,80,213,253]};
  const backdropColor=(color)=>op('stroke',{layerId:'under',target:'pixels',stroke:{
    uv:true,rect:[.1,.18,.75,.68],opacity:.8,color,erase:false
  }});
  await commands(op('updateLayer',{layerId:'artwork',patch:{blendIf}}),
    add('top-clip','保留可编辑的上层','shape',{shape,x:.48,y:.33,scale:.24,opacity:.35,blend:'screen',clipped:true}),
    op('moveLayer',{layerId:'top-clip',index:3}));
  const clipSource=structuredClone(layers(doc));
  const clipBefore=await exportPng('clip-prefix-before');
  await bake('mergeDown',['shape']);
  assert.deepEqual(layers(doc).find(layer=>layer.id==='artwork').blendIf,blendIf);
  assert.deepEqual(layers(doc).find(layer=>layer.id==='top-clip'),clipSource.find(layer=>layer.id==='top-clip'));
  compare(clipBefore,await exportPng('clip-prefix-merged'));
  await commands(backdropColor('#986037'));
  const editedMerge=await exportPng('clip-prefix-edited-backdrop');
  await undo();await undo();
  assert.deepEqual(layers(doc),clipSource);
  await commands(backdropColor('#986037'));
  const editedSource=await exportPng('clip-prefix-unmerged-edited-backdrop');
  compare(editedMerge,editedSource,3);
  assert.notDeepEqual(await fs.readFile(editedMerge),await fs.readFile(clipBefore));
  await undo();
  await page.reload();
  await row('artwork').getByRole('button',{name:'选择蒙版 贴片.png',exact:true}).click();
  await editor.locator('.document-edit-target').getByText('蒙版',{exact:true}).waitFor();
  await canvas.focus();
  const prefixRevision=doc.revision;
  await page.keyboard.press(modifier+'+Alt+Shift+KeyE');
  doc=await until(async()=>{
    const current=await api(route);return current.revision===prefixRevision+1&&current;
  },'从蒙版编辑切换到盖印可见图层');
  assert.ok(layers(doc).slice(0,-1).every(layer=>!layer.visible));
  await editor.locator('.document-edit-target').getByText('图层内容',{exact:true}).waitFor();
  const prefixStamp=await exportPng('clip-prefix-stamp');
  compare(clipBefore,prefixStamp);
  await page.screenshot({path:path.join(data,'clipping-stamp-workspace.png')});
  await undo();
  assert.deepEqual(layers(doc),clipSource);
  await page.reload();
  await select('repair').click();
  await editor.getByRole('button',{name:'仿制图章',exact:true}).click();
  await editor.locator('.document-image-stage[data-preview-size="4096"]').waitFor();
  await page.screenshot({path:path.join(data,'repair-workspace.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS selection transform requires raster pixels, rasterize image/text/shape, erase, masked merge and stamp, cross-layer clone, undo/redo and reopen:',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
  }
}
