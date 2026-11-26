import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import {pythonExecutable} from '../python-runtime.mjs';

const root=new URL('..',import.meta.url);
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-brush-kernel-'));
execFileSync(pythonExecutable(),['-B','tests/bench-brush-coverage.py',data],
  {cwd:root,env:{...process.env,PYTHONPATH:fileURLToPath(root)}});
const previous=process.env.ARACHNE_BRUSH_FIXTURE_DIR;
if(previous)await fs.cp(previous,data,{recursive:true,filter:file=>path.basename(file)!=='server-lock.json'});
const fixture=JSON.parse(await fs.readFile(path.join(data,'brush-fixture.json'),'utf8'));
const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');
const port=socket.address().port,origin='http://127.0.0.1:'+port;
await new Promise(resolve=>socket.close(resolve));
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:root,stdio:'inherit',
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',PYTHONDONTWRITEBYTECODE:'1'}});
let browser;
const headers={Origin:origin,'Content-Type':'application/json'};
const response=(route,body)=>fetch(origin+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
async function api(route,body){
  const result=await response(route,body);
  assert.ok(result.ok,result.ok?'':await result.clone().text());
  return result.json();
}
const counts=Number(process.env.ARACHNE_BRUSH_BENCH_SAMPLES||5),timings={},digests={};
try{
  for(let n=0;n<100;n++){
    if(await fetch(origin+'/api/health').then(r=>r.ok,()=>false))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  let doc;
  if(previous){
    const [id]=await fs.readdir(path.join(data,'projects'));doc=await api('/api/projects/'+id);
    assert.equal(doc.name,'4K 笔刷重放与覆盖率');
    const entries=JSON.parse(await fs.readFile(path.join(data,'projects',id,'history.json'),'utf8')).snapshots.undo;
    const lastSetup=entries.findLastIndex(entry=>entry.label==='新建图像');
    assert.ok(lastSetup>=0);
    const steps=entries.length-lastSetup-1;
    if(steps)doc=await api('/api/projects/'+id+'/paint/undo',{revision:doc.revision,steps});
  }else doc=await api('/api/projects',{workflowType:'pbr_paint',name:'4K 笔刷重放与覆盖率',modelTemplate:'plane'});
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  if(!previous){
    const base=await api(paint+'/assets',{revision:doc.revision,name:'覆盖率笔尖.png',data:(await fs.readFile(path.join(data,'tip.png'))).toString('base64')});
    doc=base.document;const tipId=base.asset.id;
    const history=fixture.history.map(stroke=>stroke.tip?{...stroke,tip:{...stroke.tip,tipAsset:tipId}}:stroke);
    const dab=(target,stroke)=>({action:'stroke',layerId:'ink',target,stroke});
    const actions=[{action:'create'},{action:'addLayer',kind:'pixel',layerId:'ink'},
      {action:'createMask',layerId:'ink',reveal:true},{action:'updateLayer',layerId:'ink',patch:{maskFeather:5.5}},
      ...history.map(stroke=>dab('pixels',stroke)),...fixture.masks.map(stroke=>dab('mask',stroke))];
    doc=await api(paint+'/commands',{revision:doc.revision,operations:actions.map(action=>({op:'image',documentId:'design',...action}))});
  }
  const hash=async()=>{
    const result=await response(paint+'/image-live',{revision:doc.revision,documentId:'design',resolution:4096});
    assert.equal(result.status,200);
    const rgba=Buffer.from(await result.arrayBuffer());
    assert.equal(rgba.length,4096*4096*4);
    return createHash('sha256').update(rgba).digest('hex');
  };
  digests.history=await hash();
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1540,height:920}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    // Track which draft actually reached the drawing canvas, after transfer.
    const buffers=new WeakMap(),originalFetch=window.fetch,putImage=CanvasRenderingContext2D.prototype.putImageData;
    window.brushBench={};
    for(const kind of ['pointerdown','pointermove','pointerup']){
      document.addEventListener(kind,event=>{
        const canvas=event.target;
        if(canvas.getAttribute?.('aria-label')!=='图像文档画布')return;
        window.brushBench[kind]=performance.now();
        window.brushBench.contact=null;
        if(kind==='pointerup'||!event.buttons)return;
        const armed=window.brushBench.armed;
        if(armed?.kind!==kind)return;
        window.brushBench.armed=null;
        if(kind==='pointerdown')window.brushBench.downHit=null;
        window.brushBench.contact={...armed,start:window.brushBench[kind]};
      },true);
    }
    window.fetch=async function(url,options){
      const response=await originalFetch.apply(this,arguments);
      if(typeof url==='string'&&url.endsWith('/image-live')&&response.ok){
        const body=JSON.parse(options.body),read=response.arrayBuffer.bind(response);
        response.arrayBuffer=async()=>{
          const data=await read();
          const nativePatch=body.window&&!body.operation&&!body.operations&&response.headers.has('X-Paint-Window');
          buffers.set(data,{revision:body.revision,resolution:nativePatch?4096:body.resolution,patch:!!nativePatch,draft:!!(body.operation||body.operations)});
          return data;
        };
      }
      if(typeof url==='string'&&url.endsWith('/image-live')&&response.ok&&window.brushBurst){
        const {resolution,revision,window:region,operation,operations}=JSON.parse(options.body);
        if((resolution===4096||region&&!operation&&!operations)&&[window.brushBurst.heldRevision,window.brushBurst.heldRevision+3].includes(revision)){
          const read=response.arrayBuffer.bind(response);
          response.arrayBuffer=async ()=>{
            const data=await read();
            if(revision===window.brushBurst.heldRevision)window.brushBurst.held=true;
            await window.brushBurst.gate;
            return data;
          };
        }
      }
      if(typeof url==='string'&&url.endsWith('/image-live')&&response.headers.has('X-Paint-Window')){
        const stamps=JSON.parse(options.body).operation?.stroke?.stamps;
        if(stamps){
          const read=response.arrayBuffer.bind(response);
          response.arrayBuffer=async ()=>{
            const data=await read();
            buffers.set(data,{count:stamps.length,u:stamps.at(-1)[0]});
            return data;
          };
        }
      }
      return response;
    };
    // Full frames are copied into an existing ImageData buffer before drawing.
    const setPixels=Uint8ClampedArray.prototype.set;
    Uint8ClampedArray.prototype.set=function(source,...args){
      setPixels.call(this,source,...args);
      const metadata=buffers.get(source?.buffer);
      if(metadata)buffers.set(this.buffer,metadata);
    };
    CanvasRenderingContext2D.prototype.putImageData=function(image,...args){
      putImage.call(this,image,...args);
      const draft=buffers.get(image.data.buffer);
      if(this.canvas.getAttribute('aria-label')==='图像文档画布'){
        const bench=window.brushBench,p=bench.contact;
        if(p){p.x=Math.floor(p.u*this.canvas.width);p.y=Math.floor(p.v*this.canvas.height);}
        if(p&&!p.hit&&p.x>=args[0]&&p.y>=args[1]&&p.x<args[0]+image.width&&p.y<args[1]+image.height){
          const at=performance.now(),seen=this.getImageData(p.x-2,p.y-2,5,5).data;
          if(seen.some((value,i)=>value!==p.before[i])){
            p.hit=at-p.start;p.local=!draft;
            if(p.kind==='pointerdown')bench.downHit=p.hit;
          }
        }
        if(p&&!draft&&image.width<4096&&p.x>=args[0]&&p.y>=args[1]&&p.x<args[0]+image.width&&p.y<args[1]+image.height){
          p.patch={x:args[0],y:args[1],image};
        }
        if(p?.patch&&draft?.u&&Math.abs(draft.u*4096-p.x)<2){
          const patch=p.patch,old=patch.image.data;
          let delta=0;
          for(let y=0;y<patch.image.height;y++)for(let x=0;x<patch.image.width;x++){
            const i=4*(y*patch.image.width+x),col=patch.x+x-args[0],row=patch.y+y-args[1];
            if(col<0||col>=image.width||row<0||row>=image.height)continue;
            const j=4*(row*image.width+col);
            delta=Math.max(delta,Math.abs(old[i+3]-image.data[j+3]));
            for(let c=0;c<3;c++)delta=Math.max(delta,Math.abs(old[i+c]*old[i+3]-image.data[j+c]*image.data[j+3])/255);
          }
          p.exactDelta=delta;
        }
        if(draft){
          draft.drawnAt=performance.now();
          if(draft.count)window.lastBrushDraft=draft;
          else if(draft.resolution===4096&&!draft.draft)window.brushBench.detail=draft;
        }
      }
    };
  });
  await page.goto(origin+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first(),stage=editor.locator('.document-image-stage');
  const canvas=editor.getByLabel('图像文档画布'),layer=page.locator('.editor-area[data-editor=imageLayers] [data-image-layer-id=ink]');
  const mod=process.platform==='darwin'?'Meta':'Control';
  const wait4K=()=>stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  const point=async (x,y)=>{const box=await canvas.boundingBox();return [box.x+x*box.width,box.y+y*box.height];};
  async function armProbe(kind,u,v){
    await canvas.evaluate((canvas,{kind,u,v})=>{
      const x=Math.floor(u*canvas.width),y=Math.floor(v*canvas.height);
      const before=[...canvas.getContext('2d').getImageData(x-2,y-2,5,5).data];
      window.brushBench.armed={kind,u,v,x,y,before};
    },{kind,u,v});
  }
  async function compareCanvas(){
    const different=await canvas.evaluate(async(canvas,{url,revision})=>{
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({documentId:'design',resolution:4096,revision})});
      if(!response.ok)throw Error('failed to read reference pixels');
      const raw=new Uint8ClampedArray(await response.arrayBuffer());
      const expected=document.createElement('canvas');expected.width=expected.height=4096;
      const ctx=expected.getContext('2d'),actual=canvas.getContext('2d');
      ctx.putImageData(new ImageData(raw,4096,4096),0,0);
      for(let y=0;y<4096;y+=128){
        const a=actual.getImageData(0,y,4096,128).data,b=ctx.getImageData(0,y,4096,128).data;
        const i=a.findIndex((v,i)=>v!==b[i]);if(i!==-1)return [Math.floor(i/4)%4096,y+Math.floor(i/16384),i%4,a[i],b[i]];
      }
      return null;
    },{url:origin+paint+'/image-live',revision:doc.revision});
    assert.equal(different,null,'the visible canvas matches the independent full composite at '+different);
  }
  async function numeric(scope,label,value){
    await scope.locator('input[aria-label="'+label+'"]').locator('..').dblclick();
    const number=scope.getByRole('spinbutton',{name:'输入数值'});
    await number.fill(String(value));await number.press('Enter');
  }
  async function nextRevision(action,{detail=true}={}){
    const revision=doc.revision;
    const next=page.waitForResponse(r=>r.ok()&&r.url().startsWith(origin+paint+'/')&&
      ['/commands','/undo','/redo'].some(end=>r.url().endsWith(end)));
    const [,reply]=await Promise.all([action(),next]);
    doc=await reply.json();
    assert.ok(doc.revision>revision);
    if(detail)await wait4K();
  }

  await wait4K();
  await editor.getByRole('button',{name:'实际像素',exact:true}).click();
  await layer.locator('.document-layer-select').click();
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  const popup=editor.getByRole('button',{name:'笔尖参数',exact:true}),tipPanel=editor.getByRole('dialog',{name:'笔尖参数',exact:true});
  for(const name of ['thin','tip','softMask']){
    if(name==='softMask')await layer.locator('.document-layer-mask').click();
    await numeric(editor,'像素半径',name==='thin'?3:name==='tip'?9:28);
    await numeric(editor,'硬度',name==='thin'?75:30);
    await numeric(editor,'流量',name==='thin'?75:19);
    if(name==='tip'){
      await popup.click();
      await tipPanel.getByRole('button',{name:'图片笔尖',exact:true}).click();
      await page.getByRole('option',{name:'覆盖率笔尖.png',exact:true}).click();
      await numeric(tipPanel,'笔尖角度',33);
      await numeric(tipPanel,'圆度',65);
      await numeric(tipPanel,'纹理深度',50);
      await page.keyboard.press('Escape');
    }
    await wait4K();
    const results=[];
    for(let run=0;run<counts;run++){
      const y=name==='softMask'?.50:.48;
      await page.mouse.move(...await point(.48,y));
      await page.evaluate(()=>{window.lastBrushDraft=null;});
      await armProbe('pointerdown',.48,y);
      let start=performance.now();
      await page.mouse.down();
      await page.waitForFunction(()=>window.lastBrushDraft?.count===1);
      const initial=performance.now()-start;
      await page.mouse.move(...await point(.506,y),{steps:7});
      await armProbe('pointermove',.508,y);
      start=performance.now();
      await page.mouse.move(...await point(.508,y));
      await page.waitForFunction(()=>window.lastBrushDraft?.u>.507);
      const continuing=performance.now()-start;
      const feedback=await page.evaluate(()=>({
        pointerToCanvas:window.lastBrushDraft.drawnAt-window.brushBench.pointermove,
        canvasToObserved:performance.now()-window.lastBrushDraft.drawnAt,
        firstChanged:window.brushBench.contact?.hit,exactDelta:window.brushBench.contact?.exactDelta,local:window.brushBench.contact?.local,down:window.brushBench.downHit
      }));
      if(feedback.exactDelta!==undefined)assert.ok(feedback.exactDelta<=1.01,'local and worker coverage agree to one displayed byte');
      if(name==='thin')assert.equal(feedback.local,true,'moving the fine brush writes pixels locally');
      start=performance.now();
      await nextRevision(()=>page.mouse.up());
      const settled=performance.now()-start;
      const detail=await page.evaluate(()=>window.brushBench.detail);
      assert.equal(detail.revision,doc.revision,'measured 4K frame belongs to the saved revision');
      const releaseToCanvas=await page.evaluate(()=>window.brushBench.detail.drawnAt-window.brushBench.pointerup);
      results.push({first:Math.round(initial),move:Math.round(continuing),settled:Math.round(settled),
        pointerToCanvas:Math.round(feedback.pointerToCanvas),firstChanged:feedback.firstChanged,local:feedback.local,down:feedback.down,exactDelta:feedback.exactDelta,canvasToObserved:Math.round(feedback.canvasToObserved),
        releaseToCanvas:Math.round(releaseToCanvas),patch:detail.patch});
      if(run===counts-1){
        digests[name]=await hash();
        assert.ok(detail.patch,'saved brush was reconciled at native resolution using its affected pixels');
        await compareCanvas();
      }
      await stage.focus();
      await nextRevision(()=>page.keyboard.press(mod+'+z'));
    }
    timings[name]=results;
    console.log(name,JSON.stringify(results));
    assert.notEqual(digests[name],digests.history,'stroke changed '+name);
    assert.equal(await hash(),digests.history,'undo '+name);
    await nextRevision(()=>page.keyboard.press(mod+'+Shift+z'));
    assert.equal(await hash(),digests[name],'redo '+name);
    await page.reload();await wait4K();
    assert.equal(await hash(),digests[name],'reopen '+name);
    await stage.focus();
    await nextRevision(()=>page.keyboard.press(mod+'+z'));
  }
  async function roundBrush(radius){
    await popup.click();
    await tipPanel.getByRole('button',{name:'图片笔尖',exact:true}).click();
    await page.getByRole('option',{name:'圆形',exact:true}).click();
    await numeric(tipPanel,'圆度',100);await numeric(tipPanel,'纹理深度',0);
    await page.keyboard.press('Escape');
    await numeric(editor,'像素半径',radius);await numeric(editor,'硬度',100);await numeric(editor,'流量',100);
  }
  // Hold a real 4K result after its body is read. New strokes must publish
  // fast frames before that body is released, then refine only their revision.
  await layer.locator('.document-layer-select').click();
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await editor.getByRole('button',{name:'实际像素',exact:true}).click();
  await roundBrush(9);
  await editor.getByLabel('图像前景色',{exact:true}).fill('#e76832');
  await stage.evaluate((el,heldRevision)=>{
    const brushBurst=window.brushBurst={heldRevision,displayed:[]};
    brushBurst.gate=new Promise(resolve=>{brushBurst.release=resolve;});
    const read=()=>{
      const {previewRevision,previewSize,previewPhase}=el.dataset;
      brushBurst.displayed.push([Number(previewRevision),Number(previewSize),previewPhase]);
    };
    new MutationObserver(read).observe(el,{attributes:true,attributeFilter:['data-preview-revision','data-preview-size','data-preview-phase']});
  },doc.revision+1);
  const drag=async y=>{
    await page.mouse.move(...await point(.474,y));await page.mouse.down();
    await page.mouse.move(...await point(.525,y),{steps:4});await page.mouse.up();
  };
  await nextRevision(()=>drag(.455),{detail:false});
  await page.waitForFunction(()=>Boolean(window.brushBurst.held));
  const held=doc.revision;
  const target=held+3;
  const endPixels=()=>canvas.evaluate(canvas=>{
    const ctx=canvas.getContext('2d');
    return [.47,.50,.53].map(v=>Array.from(ctx.getImageData(Math.floor(.5*canvas.width)-8,Math.floor(v*canvas.height)-8,16,16).data).join(','));
  });
  const beforeInk=await endPixels(),begin=performance.now();
  for(const y of [.47,.50,.53])await drag(y);
  // A local exact patch stays visible through save; a downsampled frame may
  // correctly be skipped altogether. Observe the three strokes themselves.
  await page.waitForFunction(before=>{
    const canvas=document.querySelector('canvas[aria-label="图像文档画布"]'),ctx=canvas.getContext('2d');
    return [.47,.50,.53].every((v,i)=>Array.from(ctx.getImageData(Math.floor(.5*canvas.width)-8,Math.floor(v*canvas.height)-8,16,16).data).join(',')!==before[i]);
  },beforeInk);
  assert.ok(!await stage.evaluate((el,target)=>Number(el.dataset.previewRevision)===target&&el.dataset.previewPhase==='ready',target),
    'all three strokes are visible before their full result');
  const burstFast=Math.round(performance.now()-begin);
  await page.evaluate(()=>window.brushBurst.release());
  await page.waitForFunction(()=>document.querySelector('.document-image-stage')?.dataset.pendingStrokes==='0');
  doc=await api(route);
  assert.equal(doc.revision,target);
  await wait4K();
  const displayed=await page.evaluate(()=>window.brushBurst.displayed);
  assert.ok(!displayed.some(([revision,size,phase])=>revision===held&&size===4096&&phase==='ready'),'obsolete 4K never reached the canvas');
  assert.ok(displayed.every(([revision],i)=>!i||revision>=displayed[i-1][0]),'preview never went back to an older revision');
  const burstHash=await hash();
  await stage.focus();
  await nextRevision(()=>page.keyboard.press(mod+'+z'));
  assert.notEqual(await hash(),burstHash);
  await nextRevision(()=>page.keyboard.press(mod+'+Shift+z'));
  assert.equal(await hash(),burstHash);
  await page.reload();await wait4K();
  assert.equal(await hash(),burstHash);
  // Track real visible pixels on each animation frame through a brush, erase,
  // mask and final-resolution handoff. Each target lies on the same painted line.
  await layer.locator('.document-layer-select').click();
  const brush=editor.getByRole('button',{name:'画笔',exact:true});
  await brush.click();
  await roundBrush(15);await editor.getByLabel('图像前景色',{exact:true}).fill('#e72c20');
  const y=.532,sites=[.506,.518,.531];
  await canvas.evaluate((canvas,{sites,y})=>{
    const ctx=canvas.getContext('2d'),probe=window.inkWitness={rows:[],stage:0};
    const sample=()=>{
      const pixels=sites.map(u=>[...ctx.getImageData(Math.floor(u*canvas.width),Math.floor(y*canvas.height),1,1).data]);
      probe.rows.push({phase:probe.stage,size:canvas.width,pixels});
      if(probe.stage<4)requestAnimationFrame(sample);
    };sample();
  },{sites,y});
  const pressInk=[];
  async function mark(start,end){
    await page.mouse.move(...await point(start,y));
    await armProbe('pointerdown',start,y);await page.mouse.down();
    await page.waitForFunction(()=>window.brushBench.contact?.kind==='pointerdown'&&window.brushBench.contact.hit!==undefined,null,{timeout:3000});
    pressInk.push(await page.evaluate(()=>({ms:window.brushBench.contact.hit,local:window.brushBench.contact.local})));
    await page.mouse.move(...await point(end,y),{steps:5});await page.mouse.up();
  }
  const startHash=await hash();
  await nextRevision(()=>mark(.504,.536),{detail:false});
  async function witness(phase,predicate){
    await page.waitForFunction(predicate);await page.evaluate(n=>{window.inkWitness.stage=n;},phase);
  }
  await witness(1,()=>window.inkWitness.rows.at(-1).pixels.every(p=>p[0]>180&&p[3]>200));
  await editor.getByRole('button',{name:'橡皮擦',exact:true}).click();await roundBrush(11);
  await nextRevision(()=>mark(sites[1],sites[1]+.001),{detail:false});
  await witness(2,()=>window.inkWitness.rows.at(-1).pixels[1][3]<20);
  await layer.locator('.document-layer-mask').click();await brush.click();
  await roundBrush(22);await editor.getByLabel('图像前景色',{exact:true}).fill('#000000');
  await nextRevision(()=>mark(sites[2],sites[2]+.001),{detail:false});
  await witness(3,()=>window.inkWitness.rows.at(-1).pixels[2][3]<30);
  await wait4K();
  const rows=await page.evaluate(()=>{window.inkWitness.stage=4;return window.inkWitness.rows;});
  const mixedPixels=rows.at(-1).pixels;
  assert.ok(pressInk.every(press=>press.local),'paint, erase and soft mask write locally on contact');
  for(const {phase,pixels} of rows){
    if(phase>=1)assert.ok(pixels[0][0]>180&&pixels[0][3]>200,'saved paint disappeared '+JSON.stringify({phase,pixels}));
    if(phase>=2)assert.ok(pixels[1][3]<20,'erased area filled in again');
    if(phase>=3)assert.ok(pixels[2][3]<30,'mask reverted during handoff');
  }
  const mixedHash=await hash(),undos=[mixedHash];
  for(let i=0;i<3;i++){await stage.focus();await nextRevision(()=>page.keyboard.press(mod+'+z'));undos.push(await hash());}
  assert.equal(undos[3],startHash);assert.equal(new Set(undos).size,4);
  for(let i=2;i>=0;i--){await nextRevision(()=>page.keyboard.press(mod+'+Shift+z'));assert.equal(await hash(),undos[i]);}
  await page.reload();await wait4K();assert.equal(await hash(),mixedHash);
  console.log('Mixed handoff',JSON.stringify({pressInk,mixedPixels,frames:rows.length,revision:doc.revision}));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({timings,digests,burst:{strokes:3,fastMs:burstFast}}));
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
