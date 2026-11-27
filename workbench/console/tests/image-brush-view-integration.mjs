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

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-image-brush-view-'));
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const port=socket.address().port,origin='http://127.0.0.1:'+port;
await new Promise(resolve=>socket.close(resolve));
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:new URL('..',import.meta.url),stdio:'inherit',
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',PYTHONDONTWRITEBYTECODE:'1'}});
let browser;
const headers={Origin:origin,'Content-Type':'application/json'};
async function until(read,label){
  for(let i=0;i<320;i++){const result=await read();if(result)return result;await delay(100);}
  throw Error('等待超时：'+label);
}
async function api(route,body,status=200){
  const response=await fetch(origin+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
  const result=await response.json();
  assert.equal(response.status,status,JSON.stringify(result).slice(0,450));
  return result;
}
try{
  await until(()=>fetch(origin+'/api/health').then(res=>res.ok,()=>false),'本地服务');
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'旋转画布描边与数位笔验收',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  const op=(action,fields={})=>({op:'image',documentId:'design',action,...fields});
  doc=await api(paint+'/commands',{revision:doc.revision,operations:[op('create'),op('addLayer',{layerId:'ink',kind:'pixel'})]});
  const layer=()=>doc.paint.imageDocuments.design.layers[0];
  async function saved(label){
    const before=doc.revision;
    doc=await until(async()=>{const next=await api(route);return next.revision===before+1&&next;},label);
  }
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1540,height:920}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first(),canvas=editor.getByLabel('图像文档画布');
  const stage=editor.locator('.document-image-stage');
  await canvas.waitFor();
  async function numeric(scope,label,value){
    const field=scope.locator('input[aria-label="'+label+'"]').locator('..');
    await field.dblclick();
    const entry=field.getByRole('spinbutton',{name:'输入数值'});
    await entry.fill(String(value));await entry.press('Enter');
  }
  async function point(u,v){
    return canvas.evaluate((canvas,[u,v])=>{
      const rect=canvas.getBoundingClientRect(),matrix=new DOMMatrix(getComputedStyle(canvas).transform);
      const x=(u-.5)*canvas.offsetWidth,y=(v-.5)*canvas.offsetHeight;
      return [rect.left+rect.width/2+matrix.a*x+matrix.c*y,rect.top+rect.height/2+matrix.b*x+matrix.d*y];
    },[u,v]);
  }
  async function drag(from,to){
    const a=await point(...from),b=await point(...to);
    await page.mouse.move(...a);await page.mouse.down();
    await page.mouse.move(...b,{steps:6});await page.mouse.up();
  }
  const view=editor.getByRole('button',{name:'画布视图',exact:true});
  const dialog=editor.getByRole('dialog',{name:'画布视图',exact:true});
  await stage.focus();await page.keyboard.press('r');
  await editor.getByRole('button',{name:'旋转视图',exact:true,pressed:true}).waitFor();
  await stage.locator('xpath=self::*[@data-preview-size="4096"]').waitFor({timeout:65000});
  const rotateStart=await point(.72,.5),rotateEnd=await point(.5,.72);
  await page.keyboard.down('Shift');
  await page.mouse.move(...rotateStart);await page.mouse.down();
  await page.mouse.move(...rotateEnd,{steps:6});
  await stage.locator('.document-view-compass').waitFor();
  await page.screenshot({path:path.join(data,'rotate-view-compass.png')});
  await page.mouse.up();await page.keyboard.up('Shift');
  const turned=Number((await canvas.evaluate(el=>el.style.transform)).match(/rotate\(([-.0-9]+)deg\)/)?.[1]);
  assert.ok(turned>=75&&turned<=105&&turned%15===0,'旋转后吸附到接近 90° 的 15° 整倍数：'+turned);
  await view.click();await numeric(dialog,'视图角度',30);
  await dialog.getByRole('button',{name:'水平镜像视图',exact:true}).click();
  assert.match(await canvas.evaluate(el=>el.style.transform),/rotate\(30deg\) scale\(-1/);
  await page.keyboard.press('Escape');
  assert.equal((await api(route)).revision,doc.revision);

  await stage.focus();await page.keyboard.press('m');
  await drag([.25,.24],[.53,.46]);
  const overlay=stage.locator('.area-selection-overlay');
  await overlay.waitFor();
  const vertices=(await overlay.locator('polygon').first().getAttribute('points')).trim().split(/\s+/).map(p=>p.split(',').map(Number));
  const stageBox=await stage.boundingBox(),expected=await point(.25,.24);
  assert.ok(Math.hypot(vertices[0][0]+stageBox.x-expected[0],vertices[0][1]+stageBox.y-expected[1])<1.6);
  await stage.focus();await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+d');
  await page.keyboard.press('b');
  await editor.getByLabel('图像前景色',{exact:true}).fill('#e35629');
  await numeric(editor,'像素半径',80);
  const popup=editor.getByRole('button',{name:'笔尖参数',exact:true});
  const tips=editor.getByRole('dialog',{name:'笔尖参数',exact:true});
  await popup.click();
  await tips.getByRole('checkbox',{name:'压感不透明度',exact:true}).uncheck();
  await tips.getByRole('checkbox',{name:'压感大小',exact:true}).check();
  await page.keyboard.press('Escape');
  const cdp=await page.context().newCDPSession(page);
  async function pen(u,v){
    const [x,y]=await point(u,v),base={x,y,pointerType:'pen',button:'left'};
    await cdp.send('Input.dispatchMouseEvent',{...base,type:'mousePressed',buttons:1,clickCount:1,force:.25});
    await cdp.send('Input.dispatchMouseEvent',{...base,type:'mouseReleased',buttons:0,clickCount:1,force:0});
  }
  const strokeStart=await point(.34,.35),strokeEnd=await point(.34,.435);
  const penBase={pointerType:'pen',button:'left'};
  await cdp.send('Input.dispatchMouseEvent',{...penBase,x:strokeStart[0],y:strokeStart[1],type:'mousePressed',buttons:1,clickCount:1,force:.1});
  await cdp.send('Input.dispatchMouseEvent',{...penBase,x:strokeEnd[0],y:strokeEnd[1],type:'mouseMoved',buttons:1,force:.1});
  await cdp.send('Input.dispatchMouseEvent',{...penBase,x:strokeEnd[0],y:strokeEnd[1],type:'mouseReleased',buttons:0,clickCount:1,force:0});
  await saved('只用压感控制大小');
  assert.equal(layer().strokes[0].pressureMode,'size');
  assert.equal(layer().strokes[0].stamps[0][2],.1);
  await popup.click();
  await tips.getByRole('checkbox',{name:'压感大小',exact:true}).uncheck();
  await tips.getByRole('checkbox',{name:'压感不透明度',exact:true}).check();
  await page.keyboard.press('Escape');
  await pen(.55,.35);await saved('只用压感控制不透明度');
  assert.equal(layer().strokes[1].pressureMode,undefined);
  assert.equal(layer().strokes[1].stamps[0][2],.25);

  await popup.click();await numeric(tips,'平滑',85);await page.keyboard.press('Escape');
  await page.mouse.move(...await point(.48,.53));await page.mouse.wheel(0,-830);
  await until(()=>canvas.evaluate(c=>Math.abs(new DOMMatrix(getComputedStyle(c).transform).a)>1.7),'放大画布');
  const response=page.waitForResponse(r=>r.ok()&&r.url().endsWith('/image-live')&&
    r.request().postDataJSON()?.resolution===512&&r.request().postDataJSON()?.operation?.stroke?.stamps?.length>1);
  const raw=[[.41,.51],[.422,.525],[.434,.505],[.447,.521],[.461,.510],[.478,.523],[.49,.51]];
  await page.mouse.move(...await point(...raw[0]));await page.mouse.down();
  for(const uv of raw.slice(1))await page.mouse.move(...await point(...uv));
  const smoothResponse=await response;
  const smoothSize=smoothResponse.headers()['x-paint-window']?4096:512;
  await stage.locator('xpath=self::*[@data-preview-size="'+smoothSize+'"]').waitFor();
  await page.mouse.up();await saved('保存平滑笔触');
  const stamps=layer().strokes[2].stamps;
  assert.ok(stamps[1][1]>.5105&&stamps[1][1]<.523,JSON.stringify(stamps.slice(0,2)));
  assert.ok(Math.hypot(stamps.at(-1)[0]-.49,stamps.at(-1)[1]-.51)<.002);
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  await page.screenshot({path:path.join(data,'rotated-drawing-workspace.png')});

  async function exportImage(name){
    const file=path.join(data,name+'.png');
    const res=await fetch(origin+paint+'/image-export',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,documentId:'design'})});
    assert.equal(res.status,200,res.ok?'':await res.text());
    await fs.writeFile(file,Buffer.from(await res.arrayBuffer()));
    return file;
  }
  const file=await exportImage('brush-pressure');
  const pixels=JSON.parse(execFileSync(pythonExecutable(),['-B','-c',`
import json,sys
from PIL import Image
im=Image.open(sys.argv[1])
assert im.size==(4096,4096)
assert min(im.getpixel((int(.34*4096),y))[3] for y in range(int(.352*4096),int(.431*4096)))==255
print(json.dumps([im.getpixel((int(x*4096+dx),int(y*4096)))[3] for x,y,dx in [(.34,.35,0),(.34,.35,40),(.55,.35,0),(.55,.35,40),(.49,.51,0)]]))
`,file],{encoding:'utf8'}));
  assert.deepEqual(pixels,[255,0,64,64,255]);
  const library=page.locator('.editor-area[data-editor=library]').first();
  await library.getByRole('tab',{name:'笔刷',exact:true}).click();
  await library.getByLabel('更多资源操作',{exact:true}).click();
  await library.getByRole('button',{name:'保存当前',exact:true}).click();
  await saved('将当前绘制参数保存为笔刷');
  const brush=Object.values(doc.paint.brushes)[0].graph.nodes.find(node=>node.type==='brush').params;
  assert.equal(brush.uvRadius,80);
  assert.equal(brush.smoothing,85);
  assert.equal(brush.pressure,true);
  assert.equal(brush.pressureSize,false);

  await stage.focus();await page.keyboard.press('e');
  await numeric(editor,'像素半径',120);
  await page.mouse.click(...await point(.34,.35));await saved('镜像旋转视图下精确擦除');
  assert.equal(layer().strokes[3].erase,true);
  const erased=await exportImage('erase-in-oriented-view');
  const alpha=execFileSync(pythonExecutable(),['-B','-c',
    'from PIL import Image; import sys; print(Image.open(sys.argv[1]).getpixel((int(.34*4096),int(.35*4096)))[3])',erased],{encoding:'utf8'});
  assert.equal(alpha.trim(),'0');
  await stage.focus();await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+z');
  await saved('撤销擦除');
  assert.deepEqual(await fs.readFile(await exportImage('undo-erase')),await fs.readFile(file));

  await page.reload();await canvas.waitFor();
  assert.match(await canvas.evaluate(el=>el.style.transform),/rotate\(30deg\) scale\(-/);
  await view.click();await dialog.getByRole('button',{name:'复位视图方向',exact:true}).click();
  assert.match(await canvas.evaluate(el=>el.style.transform),/rotate\(0deg\) scale\([1-9]/);
  assert.equal((await api(route)).revision,doc.revision);
  assert.deepEqual(await fs.readFile(await exportImage('reset-view')),await fs.readFile(file));

  await stage.focus();await page.keyboard.press('b');
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await numeric(editor,'像素半径',120);
  await popup.click();
  await numeric(tips,'笔尖角度',45);await numeric(tips,'圆度',28);
  await tips.getByRole('textbox',{name:'笔刷名称',exact:true}).fill('机身纤维磨痕');
  await tips.getByRole('button',{name:'保存预设',exact:true}).click();
  await saved('保存椭圆笔尖预设');
  await tips.waitFor({state:'hidden'});
  const preset=Object.values(doc.paint.brushes).find(brush=>brush.name==='机身纤维磨痕');
  assert.equal(preset.graph.nodes[0].params.tipAngle,45);
  assert.equal(preset.graph.nodes[0].params.roundness,28);
  await page.mouse.click(...await point(.27,.67));await saved('绘制旋转椭圆笔尖');
  assert.equal(layer().strokes.at(-1).tip.angle,45);
  await popup.click();
  await numeric(tips,'纹理深度',90);await numeric(tips,'散布',90);
  await tips.getByRole('textbox',{name:'笔刷名称',exact:true}).fill('机身飞散磨损');
  await tips.getByRole('button',{name:'保存预设',exact:true}).click();
  await saved('保存散布纹理预设');
  await tips.waitFor({state:'hidden'});
  await drag([.50,.73],[.75,.73]);await saved('绘制有纹理的散布笔触');
  const scattered=layer().strokes.at(-1).tip;
  assert.deepEqual({...scattered,seed:0},{angle:45,roundness:.28,scatter:.9,grain:.9,seed:0});
  const finished=await exportImage('elliptical-and-grain');
  execFileSync(pythonExecutable(),['-B','-c',`
import numpy as np,sys
from PIL import Image
alpha=np.asarray(Image.open(sys.argv[1]))[:,:,3]
x,y=int(.27*4096),int(.67*4096)
assert alpha[y+52,x+52]>200,alpha[y+52,x+52]
assert alpha[y-52,x+52]==0,alpha[y-52,x+52]
texture=alpha[int(.66*4096):int(.80*4096),int(.45*4096):int(.81*4096)]
assert np.count_nonzero(texture)>20000
assert len(np.unique(texture[texture>0]))>80
assert np.count_nonzero(texture[:int(.047*4096)])>1000
`,finished],{stdio:'inherit'});
  await stage.focus();await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+z');
  await saved('撤销纹理笔触');
  assert.equal(layer().strokes.length,4);
  await stage.focus();await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+Shift+z');
  await saved('重做纹理笔触');
  assert.deepEqual(await fs.readFile(await exportImage('redo-grain')),await fs.readFile(finished));
  await page.reload();await canvas.waitFor();
  assert.deepEqual(await fs.readFile(await exportImage('reopened-grain')),await fs.readFile(finished));
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await library.getByRole('button',{name:'机身纤维磨痕',exact:true}).click();
  await popup.click();
  assert.equal(await tips.locator('input[aria-label="圆度"]').inputValue(),'28');
  assert.equal(await tips.locator('input[aria-label="散布"]').inputValue(),'0');
  assert.ok(await tips.evaluate(panel=>panel.scrollWidth<=panel.clientWidth+1),'笔尖参数弹层可完整显示所有控件');
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  await page.screenshot({path:path.join(data,'brush-tip-settings.png')});

  const tipFile=path.join(data,'双齿磨损笔尖.png'),grainFile=path.join(data,'交替明暗纹理.png');
  execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image,ImageDraw
import sys
tip=Image.new('RGBA',(96,48))
draw=ImageDraw.Draw(tip)
draw.rectangle((3,9,29,39),fill=(130,100,80,255))
draw.rectangle((65,14,93,33),fill=(140,130,160,255))
tip.save(sys.argv[1])
grain=Image.new('L',(64,64),255)
ImageDraw.Draw(grain).rectangle((0,0,31,63),fill=0)
grain.save(sys.argv[2])
`,tipFile,grainFile],{stdio:'inherit'});
  await numeric(tips,'笔尖角度',0);await numeric(tips,'圆度',100);
  await editor.locator('input[aria-label="选择图片笔尖文件"]').setInputFiles(tipFile);
  await saved('导入自定义笔尖');
  const tipId=Object.keys(doc.paint.assets).find(id=>doc.paint.assets[id].name==='双齿磨损笔尖.png');
  assert.ok(tipId);
  await editor.locator('input[aria-label="选择笔刷纹理文件"]').setInputFiles(grainFile);
  await saved('导入纹理');
  const grainId=Object.keys(doc.paint.assets).find(id=>doc.paint.assets[id].name==='交替明暗纹理.png');
  assert.ok(grainId);
  await numeric(tips,'纹理深度',100);
  await tips.getByRole('textbox',{name:'笔刷名称',exact:true}).fill('双齿纹理笔刷');
  await tips.getByRole('button',{name:'保存预设',exact:true}).click();
  await saved('保存自定义图片预设');
  await tips.waitFor({state:'hidden'});
  const customId=Object.keys(doc.paint.brushes).find(id=>doc.paint.brushes[id].name==='双齿纹理笔刷');
  assert.equal(doc.paint.brushes[customId].graph.nodes[0].params.tipAsset,tipId);
  assert.equal(doc.paint.brushes[customId].graph.nodes[0].params.textureAsset,grainId);
  await page.mouse.click(...await point(.32,.78));await saved('用双齿纹理绘制');
  assert.deepEqual(layer().brushSources,[tipId,grainId]);
  const paintCustom=await exportImage('custom-tip-and-texture');
  await stage.focus();await page.keyboard.press('e');
  await numeric(editor,'像素半径',120);
  await popup.click();await tips.getByRole('button',{name:'图片笔尖',exact:true}).click();
  await page.getByRole('option',{name:'双齿磨损笔尖.png',exact:true}).click();
  await numeric(tips,'笔尖角度',0);await numeric(tips,'圆度',100);
  await page.keyboard.press('Escape');
  await page.mouse.click(...await point(.32,.78));await saved('用同一笔尖擦除');
  const eraseCustom=await exportImage('custom-tip-erased');
  execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import sys,numpy as np
before,after=(np.asarray(Image.open(p))[:,:,3] for p in sys.argv[1:])
x,y=round(.32*4096),round(.78*4096)
assert before[y,x]==0
assert np.max(before[y-8:y+8,x-98:x-55])>230
assert np.max(before[y-8:y+8,x+54:x+95])>230
for col in range(x-90,x-58):
    if col%64<32 and 4<col%64<27:
        assert before[y,col]==0,(col,before[y,col])
assert np.count_nonzero(after[y-18:y+18,x-89:x-58])<np.count_nonzero(before[y-18:y+18,x-89:x-58])*.1
`,paintCustom,eraseCustom],{stdio:'inherit'});
  await stage.focus();await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+z');
  await saved('撤销自定义擦除');
  assert.deepEqual(await fs.readFile(await exportImage('custom-tip-undo')),await fs.readFile(paintCustom));
  await page.reload();await canvas.waitFor();
  assert.deepEqual(await fs.readFile(await exportImage('custom-tip-reopened')),await fs.readFile(paintCustom));
  const {item,state}=await api('/api/personal-library/save',{projectId:doc.id,projectRevision:doc.revision,
    revision:0,kind:'brushes',resourceId:customId});
  assert.deepEqual(Object.keys(item.assets).sort(),[tipId,grainId].sort());
  const other=await api('/api/projects',{workflowType:'pbr_paint',name:'从个人库复用笔刷',modelTemplate:'plane'},201);
  const imported=await api('/api/projects/'+other.id+'/paint/library-import',{revision:other.revision,libraryRevision:state.revision,id:item.id});
  assert.deepEqual(imported.document.paint.brushes[imported.resource.id].graph,doc.paint.brushes[customId].graph);
  assert.deepEqual(Object.keys(imported.document.paint.assets).sort(),[tipId,grainId].sort());
  assert.equal((await api(route)).revision,doc.revision);
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await library.getByRole('button',{name:'双齿纹理笔刷',exact:true}).click();
  await popup.click();
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  await page.screenshot({path:path.join(data,'custom-brush-workspace.png')});
  await page.keyboard.press('Escape');
  await stage.focus();await page.keyboard.press('m');
  await drag([.23,.635],[.31,.705]);
  await editor.locator('.document-selection-library>summary',{hasText:'修改选区'}).click();
  await editor.getByRole('button',{name:'从选区创建笔尖',exact:true}).click();
  await saved('从画布选区创建笔尖');
  const selectionTip=Object.values(doc.paint.assets).find(asset=>asset.name==='选区笔尖.png');
  assert.ok(selectionTip&&selectionTip.width<1024&&selectionTip.height<1024);
  await tips.waitFor();
  await tips.getByRole('textbox',{name:'笔刷名称',exact:true}).fill('选区磨痕');
  await tips.getByRole('button',{name:'保存预设',exact:true}).click();
  await saved('保存从选区取样的笔尖');
  await tips.waitFor({state:'hidden'});
  assert.equal(Object.values(doc.paint.brushes).find(brush=>brush.name==='选区磨痕').graph.nodes[0].params.tipAsset,selectionTip.id);
  await editor.getByRole('button',{name:'画笔',exact:true,pressed:true}).waitFor();
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await stage.focus();await page.keyboard.press((process.platform==='darwin'?'Meta':'Control')+'+d');
  const command=page.waitForResponse(r=>r.url().endsWith('/paint/commands')&&r.request().postDataJSON()?.operations?.[0]?.stroke?.tip?.tipAsset===selectionTip.id);
  await page.mouse.click(...await point(.79,.77));
  try{
    const result=await command;
    assert.ok(result.ok(),result.ok()?'':await result.text());
    await saved('使用从选区提取的笔尖');
  }catch(error){
    await page.screenshot({path:path.join(data,'selection-brush-error.png')});throw error;
  }
  assert.equal(layer().strokes.at(-1).tip.tipAsset,selectionTip.id);
  const defined=await exportImage('selection-defined-tip');
  execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import numpy as np,sys
pixels,earlier=(np.asarray(Image.open(p))[:,:,3] for p in sys.argv[1:])
x,y=round(.79*4096),round(.77*4096)
region=np.s_[y-100:y+100,x-100:x+100]
patch=pixels[region][earlier[region]==0]
assert np.count_nonzero(patch)>400
assert 10<patch.max()<200
`,defined,paintCustom],{stdio:'inherit'});
  const layerPanel=page.locator('.editor-area[data-editor=imageLayers]').first();
  await layerPanel.getByRole('button',{name:'添加蒙版',exact:true}).click();
  await saved('建立自定义笔尖蒙版');
  // With focus on the thumbnail, Space over the canvas should pan the view.
  const inkRow=layerPanel.locator('[data-image-layer-id=ink]');
  await inkRow.locator('.document-layer-select').click();
  await inkRow.locator('.document-layer-mask').click();
  const center=await point(.5,.5);
  await page.mouse.move(...center);
  await page.keyboard.down('Space');
  await editor.getByText('临时抓手',{exact:true}).waitFor();
  await page.mouse.down();await page.mouse.move(center[0]+27,center[1]+15,{steps:3});await page.mouse.up();
  await page.keyboard.up('Space');
  const shifted=await point(.5,.5);
  assert.ok(Math.abs(shifted[0]-center[0]-27)<1 && Math.abs(shifted[1]-center[1]-15)<1);
  assert.equal((await api(route)).revision,doc.revision);
  await canvas.focus();await page.keyboard.press('d');await page.keyboard.press('b');
  await editor.getByRole('button',{name:'笔尖参数',exact:true}).waitFor();
  await popup.click();await tips.getByRole('button',{name:'图片笔尖',exact:true}).click();
  await page.getByRole('option',{name:'双齿磨损笔尖.png',exact:true}).click();
  await numeric(tips,'笔尖角度',0);await numeric(tips,'圆度',100);await numeric(tips,'纹理深度',0);
  await page.keyboard.press('Escape');
  await numeric(editor,'像素半径',120);
  await page.mouse.click(...await point(.32,.78));await saved('使用自定义笔尖刷蒙版');
  assert.equal(layer().maskStrokes.at(-1).tip.tipAsset,tipId);
  const responseMask=await fetch(origin+paint+'/image-live',{method:'POST',headers,
    body:JSON.stringify({revision:doc.revision,documentId:'design',inspectMask:'ink',resolution:4096})});
  assert.ok(responseMask.ok,responseMask.ok?'':await responseMask.text());
  const mask=new Uint8Array(await responseMask.arrayBuffer()),x=Math.round(.32*4096),y=Math.round(.78*4096);
  const gray=(dx,dy)=>mask[4*((y+dy)*4096+x+dx)];
  assert.equal(gray(0,0),255);
  assert.ok(gray(-65,0)<32&&gray(65,0)<32);
  assert.deepEqual(layer().brushSources,[tipId,grainId,selectionTip.id]);

  const mod=process.platform==='darwin'?'Meta':'Control';
  await layerPanel.locator('[data-image-layer-id=ink] .document-layer-select').click();
  await view.click();
  await dialog.getByRole('button',{name:'复位视图方向',exact:true}).click();
  await page.keyboard.press('Escape');
  await editor.getByRole('button',{name:'实际像素',exact:true}).click();
  await stage.focus();await page.keyboard.press('m');
  const grid=1024;
  const col=518,line=526,left=(col+.5)/grid,right=(col+14.5)/grid,atY=(line+.5)/grid;
  await drag([left-3/grid,atY-5/grid],[right+3/grid,atY+5/grid]);
  await overlay.waitFor();
  await layerPanel.getByRole('button',{name:'新建像素层',exact:true}).click();
  await saved('建立近距离细节测试层');
  const detailLayer=()=>doc.paint.imageDocuments.design.layers.at(-1);
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await editor.getByLabel('图像前景色',{exact:true}).fill('#e35629');
  await popup.click();
  await tips.getByRole('button',{name:'图片笔尖',exact:true}).click();
  await page.getByRole('option',{name:'圆形',exact:true}).click();
  await numeric(tips,'圆度',100);await numeric(tips,'纹理深度',0);await numeric(tips,'散布',0);
  await page.keyboard.press('Escape');
  await numeric(editor,'像素半径',2);
  async function heldPreview(label,from,to,predicate){
    const requests=[];
    const record=request=>{
      if(request.url().endsWith('/image-live'))requests.push(request.postDataJSON());
    };
    page.on('request',record);
    // Superseded drafts may be cancelled after their headers arrive. Only
    // completed responses contain pixels the browser can inspect.
    const pending=page.waitForEvent('requestfinished',{predicate:async request=>{
      if(!request.url().endsWith('/image-live'))return false;
      const body=request.postDataJSON();
      if(!predicate(body.operation?.stroke))return false;
      const response=await request.response();
      return response?.ok()&&(body.resolution===4096||Boolean(response.headers()['x-paint-window']));
    }});
    try{
      await page.mouse.move(...await point(...from));await page.mouse.down();
      await page.mouse.move(...await point(...to),{steps:7});
      await pending;
      const pixel=()=>canvas.evaluate((c,[x,y])=>c.width===4096&&[...c.getContext('2d').getImageData(x,y,1,1).data],
        [Math.floor((col+4.5)*4096/grid),Math.floor((line+.5)*4096/grid)]);
      await until(async()=>{const p=await pixel();return p&&(label==='eraser'?p[3]===0:p[0]>190&&p[3]>128);},label+' 笔尖像素上屏');
      return pixel();
    }catch(error){
      await page.screenshot({path:path.join(data,'fine-'+label+'-error.png')});
      console.log(label,JSON.stringify(requests.slice(-5)));
      throw error;
    }finally{page.off('request',record);}
  }
  const ink=await heldPreview('brush',[left,atY],[right,atY],stroke=>!stroke?.erase&&stroke?.stamps?.at(-1)?.[0]>(left+right)/2);
  assert.ok(ink[0]>190&&ink[3]>128);
  await page.screenshot({path:path.join(data,'fine-stroke-while-drawing.png')});
  await page.mouse.up();await saved('保存近距离细笔触');
  assert.ok(detailLayer().strokes[0].clip);
  await editor.getByRole('button',{name:'橡皮擦',exact:true}).click();
  await popup.click();
  await tips.getByRole('button',{name:'图片笔尖',exact:true}).click();
  await page.getByRole('option',{name:'圆形',exact:true}).click();
  await numeric(tips,'圆度',100);await numeric(tips,'纹理深度',0);await numeric(tips,'散布',0);
  await page.keyboard.press('Escape');
  await numeric(editor,'硬度',100);
  await numeric(editor,'流量',100);
  await numeric(editor,'不透明度',100);
  await numeric(editor,'像素半径',3);
  const erasedPreview=await heldPreview('eraser',[left+4/grid,atY],[left,atY],stroke=>stroke?.erase===true&&stroke.stamps?.length>1);
  assert.equal(erasedPreview[3],0);
  await page.mouse.up();await saved('保存近距离擦除');
  assert.ok(detailLayer().strokes[1].clip);
  await editor.getByRole('button',{name:'仿制图章',exact:true}).click();
  const source=[right-2/grid,atY];
  await page.keyboard.down('Alt');await page.mouse.click(...await point(...source));await page.keyboard.up('Alt');
  await stage.locator('.document-clone-source').waitFor();
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await editor.getByRole('button',{name:'仿制图章',exact:true}).click();
  await stage.locator('.document-clone-source').waitFor();
  await numeric(editor,'像素半径',3);
  const cloned=await heldPreview('clone',[left+4/grid,atY],[left+2/grid,atY],stroke=>!!stroke?.clone);
  assert.ok(cloned[0]>190&&cloned[3]>128);
  await page.mouse.up();await saved('保存近距离仿制');
  assert.ok(detailLayer().strokes[2].clip);
  assert.ok(Math.abs(detailLayer().strokes[2].clone.offset[0]-8/grid)<.001);
  await stage.focus();await page.keyboard.press(mod+'+z');await saved('撤销细节仿制');
  assert.equal(detailLayer().strokes.length,2);
  await stage.focus();await page.keyboard.press(mod+'+Shift+z');await saved('重做细节仿制');
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  assert.deepEqual(errors,[]);
  console.log('PASS oriented canvas, independent pressure, native brush/eraser/clone pixels, custom tips, presets, and reopen:',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
