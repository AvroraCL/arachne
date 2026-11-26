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
import {paragraphOrigin} from '../public/image-text-style.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-image-text-'));
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
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'涂装标题与编号',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  doc=await api(paint+'/commands',{revision:doc.revision,operations:[{op:'image',action:'create',documentId:'design'}]});
  const layers=()=>doc.paint.imageDocuments.design.layers;
  async function saved(label){
    const before=doc.revision;
    doc=await until(async()=>{const next=await api(route);return next.revision===before+1&&next;},label);
  }
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1580,height:960}}),errors=[];
  page.on('pageerror',error=>{errors.push(error.message);console.error(error);});
  await page.goto(base+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first(),canvas=editor.getByLabel('图像文档画布');
  const stage=editor.locator('.document-image-stage'),input=editor.getByRole('textbox',{name:'画布文字',exact:true});
  const stack=page.locator('.editor-area[data-editor=imageLayers]').first();
  const properties=page.getByRole('dialog',{name:'编辑文字',exact:true});
  const modifier=process.platform==='darwin'?'Meta':'Control';
  const textTool=editor.getByRole('button',{name:'文字工具',exact:true});
  const waitCanvas=()=>stage.locator('xpath=self::*[@data-preview-size="4096"]').waitFor({timeout:65000});
  await canvas.waitFor();await waitCanvas();
  const point=async ([x,y])=>{const b=await canvas.boundingBox();return [b.x+x*b.width,b.y+y*b.height];};
  await textTool.click();
  const a=await point([.19,.17]),b=await point([.51,.37]);
  await page.mouse.move(...a);await page.mouse.down();
  await page.mouse.move(...b,{steps:8});await page.mouse.up();
  await input.waitFor();
  assert.equal(await editor.locator('.document-inline-text').getAttribute('data-paragraph'),'');
  await input.fill('晨星试验涂装\nAURORA FLIGHT SYSTEMS RESEARCH');
  await input.press(modifier+'+Enter');await saved('在画布上提交段落');
  const titleId=layers()[0].id;
  const title=()=>layers().find(layer=>layer.id===titleId);
  assert.ok(Math.abs(title().text.box.width-.32*4096)<12);
  assert.ok(Math.abs(title().text.box.height-.2*4096)<12);
  assert.equal(title().text.font,'sourceHan');
  assert.match(title().text.content,/晨星/);
  const paragraphPoint=layer=>{
    const asset=doc.paint.assets[layer.asset];
    const point=paragraphOrigin(layer.text).map((value,i)=>value/(i?asset.height:asset.width));
    return imagePlacement(layer,doc.paint.assets).toCanvas(warpPoint(layer.warp,point));
  };
  const initialParagraph=paragraphPoint(title());
  const initialScreen=await point(initialParagraph);
  assert.ok(Math.hypot(initialScreen[0]-a[0],initialScreen[1]-a[1])<2);

  await page.mouse.click(...await point([.64,.27]));
  await input.fill('071');await input.press(modifier+'+Enter');await saved('在画布上输入编号');
  const numberId=layers().find(layer=>layer.id!==titleId).id;
  const number=()=>layers().find(layer=>layer.id===numberId);
  assert.equal(number().text.box,undefined);
  const numberAnchor=()=>{
    const layer=number(),asset=doc.paint.assets[layer.asset];
    return imagePlacement(layer,doc.paint.assets).toCanvas(warpPoint(layer.warp,
      layer.textOrigin.map((n,i)=>n/(i?asset.height:asset.width)),false,true));
  };
  const initialNumberAnchor=numberAnchor();
  const stableNumberAnchor=()=>assert.ok(numberAnchor().every((n,i)=>Math.abs(n-initialNumberAnchor[i])<1e-8));
  async function styleDialog(){
    await editor.getByRole('button',{name:'文字设置…',exact:true}).click();
    await properties.waitFor();
  }
  await styleDialog();
  await properties.getByRole('button',{name:'字体',exact:true}).click();
  await page.getByRole('option',{name:'IBM Plex Mono',exact:true}).click();
  await properties.locator('input[name=fontSize]').fill('176');
  await properties.locator('input[name=tracking]').fill('24');
  await properties.locator('input[name=leading]').fill('200');
  await properties.getByRole('checkbox',{name:'启用描边',exact:true}).check();
  await properties.getByRole('spinbutton',{name:'宽度',exact:true}).fill('12');
  await properties.getByRole('checkbox',{name:'启用投影',exact:true}).check();
  await properties.getByRole('spinbutton',{name:'偏移 X',exact:true}).fill('28');
  await properties.getByRole('checkbox',{name:'启用颜色叠加',exact:true}).check();
  await properties.getByLabel('叠加颜色',{exact:true}).fill('#f4d477');
  await properties.getByRole('button',{name:'应用',exact:true}).click();await saved('保存等宽字体和图层样式');
  assert.equal(number().text.font,'plexMono');assert.equal(number().text.tracking,24);
  assert.equal(number().text.leading,200);assert.equal(number().text.effects.outline.width,12);
  assert.equal(number().text.effects.shadow.x,28);assert.equal(number().text.effects.overlay.color,'#f4d477');
  stableNumberAnchor();

  await page.mouse.click(...await point([number().x,number().y]));
  await input.waitFor();assert.equal(await input.inputValue(),'071');
  await input.fill('999');await input.press('Escape');
  assert.equal((await api(route)).revision,doc.revision);
  await page.mouse.click(...await point([number().x,number().y]));
  await input.fill('073');await input.press(modifier+'+Enter');await saved('保留样式并修改编号');
  assert.equal(number().text.content,'073');
  assert.equal(number().text.effects.outline.width,12);
  assert.equal(number().text.effects.overlay.color,'#f4d477');
  stableNumberAnchor();
  const styledNumber=structuredClone(number());
  await canvas.focus();await page.keyboard.press(modifier+'+z');await saved('撤销编号编辑');
  assert.equal(number().text.content,'071');
  await canvas.focus();await page.keyboard.press(modifier+'+Shift+z');await saved('重做编号编辑');
  assert.deepEqual(number(),styledNumber);
  await styleDialog();
  await properties.getByRole('checkbox',{name:'启用渐变叠加',exact:true}).check();
  await properties.getByRole('spinbutton',{name:'渐变角度',exact:true}).fill('0');
  await properties.getByRole('button',{name:'应用',exact:true}).click();await saved('设置渐变叠加');
  assert.equal(number().text.effects.gradient.angle,0);
  assert.equal(number().text.effects.overlay.color,'#f4d477');

  await stack.locator('[data-image-layer-id="'+titleId+'"] .document-layer-select').click();
  await styleDialog();
  await properties.locator('input[name=color]').fill('#f0eddd');
  await properties.locator('input[name=tracking]').fill('7');
  await properties.locator('input[name=leading]').fill('220');
  await properties.getByRole('checkbox',{name:'启用投影',exact:true}).check();
  await properties.getByRole('spinbutton',{name:'偏移 X',exact:true}).fill('-26');
  await properties.getByRole('spinbutton',{name:'偏移 Y',exact:true}).fill('-18');
  await properties.getByRole('button',{name:'应用',exact:true}).click();await saved('调整标题字距与行距');
  assert.equal(title().text.leading,220);
  assert.deepEqual(paragraphPoint(title()),initialParagraph);
  const oldBox=structuredClone(title().text.box);
  await page.mouse.click(...await point([title().x,title().y]));
  await input.waitFor();
  const formOrigin=async()=>{
    const local=await editor.locator('.document-inline-text').evaluate(node=>{
      const p=new DOMMatrix(node.style.transform).transformPoint(new DOMPoint(0,0));
      return [p.x/p.w,p.y/p.w];
    });
    const bounds=await stage.boundingBox();
    return [bounds.x+local[0],bounds.y+local[1]];
  };
  const start=await formOrigin();
  assert.ok(Math.hypot(start[0]-initialScreen[0],start[1]-initialScreen[1])<1.5);
  await page.screenshot({path:path.join(data,'inline-paragraph.png')});
  const handle=await editor.locator('.document-inline-text-resize').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();
  await page.mouse.move(handle.x+handle.width/2-12,handle.y+handle.height/2+14,{steps:6});await page.mouse.up();
  const draftBox=await editor.locator('.document-inline-text').evaluate(el=>[parseInt(el.style.width),parseInt(el.style.height)]);
  assert.ok(draftBox[0]<oldBox.width-40&&draftBox[1]>oldBox.height+45,JSON.stringify(draftBox));
  await input.press(modifier+'+Enter');await saved('拖动调整段落框');
  assert.ok(title().text.box.width<oldBox.width-40&&title().text.box.height>oldBox.height+45);
  assert.equal(title().text.leading,220);
  assert.deepEqual(paragraphPoint(title()),initialParagraph);
  await canvas.focus();await page.keyboard.press(modifier+'+z');await saved('撤销段落框尺寸修改');
  assert.deepEqual(title().text.box,oldBox);
  await canvas.focus();await page.keyboard.press(modifier+'+Shift+z');await saved('重做段落框尺寸修改');
  assert.deepEqual(paragraphPoint(title()),initialParagraph);
  const beforeReopen=structuredClone(layers());
  const png=path.join(data,'styled-title-and-number.png');
  const response=await fetch(base+paint+'/image-export',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,documentId:'design'})});
  assert.equal(response.status,200);
  await fs.writeFile(png,Buffer.from(await response.arrayBuffer()));
  execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import numpy as np, sys
image=Image.open(sys.argv[1])
assert image.size==(4096,4096) and image.mode=='RGBA'
title=np.asarray(image.crop((700,670,2150,1650)))
number=np.asarray(image.crop((2400,850,3200,1450)))
assert np.count_nonzero(title[:,:,3]>200)>3000
rows=(title[:,:,3]>128).any(axis=1)
assert np.count_nonzero(np.diff(rows.astype(np.int8))==1)>=3
solid=number[number[:,:,3]==255,:3]
assert np.any(np.all(solid==[21,23,26],axis=1))
gradient=solid[(solid[:,0]>230)&(solid[:,1]>80)]
assert len(np.unique(gradient[:,1]))>40
assert np.count_nonzero((number[:,:,3]>0)&(number[:,:,3]<150))>500
`,png],{stdio:'inherit'});
  await page.reload();await canvas.waitFor();await waitCanvas();
  assert.deepEqual((await api(route)).paint.imageDocuments.design.layers,beforeReopen);
  await page.screenshot({path:path.join(data,'drawing-typography.png')});
  const imgOp=(action,fields)=>({op:'image',action,documentId:'design',...fields});
  const paragraphWarp={mode:'perspective',points:[[0,.08],[1,0],[.93,1],[.08,.94]]};
  doc=await api(paint+'/commands',{revision:doc.revision,operations:[
    imgOp('updateLayer',{layerId:titleId,patch:{rotation:12,warp:paragraphWarp}})
  ]});
  await page.reload();await stack.locator('[data-image-layer-id="'+titleId+'"] .document-layer-select').click();
  await textTool.click();
  const warpedStart=paragraphPoint(title()),warpedStartScreen=await point(warpedStart);
  const titlePlacement=imagePlacement(title(),doc.paint.assets);
  await page.mouse.click(...await point(titlePlacement.toCanvas(warpPoint(paragraphWarp,[.35,.45]))));
  await input.waitFor();
  const positioned=await formOrigin();
  assert.ok(Math.hypot(positioned[0]-warpedStartScreen[0],positioned[1]-warpedStartScreen[1])<1.5);
  const warpedHandle=await editor.locator('.document-inline-text-resize').boundingBox();
  await page.mouse.move(warpedHandle.x+warpedHandle.width/2,warpedHandle.y+warpedHandle.height/2);await page.mouse.down();
  await page.mouse.move(warpedHandle.x+warpedHandle.width/2+14,warpedHandle.y+warpedHandle.height/2+8,{steps:6});await page.mouse.up();
  const priorWidth=title().text.box.width;
  await input.press(modifier+'+Enter');await saved('在透视位置调整段落框');
  assert.ok(title().text.box.width>priorWidth+30);
  assert.ok(paragraphPoint(title()).every((value,index)=>Math.abs(value-warpedStart[index])<1e-8));
  assert.deepEqual(title().warp,paragraphWarp);
  assert.deepEqual(title().text.effects,beforeReopen.find(layer=>layer.id===titleId).text.effects);
  await canvas.focus();await page.keyboard.press(modifier+'+z');await saved('撤销透视段落框修改');
  assert.equal(title().text.box.width,priorWidth);
  await canvas.focus();await page.keyboard.press(modifier+'+z');await saved('撤销段落透视');
  assert.deepEqual(layers(),beforeReopen);
  async function warpNumber(warp){
    doc=await api(paint+'/commands',{revision:doc.revision,operations:[
      imgOp('updateLayer',{layerId:numberId,patch:{x:.62,y:.29,rotation:16,warp}})
    ]});
    await page.reload();
    await stack.locator('[data-image-layer-id="'+numberId+'"] .document-layer-select').click();
    await textTool.click();
  }
  const perspective={mode:'perspective',points:[[1.14,.04],[2.02,.1],[1.94,1],[1.26,1]]};
  const placedCenter=()=>imagePlacement(number(),doc.paint.assets).toCanvas(warpPoint(number().warp,[.5,.5]));
  await warpNumber(perspective);
  const center=placedCenter();
  assert.ok(imagePlacement(number(),doc.paint.assets).toLayer(center)[0]>1);
  await page.mouse.click(...await point(center));
  await input.waitFor();
  assert.equal(await input.inputValue(),'073');
  const form=editor.locator('.document-inline-text');
  const corners=await form.evaluate(node=>{
    const matrix=new DOMMatrix(node.style.transform);
    return [[0,0],[node.offsetWidth,0]].map(([x,y])=>{
      const p=matrix.transformPoint(new DOMPoint(x,y));
      return [p.x/p.w,p.y/p.w];
    });
  });
  const stageBox=await stage.boundingBox(),placement=imagePlacement(number(),doc.paint.assets);
  const ink=doc.paint.assets[number().asset],origin=number().textOrigin;
  for(let i=0;i<2;i++){
    const expected=await point(placement.toCanvas(warpPoint(perspective,[origin[0]/ink.width+i,origin[1]/ink.height],false,true)));
    assert.ok(Math.hypot(expected[0]-stageBox.x-corners[i][0],expected[1]-stageBox.y-corners[i][1])<1.5);
  }
  await page.screenshot({path:path.join(data,'inline-perspective-number.png')});
  const beforeWarpText=structuredClone(number()),beforeWarpAnchor=numberAnchor();
  await input.fill('A-073-L');
  await input.press(modifier+'+Enter');await saved('在透视位置改长编号');
  assert.equal(number().text.content,'A-073-L');
  assert.deepEqual(number().warp,perspective);
  assert.deepEqual(number().text.effects,beforeWarpText.text.effects);
  assert.ok(numberAnchor().every((value,i)=>Math.abs(value-beforeWarpAnchor[i])<1e-8));
  await canvas.focus();await page.keyboard.press(modifier+'+z');await saved('撤销透视文字编辑');
  assert.deepEqual(number(),beforeWarpText);
  await canvas.focus();await page.keyboard.press(modifier+'+Shift+z');await saved('重做透视文字编辑');
  assert.equal(number().text.content,'A-073-L');
  const mesh={mode:'mesh',points:[[1.1,0],[1.6,0],[2.1,0],[1.1,.5],[1.72,.62],[2.1,.5],[1.1,1],[1.6,1],[2.1,1]]};
  await warpNumber(mesh);
  await page.mouse.click(...await point(placedCenter()));
  await input.waitFor();
  assert.equal(await input.inputValue(),'A-073-L');
  await editor.getByText('在输入框修改文字，画布实时预览网格变形',{exact:true}).waitFor();
  const draftResponse=content=>page.waitForResponse(response=>response.url().endsWith('/image-live')&&
    response.request().postDataJSON()?.textDraft?.content===content);
  async function previewText(content){
    const response=draftResponse(content);
    await input.fill(content);
    const rendered=await response;
    assert.equal(rendered.status(),200,rendered.ok()?'':await rendered.text());
    const size=Number(rendered.headers()['x-paint-resolution']);
    const pixels=await rendered.body();
    assert.equal(pixels.length,size*size*4);
    return {size,pixels};
  }
  const snapshot=structuredClone(number());
  const assetsPath=path.join(data,'projects',doc.id,'assets');
  const originalFiles=(await fs.readdir(assetsPath)).sort();
  const cancelled=await previewText('099');
  assert.equal((await api(route)).revision,doc.revision);
  await input.press('Escape');
  assert.deepEqual((await api(route)).paint.imageDocuments.design.layers.find(layer=>layer.id===numberId),snapshot);
  await page.mouse.click(...await point(placedCenter()));
  await input.waitFor();assert.equal(await input.inputValue(),'A-073-L');
  const ime=await page.context().newCDPSession(page);
  const compositionResponse=draftResponse('晨');
  await ime.send('Input.imeSetComposition',{text:'chen',selectionStart:4,selectionEnd:4});
  await input.press(modifier+'+Enter');
  assert.equal((await api(route)).revision,doc.revision);
  await ime.send('Input.insertText',{text:'晨'});
  const composed=await compositionResponse;
  assert.equal(composed.status(),200,composed.ok()?'':await composed.text());
  await ime.detach();
  const draft=await previewText('073');
  assert.equal(draft.size,cancelled.size);
  assert.notDeepEqual(draft.pixels,cancelled.pixels);
  assert.deepEqual((await fs.readdir(assetsPath)).sort(),originalFiles);
  await page.screenshot({path:path.join(data,'mesh-number-live.png')});
  await input.press(modifier+'+Enter');await saved('在网格变形后恢复编号');
  assert.equal(number().text.content,'073');
  assert.deepEqual(number().warp,mesh);
  assert.deepEqual(number().text.effects,beforeWarpText.text.effects);
  const committed=await fetch(base+paint+'/image-live',{method:'POST',headers,body:JSON.stringify({
    revision:doc.revision,documentId:'design',resolution:draft.size
  })});
  assert.equal(committed.status,200);
  assert.deepEqual(Buffer.from(await committed.arrayBuffer()),draft.pixels);
  await page.reload();await canvas.waitFor();await waitCanvas();
  assert.deepEqual((await api(route)).paint.imageDocuments.design.layers.find(layer=>layer.id===numberId),number());
  doc=await api(paint+'/commands',{revision:doc.revision,operations:[
    imgOp('addLayer',{layerId:'under',kind:'pixel',patch:{name:'底色明暗带'}}),
    imgOp('stroke',{layerId:'under',target:'pixels',stroke:{uv:true,rect:[.1,.65,.3,.9],color:'#101010',opacity:1,erase:false}}),
    imgOp('stroke',{layerId:'under',target:'pixels',stroke:{uv:true,rect:[.3,.65,.5,.9],color:'#808080',opacity:1,erase:false}}),
    imgOp('stroke',{layerId:'under',target:'pixels',stroke:{uv:true,rect:[.5,.65,.7,.9],color:'#f0f0f0',opacity:1,erase:false}}),
    imgOp('addLayer',{layerId:'tones',kind:'pixel',patch:{name:'涂装衬色'}}),
    imgOp('stroke',{layerId:'tones',target:'pixels',stroke:{uv:true,rect:[.1,.65,.9,.9],color:'#ff0000',opacity:1,erase:false}})
  ]});
  await page.reload();await canvas.waitFor();await waitCanvas();
  await stack.locator('[data-image-layer-id=tones] .document-layer-select').click();
  const props=page.locator('.editor-area[data-editor=imageProperties]').first();
  await props.locator('summary',{hasText:'明暗混合'}).click();
  async function toneField(label,n,action='Enter'){
    const field=props.locator('input[aria-label="'+label+'"]').locator('..');
    await field.dblclick();
    const editor=field.getByRole('spinbutton',{name:'输入数值'});
    await editor.fill(String(n));await editor.press(action);
    if(action==='Enter')await saved('设置'+label);
  }
  await toneField('下方图层 · 暗部全显',180);
  await toneField('下方图层 · 暗部隐藏',32);
  await toneField('下方图层 · 亮部全显',210);
  await toneField('下方图层 · 亮部隐藏',230);
  await toneField('本图层 · 暗部全显',25,'Escape');
  assert.equal((await api(route)).revision,doc.revision);
  async function samples(){
    const res=await fetch(base+paint+'/image-export',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,documentId:'design'})});
    assert.equal(res.status,200);
    const file=path.join(data,'blend-if.png');
    await fs.writeFile(file,Buffer.from(await res.arrayBuffer()));
    return JSON.parse(execFileSync(pythonExecutable(),['-B','-c',
      'import json,sys; from PIL import Image; im=Image.open(sys.argv[1]); print(json.dumps([im.getpixel((int(u*4096),3200)) for u in [.2,.4,.6,.8]]))',
      file],{encoding:'utf8'}));
  }
  const tones=await samples();
  assert.deepEqual([tones[0],tones[2],tones[3]],[[16,16,16,255],[240,240,240,255],[255,0,0,255]]);
  const linearGray=((128/255+.055)/1.055)**2.4,weight=(128-32)/(180-32);
  const srgb=n=>Math.round(255*(1.055*n**(1/2.4)-.055));
  assert.deepEqual(tones[1],[srgb(weight+linearGray*(1-weight)),srgb(linearGray*(1-weight)),srgb(linearGray*(1-weight)),255]);
  await canvas.focus();await page.keyboard.press(modifier+'+z');await saved('撤销亮部阈值');
  assert.notDeepEqual(await samples(),tones);
  await canvas.focus();await page.keyboard.press(modifier+'+Shift+z');await saved('重做亮部阈值');
  assert.deepEqual(await samples(),tones);
  await page.reload();await canvas.waitFor();await waitCanvas();
  assert.deepEqual(await samples(),tones);
  await stack.locator('[data-image-layer-id=tones] .document-layer-select').click();
  await page.screenshot({path:path.join(data,'tone-range-workspace.png')});
  await editor.getByRole('button',{name:'应用至材质',exact:true}).click();
  await saved('绑定涂装设计到模型');
  const binding=doc.paint.layers.find(layer=>layer.documentMaps?.color==='design');
  assert.ok(binding);
  async function materialScreenshot(name){
    await page.locator('[data-area-mode=material]').click();
    const area=page.locator('.editor-area[data-editor=viewport]').first();
    await area.locator('.editor-viewport[data-state=ready]').waitFor({timeout:65000});
    await area.locator('.editor-viewport canvas').focus();
    await page.keyboard.press('Numpad7');
    const view=area.locator('.editor-viewport[data-rendered-paint-revision="'+doc.revision+'"][data-rendered-paint-resolution="4096"][data-rendered-paint-draft=false]');
    await view.waitFor({timeout:65000});
    await delay(450);
    const shot=await view.screenshot({path:path.join(data,name+'.png')});
    return shot;
  }
  const previewBefore=await materialScreenshot('material-title-073');
  await page.locator('[data-area-mode=drawing]').click();
  await page.locator('.editor-area[data-editor=imageProperties]').first().getByRole('button',{name:'编辑器类型',exact:true}).click();
  await page.getByRole('option',{name:'UV 编辑器',exact:true}).click();
  await page.getByLabel('UV 画布',{exact:true}).waitFor();
  await canvas.waitFor();await waitCanvas();
  await stack.locator('[data-image-layer-id="'+numberId+'"] .document-layer-select').click();
  await textTool.click();
  await page.mouse.click(...await point(placedCenter()));
  const materialDraft=page.waitForResponse(r=>r.url().endsWith('/paint/live')&&r.request().postDataJSON()?.textDraft?.content==='780');
  await input.fill('780');
  const reply=await materialDraft;
  assert.equal(reply.status(),200,reply.ok()?'':await reply.text());
  const draftPixels=await reply.body(),request=reply.request().postDataJSON();
  const {textDraft,documentId,...settings}=request;
  const materialPixels=async revision=>{
    const r=await fetch(base+paint+'/live',{method:'POST',headers,body:JSON.stringify({...settings,revision})});
    assert.equal(r.status,200);
    return Buffer.from(await r.arrayBuffer());
  };
  assert.equal((await api(route)).revision,doc.revision);
  assert.notDeepEqual(draftPixels,await materialPixels(doc.revision));
  await input.press(modifier+'+Enter');
  await saved('检查模型后返回修改编号');
  assert.equal(number().text.content,'780');
  assert.deepEqual(await materialPixels(doc.revision),draftPixels);
  assert.deepEqual(number().text.effects,{...styledNumber.text.effects,gradient:{start:'#ffffff',end:'#ec672c',angle:0}});
  assert.equal(doc.paint.layers.find(layer=>layer.id===binding.id).documentMaps.color,'design');
  const previewAfter=await materialScreenshot('material-title-780');
  assert.notDeepEqual(previewAfter,previewBefore);
  assert.deepEqual(errors,[]);
  console.log('PASS inline point/paragraph text, perspective and mesh, styled pixels, tonal blending, undo/redo, reopen and live material round trip:',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
