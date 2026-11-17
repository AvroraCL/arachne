import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {pythonExecutable} from '../python-runtime.mjs';
import {paragraphOrigin} from '../public/image-text-style.mjs';
import {imagePlacement,warpPoint} from '../public/image-warp.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-image-creative-'));
const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');
const port=socket.address().port,base='http://127.0.0.1:'+port;
await new Promise(resolve=>socket.close(resolve));
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:new URL('..',import.meta.url),stdio:'inherit',
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',PYTHONDONTWRITEBYTECODE:'1'}});
let browser;
const headers={Origin:base,'Content-Type':'application/json'};
const request=(route,body)=>fetch(base+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
async function api(route,body,status=200){
  const response=await request(route,body),value=await response.json();
  assert.equal(response.status,status,JSON.stringify(value).slice(0,400));return value;
}
async function until(read,label){
  for(let i=0;i<500;i++){const result=await read();if(result)return result;await delay(100);}
  throw Error('等待超时 '+label);
}
const op=(action,fields={})=>({op:'image',documentId:'design',action,...fields});
const update=(layerId,patch)=>op('updateLayer',{layerId,patch});
const python=(code,...args)=>execFileSync(pythonExecutable(),['-B','-c',code,...args],{encoding:'utf8'});
try{
  await until(()=>fetch(base+'/api/health').then(r=>r.ok,()=>false),'临时服务');
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'涂装工坊 · 第二轮创作',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  const commands=async(...operations)=>{doc=await api(paint+'/commands',{revision:doc.revision,operations});};
  const saved=async label=>{const rev=doc.revision;doc=await until(async()=>{const d=await api(route);return d.revision>rev&&d;},label);};
  const layer=id=>doc.paint.imageDocuments.design.layers.find(l=>l.id===id);
  const body=fields=>({revision:doc.revision,documentId:'design',...fields});
  const exportPng=async name=>{
    const res=await request(paint+'/image-export',body());
    assert.equal(res.status,200,res.ok?'':await res.text());
    const file=path.join(data,name+'.png');
    await fs.writeFile(file,Buffer.from(await res.arrayBuffer()));return file;
  };
  const markFile=path.join(data,'logo.png');
  python(`from PIL import Image,ImageDraw,ImageFilter
import sys
logo=Image.new('RGBA',(768,512))
d=ImageDraw.Draw(logo)
d.polygon([(24,460),(206,58),(414,58),(646,460),(524,460),(436,312),(204,312),(144,460)],fill='#178eb3')
d.rectangle((278,130,360,238),fill='#faf8ee')
d.ellipse((530,98,680,248),fill='#fc8e2d')
logo.save(sys.argv[1])
tip=Image.new('L',(128,128),255)
ImageDraw.Draw(tip).ellipse((15,40,111,87),fill=0)
tip.filter(ImageFilter.GaussianBlur(3)).save(sys.argv[2])`,markFile,path.join(data,'tip.png'));
  await commands(op('create'),op('addLayer',{layerId:'paint',kind:'pixel',patch:{name:'修补'}}));
  const imported=await api(paint+'/assets',{revision:doc.revision,name:'透明标志',data:(await fs.readFile(markFile)).toString('base64'),
    imageLayer:{documentId:'design',layerId:'logo',x:.5,y:.5,scale:.28}},201);
  doc=imported.document;
  const logo=doc.paint.imageDocuments.design.layers.find(l=>l.kind==='image').id;
  const fontPath=process.env.ARACHNE_TEST_TTF??new URL('../public/fonts/ibm-plex-mono/IBMPlexMono-Bold.ttf',import.meta.url).pathname;
  const fontBytes=await fs.readFile(decodeURI(fontPath));
  const font=await api(paint+'/fonts',{revision:doc.revision,name:path.basename(fontPath),data:fontBytes.toString('base64')},201);doc=font.document;
  assert.equal(doc.paint.textFonts[font.id].weight,700);
  const reached=await request(paint+'/fonts/'+font.id);
  assert.equal(reached.headers.get('content-type'),'font/ttf');
  assert.deepEqual(Buffer.from(await reached.arrayBuffer()),fontBytes);
  const style={content:'AURORA 071',font:font.id,fontSize:144,weight:700,align:'left',color:'#ffffff',tracking:8,leading:175,box:{width:1100,height:324}};
  const text=await api(paint+'/text',body({text:style,placement:{x:.38,y:.32,anchor:'start'}}),201);doc=text.document;
  const title=text.layerId,boxAnchor=()=>{
    const item=layer(title),png=doc.paint.assets[item.asset];
    return imagePlacement(item,doc.paint.assets).toCanvas(paragraphOrigin(item.text).map((n,i)=>n/(i?png.height:png.width)));
  };
  const position=boxAnchor();
  const customPng=layer(title).asset;
  const builtin=await api(paint+'/text',body({layerId:title,text:{...style,content:'阿拉克涅 071',font:'sourceHan',weight:500}}),201);doc=builtin.document;
  assert.notEqual(layer(title).asset,customPng);
  assert.deepEqual(boxAnchor(),position);
  const invalid=await api(paint+'/text',body({layerId:title,text:{...style,content:'阿拉克涅 071'}}),400);
  assert.match(invalid.error,/缺少字形/);

  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1580,height:960}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first(),stage=editor.locator('.document-image-stage');
  const panel=page.locator('.editor-area[data-editor=imageLayers]').first();
  const properties=page.locator('.editor-area[data-editor=imageProperties]').first();
  const canvas=editor.getByLabel('图像文档画布');
  const row=id=>panel.locator('[data-image-layer-id="'+id+'"]');
  const select=id=>row(id).locator('.document-layer-select').click();
  const choose=async(name,option,scope=editor)=>{
    await scope.getByRole('button',{name,exact:true}).click();
    await scope.page().getByRole('option',{name:option,exact:true}).click();
  };
  const wait4K=()=>stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  const point=async(x,y)=>{const b=await canvas.boundingBox();return [b.x+x*b.width,b.y+y*b.height];};
  await canvas.waitFor();await wait4K();
  await select(title);
  await properties.getByRole('button',{name:'编辑文字…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'编辑文字',exact:true});
  if(process.env.ARACHNE_TEST_OTF){
    await dialog.getByLabel('添加工程字体',{exact:true}).setInputFiles(process.env.ARACHNE_TEST_OTF);
    await saved('通过文字工具添加 OTF');
    const added=Object.entries(doc.paint.textFonts).find(([,entry])=>entry.file.endsWith('.otf'));
    assert.equal(added?.[1].italic,true);
    const response=await request(paint+'/fonts/'+added[0]);
    assert.equal(response.headers.get('content-type'),'font/otf');
    await dialog.locator('.paint-text-sample').waitFor();
  }
  await dialog.getByRole('button',{name:'字体',exact:true}).click();
  const name=doc.paint.textFonts[font.id].family+' · '+doc.paint.textFonts[font.id].style;
  await page.getByRole('searchbox',{name:'搜索字体'}).fill(name.slice(0,8));
  await page.getByRole('option',{name,exact:true}).click();
  await dialog.getByRole('textbox',{name:'文字',exact:true}).fill('AURORA 072');
  await dialog.getByRole('button',{name:'应用',exact:true}).click();await saved('应用搜索找到的工程字体');
  assert.equal(layer(title).text.font,font.id);assert.deepEqual(boxAnchor(),position);

  await select(logo);
  await properties.locator('summary').filter({hasText:/^图层样式$/}).click();
  await properties.locator('summary').filter({hasText:/^描边$/}).click();
  await properties.getByRole('checkbox',{name:'启用描边',exact:true}).check();await saved('打开图像层描边');
  await properties.locator('summary').filter({hasText:/^投影$/}).click();
  await properties.getByRole('checkbox',{name:'启用投影',exact:true}).check();await saved('打开图像层投影');
  const styles=layer(logo).styles;
  assert.equal(styles.outline.position,'outside');assert.ok(styles.shadow.enabled);
  await commands(op('createMask',{layerId:logo,reveal:true,rect:[.38,.39,.61,.61],feather:6}),update(logo,{opacity:.73}));
  await page.reload();await canvas.waitFor();await wait4K();await select(logo);
  await editor.getByRole('button',{name:'局部修边',exact:true}).click();
  const load=page.waitForResponse(r=>r.url().endsWith('/image-select'));
  await editor.getByRole('button',{name:'读取蒙版',exact:true}).click();
  assert.equal((await load).status(),200);
  for(const view of ['原图','黑底','白底','红色叠加','蒙版']){
    const response=page.waitForResponse(r=>r.url().endsWith('/image-edge-view')&&r.request().postDataJSON()?.view);
    await choose('边缘检查',view);
    const reply=await response;assert.equal(reply.status(),200,reply.ok()?'':await reply.text());
    await editor.locator('.document-edge-inspection').waitFor();
  }
  await choose('修边方式','颜色引导');
  await choose('边缘检查','原图');
  await editor.getByRole('button',{name:'取样前景',exact:true}).click();
  await page.mouse.click(...await point(.467,.466));
  await editor.getByRole('button',{name:'取样背景',exact:true}).click();
  await page.mouse.click(...await point(.575,.47));
  const refine=page.waitForResponse(r=>r.url().endsWith('/image-select')&&r.request().postDataJSON().operation==='localEdge');
  await page.mouse.move(...await point(.38,.44));await page.mouse.down();await page.mouse.move(...await point(.38,.54),{steps:8});await page.mouse.up();
  const refined=await refine;assert.equal(refined.status(),200,refined.ok()?'':await refined.text());
  const mask=layer(logo).maskStrokes;
  await editor.getByRole('button',{name:'应用到蒙版',exact:true}).click();await saved('写回图层蒙版');
  assert.notDeepEqual(layer(logo).maskStrokes,mask);

  await commands(op('groupLayers',{layerId:'marks',layerIds:[logo],patch:{name:'标志组'}}),
    update(logo,{maskLinked:false}),
    op('layoutLayers',{transforms:[{layerIds:['marks'],pivot:[.5,.5],offset:[0,0],scale:1.04,angle:1}]}),
    update('marks',{styles:{shadow:{enabled:true,color:'#080b17',opacity:66,x:24,y:18,blur:9}}}));
  await page.reload();await canvas.waitFor();await wait4K();
  await select(logo);
  await editor.getByRole('button',{name:'图层变形',exact:true}).click();
  await choose('变形方式','平滑网格变形');
  await choose('网格密度','3 × 3');
  await editor.getByRole('button',{name:'插入列',exact:true}).click();
  await editor.getByRole('button',{name:'插入行',exact:true}).click();
  const handle=editor.locator('[data-warp-handle="6"]'),anchor=await handle.boundingBox();
  await page.mouse.move(anchor.x+anchor.width/2,anchor.y+anchor.height/2);await page.mouse.down();
  await page.mouse.move(anchor.x+anchor.width/2+3,anchor.y+anchor.height/2-2,{steps:6});await page.mouse.up();
  const key=process.platform==='darwin'?'Meta':'Control';
  const dragged=await handle.getAttribute('cx');
  await canvas.focus();await page.keyboard.press(key+'+z');
  assert.notEqual(await handle.getAttribute('cx'),dragged);
  await page.keyboard.press(key+'+Shift+z');
  assert.equal(await handle.getAttribute('cx'),dragged);
  await editor.getByRole('button',{name:'应用变形',exact:true}).click();await saved('提交平滑局部变形');
  const warped=layer(logo).warp;
  assert.equal(warped.mode,'smooth');assert.equal(warped.points.length,25);
  const p=[.33,.26],q=warpPoint(warped,p),back=warpPoint(warped,q,true);
  assert.ok(Math.hypot(p[0]-back[0],p[1]-back[1])<1e-6);
  await wait4K();
  const before=await exportPng('editable-styled-group');
  await fs.writeFile(path.join(data,'saved-warp.json'),JSON.stringify(warped));
  const raster=await api(paint+'/image-layer-bake',body({action:'rasterize',layerIds:['marks']}));
  doc=raster;
  assert.equal(layer('marks').kind,'pixel');assert.ok(!layer(logo));
  const after=await exportPng('rasterized-group');
  const delta=JSON.parse(python(`import sys,json,numpy as np
from PIL import Image
a,b=[np.asarray(Image.open(p)).astype(np.int16) for p in sys.argv[1:]]
error=np.abs(a-b)
print(json.dumps([int(error[:,:,3].max()),int(np.max(error[a[:,:,3]>64])),int((a[:,:,3]>64).sum())]))`,before,after));
  assert.ok(delta[0]<=1&&delta[1]<=3&&delta[2]>10000,JSON.stringify(delta));
  doc=await api(paint+'/undo',{revision:doc.revision});
  assert.deepEqual(layer(logo).warp,warped);assert.deepEqual(layer(logo).styles,styles);

  // Leave the styled and warped art visible while making a full-resolution
  // viewport edit. The unlinked mask avoids retargeting any older mask paint.
  await commands(op('addLayer',{layerId:'detail',kind:'pixel',patch:{name:'细线'}}));
  await page.reload();await canvas.waitFor();await wait4K();await select('detail');
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await editor.getByRole('button',{name:'实际像素',exact:true}).click();
  let legacy=false;
  await page.route('**/image-live',route=>{
    const payload=route.request().postDataJSON();
    if(legacy)delete payload.window;
    return route.continue({postData:JSON.stringify(payload)});
  });
  const timings=[],repetitions=Number(process.env.ARACHNE_BRUSH_TIMING_SAMPLES||1);
  for(const percent of [100,200,400]){
    if(percent!==100){
      await page.mouse.move(...await point(.5,.5));
      await page.mouse.wheel(0,-Math.log(2)*1000);
      await until(()=>canvas.boundingBox().then(b=>Math.abs(b.width-4096*percent/100)<64),'缩放到 '+percent+'%');
    }
    for(const baseline of [true,false])for(let trial=0;trial<repetitions;trial++){
      legacy=baseline;
      const before=doc.revision;
      const ready=page.waitForResponse(r=>r.ok()&&r.url().endsWith('/image-live')&&r.request().postDataJSON()?.operation?.stroke?.stamps?.length);
      await page.mouse.move(...await point(.49,.51));
      const start=performance.now();
      await page.mouse.down();
      const reply=await ready;
      const headersAt=performance.now();
      const region=await reply.headerValue('x-paint-window');
      assert.equal(!!region,!baseline);
      await stage.locator(baseline?'xpath=self::*[@data-preview-size="1024"]':'xpath=self::*[string-length(@data-stroke-window)>0]').waitFor();
      const visibleAt=performance.now();
      timings.push({percent,draft:baseline?'1024':'4K 局部',visibleMs:Math.round(visibleAt-start),
        responseMs:Math.round(headersAt-start),receiveAndDisplayMs:Math.round(visibleAt-headersAt)});
      if(percent!==400||baseline||trial!==repetitions-1){
        await page.keyboard.press('Escape');await page.mouse.up();
        await wait4K();assert.equal((await api(route)).revision,before);
      }else{
        const startPoint=await point(.49,.51);
        await page.mouse.move(startPoint[0]+12,startPoint[1]+3,{steps:3});
        const priorView=await canvas.boundingBox();
        await page.keyboard.down('Space');
        await page.mouse.move(startPoint[0]+55,startPoint[1]+19,{steps:5});
        await page.keyboard.up('Space');
        assert.ok(Math.abs((await canvas.boundingBox()).x-priorView.x)>12);
        await page.mouse.wheel(0,-70);
        await page.mouse.move(startPoint[0]+81,startPoint[1]+23,{steps:4});
        const stop=performance.now();
        await page.mouse.up();await saved('保存高倍率细线');await wait4K();
        assert.ok(layer('detail').strokes[0].breaks?.length);
        timings.at(-1).settled4KMs=Math.round(performance.now()-stop);
      }
    }
  }
  console.log(JSON.stringify(timings));

  await editor.getByRole('button',{name:'应用至材质',exact:true}).click();await saved('绑定涂装图像');
  assert.ok(doc.paint.layers.some(l=>l.documentMaps?.color==='design'));
  async function showMaterial(){
    await page.locator('[data-area-mode=material]').click();
    const viewport=page.locator('.editor-area[data-editor=viewport] .editor-viewport[data-state=ready]').first();
    await viewport.waitFor({timeout:65000});
    await viewport.locator('xpath=self::*[@data-rendered-paint-revision="'+doc.revision+'"][@data-rendered-paint-resolution="4096"]').waitFor({timeout:65000});
  }
  await showMaterial();
  await page.locator('[data-area-mode=drawing]').click();await canvas.waitFor();await wait4K();
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await select(title);
  await properties.getByRole('button',{name:'编辑文字…',exact:true}).click();
  await dialog.getByRole('textbox',{name:'文字',exact:true}).fill('AURORA 073');
  await dialog.getByRole('button',{name:'应用',exact:true}).click();await saved('查看模型后返回修改编号');
  await wait4K();assert.equal(layer(title).text.content,'AURORA 073');
  assert.deepEqual(boxAnchor(),position);
  await page.screenshot({path:path.join(data,'creative-drawing.png')});
  await showMaterial();
  await page.screenshot({path:path.join(data,'creative-material.png')});
  assert.deepEqual((await api(route)).paint.imageDocuments.design.layers,doc.paint.imageDocuments.design.layers);
  const fontFile=path.join(data,'projects',doc.id,'assets',doc.paint.textFonts[font.id].file);
  await fs.rename(fontFile,fontFile+'.removed');
  const missing=await api(paint+'/fonts/'+font.id,undefined,422);assert.match(missing.error,/缺少字体/);
  const rejected=await api(paint+'/text',body({layerId:title,text:{...layer(title).text,content:'AURORA 099'}}),422);
  assert.match(rejected.error,/缺少字体/);
  assert.equal((await api(route)).revision,doc.revision);
  const restoredFont=await api(paint+'/fonts',{revision:doc.revision,name:path.basename(fontPath),data:fontBytes.toString('base64')},201);
  assert.equal(restoredFont.document.revision,doc.revision);assert.equal(restoredFont.id,font.id);
  assert.deepEqual(errors,[]);
  console.log('PASS fonts, layer and group styles, masks, smooth warp, rasterization and material round trip:',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
