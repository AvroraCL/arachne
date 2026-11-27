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
import {imagePlacement} from '../public/image-warp.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-image-layout-'));
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const {port}=socket.address();
await new Promise(resolve=>socket.close(resolve));
const origin='http://127.0.0.1:'+port,headers={Origin:origin,'Content-Type':'application/json'};
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{
  cwd:new URL('..',import.meta.url),stdio:'inherit',windowsHide:true,
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',PYTHONDONTWRITEBYTECODE:'1'}
});
let browser;
async function until(read,label){
  for(let n=0;n<250;n++){const value=await read();if(value)return value;await delay(120);}
  throw Error('等待超时：'+label);
}
async function api(route,body,status=200){
  const res=await fetch(origin+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
  const result=await res.json();
  assert.equal(res.status,status,JSON.stringify(result).slice(0,500));
  return result;
}
const op=(action,fields={})=>({op:'image',action,documentId:'layout',...fields});
const add=(layerId,name,kind,patch={},parentId)=>op('addLayer',{layerId,parentId,kind,patch:{name,...patch}});
const shape={kind:'rectangle',width:1800,height:450,fill:'#4ad978',stroke:null,strokeWidth:0,cornerRadius:0};
async function run(){
  await until(()=>fetch(origin+'/api/health').then(r=>r.ok,()=>false),'启动');
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'图片、文字与编号排版',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  const layers=value=>value.paint.imageDocuments.layout.layers;
  const layer=(id,value=doc)=>layers(value).find(item=>item.id===id);
  async function commands(...operations){
    doc=await api(paint+'/commands',{revision:doc.revision,operations});return doc;
  }
  async function waitRevision(label){
    const revision=doc.revision;
    doc=await until(async()=>{const current=await api(route);return current.revision===revision+1&&current;},label);
    return doc;
  }
  const source=execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image,ImageDraw
import sys
image=Image.new('RGBA',(120,100))
draw=ImageDraw.Draw(image)
draw.ellipse((6,8,112,92),fill=(242,124,43,255))
draw.rectangle((56,46,63,53),fill=(41,93,252,255))
image.save(sys.stdout.buffer,format='PNG')
`]).toString('base64');
  await commands(op('create'),add('group','装饰组','group'),
    add('strip','装饰条','shape',{shape,x:.27,y:.68,scale:.26},'group'),
    add('ramp','装饰条渐变','gradient',{gradient:{kind:'linear',start:[.16,.66],end:[.38,.71],
      colors:['#0758bd','#66e9b5'],alpha:[1,.4],clip:[.16,.655,.38,.705]}},'group'),
    add('ink','编号衬底','pixel',{},'group'),
    op('stroke',{layerId:'ink',target:'pixels',stroke:{uv:true,rect:[.52,.48,.62,.58],opacity:1,color:'#a758e3',erase:false}}),
    add('tone','局部反相','adjustment',{adjustment:{type:'invert'},maskBase:0},'group'),
    op('stroke',{layerId:'tone',target:'mask',stroke:{uv:true,rect:[.53,.49,.565,.57],opacity:1,value:1}}),
    add('disabled-tone','未链接的备用调色','adjustment',{adjustment:{type:'invert'},visible:false},'group'),
    op('updateLayer',{layerId:'disabled-tone',patch:{maskLinked:false}}));
  async function sampleArtwork(points){
    const res=await fetch(origin+paint+'/image-live',{method:'POST',headers,body:JSON.stringify({
      revision:doc.revision,documentId:'layout',resolution:512
    })});
    assert.equal(res.status,200);
    const bytes=new Uint8Array(await res.arrayBuffer());
    return points.map(([x,y])=>{
      const start=(Math.floor(y*512)*512+Math.floor(x*512))*4;
      return [...bytes.subarray(start,start+4)];
    });
  }
  const inkSamples=[[.55,.53],[.59,.53],[.20,.68],[.34,.68],[.41,.68]];
  const inkColors=await sampleArtwork(inkSamples);
  assert.notDeepEqual(inkColors[0],inkColors[1]);
  assert.deepEqual(inkColors[1],[167,88,227,255]);
  assert.equal(inkColors[2][3],255);
  assert.notDeepEqual(inkColors[2],inkColors[3]);
  assert.equal(inkColors[4][3],0);
  doc=(await api(paint+'/assets',{revision:doc.revision,name:'橙色标志.png',data:source,
    imageLayer:{documentId:'layout',layerId:'logo',x:.23,y:.30,scale:.24}},201)).document;
  const text=await api(paint+'/text',{revision:doc.revision,documentId:'layout',placement:{x:.62,y:.28},
    text:{content:'A-12',fontSize:300,weight:700,align:'center',color:'#d5eaf7'}},201);
  doc=text.document;
  const original=structuredClone(layers(doc));
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:940}});
  const errors=[],probes=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{
    if(!response.url().endsWith('/image-layout-probe'))return;
    void response.json().then(value=>probes.push([response.request().postDataJSON(),response.status(),value]),()=>{});
  });
  page.on('requestfailed',request=>{
    if(request.url().endsWith('/image-layout-probe'))probes.push([request.postDataJSON(),request.failure()]);
  });
  await page.goto(origin+'/?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('.editor-area[data-editor=image]').first();
  const panel=page.locator('.editor-area[data-editor=imageLayers]').first();
  const row=id=>panel.locator('[data-image-layer-id="'+id+'"]');
  const select=id=>row(id).locator('.document-layer-name');
  const canvas=editor.getByLabel('图像文档画布');
  const modifier=process.platform==='darwin'?'Meta':'Control';
  await select('logo').waitFor();
  await canvas.focus();
  await page.keyboard.press('v');
  await editor.getByRole('button',{name:'移动图层',exact:true,pressed:true}).waitFor();
  const box=await canvas.boundingBox();
  const point=([x,y])=>[box.x+x*box.width,box.y+y*box.height];
  if(process.argv.includes('--joint-feedback')){
    const stage=editor.locator('.document-image-stage');
    const ready=()=>stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:90000});
    await select('logo').click();await select(text.layerId).click({modifiers:[modifier]});
    assert.equal(await panel.locator('[data-image-layer-id][data-selected]').count(),2);
    await editor.getByRole('checkbox',{name:'吸附参考线'}).uncheck();
    await ready();
    await canvas.evaluate(c=>{
      const ctx=c.getContext('2d'),side=c.width;
      const x=Math.floor(.47*side),y=Math.floor(.20*side),w=Math.floor(.3*side),h=Math.floor(.16*side);
      const data=ctx.getImageData(x,y,w,h).data;
      let title;
      const ink=i=>data[i+3]===255&&data[i]===213&&data[i+1]===234;
      for(let j=6;j<h-6&&!title;j++)for(let i=6;i<w-6;i++){
        if([[0,0],[-5,-5],[5,-5],[-5,5],[5,5]].every(([a,b])=>ink(4*((j+b)*w+i+a)))){
          title=[(x+i)/side,(y+j)/side];break;
        }
      }
      if(!title)throw Error('没有找到标题笔画内部像素');
      window.jointPixels=(dx,dy)=>{
        const pixel=(u,v)=>ctx.getImageData(Math.floor(u*c.width),Math.floor(v*c.height),1,1).data;
        const logo=pixel(.23+dx,.30+dy),letter=pixel(title[0]+dx,title[1]+dy);
        return logo[2]>220&&logo[0]<70&&logo[3]>220&&letter[0]>180&&letter[1]>215&&letter[2]>225&&letter[3]>220;
      };
      window.jointMoved=(dst)=>new Promise((resolve,reject)=>{
        document.addEventListener('pointermove',()=>{
          const start=performance.now(),put=ctx.putImageData;
          let write;
          ctx.putImageData=function(...args){const result=put.apply(this,args);write=performance.now()-start;return result;};
          function sample(){
            const readStart=performance.now();
            if(window.jointPixels(...dst)){
              ctx.putImageData=put;resolve({write,observed:performance.now()-start,readback:performance.now()-readStart});return;
            }
            if(performance.now()-start>3500){ctx.putImageData=put;reject(Error('标题或标志没有跟到新位置'));return;}
            requestAnimationFrame(sample);
          }
          requestAnimationFrame(sample);
        },{capture:true,once:true});
      });
    });
    let drafts=0;
    page.on('request',req=>{if(req.url().endsWith('/image-live')&&req.postDataJSON().operation?.action==='layoutLayers')drafts++;});
    const trajectory=[[0,.09],[-.035,.24],[.04,.38]];
    for(let pass=0;pass<3;pass++){
      const rect=await canvas.boundingBox();
      const mouse=(dx,dy)=>page.mouse.move(rect.x+(.23+dx)*rect.width,rect.y+(.30+dy)*rect.height);
      await mouse(0,0);await page.mouse.down();
      const timing=[];
      for(const dst of trajectory){
        await page.evaluate(dst=>{window.jointSample=window.jointMoved(dst);},dst);
        await mouse(...dst);timing.push(await page.evaluate(()=>window.jointSample));
      }
      await page.evaluate(()=>{
        window.jointTrace={frames:0,wrong:0};
        const trace=()=>{const t=window.jointTrace;t.frames++;if(!window.jointPixels(.04,.38))t.wrong++;t.id=requestAnimationFrame(trace);};
        trace();
      });
      await page.mouse.up();await waitRevision('联合拖移');await ready();
      const trace=await page.evaluate(()=>{cancelAnimationFrame(window.jointTrace.id);return window.jointTrace;});
      console.log('JOINT MOVE',JSON.stringify({timing,trace,drafts}));
      assert.ok(trace.frames>1);
      assert.equal(trace.wrong,0,'松手后旧帧盖住了新位置');
      assert.ok(Math.abs(layer('logo').y-.68)<.002&&Math.abs(layer(text.layerId).y-.66)<.002);
      const moved=structuredClone(layers(doc));
      await canvas.focus();await page.keyboard.press(modifier+'+z');await waitRevision('撤销联合拖移');await ready();
      assert.deepEqual(layers(doc),original);assert.ok(await page.evaluate(()=>window.jointPixels(0,0)));
      await page.keyboard.press(modifier+'+Shift+z');await waitRevision('重做联合拖移');await ready();
      assert.deepEqual(layers(doc),moved);assert.ok(await page.evaluate(()=>window.jointPixels(.04,.38)));
      await page.keyboard.press(modifier+'+z');await waitRevision('复位排版');await ready();
    }
    assert.equal(drafts,0,'联合平移重复请求了后台草稿');
    // Put a translucent swatch above both moving layers. Compare what is shown
    // under the mouse to the committed 4K compositor at the very same pixel.
    await commands({...add('backdrop','有色底板','shape',{shape:{...shape,width:4096,height:4096,fill:'#487242'},x:.5,y:.5,scale:1}),index:0},
      op('updateLayer',{layerId:'logo',patch:{x:.42,y:.35,opacity:.5}}),
      add('front-swatch','半透明校色条','shape',{shape:{...shape,width:1400,height:260,fill:'#f09b34'},x:.27,y:.68,scale:.30,opacity:.55}));
    const frontLoaded=page.waitForResponse(r=>r.url().endsWith('/image-live')&&r.request().postDataJSON()?.isolatedImageLayer==='front-swatch'
      &&r.request().postDataJSON().window&&r.status()===200);
    await page.reload();await select('logo').click();await select(text.layerId).click({modifiers:[modifier]});
    await canvas.focus();await page.keyboard.press('v');await ready();
    await (await frontLoaded).finished();
    const rect=await canvas.boundingBox();
    const at=(u,v)=>[rect.x+u*rect.width,rect.y+v*rect.height];
    const sample=(u,v)=>canvas.evaluate((c,[u,v])=>[...c.getContext('2d').getImageData(Math.floor(u*c.width),Math.floor(v*c.height),1,1).data],[u,v]);
    const before=await sample(.27,.68),ink=await sample(.42,.35);
    await stage.screenshot({path:path.join(data,'joint-before.png')});
    await page.mouse.move(...at(.42,.35));await page.mouse.down();
    await page.mouse.move(...at(.27,.68),{steps:9});
    const under=await sample(.27,.68);
    assert.notDeepEqual(under,before);assert.notDeepEqual(under,ink);
    await stage.screenshot({path:path.join(data,'joint-drag.png')});
    await page.mouse.up();await waitRevision('在校色条下移动');await ready();
    const saved=await sample(.27,.68);
    assert.ok(under.every((v,i)=>Math.abs(v-saved[i])<=1),JSON.stringify({under,saved}));
    await canvas.focus();await page.keyboard.press(modifier+'+z');await waitRevision('撤销遮挡');await ready();
    assert.deepEqual(await sample(.27,.68),before);
    await page.keyboard.press(modifier+'+Shift+z');await waitRevision('重做遮挡');await ready();
    assert.deepEqual(await sample(.27,.68),saved);
    assert.equal(drafts,0,'通过上方色条时应继续本地合成');
    // Release preparation only after the worker draft is actually on the canvas.
    // The ongoing gesture must switch to local writes without requiring a new press.
    let releasePlane;
    const gate=new Promise(resolve=>{releasePlane=resolve;});
    const hold=async route=>{
      if(route.request().postDataJSON().movePlane?.plane==='content')await gate;
      await route.continue();
    };
    await page.route('**/image-live',hold);
    await page.reload();await select('logo').click();await select(text.layerId).click({modifiers:[modifier]});
    await canvas.focus();await page.keyboard.press('v');await ready();
    const waitWidth=width=>canvas.evaluate((c,width)=>new Promise((resolve,reject)=>{
      const start=performance.now();
      function check(){
        if((c.width===4096)===width){resolve();return;}
        if(performance.now()-start>12000){reject(Error('联合平移预览没有交接'));return;}
        requestAnimationFrame(check);
      }
      check();
    }),width);
    await page.mouse.move(...at(.27,.68));await page.mouse.down();await page.mouse.move(...at(.32,.74));
    try{await waitWidth(false);}finally{releasePlane();}
    await waitWidth(true);
    const requests=drafts;
    await page.mouse.move(...at(.35,.78));
    await page.keyboard.press('Escape');await page.mouse.up();
    assert.equal(drafts,requests);
    assert.deepEqual(await sample(.27,.68),saved);
    await page.unroute('**/image-live',hold);
    console.log('PASS joint foreground overlap',JSON.stringify({under,saved,data}));
    // Real stack order, bottom to top: logo / translucent band / lettering.
    // Their padded source bounds intersect. Hold the first write so the next
    // press cannot accidentally pass by waiting for a server acknowledgement.
    await commands(op('updateLayer',{layerId:'front-swatch',patch:{visible:false}}),
      op('updateLayer',{layerId:'logo',patch:{x:.27,y:.68}}),
      op('updateLayer',{layerId:text.layerId,patch:{x:.47,y:.61}}),
      {...add('midband','半透明色带','shape',{x:.56,y:.49,scale:.47,opacity:.55,
        shape:{...shape,width:1250,height:530,fill:'#23bee8'}}),index:layers(doc).findIndex(l=>l.id===text.layerId)});
    const baseLayers=structuredClone(layers(doc)),revision=doc.revision;
    const band=page.waitForResponse(r=>r.url().endsWith('/image-live')&&r.request().postDataJSON()?.isolatedImageLayer==='midband'&&r.ok());
    await page.reload();await select('logo').click();await select(text.layerId).click({modifiers:[modifier]});
    await canvas.focus();await page.keyboard.press('v');await ready();await (await band).finished();
    await editor.getByRole('checkbox',{name:'吸附参考线'}).uncheck();
    const letter=await canvas.evaluate(c=>{
      const left=1560,top=2360,w=760,h=330,d=c.getContext('2d').getImageData(left,top,w,h).data;
      for(let y=5;y<h-5;y++)for(let x=5;x<w-5;x++){
        if([[0,0],[-4,-4],[4,-4],[-4,4],[4,4]].every(([dx,dy])=>{
          const i=4*((y+dy)*w+x+dx);return d[i]===213&&d[i+1]===234&&d[i+2]===247;
        }))return [(left+x)/c.width,(top+y)/c.height];
      }
      throw Error('未找到 A-12 笔画内部');
    });
    const readPair=async(dx,dy)=>[await sample(.27+dx,.68+dy),await sample(letter[0]+dx,letter[1]+dy)];
    const offsets=[[0,0],[.19,-.16],[.32,-.12]],pairs=[await readPair(0,0)];
    const draftsBefore=drafts;
    let releaseWrite;
    const held=new Promise(resolve=>{releaseWrite=resolve;});
    const holdWrite=async route=>{await held;await route.continue();};
    await page.route('**/paint/commands',holdWrite);
    try{
      await page.mouse.move(...at(.27,.68));await page.mouse.down();
      await page.mouse.move(...at(.46,.52));
      pairs.push(await readPair(...offsets[1]));
      assert.deepEqual(pairs[1][1],[213,234,247,255]);
      assert.notDeepEqual(pairs[1][0],pairs[0][0]);
      await page.mouse.up();await page.mouse.down();await page.mouse.move(...at(.59,.56));
      pairs.push(await readPair(...offsets[2]));
      assert.deepEqual(pairs[2][1],[213,234,247,255]);
      await page.mouse.up();
      assert.equal((await api(route)).revision,revision);
    }finally{releaseWrite();}
    doc=await until(async()=>{const next=await api(route);return next.revision===revision+2&&next;},'两个独立移动提交');
    await ready();await page.unroute('**/paint/commands',holdWrite);
    assert.equal(drafts,draftsBefore);
    const checkPair=async i=>{
      const displayed=await readPair(...offsets[i]);
      assert.ok(displayed.every((p,j)=>p.every((n,k)=>Math.abs(n-pairs[i][j][k])<=1)),JSON.stringify({displayed,drag:pairs[i]}));
      for(const id of ['logo',text.layerId]){
        const initial=baseLayers.find(l=>l.id===id);
        assert.ok(Math.abs(layer(id).x-initial.x-offsets[i][0])<.002&&Math.abs(layer(id).y-initial.y-offsets[i][1])<.002);
      }
    };
    await checkPair(2);
    for(const [key,i] of [['+z',1],['+z',0],['+Shift+z',1],['+Shift+z',2]]){
      await canvas.focus();await page.keyboard.press(modifier+key);await waitRevision('连续移动的独立历史');await ready();await checkPair(i);
    }
    console.log('PASS interleaved translucent band and immediate second drag with first save held');

    assert.deepEqual(errors,[]);
    return;
  }
  if(process.argv.includes('--move-feedback')){
    const stage=editor.locator('.document-image-stage');
    const ready=()=>stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:90000});
    await select('logo').click();
    await editor.getByRole('checkbox',{name:'吸附参考线'}).uncheck();
    await ready();
    for(let n=0;n<4;n++){
      const rect=await canvas.boundingBox();
      const at=(u,v)=>[rect.x+u*rect.width,rect.y+v*rect.height];
      await page.mouse.move(...at(.23,.30));await page.mouse.down();
      const motion=[];
      for(const b of [at(.30,.32),at(.34,.33),at(.38,.34),at(.42,.35)]){
        await canvas.evaluate((c,[x,y])=>{
          const ctx=c.getContext('2d'),box=c.getBoundingClientRect();
          const u=(x-box.left)/box.width,v=(y-box.top)/box.height;
          window.moveTime=new Promise(resolve=>{
            document.addEventListener('pointermove',()=>{
              const start=performance.now();
              let write;
              const put=ctx.putImageData;
              ctx.putImageData=function(...args){
                const result=put.apply(this,args);
                write=performance.now()-start;
                return result;
              };
              function see(){
                const frame=performance.now();
                const [r,,b,a]=ctx.getImageData(Math.floor(u*c.width),Math.floor(v*c.height),1,1).data;
                if(b>160&&r<110&&a>180){
                  ctx.putImageData=put;
                  resolve({write,observed:performance.now()-start,readback:performance.now()-frame});
                }
                else requestAnimationFrame(see);
              }
              requestAnimationFrame(see);
            },{capture:true,once:true});
          });
        },b);
        await page.mouse.move(...b);
        const elapsed=await page.evaluate(()=>Promise.race([window.moveTime,new Promise(resolve=>setTimeout(()=>resolve(null),3000))]));
        if(elapsed===null){
          const diagnostic=await stage.evaluate(el=>({stage:{...el.dataset},outline:el.querySelector('.document-layout-outline')?.getAttribute('points'),
            canvas:el.querySelector('canvas').width}));
          throw Error('拖动后没有读到标记像素 '+JSON.stringify({errors,diagnostic}));
        }
        motion.push(elapsed);
      }
      await stage.evaluate((el,revision)=>{
        window.moveReady=new Promise(resolve=>{
          document.addEventListener('pointerup',()=>{
            const start=performance.now();
            const observer=new MutationObserver(()=>{
              if(Number(el.dataset.previewRevision)===revision&&el.dataset.previewSize==='4096'){
                observer.disconnect();resolve(performance.now()-start);
              }
            });
            observer.observe(el,{attributes:true});
          },{capture:true,once:true});
        });
      },doc.revision+1);
      const released=performance.now();await page.mouse.up();
      await waitRevision('移动标志');await ready();
      console.log('MOVE',n,JSON.stringify({motion,ready:performance.now()-released,canvasReady:await page.evaluate(()=>window.moveReady)}));
      assert.ok(Math.abs(layer('logo').x-.42)<.005);
      const colors=await sampleArtwork([[.42,.35],[.23,.30]]);
      assert.deepEqual(colors,[[41,93,252,255],[0,0,0,0]]);
      await canvas.focus();await page.keyboard.press(modifier+'+z');await waitRevision('撤销移动');await ready();
      assert.deepEqual(layers(doc),original);
    }
    await canvas.focus();await page.keyboard.press(modifier+'+Shift+z');await waitRevision('重做移动');await ready();
    await page.reload();await ready();
    const center=await canvas.evaluate(c=>[...c.getContext('2d').getImageData(Math.floor(.42*c.width),Math.floor(.35*c.height),1,1).data]);
    assert.deepEqual(center,[41,93,252,255]);
    if(process.argv.includes('--check-move-blend')){
      await commands({...add('backdrop','有色底板','shape',{shape:{...shape,width:4096,height:4096,fill:'#487242'},x:.5,y:.5,scale:1}),index:0},
        op('updateLayer',{layerId:'logo',patch:{opacity:.5}}));
      const prepared=page.waitForResponse(r=>r.url().endsWith('/image-live')&&r.request().postDataJSON().isolatedImageLayer==='logo'
        &&Boolean(r.request().postDataJSON().window)&&r.status()===200);
      await page.reload();await select('logo').click();await canvas.focus();await page.keyboard.press('v');
      await ready();await (await prepared).finished();
      await page.route('**/image-live',r=>r.request().postDataJSON().operation?.action==='layoutLayers'?r.abort():r.continue());
      const rect=await canvas.boundingBox(),at=(u,v)=>[rect.x+u*rect.width,rect.y+v*rect.height];
      const pixel=(u,v)=>canvas.evaluate((c,[u,v])=>[...c.getContext('2d').getImageData(Math.floor(u*c.width),Math.floor(v*c.height),1,1).data],[u,v]);
      const start=await pixel(.42,.35),background=await pixel(.27,.35);
      assert.notDeepEqual(start,background);
      await page.mouse.move(...at(.42,.35));await page.mouse.down();await page.mouse.move(...at(.27,.35));
      assert.deepEqual(await pixel(.27,.35),start);
      assert.deepEqual(await pixel(.42,.35),background);
      await page.keyboard.press('Escape');await page.mouse.up();
      assert.deepEqual(await pixel(.27,.35),background);
      assert.deepEqual(await pixel(.42,.35),start);
      console.log('PASS translucent move over colored background and immediate cancel with worker drafts unavailable');
    }
    assert.deepEqual(errors,[]);
    return;
  }
  const pickRoute='**/image-layout-probe';
  let firstPick,releasePick,firstPickCancelled;
  const firstPickStarted=new Promise(resolve=>{firstPick=resolve;});
  const holdPick=new Promise(resolve=>{releasePick=resolve;});
  const firstPickFailed=new Promise(resolve=>{firstPickCancelled=resolve;});
  page.on('requestfailed',request=>{
    if(request.url().endsWith('/image-layout-probe')&&request.postDataJSON()?.point?.[0]<.3)firstPickCancelled(true);
  });
  const delayFirstPick=async route=>{
    const p=route.request().postDataJSON()?.point;
    if(!p||p[0]>.3){await route.continue();return;}
    firstPick();
    await holdPick;
    await route.continue().catch(error=>{
      if(!/already handled/i.test(error.message))throw error;
    });
  };
  await page.route(pickRoute,delayFirstPick);
  await page.mouse.click(...point([.23,.30]));
  await until(()=>Promise.race([firstPickStarted.then(()=>true),delay(25,false)]),'第一次画布命中');
  await page.keyboard.down('Shift');
  const secondPick=page.waitForResponse(response=>response.url().endsWith('/image-layout-probe')&&response.request().postDataJSON()?.point?.[0]>.5);
  await page.mouse.click(...point([.57,.53]));
  await page.keyboard.up('Shift');
  const cancelled=await Promise.race([firstPickFailed,secondPick.then(()=>false)]);
  if(!cancelled){
    const response=await secondPick;
    assert.deepEqual(await response.json(),{hit:'ink'});
    assert.equal(await row('ink').getAttribute('data-selected'),null);
  }
  releasePick();
  assert.equal(cancelled,false,'第二次点击取消了第一次还在等待的画布命中');
  try{await row('ink').locator('xpath=self::*[@data-selected]').waitFor({timeout:12000});}
  catch(error){
    await page.screenshot({path:path.join(data,'selection-failed.png')});
    console.log('selection diagnostics',await panel.locator('[data-image-layer-id][data-selected]').evaluateAll(rows=>rows.map(row=>row.dataset.imageLayerId)),JSON.stringify(probes));
    throw error;
  }
  assert.equal(await row('logo').getAttribute('data-selected'),'');
  await row('ink').locator('xpath=self::*[@data-active]').waitFor();
  await page.unroute(pickRoute,delayFirstPick);
  let finishCancelledPick;
  const cancelPick=async route=>{
    if(!route.request().postDataJSON()?.point){await route.continue();return;}
    await new Promise(resolve=>{finishCancelledPick=resolve;});
    await route.continue().catch(error=>{
      if(!/already handled/i.test(error.message))throw error;
    });
  };
  await page.route(pickRoute,cancelPick);
  const stalePick=page.waitForRequest(req=>req.url().endsWith('/image-layout-probe')&&req.postDataJSON()?.point?.[0]>.6);
  await page.keyboard.down('Shift');
  await page.mouse.click(...point([.625,.28]));
  await page.keyboard.up('Shift');
  await stalePick;
  await until(()=>finishCancelledPick,'等待被拦截的命中');
  const aborted=page.waitForEvent('requestfailed',{predicate:req=>req.url().endsWith('/image-layout-probe')&&req.postDataJSON()?.point?.[0]>.6});
  await page.keyboard.press('Escape');
  await aborted;
  finishCancelledPick();
  await page.unroute(pickRoute,cancelPick);
  assert.equal(await row(text.layerId).getAttribute('data-selected'),null);
  assert.equal(await row('ink').getAttribute('data-active'),'');
  assert.equal((await api(route)).revision,doc.revision);
  console.log('PASS ordered canvas picks, Shift active layer and cancellation before a slow hit returns');
  const pick=async(x,y,resolution)=>api(paint+'/image-layout-probe',{revision:doc.revision,documentId:'layout',layerIds:[],point:[x,y],resolution});
  assert.deepEqual(await pick(.57,.53),{hit:'ink'});
  assert.deepEqual(await pick(.12,.21),{hit:null});
  await select('group').click({modifiers:[modifier]});
  await select(text.layerId).click({modifiers:[modifier]});
  await editor.getByRole('checkbox',{name:'吸附参考线'}).uncheck();
  const drag=async(a,b)=>{
    const bounds=await canvas.boundingBox();
    const coords=([x,y])=>[bounds.x+x*bounds.width,bounds.y+y*bounds.height];
    await page.mouse.move(...coords(a));await page.mouse.down();
    await page.mouse.move(...coords(b),{steps:12});await page.mouse.up();
  };
  // A fast release can arrive before the final pointermove is delivered.
  const dragBox=await canvas.boundingBox();
  const dragStart=[dragBox.x+.23*dragBox.width,dragBox.y+.30*dragBox.height];
  const dragEnd=[dragBox.x+.31*dragBox.width,dragBox.y+.34*dragBox.height];
  const input=await page.context().newCDPSession(page);
  await input.send('Input.dispatchMouseEvent',{type:'mousePressed',x:dragStart[0],y:dragStart[1],button:'left',buttons:1,clickCount:1});
  await input.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:dragEnd[0],y:dragEnd[1],button:'left',buttons:0,clickCount:1});
  await input.detach();
  const moved=await waitRevision('四层联动移动');
  assert.ok(Math.abs(layer('logo').x-.31)<.003);
  assert.ok(Math.abs(layer('strip').x-.35)<.003);
  assert.equal(layer('ink').strokes.filter(stroke=>stroke.transformUV).length,1);
  assert.equal(layer(text.layerId).text.content,'A-12');
  const movedInk=layer('ink').strokes.at(-1).transformUV.offset;
  const sampleOffset=inkSamples.map(([x,y])=>[x+movedInk[0],y+movedInk[1]]);
  const nearColors=(actual,expected)=>assert.ok(actual.every((color,i)=>color.every((value,c)=>Math.abs(value-expected[i][c])<=3)),
    JSON.stringify({actual,expected}));
  nearColors(await sampleArtwork(sampleOffset),inkColors);
  assert.deepEqual(layer('tone').maskTransform.slice(4),movedInk);
  assert.deepEqual(layer('ramp').gradientTransform.slice(4),movedInk);
  assert.equal(layer('disabled-tone').maskTransform,undefined);
  const selectedCount=await panel.locator('[data-image-layer-id][data-selected]').count();
  assert.equal(selectedCount,4);
  await editor.getByRole('button',{name:'联合变换',exact:true}).waitFor();
  await canvas.focus();await page.keyboard.press('h');
  let unblockBounds,probeStarted,probeContinued;
  const boundsBarrier=new Promise(resolve=>{unblockBounds=resolve;});
  const boundsProbe=new Promise(resolve=>{probeStarted=resolve;});
  const boundsContinued=new Promise(resolve=>{probeContinued=resolve;});
  const probeUrl='**/image-layout-probe';
  const blockProbe=async route=>{
    if(route.request().postDataJSON()?.layerIds?.length){
      probeStarted();await boundsBarrier;
    }
    try{await route.continue();}finally{probeContinued();}
  };
  await page.route(probeUrl,blockProbe);
  await page.reload();
  await canvas.focus();
  await editor.getByRole('button',{name:'抓手',exact:true,pressed:true}).waitFor();
  await page.keyboard.press(modifier+'+t');
  const transformOptions=editor.locator('.document-layout-options');
  await Promise.race([boundsProbe,delay(10000).then(()=>{throw Error('联合变换没有请求图层边界');})]);
  assert.equal(await transformOptions.isVisible(),false);
  unblockBounds();
  await boundsContinued;
  await transformOptions.waitFor();
  await page.unroute(probeUrl,blockProbe);
  const angle=transformOptions.locator('input[aria-label="旋转"]'),scale=transformOptions.locator('input[aria-label="等比缩放"]');
  for(const [control,value] of [[angle,'30'],[scale,'125']]){
    const field=control.locator('..');
    await field.dblclick();
    const entry=field.getByRole('spinbutton',{name:'输入数值'});
    await entry.fill(value);await entry.press('Enter');
  }
  await transformOptions.getByRole('button',{name:'应用',exact:true}).click();
  const transformed=await waitRevision('联合旋转缩放');
  assert.ok(Math.abs(layer('logo').rotation-30)<.001);
  assert.ok(Math.abs(layer('logo').scale-.30)<.001);
  assert.ok(Math.abs(layer('strip').scale-.325)<.001);
  assert.equal(layer('ink').strokes.at(-1).transformUV.angle,30);
  assert.equal(layer('ink').strokes.at(-1).transformUV.scale[0],1.25);
  const pivot=layer('ink').strokes.at(-1).transformUV.pivot;
  const relative=([x,y])=>[x-pivot[0],y-pivot[1]];
  for(const id of ['logo','strip',text.layerId]){
    const [x,y]=relative([layer(id,moved).x,layer(id,moved).y]);
    const [tx,ty]=relative([layer(id).x,layer(id).y]);
    assert.ok(Math.abs(tx-1.25*(x*Math.sqrt(3)/2-y/2))<1e-7);
    assert.ok(Math.abs(ty-1.25*(x/2+y*Math.sqrt(3)/2))<1e-7);
  }
  const inkTransform=layer('ink').strokes.at(-1).transformUV;
  const projected=sampleOffset.map(p=>{
    const [x,y]=relative(p);
    return [pivot[0]+inkTransform.offset[0]+1.25*(x*Math.sqrt(3)/2-y/2),
      pivot[1]+inkTransform.offset[1]+1.25*(x/2+y*Math.sqrt(3)/2)];
  });
  nearColors(await sampleArtwork(projected),inkColors);
  assert.deepEqual(layer('tone').adjustment,{type:'invert'});
  assert.deepEqual(layer('ramp').gradient,layer('ramp',moved).gradient);
  assert.deepEqual(layers(doc).map(item=>item.kind),original.map(item=>item.kind));
  await select('ramp').click();
  await editor.getByRole('button',{name:'渐变工具',exact:true}).click();
  const gradientHandle=editor.locator('[data-gradient-handle=end]');
  const [ga,gb,gd,ge,gx,gy]=layer('ramp').gradientTransform;
  const [gu,gv]=layer('ramp').gradient.end;
  const endPoint=[ga*gu+gd*gv+gx,gb*gu+ge*gv+gy];
  const rampCanvas=await canvas.boundingBox();
  const gradientPoint=([u,v])=>[rampCanvas.x+u*rampCanvas.width,rampCanvas.y+v*rampCanvas.height];
  const expected=gradientPoint(endPoint);
  await gradientHandle.waitFor();
  const handleBox=await gradientHandle.boundingBox();
  assert.ok(Math.abs(handleBox.x+handleBox.width/2-expected[0])<1,JSON.stringify({handleBox,expected,endPoint}));
  assert.ok(Math.abs(handleBox.y+handleBox.height/2-expected[1])<1,JSON.stringify({handleBox,expected,endPoint}));
  await page.screenshot({path:path.join(data,'transformed-gradient.png')});
  await page.mouse.move(...expected);await page.mouse.down();
  await page.mouse.move(...gradientPoint([endPoint[0]+.04,endPoint[1]]),{steps:12});await page.mouse.up();
  await waitRevision('修改联合变换后的渐变手柄');
  assert.notDeepEqual(layer('ramp').gradient.end,layer('ramp',transformed).gradient.end);
  assert.deepEqual(layer('ramp').gradient.clip,layer('ramp',transformed).gradient.clip);
  assert.deepEqual(layer('ramp').gradientTransform,layer('ramp',transformed).gradientTransform);
  await canvas.focus();await page.keyboard.press(modifier+'+z');
  await waitRevision('撤销渐变手柄编辑');
  assert.deepEqual(layers(doc),layers(transformed));
  await select('logo').click();
  for(const id of ['ink','group',text.layerId])await select(id).click({modifiers:[modifier]});
  await canvas.focus();await page.keyboard.press('v');
  await editor.getByRole('button',{name:'联合变换',exact:true}).click();
  await angle.locator('..').dblclick();
  const angleEntry=angle.locator('..').getByRole('spinbutton',{name:'输入数值'});
  await angleEntry.fill('60');await angleEntry.press('Enter');
  await editor.locator('.document-image-stage').focus();
  await page.keyboard.press('Escape');
  assert.equal((await api(route)).revision,doc.revision);
  await editor.getByRole('button',{name:'对齐与分布'}).click();
  await page.getByRole('menuitem',{name:'顶对齐',exact:true}).click();
  await waitRevision('对齐保留组内相对位置');
  const sameOffset=layer('strip').y-layer('strip',transformed).y;
  assert.ok(Math.abs(layer('ink').strokes.at(-1).transformUV.offset[1]-sameOffset)<1e-6);
  await editor.getByRole('button',{name:'对齐与分布'}).click();
  await page.getByRole('menuitem',{name:'水平等距分布',exact:true}).click();
  await waitRevision('水平等距分布');
  await page.mouse.move(...point([.5,.5]));
  await editor.getByRole('button',{name:'参考线',exact:true}).click();
  await page.getByRole('menuitem',{name:/垂直参考线/}).click();
  const reference=editor.locator('.document-reference-line');
  await reference.waitFor({state:'attached'});
  const line=Number(await reference.getAttribute('x1'));
  await select('logo').click();
  await editor.getByRole('checkbox',{name:'吸附参考线'}).check();
  const logo=layer('logo');
  const originX=Number(await editor.locator('.document-layout-outline').getAttribute('points').then(value=>value.split(' ')[0].split(',')[0]));
  const snapBox=await canvas.boundingBox();
  const startX=snapBox.x+logo.x*snapBox.width,startY=snapBox.y+logo.y*snapBox.height;
  const delta=line-originX;
  await page.mouse.move(startX,startY);await page.mouse.down();
  await page.mouse.move(startX+delta,startY,{steps:10});
  await editor.locator('.document-snap-line').first().waitFor({state:'attached'});
  await page.mouse.up();
  await waitRevision('图层边缘吸附参考线');
  const snappedLeft=Number(await editor.locator('.document-layout-outline').getAttribute('points').then(value=>value.split(' ')[0].split(',')[0]));
  assert.ok(Math.abs(snappedLeft-line)<1.1,JSON.stringify({snappedLeft,line,originX}));
  await canvas.focus();await page.keyboard.press(modifier+'+z');
  await waitRevision('撤销一次吸附移动');
  await page.reload();await select('logo').waitFor();
  await reference.waitFor({state:'attached'});
  await page.screenshot({path:path.join(data,'layout-workspace.png')});
  const raster=await fetch(origin+paint+'/image-export',{method:'POST',headers,
    body:JSON.stringify({revision:doc.revision,documentId:'layout'})});
  assert.ok(raster.ok);
  const png=path.join(data,'arranged.png');
  await fs.writeFile(png,Buffer.from(await raster.arrayBuffer()));
  execFileSync(pythonExecutable(),['-B','-c',`
import numpy as np,sys
from PIL import Image
p=np.asarray(Image.open(sys.argv[1]))
assert p.shape==(4096,4096,4)
assert np.count_nonzero((p[:,:,0]>180)&(p[:,:,1]<150)&(p[:,:,3]>250))>15000
assert np.count_nonzero((p[:,:,1]>140)&(p[:,:,0]<120)&(p[:,:,3]>250))>15000
assert np.count_nonzero((p[:,:,2]>180)&(p[:,:,1]<135)&(p[:,:,3]>250))>10000
`,png],{stdio:'inherit'});
  const finalLayers=structuredClone(layers(doc));
  await page.reload();
  await select('logo').waitFor();
  assert.deepEqual(layers(await api(route)),finalLayers);
  await select('logo').click();
  await editor.getByRole('checkbox',{name:'吸附参考线'}).uncheck();
  const strip=layer('strip');
  const start=imagePlacement(strip,doc.paint.assets).toCanvas([.5,.9]);
  assert.deepEqual(await pick(...start,512),{hit:'strip'});
  await drag(start,[start[0]-.06,start[1]+.12]);
  await waitRevision('拖动未选中的装饰条');
  await row('strip').locator('xpath=self::*[@data-active]').waitFor({timeout:6000}).catch(async error=>{
    console.log('drag pick diagnostics',JSON.stringify({strip,after:layer('strip'),probes:probes.slice(-8)}));
    throw error;
  });
  assert.ok(Math.abs(layer('strip').x-strip.x+.06)<.003);
  assert.equal(layer('logo').x,finalLayers.find(item=>item.id==='logo').x);
  doc=await api(paint+'/undo',{revision:doc.revision});
  assert.deepEqual(layers(doc),finalLayers);
  for(let step=0;step<4;step++)doc=await api(paint+'/undo',{revision:doc.revision});
  assert.deepEqual(layers(doc),original);
  doc=await api(paint+'/redo',{revision:doc.revision});
  assert.deepEqual(layers(doc),layers(moved));
  await page.reload();
  await select('logo').click();
  const stage=editor.locator('.document-image-stage');
  const warpOptions=editor.locator('.document-warp-options');
  const handle=index=>stage.locator('[data-warp-handle="'+index+'"]');
  async function editWarp(label){
    if(!await warpOptions.isVisible())await editor.getByRole('button',{name:'图层变形',exact:true}).click();
    const start=warpOptions.getByRole('button',{name:'编辑变形',exact:true});
    if(await start.isVisible())await start.click();
    await warpOptions.getByRole('button',{name:'变形方式',exact:true}).click();
    await page.getByRole('option',{name:label,exact:true}).click();
  }
  async function controlDrag(index,x,y){
    const box=await handle(index).boundingBox();
    const a=box.x+box.width/2,b=box.y+box.height/2;
    await page.mouse.move(a,b);await page.mouse.down();
    await page.mouse.move(a+x,b+y,{steps:8});await page.mouse.up();
  }
  async function saveWarp(){
    await stage.focus();
    await page.keyboard.press('Enter');
    await waitRevision('确认图层变形');
  }
  async function exportWarp(name){
    const response=await fetch(origin+paint+'/image-export',{method:'POST',headers,
      body:JSON.stringify({revision:doc.revision,documentId:'layout'})});
    assert.ok(response.ok,response.ok?'':await response.text());
    const output=path.join(data,name+'.png');
    await fs.writeFile(output,Buffer.from(await response.arrayBuffer()));
    return output;
  }
  await editWarp('斜切');
  await controlDrag(0,21,0);
  await saveWarp();
  const skew=layer('logo').warp;
  assert.equal(skew.mode,'skew');
  assert.ok(skew.points[0][0]>.1);
  assert.ok(Math.abs(skew.points[1][0]-1-skew.points[0][0])<1e-8);
  await editWarp('四角扭曲');
  await controlDrag(1,10,17);
  await stage.focus();
  await page.keyboard.press('Escape');
  assert.deepEqual(layer('logo',await api(route)).warp,skew);
  await editWarp('透视');
  await controlDrag(0,13,0);
  await saveWarp();
  const perspective=layer('logo').warp;
  assert.equal(perspective.mode,'perspective');
  assert.ok(perspective.points[0][0]>skew.points[0][0]);
  assert.ok(Math.abs(perspective.points[0][0]+perspective.points[1][0]-skew.points[0][0]-skew.points[1][0])<1e-8);
  const perspectiveFile=await exportWarp('perspective');
  await editWarp('四角扭曲');
  await controlDrag(1,11,17);
  await saveWarp();
  const distorted=layer('logo').warp;
  assert.equal(distorted.mode,'distort');
  assert.ok(distorted.points[1][1]>.08);
  for(const i of [0,2,3])assert.deepEqual(distorted.points[i],perspective.points[i]);
  await editWarp('网格变形');
  await handle(4).waitFor();
  await controlDrag(4,19,13);
  await saveWarp();
  const mesh=layer('logo').warp;
  assert.equal(mesh.mode,'mesh');assert.equal(mesh.points.length,9);
  const meshFile=await exportWarp('mesh');
  const marker=([u,v])=>[(layer('logo').x+(u-.5)*layer('logo').scale)*4096,
    (layer('logo').y+(v-.5)*layer('logo').scale*100/120)*4096];
  execFileSync(pythonExecutable(),['-B','-c',`
import numpy as np,sys
from PIL import Image
def marker(file):
    p=np.asarray(Image.open(file))
    assert p.shape==(4096,4096,4)
    blue=(p[:,:,0]<60)&(p[:,:,1]>75)&(p[:,:,1]<110)&(p[:,:,2]>220)&(p[:,:,3]==255)
    y,x=np.where(blue)
    assert len(x)>300
    return blue,np.array([x.mean(),y.mean()])
(first,a),(second,b)=map(marker,sys.argv[1:3])
assert np.linalg.norm(a-b)>35,(a,b)
x,y=map(lambda v: int(float(v)),sys.argv[3:])
assert second[y-2:y+3,x-2:x+3].all() and not first[y,x],(x,y,b)
`,perspectiveFile,meshFile,...marker(mesh.points[4]).map(String)],{stdio:'inherit'});
  await api(paint+'/commands',{revision:doc.revision,operations:[op('updateLayer',{layerId:'logo',
    patch:{warp:{mode:'distort',points:[[0,0],[1,1],[1,0],[0,1]]}}})]},400);
  assert.equal((await api(route)).revision,doc.revision);
  await stage.focus();await page.keyboard.press(modifier+'+z');
  await waitRevision('撤销网格变形');assert.deepEqual(layer('logo').warp,distorted);
  await stage.focus();await page.keyboard.press(modifier+'+Shift+z');
  await waitRevision('重做网格变形');assert.deepEqual(layer('logo').warp,mesh);
  await page.reload();await select('logo').click();
  await editWarp('网格变形');
  assert.deepEqual(layer('logo',await api(route)).warp,mesh);
  await page.screenshot({path:path.join(data,'mesh-workspace.png')});
  await stage.focus();await page.keyboard.press('Escape');
  await select('strip').click();
  await editWarp('四角扭曲');
  await controlDrag(1,9,12);
  await saveWarp();
  assert.equal(layer('strip').warp.mode,'distort');
  assert.deepEqual(layer('strip').shape,shape);
  assert.equal(layer('logo').asset,layer('logo',moved).asset);
  assert.equal(layer(text.layerId).text.content,'A-12');
  await select('logo').click();
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await drag([.25,.22],[.36,.44]);
  await panel.getByRole('button',{name:'添加蒙版',exact:true}).click();
  await waitRevision('从选区创建蒙版');
  const properties=page.locator('.editor-area[data-editor=imageProperties]').first();
  await panel.getByRole('button',{name:'选择蒙版 橙色标志.png',exact:true}).click();
  async function setMaskValue(label,value){
    const control=properties.locator('input[aria-label="'+label+'"]').locator('..');
    await control.dblclick();
    const entry=control.getByRole('spinbutton',{name:'输入数值'});
    await entry.fill(String(value));await entry.press('Enter');
    await waitRevision('保存蒙版'+label);
  }
  await setMaskValue('密度',50);
  await setMaskValue('羽化',96);
  assert.equal(layer('logo').maskDensity,.5);
  assert.equal(layer('logo').maskFeather,96);
  async function readMask(size,operation){
    const request=await fetch(origin+paint+'/image-live',{method:'POST',headers,body:JSON.stringify({
      revision:doc.revision,documentId:'layout',inspectMask:'logo',resolution:size,operation
    })});
    assert.equal(request.status,200,request.ok?'':await request.text());
    const values=new Uint8Array(await request.arrayBuffer());
    return (x,y)=>values[(Math.floor(y*size)*size+Math.floor(x*size))*4];
  }
  for(const size of [512,4096]){
    const mask=await readMask(size);
    assert.equal(mask(.12,.32),128);
    assert.ok(mask(.30,.32)>=252);
    assert.ok(mask(.241,.32)>142&&mask(.241,.32)<188);
    assert.ok(mask(.259,.32)>190&&mask(.259,.32)<239);
  }
  const draftMask=await readMask(512,op('updateLayer',{layerId:'logo',patch:{maskDensity:1}}));
  assert.equal(draftMask(.12,.32),0);
  assert.equal((await api(route)).revision,doc.revision);
  const maskedFile=await exportWarp('masked-mesh');
  const effectiveMask=await readMask(4096);
  const probeX=.36,probeY=.34;
  execFileSync(pythonExecutable(),['-B','-c',`
from PIL import Image
import numpy as np
import sys
x,y,expected=map(int,sys.argv[3:])
with Image.open(sys.argv[1]) as before, Image.open(sys.argv[2]) as after:
    raw,masked=before.getpixel((x,y)),after.getpixel((x,y))
    assert raw[3]==255 and raw[0]>210,raw
    assert masked[:3]==raw[:3] and abs(masked[3]-expected)<=1,(masked,raw,expected)
    assert 150<masked[3]<240,masked
    def green(p):
        return p[1]>190 and p[0]<100 and p[3]==255
    # A warped shape moves real pixels, while it remains editable as a shape.
    a,b=(np.asarray(image.resize((256,256))).reshape(-1,4) for image in (before,after))
    assert any(green(p)!=green(q) for p,q in zip(a,b))
`,meshFile,maskedFile,String(Math.floor(probeX*4096)),String(Math.floor(probeY*4096)),String(effectiveMask(probeX,probeY))],{stdio:'inherit'});
  doc=await api(paint+'/undo',{revision:doc.revision});
  assert.equal(layer('logo').maskFeather,undefined);
  assert.equal((await readMask(512))(.241,.32),128);
  doc=await api(paint+'/redo',{revision:doc.revision});
  await page.reload();await select('logo').waitFor();
  assert.equal(layer('logo',await api(route)).maskFeather,96);
  assert.ok((await readMask(512))(.241,.32)>142);
  const openSelections=()=>editor.locator('.document-selection-library>summary',{hasText:'已存选区'}).click();
  const savedSelections=editor.getByRole('dialog',{name:'已存选区',exact:true});
  async function saveSelection(name){
    await openSelections();
    await savedSelections.getByRole('textbox',{name:'选区名称'}).fill(name);
    await savedSelections.getByRole('button',{name:'保存',exact:true}).click();
    await waitRevision('保存选区 '+name);
    await savedSelections.getByRole('button',{name:'载入选区 '+name,exact:true}).waitFor();
    await savedSelections.getByRole('textbox',{name:'选区名称'}).press('Escape');
  }
  await select('logo').click();
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await drag([.25,.22],[.36,.44]);
  await saveSelection('机身标志');
  await drag([.63,.38],[.74,.54]);
  await editor.getByRole('button',{name:'变换选区边界',exact:true}).click();
  const beforeBoundary=await api(route);
  const boundary=editor.locator('input[data-transform-field="angle"]').locator('..');
  await boundary.dblclick();
  const boundaryAngle=boundary.getByRole('spinbutton',{name:'输入数值'});
  await boundaryAngle.fill('90');await boundaryAngle.press('Enter');
  await stage.focus();await page.keyboard.press('Enter');
  assert.equal((await api(route)).revision,beforeBoundary.revision);
  await saveSelection('编号留白');
  const regions=structuredClone(doc.paint.imageDocuments.layout.selections);
  assert.deepEqual(regions.map(region=>region.name),['机身标志','编号留白']);
  assert.ok(Math.abs(regions[1].rect[2]-regions[1].rect[0]-.16)<.004);
  assert.ok(Math.abs(regions[1].rect[3]-regions[1].rect[1]-.11)<.004);
  await page.reload();await select('logo').click();
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await openSelections();
  await savedSelections.getByRole('button',{name:'载入选区 机身标志',exact:true}).click();
  await stage.locator('.area-selection-overlay').waitFor();
  await openSelections();
  await savedSelections.getByRole('button',{name:'载入选区 机身标志',exact:true}).waitFor();
  await page.screenshot({path:path.join(data,'saved-selections-workspace.png')});
  await savedSelections.getByRole('textbox',{name:'选区名称'}).press('Escape');
  await select('strip').click();
  await panel.getByRole('button',{name:'添加蒙版',exact:true}).click();
  await waitRevision('重开后复用命名选区');
  assert.deepEqual(layer('strip').maskStrokes[0].rect,regions[0].rect);
  await editor.getByRole('button',{name:'矩形选区',exact:true}).click();
  await openSelections();
  await savedSelections.getByRole('button',{name:'删除选区 编号留白',exact:true}).click();
  await waitRevision('删除命名选区');
  assert.deepEqual(doc.paint.imageDocuments.layout.selections,[regions[0]]);
  doc=await api(paint+'/undo',{revision:doc.revision});
  assert.deepEqual(doc.paint.imageDocuments.layout.selections,regions);

  // Move a masked feature with the logo, then paint on the resulting canvas.
  await commands(...layers(doc).filter(item=>item.id!=='logo'&&item.visible)
    .map(item=>op('updateLayer',{layerId:item.id,patch:{visible:false}})),
    op('removeMask',{layerId:'logo'}),
    op('updateLayer',{layerId:'logo',patch:{x:.5,y:.5,scale:.6,rotation:0,stretch:[1,1],warp:null}}),
    op('stroke',{layerId:'logo',target:'mask',stroke:{uv:true,rect:[.47,.47,.53,.53],opacity:1,value:0}}));
  await page.reload();await select('logo').click();
  await editWarp('网格变形');
  await controlDrag(4,53,25);
  await saveWarp();
  const warpedLogo=structuredClone(layer('logo'));
  const at=imagePlacement(warpedLogo,doc.paint.assets).toCanvas(warpedLogo.warp.points[4]);
  const draft=await readMask(512);
  assert.equal(draft(...at),0);
  assert.equal(draft(.5,.5),255);
  const pixels=await sampleArtwork([at,[.5,.5]]);
  assert.equal(pixels[0][3],0);
  assert.equal(pixels[1][3],255);
  await panel.getByRole('button',{name:'选择蒙版 橙色标志.png',exact:true}).click();
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await editor.getByLabel('图像前景色',{exact:true}).fill('#ffffff');
  await drag([at[0]-.004,at[1]],[at[0]+.004,at[1]]);
  await waitRevision('在变形后的蒙版上补画');
  assert.equal((await readMask(512))(...at),255);
  const nearby=imagePlacement(warpedLogo,doc.paint.assets).toCanvas([warpedLogo.warp.points[4][0]-.035,warpedLogo.warp.points[4][1]]);
  assert.equal((await readMask(512))(...nearby),0);
  await stage.focus();await page.keyboard.press(modifier+'+z');
  await waitRevision('撤销变形后补画');
  assert.equal((await readMask(512))(...at),0);
  await stage.focus();await page.keyboard.press(modifier+'+Shift+z');
  await waitRevision('重做变形后补画');
  assert.equal((await readMask(512))(...at),255);
  await page.reload();
  await panel.getByRole('button',{name:'选择蒙版 橙色标志.png',exact:true}).click();
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:90000});
  await page.screenshot({path:path.join(data,'linked-warp-mask-workspace.png')});
  await row('logo').getByRole('button',{name:'解除蒙版链接',exact:true}).click();
  await waitRevision('解除蒙版链接');
  const translated={...warpedLogo.warp,points:warpedLogo.warp.points.map(([x,y])=>[x-.18,y+.03])};
  await commands(op('updateLayer',{layerId:'logo',patch:{warp:translated}}));
  assert.equal((await readMask(512))(...nearby),0);
  doc=await api(paint+'/undo',{revision:doc.revision});
  assert.deepEqual(layer('logo').warp,warpedLogo.warp);
  doc=await api(paint+'/redo',{revision:doc.revision});
  assert.deepEqual(layer('logo').warp,translated);
  await page.reload();await select('logo').waitFor();
  assert.equal((await readMask(4096))(...nearby),0);
  await commands(
    add('pick-ground','点选底板','pixel'),
    op('stroke',{layerId:'pick-ground',target:'pixels',stroke:{uv:true,rect:[.12,.1,.84,.24],opacity:1,color:'#535c68',erase:false}}),
    add('pick-group','点选组','group',{opacity:.25}),
    add('pick-foreground','组外前景','pixel'),
    op('stroke',{layerId:'pick-foreground',target:'pixels',stroke:{uv:true,rect:[.12,.1,.30,.24],opacity:1,color:'#ff6830',erase:false}}),
    add('pick-base','组内底层','pixel',{},'pick-group'),
    op('stroke',{layerId:'pick-base',target:'pixels',stroke:{uv:true,rect:[.12,.1,.69,.24],opacity:1,color:'#0aafb8',erase:false}}),
    add('pick-child','组内剪贴标志','pixel',{clipped:true,opacity:.01},'pick-group'),
    op('stroke',{layerId:'pick-child',target:'pixels',stroke:{uv:true,rect:[.12,.1,.84,.24],opacity:1,color:'#f5d51d',erase:false}}));
  assert.deepEqual(await pick(.20,.17),{hit:'pick-foreground'});
  assert.deepEqual(await pick(.50,.17),{hit:'pick-base'});
  assert.deepEqual(await pick(.76,.17),{hit:'pick-ground'});
  const scenePixels=await sampleArtwork([[.20,.17],[.76,.17]]);
  assert.deepEqual(scenePixels,[[255,104,48,255],[83,92,104,255]]);
  await page.reload();
  // The preceding mask edit survives reload. Select pixel content before
  // testing layer picks, since Move on a mask has its own interaction.
  await select('pick-ground').click();
  await row('pick-ground').locator('xpath=self::*[@data-active]').waitFor();
  await editor.getByRole('button',{name:'移动图层',exact:true}).click();
  const viewClick=async(x,y)=>{
    const rect=await canvas.boundingBox();
    const hit=page.waitForResponse(response=>response.url().endsWith('/image-layout-probe')&&
      response.request().postDataJSON()?.point?.every((value,index)=>Math.abs(value-[x,y][index])<.005));
    await page.mouse.click(rect.x+x*rect.width,rect.y+y*rect.height);
    const response=await hit;
    assert.equal(response.status(),200);
    return (await response.json()).hit;
  };
  assert.equal(await viewClick(.20,.17),'pick-foreground');
  await row('pick-foreground').locator('xpath=self::*[@data-active]').waitFor();
  await row('pick-group').getByRole('button',{name:'收起 点选组',exact:true}).click();
  await row('pick-base').waitFor({state:'hidden'});
  await page.keyboard.down('Shift');
  try{assert.equal(await viewClick(.50,.17),'pick-base');}finally{await page.keyboard.up('Shift');}
  await row('pick-base').locator('xpath=self::*[@data-active][@data-selected]').waitFor();
  assert.equal(await row('pick-foreground').getAttribute('data-selected'),'');
  assert.equal(await row('pick-group').getByRole('button',{name:'收起 点选组',exact:true}).getAttribute('aria-expanded'),'true');
  assert.equal((await api(route)).revision,doc.revision);
  await page.screenshot({path:path.join(data,'layer-pick-compositing-order.png')});
  await row('pick-group').getByRole('button',{name:'收起 点选组',exact:true}).click();
  await row('pick-base').waitFor({state:'hidden'});
  assert.equal(await row('pick-base').getAttribute('data-active'),'');

  await commands(...layers(doc).filter(item=>item.visible)
    .map(item=>op('updateLayer',{layerId:item.id,patch:{visible:false}})),
    add('tone-base','底图明暗','pixel'),
    op('stroke',{layerId:'tone-base',target:'pixels',stroke:{uv:true,rect:[.25,.30,.5,.70],opacity:1,color:'#202020',erase:false}}),
    op('stroke',{layerId:'tone-base',target:'pixels',stroke:{uv:true,rect:[.5,.30,.75,.70],opacity:1,color:'#e0e0e0',erase:false}}),
    add('tone-ink','明暗混合标识','pixel',{blendIf:{source:[0,0,255,255],backdrop:[130,130,255,255]}}),
    op('stroke',{layerId:'tone-ink',target:'pixels',stroke:{uv:true,rect:[.35,.40,.65,.60],opacity:1,color:'#fa7835',erase:false}}),
    add('detail-line','细分割线','pixel'),
    op('stroke',{layerId:'detail-line',target:'pixels',stroke:{uv:true,rect:[.499,.43,.501,.57],opacity:1,color:'#28c5ff',erase:false}}));
  assert.deepEqual(await sampleArtwork([[.4,.5],[.6,.5]]),[[32,32,32,255],[250,120,53,255]]);
  assert.deepEqual(await pick(.4,.5),{hit:'tone-base'});
  assert.deepEqual(await pick(.6,.5),{hit:'tone-ink'});
  assert.deepEqual(await pick(.5,.5,1024),{hit:'detail-line'});
  const detail=await api(paint+'/image-layout-probe',{revision:doc.revision,documentId:'layout',layerIds:['detail-line']});
  assert.ok(detail.bounds['detail-line'][0]<.5&&detail.bounds['detail-line'][2]>.5);
  await page.reload();await select('tone-base').click();
  await editor.getByRole('button',{name:'移动图层',exact:true}).click();
  await editor.getByRole('button',{name:'实际像素',exact:true}).click();
  const center=await canvas.boundingBox();
  const closePick=page.waitForResponse(response=>response.url().endsWith('/image-layout-probe')&&
    response.request().postDataJSON()?.point);
  await page.mouse.click(center.x+center.width/2,center.y+center.height/2);
  const closeResponse=await closePick;
  assert.equal(closeResponse.request().postDataJSON().resolution,1024);
  assert.deepEqual(await closeResponse.json(),{hit:'detail-line'});
  await row('detail-line').locator('xpath=self::*[@data-active]').waitFor();
  await canvas.focus();await page.keyboard.press('ArrowRight');
  await waitRevision('微移点中的细线');
  assert.equal(layer('detail-line').strokes.at(-1).transformUV.offset[0],1/4096);
  await canvas.focus();await page.keyboard.press(modifier+'+z');
  await waitRevision('撤销细线微移');
  assert.equal(layer('detail-line').strokes.length,1);
  await stage.locator('xpath=self::*[@data-preview-size="4096"][@data-preview-revision="'+doc.revision+'"]').waitFor({timeout:90000});
  await page.screenshot({path:path.join(data,'layout-fine-line-pick.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS joint layout, four editable warps, linked and independent masks, named selections, pixels, undo and reopen:',data);
}
try{await run();}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
  }
}
