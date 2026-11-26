import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {pythonExecutable} from '../python-runtime.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-image-selection-'));
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
async function until(read,label){
  for(let i=0;i<400;i++){
    const result=await read();
    if(result)return result;
    await delay(100);
  }
  throw Error('等待超时：'+label);
}
async function api(route,body,status=200){
  const response=await fetch(origin+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
  const value=await response.json();
  assert.equal(response.status,status,JSON.stringify(value).slice(0,400));
  return value;
}
const op=(action,fields={})=>({op:'image',documentId:'design',action,...fields});
const add=(layerId,name)=>op('addLayer',{layerId,kind:'pixel',patch:{name}});
const fill=(layerId,rect,color,opacity=1)=>op('stroke',{layerId,target:'pixels',stroke:{uv:true,rect,color,opacity,erase:false}});
const at=([x,y],size)=>[Math.floor(x*size),Math.floor(y*size)];
try{
  await until(()=>fetch(origin+'/api/health').then(r=>r.ok,()=>false),'本机服务');
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'标志选取和蒙版验证',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  const commands=async operations=>{doc=await api(paint+'/commands',{revision:doc.revision,operations});return doc;};
  const saved=async label=>{
    const revision=doc.revision;
    doc=await until(async()=>{const next=await api(route);return next.revision===revision+1&&next;},label);
    return doc;
  };
  await commands([op('create'),add('art','标志底稿'),
    fill('art',[.1,.1,.25,.25],'#db5a25'),
    fill('art',[.25,.1,.30,.25],'#d0582a'),
    fill('art',[.60,.1,.75,.25],'#db5a25'),
    fill('art',[.36,.54,.48,.68],'#44c3ee',.5),
    add('cover','遮挡素材'),fill('cover',[.05,.06,.33,.31],'#315ed0')]);
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1600,height:940}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first();
  const panel=page.locator('.editor-area[data-editor=imageLayers]').first();
  const canvas=editor.getByLabel('图像文档画布'),stage=editor.locator('.document-image-stage');
  const art=panel.locator('[data-image-layer-id=art]');
  const cmd=process.platform==='darwin'?'Meta':'Control';
  await art.locator('.document-layer-select').click();
  await canvas.focus();await page.keyboard.press('w');
  await editor.getByRole('button',{name:'魔棒',pressed:true,exact:true}).waitFor();
  const select=async action=>{
    const response=page.waitForResponse(r=>r.url().endsWith('/image-select'));
    await action();
    const result=await response;
    const body=await result.json();
    assert.equal(result.status(),200,JSON.stringify(body).slice(0,350));
    await until(()=>stage.locator('.area-selection-overlay').getAttribute('data-sampling').then(value=>value===null),'取样完成');
    return body.selection;
  };
  const click=async ([x,y])=>{
    const b=await canvas.boundingBox();
    await page.mouse.click(b.x+x*b.width,b.y+y*b.height);
  };
  const setTolerance=async value=>{
    const box=editor.locator('input[aria-label="魔棒容差"]').locator('..');
    await box.dblclick();
    const input=box.getByRole('spinbutton',{name:'输入数值'});
    await input.fill(String(value));await input.press('Enter');
  };
  await setTolerance(0);
  const exact=await select(()=>click([.16,.16]));
  assert.deepEqual(exact.rect,[410/4096,410/4096,.25,.25]);
  await editor.getByRole('button',{name:'覆盖预览',exact:true}).click();
  const coverageImage=editor.locator('img.selection-coverage');
  await coverageImage.waitFor();await coverageImage.evaluate(img=>img.decode());
  const coverage=await coverageImage.evaluate(img=>{
    const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
    const g=c.getContext('2d');g.drawImage(img,0,0);
    return [.16,.65].map(u=>g.getImageData(c.width*u,c.height*.16,1,1).data[3]);
  });
  assert.ok(coverage[0]>130);assert.equal(coverage[1],0);
  await editor.getByRole('button',{name:'覆盖预览',exact:true}).click();
  let releaseSample,started;
  const gate=new Promise(resolve=>releaseSample=resolve),sampling=new Promise(resolve=>started=resolve);
  await page.route('**/paint/image-select',async route=>{started();await gate;await route.continue();},{times:1});
  const reply=page.waitForResponse(r=>r.url().endsWith('/image-select'));
  await click([.66,.16]);await sampling;
  await stage.focus();await page.keyboard.press('b');
  await editor.getByRole('button',{name:'画笔',pressed:true,exact:true}).waitFor();
  await click([.66,.16]);
  assert.equal((await api(route)).revision,doc.revision);
  releaseSample();
  const resolved=(await (await reply).json()).selection;
  await saved('取样中换画笔并落笔');
  const stroke=doc.paint.imageDocuments.design.layers.find(l=>l.id==='art').strokes.at(-1);
  assert.deepEqual(stroke.clip,resolved.rect);assert.equal(stroke.coverage,resolved.coverage);
  await stage.focus();await page.keyboard.press(cmd+'+z');await saved('撤销取样后的笔触');
  await canvas.focus();await editor.getByRole('button',{name:'魔棒',exact:true}).click();
  await setTolerance(18);
  const similar=await select(()=>click([.16,.16]));
  assert.ok(Math.abs(similar.rect[2]-.30)<.001);
  await editor.getByRole('checkbox',{name:'连续区域',exact:true}).uncheck();
  const separated=await select(()=>click([.16,.16]));
  assert.equal(separated.rect[2],.75);
  await editor.getByRole('button',{name:'魔棒取样来源',exact:true}).click();
  await page.getByRole('option',{name:'可见合成',exact:true}).click();
  const visible=await select(()=>click([.16,.16]));
  assert.ok(Math.abs(visible.rect[0]-.05)<.001&&Math.abs(visible.rect[2]-.33)<.001);
  await page.screenshot({path:path.join(data,'wand-workspace.png')});
  const alpha=await select(()=>art.locator('.document-layer-thumb').click({modifiers:[cmd]}));
  assert.equal(alpha.rect[2],.75);
  assert.ok(Math.abs(alpha.rect[3]-.68)<.001);
  assert.equal(await art.getAttribute('data-active'),'');
  const controls=editor.locator('.document-selection-library');
  await controls.filter({has:page.locator('summary',{hasText:'修改选区'})}).locator('summary').click();
  const refine=editor.getByRole('dialog',{name:'修改选区',exact:true});
  const radius=refine.locator('input[aria-label="修改半径"]').locator('..');
  await radius.dblclick();
  const entry=radius.getByRole('spinbutton',{name:'输入数值'});
  await entry.fill('24');await entry.press('Enter');
  const expanded=await select(()=>refine.getByRole('button',{name:'扩展',exact:true}).click());
  assert.equal(Math.round((alpha.rect[0]-expanded.rect[0])*4096),24);
  await controls.filter({has:page.locator('summary',{hasText:'修改选区'})}).locator('summary').click();
  const contracted=await select(()=>refine.getByRole('button',{name:'收缩',exact:true}).click());
  assert.deepEqual(contracted.rect,alpha.rect);
  await controls.filter({has:page.locator('summary',{hasText:'修改选区'})}).locator('summary').click();
  const smooth=await select(()=>refine.getByRole('button',{name:'平滑',exact:true}).click());
  assert.notEqual(smooth.coverage,contracted.coverage);
  await select(()=>art.locator('.document-layer-thumb').click({modifiers:[cmd]}));
  await select(()=>art.locator('.document-layer-thumb').click({modifiers:[cmd,'Shift']}));
  const subtracted=await select(()=>art.locator('.document-layer-thumb').click({modifiers:[cmd,'Alt']}));
  assert.ok(subtracted.rect[1]>.5&&subtracted.rect[3]<.7);
  await select(()=>art.locator('.document-layer-thumb').click({modifiers:[cmd]}));
  await canvas.focus();await page.keyboard.press('m');
  const overlay=stage.locator('.area-selection-overlay'),outline=overlay.locator('.uv-lasso-border');
  const beforeDrag=await outline.getAttribute('transform');
  const canvasBox=await canvas.boundingBox();
  const point=([u,v])=>[canvasBox.x+u*canvasBox.width,canvasBox.y+v*canvasBox.height];
  await page.mouse.move(...point([.40,.60]));await page.mouse.down();
  await page.mouse.move(...point([.50,.65]),{steps:6});
  await overlay.locator('xpath=self::*[@data-moving]').waitFor();
  assert.notEqual(await outline.getAttribute('transform'),beforeDrag);
  await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(await outline.getAttribute('transform'),beforeDrag);
  await page.mouse.move(...point([.40,.60]));await page.mouse.down();
  await page.mouse.move(...point([.50,.65]),{steps:6});
  const moved=await select(()=>page.mouse.up());
  assert.ok(Math.abs(moved.rect[0]-alpha.rect[0]-.10)<.004);
  assert.ok(Math.abs(moved.rect[1]-alpha.rect[1]-.05)<.004);
  assert.equal((await api(route)).revision,doc.revision);
  await page.screenshot({path:path.join(data,'moved-sampled-selection.png')});
  const assetDir=path.join(data,'projects',doc.id,'assets');
  execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import numpy as np
import sys
a,b=(np.asarray(Image.open(p)) for p in sys.argv[1:3])
dx,dy=map(int,sys.argv[3:])
assert dx>0 and dy>0
assert np.array_equal(a[:-dy,:-dx],b[dy:,dx:])
assert not b[:dy,:].any() and not b[:,:dx].any()
assert 128 in b and 255 in b
`,path.join(assetDir,'paint-'+alpha.coverage+'.png'),path.join(assetDir,'paint-'+moved.coverage+'.png'),
    ...[0,1].map(i=>String(Math.round((moved.rect[i]-alpha.rect[i])*4096)))],{stdio:'inherit'});
  const hole=[.47,.36];
  await page.mouse.move(...point(hole));await page.mouse.down();
  await page.mouse.move(...point([.53,.43]),{steps:6});
  assert.equal(await overlay.getAttribute('data-moving'),null);
  await page.keyboard.press('Escape');await page.mouse.up();
  await page.keyboard.press(cmd+'+d');
  const polygon=overlay.locator('.uv-selection-border');
  const uvBounds=async()=>{
    const points=(await polygon.getAttribute('points')).split(' ').map(pair=>pair.split(',').map(Number));
    return [points[0][0],points[0][1],points[2][0],points[2][1]].map((value,i)=>value/canvasBox[i%2?'height':'width']);
  };
  const delta=(a,b)=>a.map((n,i)=>n-b[i]);
  const near=(values,expected)=>assert.ok(values.every((n,i)=>Math.abs(n-expected[i])<.004),JSON.stringify(values));
  await page.mouse.move(...point([.35,.35]));await page.mouse.down();
  await page.keyboard.down('Alt');
  await page.mouse.move(...point([.45,.41]),{steps:6});
  const centered=await uvBounds();
  near([centered[2]-centered[0],centered[3]-centered[1]],[.20,.12]);
  await page.keyboard.down('Space');
  await page.mouse.move(...point([.55,.48]),{steps:6});
  near(delta(await uvBounds(),centered),[.10,.07,.10,.07]);
  await page.keyboard.up('Space');
  await page.mouse.move(...point([.58,.50]),{steps:4});
  near(delta(await uvBounds(),centered),[.07,.05,.13,.09]);
  await page.mouse.up();await page.keyboard.up('Alt');
  near(delta(await uvBounds(),centered),[.07,.05,.13,.09]);
  assert.equal((await api(route)).revision,doc.revision);
  await select(()=>art.locator('.document-layer-thumb').click({modifiers:[cmd]}));
  await editor.getByRole('button',{name:'变换选区边界',exact:true}).click();
  const xField=editor.locator('input[data-transform-field="x"]').locator('..');
  await xField.dblclick();
  const xEntry=xField.getByRole('spinbutton',{name:'输入数值'});
  await xEntry.fill('256');await xEntry.press('Enter');
  await stage.focus();
  const reshaped=await select(()=>page.keyboard.press('Enter'));
  assert.ok(Math.abs(reshaped.rect[0]-alpha.rect[0]-.0625)<.002);
  await select(()=>art.locator('.document-layer-thumb').click({modifiers:[cmd]}));
  const library=controls.filter({has:page.locator('summary',{hasText:'已存选区'})});
  await library.locator('summary').click();
  const popup=editor.getByRole('dialog',{name:'已存选区',exact:true});
  await popup.getByRole('textbox',{name:'选区名称'}).fill('标志半透明边');
  await popup.getByRole('button',{name:'保存',exact:true}).click();
  await saved('保存像素选区');
  assert.equal(doc.paint.imageDocuments.design.selections[0].coverage,alpha.coverage);
  assert.equal(doc.paint.assets[alpha.coverage].purpose,'selection');
  await page.reload();
  await canvas.waitFor();await canvas.focus();await page.keyboard.press('w');
  await editor.getByRole('button',{name:'魔棒',pressed:true,exact:true}).waitFor();
  await library.locator('summary').click();
  await popup.getByRole('button',{name:'载入选区 标志半透明边',exact:true}).click();
  await panel.locator('[data-image-layer-id=cover] .document-layer-select').click();
  await panel.getByRole('button',{name:'添加蒙版',exact:true}).click();
  await saved('从已存透明度创建蒙版');
  const image=()=>doc.paint.imageDocuments.design;
  const cover=()=>image().layers.find(l=>l.id==='cover');
  assert.equal(cover().maskStrokes[0].coverage,alpha.coverage);
  const sampledMask=await select(()=>panel.getByRole('button',{name:'选择蒙版 遮挡素材',exact:true}).click({modifiers:[cmd]}));
  assert.equal(sampledMask.coverage,alpha.coverage);
  const coords=[[.15,.15],[.41,.59],[.90,.90]];
  async function readMask(layerId,coords){
    const response=await fetch(origin+paint+'/image-live',{method:'POST',headers,body:JSON.stringify({
      revision:doc.revision,documentId:'design',resolution:512,inspectMask:layerId
    })});
    assert.equal(response.status,200,response.ok?'':await response.text());
    const bytes=new Uint8Array(await response.arrayBuffer());
    return coords.map(p=>{const [x,y]=at(p,512);return bytes[(y*512+x)*4];});
  }
  assert.deepEqual(await readMask('cover',coords),[255,128,0]);
  const coverRow=panel.locator('[data-image-layer-id=cover]');
  const drag=async (from,to)=>{
    const b=await canvas.boundingBox();
    const point=([x,y])=>[b.x+x*b.width,b.y+y*b.height];
    await page.mouse.move(...point(from));await page.mouse.down();
    await page.mouse.move(...point(to),{steps:10});await page.mouse.up();
  };
  const originalPaint=structuredClone(cover().strokes);
  await coverRow.getByRole('button',{name:'解除蒙版链接',exact:true}).click();
  await saved('解除蒙版链接');
  assert.equal(cover().maskLinked,false);
  await panel.getByRole('button',{name:'选择蒙版 遮挡素材',exact:true}).click();
  await editor.getByRole('button',{name:'移动图层',exact:true}).click();
  await drag([.22,.22],[.42,.22]);
  await saved('独立拖动蒙版');
  const shifted=cover();
  assert.ok(Math.abs(shifted.maskTransform[4]-.2)<.004);
  assert.deepEqual(shifted.strokes,originalPaint);
  const movedMask=await readMask('cover',[[.15,.15],[.39,.15],[.61,.59]]);
  assert.deepEqual(movedMask,[0,255,128]);
  await page.screenshot({path:path.join(data,'unlinked-mask-workspace.png')});
  await canvas.focus();await page.keyboard.press(cmd+'+z');
  await saved('撤销蒙版移动');
  assert.deepEqual(await readMask('cover',coords),[255,128,0]);
  await canvas.focus();await page.keyboard.press(cmd+'+Shift+z');
  await saved('重做蒙版移动');
  assert.deepEqual(await readMask('cover',[[.15,.15],[.39,.15],[.61,.59]]),movedMask);
  await page.reload();await canvas.waitFor();
  assert.deepEqual(await readMask('cover',[[.15,.15],[.39,.15],[.61,.59]]),movedMask);
  await coverRow.getByRole('button',{name:'选择蒙版 遮挡素材',exact:true}).click();
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await canvas.focus();await page.keyboard.press('d');
  await drag([.38,.15],[.40,.15]);
  await saved('移动后在蒙版上补画');
  assert.deepEqual(cover().maskStrokes.at(-1).maskSpace,cover().maskTransform);
  assert.ok((await readMask('cover',[[.39,.15]]))[0]<=10);
  await canvas.focus();await page.keyboard.press(cmd+'+z');
  await saved('撤销蒙版补画');
  await canvas.focus();await page.keyboard.press(cmd+'+z');
  await saved('恢复原始蒙版位置');
  await coverRow.getByRole('button',{name:'链接图层和蒙版',exact:true}).click();
  await saved('重新链接蒙版');
  const linked=()=>api(paint+'/commands',{revision:doc.revision,operations:[op('layoutLayers',{transforms:[
    {layerIds:['cover'],pivot:[.5,.5],offset:[.10,0],scale:1,angle:0}
  ]})]});
  doc=await linked();
  assert.ok(Math.abs(cover().maskTransform[4]-.1)<1e-8);
  assert.equal(cover().strokes.at(-1).transformUV.offset[0],.1);
  assert.deepEqual(await readMask('cover',[[.15,.15],[.35,.15],[.51,.59]]),[0,255,128]);
  doc=await api(paint+'/undo',{revision:doc.revision});
  await page.reload();await canvas.waitFor();
  await select(()=>coverRow.getByRole('button',{name:'选择蒙版 遮挡素材',exact:true}).click({modifiers:[cmd]}));
  await panel.getByRole('button',{name:'新建调整图层',exact:true}).click();
  await page.getByRole('menuitem',{name:'反相',exact:true}).click();
  await saved('用蒙版选区建立局部调整');
  const adjustment=image().layers.find(l=>l.kind==='adjustment');
  assert.equal(adjustment.maskStrokes[0].coverage,alpha.coverage);
  assert.deepEqual(await readMask(adjustment.id,coords),[255,128,0]);
  const output=await fetch(origin+paint+'/image-export',{method:'POST',headers,
    body:JSON.stringify({revision:doc.revision,documentId:'design'})});
  assert.equal(output.status,200);
  const png=path.join(data,'localized-color.png');
  await fs.writeFile(png,Buffer.from(await output.arrayBuffer()));
  execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import sys
im=Image.open(sys.argv[1])
assert im.size==(4096,4096)
def at(x,y): return im.getpixel((int(x*4096),int(y*4096)))
assert at(.15,.15)==(206,161,47,255),at(.15,.15)
assert at(.41,.59)[3]==128 and at(.41,.59)[:3]!=(68,195,238),at(.41,.59)
assert at(.9,.9)==(0,0,0,0),at(.9,.9)
`,png],{stdio:'inherit'});
  await art.locator('.document-layer-select').click();
  await canvas.focus();await page.keyboard.press(cmd+'+d');await page.keyboard.press('Shift+w');
  await editor.getByRole('button',{name:'颜色范围',pressed:true,exact:true}).waitFor();
  await editor.getByRole('button',{name:'颜色范围取样来源',exact:true}).click();
  await page.getByRole('option',{name:'当前层',exact:true}).click();
  const fuzziness=editor.locator('input[aria-label="颜色范围模糊度"]').locator('..');
  await fuzziness.dblclick();
  await fuzziness.getByRole('spinbutton',{name:'输入数值'}).fill('48');
  await fuzziness.getByRole('spinbutton',{name:'输入数值'}).press('Enter');
  const orange=await select(()=>click([.16,.16]));
  assert.equal(orange.rect[2],.75);
  const swatchClick=async (point,modifier)=>{
    await page.keyboard.down(modifier);
    try{return await click(point);}finally{await page.keyboard.up(modifier);}
  };
  const both=await select(()=>swatchClick([.41,.59],'Shift'));
  assert.ok(both.rect[3]>.67);
  const orangeAgain=await select(()=>swatchClick([.41,.59],'Alt'));
  assert.ok(orangeAgain.rect[3]<=.2501);
  const combined=await select(()=>swatchClick([.41,.59],'Shift'));
  await panel.getByRole('button',{name:'新建调整图层',exact:true}).click();
  await page.getByRole('menuitem',{name:'色彩平衡',exact:true}).click();
  await saved('用颜色范围的柔和选区生成调整图层蒙版');
  const colorLayer=image().layers.find(l=>l.adjustment?.type==='colorBalance');
  assert.equal(colorLayer.maskStrokes[0].coverage,combined.coverage);
  const rangeCoverage=await readMask(colorLayer.id,[[.16,.16],[.27,.16],[.66,.16],[.41,.59],[.9,.9]]);
  assert.deepEqual(rangeCoverage,[255,197,255,128,0]);
  await page.screenshot({path:path.join(data,'sampled-color-range.png')});
  await canvas.focus();await page.keyboard.press(cmd+'+z');
  await saved('撤销颜色范围调整图层');
  assert.ok(!image().layers.some(layer=>layer.id===colorLayer.id));
  await canvas.focus();await page.keyboard.press(cmd+'+Shift+z');
  await saved('重做颜色范围调整图层');
  await page.reload();await canvas.waitFor();
  assert.deepEqual(await readMask(colorLayer.id,[[.16,.16],[.27,.16],[.66,.16],[.41,.59],[.9,.9]]),rangeCoverage);
  await commands([
    op('addLayer',{layerId:'trim',kind:'group',patch:{name:'标志组',opacity:.5}}),
    op('addLayer',{layerId:'clip-base',kind:'pixel',parentId:'trim',patch:{name:'标志底层',opacity:.5}}),
    fill('clip-base',[.2,.3,.65,.72],'#dd7030',.5),
    op('stroke',{layerId:'clip-base',target:'mask',stroke:{uv:true,rect:[.48,.3,.65,.72],opacity:1,value:0}}),
    op('addLayer',{layerId:'clip-ink',kind:'pixel',parentId:'trim',patch:{name:'半透明标志',clipped:true}}),
    fill('clip-ink',[.1,.38,.82,.65],'#0e4fc2',.5),
    op('stroke',{layerId:'clip-ink',target:'mask',stroke:{uv:true,rect:[.34,.38,.41,.65],opacity:1,value:0}}),
    op('stroke',{layerId:'trim',target:'mask',stroke:{uv:true,rect:[.2,.54,.65,.72],opacity:1,value:.5}}),
    add('visible-proof','可见选区验证')
  ]);
  await page.reload();await canvas.waitFor();
  const clipRow=panel.locator('[data-image-layer-id=clip-ink]');
  const raw=await select(()=>clipRow.locator('.document-layer-thumb').click({modifiers:[cmd]}));
  assert.ok(raw.rect[0]<.11&&raw.rect[2]>.81);
  await clipRow.locator('.document-layer-select').click({button:'right'});
  const effective=await select(()=>page.getByRole('menuitem',{name:'从可见范围载入选区',exact:true}).click());
  assert.ok(Math.abs(effective.rect[0]-.20)<.001&&Math.abs(effective.rect[2]-.48)<.001);
  assert.notEqual(raw.coverage,effective.coverage);
  await page.screenshot({path:path.join(data,'visible-clip-selection.png')});
  await panel.locator('[data-image-layer-id=visible-proof] .document-layer-select').click();
  await panel.getByRole('button',{name:'添加蒙版',exact:true}).click();
  await saved('从剪贴层可见范围制作蒙版');
  const checks=[[.15,.45],[.28,.45],[.37,.45],[.45,.45],[.55,.45],[.45,.59]];
  const expected=[0,16,0,16,0,8];
  assert.deepEqual(await readMask('visible-proof',checks),expected);
  await page.reload();await canvas.waitFor();
  assert.deepEqual(await readMask('visible-proof',checks),expected);
  await clipRow.locator('.document-layer-select').click({button:'right'});
  const reloadedCoverage=await select(()=>page.getByRole('menuitem',{name:'从可见范围载入选区',exact:true}).click());
  assert.equal(reloadedCoverage.coverage,effective.coverage);
  await panel.locator('[data-image-layer-id=visible-proof] .document-layer-select').click();
  await panel.getByRole('button',{name:'新建调整图层',exact:true}).click();
  await page.getByRole('menuitem',{name:'反相',exact:true}).click();
  await saved('从剪贴层可见范围建立调整图层');
  const targeted=image().layers.at(-1);
  assert.equal(targeted.kind,'adjustment');
  assert.equal(targeted.maskStrokes[0].coverage,effective.coverage);
  assert.deepEqual(await readMask(targeted.id,checks),expected);
  await canvas.focus();await page.keyboard.press(cmd+'+z');
  await saved('撤销可见范围调整图层');
  assert.ok(!image().layers.some(layer=>layer.id===targeted.id));
  await canvas.focus();await page.keyboard.press(cmd+'+Shift+z');
  await saved('重做可见范围调整图层');
  assert.deepEqual(await readMask(targeted.id,checks),expected);
  assert.deepEqual(errors,[]);
  console.log('PASS 4K wand, sampled selection drag, mask transform, fuzzy color range, clipped visible coverage and masks after reopen:',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
  }
}
