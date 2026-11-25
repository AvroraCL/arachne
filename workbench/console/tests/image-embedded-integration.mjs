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

const archive=process.argv[2];
if(!archive)throw Error('请提供 verify:image-size 生成的 banner-project.zip');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-embedded-'));
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
  async function restore(bytes){
    const r=await fetch(base+'/api/projects/paint-import',{method:'POST',headers:{Origin:base,'Content-Type':'application/zip'},body:bytes});
    const project=await r.json();assert.equal(r.status,201,JSON.stringify(project).slice(0,180));return project;
  }
  let doc=await restore(await fs.readFile(archive));
  const route='/api/projects/'+doc.id,paint=route+'/paint',mainId=Object.keys(doc.paint.imageDocuments)[0];
  const main=()=>doc.paint.imageDocuments[mainId],textId=main().layers.find(l=>l.text).id,shapeId=main().layers.find(l=>l.shape).id;
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1590,height:980}}),errors=[];
  page.on('pageerror',e=>{console.error(e);errors.push(e.message);});
  await page.goto(base+'/paint.html?project='+doc.id);await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('[data-editor=image]').first(),stack=page.locator('[data-editor=imageLayers]').first(),props=page.locator('[data-editor=imageProperties]').first();
  const canvas=editor.getByLabel('图像文档画布'),row=id=>stack.locator('[data-image-layer-id="'+id+'"] .document-layer-select');
  const mod=process.platform==='darwin'?'Meta':'Control';
  const detailed=()=>editor.locator('.document-image-stage[data-preview-size="4096"][data-preview-revision="'+doc.revision+'"]').waitFor({timeout:95000});
  async function saved(label){
    const prev=doc.revision;
    doc=await until(async()=>{const d=await api(route);return d.revision>prev&&d;},label);console.log('PASS',label);
  }
  async function snapshot(name){
    await detailed();
    const bytes=await canvas.evaluate(c=>c.toDataURL('image/png').split(',')[1]);await fs.writeFile(path.join(data,name+'.png'),Buffer.from(bytes,'base64'));
  }
  async function menu(id,label){
    await row(id).click({button:'right'});
    await page.getByRole('menuitem',{name:label,exact:true}).click();await saved(label);
  }
  await snapshot('original');
  await row(textId).click();await stack.locator('[data-image-layer-id="'+shapeId+'"] .document-layer-name').click({modifiers:[mod]});
  assert.equal(await stack.locator('.document-layer-row[data-selected]').count(),2);
  await menu(shapeId,'将所选图层成组');
  const group=main().layers.find(l=>l.kind==='group').id;
  await menu(group,'转换为内嵌对象');const sourceId=main().layers.find(l=>l.id===group).embedded.documentId;
  const source=()=>doc.paint.imageDocuments[sourceId];
  assert.ok(source().layers.find(l=>l.id===textId).text);assert.ok(source().layers.find(l=>l.id===shapeId).shape);
  await snapshot('converted');
  await menu(group,'放置关联实例');
  const instanceIds=main().layers.filter(l=>l.embedded).map(l=>l.id);
  assert.equal(instanceIds.length,2);
  const pose=()=>main().layers.filter(l=>l.embedded).map(({id,x,y,scale,rotation,stretch,embedded})=>({id,x,y,scale,rotation,stretch,embedded}));
  async function position(id,x,y,scale){
    await row(id).click();
    for(const [name,value] of [['缩放',scale],['位置 X',x],['位置 Y',y]]){
      const input=props.getByLabel(name,{exact:true});await input.dblclick();
      const field=props.getByRole('spinbutton',{name:'输入数值',exact:true});await field.fill(String(value));await field.press('Enter');
      await saved(name+' '+value);
    }
  }
  await position(instanceIds[0],.425,.485,.24);
  await position(instanceIds[1],.658,.526,.19);
  const poses=structuredClone(pose());
  assert.deepEqual(poses.map(p=>[p.x,p.y,p.scale]),[[.425,.485,.24],[.658,.526,.19]]);
  assert.ok(poses.every(p=>p.embedded.documentId===sourceId));
  await snapshot('before-edit');
  await row(instanceIds[1]).dblclick();
  await editor.getByRole('button',{name:'返回原稿',exact:true}).waitFor();
  await row(textId).click();
  await props.getByRole('button',{name:'编辑文字…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'编辑文字',exact:true});
  await dialog.locator('textarea').fill('STUDIO 02');
  await dialog.getByRole('button',{name:'应用',exact:true}).click();await saved('从第二个实例修改共享源稿');
  assert.equal(source().layers.find(l=>l.id===textId).text.content,'STUDIO 02');
  await editor.getByRole('button',{name:'返回原稿',exact:true}).click();
  await row(instanceIds[1]).waitFor();assert.deepEqual(pose(),poses);
  await snapshot('after-edit');
  async function history(key,label){
    await canvas.focus();await page.keyboard.press(mod+key);await saved(label);assert.deepEqual(pose(),poses);
  }
  await history('+z','撤销共享改字');assert.equal(source().layers.find(l=>l.id===textId).text.content,'BANNER 01');
  await snapshot('undo');
  await history('+Shift+z','重做共享改字');await snapshot('redo');
  await page.reload();await row(instanceIds[0]).waitFor();await snapshot('reopened');
  await editor.screenshot({path:path.join(data,'workspace.png')});
  execFileSync(pythonExecutable(),['-c',`import sys, os
import numpy as np
from PIL import Image
def im(n): return np.asarray(Image.open(os.path.join(sys.argv[1],n+'.png')))
assert np.array_equal(im('original'),im('converted'))
a,b=im('before-edit'),im('after-edit')
assert a.shape==b.shape==(256,1152,4)
changed=(a!=b).any(axis=2)
# Instance envelopes from their placements on the 2304x512 editing frame.
first=changed[:,:600].sum(); second=changed[:,600:].sum()
assert first>100 and second>100,(first,second)
# The two circles and both painted edge marks stay fixed.
for x,y in [(int((.425+(.57421875-.53125)*.24/.5625-.25)*2048),int((.485-.4375)*2048)),
            (int((.658+(.57421875-.53125)*.19/.5625-.25)*2048),int((.526-.4375)*2048))]:
 assert a[y,x,3]==255 and not changed[y-5:y+6,x-5:x+6].any()
assert not changed[:,:32].any() and not changed[:,975:].any()
assert np.array_equal(im('undo'),a) and np.array_equal(im('redo'),b) and np.array_equal(im('reopened'),b)
print('PASS changed pixels in two instances:',first,second)`,data],{stdio:'inherit'});
  await editor.getByRole('button',{name:'移动图层',exact:true}).click();
  const bounds=await canvas.boundingBox();
  // Click the opaque center of the smaller instance's orange circle.
  const u=.658+(.57421875-.53125)*.19/.5625;
  await page.mouse.dblclick(bounds.x+bounds.width*(u-.25)/.5625,bounds.y+bounds.height*(.526-.4375)/.125);
  await editor.getByRole('button',{name:'返回原稿',exact:true}).waitFor({timeout:15000});
  await row(textId).waitFor();
  await editor.getByRole('button',{name:'返回原稿',exact:true}).click();
  assert.deepEqual(pose(),poses);
  console.log('PASS 画布双击实例进入源稿');
  const backup=await api(paint+'/backup',{requestId:'shared-banner',revision:doc.revision},202);
  const done=await until(async()=>{const job=await api(route+'/jobs/'+backup.id);if(job.status==='failed')throw Error(job.error);return job.status==='completed'&&job;},'工程备份');
  const response=await fetch(new URL(done.archiveUrl,base));assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());await fs.writeFile(path.join(data,'shared-banner.zip'),bytes);
  const reopened=await restore(bytes);
  assert.deepEqual(reopened.paint.imageDocuments,doc.paint.imageDocuments);assert.deepEqual(errors,[]);
  console.log('PASS editable embedded banner, history and archive reopen',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
