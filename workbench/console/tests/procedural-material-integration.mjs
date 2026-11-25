import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {defaultMaterialGraph,makeNode} from '../public/material-graph.mjs';
import {pythonExecutable} from '../python-runtime.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-procedural-'));
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const port=socket.address().port,base='http://127.0.0.1:'+port;
await new Promise(resolve=>socket.close(resolve));
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:new URL('..',import.meta.url),stdio:'inherit',
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',PYTHONDONTWRITEBYTECODE:'1'}});
let browser;
const headers={Origin:base,'Content-Type':'application/json'};
async function until(read,label){
  for(let i=0;i<320;i++){const result=await read();if(result)return result;await delay(100);}
  throw Error('等待超时：'+label);
}
async function api(route,body,status=200){
  const response=await fetch(base+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
  const result=await response.json();
  assert.equal(response.status,status,JSON.stringify(result).slice(0,500));
  return result;
}
try{
  await until(()=>fetch(base+'/api/health').then(r=>r.ok,()=>false),'工作台启动');
  const project=await api('/api/projects',{workflowType:'pbr_paint',name:'渐变材质试板',modelTemplate:'plane'},201);
  const route='/api/projects/'+project.id,paint=route+'/paint';
  const graph=defaultMaterialGraph();
  graph.nodes.push(makeNode('ramp',100,310,'ramp'));
  graph.links=graph.links.filter(link=>link.to.port!=='color');
  graph.links.push({from:{node:'ramp',port:'color'},to:{node:'pbr',port:'color'}});
  await api(paint+'/commands',{revision:project.revision,operations:[{op:'shader',graph}]});
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/paint.html?project='+project.id);
  await page.locator('[data-area-mode=modeling]').click();
  const shader=page.locator('.editor-area[data-editor=shader]').first();
  const stage=shader.locator('.shader-stage');
  await stage.focus();await page.keyboard.press('Home');
  const ramp=shader.locator('[data-node=ramp]'),add=ramp.getByRole('button',{name:'添加色标'});
  const getStops=async()=>((await api(route)).paint.materialGraph.nodes.find(n=>n.id==='ramp').params.stops??[]);
  async function changed(action,endpoint='commands'){
    const response=page.waitForResponse(r=>r.url().endsWith('/paint/'+endpoint)&&r.request().method()==='POST');
    await action();assert.ok((await response).ok());
    await until(()=>add.isEnabled(),'节点恢复编辑');
  }
  await changed(()=>add.click());
  assert.deepEqual(await getStops(),[{position:.5,color:'#bcbcbc'}]);
  await changed(()=>ramp.getByLabel('色标 1 颜色').fill('#c63018'));
  await changed(()=>add.click());
  await changed(()=>ramp.getByLabel('色标 1 位置（%）').fill('80').then(()=>ramp.getByLabel('色标 1 位置（%）').press('Enter')));
  const arranged=await getStops();
  assert.deepEqual(arranged.map(s=>s.position),[.5,.8]);
  assert.equal(arranged[0].color,'#c63018');
  await changed(()=>ramp.getByRole('button',{name:'移除色标 2'}).click());
  async function editMenu(id){
    await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();
    await page.locator('#'+id).click();
  }
  await changed(()=>editMenu('undo'),'undo');assert.deepEqual(await getStops(),arranged);
  await changed(()=>editMenu('redo'),'redo');assert.deepEqual(await getStops(),arranged.slice(0,1));
  await page.reload();
  await ramp.getByLabel('色标 1 颜色').waitFor();
  assert.equal(await ramp.getByLabel('色标 1 颜色').inputValue(),'#c63018');
  await stage.focus();await page.keyboard.press('Control+Space');
  await stage.focus();await page.keyboard.press('Home');
  await ramp.locator('.shader-node-title').click();
  await shader.getByRole('button',{name:'聚焦所选节点'}).click();
  await ramp.screenshot({path:path.join(data,'渐变节点.png')});
  const doc=await api(route);
  const job=await api(paint+'/preview',{revision:doc.revision,requestId:'ramp-bake'},202);
  const baked=await until(async()=>{
    const result=await api(route+'/jobs/'+job.id);
    if(result.status==='failed')throw Error(result.error);
    return result.status==='completed'&&result;
  },'渐变烘焙');
  const file=path.join(data,'色标-4K.png');
  await fs.writeFile(file,Buffer.from(await (await fetch(base+baked.colorUrl)).arrayBuffer()));
  execFileSync(pythonExecutable(),['-c',`from PIL import Image
import sys
with Image.open(sys.argv[1]) as im:
    assert im.size==(4096,4096)
    assert im.getpixel((2048,2048))==(198,48,24), im.getpixel((2048,2048))
`,file]);
  await shader.getByRole('button',{name:'添加材质节点'}).click();
  await changed(()=>page.getByRole('option',{name:'噪声纹理',exact:true}).click());
  const noise=shader.locator('[data-type=noise].shader-node');
  await stage.focus();await page.keyboard.press('Home');
  async function wire(target,port){
    const from=await noise.locator('[data-direction=out][data-port=value]').boundingBox();
    const to=await target.locator('[data-direction=in][data-port='+port+']').boundingBox();
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
    await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:8});await page.mouse.up();
  }
  await changed(()=>wire(ramp,'value'));
  await changed(()=>wire(shader.locator('[data-node=pbr]'),'roughness'));
  async function preview(file){
    const current=await api(route);
    const response=await fetch(base+paint+'/live',{method:'POST',headers,body:JSON.stringify({revision:current.revision,resolution:256,format:'pbr8'})});
    assert.equal(response.status,200);
    const raw=Buffer.from(await response.arrayBuffer());assert.equal(raw.length,256*256*15);
    await fs.writeFile(path.join(data,file),raw);
    return current;
  }
  await preview('scale-5.raw');
  const scale=noise.getByLabel('噪声纹理 缩放');
  await changed(async()=>{await scale.fill('11');await scale.press('Enter');});
  const scaled=await preview('scale-11.raw');
  await changed(()=>editMenu('undo'),'undo');assert.equal(await scale.inputValue(),'5');
  await changed(()=>editMenu('redo'),'redo');
  await page.reload();assert.equal(await scale.inputValue(),'11');
  const reopened=await api(route);
  assert.deepEqual(reopened.paint.materialGraph,scaled.paint.materialGraph);
  const noiseJob=await api(paint+'/preview',{revision:reopened.revision,requestId:'noise-bake'},202);
  const noiseBake=await until(async()=>{
    const j=await api(route+'/jobs/'+noiseJob.id);
    if(j.status==='failed')throw Error(j.error);return j.status==='completed'&&j;
  },'噪声 4K 烘焙');
  for(const [key,url] of [['color',noiseBake.colorUrl],['roughness',noiseBake.materialUrls.roughness]]){
    const response=await fetch(base+url);assert.ok(response.ok);
    await fs.writeFile(path.join(data,key+'.png'),Buffer.from(await response.arrayBuffer()));
  }
  execFileSync(pythonExecutable(),['-c',`import sys
import numpy as np
from pathlib import Path
from PIL import Image
root=Path(sys.argv[1])
load=lambda name: np.fromfile(root/name,dtype=np.uint8).reshape(256,256,15)
old,new=load('scale-5.raw'),load('scale-11.raw')
color=np.asarray(Image.open(root/'color.png')).astype(int)
rough=np.asarray(Image.open(root/'roughness.png')).astype(int)
assert color.shape==(4096,4096,3) and rough.shape==(4096,4096)
assert np.mean(abs(old[:,:,4].astype(int)-new[:,:,4]))>5
assert np.mean(abs(old[:,:,:3].astype(int)-new[:,:,:3]))>5
# Baked centers are within half of a 4K texel of each live sample.
delta=abs(color[8::16,8::16]-new[:,:,:3])
assert np.percentile(delta,99)<4, np.percentile(delta,[50,99,100])
dr=abs(rough[8::16,8::16]-new[:,:,4])
assert dr.max()<=2,(dr.mean(),dr.max())
`,data]);
  console.log('PASS 单个噪声分支驱动渐变颜色和粗糙度，修改尺度、撤销重做、重开及同 UV 的实时与 4K 像素。');
  assert.deepEqual(errors,[]);
  console.log('PASS 添加、调色、移动并重排色标，移除、撤销、重做和重开。4K 烘焙中心为 (198,48,24)。');
}finally{
  await browser?.close();server.kill('SIGTERM');
}
