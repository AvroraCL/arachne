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
  async function imagePng(filename,revision){
    const response=await fetch(origin+paintRoute+'/image-export',{method:'POST',
      headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({revision,documentId})});
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

  await editor.getByRole('button',{name:'与选区相交',exact:true}).click();
  await drag([.12,.12],[.48,.55]);
  assert.equal((await shape.getAttribute('d')).match(/M/g).length,2);
  await canvas.focus();
  await page.keyboard.press('Control+Shift+i');
  assert.equal((await shape.getAttribute('d')).match(/M/g).length,3);
  assert.deepEqual(pageErrors,[]);
  console.log('PASS compound marquee, holes, intersect, inverse, reselect, 4K clipboard and clear across layers');
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
