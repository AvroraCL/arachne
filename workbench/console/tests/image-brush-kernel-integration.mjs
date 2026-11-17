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
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'4K 笔刷重放与覆盖率',modelTemplate:'plane'});
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  const image=action=>({op:'image',documentId:'design',...action});
  const command=async operations=>{doc=await api(paint+'/commands',{revision:doc.revision,operations:operations.map(image)});};
  const base=await api(paint+'/assets',{revision:doc.revision,name:'覆盖率笔尖.png',data:(await fs.readFile(path.join(data,'tip.png'))).toString('base64')});
  doc=base.document;
  const tipId=base.asset.id;
  const history=fixture.history.map(stroke=>stroke.tip?{...stroke,tip:{...stroke.tip,tipAsset:tipId}}:stroke);
  const dab=(target,stroke)=>({action:'stroke',layerId:'ink',target,stroke});
  await command([{action:'create'},{action:'addLayer',kind:'pixel',layerId:'ink'},
    {action:'createMask',layerId:'ink',reveal:true},{action:'updateLayer',layerId:'ink',patch:{maskFeather:5.5}},
    ...history.map(stroke=>dab('pixels',stroke)),...fixture.masks.map(stroke=>dab('mask',stroke))]);

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
    for(const kind of ['pointermove','pointerup']){
      document.addEventListener(kind,event=>{
        if(event.target.getAttribute?.('aria-label')==='图像文档画布')
          window.brushBench[kind]=performance.now();
      },true);
    }
    window.fetch=async function(url,options){
      const response=await originalFetch.apply(this,arguments);
      if(typeof url==='string'&&url.endsWith('/image-live')&&response.ok){
        const body=JSON.parse(options.body),read=response.arrayBuffer.bind(response);
        response.arrayBuffer=async()=>{
          const data=await read();
          buffers.set(data,{revision:body.revision,resolution:body.resolution,draft:!!(body.operation||body.operations)});
          return data;
        };
      }
      if(typeof url==='string'&&url.endsWith('/image-live')&&response.ok&&window.brushBurst){
        const {resolution,revision}=JSON.parse(options.body);
        if(resolution===4096&&revision===window.brushBurst.heldRevision){
          const read=response.arrayBuffer.bind(response);
          response.arrayBuffer=async ()=>{
            const data=await read();
            await new Promise(resolve=>{window.brushBurst.release=resolve;});
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
        if(draft){
          draft.drawnAt=performance.now();
          if(draft.count)window.lastBrushDraft=draft;
          else if(draft.resolution===4096&&!draft.draft)window.brushBench.detail=draft;
        }
        const burst=window.brushBurst;
        if(burst){
          const stage=this.canvas.closest('.document-image-stage');
          queueMicrotask(()=>burst.writes.push([Number(stage.dataset.previewRevision),image.width]));
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
  async function numeric(scope,label,value){
    await scope.locator('input[aria-label="'+label+'"]').locator('..').dblclick();
    const number=scope.getByRole('spinbutton',{name:'输入数值'});
    await number.fill(String(value));await number.press('Enter');
  }
  async function nextRevision(action,{detail=true}={}){
    const revision=doc.revision;
    const next=page.waitForResponse(r=>r.ok()&&r.url().startsWith(origin+paint+'/')&&
      ['/commands','/undo','/redo'].some(end=>r.url().endsWith(end)));
    await action();
    doc=await (await next).json();
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
      let start=performance.now();
      await page.mouse.down();
      await page.waitForFunction(()=>window.lastBrushDraft?.count===1);
      const initial=performance.now()-start;
      await page.mouse.move(...await point(.506,y),{steps:7});
      start=performance.now();
      await page.mouse.move(...await point(.508,y));
      await page.waitForFunction(()=>window.lastBrushDraft?.u>.507);
      const continuing=performance.now()-start;
      const feedback=await page.evaluate(()=>({
        pointerToCanvas:window.lastBrushDraft.drawnAt-window.brushBench.pointermove,
        canvasToObserved:performance.now()-window.lastBrushDraft.drawnAt
      }));
      start=performance.now();
      await nextRevision(()=>page.mouse.up());
      const settled=performance.now()-start;
      const detail=await page.evaluate(()=>window.brushBench.detail);
      assert.equal(detail.revision,doc.revision,'measured 4K frame belongs to the saved revision');
      const releaseToCanvas=await page.evaluate(()=>window.brushBench.detail.drawnAt-window.brushBench.pointerup);
      results.push({first:Math.round(initial),move:Math.round(continuing),settled:Math.round(settled),
        pointerToCanvas:Math.round(feedback.pointerToCanvas),canvasToObserved:Math.round(feedback.canvasToObserved),
        releaseToCanvas:Math.round(releaseToCanvas)});
      if(run===counts-1)digests[name]=await hash();
      await stage.focus();
      await nextRevision(()=>page.keyboard.press(mod+'+z'));
    }
    timings[name]=results;
    assert.notEqual(digests[name],digests.history,'stroke changed '+name);
    assert.equal(await hash(),digests.history,'undo '+name);
    await nextRevision(()=>page.keyboard.press(mod+'+Shift+z'));
    assert.equal(await hash(),digests[name],'redo '+name);
    await page.reload();await wait4K();
    assert.equal(await hash(),digests[name],'reopen '+name);
    await stage.focus();
    await nextRevision(()=>page.keyboard.press(mod+'+z'));
  }
  // Hold a real 4K result after its body is read. New strokes must publish
  // fast frames before that body is released, then refine only their revision.
  await layer.locator('.document-layer-select').click();
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await editor.getByRole('button',{name:'实际像素',exact:true}).click();
  await stage.evaluate((el,heldRevision)=>{
    const brushBurst=window.brushBurst={heldRevision,displayed:[],writes:[]};
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
  await page.waitForFunction(()=>Boolean(window.brushBurst.release));
  const held=doc.revision;
  const target=held+3,begin=performance.now();
  for(const y of [.47,.50,.53])await drag(y);
  await page.waitForFunction(revision=>window.brushBurst.writes.some(([seen,size])=>seen===revision&&size>0&&size<4096),target);
  const burstFast=Math.round(performance.now()-begin);
  await page.evaluate(()=>window.brushBurst.release());
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
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({timings,digests,burst:{strokes:3,fastMs:burstFast}}));
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
