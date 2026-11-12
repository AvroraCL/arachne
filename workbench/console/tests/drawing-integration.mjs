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

const root=path.resolve(import.meta.dirname,'..');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-drawing-'));
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const {port}=socket.address();
await new Promise(resolve=>socket.close(resolve));
const origin='http://127.0.0.1:'+port;
const env={...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:path.join(data,'no-blender')};
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:root,env,windowsHide:true});
let logs='',browser;
for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-9000);});

async function until(read,label,timeout=45000){
  for(const end=Date.now()+timeout;Date.now()<end;){
    const result=await read();
    if(result)return result;
    await delay(100);
  }
  throw Error('等待超时：'+label);
}
async function api(route,body,expected=200){
  const response=await fetch(origin+route,body===undefined?{}:{method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  assert.equal(response.status,expected,JSON.stringify(result));
  return result;
}
function rgba(file,points){
  return JSON.parse(execFileSync(pythonExecutable(),['-c',[
    'from PIL import Image','import json,sys',
    'with Image.open(sys.argv[1]) as image:',
    ' assert image.mode=="RGBA"',
    ' print(json.dumps([image.size,[image.getpixel(tuple(p)) for p in json.loads(sys.argv[2])]]))'
  ].join('\n'),file,JSON.stringify(points)],{encoding:'utf8'}));
}

try{
  await until(()=>fetch(origin+'/api/health').then(response=>response.ok,()=>false),'本机服务');
  const project=await api('/api/projects',{workflowType:'pbr_paint',name:'独立绘制验收',modelTemplate:'plane'},201);
  const projectRoute='/api/projects/'+project.id,paintRoute=projectRoute+'/paint';
  const documentId='drawing-document',layerId='drawing-pixels',otherLayerId='secondary-pixels';
  const seed=await api(paintRoute+'/commands',{revision:project.revision,operations:[
    {op:'image',action:'create',documentId,patch:{name:'选区验收'}},
    {op:'image',action:'addLayer',documentId,layerId:otherLayerId,kind:'pixel',patch:{name:'备用层'}},
    {op:'image',action:'addLayer',documentId,layerId,kind:'pixel',patch:{name:'颜色层'}},
    {op:'image',action:'stroke',documentId,layerId,target:'pixels',
      stroke:{uv:true,rect:[0,0,1,1],opacity:1,color:'#3989bf',erase:false}}
  ]});
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(origin+'/?project='+project.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first();
  const canvas=editor.getByLabel('图像文档画布'),overlay=editor.locator('.area-selection-overlay');
  await canvas.waitFor();
  async function point([x,y]){
    const box=await canvas.boundingBox();
    return [box.x+x*box.width,box.y+y*box.height];
  }
  async function drag(start,end){
    await page.mouse.move(...await point(start));
    await page.mouse.down();
    await page.mouse.move(...await point(end),{steps:7});
    await page.mouse.up();
  }
  async function imagePng(filename,revision,id=documentId){
    const response=await fetch(origin+paintRoute+'/image-export',{method:'POST',
      headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({revision,documentId:id})});
    assert.equal(response.status,200,response.ok?'':await response.text());
    const file=path.join(data,filename);
    await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));
    return file;
  }

  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await drag([.1,.1],[.5,.65]);
  await page.keyboard.down('Shift');
  await drag([.65,.2],[.9,.7]);
  await page.keyboard.up('Shift');
  await editor.getByRole('button',{name:'从选区减去',exact:true}).click();
  await drag([.23,.25],[.34,.5]);
  const shape=overlay.locator('.uv-lasso-border');
  assert.equal((await shape.getAttribute('d')).match(/M/g).length,3);
  await page.screenshot({path:path.join(data,'compound-selection.png')});
  await canvas.focus();
  await page.keyboard.press('Control+d');
  await overlay.waitFor({state:'hidden'});
  await page.keyboard.press('Control+Shift+d');
  await overlay.waitFor();
  assert.equal((await shape.getAttribute('d')).match(/M/g).length,3);

  const [copyResponse]=await Promise.all([
    page.waitForResponse(response=>response.url().endsWith('/paint/image-clipboard')),
    page.keyboard.press('Control+c')
  ]);
  assert.equal(copyResponse.status(),200);
  const {rect,regions}=copyResponse.request().postDataJSON();
  assert.deepEqual(regions.map(polygon=>polygon.length),[2,1]);
  const copyFile=path.join(data,'compound-copy.png');
  const clipboard=await page.waitForFunction(async()=>{
    const {copiedImage}=await import('/image-clipboard.mjs');
    return copiedImage()?.file.size>0;
  });
  await clipboard.dispose();
  const copiedBytes=await page.evaluate(async()=>{
    const {copiedImage}=await import('/image-clipboard.mjs');
    return Array.from(new Uint8Array(await copiedImage().file.arrayBuffer()));
  });
  await fs.writeFile(copyFile,Buffer.from(copiedBytes));
  const copyOrigin=rect.slice(0,2).map(value=>Math.ceil(value*4096-.5));
  const checks=[[.15,.2],[.28,.38],[.57,.4],[.78,.39],[.73,.67]];
  const atCanvas=checks.map(point=>point.map(n=>Math.floor(n*4096)));
  const [,copied]=rgba(copyFile,atCanvas.map(point=>point.map((n,i)=>n-copyOrigin[i])));
  assert.deepEqual(copied.map(pixel=>pixel[3]),[255,0,0,255,255]);

  await page.getByRole('button',{name:'备用层',exact:true}).click();
  await overlay.waitFor();
  await page.getByRole('button',{name:'颜色层',exact:true}).click();
  await overlay.waitFor();
  await canvas.focus();
  await page.keyboard.press('Delete');
  const cleared=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>seed.revision&&current;
  },'清除组合选区');
  const [dimensions,edited]=rgba(await imagePng('compound-clear.png',cleared.revision),atCanvas);
  assert.deepEqual(dimensions,[4096,4096]);
  assert.deepEqual(edited.map(pixel=>pixel[3]),[0,255,255,0,0]);
  assert.equal(cleared.paint.imageDocuments[documentId].layers.at(-1).strokes.at(-1).regions.length,2);

  const imageLayers=current=>Object.fromEntries(current.paint.imageDocuments[documentId].layers.map(layer=>[layer.id,layer]));
  const maskButton=page.getByRole('button',{name:'添加蒙版',exact:true});
  await maskButton.click();
  const reveal=await until(async()=>{
    const current=await api(projectRoute),layer=imageLayers(current)[layerId];
    return layer.maskStrokes?.[0]?.regions&&current;
  },'通过组合选区显示蒙版');
  const originalMask=imageLayers(reveal)[layerId];
  assert.equal(originalMask.maskBase,0);
  assert.deepEqual(originalMask.maskStrokes[0].regions,regions);
  async function inspectMask(revision,layer){
    const size=256,response=await fetch(origin+paintRoute+'/image-live',{method:'POST',
      headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({revision,documentId,inspectMask:layer,resolution:size})});
    assert.equal(response.status,200,response.ok?'':await response.text());
    const pixels=new Uint8Array(await response.arrayBuffer());
    assert.equal(pixels.length,size*size*4);
    return checks.map(([x,y])=>pixels[(Math.floor(y*size)*size+Math.floor(x*size))*4]);
  }
  assert.deepEqual(await inspectMask(reveal.revision,layerId),[255,0,0,255,255]);

  await page.getByRole('button',{name:'备用层',exact:true}).click();
  await maskButton.click({modifiers:['Alt']});
  const hide=await until(async()=>{
    const current=await api(projectRoute),layer=imageLayers(current)[otherLayerId];
    return layer.maskStrokes?.[0]?.value===0&&current;
  },'通过组合选区隐藏蒙版');
  assert.equal(imageLayers(hide)[otherLayerId].maskBase,1);
  assert.deepEqual(await inspectMask(hide.revision,otherLayerId),[0,255,255,0,0]);

  const sourceMask=page.getByRole('button',{name:'选择蒙版 颜色层',exact:true});
  const maskTarget=page.locator('[data-image-layer-id="'+otherLayerId+'"]');
  await page.keyboard.down('Alt');
  await sourceMask.dragTo(maskTarget);
  await page.keyboard.up('Alt');
  const copiedMask=await until(async()=>{
    const current=await api(projectRoute),layers=imageLayers(current);
    return layers[otherLayerId].maskBase===0&&layers[layerId].maskEnabled&&current;
  },'Alt 拖动复制蒙版');
  assert.deepEqual(imageLayers(copiedMask)[otherLayerId].maskStrokes,originalMask.maskStrokes);
  await sourceMask.dragTo(maskTarget);
  const movedMask=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>copiedMask.revision&&!imageLayers(current)[layerId].maskEnabled&&current;
  },'拖动移动蒙版');
  assert.equal(imageLayers(movedMask)[layerId].maskStrokes,undefined);
  assert.deepEqual(imageLayers(movedMask)[otherLayerId].maskStrokes,originalMask.maskStrokes);
  await canvas.focus();
  await page.keyboard.press('Control+z');
  const maskUndo=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>movedMask.revision&&imageLayers(current)[layerId].maskEnabled&&current;
  },'撤销蒙版移动');
  assert.deepEqual(imageLayers(maskUndo)[layerId].maskStrokes,originalMask.maskStrokes);
  console.log('PASS reveal and hide selection masks, 4K source shape, Alt-copy, move and undo');

  await page.getByRole('button',{name:'颜色层',exact:true}).click();
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await editor.getByRole('button',{name:'与选区相交',exact:true}).click();
  await drag([.12,.12],[.48,.55]);
  assert.equal((await shape.getAttribute('d')).match(/M/g).length,2);
  await canvas.focus();
  await page.keyboard.press('Control+Shift+i');
  assert.equal((await shape.getAttribute('d')).match(/M/g).length,3);
  console.log('PASS compound marquee, holes, intersect, inverse, reselect, 4K clipboard and clear across layers');

  const adjustmentDoc='adjustment-document',adjustmentPixels='adjustment-pixels';
  const before=await api(projectRoute);
  await api(paintRoute+'/commands',{revision:before.revision,operations:[
    {op:'image',action:'create',documentId:adjustmentDoc,patch:{name:'调整验收'}},
    {op:'image',action:'addLayer',documentId:adjustmentDoc,layerId:adjustmentPixels,kind:'pixel',patch:{name:'半透明底稿'}},
    {op:'image',action:'stroke',documentId:adjustmentDoc,layerId:adjustmentPixels,target:'pixels',
      stroke:{uv:true,rect:[.1,.1,.9,.75],opacity:.5,color:'#326496',erase:false}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(adjustmentDoc,{force:true});
  await page.getByRole('button',{name:'半透明底稿',exact:true}).click();
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await editor.getByRole('button',{name:'新建选区',exact:true}).click();
  await drag([0,.1],[.5,.9]);
  await page.getByRole('button',{name:'新建调整图层',exact:true}).click();
  await page.getByRole('menuitem',{name:'亮度／对比度',exact:true}).click();
  const currentAdjustment=current=>current.paint.imageDocuments[adjustmentDoc].layers.find(layer=>layer.kind==='adjustment');
  const adjustmentCreated=await until(async()=>{
    const current=await api(projectRoute);
    return currentAdjustment(current)&&current;
  },'新建带选区蒙版的调整层');
  const adjustment=currentAdjustment(adjustmentCreated);
  assert.equal(adjustment.maskBase,0);
  assert.equal(adjustment.maskStrokes.length,1);
  const brightness=page.locator('input.workspace-number-input[aria-label="亮度"]');
  await brightness.waitFor();
  const field=brightness.locator('..'),fieldBox=await field.boundingBox();
  await page.mouse.move(fieldBox.x+fieldBox.width/2,fieldBox.y+fieldBox.height/2);
  await page.mouse.down();
  const draft=page.waitForResponse(response=>{
    const request=response.request();
    return response.url().endsWith('/paint/image-live')&&request.postDataJSON()?.operation?.patch?.adjustment?.brightness>0;
  });
  await page.mouse.move(fieldBox.x+fieldBox.width/2+40,fieldBox.y+fieldBox.height/2,{steps:4});
  assert.equal((await draft).status(),200);
  assert.equal((await api(projectRoute)).revision,adjustmentCreated.revision);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await brightness.inputValue(),'0');
  assert.equal((await api(projectRoute)).revision,adjustmentCreated.revision);
  await field.dblclick();
  const entry=field.getByRole('spinbutton',{name:'输入数值'});
  await entry.fill('40');
  await entry.press('Enter');
  const adjusted=await until(async()=>{
    const current=await api(projectRoute);
    return currentAdjustment(current).adjustment.brightness===40&&current;
  },'调整数值提交');
  await canvas.focus();
  await page.keyboard.press('Control+d');
  await overlay.waitFor({state:'hidden'});
  const png=await imagePng('masked-adjustment.png',adjusted.revision,adjustmentDoc);
  const samples=[[1024,1024],[3072,1024],[1024,3700]];
  const [,pixels]=rgba(png,samples);
  assert.ok(pixels[0][0]>50&&pixels[0][1]>100&&pixels[0][2]>150);
  assert.deepEqual(pixels.slice(1),[[50,100,150,128],[0,0,0,0]]);
  assert.equal(pixels[0][3],128);
  await page.screenshot({path:path.join(data,'adjustment-properties.png')});

  const [merged]=await Promise.all([
    page.waitForResponse(response=>response.url().endsWith('/paint/image-clipboard')&&response.request().postDataJSON()?.merged===true),
    page.keyboard.press('Control+Shift+c')
  ]);
  assert.equal(merged.status(),200);
  await page.waitForFunction(async id=>{
    const {copiedImage}=await import('/image-clipboard.mjs');
    return copiedImage()?.documentId===id;
  },adjustmentDoc);
  const mergedFile=path.join(data,'merged-adjustment.png');
  const mergedBytes=await page.evaluate(async()=>{
    const {copiedImage}=await import('/image-clipboard.mjs');
    return Array.from(new Uint8Array(await copiedImage().file.arrayBuffer()));
  });
  await fs.writeFile(mergedFile,Buffer.from(mergedBytes));
  assert.deepEqual(rgba(mergedFile,samples),[[4096,4096],pixels]);
  await page.reload();
  await canvas.waitFor();
  assert.equal(currentAdjustment(await api(projectRoute)).adjustment.brightness,40);
  console.log('PASS masked adjustment, live scrub and Escape, double-click edit, preserved alpha, merged copy and reopen');

  const brushDoc='brush-document',brushLayer='brush-pixels';
  const brushSeed=await api(paintRoute+'/commands',{revision:adjusted.revision,operations:[
    {op:'image',action:'create',documentId:brushDoc,patch:{name:'画笔验收'}},
    {op:'image',action:'addLayer',documentId:brushDoc,layerId:brushLayer,kind:'pixel',patch:{name:'画笔底稿'}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(brushDoc,{force:true});
  await page.getByRole('button',{name:'画笔底稿',exact:true}).click();
  const brushTool=editor.getByRole('button',{name:'画笔',exact:true});
  const eraserTool=editor.getByRole('button',{name:'橡皮擦',exact:true});
  const option=label=>editor.locator('input.workspace-number-input[aria-label="'+label+'"]');
  async function setBrushOption(label,value){
    const control=option(label),wrapper=control.locator('..');
    await wrapper.dblclick();
    const entry=wrapper.getByRole('spinbutton',{name:'输入数值'});
    await entry.fill(String(value));
    await entry.press('Enter');
    assert.equal(Number(await control.inputValue()),value);
  }
  async function brushRevision(previous,check){
    const current=await until(async()=>{
      const doc=await api(projectRoute);
      return doc.revision>previous&&doc;
    },'保存画笔轨迹');
    check(current.paint.imageDocuments[brushDoc].layers[0]);
    await until(()=>brushTool.isEnabled(),'绘制控件可继续操作');
    return current;
  }
  await brushTool.click();
  await setBrushOption('像素半径',64);
  await setBrushOption('不透明度',60);
  await setBrushOption('流量',25);
  await setBrushOption('间距',20);
  await page.keyboard.press('d');
  await page.mouse.click(...await point([.28,.3]));
  const dot=await brushRevision(brushSeed.revision,layer=>{
    assert.equal(layer.strokes[0].flow,.25);
    assert.equal(layer.strokes[0].spacing,.2);
    assert.equal(layer.strokes[0].stamps.length,1);
  });
  await page.keyboard.down('Shift');
  await page.mouse.click(...await point([.72,.3]));
  await page.keyboard.up('Shift');
  const straight=await brushRevision(dot.revision,layer=>{
    assert.equal(layer.strokes[1].stamps.length,2);
    assert.deepEqual(layer.strokes[0].stamps[0],layer.strokes[1].stamps[0]);
  });
  await page.keyboard.press('Control+=');
  await drag([.28,.7],[.72,.7]);
  const zoomed=await brushRevision(straight.revision,layer=>{
    assert.ok(layer.strokes[2].stamps.length>=2);
  });
  const xy=(x,y)=>[Math.floor(x*4096),Math.floor(y*4096)];
  const [,brushPixels]=rgba(await imagePng('brush-flow.png',zoomed.revision,brushDoc),
    [xy(.5,.3),xy(.5,.7),xy(.5,.5),xy(.28,.3)]);
  assert.ok(brushPixels[0][3]>38&&brushPixels[0][3]<=153);
  assert.ok(Math.abs(brushPixels[0][3]-brushPixels[1][3])<=2);
  assert.equal(brushPixels[2][3],0);
  await eraserTool.click();
  assert.equal(await option('流量').inputValue(),'100');
  await setBrushOption('像素半径',42);
  await page.mouse.click(...await point([.5,.7]));
  const erased=await brushRevision(zoomed.revision,layer=>{
    assert.equal(layer.strokes[3].erase,true);
    assert.equal(layer.strokes[3].radius,42/4096);
    assert.equal(layer.strokes[3].opacity,1);
  });
  assert.equal(rgba(await imagePng('brush-erased.png',erased.revision,brushDoc),[xy(.5,.7)])[1][0][3],0);
  await brushTool.click();
  assert.equal(await option('流量').inputValue(),'25');
  assert.equal(await option('像素半径').inputValue(),'64');
  await eraserTool.click();
  assert.equal(await option('像素半径').inputValue(),'42');
  await page.mouse.move(...await point([.5,.7]));
  await editor.locator('.area-uv-cursor').waitFor({state:'visible'});
  await page.screenshot({path:path.join(data,'brush-options.png')});
  console.log('PASS opacity and flow, document-space spacing, Shift-click line, zoomed stroke, separate eraser and radius cursor');

  const clipDoc='clipping-document',clipBase='clipping-base',clipColor='clipping-color',clipEffect='clipping-effect';
  const clipSeed=await api(paintRoute+'/commands',{revision:erased.revision,operations:[
    {op:'image',action:'create',documentId:clipDoc,patch:{name:'剪贴蒙版验收'}},
    {op:'image',action:'addLayer',documentId:clipDoc,layerId:'clip-backdrop',kind:'pixel',patch:{name:'下方背景'}},
    {op:'image',action:'stroke',documentId:clipDoc,layerId:'clip-backdrop',target:'pixels',
      stroke:{uv:true,rect:[0,.1,.2,.8],opacity:1,color:'#c8501e',erase:false}},
    {op:'image',action:'addLayer',documentId:clipDoc,layerId:clipBase,kind:'pixel',patch:{name:'剪贴底层',opacity:.5}},
    {op:'image',action:'stroke',documentId:clipDoc,layerId:clipBase,target:'pixels',
      stroke:{uv:true,rect:[.25,.2,.7,.75],opacity:.5,color:'#326496',erase:false}},
    {op:'image',action:'addLayer',documentId:clipDoc,layerId:clipColor,kind:'pixel',patch:{name:'剪贴色层'}},
    {op:'image',action:'stroke',documentId:clipDoc,layerId:clipColor,target:'pixels',
      stroke:{uv:true,rect:[0,0,.5,1],opacity:1,color:'#406080',erase:false}},
    {op:'image',action:'addLayer',documentId:clipDoc,layerId:clipEffect,kind:'adjustment',
      patch:{name:'剪贴反相',adjustment:{type:'invert'}}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(clipDoc,{force:true});
  const clipButton=page.getByRole('button',{name:'剪贴色层',exact:true});
  await clipButton.click({button:'right'});
  await page.getByRole('menuitem',{name:'创建剪贴蒙版'}).click();
  const clipState=(current,id)=>current.paint.imageDocuments[clipDoc].layers.find(layer=>layer.id===id);
  const clipped=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>clipSeed.revision&&clipState(current,clipColor).clipped&&current;
  },'通过图层菜单创建剪贴蒙版');
  const clippedEffectRow=page.locator('[data-image-layer-id="'+clipEffect+'"]');
  await clippedEffectRow.getByRole('button',{name:'Alt / Option 单击创建剪贴蒙版',exact:true}).click({modifiers:['Alt']});
  const clippingGroup=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>clipped.revision&&clipState(current,clipEffect).clipped&&current;
  },'Alt 单击分界线剪贴调整图层');
  const clipSamples=[xy(.1,.4),xy(.4,.4),xy(.6,.4),xy(.8,.4)];
  const [,clipPixels]=rgba(await imagePng('clipping-group.png',clippingGroup.revision,clipDoc),clipSamples);
  assert.deepEqual(clipPixels,[[200,80,30,255],[191,159,127,64],[205,155,105,64],[0,0,0,0]]);
  await page.screenshot({path:path.join(data,'clipping-layers.png')});
  await page.getByRole('button',{name:'隐藏 剪贴底层',exact:true}).click();
  const hiddenClips=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>clippingGroup.revision&&!clipState(current,clipBase).visible&&current;
  },'隐藏剪贴底层');
  assert.deepEqual(rgba(await imagePng('clipping-hidden.png',hiddenClips.revision,clipDoc),clipSamples)[1],
    [[200,80,30,255],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
  await page.getByRole('button',{name:'显示 剪贴底层',exact:true}).click();
  await clipButton.click({button:'right'});
  await page.getByRole('menuitem',{name:'释放剪贴蒙版'}).click();
  const released=await until(async()=>{
    const current=await api(projectRoute);
    return !clipState(current,clipColor).clipped&&!clipState(current,clipEffect).clipped&&current;
  },'释放选中层和上方剪贴层');
  await page.reload();
  await canvas.waitFor();
  assert.equal((await api(projectRoute)).revision,released.revision);
  console.log('PASS clipping mask from menu and Option-click, adjustment clipping, exact alpha, hidden base, release and reopen');

  const featherDoc='feather-document',featherLayer='feather-pixels';
  const featherSeed=await api(paintRoute+'/commands',{revision:released.revision,operations:[
    {op:'image',action:'create',documentId:featherDoc,patch:{name:'羽化验收'}},
    {op:'image',action:'addLayer',documentId:featherDoc,layerId:featherLayer,kind:'pixel',patch:{name:'软边测试'}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(featherDoc,{force:true});
  await page.getByRole('button',{name:'软边测试',exact:true}).click();
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await editor.getByRole('button',{name:'新建选区',exact:true}).click();
  await drag([.24,.25],[.42,.75]);
  await setBrushOption('选区羽化',64);
  await editor.getByLabel('图像前景色',{exact:true}).fill('#478cde');
  await canvas.focus();
  await page.keyboard.press('Alt+Backspace');
  const featherState=(current)=>current.paint.imageDocuments[featherDoc].layers[0];
  const filled=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>featherSeed.revision&&featherState(current).strokes?.length&&current;
  },'快捷键填充羽化选区');
  const fillStroke=featherState(filled).strokes[0];
  assert.equal(fillStroke.feather,64);
  assert.equal(fillStroke.opacity,1);
  const left=Math.ceil(fillStroke.rect[0]*4096-.5),middle=2048;
  const featherSamples=[-220,-32,0,32,220].map(dx=>[left+dx,middle]);
  const [,featherPixels]=rgba(await imagePng('feather-fill.png',filled.revision,featherDoc),featherSamples);
  const alpha=featherPixels.map(pixel=>pixel[3]);
  assert.equal(alpha[0],0);
  assert.equal(alpha.at(-1),255);
  assert.ok(alpha[1]>0&&alpha[1]<alpha[2]&&alpha[2]>110&&alpha[2]<145&&alpha[3]>alpha[2]&&alpha[3]<255);
  assert.deepEqual(featherPixels[2].slice(0,3),[71,140,222]);
  await until(()=>editor.getByRole('button',{name:'画笔',exact:true}).isEnabled(),'羽化填充保存后继续复制');
  const [softCopy]=await Promise.all([
    page.waitForResponse(response=>response.url().endsWith('/paint/image-clipboard')),
    page.keyboard.press('Control+c')
  ]);
  assert.equal(softCopy.status(),200);
  assert.equal(softCopy.request().postDataJSON().feather,64);
  await page.waitForFunction(async id=>(await import('/image-clipboard.mjs')).copiedImage()?.documentId===id,featherDoc);
  const softClipboard=await page.evaluate(async()=>{const {copiedImage}=await import('/image-clipboard.mjs');const entry=copiedImage();return {
    width:entry.width,height:entry.height,bytes:Array.from(new Uint8Array(await entry.file.arrayBuffer()))
  };});
  const softCopyFile=path.join(data,'feather-copy.png');
  await fs.writeFile(softCopyFile,Buffer.from(softClipboard.bytes));
  const padding=193,top=Math.ceil(fillStroke.rect[1]*4096-.5);
  assert.equal(softClipboard.width,Math.ceil(fillStroke.rect[2]*4096-.5)-left+2*padding);
  const [,copiedFeather]=rgba(softCopyFile,[[padding,middle-top+padding]]);
  assert.ok(Math.abs(copiedFeather[0][3]-Math.round(alpha[2]**2/255))<=1);

  const transformed=await api(paintRoute+'/commands',{revision:filled.revision,operations:[
    {op:'image',action:'transform',documentId:featherDoc,layerId:featherLayer,
      transform:{rect:fillStroke.rect,feather:64,offset:[.35,0],scale:[1,1],angle:0,interpolation:'linear'}}
  ]});
  const [,movedFeather]=rgba(await imagePng('feather-transform.png',transformed.revision,featherDoc),
    [xy(.33,.5),xy(.68,.5),[left+Math.round(.35*4096),middle]]);
  assert.deepEqual(movedFeather.slice(0,2),[[0,0,0,0],[71,140,222,255]]);
  assert.ok(movedFeather[2][3]>45&&movedFeather[2][3]<90);
  await page.reload();
  await canvas.waitFor();
  assert.equal(await option('选区羽化').inputValue(),'64');
  assert.deepEqual(pageErrors,[]);
  console.log('PASS feathered keyboard fill, exact soft coverage and clipboard bounds, linear transform and persisted tool setting');
}catch(error){
  console.error(logs);
  throw error;
}finally{
  await browser?.close();
  if(server.exitCode===null&&server.signalCode===null){
    const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;
  }
  console.log('Drawing verification data:',data);
}
