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

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-image-pen-'));
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const port=socket.address().port,base='http://127.0.0.1:'+port;
await new Promise(resolve=>socket.close(resolve));
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:new URL('..',import.meta.url),stdio:'inherit',
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',PYTHONDONTWRITEBYTECODE:'1'}});
let browser;
const headers={Origin:base,'Content-Type':'application/json'};
async function until(read,label){
  for(let i=0;i<300;i++){const result=await read();if(result)return result;await delay(100);}
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
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'机身标志曲线选区',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  const op=(action,fields={})=>({op:'image',documentId:'design',action,...fields});
  doc=await api(paint+'/commands',{revision:doc.revision,operations:[op('create'),op('addLayer',{layerId:'color',kind:'pixel',patch:{name:'标志底色'}}),
    op('stroke',{layerId:'color',target:'pixels',stroke:{uv:true,rect:[.15,.15,.85,.85],color:'#ed6e25',opacity:1,erase:false}})]});
  async function saved(label){
    const before=doc.revision;
    doc=await until(async()=>{const next=await api(route);return next.revision===before+1&&next;},label);
  }
  const image=()=>doc.paint.imageDocuments.design;
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1640,height:980}}),errors=[];
  page.on('pageerror',error=>{errors.push(error.message);console.error(error);});
  await page.goto(base+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first(),canvas=editor.getByLabel('图像文档画布');
  const stage=editor.locator('.document-image-stage'),overlay=stage.locator('.document-pen-overlay');
  const stack=page.locator('.editor-area[data-editor=imageLayers]').first();
  const mod=process.platform==='darwin'?'Meta':'Control';
  await canvas.waitFor();
  await stage.locator('xpath=self::*[@data-preview-size="4096"]').waitFor({timeout:65000});
  await canvas.focus();await page.keyboard.press('p');
  await editor.getByRole('button',{name:'钢笔工具',exact:true,pressed:true}).waitFor();
  const point=async ([x,y])=>{const box=await canvas.boundingBox();return [box.x+x*box.width,box.y+y*box.height];};
  async function drag(start,end){
    const a=await point(start),b=await point(end);
    await page.mouse.move(...a);await page.mouse.down();await page.mouse.move(...b,{steps:8});await page.mouse.up();
  }
  const k=.23*.55228475;
  await drag([.5,.27],[.5+k,.27]);
  await drag([.73,.5],[.73,.5+k]);
  await drag([.5,.73],[.5-k,.73]);
  await drag([.27,.5],[.27,.5-k]);
  assert.equal(await overlay.locator('.document-pen-anchor').count(),4);
  await page.mouse.click(...await point([.5,.27]));
  await editor.getByRole('button',{name:'转为选区',exact:true}).waitFor();
  const shape=overlay.locator('.document-pen-line');
  assert.match(await shape.getAttribute('d'),/ C.* Z$/);
  const beforeHandle=await shape.getAttribute('d');
  await page.keyboard.down('Alt');
  await drag([.5+k,.27],[.66,.24]);
  await page.keyboard.up('Alt');
  const adjustedHandle=await shape.getAttribute('d');
  assert.notEqual(adjustedHandle,beforeHandle);
  await canvas.focus();await page.keyboard.press(mod+'+z');
  assert.equal(await shape.getAttribute('d'),beforeHandle);
  await page.keyboard.press(mod+'+Shift+z');
  assert.equal(await shape.getAttribute('d'),adjustedHandle);
  assert.equal((await api(route)).revision,doc.revision);
  await page.screenshot({path:path.join(data,'pen-curve.png')});
  const name=editor.getByRole('textbox',{name:'路径名称',exact:true});
  await name.fill('机身标志轮廓');
  await editor.getByRole('button',{name:'保存路径',exact:true}).click();await saved('保存闭合曲线');
  const savedPath=structuredClone(image().paths[0]);
  assert.equal(savedPath.geometry.closed,true);assert.equal(savedPath.name,'机身标志轮廓');
  assert.ok(savedPath.geometry.anchors[0].outgoing[0]>.15);
  assert.ok(savedPath.geometry.anchors[0].incoming[0]<-.11&&Math.abs(savedPath.geometry.anchors[0].incoming[1])<.003);
  async function selection(){
    const response=page.waitForResponse(r=>r.url().endsWith('/image-select')&&r.request().postDataJSON()?.source==='path');
    await editor.getByRole('button',{name:'转为选区',exact:true}).click();
    const res=await response;const body=await res.json();
    assert.ok(res.ok(),JSON.stringify(body).slice(0,300));
    assert.ok(body.selection?.coverage);
    await until(()=>stage.locator('.area-selection-overlay').getAttribute('data-sampling').then(v=>v===null),'钢笔选区就绪');
    return body.selection;
  }
  const selected=await selection();
  assert.ok(selected.rect[0]<.274&&selected.rect[2]>.725&&selected.rect[3]>.725);
  assert.equal((await api(route)).revision,doc.revision);

  await editor.getByRole('button',{name:'局部修边',exact:true}).click();
  async function localEdge(start,end){
    const response=page.waitForResponse(r=>r.url().endsWith('/image-select')&&r.request().postDataJSON()?.operation==='localEdge');
    await drag(start,end);
    const res=await response,body=await res.json();
    assert.ok(res.ok(),JSON.stringify(body).slice(0,300));
    await editor.getByRole('button',{name:'撤销修边',exact:true}).waitFor();
    await until(()=>editor.getByRole('button',{name:'撤销修边',exact:true}).isEnabled(),'修边结果可撤销');
    return body.selection;
  }
  const refined=await localEdge([.635,.29],[.705,.38]);
  assert.notEqual(refined.coverage,selected.coverage);
  assert.deepEqual(refined.rect,selected.rect);
  await editor.getByRole('button',{name:'撤销修边',exact:true}).click();
  await until(()=>editor.getByRole('button',{name:'重做修边',exact:true}).isEnabled(),'撤销局部修边');
  await canvas.focus();await page.keyboard.press(mod+'+Shift+z');
  await until(()=>editor.getByRole('button',{name:'重做修边',exact:true}).isDisabled(),'重做局部修边');
  assert.equal((await api(route)).revision,doc.revision);
  async function edgeAmount(value){
    const field=editor.locator('input[aria-label="边缘位移"]').locator('..');
    await field.dblclick();
    const entry=field.getByRole('spinbutton',{name:'输入数值'});
    await entry.fill(String(value));await entry.press('Enter');
  }
  await edgeAmount(16);
  const expanded=await localEdge([.289,.41],[.27,.49]);
  assert.ok(expanded.rect[0]<refined.rect[0]);
  await editor.getByRole('button',{name:'撤销修边',exact:true}).click();
  await edgeAmount(0);
  const softened=await localEdge([.289,.41],[.27,.49]);
  assert.notEqual(softened.coverage,refined.coverage);
  await editor.getByRole('button',{name:'撤销修边',exact:true}).click();
  await page.screenshot({path:path.join(data,'refined-curve.png')});
  await stack.getByRole('button',{name:'添加蒙版',exact:true}).click();await saved('用曲线选区建立蒙版');
  assert.equal(image().layers[0].maskStrokes[0].coverage,refined.coverage);
  async function png(label){
    const res=await fetch(base+paint+'/image-export',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,documentId:'design'})});
    assert.ok(res.ok,res.ok?'':await res.text());
    const bytes=Buffer.from(await res.arrayBuffer());await fs.writeFile(path.join(data,label+'.png'),bytes);return bytes;
  }
  const before=await png('curve-mask');
  execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import sys,numpy as np
im=Image.open(sys.argv[1])
assert im.size==(4096,4096)
def pixel(x,y): return im.getpixel((int(4096*x),int(4096*y)))
assert pixel(.50,.50)==(237,110,37,255),pixel(.50,.50)
assert pixel(.28,.28)[3]==0
assert pixel(.50,.20)[3]==0
assert pixel(.35,.36)[3]==255
a=np.asarray(im)[:,:,3]
assert np.count_nonzero((a>0)&(a<255))>1000
`,path.join(data,'curve-mask.png')],{stdio:'inherit'});
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销应用路径蒙版');
  assert.equal(image().layers[0].maskStrokes,undefined);
  await canvas.focus();await page.keyboard.press(mod+'+Shift+z');await saved('重做应用路径蒙版');
  assert.deepEqual(await png('curve-redone'),before);
  const maskFile=id=>path.join(data,'projects',doc.id,'assets','paint-'+id+'.png');
  execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import sys,numpy as np
a,b,c,d=(np.asarray(Image.open(path)) for path in sys.argv[1:])
delta=a.astype(np.int16)-b
assert delta.max()>200
assert np.count_nonzero(delta[:1750,2500:3300])>100
assert np.count_nonzero(delta[1800:,:])==0
assert np.count_nonzero(delta[:,:2400])==0
assert np.all(delta>=0)
assert np.all(c>=b) and np.count_nonzero(c>b)>1000
assert np.count_nonzero(d>b)>100 and np.count_nonzero(d<b)>100
`,maskFile(selected.coverage),maskFile(refined.coverage),maskFile(expanded.coverage),maskFile(softened.coverage)],{stdio:'inherit'});
  await page.reload();await canvas.waitFor();await canvas.focus();await page.keyboard.press('p');
  await editor.getByRole('button',{name:'钢笔路径',exact:true}).click();
  await page.getByRole('option',{name:'机身标志轮廓',exact:true}).click();
  assert.deepEqual(image().paths[0],savedPath);
  assert.equal(await overlay.locator('.document-pen-anchor').count(),4);
  assert.equal((await selection()).coverage,selected.coverage);
  assert.deepEqual(await png('curve-reopened'),before);
  assert.deepEqual(errors,[]);
  console.log('PASS Bézier anchors, independent handle, project paths, antialiased 4K mask, local edge, history and reload:',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
