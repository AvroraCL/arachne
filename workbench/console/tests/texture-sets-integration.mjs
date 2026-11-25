import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {pythonExecutable} from '../python-runtime.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-texture-sets-'));
const portProbe=net.createServer().listen(0,'127.0.0.1');
await once(portProbe,'listening');
const port=portProbe.address().port,origin='http://127.0.0.1:'+port;
await new Promise(resolve=>portProbe.close(resolve));
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:new URL('..',import.meta.url),stdio:'inherit',
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1'}});
let browser;
async function until(read,label){
  const end=Date.now()+120000;
  while(Date.now()<end){const value=await read();if(value)return value;await delay(125);}
  throw Error('等待超时 '+label);
}
async function json(route,body){
  const r=await fetch(origin+route,body?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const obj=await r.json();assert.ok(r.ok,JSON.stringify(obj));return obj;
}
// The two panels deliberately occupy identical UVs and have separate material slots.
function panels(){
  const arrays=[new Float32Array([-.47,-.5,0,.47,-.5,0,.47,.5,0,-.47,.5,0]),
    new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),new Float32Array([0,1,1,1,1,0,0,0]),new Uint16Array([0,1,2,0,2,3])];
  const left=arrays[0],right=left.slice();
  for(let i=0;i<left.length;i+=3){left[i]-=.5;right[i]+=.5;}
  arrays.push(right);
  const bytes=Buffer.concat(arrays.map(a=>Buffer.from(a.buffer)));let offset=0;
  const gltf={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],
    nodes:[{name:'Twin panels',mesh:0}],
    meshes:[{primitives:[0,1].map(material=>({attributes:{POSITION:material?4:0,NORMAL:1,TEXCOORD_0:2},indices:3,material}))}],
    materials:['Shell','Latch'].map(name=>({name,doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.24,.24,.24,1],roughnessFactor:.65,metallicFactor:0}})),
    buffers:[{uri:'panels.bin',byteLength:bytes.length}],bufferViews:arrays.map(a=>{const view={buffer:0,byteOffset:offset,byteLength:a.byteLength};offset+=a.byteLength;return view;}),
    accessors:arrays.map((a,i)=>({bufferView:i,componentType:i===3?5123:5126,count:i===3?6:4,type:['VEC3','VEC3','VEC2','SCALAR','VEC3'][i],...([0,4].includes(i)?{min:[a[0],-.5,0],max:[a[3],.5,0]}:{})}))};
  // Latch starts with real base-color and roughness textures. Pulling back its
  // paint mask must expose these maps, including the green stripe at the right.
  gltf.images=[{uri:'original.png'},{uri:'orm.png'}];gltf.textures=[{source:0},{source:1}];
  gltf.materials[1].alphaMode='BLEND';
  Object.assign(gltf.materials[1].pbrMetallicRoughness,{baseColorFactor:[1,1,1,1],baseColorTexture:{index:0},metallicRoughnessTexture:{index:1}});
  const form=new FormData();form.append('model',new Blob([JSON.stringify(gltf)]),'panels.gltf');form.append('attachment',new Blob([bytes]),'panels.bin');
  const encoded=JSON.parse(execFileSync(pythonExecutable(),['-c',`import base64,io,json
from PIL import Image
color=Image.new('RGBA',(32,32),(134,134,134,255))
color.paste((30,154,83,255),(20,0,32,32))
color.paste((30,154,83,128),(30,0,32,32))
def png(image):
 b=io.BytesIO();image.save(b,format='PNG');return base64.b64encode(b.getvalue()).decode()
print(json.dumps([png(color),png(Image.new('RGB',(32,32),(255,204,0)))]))`],{encoding:'utf8'}));
  for(const [i,file] of ['original.png','orm.png'].entries())form.append('attachment',new Blob([Buffer.from(encoded[i],'base64')]),file);
  return form;
}
try{
  await until(()=>fetch(origin+'/api/health').then(r=>r.ok,()=>false),'服务');
  const r=await fetch(origin+'/api/projects/gltf-import?name=Twin%20Panels',{method:'POST',headers:{Origin:origin},body:panels()});
  let doc=await r.json();assert.equal(r.status,201,JSON.stringify(doc));const route='/api/projects/'+doc.id;
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1530,height:960}});
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e);});
  await page.goto(origin+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=material]').click();
  await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:90000});
  assert.deepEqual((await json(route+'/paint/render-objects')).materials,['Shell','Latch']);
  const panel=page.locator('.texture-set-editor').first(),slot=panel.locator('select[aria-label=纹理集材质槽]');
  const viewport=page.locator('.editor-viewport[data-state=ready]').first();
  await panel.getByRole('button',{name:'纹理集',exact:true}).click();
  await slot.locator('option[value=Shell]').waitFor({state:'attached'});
  async function written(action){
    const revision=doc.revision;await action();
    doc=await until(async()=>{const snap=await json(route);return snap.revision>revision&&snap;},'写入纹理集');
    await until(()=>slot.isEnabled(),'面板就绪');console.log('已提交',doc.revision);
  }
  async function choose(name){
    await panel.getByRole('button',{name:'纹理集材质槽',exact:true}).click();
    await page.getByRole('option',{name,exact:true}).click();
  }
  async function modify(name,color,roughness,x){
    await choose(name);
    await written(()=>panel.getByText('新建填充层',{exact:true}).click());
    await written(()=>panel.getByLabel('颜色',{exact:true}).fill(color));
    await written(async()=>{const input=panel.getByLabel('粗糙度');await input.fill(String(roughness));await input.press('Enter');await input.blur();});
    const canvas=panel.getByLabel('纹理集 UV 蒙版');await canvas.scrollIntoViewIfNeeded();
    const box=await canvas.boundingBox();
    await written(async()=>{await page.mouse.move(box.x+x*box.width,box.y+box.height*.4);
      await page.mouse.down();await page.mouse.move(box.x+x*box.width,box.y+box.height*.6,{steps:12});await page.mouse.up();});
  }
  const channels=async (name,format='legacy')=>{
    const r=await fetch(origin+route+'/paint/live',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({revision:doc.revision,resolution:256,textureSet:name,format})});
    assert.equal(r.status,200,r.ok?'':await r.text());return Buffer.from(await r.arrayBuffer());
  };
  const sample=(pixels,x,y)=>Array.from(pixels.subarray((y*256+x)*6,(y*256+x)*6+5));
  await modify('Shell','#d92820',.17,.27);
  const shell=structuredClone(doc.paint.layers),originalPixels=await channels('Shell');
  await modify('Latch','#1876eb',.81,.73);
  assert.deepEqual(doc.paint.layers,shell);
  const latch=structuredClone(doc.paint.textureSets.Latch);
  assert.equal(latch.layers[0].name,'源材质贴图');assert.ok(latch.layers[0].maps.color&&latch.layers[0].maps.roughness);
  assert.equal(latch.layers.at(-1).maskStrokes.length,1);
  await choose('Shell');assert.equal(await panel.getByLabel('颜色',{exact:true}).inputValue(),'#d92820');
  await choose('Latch');assert.equal(await panel.getByLabel('粗糙度').inputValue(),'0.81');
  assert.deepEqual(await channels('Shell'),originalPixels);
  const bluePixels=await channels('Latch');
  console.log('PIXELS',sample(originalPixels,186,128),sample(originalPixels,69,128),sample(bluePixels,69,128),sample(bluePixels,186,128));
  assert.deepEqual(sample(originalPixels,186,128),[217,40,32,0,43]);
  assert.deepEqual(sample(bluePixels,69,128),[24,118,235,0,207]);
  assert.deepEqual(sample(originalPixels,69,128),[134,134,134,0,166]);
  assert.deepEqual(sample(bluePixels,186,128),[30,154,83,0,133]);
  const extended=await channels('Latch','pbr8');assert.equal(extended[(128*256+248)*15+13],128);
  // Let the normal viewport finish drawing both actual PBR textures. Count colored
  // pixels in its rendered image, independent of material IDs or DOM status flags.
  async function capture(){
    await viewport.screenshot({path:path.join(data,'both-slots.png')});
    return JSON.parse(execFileSync(pythonExecutable(),['-c',`from PIL import Image
import numpy as np,sys,json
a=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
r,g,b=a.transpose(2,0,1)
red=(r>g+30)&(r>b+30); blue=(b>r+30)&(b>g+15)
points=[list(map(float,[np.where(mask)[1].mean(),np.where(mask)[0].mean()])) for mask in (red,blue) if mask.any()]
print(json.dumps([int(red.sum()),int(blue.sum()),*points]))`,path.join(data,'both-slots.png')],{encoding:'utf8'}));
  }
  await until(async()=>{const [red,blue]=await capture();return red>300&&blue>300;},'视口同时显示两种材质');
  console.log('VIEWPORT',await capture());
  async function travel(key){await written(async()=>{await viewport.click({position:{x:8,y:8}});await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+key);});}
  const surfaceButton=panel.getByRole('button',{name:'视口画蒙版',exact:true});
  await surfaceButton.click();
  const [,,redCenter,blueCenter]=await capture(),vbox=await viewport.boundingBox();
  await page.mouse.click(vbox.x+redCenter[0],vbox.y+redCenter[1]);
  await panel.getByRole('status').filter({hasText:'请在「Latch」的可见表面绘制'}).waitFor();
  assert.equal((await json(route)).revision,doc.revision);
  await written(()=>page.mouse.click(vbox.x+blueCenter[0],vbox.y+blueCenter[1]));
  assert.deepEqual(doc.paint.layers,shell);assert.equal(doc.paint.textureSets.Latch.layers.at(-1).maskStrokes.length,2);
  const stamp=doc.paint.textureSets.Latch.layers.at(-1).maskStrokes.at(-1).stamps[0];
  const marked=sample(await channels('Latch'),Math.floor(stamp[0]*256),Math.floor(stamp[1]*256));
  assert.equal(marked[4],133);
  await surfaceButton.click();
  await travel('+z');assert.deepEqual(doc.paint.textureSets.Latch,latch);
  console.log('PASS 视口跨槽物体拒绝落笔，当前槽落笔及撤销');
  await travel('+z');assert.deepEqual(doc.paint.layers,shell);
  assert.equal(doc.paint.textureSets.Latch.layers.at(-1).maskStrokes?.length??0,0);
  assert.deepEqual(sample(await channels('Latch'),186,128),[24,118,235,0,207]);
  await travel('+z');assert.equal(doc.paint.textureSets.Latch.layers.at(-1).values.roughness,.5);
  assert.deepEqual(await channels('Shell'),originalPixels);
  await travel('+Shift+z');assert.equal(doc.paint.textureSets.Latch.layers.at(-1).values.roughness,.81);
  await travel('+Shift+z');assert.deepEqual(doc.paint.textureSets.Latch,latch);
  assert.deepEqual(await channels('Latch'),bluePixels);
  await page.reload();await viewport.waitFor();await until(async()=>{const [red,blue]=await capture();return red>300&&blue>300;},'重开视口');
  doc=await json(route);assert.deepEqual(doc.paint.layers,shell);assert.deepEqual(doc.paint.textureSets.Latch,latch);
  const backup=await json(route+'/paint/backup',{requestId:'two-sets',revision:doc.revision});
  const done=await until(async()=>{const j=await json(route+'/jobs/'+backup.id);if(j.status==='failed')throw Error(j.error);return j.status==='completed'&&j;},'工程包');
  const bytes=Buffer.from(await (await fetch(new URL(done.archiveUrl,origin))).arrayBuffer());await fs.writeFile(path.join(data,'dual-panels.zip'),bytes);
  async function restore(bytes){const r=await fetch(origin+'/api/projects/paint-import',{method:'POST',headers:{Origin:origin,'Content-Type':'application/zip'},body:bytes});
    const saved=await r.json();assert.equal(r.status,201,JSON.stringify(saved).slice(0,180));return saved;}
  const copy=await restore(bytes);assert.deepEqual(copy.paint.textureSets.Latch,latch);assert.deepEqual(copy.paint.layers,shell);
  if(process.argv[2]){
    const old=await restore(await fs.readFile(process.argv[2]));
    assert.equal(old.paint.textureSets,undefined);await page.goto(origin+'/paint.html?project='+old.id);
    await viewport.waitFor();const original=structuredClone(old.paint.layers);
    const oldRoute='/api/projects/'+old.id+'/paint';
    async function oldPixels(revision,textureSet){
      const r=await fetch(origin+oldRoute+'/live',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
        body:JSON.stringify({revision,textureSet,resolution:256})});
      assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());
    }
    const legacy=await oldPixels(old.revision);
    assert.deepEqual(await oldPixels(old.revision,old.source.material),legacy);
    await page.locator('[data-area-mode=material]').click();
    await panel.getByRole('button',{name:'纹理集',exact:true}).click();
    await panel.getByText('新建填充层',{exact:true}).click();
    await until(async()=>(await json('/api/projects/'+old.id)).revision===old.revision+1,'旧工程写入');
    const undone=await json(oldRoute+'/undo',{revision:old.revision+1});
    assert.deepEqual(undone.paint.layers,original);assert.deepEqual(await oldPixels(undone.revision),legacy);
    console.log('PASS 旧单槽工程编辑与撤销，原有像素逐字节一致');

  }
  assert.deepEqual(errors,[]);
  console.log('PASS independent slots, viewport, masks, history and archive reopen',data);
}finally{await browser?.close();if(server.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}}
