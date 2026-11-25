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
import {imagePlacement,warpPoint} from '../public/image-warp.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-image-repair-'));
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
const python=pythonExecutable();
const fixture=execFileSync(python,['-B','-c',`
import numpy as np,sys
from PIL import Image
n=1024
y,x=np.indices((n,n))
tone=np.where(x<512,95,175)+np.where(y>512,-40,0)
grain=(np.cos(y*np.pi/7)*7).round()
p=np.empty((n,n,4),dtype=np.uint8)
for i,offset in enumerate([0,13,25]):
    p[:,:,i]=tone+grain+offset
p[:,:,3]=255
p[:85,:,3]=0
p[213:237,731:739,:3]=[30,20,16]
spot=(x-674)**2+(y-713)**2<=7**2
p[spot,:3]=[16,16,16]
from PIL import ImageDraw
image=Image.fromarray(p)
draw=ImageDraw.Draw(image)
draw.polygon([(45,495),(950,398),(978,486),(70,585)],fill=(21,41,60,255))
draw.polygon([(72,519),(951,424),(961,454),(83,549)],fill=(36,111,196,255))
draw.line([(64,591),(977,493)],fill=(243,167,60,255),width=7)
image.save(sys.stdout.buffer,format='PNG')
`]).toString('base64');
try{
  await until(()=>fetch(base+'/api/health').then(res=>res.ok,()=>false),'本地服务');
  const model=process.env.ARACHNE_LIVERY_TEST_GLB;
  let doc;
  if(model){
    const name=encodeURIComponent('A-17 · 实际模型涂装验收');
    const response=await fetch(base+'/api/projects/model-import?material=0&textures=blank&name='+name,{
      method:'POST',headers:{Origin:base,'Content-Type':'model/gltf-binary'},body:await fs.readFile(model)});
    doc=await response.json();
    assert.equal(response.status,201,JSON.stringify(doc).slice(0,500));
    assert.match(doc.source.uvSha256,/^[a-f0-9]{64}$/);
  }else doc=await api('/api/projects',{workflowType:'pbr_paint',name:'涂装接缝修补',modelTemplate:'plane'},201);
  const registeredUV=doc.source.uvSha256;
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  const op=(action,fields={})=>({op:'image',documentId:'design',action,...fields});
  const commands=async operations=>{doc=await api(paint+'/commands',{revision:doc.revision,operations});};
  await commands([op('create',{patch:{name:'A-17 · 深空蓝机身涂装'}})]);
  doc=(await api(paint+'/assets',{revision:doc.revision,name:'带接缝和污点的机身蒙皮.png',data:fixture,
    imageLayer:{documentId:'design',layerId:'skin',x:.5,y:.5,scale:1}},201)).document;
  await commands([op('addLayer',{layerId:'repair',kind:'pixel',patch:{name:'独立修补层'}})]);
  const image=()=>doc.paint.imageDocuments.design,repair=()=>image().layers.find(layer=>layer.id==='repair');
  const read=()=>api(route);
  async function saved(label){
    const before=doc.revision;
    doc=await until(async()=>{const next=await read();return next.revision===before+1&&next;},label);
  }
  async function png(name){
    const file=path.join(data,name+'.png');
    const response=await fetch(base+paint+'/image-export',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,documentId:'design'})});
    assert.ok(response.ok,response.ok?'':await response.text());await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));return file;
  }
  const before=await png('before'),skin=structuredClone(image().layers[0]);
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1590,height:950}}),errors=[];
  page.on('pageerror',error=>{errors.push(error.message);console.error(error);});
  page.on('response',async response=>{
    if(response.url().endsWith('/paint/live')&&response.status()>=400)
      console.error('材质预览',response.status(),await response.text().catch(()=>''));
  });
  await page.goto(base+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first(),canvas=editor.getByLabel('图像文档画布');
  const stage=editor.locator('.document-image-stage'),options=editor.locator('.document-clone-options');
  const mod=process.platform==='darwin'?'Meta':'Control';
  await canvas.waitFor();
  const guide=editor.getByRole('button',{name:'原 UV 参考',exact:true}),overlay=editor.locator('.document-uv-guide');
  const layoutResponse=page.waitForResponse(response=>response.url().endsWith('/paint/uv-layout'));
  await guide.click();
  const uv=await layoutResponse;
  assert.ok(uv.ok(),uv.ok()?'':await uv.text());
  assert.equal(uv.headers()['x-uv-sha256'],registeredUV);
  await overlay.waitFor();
  await until(()=>overlay.evaluate(image=>image.naturalWidth===1024),'UV 参考解码');
  const imagePath=path.join(data,'registered-uv.png');
  const overlayBytes=await overlay.evaluate(async image=>Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())));
  await fs.writeFile(imagePath,Buffer.from(overlayBytes));
  const viewButton=editor.getByRole('button',{name:'画布视图',exact:true});
  await viewButton.click();
  const orientation=editor.getByRole('dialog',{name:'画布视图',exact:true});
  await orientation.getByRole('button',{name:'水平镜像视图',exact:true}).click();
  assert.equal(await overlay.evaluate(image=>image.style.transform),await canvas.evaluate(image=>image.style.transform));
  await orientation.getByRole('button',{name:'复位视图方向',exact:true}).click();
  await page.keyboard.press('Escape');
  assert.equal((await read()).revision,doc.revision);
  await guide.click();await overlay.waitFor({state:'hidden'});
  await page.locator('[data-image-layer-id=repair] .document-layer-select').click();
  await canvas.focus();await page.keyboard.press('Shift+j');
  await editor.getByRole('button',{name:'修复画笔',exact:true,pressed:true}).waitFor();
  async function size(value){
    const field=editor.locator('input[aria-label="像素半径"]').locator('..');
    await field.dblclick();
    const input=field.getByRole('spinbutton',{name:'输入数值'});
    await input.fill(String(value));await input.press('Enter');
  }
  const point=async ([x,y])=>{const box=await canvas.boundingBox();return [box.x+x*box.width,box.y+y*box.height];};
  const ready=()=>options.locator('xpath=self::*[@data-repair-ready="true"]').waitFor({timeout:65000});
  await size(93);
  await page.keyboard.down('Alt');
  await page.mouse.click(...await point([.27,.226]));
  await page.keyboard.up('Alt');
  await ready();
  const preview=page.waitForResponse(r=>r.ok()&&r.url().endsWith('/image-live')&&r.request().postDataJSON()?.operation?.stroke?.clone?.kind==='heal');
  const start=await point([.717,.217]),end=await point([.717,.230]);
  await page.mouse.move(...start);await page.mouse.down();await page.mouse.move(...end,{steps:7});await preview;await page.mouse.up();
  await saved('修复笔触单次保存');
  assert.equal(repair().strokes[0].clone.kind,'heal');
  assert.equal(repair().strokes[0].clone.asset,repair().strokes[0].clone.backdrop);
  const healed=await png('healed');
  await canvas.focus();await page.keyboard.press('j');
  await editor.getByRole('button',{name:'污点修复画笔',exact:true,pressed:true}).waitFor();
  await size(55);await ready();
  await page.mouse.click(...await point([674/1024,713/1024]));
  await saved('自动修复污点');
  assert.equal(repair().strokes[1].clone.kind,'spot');
  assert.deepEqual(image().layers[0],skin);
  const final=await png('spot-repaired');
  execFileSync(python,['-B','-c',`
import sys
import numpy as np
from PIL import Image
before,heal,after=(np.asarray(Image.open(file)) for file in sys.argv[1:])
def p(a,x,y): return a[int(y*4096),int(x*4096)]
assert tuple(p(before,.717,.219)[:3])==(30,20,16)
assert p(heal,.717,.219)[0]>155 and p(heal,.717,.219)[0]<192,p(heal,.717,.219)
assert np.std(heal[859:935,2937,0])>2
assert p(heal,.717,.225)[0]!=p(heal,.717,.222)[0]
assert p(before,674/1024,713/1024)[0]==16
assert 121<p(after,674/1024,713/1024)[0]<148,p(after,674/1024,713/1024)
assert np.array_equal(before[1800:2200],after[1800:2200])
assert np.array_equal(before[:,:,3],after[:,:,3])
`,before,healed,final],{stdio:'inherit'});
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销污点修复');
  assert.deepEqual(await fs.readFile(await png('undo')),await fs.readFile(healed));
  await canvas.focus();await page.keyboard.press(mod+'+Shift+z');await saved('重做污点修复');
  assert.deepEqual(await fs.readFile(await png('redo')),await fs.readFile(final));
  await page.reload();await canvas.waitFor();
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  assert.deepEqual(await fs.readFile(await png('reopened')),await fs.readFile(final));
  await page.screenshot({path:path.join(data,'repair-workspace.png')});
  console.log('PASS repair pixels, history and reopen:',data);

  const rows=page.locator('.editor-area[data-editor=imageLayers]').first();
  const row=id=>rows.locator('[data-image-layer-id="'+id+'"] .document-layer-select');
  const startNumber=model?[.178,.273]:[.24,.28],endNumber=model?[.1835,.2905]:[.31,.31];
  const text=await api(paint+'/text',{revision:doc.revision,documentId:'design',placement:{x:startNumber[0],y:startNumber[1]},
    text:{content:'A-17',font:'plexMono',fontSize:model?54:390,weight:700,tracking:model?0:32,align:'center',color:'#f8edcc'}},201);
  doc=text.document;
  await page.reload();await canvas.waitFor();
  await row(text.layerId).click();
  await editor.getByRole('button',{name:'移动图层',exact:true}).click();
  await guide.click();await overlay.waitFor();
  const from=await point(startNumber),to=await point(endNumber);
  await page.mouse.move(...from);await page.mouse.down();await page.mouse.move(...to,{steps:12});await page.mouse.up();
  await saved('移动机身编号');
  assert.ok(Math.abs(image().layers.find(layer=>layer.id===text.layerId).x-endNumber[0])<.006);
  assert.equal(await guide.getAttribute('aria-pressed'),'true');
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  await page.screenshot({path:path.join(data,'uv-assisted-layout.png')});
  if(model){
    await guide.click();await overlay.waitFor({state:'hidden'});
    await commands([op('updateLayer',{layerId:text.layerId,patch:{
      warp:{mode:'perspective',points:[[.14,.06],[.98,0],[.94,.96],[.05,1]]}
    }}),op('addLayer',{layerId:'wing-stripe',kind:'shape',patch:{
      name:'翼面识别条',x:.946,y:.267,scale:.032,rotation:0,
      shape:{kind:'rectangle',width:380,height:124,fill:'#eca34b',stroke:null,strokeWidth:0,cornerRadius:15}
    }}),op('stroke',{layerId:'wing-stripe',target:'mask',stroke:{
      uv:true,rect:[.945,.26,.947,.274],opacity:1,value:0
    }}),op('updateLayer',{layerId:'wing-stripe',patch:{
      warp:{mode:'perspective',points:[[.18,.06],[1,.06],[.94,.96],[.12,.96]]}
    }})]);
    await page.reload();await canvas.waitFor();
  }
  await row('repair').click();
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  const a=await point([.53,.395]),b=await point([.955,.565]);
  await page.mouse.move(...a);await page.mouse.down();await page.mouse.move(...b,{steps:8});await page.mouse.up();
  await rows.getByRole('button',{name:'新建调整图层',exact:true}).click();
  await page.getByRole('menuitem',{name:'色相／饱和度',exact:true}).click();
  await saved('从选区建立局部调色蒙版');
  const adjustment=image().layers.find(layer=>layer.adjustment?.type==='hueSaturation');
  assert.equal(adjustment.maskEnabled,true);
  assert.equal(adjustment.maskBase,0);
  assert.ok(adjustment.maskStrokes.length);
  const props=page.locator('.editor-area[data-editor=imageProperties]').first();
  await props.getByRole('button',{name:'颜色范围',exact:true}).click();
  await page.getByRole('option',{name:'蓝色',exact:true}).click();
  await saved('选取蓝色油漆');
  const hue=props.locator('input[aria-label="色相"]').locator('..');
  await hue.dblclick();
  const number=hue.getByRole('spinbutton',{name:'输入数值'});
  await number.fill('-80');await number.press('Enter');
  await saved('局部蓝色转向青绿');
  const livery=await png('livery-4k');
  if(model){
    const boxes=[text.layerId,'wing-stripe'].map(id=>{
      const layer=image().layers.find(layer=>layer.id===id),meta=layer.shape??doc.paint.assets[layer.asset];
      const size=layer.scale/Math.max(meta.width,meta.height);
      return [layer.x-meta.width*size/2,layer.y-meta.height*size/2,layer.x+meta.width*size/2,layer.y+meta.height*size/2];
    });
    execFileSync(python,['-B','-c',`
from PIL import Image
import numpy as np,sys
guide=np.asarray(Image.open(sys.argv[1]))
for start in (2,6):
    x0,y0,x1,y1=[int(float(n)*1024) for n in sys.argv[start:start+4]]
    assert x1>x0 and y1>y0
    assert not guide[y0:y1+1,x0:x1+1,3].any(),(x0,y0,x1,y1)
artwork=Image.open(sys.argv[10])
def at(x,y): return artwork.getpixel((int(x*4096),int(y*4096)))
assert at(.948,.267)[:3] != (236,163,75) and at(.9455,.267)[:3] == (236,163,75)
`,imagePath,...boxes.flat().map(String),livery],{stdio:'inherit'});
  }
  execFileSync(python,['-B','-c',`
import sys
from PIL import Image
base,paint=(Image.open(name) for name in sys.argv[1:])
def at(im,x,y): return im.getpixel((int(x*4096),int(y*4096)))
assert at(base,.4,.48)==at(paint,.4,.48)
assert at(base,.65,.465)!=at(paint,.65,.465)
assert at(base,.717,.219)==at(paint,.717,.219)
`,final,livery],{stdio:'inherit'});
  await editor.getByRole('button',{name:'应用至材质',exact:true}).click();
  await saved('应用涂装到模型');
  const material=doc.paint.layers.find(layer=>layer.documentMaps?.color==='design');
  assert.ok(material);
  async function materialView(name){
    await page.locator('[data-area-mode=material]').click();
    const view=page.locator('.editor-area[data-editor=viewport] .editor-viewport').first();
    await view.locator('xpath=self::*[@data-state="ready"]').waitFor({timeout:65000});
    await view.locator('canvas').focus();
    await page.keyboard.press('Numpad7');
    try{
      await view.locator('xpath=self::*[@data-rendered-paint-revision="'+doc.revision+'"][@data-rendered-paint-resolution="4096"][@data-rendered-paint-draft="false"]').waitFor({timeout:65000});
    }catch(error){
      console.error('三维视口',await view.evaluate(node=>({state:{...node.dataset},text:node.closest('.editor-area').innerText})));
      await page.screenshot({path:path.join(data,'livery-viewport-error.png')});
      throw error;
    }
    await delay(400);
    return view.screenshot({path:path.join(data,name+'.png')});
  }
  const firstView=await materialView('livery-in-3d');
  await page.locator('[data-area-mode=drawing]').click();
  await row(text.layerId).click();
  await editor.getByRole('button',{name:'文字工具',exact:true}).click();
  const numberLayer=image().layers.find(layer=>layer.id===text.layerId);
  const numberCenter=layer=>imagePlacement(layer,doc.paint.assets).toCanvas(warpPoint(layer.warp,[.5,.5]));
  const beforeCenter=numberCenter(numberLayer);
  await page.mouse.click(...await point(beforeCenter));
  const inline=editor.getByRole('textbox',{name:'画布文字',exact:true});
  assert.equal(await inline.inputValue(),'A-17');
  await inline.fill('A-71');
  await inline.press(mod+'+Enter');
  await saved('查看三维后返回修改编号');
  const revisedNumber=image().layers.find(layer=>layer.id===text.layerId);
  assert.equal(revisedNumber.text.content,'A-71');
  assert.deepEqual(revisedNumber.warp,numberLayer.warp);
  assert.ok(numberCenter(revisedNumber).every((value,i)=>Math.abs(value-beforeCenter[i])<1e-8));
  assert.equal(doc.paint.layers.find(layer=>layer.id===material.id).documentMaps.color,'design');
  assert.equal(doc.source.uvSha256,registeredUV);
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  await page.screenshot({path:path.join(data,'livery-drawing.png')});
  const revisedView=await materialView('livery-3d-revised');
  assert.notDeepEqual(revisedView,firstView);
  execFileSync(python,['-B','-c',`
from PIL import Image
import numpy as np,sys
a,b=(np.asarray(Image.open(file).convert('RGB')).astype(np.int16) for file in sys.argv[1:])
assert a.shape==b.shape
area=np.s_[80:-50,120:-120]
assert np.count_nonzero((np.abs(a-b).max(axis=-1)>12)[area])>=10
`,path.join(data,'livery-in-3d.png'),path.join(data,'livery-3d-revised.png')],{stdio:'inherit'});
  assert.deepEqual(errors,[]);
  console.log('PASS livery layout, selection-based color adjustment, 4K linked material and edit after 3D review:',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
