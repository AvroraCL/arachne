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

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-image-color-'));
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const origin='http://127.0.0.1:'+socket.address().port;
await new Promise(resolve=>socket.close(resolve));
const server=spawn(process.execPath,['server.mjs','--port',new URL(origin).port],{
  cwd:new URL('..',import.meta.url),stdio:'inherit',windowsHide:true,
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',PYTHONDONTWRITEBYTECODE:'1'}
});
let browser;
const headers={Origin:origin,'Content-Type':'application/json'};
async function api(route,body,expected=200){
  const res=await fetch(origin+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
  const value=await res.json();
  assert.equal(res.status,expected,JSON.stringify(value).slice(0,400));
  return value;
}
async function until(read,label){
  for(let i=0;i<300;i++){const value=await read();if(value)return value;await delay(100);}
  throw Error('等待超时：'+label);
}
const imageOp=(action,fields={})=>({op:'image',documentId:'design',action,...fields});
const source=execFileSync(pythonExecutable(),['-B','-c',`
import sys
from PIL import Image,ImageDraw
im=Image.new('RGBA',(512,512))
d=ImageDraw.Draw(im)
d.polygon([(145,251),(190,218),(318,218),(373,251),(432,425),(346,442),(329,490),(182,490),(168,442),(81,425)],fill=(48,90,190,255))
d.polygon([(318,218),(373,251),(432,425),(346,442),(329,490),(294,490),(310,320)],fill=(37,60,126,160))
d.rounded_rectangle((183,97,329,238),36,fill=(230,157,115,255))
d.rectangle((214,230,298,252),fill=(230,157,115,255))
d.rectangle((185,308,285,326),fill=(128,128,128,255))
im.save(sys.stdout.buffer,'PNG')
`]).toString('base64');
try{
  await until(()=>fetch(origin+'/api/health').then(r=>r.ok,()=>false),'本机工作台');
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'服装标志局部调色',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  const commands=async operations=>{doc=await api(paint+'/commands',{revision:doc.revision,operations});return doc;};
  const document=()=>doc.paint.imageDocuments.design;
  const adjustment=type=>document().layers.find(layer=>layer.adjustment?.type===type);
  const waitRevision=async label=>{
    const expected=doc.revision+1;
    doc=await until(async()=>{const current=await api(route);return current.revision===expected&&current;},label);
  };
  await commands([imageOp('create',{patch:{name:'服装标志'}})]);
  doc=(await api(paint+'/assets',{revision:doc.revision,name:'服装底稿.png',data:source,imageLayer:{documentId:'design',
    layerId:'costume',x:.5,y:.5,scale:1}},201)).document;
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1520,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first();
  const stack=page.locator('.editor-area[data-editor=imageLayers]').first();
  const properties=page.locator('.editor-area[data-editor=imageProperties]').first();
  const canvas=editor.getByLabel('图像文档画布');
  await canvas.waitFor();
  const add=async name=>{
    await stack.getByRole('button',{name:'新建调整图层',exact:true}).click();
    await page.getByRole('menuitem',{name,exact:true}).click();
    await waitRevision(name);
    await properties.locator('.document-adjustment-heading strong',{hasText:name}).waitFor();
  };
  const option=async (label,name)=>{
    await properties.getByRole('button',{name:label,exact:true}).click();
    await page.getByRole('option',{name,exact:true}).click();
  };
  const enterNumber=async (label,value,action='Enter')=>{
    const field=properties.locator('input[aria-label="'+label+'"]').locator('..');
    await field.dblclick();
    const entry=field.getByRole('spinbutton',{name:'输入数值'});
    await entry.fill(String(value));await entry.press(action);
  };
  async function exportImage(name){
    const response=await fetch(origin+paint+'/image-export',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,documentId:'design'})});
    assert.equal(response.status,200,response.ok?'':await response.text());
    const file=path.join(data,name+'.png');
    await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));
    return file;
  }
  const sampleCode=`
import json,sys
from PIL import Image
im=Image.open(sys.argv[1])
assert im.size==(4096,4096)
print(json.dumps([im.getpixel((x*8+4,y*8+4)) for x,y in [(220,380),(356,376),(230,170),(223,317),(20,20)]]))
`;
  const samples=file=>JSON.parse(execFileSync(pythonExecutable(),['-B','-c',sampleCode,file],{encoding:'utf8'}));
  const before=samples(await exportImage('original-costume'));
  assert.deepEqual(before,[[48,90,190,255],[37,60,126,160],[230,157,115,255],[128,128,128,255],[0,0,0,0]]);

  await add('色相／饱和度');
  const picker=properties.getByRole('button',{name:'在画布取色',exact:true});
  const stage=editor.locator('.document-image-stage');
  const point=async(x,y)=>{
    const box=await canvas.boundingBox();
    return [box.x+(x+.5)/512*box.width,box.y+(y+.5)/512*box.height];
  };
  await picker.click();
  await stage.locator('xpath=self::*[@data-adjustment-pick]').waitFor();
  await page.mouse.click(...await point(223,317));
  await editor.getByRole('status').filter({hasText:'此处没有可用色相'}).waitFor();
  assert.equal((await api(route)).revision,doc.revision);
  await page.keyboard.press('Escape');
  assert.equal(await stage.getAttribute('data-adjustment-pick'),null);
  await picker.click();
  await page.mouse.click(...await point(220,380));
  await waitRevision('从画布取样蓝色服装');
  assert.equal(adjustment('hueSaturation').adjustment.range,'custom');
  assert.equal(adjustment('hueSaturation').adjustment.center,222);
  const mod=process.platform==='darwin'?'Meta':'Control';
  await canvas.focus();await page.keyboard.press(mod+'+z');
  await waitRevision('撤销画布取色');
  assert.equal(adjustment('hueSaturation').adjustment.range,'all');
  await canvas.focus();await page.keyboard.press(mod+'+Shift+z');
  await waitRevision('重做画布取色');
  assert.equal(adjustment('hueSaturation').adjustment.center,222);
  await enterNumber('范围半宽',25);await waitRevision('保存范围半宽');
  await enterNumber('过渡宽度',15);await waitRevision('保存过渡宽度');
  const hueInput=properties.locator('input[aria-label="色相"]');
  await until(()=>hueInput.evaluate(input=>{
    if(input.disabled)return false;
    input.scrollIntoView({block:'nearest'});
    return true;
  }).catch(()=>false),'色相参数可编辑');
  const preview=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/image-live')&&
    response.request().postDataJSON()?.operation?.patch?.adjustment?.hue===-110);
  const hueBar=await hueInput.locator('..').boundingBox();
  const hueX=hueBar.x+hueBar.width-8,hueY=hueBar.y+hueBar.height/2;
  await page.mouse.move(hueX,hueY);await page.mouse.down();
  await page.mouse.move(hueX-110,hueY,{steps:1});
  await preview;
  assert.equal((await api(route)).revision,doc.revision);
  await page.mouse.up();
  await waitRevision('保存服装改色');
  assert.equal(adjustment('hueSaturation').adjustment.hue,-110);
  const recoloredFile=await exportImage('costume-recolored'),recolored=samples(recoloredFile);
  assert.deepEqual(recolored.slice(2),before.slice(2));
  assert.deepEqual(recolored.map(pixel=>pixel[3]),before.map(pixel=>pixel[3]));
  assert.ok(recolored[0][1]>170&&recolored[0][2]<90);
  assert.ok(recolored[1][1]>115&&recolored[1][2]<70);
  await picker.click();
  const originalColor=page.waitForResponse(response=>response.ok()&&response.url().endsWith('/image-live')&&
    response.request().postDataJSON()?.beforeImageLayer===adjustment('hueSaturation').id);
  await page.mouse.click(...await point(220,380));
  const originalFrame=new Uint8Array(await (await originalColor).body());
  assert.deepEqual([...originalFrame.slice(4*(380*512+220),4*(380*512+220)+4)],before[0]);
  await stage.locator('xpath=self::*[not(@data-adjustment-pick)]').waitFor();
  assert.equal((await api(route)).revision,doc.revision);
  await enterNumber('色相',80,'Escape');
  assert.equal((await api(route)).revision,doc.revision);
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  await page.screenshot({path:path.join(data,'targeted-color-workspace.png')});
  const stable=doc.revision;
  await canvas.focus();await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+z');
  await waitRevision('撤销服装改色');assert.deepEqual(samples(await exportImage('costume-undo')),before);
  await canvas.focus();await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+Shift+z');
  await waitRevision('重做服装改色');
  assert.equal(doc.revision,stable+2);
  assert.deepEqual(await fs.readFile(await exportImage('costume-redo')),await fs.readFile(recoloredFile));

  await add('可选颜色');
  await option('颜色族','绿色');
  await enterNumber('青色',65);await waitRevision('提高绿色区域青色');
  await option('颜色族','红色');
  await enterNumber('洋红',-12);await waitRevision('保留独立颜色族参数');
  assert.equal(adjustment('selectiveColor').adjustment.tones.green.cyan,65);
  assert.equal(adjustment('selectiveColor').adjustment.tones.red.magenta,-12);
  await option('调整方式','绝对');await waitRevision('切换绝对可选颜色');
  const selective=samples(await exportImage('costume-selective'));
  assert.notDeepEqual(selective[0],recolored[0]);
  assert.deepEqual(selective[3],recolored[3]);
  await add('色彩平衡');
  await option('色调范围','阴影');
  await enterNumber('黄色／蓝色',22);await waitRevision('阴影色彩平衡');
  await option('色调范围','高光');
  await enterNumber('青色／红色',12);await waitRevision('高光色彩平衡');
  const balanced=samples(await exportImage('costume-balanced'));
  assert.notDeepEqual(balanced[1],selective[1]);
  assert.equal(adjustment('colorBalance').adjustment.tones.shadows.blue,22);
  assert.equal(adjustment('colorBalance').adjustment.tones.highlights.red,12);
  const lum=([r,g,b])=>.3*r+.59*g+.11*b;
  assert.ok(Math.abs(lum(balanced[1])-lum(selective[1]))<1.1);

  await add('渐变映射');
  await properties.locator('input[aria-label="阴影颜色"]').fill('#151537');await waitRevision('设定渐变阴影');
  await properties.locator('input[aria-label="中间色"]').fill('#528896');await waitRevision('设定渐变中间色');
  await properties.locator('input[aria-label="高光颜色"]').fill('#f4d092');await waitRevision('设定渐变高光');
  await enterNumber('中间色位置',42);await waitRevision('设置渐变中间色位置');
  const mapped=samples(await exportImage('costume-gradient'));
  assert.notDeepEqual(mapped[2],balanced[2]);assert.deepEqual(mapped.map(pixel=>pixel[3]),before.map(pixel=>pixel[3]));
  await stack.getByRole('button',{name:'图像图层混合模式',exact:true}).click();
  await page.getByRole('option',{name:'颜色',exact:true}).click();
  await waitRevision('颜色混合渐变映射');
  const tinted=samples(await exportImage('costume-color-blend'));
  assert.notDeepEqual(tinted[0],mapped[0]);
  const linear=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
  const linearLum=pixel=>lum(pixel.slice(0,3).map(n=>linear(n/255)));
  assert.ok(Math.abs(linearLum(tinted[0])-linearLum(balanced[0]))<.005);
  const result=await exportImage('costume-final');
  await page.reload();await canvas.waitFor();
  assert.deepEqual(await fs.readFile(await exportImage('costume-reopened')),await fs.readFile(result));
  assert.deepEqual(errors,[]);
  console.log('PASS canvas hue sampling, skin and alpha preservation, color banks, gradient map, component blend, 4K, undo and reopen:',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
  }
}
