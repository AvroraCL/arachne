import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {pythonExecutable} from '../python-runtime.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-banner-'));
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
  await until(()=>fetch(base+'/api/health').then(res=>res.ok,()=>false),'本地服务');
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'横幅边界验收',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1580,height:960}}),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e);});
  await page.goto(base+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('[data-editor=image]').first(),canvas=editor.getByLabel('图像文档画布');
  const stack=page.locator('[data-editor=imageLayers]').first(),mod=process.platform==='darwin'?'Meta':'Control';
  async function saved(label){
    const last=doc.revision;
    doc=await until(async()=>{const next=await api(route);return next.revision>last&&next;},label);
    console.log('PASS',label);
  }
  await editor.getByRole('button',{name:'新建图像',exact:true}).click();
  const dialog=page.locator('dialog.image-size-dialog[open]');
  const width=dialog.getByLabel('宽度（像素）'),height=dialog.getByLabel('高度（像素）');
  await dialog.getByRole('button',{name:/全高清/}).click();
  await dialog.getByRole('button',{name:'纵向'}).click();
  assert.deepEqual([await width.inputValue(),await height.inputValue()],['1080','1920']);
  assert.equal(await dialog.getByRole('button',{name:/全高清/}).getAttribute('aria-pressed'),'true');
  for(const button of [dialog.getByRole('button',{name:/全高清/}),dialog.getByRole('button',{name:'纵向'}),dialog.getByRole('button',{name:'创建',exact:true})]){
    const background=await button.evaluate(el=>getComputedStyle(el).backgroundColor);
    assert.match(background,/^rgba?\((\d+), \1, \1(?:, [\d.]+)?\)$/,'neutral button surface: '+background);
  }
  await page.setViewportSize({width:540,height:680});
  const presets=await dialog.getByRole('region',{name:'画布预设'}).boundingBox();
  const details=await dialog.getByRole('region',{name:'图像设置'}).boundingBox();
  assert.ok(details.y>=presets.y+presets.height-1&&details.x+details.width<=540);
  const paper=dialog.locator('.new-image-paper');
  const portrait=await paper.boundingBox();
  assert.ok(Math.abs(portrait.width/portrait.height-1080/1920)<.02);
  await page.setViewportSize({width:390,height:600});
  const confirm=await dialog.getByRole('button',{name:'创建',exact:true}).boundingBox();
  assert.ok(confirm.y>=0&&confirm.y+confirm.height<=600);
  await dialog.getByRole('button',{name:'颜色空间',exact:true}).click();
  await dialog.getByRole('option',{name:'数据（线性）',exact:true}).click();
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1580,height:960});
  assert.equal(Object.keys((await api(route)).paint.imageDocuments??{}).length,0);
  for(const [colorSpace,label,description] of [['adobe-rgb','Adobe RGB (1998)','A98C'],['rec2020','Rec.2020','2020'],['linear-srgb','线性 sRGB（颜色）','cRGB']]){
    await editor.getByRole('button',{name:'创建第一个图像文档'}).click();
    await width.fill('63');await height.fill('31');
    await dialog.getByRole('button',{name:'背景内容',exact:true}).click();
    await dialog.getByRole('option',{name:'自定颜色',exact:true}).click();
    await dialog.getByLabel('背景颜色').fill('#4477aa');
    assert.equal(await paper.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(68, 119, 170)');
    await dialog.getByRole('button',{name:'颜色空间',exact:true}).click();
    for(const name of ['Display P3','Adobe RGB (1998)','ProPhoto RGB','Rec.709','Rec.2020','Rec.2020（Gamma 2.4）','DCI-P3（影院）','线性 sRGB（颜色）'])assert.ok(await dialog.getByRole('option',{name,exact:true}).isVisible());
    await dialog.getByRole('option',{name:label,exact:true}).click();
    const swatch=await paper.evaluate(e=>getComputedStyle(e).backgroundColor.match(/\d+/g).map(Number));
    await dialog.getByRole('button',{name:'创建',exact:true}).click();await saved('创建带 '+label+' 背景的图像');
    const colored=Object.values(doc.paint.imageDocuments)[0];
    assert.equal(colored.colorSpace,colorSpace);
    assert.deepEqual(colored.layers.map(l=>l.kind),['shape','pixel']);
    await editor.locator('.document-image-stage[data-preview-revision="'+doc.revision+'"]').waitFor();
    const backgroundFile=path.join(data,'background.png');
    const downloadBackground=page.waitForEvent('download');
    await editor.getByRole('button',{name:'导出当前图像 PNG'}).click();
    await (await downloadBackground).saveAs(backgroundFile);
    const expectedDisplay=execFileSync(pythonExecutable(),['-c',`from PIL import Image
import sys
from PIL import ImageCms
from io import BytesIO
im=Image.open(sys.argv[1])
profile=ImageCms.ImageCmsProfile(BytesIO(im.info['icc_profile']))
assert ImageCms.getProfileDescription(profile).strip()==sys.argv[2]
proof=ImageCms.profileToProfile(im,profile,ImageCms.createProfile('sRGB'),outputMode='RGBA',renderingIntent=1)
print(*proof.getpixel((30,15)))
assert im.size==(63,31)
assert im.getextrema()==((68,68),(119,119),(170,170),(255,255)),im.getextrema()`,backgroundFile,description],{encoding:'utf8'}).trim().split(/\s+/).map(Number);
    swatch.forEach((value,i)=>assert.ok(Math.abs(value-expectedDisplay[i])<=1,label+' 新建预览色块'));
    async function checkDisplay(){
      await until(async()=>{
        const pixel=await canvas.evaluate(c=>[...c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data]);
        return pixel.every((n,i)=>Math.abs(n-expectedDisplay[i])<=1);
      },label+' 画布与导出 ICC 色块一致');
    }
    await checkDisplay();
    await page.reload();await checkDisplay();
    assert.equal((await api(route)).paint.imageDocuments[Object.keys(doc.paint.imageDocuments)[0]].colorSpace,colorSpace);
    await canvas.focus();await page.keyboard.press(mod+'+z');await saved('一次撤销整张图像');
    assert.equal(Object.keys(doc.paint.imageDocuments??{}).length,0);
  }
  await editor.getByRole('button',{name:'创建第一个图像文档'}).click();
  await dialog.getByRole('button',{name:/横幅/}).click();
  assert.equal(await dialog.getByRole('button',{name:/横幅/}).getAttribute('aria-pressed'),'true');
  await height.fill('500');
  assert.equal(await dialog.getByRole('button',{name:/横幅/}).getAttribute('aria-pressed'),'false');
  await height.fill('512');
  await dialog.getByLabel('名称',{exact:true}).fill('横幅样稿');
  await dialog.getByRole('button',{name:'创建',exact:true}).click();await saved('创建横幅');
  const documentId=Object.keys(doc.paint.imageDocuments)[0],image=()=>doc.paint.imageDocuments[documentId];
  assert.equal(image().name,'横幅样稿');assert.equal(image().colorSpace,'srgb');
  const pixelId=image().layers[0].id;
  // Wait for the selected document frame, not a preview left from the previous revision.
  const detailed=()=>editor.locator('.document-image-stage[data-preview-size="4096"][data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  await detailed();
  assert.deepEqual(await canvas.evaluate(c=>[c.width,c.height]),[2048,512]);
  async function point(x,y){
    const b=await canvas.boundingBox();
    return [b.x+b.width*x/2048,b.y+b.height*y/512];
  }
  async function dot(x,y){
    await page.mouse.click(...await point(x,y));await saved('写入像素 '+x+','+y);
  }
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await dot(32,256);await dot(1980,455);
  await stack.getByRole('button',{name:'添加蒙版',exact:true}).click();await saved('添加图层蒙版');
  await editor.locator('.document-edit-target').getByText('蒙版',{exact:true}).waitFor();
  await dot(2004,455);
  await stack.locator('[data-image-layer-id="'+pixelId+'"] .document-layer-select').click();
  await editor.getByRole('button',{name:'文字工具',exact:true}).click();
  await page.mouse.click(...await point(300,160));
  const input=editor.getByRole('textbox',{name:'画布文字',exact:true});
  await input.fill('BANNER 01');await input.press(mod+'+Enter');await saved('创建可编辑文字');
  await editor.getByRole('button',{name:'形状工具',exact:true}).click();
  await editor.getByRole('button',{name:'形状类型',exact:true}).click();
  await page.getByRole('option',{name:'椭圆',exact:true}).click();
  await page.mouse.move(...await point(1200,128));await page.mouse.down();
  await page.mouse.move(...await point(1456,384),{steps:6});await page.mouse.up();await saved('绘制圆');
  const originalLayers=structuredClone(image().layers);
  assert.ok(originalLayers.some(l=>l.shape?.kind==='ellipse'));
  assert.ok(originalLayers.some(l=>l.text?.content==='BANNER 01'));
  assert.ok(originalLayers.find(l=>l.id===pixelId).maskEnabled);
  async function png(name){
    await detailed();
    const dl=page.waitForEvent('download');
    await editor.getByRole('button',{name:'导出当前图像 PNG'}).click();
    await (await dl).saveAs(path.join(data,name+'.png'));
  }
  async function size(menu,fields,anchor){
    await editor.getByRole('button',{name:'图像尺寸操作',exact:true}).click();
    await page.getByRole('option',{name:menu,exact:true}).click();
    for(const [name,value] of fields)await dialog.getByLabel(name+'（像素）').fill(String(value));
    if(anchor)await dialog.getByRole('button',{name:anchor,exact:true}).click();
    await dialog.getByRole('button',{name:'应用',exact:true}).click();await saved(menu);
  }
  const thumbnail=stack.locator('[data-image-layer-id="'+pixelId+'"] .document-layer-thumb');
  await until(()=>thumbnail.evaluate(c=>c.width===32&&c.height===8),'横幅图层缩略图');
  await png('original');
  await size('画布尺寸…',[['宽度',2304]],'左中');await png('extended');
  await editor.getByRole('button',{name:'图像尺寸操作',exact:true}).click();
  await page.getByRole('option',{name:'裁切…',exact:true}).click();
  const cropBox=await dialog.locator('.image-crop-preview').boundingBox();
  await page.mouse.move(cropBox.x+8,cropBox.y+10);await page.mouse.down();
  await page.mouse.move(cropBox.x+cropBox.width-16,cropBox.y+cropBox.height-6,{steps:4});await page.mouse.up();
  const firstWidth=Number(await dialog.getByLabel('宽度（像素）').inputValue());
  const handle=await dialog.locator('[data-edge=e]').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();
  await page.mouse.move(handle.x-24,handle.y+handle.height/2,{steps:4});await page.mouse.up();
  assert.ok(Number(await dialog.getByLabel('宽度（像素）').inputValue())<firstWidth);
  await dialog.getByRole('button',{name:'取消'}).click();
  assert.equal((await api(route)).revision,doc.revision);
  await size('裁切…',[['左边距',128],['宽度',2176]]);await png('cut');
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销裁切');
  assert.equal(image().width,2304);await png('undo');
  await canvas.focus();await page.keyboard.press(mod+'+Shift+z');await saved('重做裁切');
  await size('画布尺寸…',[['宽度',2304]],'右中');await png('restored');
  await size('图像尺寸…',[['宽度',1152]]);assert.equal(image().height,256);await png('half');
  await page.reload();await detailed();await png('reopened');
  assert.deepEqual(await canvas.evaluate(c=>[c.width,c.height]),[1152,256]);
  await editor.getByRole('button',{name:'实际像素',exact:true}).click();
  assert.match(await editor.locator('.document-status-bar').innerText(),/100.0%.*1152 × 256/);
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await editor.screenshot({path:path.join(data,'banner-workspace.png')});
  const display=await canvas.evaluate(c=>c.toDataURL('image/png').split(',')[1]);
  await fs.writeFile(path.join(data,'canvas.png'),Buffer.from(display,'base64'));
  assert.deepEqual((await api(route)).paint.imageDocuments[documentId].layers,originalLayers);
  execFileSync(pythonExecutable(),['-c',`from PIL import Image
import numpy as np, sys, os
def load(n): return np.asarray(Image.open(os.path.join(sys.argv[1],n+'.png')))
src,ext,cut=map(load,['original','extended','cut'])
assert src.shape==(512,2048,4) and src[455,1968,3]>0 and src[455,1980,3]==0 and src[256,32,3]>0
assert ext.shape==(512,2304,4) and np.array_equal(ext[:,:2048],src) and not ext[:,2048:,3].any()
assert np.array_equal(cut,ext[:,128:])
assert np.array_equal(load('undo'),ext) and np.array_equal(load('restored'),ext)
half=load('half')
assert half.shape==(256,1152,4) and np.array_equal(half,load('reopened'))
canvas=load('canvas')
assert np.array_equal(half[:,:,3],canvas[:,:,3])
assert np.array_equal(np.asarray(Image.fromarray(half).convert('RGBa')),np.asarray(Image.fromarray(canvas).convert('RGBa')))
assert np.array_equal(half,np.asarray(Image.fromarray(ext).resize((1152,256),Image.Resampling.BICUBIC)))
`,data],{stdio:'inherit'});
  await editor.getByRole('button',{name:'图像尺寸操作',exact:true}).click();
  await page.getByRole('option',{name:'图像尺寸…',exact:true}).click();
  await dialog.getByLabel('锁定宽高比').uncheck();
  await dialog.getByLabel('宽度（像素）').fill('256');await dialog.getByLabel('高度（像素）').fill('512');
  await dialog.getByRole('button',{name:'应用',exact:true}).click();await saved('分别缩放宽高为竖图');
  await detailed();assert.deepEqual(await canvas.evaluate(c=>[c.width,c.height]),[256,512]);
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销非等比缩放');await detailed();
  const title=image().layers.find(layer=>layer.text);
  await stack.locator('[data-image-layer-id="'+title.id+'"] .document-layer-select').click();
  await page.locator('[data-editor=imageProperties]').first().getByRole('button',{name:'编辑文字…',exact:true}).click();
  const textDialog=page.getByRole('dialog',{name:'编辑文字',exact:true});
  await textDialog.locator('textarea').fill('BANNER 02');
  await textDialog.getByRole('button',{name:'应用',exact:true}).click();await saved('缩放后重开并修改标题');
  assert.equal(image().layers.find(layer=>layer.id===title.id).text.content,'BANNER 02');
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销标题修改');
  assert.deepEqual(image().layers,originalLayers);
  const profilePicker=page.getByRole('button',{name:'图像颜色空间',exact:true});
  await profilePicker.click();await page.getByRole('option',{name:'Display P3',exact:true}).click();
  await saved('将已有文档指定为 Display P3');assert.equal(image().colorSpace,'display-p3');
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销指定空间');assert.equal(image().colorSpace,'srgb');
  await page.keyboard.press(mod+'+Shift+z');await saved('重做指定空间');assert.equal(image().colorSpace,'display-p3');
  await editor.getByRole('button',{name:'应用至材质',exact:true}).click();await saved('绑定非方形颜色通道');
  await page.locator('[data-area-mode=material]').click();
  await page.locator('.editor-viewport[data-rendered-paint-revision="'+doc.revision+'"][data-rendered-paint-resolution="4096"]').first().waitFor({timeout:90000});
  const preview=await fetch(base+paint+'/live',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,resolution:256,format:'pbr8'})});
  assert.equal(preview.status,200);
  await fs.writeFile(path.join(data,'preview.raw'),Buffer.from(await preview.arrayBuffer()));
  const job=await api(paint+'/preview',{requestId:'banner-color',revision:doc.revision},202);
  const bake=await until(async()=>{
    const j=await api(route+'/jobs/'+job.id);if(j.status==='failed')throw Error(j.error);
    return j.status==='completed'&&j;
  },'非方形文档烘焙');
  const baked=await fetch(new URL(bake.colorUrl,base));assert.equal(baked.status,200);
  await fs.writeFile(path.join(data,'bake.png'),Buffer.from(await baked.arrayBuffer()));
  execFileSync(pythonExecutable(),['-c',`from PIL import Image
import numpy as np, sys, os
p=sys.argv[1]
live=np.fromfile(os.path.join(p,'preview.raw'),dtype=np.uint8).reshape(256,256,15)
baked=np.asarray(Image.open(os.path.join(p,'bake.png')))
assert baked.shape[:2]==(4096,4096)
# Interior of circle, transparent extension, and surviving ink at lower right.
colors=[]
for x,y in [(147,128),(249,220),(218,227),(3,128)]:
    a=live[y,x,:3];b=baked[y*16+8,x*16+8,:3]
    print('UV',x,y,'live',a,'bake',b)
    assert np.max(np.abs(a.astype(int)-b.astype(int)))<=1
    colors.append(tuple(b))
assert len(set(colors))>=2`,data],{stdio:'inherit'});
  const backup=await api(paint+'/backup',{requestId:'banner-editable',revision:doc.revision},202);
  const packed=await until(async()=>{
    const j=await api(route+'/jobs/'+backup.id);if(j.status==='failed')throw Error(j.error);
    return j.status==='completed'&&j;
  },'保存可重新打开的横幅工程');
  const archive=await fetch(new URL(packed.archiveUrl,base));assert.equal(archive.status,200);
  const bytes=Buffer.from(await archive.arrayBuffer());
  await fs.writeFile(path.join(data,'banner-project.zip'),bytes);
  const imported=await fetch(base+'/api/projects/paint-import',{method:'POST',headers:{Origin:base,'Content-Type':'application/zip'},body:bytes});
  const restored=await imported.json();assert.equal(imported.status,201,JSON.stringify(restored).slice(0,180));
  assert.deepEqual(restored.paint.imageDocuments[documentId],image());
  assert.deepEqual(errors,[]);
  console.log('PASS banner PNG pixels, transparency, mark, circle, editable layers, history and reopen',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
