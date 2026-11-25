import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {verifyPanelNormal} from './panel-normal-workflow.mjs';
import {verifyPanelProjection} from './panel-projection-workflow.mjs';
import {verifyPanelAnchors} from './panel-anchor-workflow.mjs';
import {pythonExecutable} from '../python-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..'),folder=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-mesh-panel-'));
const fixture=path.join(folder,'panel.glb'),python=pythonExecutable();
const panel=path.join(import.meta.dirname,'mesh-map-panel.py');
execFileSync(python,[panel,'create-seam',fixture]);
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const {port}=socket.address();
await new Promise(resolve=>socket.close(resolve));
const origin='http://127.0.0.1:'+port;
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:root,
  env:{...process.env,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_DATA_DIR:path.join(folder,'store')},stdio:['ignore','pipe','pipe']});
let logs='',browser;
for(const stream of [server.stdout,server.stderr])stream.on('data',bytes=>{logs+=bytes;});
async function api(url,body){
  const response=await fetch(origin+url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const json=await response.json();assert.ok(response.ok,JSON.stringify(json));return json;
}
try{
  for(let i=0;i<200;i++){if(await fetch(origin+'/api/health').then(r=>r.ok,()=>false))break;await delay(100);}
  const uploaded=await fetch(origin+'/api/projects/model-import?material=0&textures=blank',{method:'POST',
    headers:{'Content-Type':'model/gltf-binary'},body:await fs.readFile(fixture)});
  const project=await uploaded.json();assert.ok(uploaded.ok,JSON.stringify(project));
  const url='/api/projects/'+project.id,paint=url+'/paint';
  const doc=await api(paint+'/commands',{revision:project.revision,operations:[
    {op:'base',patch:{color:'#000000'}},{op:'add',kind:'fill',patch:{name:'面板漆',maskEnabled:true,maskBase:1,
      values:{color:'#ffffff',roughness:.6,metallic:0},channels:{color:true,roughness:false,metallic:false}}}]});
  const layer=doc.paint.layers[0];
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  page.on('pageerror',error=>console.error(error));
  await page.goto(origin+'/paint.html?project='+project.id);
  await verifyPanelNormal({page,api,url,paint,origin,folder,panel,python});
  const normalTrial=await api(url);await api(paint+'/undo',{revision:normalTrial.revision});await page.reload();
  await page.locator('[data-area-mode=material]').click();
  await page.getByRole('button',{name:'绘制蒙版 · 面板漆',exact:true}).click();
  await page.getByRole('button',{name:'网格贴图…'}).first().click();
  const dialog=page.locator('#mesh-map-dialog');
  async function choose(label,option){
    await dialog.getByRole('button',{name:label,exact:true}).click();
    await page.getByRole('option',{name:option,exact:true}).click();
  }
  await choose('烘焙分辨率','512');await choose('ID 来源','顶点色 COLOR_0');
  const baked=page.waitForResponse(r=>r.url().endsWith('/mesh-bake'),{timeout:180000});
  await dialog.locator('[data-bake]').click();
  const result=await baked,mapsResult=await result.json();
  assert.ok(result.ok(),JSON.stringify(mapsResult));
  const {maps}=mapsResult;
  for(const [key,id] of Object.entries(maps)){
    const response=await fetch(origin+paint+'/assets/'+id);
    assert.ok(response.ok);await fs.writeFile(path.join(folder,key+'.png'),Buffer.from(await response.arrayBuffer()));
  }
  console.log(execFileSync(python,[panel,'check',folder],{encoding:'utf8'}).trim());
  await dialog.getByText('三张贴图已保存到当前工程').waitFor();
  await choose('提取范围','分色 · 颜色 ID');
  assert.equal(await dialog.getByRole('button',{name:'来源贴图'}).innerText(),'顶点色 ID.png');
  const preview=dialog.locator('img');
  await page.waitForFunction(()=>{const im=document.querySelector('#mesh-map-dialog img');return im.complete&&im.naturalWidth===512;});
  const rect=await preview.boundingBox();
  await preview.click({position:{x:rect.width*.25,y:rect.height*.5}});
  assert.equal(await dialog.locator('[name=pick]').inputValue(),'#dc2418');
  const applied=page.waitForResponse(r=>r.url().endsWith('/mesh-mask'));
  await dialog.locator('[type=submit]').click();
  const maskResult=await applied;assert.ok(maskResult.ok(),await maskResult.text());
  const before=await api(url);assert.ok(before.paint.layers[0].mask);
  const inspect=async rev=>{
    const r=await fetch(origin+paint+'/live',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({revision:rev,inspectMask:layer.id,resolution:256,format:'pbr8'})});
    assert.ok(r.ok,r.ok?'':await r.text());return Buffer.from(await r.arrayBuffer());
  };
  const sample=(bytes,x,y)=>bytes[(y*256+x)*15];
  const selected=await inspect(before.revision);
  assert.equal(sample(selected,65,128),255);assert.equal(sample(selected,195,128),0);
  const corrected=await api(paint+'/commands',{revision:before.revision,operations:[
    {op:'stroke',target:'mask',id:layer.id,stroke:{uv:true,rect:[.23,.46,.28,.54],value:0,opacity:1}}]});
  const hand=await inspect(corrected.revision);
  assert.equal(sample(hand,65,128),0);assert.equal(sample(hand,80,128),255);
  const undo=await api(paint+'/undo',{revision:corrected.revision});assert.deepEqual(await inspect(undo.revision),selected);
  const redo=await api(paint+'/redo',{revision:undo.revision});assert.deepEqual(await inspect(redo.revision),hand);
  await page.reload();assert.deepEqual((await api(url)).paint.layers,corrected.paint.layers);
  const job=await api(paint+'/preview',{revision:redo.revision,requestId:'mesh-map-corrected'});
  let finished;
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    const state=await api(url+'/jobs/'+job.id);if(state.status==='failed')throw Error(state.error);
    if(state.status==='completed'){finished=state;break;}await delay(200);
  }
  assert.ok(finished);assert.equal(finished.paintReport.uv_unchanged,true);
  assert.equal(finished.paintReport.protectedTexelsWritten,0);
  const file=path.join(folder,'painted.png'),texture=await fetch(origin+finished.colorUrl);
  assert.ok(texture.ok);await fs.writeFile(file,Buffer.from(await texture.arrayBuffer()));
  execFileSync(python,['-c',[
    'from PIL import Image;import sys','im=Image.open(sys.argv[1]);assert im.size==(4096,4096)',
    'for x,n in [(65,0),(80,255),(195,0)]: assert im.getpixel((x*16,2048))[:3]==(n,n,n)'
  ].join('\n'),file]);
  for(const [mode,key,x] of [['cavity','ao',61],['convex','curvature',102],['concave','curvature',128]]){
    const current=await api(url);
    const next=await api(paint+'/mesh-mask',{revision:current.revision,layerId:layer.id,image:maps[key],mode});
    const bytes=await inspect(next.revision);
    const v=sample(bytes,x,100);
    if(mode==='cavity')assert.ok(sample(bytes,55,128)>100);
    else assert.ok(v>30,mode+' '+v);
    assert.equal(sample(bytes,210,100),0);
    assert.equal((await api(url)).paint.layers[0].maskStrokes.length,1);
  }
  const last=await api(url);
  const locked=await api(paint+'/commands',{revision:last.revision,operations:[{op:'update',id:layer.id,patch:{locked:true}}]});
  const attempt=revision=>api(paint+'/mesh-mask',{revision,layerId:layer.id,image:maps.id,mode:'id',color:'#dc2418'});
  await assert.rejects(attempt(last.revision),/修订/);
  await assert.rejects(attempt(locked.revision),/锁定/);
  assert.equal((await api(url)).revision,locked.revision);
  for(const [idSource,resolution] of [['material',1024],['object',2048]]){
    const current=await api(url),bake=await api(paint+'/mesh-bake',{revision:current.revision,idSource,resolution});
    const response=await fetch(origin+paint+'/assets/'+bake.maps.id);
    const file=path.join(folder,idSource+'.png');
    await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));
    execFileSync(python,['-c',[
      'from PIL import Image; import sys','im=Image.open(sys.argv[1]); n=int(sys.argv[2]); assert im.size==(n,n)',
      'a,b=[im.getpixel((int(u*n),n//2)) for u in (.18,.82)]',
      'assert a[3]==b[3]==255 and (a==b)==(sys.argv[3]=="material")'
    ].join('\n'),file,String(resolution),idSource]);
  }
  const anchored=await verifyPanelAnchors({page,api,url,paint,origin});
  const anchoredPNG=await fetch(origin+anchored.colorUrl);
  assert.ok(anchoredPNG.ok);
  await fs.writeFile(path.join(folder,'anchor.png'),Buffer.from(await anchoredPNG.arrayBuffer()));
  await fs.writeFile(path.join(folder,'mask.raw'),anchored.mask);
  await fs.writeFile(path.join(folder,'material.raw'),anchored.material);
  execFileSync(python,['-c',[
    'import numpy as np,sys;from PIL import Image;from pathlib import Path','p=Path(sys.argv[1])',
    'im=np.array(Image.open(p/"anchor.png").convert("RGB"));assert im.shape==(4096,4096,3)',
    'mask=np.fromfile(p/"mask.raw",np.uint8).reshape(256,256,15)[:,:,0]',
    'live=np.fromfile(p/"material.raw",np.uint8).reshape(256,256,15)[:,:,:3]',
    // Registration takes the center subsample before rows are reversed for PNG.
    'baked=im[7::16,8::16]; solid=np.all(live==[0,255,0],axis=2); hits=mask>0',
    'assert solid.any() and np.array_equal(baked[solid],live[solid]), (solid.sum(),np.unique(baked[solid],axis=0)[:10])',
    'assert np.array_equal(baked[hits],live[hits]), (hits.sum(),np.max(np.abs(baked[hits].astype(int)-live[hits])))',
    'assert not np.any(np.all(baked[~hits]==[0,255,0],axis=1))'
  ].join('\n'),folder]);
  await verifyPanelProjection({page,api,url,paint,origin,folder,python});
  console.log('Browser bake, color pick, signed mesh masks, brush correction, exact undo/redo and reopen passed.');
}catch(error){console.error(folder,logs.slice(-2400));throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null&&server.signalCode===null)await once(server,'exit');
  await fs.rm(folder,{recursive:true,force:true});}
