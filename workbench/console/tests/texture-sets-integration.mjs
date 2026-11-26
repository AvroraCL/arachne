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
    await written(async()=>{const input=panel.getByLabel('粗糙度',{exact:true});await input.fill(String(roughness));await input.press('Enter');await input.blur();});
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
  await choose('Latch');assert.equal(await panel.getByLabel('粗糙度',{exact:true}).inputValue(),'0.81');
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
  const jobFolder=id=>path.join(data,'projects',doc.id,'jobs',id);
  async function finished(type){
    return until(async()=>{
      const job=(await json(route+'/jobs')).find(j=>j.type===type&&j.revision===doc.revision);
      if(job&&['failed','interrupted','cancelled'].includes(job.status))throw Error(type+' '+job.error);
      return job?.status==='completed'&&job;
    },type);
  }
  await page.getByText('文件',{exact:true}).first().click();await page.locator('#open-delivery').click();
  await page.locator('#delivery-preview-button').click();const preview=await finished('paint-preview');
  await page.getByRole('button',{name:'查看纹理集',exact:true}).click();
  await page.getByRole('option',{name:'Latch',exact:true}).click();
  const secondary=preview.textureSetBakes.Latch,channelsView=page.locator('#delivery-channels a');
  await until(async()=>((await channelsView.first().getAttribute('href'))??'').includes(secondary.directory),'查看第二套 4K');
  assert.equal(await channelsView.count(),8);
  for(const href of await channelsView.evaluateAll(links=>links.map(link=>link.href))){
    const response=await fetch(href);assert.equal(response.status,200);await response.body.cancel();
  }
  await page.locator('#export-glb').click();const glb=await finished('paint-glb-export');
  const quality=JSON.parse(execFileSync(pythonExecutable(),['-c',`import io,json,sys
from pathlib import Path
from PIL import Image
from paint_glb import read_glb
root,slot,out=sys.argv[1:]
scene,data=read_glb(Path(out).read_bytes())
def embedded(key):
 view=scene['bufferViews'][scene['images'][scene['textures'][key['index']]['source']]['bufferView']]
 start=view.get('byteOffset',0)
 return Image.open(io.BytesIO(data[start:start+view['byteLength']]))
results={}
for material in scene['materials']:
 name=material['name']; source=Path(root) if name=='Shell' else Path(root)/slot
 pbr=material['pbrMetallicRoughness']
 color=embedded(pbr['baseColorTexture']).convert('RGBA')
 metalrough=embedded(pbr['metallicRoughnessTexture'])
 raw=[Image.open(source/('f_16xl_'+c+'.png')) for c in ('BaseColor','metallic','roughness','alpha')]
 assert all(image.size==(4096,4096) for image in [color,metalrough,*raw])
 samples=[]
 for x in (69,186,248):
  point=(x*16+8,2056)
  rgb=raw[0].convert('RGB').getpixel(point)
  metal,rough,alpha=[image.getpixel(point) for image in raw[1:]]
  assert color.getpixel(point)==(*rgb,alpha),(name,point,color.getpixel(point),rgb,alpha)
  assert metalrough.getpixel(point)[1:]==(rough,metal)
  samples.append([*rgb,metal,rough,alpha])
 results[name]=samples
print(json.dumps(results))`,path.join(jobFolder(preview.id),'paint'),secondary.directory,path.join(jobFolder(glb.id),'model.glb')],{encoding:'utf8'}));
  for(const [name,pixels] of [['Shell',originalPixels],['Latch',bluePixels]]){
    for(const [index,x] of [69,186].entries())assert.deepEqual(quality[name][index].slice(0,5),sample(pixels,x,128));
  }
  assert.equal(quality.Latch[2][5],128);console.log('PASS 实际 4K 和 GLB 双槽材质、原 UV、透明度',quality);
  const camera={projection:'orthographic',eye:[0,0,3],target:[0,0,0],up:[0,1,0],fov:38,orthoHeight:1.55};
  await json(route+'/paint/render',{revision:doc.revision,requestId:'two-slot-render',settings:{width:384,height:256,samples:6,transparent:true,camera}});
  const frame=await finished('paint-render');
  assert.equal(frame.render.textureSets.Latch.roughness,secondary.report.files['f_16xl_roughness.png']);
  const counts=JSON.parse(execFileSync(pythonExecutable(),['-c',`from PIL import Image
import sys,json,numpy as np
im=np.asarray(Image.open(sys.argv[1]).convert('RGBA')).astype(int)
assert im.shape==(256,384,4)
r,g,b,a=im.transpose(2,0,1); red=(r>g+30)&(r>b+30)&(a>200); blue=(b>r+30)&(b>g+15)&(a>200)
print(json.dumps([int(red[:,:192].sum()),int(blue[:,192:].sum()),int(red[:,192:].sum()),int(blue[:,:192].sum())]))`,path.join(jobFolder(frame.id),'path-tracing','render.png')],{encoding:'utf8'}));
  assert.ok(counts[0]>300&&counts[1]>300&&counts[2]<counts[0]/10&&counts[3]<counts[1]/10,JSON.stringify(counts));
  console.log('PASS 正式出图左右两个面板分别显示涂装颜色',counts);
  await page.getByRole('button',{name:'贴图输出预设',exact:true}).click();
  await page.getByRole('option',{name:'Unreal · ORM',exact:true}).click();
  await page.locator('#export-textures').click();
  const bundle=await finished('paint-texture-export');
  const zip=path.join(jobFolder(bundle.id),'textures','project.zip'),damaged=path.join(data,'tampered.zip');
  const packaged=JSON.parse(execFileSync(pythonExecutable(),['-c',`import io,json,sys
from zipfile import ZipFile,ZIP_DEFLATED
from PIL import Image
with ZipFile(sys.argv[1]) as z, ZipFile(sys.argv[2],'w',ZIP_DEFLATED) as altered:
 report=json.loads(z.read('project-report.json'))
 outputs={}; member=None
 for name,stack in [('Shell',report),('Latch',report['textureSets']['Latch'])]:
  prefix=stack.get('directory','')
  p=prefix+'/' if prefix else ''
  assert len(stack['bake']['files'])==8 and len(stack['textureOutput']['files'])==5
  key=p+'presets/unreal-orm/'
  base=Image.open(io.BytesIO(z.read(key+'BaseColor.png')))
  orm=Image.open(io.BytesIO(z.read(key+'ORM.png')))
  outputs[name]=[]
  for x in (69,186,248):
   point=(x*16+8,2056); r,g,b,a=base.getpixel(point); _,rough,metal=orm.getpixel(point)
   outputs[name].append([r,g,b,metal,rough,a])
  if name=='Latch': member=key+'ORM.png'
 for entry in z.infolist():
  content=z.read(entry)
  altered.writestr(entry,content+b'x' if entry.filename==member else content)
print(json.dumps(outputs))`,zip,damaged],{encoding:'utf8'}));
  assert.deepEqual(packaged,quality);
  const packedCopy=await restore(await fs.readFile(zip));assert.deepEqual(packedCopy.paint.textureSets.Latch,latch);
  const invalid=await fetch(origin+'/api/projects/paint-import',{method:'POST',headers:{Origin:origin,'Content-Type':'application/zip'},body:await fs.readFile(damaged)});
  assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/指纹/);
  console.log('PASS 两个槽的 4K ORM、颜色和透明度与 GLB 一致，完整包可重开，损坏副槽被拒绝');
  await json(route+'/paint/export',{revision:doc.revision,requestId:'native-two-slot',previewId:preview.id,confirmed:true,
    texturePreset:'unity-hdrp',settings:{width:384,height:256,samples:3,transparent:true,camera}});
  const delivery=await finished('paint-export');
  const packageFile=path.join(data,'two-slot-delivery.zip');
  await fs.writeFile(packageFile,Buffer.from(await (await fetch(new URL(delivery.packageUrl,origin))).arrayBuffer()));
  const nativeCheck=JSON.parse(execFileSync(pythonExecutable(),['-c',`from zipfile import ZipFile
from PIL import Image
import hashlib,json,io,sys
with ZipFile(sys.argv[1]) as z:
 material=json.loads(z.read('materials.json'))
 report=json.loads(z.read('project-report.json'))
 slots=report['textureSets']['Latch']
 info=material['textureSets']['Latch']['channels']['roughness']
 assert hashlib.sha256(z.read(info['file'])).hexdigest()==info['sha256']
 mask=Image.open(io.BytesIO(z.read(slots['directory']+'/presets/unity-hdrp/MaskMap.png')))
 rendered=Image.open(io.BytesIO(z.read('render.png')))
 assert mask.size==(4096,4096) and rendered.size==(384,256)
 print(json.dumps([mask.getpixel((x*16+8,2056)) for x in (69,186,248)]))`,packageFile],{encoding:'utf8'}));
  for(const [i,[,,,metal,rough]] of quality.Latch.entries())assert.deepEqual(nativeCheck[i],[metal,255,0,255-rough]);
  const nativeCopy=await restore(await fs.readFile(packageFile));assert.deepEqual(nativeCopy.paint.textureSets.Latch,latch);
  console.log('PASS 原生交付包保留副槽的材质清单、HDRP 通道、成片与可继续编辑的工程');
  // The two panels overlap in UV space. Only the Latch reads this banner.
  const image=(action,fields)=>({op:'image',action,documentId:'banner',...fields});
  const ink=color=>image('stroke',{layerId:'label',target:'pixels',stroke:{rect:[0,0,1,1],uv:true,color,opacity:1,erase:false}});
  doc=await json(route+'/paint/commands',{revision:doc.revision,operations:[
    image('create',{patch:{width:2048,height:512,name:'机身标记'}}),
    image('addLayer',{layerId:'label',kind:'pixel'}),ink('#60b050')]});
  await page.reload();await viewport.waitFor();
  if(await slot.isHidden())await panel.getByRole('button',{name:'纹理集',exact:true}).click();
  await choose('Latch');
  for(const name of ['纹理集颜色来源','纹理集粗糙度来源']){
    await written(async()=>{
      await panel.getByRole('button',{name,exact:true}).click();
      await page.getByRole('option',{name:'机身标记',exact:true}).click();
    });
  }
  // Wait for the actual viewport upload before requesting independent comparison frames.
  async function viewportBand(band){
    return until(async()=>{
      const bytes=await viewport.screenshot();
      const count=Number(execFileSync(pythonExecutable(),['-c',`from PIL import Image
import io,sys,numpy as np
r,g,b=np.asarray(Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')).astype(int).transpose(2,0,1)
test=(g>r+20)&(g>b+20) if sys.argv[1]=='green' else (b>g+25)&(r>g+12)
print(test.sum())`,band],{input:bytes,encoding:'utf8'}));
      return count>15000;
    },'视口横幅 '+band);
  }
  await viewportBand('green');
  await page.waitForLoadState('networkidle');
  const shelf=page.locator('.editor-area[data-editor=library]').first();
  await shelf.getByRole('button',{name:'编辑器类型',exact:true}).click();
  await page.getByRole('option',{name:'图像图层',exact:true}).click();
  const imageLayers=page.locator('.editor-area[data-editor=imageLayers]').first();
  const row=imageLayers.locator('[data-image-layer-id=label] .document-layer-select');
  if(!await row.count()){
    await imageLayers.locator('.area-header-tools select').first().selectOption('banner',{force:true});
  }
  await row.click();
  const properties=page.locator('.editor-area[data-editor=properties]:visible').first();
  await properties.getByRole('button',{name:'编辑器类型',exact:true}).click();
  await page.getByRole('option',{name:'UV 编辑器',exact:true}).click();
  const uv=page.locator('.editor-area[data-editor=uv]:visible').first();
  await uv.getByRole('button',{name:'UV 纹理集',exact:true}).click();
  await page.getByRole('option',{name:'Latch',exact:true}).click();
  const uvPixel=()=>uv.getByLabel('UV 画布').evaluate(c=>Array.from(c.getContext('2d')
    .getImageData(Math.floor(c.width*.27),Math.floor(c.height*.5),1,1).data).slice(0,3));
  await until(async()=>String(await uvPixel())==='96,176,80','UV 副槽横幅原色');
  await viewportBand('green');await page.waitForLoadState('networkidle');
  const baseline=path.join(data,'banner-before.png');await viewport.screenshot({path:baseline});
  const changedPixels=async()=>Number(execFileSync(pythonExecutable(),['-c',`from PIL import Image
import sys,io,numpy as np
a=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
b=np.asarray(Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')).astype(int)
print(np.count_nonzero(np.abs(a-b).max(axis=2)>8))`,baseline],{input:await viewport.screenshot(),encoding:'utf8'}));
  const targetSlots=[];
  function trackDraft(req){
    if(req.method()!=='POST'||!req.url().endsWith('/paint/live'))return;
    const body=req.postDataJSON();
    if(body.operation?.documentId==='banner')targetSlots.push(body.textureSet);
  }
  page.on('request',trackDraft);
  const opacity=imageLayers.locator('input[aria-label="不透明度"]').locator('..'),box=await opacity.boundingBox();
  const x=box.x+box.width*.75,y=box.y+box.height*.5;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-115,y,{steps:5});
  await until(async()=>String(await uvPixel())!=='96,176,80','UV 显示未松手的透明度');
  await until(async()=>await changedPixels()>15000,'三维显示未松手的透明度');
  assert.equal((await json(route)).revision,doc.revision);
  assert.deepEqual([...new Set(targetSlots)],['Latch']);
  await page.keyboard.press('Escape');await page.mouse.up();
  await until(async()=>String(await uvPixel())==='96,176,80','取消后 UV 恢复原色');
  await until(async()=>await changedPixels()<100,'取消后三维恢复同机位像素');
  assert.equal((await json(route)).revision,doc.revision);
  page.off('request',trackDraft);
  const green=await channels('Latch');
  const update=ink('#8030d0');
  const draft=await fetch(origin+route+'/paint/live',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({textureSet:'Latch',revision:doc.revision,resolution:256,operation:update})});
  assert.equal(draft.status,200);
  const purple=Buffer.from(await draft.arrayBuffer());
  assert.notDeepEqual(sample(green,69,128).slice(0,3),sample(purple,69,128).slice(0,3));
  assert.notEqual(sample(green,69,128)[4],sample(purple,69,128)[4]);
  doc=await json(route+'/paint/commands',{revision:doc.revision,operations:[update]});
  assert.deepEqual(await channels('Latch'),purple);
  assert.deepEqual(await channels('Shell'),originalPixels);
  doc=await json(route+'/paint/undo',{revision:doc.revision});
  assert.deepEqual(await channels('Latch'),green);
  doc=await json(route+'/paint/redo',{revision:doc.revision});
  await page.reload();await viewport.waitFor();await viewportBand('purple');
  await page.waitForLoadState('networkidle');
  assert.deepEqual(await channels('Latch'),purple);
  console.log('PASS 同一横幅驱动副槽颜色和粗糙度，草稿与提交逐字节一致，撤销、重做、重开保留主槽');
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
