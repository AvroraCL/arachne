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
  console.log('PASS feathered keyboard fill, exact soft coverage and clipboard bounds, linear transform and persisted tool setting');

  const curvesDoc='curves-document',curvesPixels='curves-pixels';
  const curvesSeed=await api(paintRoute+'/commands',{revision:transformed.revision,operations:[
    {op:'image',action:'create',documentId:curvesDoc,patch:{name:'曲线验收'}},
    {op:'image',action:'addLayer',documentId:curvesDoc,layerId:curvesPixels,kind:'pixel',patch:{name:'曲线底稿'}},
    {op:'image',action:'stroke',documentId:curvesDoc,layerId:curvesPixels,target:'pixels',
      stroke:{uv:true,rect:[.1,.1,.4,.9],opacity:.5,color:'#4060a0',erase:false}},
    {op:'image',action:'stroke',documentId:curvesDoc,layerId:curvesPixels,target:'pixels',
      stroke:{uv:true,rect:[.6,.1,.9,.9],opacity:1,color:'#c05028',erase:false}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(curvesDoc,{force:true});
  await page.getByRole('button',{name:'曲线底稿',exact:true}).click();
  await page.getByRole('button',{name:'新建调整图层',exact:true}).click();
  const hist=page.waitForResponse(response=>response.url().endsWith('/paint/image-live')&&!!response.request().postDataJSON()?.beforeImageLayer);
  await page.getByRole('menuitem',{name:'曲线',exact:true}).click();
  const graph=page.getByRole('group',{name:'曲线控制点'});
  await graph.locator('path.document-curves-histogram').waitFor();
  assert.equal((await hist).status(),200);
  await page.locator('.document-curves-graph[data-histogram-ready]').waitFor();
  await graph.scrollIntoViewIfNeeded();
  const curvesLayer=current=>current.paint.imageDocuments[curvesDoc].layers.find(layer=>layer.kind==='adjustment');
  const curveCreated=await api(projectRoute);
  assert.ok(curveCreated.revision>curvesSeed.revision);
  async function graphPoint(x,y){
    return graph.evaluate((node,[x,y])=>{
      const point=new DOMPoint(x,255-y).matrixTransform(node.getScreenCTM());
      return [point.x,point.y];
    },[x,y]);
  }
  const graphDraft=page.waitForResponse(response=>{
    const params=response.request().postDataJSON()?.operation?.patch?.adjustment;
    return response.url().endsWith('/paint/image-live')&&params?.type==='curves'&&params.points.rgb.some(point=>Math.abs(point[1]-128)<=1);
  });
  await page.mouse.move(...await graphPoint(64,96));
  await page.mouse.down();
  await page.mouse.move(...await graphPoint(64,128),{steps:4});
  assert.equal((await graphDraft).status(),200);
  assert.equal((await api(projectRoute)).revision,curveCreated.revision);
  await page.mouse.up();
  const rgbCurve=await until(async()=>{
    const current=await api(projectRoute);
    return curvesLayer(current).adjustment.points.rgb.some(point=>Math.abs(point[0]-64)<=1&&Math.abs(point[1]-128)<=1)&&current;
  },'保存 RGB 曲线控制点');
  await page.locator('select[aria-label="曲线通道"]').selectOption('red',{force:true});
  await page.locator('.document-curves-graph[data-channel=red]:not([data-disabled])').waitFor();
  await page.mouse.click(...await graphPoint(128,148));
  const redCurve=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>rgbCurve.revision&&curvesLayer(current).adjustment.points.red.length===3&&current;
  },'保存独立红色曲线');
  const curveOutput=page.locator('input.workspace-number-input[aria-label="曲线输出"]');
  await until(()=>curveOutput.isEnabled(),'重绘后仍选中红色控制点');
  const curveOutputField=curveOutput.locator('..');
  await curveOutputField.dblclick();
  const curveEntry=curveOutputField.getByRole('spinbutton',{name:'输入数值'});
  await curveEntry.fill('152');
  await curveEntry.press('Enter');
  const preciseCurve=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>redCurve.revision&&curvesLayer(current).adjustment.points.red[1][1]===152&&current;
  },'双击输入曲线输出值');
  const [,curvePixels]=rgba(await imagePng('channel-curves.png',preciseCurve.revision,curvesDoc),
    [xy(.25,.5),xy(.5,.5)]);
  assert.ok(Math.abs(curvePixels[0][0]-152)<=3&&curvePixels[0][1]>96&&curvePixels[0][2]>160);
  assert.equal(curvePixels[0][3],128);
  assert.deepEqual(curvePixels[1],[0,0,0,0]);
  await page.screenshot({path:path.join(data,'curve-editor.png')});
  await graph.focus();
  await page.keyboard.press('Delete');
  const removedCurve=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>preciseCurve.revision&&curvesLayer(current).adjustment.points.red.length===2&&current;
  },'Delete 删除曲线控制点');
  await canvas.focus();
  await page.keyboard.press('Control+z');
  await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>removedCurve.revision&&curvesLayer(current).adjustment.points.red[1][1]===152;
  },'撤销恢复曲线控制点');
  await page.reload();
  await graph.waitFor();
  const restoredCurve=await api(projectRoute);
  assert.equal(curvesLayer(restoredCurve).adjustment.points.red[1][1],152);
  console.log('PASS curve histogram, live point drag, independent RGB and red controls, exact numeric input, 4K alpha and undo');

  const blurDoc='blur-document',blurPixels='blur-pixels';
  await api(paintRoute+'/commands',{revision:restoredCurve.revision,operations:[
    {op:'image',action:'create',documentId:blurDoc,patch:{name:'滤镜验收'}},
    {op:'image',action:'addLayer',documentId:blurDoc,layerId:blurPixels,kind:'pixel',patch:{name:'半透明方形'}},
    {op:'image',action:'stroke',documentId:blurDoc,layerId:blurPixels,target:'pixels',
      stroke:{uv:true,rect:[.25,.25,.75,.75],opacity:.5,color:'#ec7c28',erase:false}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(blurDoc,{force:true});
  await page.getByRole('button',{name:'半透明方形',exact:true}).click();
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await editor.getByRole('button',{name:'新建选区',exact:true}).click();
  await drag([.12,.35],[.5,.65]);
  await page.getByRole('button',{name:'新建调整图层',exact:true}).click();
  await page.getByRole('menuitem',{name:'高斯模糊',exact:true}).click();
  const blurRadius=page.locator('input.workspace-number-input[aria-label="半径（像素）"]');
  const blurValue=blurRadius.locator('..');
  await blurRadius.waitFor();
  await blurValue.dblclick();
  const blurEntry=blurValue.getByRole('spinbutton',{name:'输入数值'});
  await blurEntry.fill('64');
  await blurEntry.press('Enter');
  const filterLayer=current=>current.paint.imageDocuments[blurDoc].layers[1];
  const blurred=await until(async()=>{
    const current=await api(projectRoute);
    return filterLayer(current)?.adjustment.radius===64&&current;
  },'保存高斯模糊半径');
  assert.equal(filterLayer(blurred).maskBase,0);
  assert.equal(filterLayer(blurred).maskStrokes.length,1);
  await canvas.focus();
  await page.keyboard.press('Control+d');
  const probes=[[1000,2048],[1050,2048],[1300,2048],[3100,2048],[1000,1100]];
  const [blurDimensions,blurredPixels]=rgba(await imagePng('masked-gaussian-blur.png',blurred.revision,blurDoc),probes);
  assert.deepEqual(blurDimensions,[4096,4096]);
  assert.deepEqual(blurredPixels.slice(2),[[236,124,40,128],[0,0,0,0],[0,0,0,0]]);
  assert.ok(blurredPixels[0][3]>35&&blurredPixels[0][3]<55);
  assert.ok(blurredPixels[1][3]>75&&blurredPixels[1][3]<94);
  assert.deepEqual(blurredPixels.slice(0,2).map(pixel=>pixel.slice(0,3)),[[236,124,40],[236,124,40]]);
  await page.screenshot({path:path.join(data,'masked-gaussian-blur-workbench.png')});
  await page.keyboard.press('Control+z');
  const undoBlur=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>blurred.revision&&filterLayer(current).adjustment.radius===12&&current;
  },'撤销高斯模糊半径');
  await page.keyboard.press('Control+Shift+z');
  const redoBlur=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>undoBlur.revision&&filterLayer(current).adjustment.radius===64&&current;
  },'重做高斯模糊半径');
  await page.reload();
  await blurRadius.waitFor();
  assert.equal(await blurRadius.inputValue(),'64');
  console.log('PASS non-destructive Gaussian blur, selection mask, premultiplied 4K pixels, undo, redo and reopen');
  const sharpDoc='sharpen-document',sharpPixels='sharpen-pixels';
  await api(paintRoute+'/commands',{revision:redoBlur.revision,operations:[
    {op:'image',action:'remove',documentId:blurDoc},
    {op:'image',action:'create',documentId:sharpDoc,patch:{name:'锐化验收'}},
    {op:'image',action:'addLayer',documentId:sharpDoc,layerId:sharpPixels,kind:'pixel',patch:{name:'半透明对比边界'}},
    ...['#606060','#a0a0a0'].map((color,index)=>({op:'image',action:'stroke',documentId:sharpDoc,layerId:sharpPixels,target:'pixels',
      stroke:{uv:true,rect:[.25+index*.25,.25,.5+index*.25,.75],opacity:.5,color,erase:false}}))
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(sharpDoc,{force:true});
  await page.getByRole('button',{name:'半透明对比边界',exact:true}).click();
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await editor.getByRole('button',{name:'新建选区',exact:true}).click();
  await drag([.4,.31],[.6,.5]);
  await page.getByRole('button',{name:'新建调整图层',exact:true}).click();
  await page.getByRole('menuitem',{name:'USM 锐化',exact:true}).click();
  const sharpenedLayer=current=>current.paint.imageDocuments[sharpDoc].layers[1];
  async function filterSetting(label,value){
    const control=page.locator('input.workspace-number-input[aria-label="'+label+'"]'),field=control.locator('..');
    await until(()=>control.isEnabled(),label+' 可修改');
    await field.dblclick();
    const entry=field.getByRole('spinbutton',{name:'输入数值'});
    await entry.fill(String(value));
    await entry.press('Enter');
  }
  await filterSetting('半径（像素）',32);
  const sharpened=await until(async()=>{
    const current=await api(projectRoute);
    return sharpenedLayer(current)?.adjustment.radius===32&&current;
  },'保存锐化半径');
  assert.equal(sharpenedLayer(sharpened).maskBase,0);
  const sharpenProbes=[[2040,1650],[2055,1650],[2040,2450],[2055,2450],[1220,1650],[820,1650]];
  const [sharpDimensions,sharpValues]=rgba(await imagePng('masked-unsharp.png',sharpened.revision,sharpDoc),sharpenProbes);
  assert.deepEqual(sharpDimensions,[4096,4096]);
  assert.ok(sharpValues[0][0]<80&&sharpValues[1][0]>175);
  assert.deepEqual(sharpValues.slice(2),[[96,96,96,128],[160,160,160,128],[96,96,96,128],[0,0,0,0]]);
  assert.equal(sharpValues[0][3],128);
  assert.equal(sharpValues[1][3],128);
  await canvas.focus();
  await page.keyboard.press('Control+d');
  await page.screenshot({path:path.join(data,'masked-unsharp-workbench.png')});
  await filterSetting('阈值',255);
  const thresholded=await until(async()=>{
    const current=await api(projectRoute);
    return sharpenedLayer(current)?.adjustment.threshold===255&&current;
  },'保存锐化阈值');
  const [,baseValues]=rgba(await imagePng('threshold-unsharp.png',thresholded.revision,sharpDoc),sharpenProbes);
  assert.deepEqual(baseValues.slice(0,2),[[96,96,96,128],[160,160,160,128]]);
  await canvas.focus();
  await page.keyboard.press('Control+z');
  const undoThreshold=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>thresholded.revision&&sharpenedLayer(current).adjustment.threshold===0&&current;
  },'撤销锐化阈值');
  await page.reload();
  await page.locator('input.workspace-number-input[aria-label="阈值"]').waitFor();
  assert.deepEqual(rgba(await imagePng('reopen-unsharp.png',undoThreshold.revision,sharpDoc),sharpenProbes)[1],sharpValues);
  console.log('PASS non-destructive Unsharp Mask, threshold, selection mask, unchanged 4K alpha, undo and reopen');
  const finishedBlur=await api(paintRoute+'/commands',{revision:undoThreshold.revision,operations:[
    {op:'image',action:'remove',documentId:sharpDoc}
  ]});

  const fillDoc='bucket-document',bucketLayer='bucket-pixels';
  const swatches=[
    [[.1,.25,.24,.75],'#202040'],[[.36,.25,.5,.75],'#242640'],
    [[.66,.25,.8,.75],'#282444'],[[.86,.25,.96,.75],'#806040']
  ];
  const bucketSeed=await api(paintRoute+'/commands',{revision:finishedBlur.revision,operations:[
    {op:'image',action:'create',documentId:fillDoc,patch:{name:'油漆桶验收'}},
    {op:'image',action:'addLayer',documentId:fillDoc,layerId:bucketLayer,kind:'pixel',patch:{name:'色块'}},
    ...swatches.map(([rect,color])=>({op:'image',action:'stroke',documentId:fillDoc,layerId:bucketLayer,target:'pixels',
      stroke:{uv:true,rect,opacity:1,color,erase:false}}))
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(fillDoc,{force:true});
  await page.getByRole('button',{name:'色块',exact:true}).click();
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await editor.getByRole('button',{name:'渐变工具',exact:true}).click();
  await page.keyboard.press('Shift+g');
  const bucket=editor.getByRole('button',{name:'油漆桶',exact:true});
  assert.equal(await bucket.getAttribute('aria-pressed'),'true');
  await setBrushOption('油漆桶容差',12);
  await editor.getByLabel('图像前景色',{exact:true}).fill('#f3b529');
  await page.mouse.click(...await point([.17,.5]));
  const bucketStrokes=current=>current.paint.imageDocuments[fillDoc].layers[0].strokes;
  const contiguousFill=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>bucketSeed.revision&&bucketStrokes(current).at(-1).flood?.contiguous&&current;
  },'填充连续色块');
  const bucketSamples=[.17,.42,.7,.9,.55].map(x=>xy(x,.5));
  assert.deepEqual(rgba(await imagePng('bucket-contiguous.png',contiguousFill.revision,fillDoc),bucketSamples)[1],
    [[243,181,41,255],[36,38,64,255],[40,36,68,255],[128,96,64,255],[0,0,0,0]]);
  await until(()=>bucket.isEnabled(),'油漆桶可再次填充');
  await editor.getByRole('checkbox',{name:'只填充连续区域'}).uncheck();
  await editor.getByLabel('图像前景色',{exact:true}).fill('#249ed8');
  await page.mouse.click(...await point([.42,.5]));
  const globalFill=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>contiguousFill.revision&&bucketStrokes(current).at(-1).flood?.contiguous===false&&current;
  },'填充不相邻的相似色块');
  assert.deepEqual(rgba(await imagePng('bucket-global.png',globalFill.revision,fillDoc),bucketSamples)[1],
    [[243,181,41,255],[36,158,216,255],[36,158,216,255],[128,96,64,255],[0,0,0,0]]);
  await page.reload();
  await canvas.waitFor();
  assert.equal(await bucket.getAttribute('aria-pressed'),'true');
  assert.equal(await editor.getByRole('checkbox',{name:'只填充连续区域'}).isChecked(),false);
  console.log('PASS Paint Bucket, G tool group, tolerance, connected and disconnected pixels, transparency and reopen');

  const cloneDoc='clone-document',cloneLayer='clone-pixels';
  const cloneSeed=await api(paintRoute+'/commands',{revision:globalFill.revision,operations:[
    {op:'image',action:'create',documentId:cloneDoc,patch:{name:'仿制图章验收'}},
    {op:'image',action:'addLayer',documentId:cloneDoc,layerId:cloneLayer,kind:'pixel',patch:{name:'仿制素材'}},
    {op:'image',action:'stroke',documentId:cloneDoc,layerId:cloneLayer,target:'pixels',
      stroke:{uv:true,rect:[.15,.22,.24,.4],opacity:.6,color:'#e24b3f',erase:false}},
    {op:'image',action:'stroke',documentId:cloneDoc,layerId:cloneLayer,target:'pixels',
      stroke:{uv:true,rect:[.24,.22,.33,.4],opacity:.8,color:'#39ad70',erase:false}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(cloneDoc,{force:true});
  await page.getByRole('button',{name:'仿制素材',exact:true}).click();
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await canvas.focus();
  await page.keyboard.press('s');
  const stamp=editor.getByRole('button',{name:'仿制图章',exact:true});
  assert.equal(await stamp.getAttribute('aria-pressed'),'true');
  await setBrushOption('像素半径',128);
  await page.keyboard.down('Alt');
  await page.mouse.click(...await point([.2,.3]));
  await page.keyboard.up('Alt');
  await editor.locator('.document-clone-source').waitFor({state:'visible'});
  await drag([.55,.35],[.63,.35]);
  const cloneStrokes=current=>current.paint.imageDocuments[cloneDoc].layers[0].strokes;
  const firstClone=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>cloneSeed.revision&&cloneStrokes(current).at(-1).clone&&current;
  },'从当前像素层复制源像素');
  assert.ok(Math.abs(cloneStrokes(firstClone).at(-1).clone.offset[0]+.35)<.005);
  await until(()=>stamp.isEnabled(),'第一笔仿制已保存');
  await page.mouse.click(...await point([.65,.35]));
  const alignedClone=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>firstClone.revision&&cloneStrokes(current).length===4&&current;
  },'对齐仿制跨笔沿用偏移');
  assert.deepEqual(cloneStrokes(alignedClone).at(-1).clone,cloneStrokes(firstClone).at(-1).clone);
  await until(()=>stamp.isEnabled(),'第二笔仿制已保存');
  await editor.getByRole('checkbox',{name:'对齐仿制源'}).uncheck();
  await page.mouse.click(...await point([.8,.6]));
  const unalignedClone=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>alignedClone.revision&&cloneStrokes(current).length===5&&current;
  },'从原始取样点开始新一笔');
  assert.ok(Math.abs(cloneStrokes(unalignedClone).at(-1).clone.offset[0]+.6)<.005);
  const [,clonedPixels]=rgba(await imagePng('clone-stamp.png',unalignedClone.revision,cloneDoc),
    [[.55,.35],[.65,.35],[.8,.6],[.8,.35],[.2,.3]].map(([x,y])=>xy(x,y)));
  assert.deepEqual(clonedPixels[0].slice(0,3),[226,75,63]);
  assert.deepEqual(clonedPixels[1].slice(0,3),[57,173,112]);
  assert.deepEqual(clonedPixels[2], [226,75,63,153]);
  assert.deepEqual(clonedPixels[3], [0,0,0,0]);
  assert.deepEqual(clonedPixels[4], [226,75,63,153]);
  await page.screenshot({path:path.join(data,'clone-tool.png')});
  await page.reload();
  await canvas.waitFor();
  assert.equal(cloneStrokes(await api(projectRoute)).length,5);
  assert.equal(await editor.getByRole('checkbox',{name:'对齐仿制源'}).isChecked(),false);
  console.log('PASS Clone Stamp source cursor, aligned and unaligned strokes, original RGBA pixels and reopen');

  const rapidDoc='rapid-strokes',rapidLayer='rapid-pixels';
  const rapidSeed=await api(paintRoute+'/commands',{revision:unalignedClone.revision,operations:[
    {op:'image',action:'create',documentId:rapidDoc,patch:{name:'连续画笔验收'}},
    {op:'image',action:'addLayer',documentId:rapidDoc,layerId:rapidLayer,kind:'pixel',patch:{name:'连续笔触'}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(rapidDoc,{force:true});
  await page.getByRole('button',{name:'连续笔触',exact:true}).click();
  await brushTool.click();
  await setBrushOption('流量',100);
  await setBrushOption('不透明度',100);
  const delayedWrite=async route=>{await delay(300);await route.continue();};
  await page.route('**/paint/commands',delayedWrite);
  const pendingPreview=page.waitForResponse(response=>{
    const request=response.request().postDataJSON();
    return response.url().endsWith('/paint/image-live')&&request?.operations?.length>=3;
  });
  const rapidPositions=[[.2,.35],[.34,.35],[.48,.35],[.62,.35],[.76,.35]];
  for(const position of rapidPositions)await page.mouse.click(...await point(position));
  assert.ok(Number(await editor.locator('.document-image-stage').getAttribute('data-pending-strokes'))>=3);
  assert.equal((await pendingPreview).status(),200);
  await canvas.focus();
  assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('undo')),true);
  const rapidStrokes=current=>current.paint.imageDocuments[rapidDoc].layers[0].strokes;
  const rapidlyUndone=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision===rapidSeed.revision+6&&rapidStrokes(current)?.length===4&&current;
  },'排队保存五笔后只撤销最后一笔');
  await page.unroute('**/paint/commands',delayedWrite);
  assert.deepEqual(rgba(await imagePng('rapid-undo.png',rapidlyUndone.revision,rapidDoc),
    rapidPositions.map(([x,y])=>xy(x,y)))[1].map(pixel=>pixel[3]),[255,255,255,255,0]);
  await canvas.focus();
  await page.keyboard.press('Control+Shift+z');
  const rapidlyRedone=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision===rapidlyUndone.revision+1&&rapidStrokes(current)?.length===5&&current;
  },'重做独立恢复第五笔');
  await editor.locator('.document-image-stage[data-preview-size="4096"][data-preview-revision="'+rapidlyRedone.revision+'"]').waitFor();
  console.log('PASS rapid consecutive strokes under delayed writes, merged live draft, independent undo/redo and automatic 4K');

  let releaseWrite,attempted;
  const waitForPaint=new Promise(resolve=>{releaseWrite=resolve;});
  const loseResponse=async route=>{
    const request=route.request().postDataJSON();
    if(attempted||!request?.strokeRequestId){await route.continue();return;}
    attempted=request;
    await waitForPaint;
    const committed=await route.fetch();
    assert.equal(committed.status(),200);
    await route.abort('failed');
  };
  await page.route('**/paint/commands',loseResponse);
  const recoveredPositions=[[.25,.66],[.5,.66],[.75,.66]];
  for(const position of recoveredPositions)await page.mouse.click(...await point(position));
  await until(()=>attempted,'截取第一笔保存请求');
  await until(async()=>Number(await editor.locator('.document-image-stage').getAttribute('data-pending-strokes'))===3,'三笔保留在同一队列');
  releaseWrite();
  const retryStroke=editor.getByRole('button',{name:'重试保存笔触',exact:true});
  await retryStroke.waitFor();
  assert.equal(await page.locator('#project-save-state').textContent(),'笔触未保存');
  assert.equal(await page.evaluate(async()=> (await window.arachneNativeHost.prepareToCloseAsync()).state),'unsaved');
  assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('openProject')),true);
  assert.equal(await page.locator('#open-project-dialog[open]').count(),0);
  const acknowledged=await api(paintRoute+'/commands',attempted);
  assert.equal(acknowledged.revision,rapidlyRedone.revision+1);
  assert.equal(rapidStrokes(acknowledged).length,6);
  await page.screenshot({path:path.join(data,'stroke-save-recovery.png')});
  await page.reload();
  await retryStroke.waitFor();
  await editor.getByRole('alert').filter({hasText:'从此窗口恢复了待保存笔触'}).waitFor();
  assert.equal(await editor.locator('.document-image-stage').getAttribute('data-pending-strokes'),'3');
  await retryStroke.click();
  const recovered=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision===rapidlyRedone.revision+3&&rapidStrokes(current)?.length===8&&current;
  },'恢复响应丢失的笔触与后续两笔');
  await until(async()=>await page.locator('#project-save-state').textContent()==='已保存','恢复后保存状态');
  assert.deepEqual(rgba(await imagePng('recovered-strokes.png',recovered.revision,rapidDoc),
    recoveredPositions.map(([x,y])=>xy(x,y)))[1].map(pixel=>pixel[3]),[255,255,255]);
  await page.unroute('**/paint/commands',loseResponse);
  console.log('PASS lost stroke response, reload recovery, duplicate command protection, blocked project switch and quit, exact recovered 4K pixels');

  const shapesDoc='shape-document';
  const shapesSeed=await api(paintRoute+'/commands',{revision:recovered.revision,operations:[
    {op:'image',action:'create',documentId:shapesDoc,patch:{name:'形状层验收'}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(shapesDoc,{force:true});
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await canvas.focus();
  await page.keyboard.press('u');
  await editor.getByRole('checkbox',{name:'形状描边',exact:true}).check();
  await setBrushOption('形状描边宽度',32);
  await setBrushOption('形状圆角',220);
  await editor.getByLabel('图像前景色',{exact:true}).fill('#155ed4');
  await editor.getByLabel('图像背景色',{exact:true}).fill('#f5d454');
  const shapeDraft=page.waitForResponse(response=>response.url().endsWith('/paint/image-live')&&
    response.request().postDataJSON()?.operation?.kind==='shape');
  await page.keyboard.down('Shift');
  await page.mouse.move(...await point([.2,.2]));
  await page.mouse.down();
  await page.mouse.move(...await point([.52,.38]),{steps:5});
  assert.equal((await shapeDraft).status(),200);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const shapes=current=>current.paint.imageDocuments[shapesDoc].layers;
  const rectangle=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>shapesSeed.revision&&shapes(current)[0]?.shape?.kind==='rectangle'&&current;
  },'Shift 绘制可编辑圆角正方形');
  const rectangleLayer=shapes(rectangle)[0];
  assert.equal(rectangleLayer.shape.width,rectangleLayer.shape.height);
  assert.equal(rectangleLayer.shape.cornerRadius,220);
  const leftShape=rectangleLayer.x-rectangleLayer.scale/2,topShape=rectangleLayer.y-rectangleLayer.scale/2;
  const squareSamples=[[rectangleLayer.x,rectangleLayer.y],[leftShape+10/4096,rectangleLayer.y],
    [leftShape+10/4096,topShape+10/4096]].map(([x,y])=>xy(x,y));
  assert.deepEqual(rgba(await imagePng('vector-rectangle.png',rectangle.revision,shapesDoc),squareSamples)[1],
    [[21,94,212,255],[245,212,84,255],[0,0,0,0]]);
  const fillColor=page.getByLabel('填充颜色',{exact:true});
  await fillColor.fill('#2299b7');
  const restyled=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>rectangle.revision&&shapes(current)[0].shape.fill==='#2299b7'&&current;
  },'从图像属性更改形状填充色');
  await canvas.focus();
  await page.keyboard.press('Control+t');
  await editor.locator('form.editor-toolbar [data-transform-field=angle]').waitFor();
  await setBrushOption('旋转',30);
  await editor.getByRole('button',{name:'应用',exact:true}).click();
  const rotated=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>restyled.revision&&shapes(current)[0].rotation===30&&current;
  },'自由变换仍保留形状参数');
  assert.equal(shapes(rotated)[0].shape.width,rectangleLayer.shape.width);
  await until(()=>editor.getByRole('button',{name:'形状工具',exact:true}).isEnabled(),'自由变换已保存');
  await canvas.focus();
  await page.keyboard.press('Shift+u');
  await page.keyboard.down('Alt');
  await drag([.75,.68],[.87,.76]);
  await page.keyboard.up('Alt');
  const ellipseShape=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>rotated.revision&&shapes(current)[1]?.shape?.kind==='ellipse'&&current;
  },'从中心创建可编辑椭圆');
  assert.ok(Math.abs(shapes(ellipseShape)[1].x-.75)<.004&&Math.abs(shapes(ellipseShape)[1].y-.68)<.004);
  await page.screenshot({path:path.join(data,'shape-tools.png')});
  await page.reload();
  await canvas.waitFor();
  const reopenedShapes=await api(projectRoute);
  assert.equal(shapes(reopenedShapes)[0].rotation,30);
  console.log('PASS editable shape layers, rounded stroke, Shift square, Alt-centered ellipse, recolor, transform and reopen');

  const alphaDoc='alpha-document',alphaLayer='alpha-layer';
  await api(paintRoute+'/commands',{revision:reopenedShapes.revision,operations:[
    {op:'image',action:'create',documentId:alphaDoc,patch:{name:'透明度锁定验收'}},
    {op:'image',action:'addLayer',documentId:alphaDoc,layerId:alphaLayer,kind:'pixel',patch:{name:'半透明图层'}},
    {op:'image',action:'stroke',documentId:alphaDoc,layerId:alphaLayer,target:'pixels',
      stroke:{uv:true,rect:[.15,.2,.4,.8],opacity:.5,color:'#213a67',erase:false}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(alphaDoc,{force:true});
  await page.getByRole('button',{name:'半透明图层',exact:true}).click();
  const lockAlpha=page.getByRole('button',{name:'锁定透明像素',exact:true});
  await lockAlpha.click();
  const alphaState=current=>current.paint.imageDocuments[alphaDoc].layers[0];
  const lockedAlpha=await until(async()=>{
    const current=await api(projectRoute);
    return alphaState(current).alphaLocked&&current;
  },'启用像素透明度锁');
  await until(()=>lockAlpha.isEnabled(),'透明度锁保存完成');
  assert.equal(await eraserTool.isDisabled(),true);
  await editor.getByLabel('图像前景色',{exact:true}).fill('#ed522b');
  await canvas.focus();
  await page.keyboard.press('Alt+Backspace');
  const recoloredAlpha=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>lockedAlpha.revision&&alphaState(current).strokes.at(-1).preserveAlpha&&current;
  },'填充整层但保留每个像素的透明度');
  const alphaSamples=[xy(.25,.5),xy(.7,.5)];
  assert.deepEqual(rgba(await imagePng('locked-alpha.png',recoloredAlpha.revision,alphaDoc),alphaSamples)[1],
    [[237,82,43,128],[0,0,0,0]]);
  await lockAlpha.click();
  const unlockedAlpha=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>recoloredAlpha.revision&&alphaState(current).alphaLocked===false&&current;
  },'解除透明度锁');
  assert.deepEqual(rgba(await imagePng('unlocked-alpha.png',unlockedAlpha.revision,alphaDoc),alphaSamples)[1],
    [[237,82,43,128],[0,0,0,0]]);
  assert.equal(alphaState(unlockedAlpha).strokes.at(-1).preserveAlpha,true);
  console.log('PASS alpha lock UI, preserved translucent pixels, blocked eraser and historical lock after unlock');

  const importDoc='drawing-import';
  const importSeed=await api(paintRoute+'/commands',{revision:unlockedAlpha.revision,operations:[
    {op:'image',action:'create',documentId:importDoc,patch:{name:'图片导入验收'}}
  ]});
  const jpeg=path.join(data,'photo.jpg'),webp=path.join(data,'transparent.webp');
  execFileSync(pythonExecutable(),['-c',[
    'from PIL import Image','import sys',
    'photo=Image.new("RGB",(312,196),(56,111,174))','exif=photo.getexif();exif[274]=6',
    'photo.save(sys.argv[1],quality=99,exif=exif)',
    'Image.new("RGBA",(96,64),(204,109,43,143)).save(sys.argv[2],lossless=True)'
  ].join('\n'),jpeg,webp]);
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(importDoc,{force:true});
  const importButton=editor.getByRole('button',{name:'导入图片至画布',exact:true});
  const [fileChooser]=await Promise.all([page.waitForEvent('filechooser'),importButton.click()]);
  await fileChooser.setFiles(jpeg);
  const importedLayers=current=>current.paint.imageDocuments[importDoc].layers;
  const importedPhoto=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>importSeed.revision&&importedLayers(current).length===1&&current;
  },'用图片按钮导入 JPEG');
  const photoLayer=importedLayers(importedPhoto)[0],photoAsset=importedPhoto.paint.assets[photoLayer.asset];
  assert.deepEqual([photoAsset.width,photoAsset.height],[196,312]);
  assert.equal(photoLayer.scale,312/4096);
  assert.equal(photoLayer.name,'photo.png');
  await until(()=>importButton.isEnabled(),'JPEG 导入完成');
  const at=await point([.72,.32]),webpBytes=[...await fs.readFile(webp)];
  const transfer=await page.evaluateHandle(bytes=>{
    const data=new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)],'transparent.webp',{type:'image/webp'}));
    return data;
  },webpBytes);
  await canvas.dispatchEvent('drop',{dataTransfer:transfer,clientX:at[0],clientY:at[1]});
  await transfer.dispose();
  const importedWebp=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>importedPhoto.revision&&importedLayers(current).length===2&&current;
  },'拖入保留透明度的 WebP');
  const webpLayer=importedLayers(importedWebp)[1],webpAsset=importedWebp.paint.assets[webpLayer.asset];
  assert.deepEqual([webpAsset.width,webpAsset.height],[96,64]);
  assert.equal(webpLayer.scale,96/4096);
  assert.ok(Math.abs(webpLayer.x-.72)<.005&&Math.abs(webpLayer.y-.32)<.005);
  const [,inputPixels]=rgba(await imagePng('imported-images.png',importedWebp.revision,importDoc),
    [xy(.5,.5),xy(webpLayer.x,webpLayer.y)]);
  assert.ok(inputPixels[0].slice(0,3).every((channel,i)=>Math.abs(channel-[56,111,174][i])<=2));
  assert.equal(inputPixels[0][3],255);
  assert.ok(inputPixels[1].slice(0,3).every((channel,i)=>Math.abs(channel-[204,109,43][i])<=1));
  assert.equal(inputPixels[1][3],143);
  await page.reload();
  await canvas.waitFor();
  const reopenedImport=await api(projectRoute);
  assert.equal(importedLayers(reopenedImport).length,2);
  console.log('PASS JPEG chooser and EXIF orientation, WebP drag and drop, original pixel size and preserved alpha');

  const polyDoc='polygon-selection',polyLayer='polygon-pixels';
  const polySeed=await api(paintRoute+'/commands',{revision:reopenedImport.revision,operations:[
    {op:'image',action:'create',documentId:polyDoc,patch:{name:'多边形套索验收'}},
    {op:'image',action:'addLayer',documentId:polyDoc,layerId:polyLayer,kind:'pixel',patch:{name:'多边形底稿'}},
    {op:'image',action:'stroke',documentId:polyDoc,layerId:polyLayer,target:'pixels',
      stroke:{uv:true,rect:[0,0,1,1],opacity:1,color:'#558ab8',erase:false}}
  ]});
  await page.reload();
  await canvas.waitFor();
  await editor.locator('select[aria-label="图像文档"]').selectOption(polyDoc,{force:true});
  await page.getByRole('button',{name:'多边形底稿',exact:true}).click();
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await editor.getByRole('button',{name:'套索',exact:true}).click();
  await canvas.focus();
  await page.keyboard.press('Shift+l');
  const polyTool=editor.getByRole('button',{name:'多边形套索',exact:true});
  assert.equal(await polyTool.getAttribute('aria-pressed'),'true');
  await setBrushOption('选区羽化',0);
  await editor.getByRole('button',{name:'新建选区',exact:true}).click();
  await page.mouse.click(...await point([.2,.2]));
  await page.keyboard.down('Shift');
  await page.mouse.click(...await point([.7,.21]));
  await page.keyboard.up('Shift');
  await page.mouse.click(...await point([.25,.7]));
  await page.mouse.click(...await point([.75,.78]));
  await page.keyboard.press('Backspace');
  assert.equal(await overlay.getAttribute('data-tracing'),'');
  assert.match(await editor.locator('.document-tool-parameters output').first().textContent(),/3 个顶点/);
  await page.screenshot({path:path.join(data,'polygon-tracing.png')});
  await page.keyboard.press('Enter');
  assert.equal(await overlay.getAttribute('data-tracing'),null);
  const originalPolygon=await shape.getAttribute('d');
  assert.ok(originalPolygon.endsWith('Z'));
  await page.mouse.click(...await point([.6,.6]));
  await page.mouse.click(...await point([.75,.62]));
  await page.keyboard.press('Escape');
  assert.equal(await shape.getAttribute('d'),originalPolygon);
  await page.keyboard.press('Delete');
  const polygonClear=await until(async()=>{
    const current=await api(projectRoute);
    return current.revision>polySeed.revision&&current;
  },'清除逐点勾选的三角形');
  const polygonStroke=polygonClear.paint.imageDocuments[polyDoc].layers[0].strokes.at(-1);
  assert.equal(polygonStroke.polygon.length,3);
  assert.ok(Math.abs(polygonStroke.polygon[1][1]-polygonStroke.polygon[0][1])<.00001);
  assert.deepEqual(rgba(await imagePng('polygon-lasso.png',polygonClear.revision,polyDoc),
    [xy(.31,.31),xy(.6,.6),xy(.1,.1)])[1].map(pixel=>pixel[3]),[0,255,255]);
  console.log('PASS Polygonal Lasso, Shift snapping, vertex deletion, Enter closure, Esc restore and exact 4K triangle');

  assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('history')),true);
  const historyDialog=page.getByRole('dialog',{name:'历史记录',exact:true});
  const historyEntry=historyDialog.getByRole('button',{name:'撤销 1 步：清除选区',exact:true});
  await historyEntry.waitFor();
  assert.match(await historyEntry.textContent(),/多边形套索验收 · 多边形底稿/);
  await historyDialog.getByRole('button',{name:'关闭历史记录',exact:true}).click();
  await page.setViewportSize({width:960,height:600});
  await brushTool.click();
  const railBounds=await editor.locator('.document-tools').boundingBox();
  const foregroundBounds=await editor.getByLabel('图像前景色',{exact:true}).boundingBox();
  assert.ok(foregroundBounds.y>=railBounds.y&&foregroundBounds.y+foregroundBounds.height<=railBounds.y+railBounds.height);
  const layersPanel=page.locator('.editor-area[data-editor=imageLayers]').first();
  const alphaBounds=await layersPanel.getByRole('button',{name:'锁定透明像素',exact:true}).boundingBox();
  const opacityBounds=await layersPanel.locator('input.workspace-number-input[aria-label="不透明度"]').boundingBox();
  assert.ok(Math.abs(alphaBounds.y+alphaBounds.height/2-opacityBounds.y-opacityBounds.height/2)<6);
  const opacityReadout=layersPanel.locator('.document-layer-controls .workspace-range-value');
  assert.equal(await opacityReadout.textContent(),'100%');
  assert.equal(await opacityReadout.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  const parameters=editor.locator('.document-tool-parameters');
  await parameters.waitFor();
  const brushParams=editor.getByRole('button',{name:'笔尖参数',exact:true});
  if(!await brushParams.isVisible())await page.setViewportSize({width:820,height:600});
  await brushParams.click();
  const brushPopup=editor.getByRole('dialog',{name:'笔尖参数',exact:true});
  await brushPopup.waitFor();
  await brushPopup.getByRole('checkbox',{name:'压感',exact:true}).waitFor();
  assert.equal(await brushPopup.locator('[data-brush-setting="brush-flow"]').count(),1);
  await page.screenshot({path:path.join(data,'compact-brush-options.png')});
  await page.keyboard.press('Escape');
  await brushPopup.waitFor({state:'hidden'});
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  const nextParameters=editor.getByRole('button',{name:'下一组工具参数',exact:true});
  const previousParameters=editor.getByRole('button',{name:'上一组工具参数',exact:true});
  if(!await nextParameters.isVisible())await page.setViewportSize({width:820,height:600});
  await nextParameters.waitFor();
  await nextParameters.click();
  await editor.locator('.document-tool-parameters[data-scroll-start]').waitFor();
  await page.screenshot({path:path.join(data,'compact-drawing-tools.png')});
  await previousParameters.click();
  await editor.locator('.document-tool-parameters[data-scroll-start]').waitFor({state:'hidden'});
  await brushTool.click();
  const radiusBeforeTip=Number(await option('像素半径').inputValue());
  const hardnessBeforeTip=Number(await option('硬度').inputValue());
  const [tipX,tipY]=await point([.47,.53]);
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.mouse.move(tipX,tipY);
  await page.mouse.down();
  await page.mouse.move(tipX+43,tipY+44,{steps:4});
  const tipReadout=editor.locator('.document-brush-tip-readout');
  await tipReadout.waitFor();
  assert.ok(Number(await option('像素半径').inputValue())>radiusBeforeTip);
  assert.ok(Number(await option('硬度').inputValue())<hardnessBeforeTip);
  await page.screenshot({path:path.join(data,'brush-tip-adjustment.png')});
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await tipReadout.waitFor({state:'hidden'});
  assert.equal(Number(await option('像素半径').inputValue()),radiusBeforeTip);
  assert.equal(Number(await option('硬度').inputValue()),hardnessBeforeTip);
  await page.keyboard.down('Alt');
  await page.mouse.move(tipX,tipY);
  await page.mouse.down({button:'right'});
  await page.mouse.move(tipX+25,tipY,{steps:3});
  await page.mouse.up({button:'right'});
  await page.keyboard.up('Alt');
  assert.ok(Number(await option('像素半径').inputValue())>radiusBeforeTip);
  assert.equal((await api(projectRoute)).revision,polygonClear.revision);
  await layersPanel.getByRole('button',{name:'多边形底稿',exact:true}).press('F2');
  const rename=layersPanel.getByRole('textbox',{name:'图像图层名称',exact:true});
  await rename.fill('飞机涂装');
  const ime=await rename.evaluate(input=>{
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    const save=window.arachneNativeHost.command('save');
    const quit=window.arachneNativeHost.prepareToClose().state;
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    for(const key of ['Escape','Enter']){
      const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
      Object.defineProperty(event,'keyCode',{value:229});
      input.dispatchEvent(event);
    }
    return {save,quit,focused:input===document.activeElement};
  });
  assert.deepEqual(ime,{save:false,quit:'editing',focused:true});
  assert.equal((await api(projectRoute)).revision,polygonClear.revision);
  await rename.press('Enter');
  await layersPanel.getByRole('button',{name:'飞机涂装',exact:true}).waitFor();
  assert.equal((await api(projectRoute)).revision,polygonClear.revision+1);
  assert.deepEqual(pageErrors,[]);
  console.log('PASS drawing history, native-menu undo, compact tool rail, brush tip HUD and Escape rollback');
  console.log('PASS Chinese layer rename after IME confirmation and native save/quit guard during composition');

  await page.setViewportSize({width:1400,height:900});
  const groupDoc='drawing-groups',leftLayer='group-left',rightLayer='group-right';
  await api(paintRoute+'/commands',{revision:polygonClear.revision+1,operations:[
    {op:'image',action:'create',documentId:groupDoc,patch:{name:'图层组验收'}},
    ...[[leftLayer,'左侧填色','#225ebb',[0,0,.5,1]],[rightLayer,'右侧填色','#c0692b',[.5,0,1,1]]].flatMap(([layerId,name,color,rect])=>[
      {op:'image',action:'addLayer',documentId:groupDoc,layerId,kind:'pixel',patch:{name}},
      {op:'image',action:'stroke',documentId:groupDoc,layerId,target:'pixels',stroke:{uv:true,rect,color,opacity:1,erase:false}}
    ])
  ]});
  await editor.locator('select[aria-label="图像文档"]').selectOption(groupDoc,{force:true});
  const groupLayers=async()=>Object.fromEntries((await api(projectRoute)).paint.imageDocuments[groupDoc].layers.map(layer=>[layer.id,layer]));
  const leftButton=layersPanel.getByRole('button',{name:'左侧填色',exact:true}),rightButton=layersPanel.getByRole('button',{name:'右侧填色',exact:true});
  await leftButton.click();await rightButton.click({modifiers:['Shift']});
  assert.equal(await layersPanel.locator('.document-layer-row[data-selected]').count(),2);
  await rightButton.press('Control+g');
  const parent=await until(async()=>Object.values(await groupLayers()).find(layer=>layer.kind==='group'),'创建图层组');
  assert.equal(parent.blend,'passThrough');
  const row=id=>layersPanel.locator('[data-image-layer-id="'+id+'"]');
  await row(parent.id).getByRole('button',{name:'图层组',exact:true}).waitFor();
  assert.deepEqual(Object.values(await groupLayers()).filter(layer=>layer.parentId===parent.id).map(layer=>layer.id),[leftLayer,rightLayer]);
  await row(parent.id).getByRole('button',{name:'收起 图层组',exact:true}).click();
  await leftButton.waitFor({state:'hidden'});
  await row(parent.id).getByRole('button',{name:'展开 图层组',exact:true}).click();
  await leftButton.waitFor();
  await row(parent.id).getByRole('button',{name:'图层组',exact:true}).click();
  await layersPanel.getByRole('button',{name:'新建图层组',exact:true}).click();
  const nested=await until(async()=>Object.values(await groupLayers()).find(layer=>layer.kind==='group'&&layer.parentId===parent.id),'创建子组');
  await until(async()=>await rightButton.getAttribute('draggable')==='true','新组保存完成，图层重新可拖动');
  await rightButton.dragTo(row(nested.id));
  await until(async()=>(await groupLayers())[rightLayer].parentId===nested.id,'拖入子组');
  await row(parent.id).getByRole('button',{name:'图层组',exact:true}).click();
  const groupOpacity=layersPanel.locator('input.workspace-number-input[aria-label="不透明度"]');
  await groupOpacity.fill('50');await groupOpacity.press('Tab');
  await until(async()=>(await groupLayers())[parent.id].opacity===.5,'图层组不透明度');
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await drag([.06,.08],[.48,.92]);
  await layersPanel.getByRole('button',{name:'添加蒙版',exact:true}).click();
  await row(parent.id).getByRole('button',{name:'选择蒙版 图层组',exact:true}).waitFor();
  const masked=await until(async()=>{
    const current=await api(projectRoute);
    return current.paint.imageDocuments[groupDoc].layers.find(layer=>layer.id===parent.id).maskEnabled&&current;
  },'组蒙版保存');
  assert.deepEqual(rgba(await imagePng('drawing-groups.png',masked.revision,groupDoc),[xy(.25,.5),xy(.75,.5)]),[
    [4096,4096],[[34,94,187,128],[0,0,0,0]]
  ]);
  await editor.locator('.document-image-stage[data-preview-size="4096"]').waitFor({timeout:45000});
  await page.screenshot({path:path.join(data,'drawing-groups-workbench.png')});
  await page.reload();await canvas.waitFor();
  await row(parent.id).waitFor();
  const reopenedGroup=(await groupLayers())[parent.id];
  assert.equal(reopenedGroup.opacity,.5);assert.equal(reopenedGroup.maskEnabled,true);
  const undoneGroup=await api(paintRoute+'/undo',{revision:masked.revision});
  assert.equal(undoneGroup.paint.imageDocuments[groupDoc].layers.find(layer=>layer.id===parent.id).maskEnabled,false);
  const redoneGroup=await api(paintRoute+'/redo',{revision:undoneGroup.revision});
  assert.deepEqual(redoneGroup.paint.imageDocuments[groupDoc].layers,masked.paint.imageDocuments[groupDoc].layers);
  assert.deepEqual(pageErrors,[]);
  console.log('PASS drawing group multiselect, nested drag, collapse, 4K alpha mask, reopen and undo/redo');

  const cutDoc='cut-source',cutLayer='cut-pixels',cutDestination='cut-destination';
  const cutSeed=await api(paintRoute+'/commands',{revision:redoneGroup.revision,operations:[
    {op:'image',action:'create',documentId:cutDoc,patch:{name:'剪切来源'}},
    {op:'image',action:'create',documentId:cutDestination,patch:{name:'原位粘贴目标'}},
    {op:'image',action:'addLayer',documentId:cutDoc,layerId:cutLayer,kind:'pixel',patch:{name:'带蒙版的像素层',opacity:.3}},
    {op:'image',action:'stroke',documentId:cutDoc,layerId:cutLayer,target:'pixels',stroke:{uv:true,rect:[0,0,1,1],color:'#35a4db',opacity:1,erase:false}},
    {op:'image',action:'createMask',documentId:cutDoc,layerId:cutLayer,reveal:true,rect:[0,0,.5,1]}
  ]});
  const imagePicker=editor.locator('select[aria-label="图像文档"]');
  async function cutRegion(){
    await imagePicker.selectOption(cutDoc,{force:true});
    await layersPanel.getByRole('button',{name:'带蒙版的像素层',exact:true}).click();
    await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
    await editor.getByRole('button',{name:'适应画布',exact:true}).click();
    await setBrushOption('选区羽化',0);
    await editor.getByRole('button',{name:'新建选区',exact:true}).click();
    await drag([.58,.2],[.8,.6]);
  }
  await cutRegion();
  const clipboardRoute='**/paint/image-clipboard';
  await page.route(clipboardRoute,async route=>{
    const response=await route.fetch();
    assert.equal(response.status(),200);
    await api(paintRoute+'/commands',{revision:cutSeed.revision,operations:[
      {op:'image',action:'update',documentId:cutDoc,patch:{name:'另一个客户端修改了文档'}}
    ]});
    await route.fulfill({response});
  },{times:1});
  await canvas.focus();
  assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('cut')),true);
  await until(async()=>{
    const doc=await api(projectRoute);
    return doc.revision===cutSeed.revision+1&&await page.evaluate(()=>window.arachneNativeHost.prepareToClose().state!=='editing');
  },'剪切遇到并发修订');
  const concurrent=await api(projectRoute);
  assert.deepEqual(concurrent.paint.imageDocuments[cutDoc].layers,cutSeed.paint.imageDocuments[cutDoc].layers);
  await page.reload();await canvas.waitFor();
  await cutRegion();
  await page.locator('summary').filter({hasText:/^编辑$/}).click();
  await page.locator('#cut-image-selection').click();
  const cut=await until(async()=>{
    const doc=await api(projectRoute);
    return doc.paint.imageDocuments[cutDoc].layers[0].strokes.at(-1).cut&&doc;
  },'剪切选区保存');
  const source=cut.paint.imageDocuments[cutDoc].layers[0];
  assert.deepEqual(source.maskStrokes,cutSeed.paint.imageDocuments[cutDoc].layers[0].maskStrokes);
  assert.equal(cut.revision,concurrent.revision+1);
  await imagePicker.selectOption(cutDestination,{force:true});
  await canvas.focus();
  assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('pasteInPlace')),true);
  const pasted=await until(async()=>{
    const doc=await api(projectRoute);
    return doc.paint.imageDocuments[cutDestination].layers.length&&doc;
  },'原位粘贴到另一文档');
  const pastedLayer=pasted.paint.imageDocuments[cutDestination].layers[0];
  assert.ok(Math.abs(pastedLayer.x-.69)<.005&&Math.abs(pastedLayer.y-.4)<.005);
  assert.deepEqual(rgba(await imagePng('cut-paste.png',pasted.revision,cutDestination),[xy(.65,.35),xy(.5,.35)]),[
    [4096,4096],[[53,164,219,255],[0,0,0,0]]
  ]);
  const undoPaste=await api(paintRoute+'/undo',{revision:pasted.revision});
  const undoCut=await api(paintRoute+'/undo',{revision:undoPaste.revision});
  assert.deepEqual(undoCut.paint.imageDocuments[cutDoc].layers,cutSeed.paint.imageDocuments[cutDoc].layers);
  assert.deepEqual(pageErrors,[]);
  console.log('PASS selection cut, revision conflict safety, hidden source pixels, native command and cross-document paste in place');

  const desktopPage=await browser.newPage();
  await desktopPage.addInitScript(()=>{window.arachneDesktop={notifyProject(){}};});
  await desktopPage.goto(origin+'/?project='+project.id);
  const layoutRoute='/api/desktop-layout';
  const baseline=await until(async()=>{
    const result=await api(layoutRoute);
    return result.layout&&result;
  },'桌面初始布局');
  const nextArea=baseline.layout.activeWorkspace==='drawing'?'modeling':'drawing';
  const dropLayoutResponse=async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    const response=await route.fetch();
    assert.equal(response.status(),200);
    await route.abort('failed');
  };
  await desktopPage.route('**'+layoutRoute,dropLayoutResponse);
  await desktopPage.locator('[data-area-mode='+nextArea+']').click();
  const retryLayout=desktopPage.getByRole('button',{name:'重试保存布局',exact:true});
  await retryLayout.waitFor();
  assert.equal(await desktopPage.evaluate(async()=> (await window.arachneNativeHost.prepareToCloseAsync()).state),'unsaved');
  const published=await api(layoutRoute);
  assert.equal(published.layout.activeWorkspace,nextArea);
  assert.equal(published.revision,baseline.revision+1);
  await desktopPage.unroute('**'+layoutRoute,dropLayoutResponse);
  await retryLayout.click();
  await retryLayout.waitFor({state:'hidden'});
  await until(async()=>await desktopPage.evaluate(async()=> (await window.arachneNativeHost.prepareToCloseAsync()).state==='ready'),'布局恢复后允许退出');
  assert.equal((await api(layoutRoute)).revision,published.revision);
  await desktopPage.close();
  console.log('PASS desktop layout lost response blocks quit; retry confirms server revision without another write');
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
