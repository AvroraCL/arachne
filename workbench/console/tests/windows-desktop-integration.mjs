import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {_electron as electron} from 'playwright-core';
import {demoProjectId} from '../demo-source.mjs';

const [executable,appFolder]=process.argv.slice(2);
if(!executable)throw Error('Specify the packaged desktop executable');
const suppliedProfile=process.env.ARACHNE_DESKTOP_TEST_PROFILE;
const profile=suppliedProfile?path.resolve(suppliedProfile):await fs.mkdtemp(path.join(os.tmpdir(),'阿拉克涅 桌面验收-'));
await fs.mkdir(profile,{recursive:true});
const screenshots=process.env.ARACHNE_DESKTOP_SCREENSHOTS;
const withoutBlender=process.env.ARACHNE_TEST_WITH_BLENDER!=='1'||process.env.ARACHNE_TEST_WITHOUT_BLENDER==='1';
const env={...process.env,ARACHNE_USER_DATA_DIR:profile,ARACHNE_CYCLES_INTERACTIVE:'0'};
delete env.ELECTRON_RUN_AS_NODE;
if(process.platform==='win32')delete env.ARACHNE_BLENDER;
if(withoutBlender)env.ARACHNE_BLENDER=path.join(profile,'missing-blender');
let desktop;
const limit=setTimeout(()=>{
  console.error('Windows desktop verification timed out. Data:',profile);
  desktop?.process().kill();
  process.exit(1);
},9*60*1000).unref();
async function waitFor(check,label){
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    const value=await check();
    if(value)return value;
    await delay(200);
  }
  throw Error('Timed out: '+label);
}
async function launch(){
  console.log('Launching packaged desktop from',path.resolve(executable));
  desktop=await electron.launch({executablePath:path.resolve(executable),env,
    args:[...(appFolder?[path.resolve(appFolder)]:[]),
      ...(process.platform==='win32'?['--use-angle=swiftshader','--enable-unsafe-swiftshader','--force-device-scale-factor=1.25']:[])],
    timeout:60000});
  const page=await desktop.firstWindow({timeout:60000});
  console.log('Packaged desktop window created');
  await page.waitForURL(/127\.0\.0\.1:\d+\/paint\.html/, {timeout:30000});
  try{await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});}
  catch(error){
    const diagnostic=await page.evaluate(()=>({
      viewport:[...document.querySelectorAll('.editor-viewport')].map(item=>item.dataset.state),
      body:document.body.innerText.slice(0,1200)
    }));
    throw Error(error.message+'\n'+JSON.stringify(diagnostic));
  }
  return page;
}
async function close(){
  const exited=desktop.waitForEvent('close',{timeout:20000});
  await desktop.evaluate(({app})=>{setTimeout(()=>app.quit(),0);});
  await exited;
  desktop=null;
}
try{
  let page=await launch();
  const origin=new URL(page.url()).origin;
  const seedId=new URL(page.url()).searchParams.get('project');
  const read=async route=>{
    const response=await page.request.get(new URL(route,page.url()).href,{timeout:35000});
    assert.equal(response.status(),200);
    return response.json();
  };
  assert.equal((await read('/api/health')).localOnly,true);
  if(process.platform==='win32')assert.equal(await page.evaluate(()=>window.devicePixelRatio),1.25);
  assert.deepEqual(await read('/api/desktop-activity'),{state:'ready'});
  const blenderRequests=[];
  const watchRenderer=request=>{
    if(/\/(?:render-view|cycles-session|cycles-devices)(?:\/|$)/.test(new URL(request.url()).pathname))blenderRequests.push(request.url());
  };
  page.on('request',watchRenderer);
  await page.getByRole('button',{name:'渲染预览',exact:true}).first().click();
  await page.locator('.editor-viewport[data-render-backend="path-tracer"][data-render-phase="ready"]').first().waitFor({timeout:90000});
  await page.getByRole('button',{name:'材质预览',exact:true}).first().click();
  page.off('request',watchRenderer);
  assert.deepEqual(blenderRequests,[]);
  console.log('PASS Windows viewport and progressive path tracing');
  assert.equal((await read('/api/cycles-devices')).available,!withoutBlender);
  assert.deepEqual(await page.evaluate(()=>[typeof window.require,typeof window.arachneDesktop.notifyProject]),
    ['undefined','function']);
  await desktop.evaluate(({Menu,BrowserWindow})=>{
    const item=Menu.getApplicationMenu().items.find(group=>group.label==='文件').submenu.items[0];
    item.click(item,BrowserWindow.getAllWindows()[0],{});
  });
  await page.locator('#new-paint-dialog[open]').waitFor();
  const name='桌面验收';
  await page.locator('#new-paint-name').fill(name);
  await page.locator('#new-paint-submit').click();
  await page.waitForFunction(expected=>document.querySelector('#project-name')?.textContent===expected,name);
  const id=new URL(page.url()).searchParams.get('project');
  const project=await read('/api/projects/'+id);
  assert.equal(project.name,name);
  assert.equal(project.source.format,'glb');
  const target=await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle());
  assert.match(target,/桌面验收/);
  console.log('PASS native File menu and Chinese project name');
  if(!withoutBlender){
    const legacy=(await read('/api/projects')).find(project=>project.id===demoProjectId);
    assert.ok(legacy,'Generate the legacy demo before packaging to verify historical Cycles');
    const frame=await page.request.post(origin+'/api/projects/'+legacy.id+'/paint/render-view',{
      headers:{Origin:origin},timeout:120000,data:{revision:legacy.revision,quality:'draft',settings:{
        width:192,height:144,samples:2,device:'cpu',
        camera:{projection:'perspective',eye:[5,-7,5],target:[0,0,0],up:[0,0,1]}
      }}
    });
    assert.equal(frame.status(),200,frame.ok()?'':await frame.text());
    assert.equal(frame.headers()['x-cycles-device'],'CPU');
    assert.equal((await frame.body()).readUInt32BE(16),192);
  }
  const paint='/api/projects/'+id+'/paint';
  async function job(action,data){
    const response=await page.request.post(origin+paint+'/'+action,{
      headers:{Origin:origin},data:{revision:0,requestId:randomUUID(),...data}
    });
    assert.equal(response.status(),202,response.ok()?'':await response.text());
    const {id:jobId}=await response.json();
    return waitFor(async()=>{
      const result=await read('/api/projects/'+id+'/jobs/'+jobId);
      if(['failed','cancelled','interrupted'].includes(result.status))throw Error(result.error||result.status);
      return result.status==='completed'&&result;
    },action);
  }
  const rendered=await job('render',{settings:{width:256,height:192,samples:2,device:'cpu'}});
  assert.equal(rendered.render.engine,'PATH_TRACING');
  const png=await page.request.get(origin+rendered.renderUrl);
  assert.equal(png.status(),200);
  const bytes=await png.body();
  assert.equal(bytes.readUInt32BE(16),256);
  assert.equal(bytes.readUInt32BE(20),192);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),rendered.render.sha256);
  const bake=await job('preview',{});
  assert.equal(Object.keys(bake.paintReport.files).length,8);
  console.log('PASS Windows formal PNG and eight-channel 4K bake');
  if(withoutBlender){
    await desktop.evaluate(({Menu,BrowserWindow})=>{
      const item=Menu.getApplicationMenu().items.find(group=>group.label==='文件')
        .submenu.items.find(item=>item.label==='导出…');
      item.click(item,BrowserWindow.getAllWindows()[0],{});
    });
    await page.locator('#export-glb').click();
    const link=page.locator('#downloads a[download$=".glb"]');
    await link.waitFor({timeout:120000});
    const response=await page.request.get(origin+await link.getAttribute('href'));
    assert.equal(response.status(),200);
    assert.equal((await response.body()).toString('ascii',0,4),'glTF');
    await page.locator('#close-delivery').click();
  }
  const exported=await job('export-textures',{previewId:bake.id,confirmed:true});
  const archive=await page.request.get(origin+exported.packageUrl);
  assert.equal(archive.status(),200);
  const archiveDigest=createHash('sha256').update(await archive.body()).digest('hex');
  const saved=path.join(profile,'saved textures.zip');
  await desktop.evaluate(({session},file)=>{
    session.defaultSession.once('will-download',(event,item)=>{
      if(!event.defaultPrevented)item.setSavePath(file);
    });
  },saved);
  await page.evaluate(url=>{
    const link=document.createElement('a');
    link.href=url;link.download='textures.zip';link.click();
  },exported.packageUrl);
  await waitFor(async()=>{
    const bytes=await fs.readFile(saved).catch(error=>{if(error.code!=='ENOENT')throw error;});
    return bytes&&createHash('sha256').update(bytes).digest('hex')===archiveDigest;
  },'native ZIP download');
  console.log('PASS native ZIP save dialog and archive hash');
  // A job submitted from a different project is invisible to the open
  // workbench. The native close guard must still check the shared service.
  const other=await read('/api/projects/'+seedId);
  const task=await page.request.post(origin+'/api/projects/'+seedId+'/paint/render',{
    headers:{Origin:origin},data:{revision:other.revision,requestId:randomUUID(),
      settings:{width:1024,height:768,samples:32,device:'cpu'}}
  });
  assert.equal(task.status(),202,task.ok()?'':await task.text());
  const {id:taskId}=await task.json();
  assert.deepEqual(await read('/api/desktop-activity'),{state:'jobs'});
  await desktop.evaluate(({dialog,BrowserWindow})=>{
    const show=dialog.showMessageBox;
    globalThis.arachneQuitPrompt=new Promise(resolve=>{
      dialog.showMessageBox=async (_win,options)=>{
        dialog.showMessageBox=show;
        resolve(options.detail);
        return {response:0};
      };
    });
    BrowserWindow.getAllWindows()[0].close();
  });
  assert.match(await Promise.race([desktop.evaluate(()=>globalThis.arachneQuitPrompt),
    delay(10000,undefined,{ref:false})]),/后台任务/);
  const cancelled=await page.request.post(origin+'/api/projects/'+seedId+'/jobs/'+taskId+'/cancel',{
    headers:{Origin:origin},data:{}
  });
  assert.equal(cancelled.status(),200,cancelled.ok()?'':await cancelled.text());
  await waitFor(async()=> (await read('/api/desktop-activity')).state==='ready','renderer cleanup');
  console.log('PASS native quit checks active jobs in other projects');
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first();
  await editor.getByRole('button',{name:'新建贴图',exact:true}).click();
  const drawing=await waitFor(async()=>{
    const doc=await read('/api/projects/'+id);
    return Object.values(doc.paint.imageDocuments??{}).length&&doc;
  },'native clipboard test document');
  const imageId=Object.keys(drawing.paint.imageDocuments)[0];
  await editor.getByLabel('图像文档画布').focus();
  await desktop.evaluate(({BrowserWindow,clipboard,nativeImage},encoded)=>{
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(encoded,'base64')));
    BrowserWindow.getAllWindows()[0].webContents.paste();
  },bytes.toString('base64'));
  const pasted=await waitFor(async()=>{
    const doc=await read('/api/projects/'+id),layer=doc.paint.imageDocuments[imageId].layers.find(layer=>layer.kind==='image');
    return layer&&{doc,layer};
  },'Windows image clipboard');
  assert.equal(pasted.doc.paint.assets[pasted.layer.asset].width,256);
  assert.equal(pasted.doc.paint.assets[pasted.layer.asset].height,192);
  const clipboardCanvas=editor.getByLabel('图像文档画布');
  await desktop.evaluate(({clipboard})=>clipboard.clear());
  await clipboardCanvas.focus();
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.copy());
  const copiedSize=await waitFor(async()=>desktop.evaluate(({clipboard})=>{
    const image=clipboard.readImage();
    return image.isEmpty()?null:image.getSize();
  }),'copying the document to the Windows clipboard');
  assert.deepEqual(copiedSize,{width:4096,height:4096});
  console.log('PASS 125% Windows desktop scale and native clipboard image paste and copy');
  await page.locator('[data-area-mode=modeling]').click();
  const bounds=await desktop.evaluate(({BrowserWindow,screen})=>{
    const area=screen.getPrimaryDisplay().workArea;
    const win=BrowserWindow.getAllWindows()[0];
    win.setBounds({x:area.x+12,y:area.y+12,width:Math.min(area.width-24,1060),height:Math.min(area.height-24,680)});
    return win.getBounds();
  });
  if(screenshots){
    await fs.mkdir(screenshots,{recursive:true});
    await page.screenshot({path:path.join(screenshots,'windows-modeling.png')});
  }
  await close();
  assert.equal(await fetch(origin+'/api/health',{signal:AbortSignal.timeout(1000)}).then(()=>true,()=>false),false);
  page=await launch();
  assert.equal(new URL(page.url()).searchParams.get('project'),id);
  const resumed=await read('/api/projects/'+id);
  assert.equal(resumed.name,name);
  assert.deepEqual(resumed.paint.imageDocuments[imageId],pasted.doc.paint.imageDocuments[imageId]);
  assert.deepEqual(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getNormalBounds()),bounds);
  await close();
  if(!suppliedProfile)await fs.rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:250});
  console.log('PASS desktop GPU path tracing, formal PNG, project and window reopen, Chinese path, 4K bake, native ZIP save, '+
    (withoutBlender?'GLB export without Blender':'Cycles render')+' and service shutdown');
}catch(error){
  console.error(error);
  console.error('Desktop verification data:',profile);
  for(const name of await fs.readdir(path.join(profile,'logs')).catch(()=>[])){
    const log=await fs.readFile(path.join(profile,'logs',name),'utf8').catch(()=>null);
    if(log)console.error(log.slice(-8000));
  }
  if(desktop){
    await Promise.race([desktop.evaluate(({app})=>app.exit(1)).catch(()=>{}),delay(2000)]);
    if(desktop.process().exitCode===null)desktop.process().kill();
  }
  throw error;
}finally{clearTimeout(limit);}
