import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-workspaces-'));
const evidence=process.env.ARACHNE_WORKSPACE_SCREENSHOTS||data;
await fs.mkdir(evidence,{recursive:true});
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const {port}=socket.address();
await new Promise(resolve=>socket.close(resolve));
const origin='http://127.0.0.1:'+port,headers={Origin:origin,'Content-Type':'application/json'};
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:new URL('..',import.meta.url),windowsHide:true,
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:path.join(data,'no-blender')}});
let browser,logs='';
for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-8000);});
async function until(read,label,timeout=25000){
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
  const project=await api('/api/projects',{workflowType:'pbr_paint',modelTemplate:'cube',name:'高分辨率工业外壳与防护涂层测试工程'});
  const route='/api/projects/'+project.id,paint=route+'/paint',documentId='detail-color',layerId='stripe';
  await api(paint+'/commands',{revision:project.revision,operations:[
    {op:'add',kind:'fill',patch:{name:'深海蓝 · 抗氧化半哑光金属底漆',values:{color:'#26415f',metallic:.64,roughness:.38}}},
    {op:'image',action:'create',documentId,patch:{name:'外壳颜色贴图 · 主涂装工作样张'}},
    {op:'image',action:'addLayer',documentId,layerId,kind:'pixel',patch:{name:'橙色标记条纹与细节修正图层'}},
    {op:'image',action:'stroke',documentId,layerId,target:'pixels',stroke:{uv:true,rect:[.2,.45,.8,.55],color:'#dda14d',opacity:1,erase:false}}
  ]});
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:940},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/?project='+project.id);
  await page.evaluate(()=>document.fonts.ready);
  const viewport=page.locator('.editor-viewport[data-state=ready]').first();
  const canvas=page.getByLabel('图像文档画布',{exact:true}).first();
  async function show(workspace){
    await page.locator('[data-area-mode='+workspace+']').click();
    if(workspace==='drawing'){
      await canvas.waitFor();
      await page.getByRole('button',{name:'画笔',exact:true}).first().click();
      await page.locator('.document-image-stage[data-preview-size="4096"]').first().waitFor({timeout:30000});
    }else await viewport.waitFor();
  }
  for(const [size,dimensions] of [['wide',{width:1440,height:940}],['narrow',{width:900,height:630}]]){
    await page.setViewportSize(dimensions);
    for(const workspace of ['modeling','material','drawing']){
      await show(workspace);
      const widths=await page.evaluate(()=>({document:document.documentElement.scrollWidth,window:innerWidth}));
      assert.ok(widths.document<=widths.window);
      await page.screenshot({path:path.join(evidence,workspace+'-'+size+'.png')});
    }
  }

  await page.setViewportSize({width:1200,height:800});
  await show('modeling');
  const cdp=await page.context().newCDPSession(page);
  const readBuffer=()=>viewport.evaluate(host=>{
    const canvas=host.querySelector('canvas');
    return {ratio:Number(host.dataset.pixelRatio),width:canvas.width,height:canvas.height,cssWidth:host.clientWidth,cssHeight:host.clientHeight};
  });
  const first=await readBuffer();
  assert.deepEqual([first.ratio,first.width,first.height],[1,first.cssWidth,first.cssHeight]);
  for(const ratio of [1.25,2,1]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:ratio,mobile:false});
    const next=await until(async()=>{const frame=await readBuffer();return frame.ratio===ratio&&frame;},'viewport scale '+ratio);
    assert.deepEqual([next.cssWidth,next.cssHeight],[first.cssWidth,first.cssHeight]);
    assert.deepEqual([next.width,next.height],[Math.floor(first.cssWidth*ratio),Math.floor(first.cssHeight*ratio)]);
  }
  await cdp.detach();
  const split=page.getByRole('separator',{name:'调整区域高度',exact:true}).first();
  const ratio=()=>split.getAttribute('aria-valuenow');
  const defaultRatio=await ratio();
  await split.focus();await split.press('ArrowUp');
  const customRatio=await ratio();assert.notEqual(customRatio,defaultRatio);
  await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync());
  await page.reload();await viewport.waitFor();
  assert.equal(await ratio(),customRatio,'Reload retains the user-resized layout');
  await page.evaluate(()=>{
    const write=Storage.prototype.setItem;
    window.restoreLayoutStorage=()=>{Storage.prototype.setItem=write;};
    Storage.prototype.setItem=function(key,value){
      if(key==='arachne-area-workspaces-v1')throw new DOMException('layout quota test','QuotaExceededError');
      return write.call(this,key,value);
    };
  });
  await split.focus();await split.press('ArrowUp');
  const pendingRatio=await ratio();assert.notEqual(pendingRatio,customRatio);
  const recovery=page.locator('.area-layout-save');
  await recovery.getByRole('alert').filter({hasText:'浏览器存储空间不足'}).waitFor();
  assert.equal(await page.locator('#project-save-state').textContent(),'保存失败');
  assert.equal((await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync())).state,'unsaved');
  assert.equal(await ratio(),pendingRatio);
  await page.evaluate(()=>window.restoreLayoutStorage());
  await recovery.getByRole('button',{name:'重试保存布局',exact:true}).click();
  await recovery.waitFor({state:'hidden'});
  assert.equal((await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync())).state,'ready');
  await page.reload();await viewport.waitFor();
  assert.equal(await ratio(),pendingRatio);
  assert.deepEqual(errors,[]);
  console.log('PASS all three workspaces at 1440 and 900 px; viewport reallocates its buffer at 125%, 200% and 100% without a CSS resize');
  console.log('PASS custom layout reload, browser quota error, quit protection and retry without losing the layout');
}catch(error){console.error(logs);throw error;}
finally{
  await browser?.close();
  if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
  console.log('Workspace verification images:',evidence);
}
