import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {FloatType} from 'three';
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js';
import {pythonExecutable} from '../python-runtime.mjs';
import {nativeDemoProjectId} from '../demo-source.mjs';
import {nativeModelSteps} from '../model-binding.mjs';
import {captureRenderPreset,updateDeliveryOptions} from '../public/paint-delivery-options.mjs';
import {renderOpticsDefaults} from '../public/render-optics.mjs';
import {renderLightingDefaults} from '../public/render-lighting.mjs';

const root=path.resolve(import.meta.dirname,'..');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-glb-import-'));
const fixture=path.join(data,'uncached-model.glb');
const marker=path.join(data,'blender-invoked'),probe=path.join(data,'blender-probe');
const digest=value=>createHash('sha256').update(value).digest('hex');
if(process.platform!=='win32')
  await fs.writeFile(probe,'#!/bin/sh\ntouch "$(dirname "$0")/blender-invoked"\nexit 42\n',{mode:0o700});

function sampleModel(coverUv=true,coverHeight=.3){
  const parts=[
    new Float32Array([-1,0,-1,-1,0,1,1,0,1,1,0,-1]),
    new Float32Array([0,0,0,1,1,1,1,0]),
    new Uint16Array([0,1,2,0,2,3])
  ];
  const bins=parts.map(value=>Buffer.from(value.buffer));
  const binary=Buffer.concat(bins);
  const gltf={
    asset:{version:'2.0'},scene:0,scenes:[{nodes:[0,2]}],
    nodes:[{name:'涂装面',mesh:0},{name:'遮挡面',mesh:1,translation:[.25,coverHeight,0],scale:[.34,1,.42]},
      {name:'缩放组',scale:[1.2,1,.85],children:[1]}],
    meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},indices:2,material:0}]},
      {primitives:[{attributes:{POSITION:0,...(coverUv?{TEXCOORD_0:1}:{})},indices:2,material:1}]}],
    materials:[{name:'表面材料',doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.03,.2,.36,1],metallicFactor:.1,roughnessFactor:.6}},
      {name:'遮挡材料',doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.6,.22,.05,1],metallicFactor:0,roughnessFactor:.7}}],
    buffers:[{byteLength:binary.length}],
    bufferViews:bins.map((buffer,i)=>({buffer:0,byteOffset:bins.slice(0,i).reduce((size,part)=>size+part.length,0),byteLength:buffer.length})),
    accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[-1,0,-1],max:[1,0,1]},
      {bufferView:1,componentType:5126,count:4,type:'VEC2'},{bufferView:2,componentType:5123,count:6,type:'SCALAR'}]
  };
  return {bytes:glbBytes(gltf,binary),binary,gltf};
}

function glbBytes(gltf,binary){
  const json=Buffer.from(JSON.stringify(gltf));
  const metadata=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const header=Buffer.alloc(20),chunk=Buffer.alloc(8);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+metadata.length+binary.length,8);
  header.writeUInt32LE(metadata.length,12);header.write('JSON',16);
  chunk.writeUInt32LE(binary.length);chunk.write('BIN',4);
  return Buffer.concat([header,metadata,chunk,binary]);
}

async function until(read,timeout=120000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const value=await read();
    if(value)return value;
    await delay(200);
  }
  throw Error('验收等待超时');
}

const model=sampleModel();
await fs.writeFile(fixture,model.bytes);
const services=[];
let logs='',browser;
async function start(folder){
  const socket=net.createServer().listen(0,'127.0.0.1');
  await once(socket,'listening');
  const {port}=socket.address();
  await new Promise(resolve=>socket.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const env={...process.env,ARACHNE_DATA_DIR:folder,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:probe};
  const service=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:root,env});
  services.push(service);
  for(const stream of [service.stdout,service.stderr])stream.on('data',bytes=>{logs+=bytes;});
  await until(()=>fetch(origin+'/api/health').then(r=>r.ok,()=>false));
  return origin;
}
let origin;
async function api(route,body,server=origin){
  const r=await fetch(server+route,body===undefined?{}:{method:'POST',headers:{Origin:server,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const json=await r.json();
  assert.ok(r.ok,JSON.stringify(json));
  return json;
}
async function verifyModelUpdate(){
  const headers={Origin:origin,'Content-Type':'model/gltf-binary'};
  const create=await fetch(origin+'/api/projects/model-import?material=1',{method:'POST',headers,body:model.bytes});
  const doc=await create.json();
  assert.equal(create.status,201,JSON.stringify(doc));
  const path='/api/projects/'+doc.id+'/paint';
  const painted=await api(path+'/commands',{revision:doc.revision,operations:[
    {op:'add',kind:'fill',patch:{name:'蒙版返工',maskEnabled:true,maskBase:.6}}
  ]});
  const update=(revision,body)=>fetch(origin+path+'/update-glb?revision='+revision,{method:'POST',headers,body});
  const firstUpdate=await update(painted.revision,sampleModel(true,.26).bytes);
  assert.equal(firstUpdate.status,200);
  const plain=await firstUpdate.json();
  assert.equal(plain.modeling,undefined);
  assert.deepEqual(plain.paint,painted.paint);
  const restored=await api(path+'/undo',{revision:plain.revision});
  assert.deepEqual(restored.source,doc.source);
  const oldManifest=await api('/api/projects/'+doc.id+'/viewport');
  const topology=await api((await api('/api/projects/'+doc.id+'/viewport/topology',{})).url);
  const steps=[
    {matrix:[1,0,0,0,0,.75,0,0,0,0,.75,0,0,0,0,1],targets:[{id:1}]},
    {type:'vertexPositions',targets:[{mesh:0,vertices:[0],positions:[-1,.125,-1]}]}
  ];
  const glb=await fs.readFile(doc.source.reviewSource);
  const registered=JSON.parse(glb.toString('utf8',20,20+glb.readUInt32LE(12)));
  const modeled=await api(path+'/model',{revision:restored.revision,modeling:{
    version:2,binding:oldManifest.key,modelSha256:oldManifest.modelSha256,
    steps,nativeSteps:nativeModelSteps(registered,steps,topology)
  }});
  const authored=await api(path+'/commands',{revision:modeled.revision,operations:[
    {op:'update',id:painted.paint.layers[0].id,patch:{maskBase:0,values:{...painted.paint.base,color:'#dec04a'}}},
    {op:'stroke',target:'mask',id:painted.paint.layers[0].id,stroke:{
      radius:.12,opacity:1,hardness:.9,value:1,stamps:[[.30,0,.225,0,0,1]]
    }}
  ]});
  const mark=authored.paint.layers[0].maskStrokes[0];
  assert.deepEqual(authored.paint.surfaceBindings[mark.surfaceBinding],modeled.modeling);
  async function projectedPixels(doc){
    const job=await api(path+'/preview',{revision:doc.revision,requestId:'surface-'+doc.revision});
    const bake=await until(async()=>{
      const result=await api('/api/projects/'+doc.id+'/jobs/'+job.id);
      if(result.status==='failed')throw Error(result.error);
      return result.status==='completed'&&result;
    });
    const pixels=Buffer.from(await (await fetch(origin+bake.colorUrl)).arrayBuffer());
    await fs.writeFile(pathToBake,pixels);
    const sample=JSON.parse(execFileSync(pythonExecutable(),['-c',
      "from PIL import Image;import json,sys;im=Image.open(sys.argv[1]);print(json.dumps([im.getpixel((2048,2048)),im.getpixel((320,320))]))",pathToBake],{encoding:'utf8'}));
    assert.notDeepEqual(sample[0],sample[1]);
    return digest(pixels);
  }
  const pathToBake=fixture+'.png';
  const beforePixels=await projectedPixels(authored);
  const revised=sampleModel(true,.16).bytes;
  const conflict=Buffer.from(revised);
  conflict.writeFloatLE(.5,conflict.length-model.binary.length+4);
  const blocked=await update(authored.revision,conflict);
  assert.equal(blocked.status,400);
  assert.match((await blocked.json()).error,/同一组顶点/);
  assert.equal((await api('/api/projects/'+doc.id)).revision,authored.revision);
  const reject=await update(authored.revision,sampleModel(false).bytes);
  assert.equal(reject.status,400);
  assert.match((await reject.json()).error,/UV/);
  const response=await update(authored.revision,revised);
  assert.equal(response.status,200);
  const edited=await response.json();
  assert.equal(await projectedPixels(edited),beforePixels);
  assert.equal(edited.revision,authored.revision+1);
  assert.equal(edited.source.material,doc.source.material);
  assert.equal(edited.source.uvSha256,doc.source.uvSha256);
  assert.deepEqual(edited.paint,authored.paint);
  const manifest=await api('/api/projects/'+doc.id+'/viewport');
  assert.deepEqual(edited.modeling,{...authored.modeling,binding:manifest.key,modelSha256:manifest.modelSha256});
  assert.notEqual(edited.source.reviewSource,doc.source.reviewSource);
  assert.equal((await fetch(origin+oldManifest.modelUrl)).status,409);
  assert.equal((await update(authored.revision,revised)).status,409);
  const same=await update(edited.revision,revised);
  assert.match((await same.json()).error,/相同/);
  const undo=await api(path+'/undo',{revision:edited.revision});
  assert.deepEqual(undo.modeling,authored.modeling);
  assert.deepEqual(undo.source,doc.source);
  assert.deepEqual(undo.paint,authored.paint);
  const redo=await api(path+'/redo',{revision:undo.revision});
  assert.deepEqual(redo.modeling,edited.modeling);
  assert.deepEqual(redo.source,edited.source);
  console.log('PASS GLB revision update, modeling replay, conflicting absolute vertices, rejected UV change, stale revision and undo/redo');
}

async function verifyProceduralMasks(cubeId){
  const wearRoute='/api/projects/'+cubeId,wearPaint=wearRoute+'/paint';
  const wearSeed=await api(wearPaint+'/commands',{revision:0,operations:[
    {op:'base',patch:{color:'#182537',metallic:.05,roughness:.65}},
    {op:'add',kind:'fill',patch:{name:'金属磨边',maskEnabled:true,maskBase:1,
      channels:{color:true,metallic:true,roughness:true},values:{color:'#e5bd70',metallic:.85,roughness:.26}}}
  ]});
  const wearLayer=wearSeed.paint.layers[0],wearPage=await browser.newPage({viewport:{width:1400,height:900}});
  await wearPage.goto(origin+'/?project='+cubeId);
  await wearPage.locator('[data-area-mode=material]').click();
  await wearPage.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  await wearPage.getByRole('button',{name:'绘制蒙版 · 金属磨边',exact:true}).click();
  const effects=wearPage.getByRole('button',{name:'添加效果',exact:true});
  await effects.click();
  await wearPage.getByRole('option',{name:'边缘磨损',exact:true}).click();
  await until(async()=>(await api(wearRoute)).paint.layers[0].maskEffects?.[0]?.kind==='edgeWear');
  const width=wearPage.getByRole('spinbutton',{name:'磨损宽度 (%)',exact:true});
  const liveWidth=wearPage.waitForResponse(response=>
    response.url().endsWith('/paint/live')&&response.request().postDataJSON()?.operation?.patch?.maskEffects?.[0]?.width===6);
  await width.fill('6');
  assert.equal((await liveWidth).status(),200);
  await width.press('Tab');
  const edgeMask=await until(async()=>{
    const current=await api(wearRoute);
    return current.paint.layers[0].maskEffects?.[0]?.width===6&&current;
  });
  const wearJob=await api(wearPaint+'/preview',{revision:edgeMask.revision,requestId:'crease-mask'});
  const wearBake=await until(async()=>{
    const job=await api(wearRoute+'/jobs/'+wearJob.id);
    if(job.status==='failed')throw Error(job.error);
    return job.status==='completed'&&job;
  });
  assert.equal(wearBake.paintReport.uv_unchanged,true);
  assert.equal(wearBake.paintReport.protectedTexelsWritten,0);
  const wearImage=path.join(data,'edge-wear-4k.png');
  await fs.writeFile(wearImage,Buffer.from(await (await fetch(origin+wearBake.colorUrl)).arrayBuffer()));
  const wearPixels=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import json,sys',
    'from PIL import Image',
    'im=Image.open(sys.argv[1]); print(json.dumps([im.size,[im.getpixel((int(x*4096),int(y*4096))) for x,y in ((.024,.25),(.166,.25),(.01,.25))]]))'
  ].join('\n'),wearImage],{encoding:'utf8'}));
  assert.deepEqual(wearPixels,[[4096,4096],[[229,189,112],[24,37,55],[24,37,55]]]);
  await effects.click();
  await wearPage.getByRole('option',{name:'表面噪声',exact:true}).click();
  const noiseMask=await until(async()=>{
    const current=await api(wearRoute);
    return current.paint.layers[0].maskEffects?.length===2&&current;
  });
  const invalidNoise=await fetch(origin+wearPaint+'/commands',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({revision:noiseMask.revision,operations:[{op:'update',id:wearLayer.id,patch:{
      maskEffects:[noiseMask.paint.layers[0].maskEffects[0],{...noiseMask.paint.layers[0].maskEffects[1],seed:.5}]
    }}]})
  });
  assert.equal(invalidNoise.status,400);
  await wearPage.getByRole('button',{name:'表面噪声合成',exact:true}).click();
  await wearPage.getByRole('option',{name:'相减',exact:true}).click();
  const subtractMask=await until(async()=>{
    const current=await api(wearRoute);
    return current.paint.layers[0].maskEffects[1].blend==='subtract'&&current;
  });
  await wearPage.getByRole('button',{name:'表面噪声合成',exact:true}).filter({hasText:'相减'}).waitFor();
  await until(async()=>await wearPage.locator('#project-save-state').textContent()==='已保存',12000);
  const noiseOpacity=wearPage.getByRole('spinbutton',{name:'表面噪声强度',exact:true});
  await noiseOpacity.fill('0.5');await noiseOpacity.press('Tab');
  const mixedMask=await until(async()=>{
    const current=await api(wearRoute);
    return current.paint.layers[0].maskEffects[1].opacity===.5&&current;
  });
  assert.equal(mixedMask.revision,subtractMask.revision+1);
  await wearPage.getByRole('button',{name:'参数 · 表面噪声',exact:true}).click();
  await noiseOpacity.waitFor({state:'hidden'});
  assert.equal((await api(wearRoute)).revision,mixedMask.revision);
  await wearPage.getByRole('button',{name:'复制表面噪声',exact:true}).click();
  const copiedEffect=await until(async()=>{
    const current=await api(wearRoute);
    return current.paint.layers[0].maskEffects.length===3&&current;
  });
  const [edge,noise,copy]=copiedEffect.paint.layers[0].maskEffects;
  assert.notEqual(noise.id,copy.id);
  assert.deepEqual({...copy,id:noise.id},noise);
  const properties=wearPage.locator('.editor-area[data-editor=properties]').first();
  const copiedRow=properties.locator('[data-effect-id="'+copy.id+'"]');
  await copiedRow.getByRole('checkbox',{name:'启用表面噪声',exact:true}).uncheck();
  await until(async()=>!(await api(wearRoute)).paint.layers[0].maskEffects[2].enabled);
  await until(async()=>await wearPage.locator('#project-save-state').textContent()==='已保存');
  const grip=copiedRow.getByRole('button',{name:'拖动排序 · 表面噪声',exact:true});
  const noiseRow=properties.locator('[data-effect-id="'+noise.id+'"] .mask-effect-row');
  const source=await grip.boundingBox(),target=await noiseRow.boundingBox(),mouse=wearPage.mouse;
  await mouse.move(source.x+source.width/2,source.y+source.height/2);await mouse.down();
  await mouse.move(source.x+source.width/2,source.y+source.height/2+10,{steps:4});
  await mouse.move(target.x+target.width*.45,target.y+target.height-4,{steps:12});
  await mouse.move(target.x+target.width*.46,target.y+target.height-4);
  await noiseRow.and(wearPage.locator('[data-effect-drop=below]')).waitFor({timeout:5000});
  await wearPage.screenshot({path:path.join(data,'material-mask-effect-order.png')});
  await mouse.up();
  const reordered=await until(async()=>{
    const current=await api(wearRoute);
    return current.paint.layers[0].maskEffects[1].id===copy.id&&current;
  });
  assert.deepEqual(reordered.paint.layers[0].maskEffects.map(effect=>effect.id),[edge.id,copy.id,noise.id]);
  await wearPage.getByRole('button',{name:'手绘修正',exact:true}).click();
  await wearPage.getByRole('option',{name:'在效果后',exact:true}).click();
  const correctionOrder=await until(async()=>{
    const current=await api(wearRoute);
    return current.paint.layers[0].maskStrokeOrder==='after'&&current;
  });
  await wearPage.getByRole('button',{name:'手绘修正',exact:true}).filter({hasText:'在效果后'}).waitFor();
  await until(async()=>await wearPage.locator('#project-save-state').textContent()==='已保存');
  const maskFrame=async current=>{
    const response=await fetch(origin+wearPaint+'/live',{method:'POST',
      headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({revision:current.revision,inspectMask:wearLayer.id,resolution:256,format:'pbr8'})});
    assert.equal(response.status,200);
    return new Uint8Array(await response.arrayBuffer());
  };
  const initialMask=await maskFrame(correctionOrder),maskSample=(192*256+6)*15;
  assert.ok(initialMask[maskSample]>0);
  const view3d=wearPage.locator('.editor-viewport[data-state=ready]').first();
  await wearPage.getByRole('button',{name:'交互模式',exact:true}).filter({hasText:'蒙版绘制'}).waitFor();
  await wearPage.getByRole('button',{name:'绘制蒙版 · 金属磨边',exact:true}).and(wearPage.locator('[aria-pressed=true]')).waitFor();
  const wearBounds=await view3d.boundingBox();
  const screenPoint=(x,y)=>[wearBounds.x+x*wearBounds.width,wearBounds.y+y*wearBounds.height];
  await wearPage.mouse.move(...screenPoint(.48,.5));await wearPage.mouse.down();
  await wearPage.mouse.move(...screenPoint(.53,.5),{steps:6});await wearPage.mouse.up();
  const handPainted=await until(async()=>{
    const current=await api(wearRoute);
    return current.paint.layers[0].maskStrokes?.length===1&&current;
  },12000).catch(async error=>{
    await wearPage.screenshot({path:path.join(data,'material-mask-stroke-failure.png')});
    throw error;
  });
  assert.ok(handPainted.paint.layers[0].maskStrokes[0].stamps.length>0);
  const corrected=await api(wearPaint+'/commands',{revision:handPainted.revision,operations:[
    {op:'stroke',id:wearLayer.id,target:'mask',stroke:{uv:true,rect:[.02,.71,.031,.79],value:0,opacity:1}}
  ]});
  assert.equal((await maskFrame(corrected))[maskSample],0);
  await wearPage.screenshot({path:path.join(data,'procedural-mask-workbench.png')});
  await wearPage.reload();
  assert.deepEqual((await api(wearRoute)).paint.layers,corrected.paint.layers);
  const undoCorrection=await api(wearPaint+'/undo',{revision:corrected.revision});
  assert.deepEqual(undoCorrection.paint.layers,handPainted.paint.layers);
  const redoCorrection=await api(wearPaint+'/redo',{revision:undoCorrection.revision});
  assert.deepEqual(redoCorrection.paint.layers,corrected.paint.layers);
  const correctedJob=await api(wearPaint+'/preview',{revision:redoCorrection.revision,requestId:'corrected-mixed-mask'});
  const correctedBake=await until(async()=>{
    const job=await api(wearRoute+'/jobs/'+correctedJob.id);
    if(job.status==='failed')throw Error(job.error);
    return job.status==='completed'&&job;
  });
  assert.equal(correctedBake.paintReport.uv_unchanged,true);
  assert.equal(correctedBake.paintReport.protectedTexelsWritten,0);
  const correctedFile=path.join(data,'corrected-mask-4k.png');
  await fs.writeFile(correctedFile,Buffer.from(await (await fetch(origin+correctedBake.colorUrl)).arrayBuffer()));
  const correctedPixels=JSON.parse(execFileSync(pythonExecutable(),['-B','-X','utf8','-c',
    'import json,sys;from PIL import Image;im=Image.open(sys.argv[1]);print(json.dumps([im.size,im.getpixel((98,3072))]))',
    correctedFile],{encoding:'utf8'}));
  assert.deepEqual(correctedPixels,[[4096,4096],[24,37,55]]);
  await wearPage.locator('.editor-viewport[data-state=ready]').first().waitFor();
  const mode=wearPage.locator('.editor-area[data-editor=viewport]').first().getByRole('button',{name:'交互模式',exact:true});
  const targetMask=wearPage.getByRole('button',{name:'绘制蒙版 · 金属磨边',exact:true});
  await targetMask.and(wearPage.locator('[aria-pressed=true]')).waitFor();
  await mode.filter({hasText:'蒙版绘制'}).waitFor();
  await wearPage.locator('.editor-area[data-editor=layers]').getByRole('button',{name:'金属磨边',exact:true}).click();
  await mode.filter({hasText:'查看'}).waitFor();
  assert.equal(await targetMask.getAttribute('aria-pressed'),'false');
  await mode.click();await wearPage.getByRole('option',{name:'蒙版填充',exact:true}).click();
  await mode.filter({hasText:'蒙版填充'}).waitFor();
  await targetMask.and(wearPage.locator('[aria-pressed=true]')).waitFor();
  assert.equal((await api(wearRoute)).revision,redoCorrection.revision);
  await wearPage.close();
  console.log('PASS live mesh wear, noise subtraction, effect drag order, exact 4K pixels, saved mask focus, viewport tool sync and undo/redo');

}

function prepareTexturedModel(){
  const texturedFile=path.join(data,'贴图 模型.glb'),differentUV=path.join(data,'其他 UV.glb');
  execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import sys',
    'from pathlib import Path',
    'from PIL import Image',
    'from paint_glb import read_glb, append_texture, png_bytes, write_glb',
    'scene, binary = read_glb(Path(sys.argv[1]).read_bytes())',
    'def texture(colors, name):',
    ' image = Image.new("RGBA",(2,2))',
    ' image.putdata(colors)',
    ' return append_texture(scene,binary,png_bytes(image),name)',
    'material = scene["materials"][0]',
    'pbr = material["pbrMetallicRoughness"]',
    'pbr.update(baseColorFactor=[.5,.25,1,.5],metallicFactor=.5,roughnessFactor=.25)',
    'pbr["baseColorTexture"] = texture([(255,0,0,128),(0,255,0,255),(0,0,255,255),(255,255,255,0)],"color")',
    'pbr["metallicRoughnessTexture"] = texture([(16,40,200,255),(64,160,60,255)]*2,"orm")',
    'pbr["metallicRoughnessTexture"]["extensions"] = {"KHR_texture_transform":{"offset":[.5,0]}}',
    'material.setdefault("extensions", {})["KHR_materials_transmission"] = {"transmissionFactor":.75,"transmissionTexture":{"index":1}}',
    'scene["extensionsUsed"] = ["KHR_texture_transform","KHR_materials_transmission"]',
    'scene["samplers"] = [{"magFilter":9728,"minFilter":9728}]',
    'scene["textures"][1]["sampler"] = 0',
    'material.update(alphaMode="MASK",alphaCutoff=.35,emissiveFactor=[.25,.5,1])',
    'material["normalTexture"] = {**texture([(191,128,238,255)]*4,"normal"),"scale":.5}',
    'material["occlusionTexture"] = {"index":1,"strength":.5}',
    'material["emissiveTexture"] = texture([(255,0,0,255)]*4,"emission")',
    'write_glb(sys.argv[2],scene,binary)',
    'pbr["baseColorTexture"]["texCoord"] = 1',
    'scene["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_1"] = 1',
    'write_glb(sys.argv[3],scene,binary)',
  ].join('\n'),fixture,texturedFile,differentUV],{cwd:root});
  return {texturedFile,differentUV};
}

async function pixelAt(page,x,y){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const png=await page.screenshot({clip:{x,y,width:1,height:1}});
  return [...execFileSync(pythonExecutable(),['-c','import sys,io;from PIL import Image;sys.stdout.buffer.write(Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB").tobytes())'],{input:png})];
}

async function verifyOriginalTextureChannels(texturedFile){
  const created=await fetch(origin+'/api/projects/model-import?material=1',{
    method:'POST',headers:{'Content-Type':'model/gltf-binary',Origin:origin},body:await fs.readFile(texturedFile)
  });
  const doc=await created.json();assert.ok(created.ok,JSON.stringify(doc));
  await api('/api/projects/'+doc.id+'/paint/commands',{revision:doc.revision,operations:[
    {op:'base',patch:{metallic:.2,roughness:.8,ao:.4}},
    {op:'baseChannels',patch:{ao:true}},
    {op:'add',kind:'fill',patch:{name:'AO 调节',channels:{color:false,metallic:false,roughness:false,ao:true},values:{...doc.paint.base,ao:.4}}}
  ]});
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  try{
    await page.goto(origin+'/paint.html?project='+doc.id);
    await page.locator('[data-area-mode="modeling"]').click();
    const viewport=page.locator('.editor-viewport[data-state=ready]').first();
    await viewport.waitFor();
    const box=await viewport.boundingBox(),x=Math.floor(box.x+box.width*.5),y=Math.floor(box.y+box.height*.74);
    await page.mouse.click(x,y);
    await page.locator('.object-property-editor').getByText('表面材料',{exact:true}).filter({visible:true}).waitFor();
    const maps=page.locator('.object-property-editor .source-texture-channel:visible');
    assert.deepEqual(await maps.allTextContents(),['× color.RGB','× orm.B','× orm.G','× orm.R']);
    const transmission=page.locator('.object-property-editor').getByLabel('模型材质透射',{exact:true});
    assert.equal(await transmission.inputValue(),'0.75');
    await transmission.fill('0');await transmission.press('Enter');
    await until(async()=>(await api('/api/projects/'+doc.id)).paint.sourceMaterials?.['表面材料']?.transmission===0);
    const lensEdit=await api('/api/projects/'+doc.id);
    const incompatible=await fetch(origin+'/api/projects/'+doc.id+'/paint/update-glb?revision='+lensEdit.revision,{
      method:'POST',headers:{Origin:origin,'Content-Type':'model/gltf-binary'},body:model.bytes
    });
    assert.equal(incompatible.ok,false);
    assert.match((await incompatible.json()).error,/表面材料.*透射/);
    assert.equal((await api('/api/projects/'+doc.id)).revision,lensEdit.revision);
    await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();await page.locator('#undo').click();
    await until(async()=>await transmission.inputValue()==='0.75');
    const canvas=viewport.locator('canvas').first();
    const channels=await page.locator('select[aria-label="视口材质通道"]').locator('option').evaluateAll(options=>options.map(o=>o.value));
    assert.ok(channels.includes('normal')&&channels.includes('ao')&&channels.includes('alpha')&&channels.includes('emission'),JSON.stringify(channels));
    const result={},primary={};
    const frontX=Math.floor(box.x+box.width*.55),frontY=Math.floor(box.y+box.height*.48);
    for(const channel of channels.filter(Boolean)){
      await canvas.press('c');
      await viewport.and(page.locator('[data-inspected-channel="'+channel+'"]')).waitFor();
      result[channel]=await pixelAt(page,x,y);
      if(['metallic','roughness','ao'].includes(channel))primary[channel]=await pixelAt(page,frontX,frontY);
    }
    assert.ok(Math.max(...result.color)>Math.min(...result.color),JSON.stringify(result));
    const rough=result.roughness[0];
    assert.ok(rough===10||rough===40,JSON.stringify(result));
    const gray=value=>[value,value,value];
    assert.deepEqual(primary,{metallic:gray(51),roughness:gray(204),ao:gray(102)});
    assert.deepEqual(result.roughness,gray(rough));
    // The ORM transform offsets metal/roughness by half a texture. AO is unshifted.
    assert.deepEqual(result.metallic,gray(rough===10?100:30));
    assert.deepEqual(result.ao,gray(rough===10?160:136));
    assert.deepEqual(result.emission,[137,0,0]);
    assert.ok(result.normal.every((v,i)=>Math.abs(v-[163,128,250][i])<=1),JSON.stringify(result));
    assert.ok(result.alpha[0]>0&&result.alpha[0]<128,JSON.stringify(result));
    assert.deepEqual(result.alpha,gray(result.alpha[0]));
    await page.mouse.click(frontX,frontY);
    await page.locator('.object-property-editor').getByRole('button',{name:'查看图层属性'}).click();
    const ao=page.locator('.property-editor-material').getByLabel('环境遮蔽',{exact:true});
    await ao.fill('0.8');await ao.press('Enter');
    // Selection has moved the transform gizmo over the original sample.
    const insideFace=Math.floor(box.x+box.width*.5);
    const primaryShows=byte=>until(async()=>(await pixelAt(page,insideFace,frontY)).every(v=>v===byte),20000);
    await primaryShows(204);
    assert.deepEqual(await pixelAt(page,x,y),result.ao);
    await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();await page.locator('#undo').click();
    await primaryShows(102);
    await canvas.press('m');
    console.log('PASS original material textures, UV transform, PBR factors and data-channel display',JSON.stringify(result));
  }finally{await page.close();}
}

async function verifyObjectMaterialNavigation(id){
  const originalProject=await api('/api/projects/'+id);
  const withFill=await api('/api/projects/'+id+'/paint/commands',{revision:originalProject.revision,operations:[
    {op:'add',kind:'fill',patch:{name:'遮挡面涂层',channels:{color:true,metallic:false,roughness:true},values:originalProject.paint.base}}
  ]});
  const coat=withFill.paint.layers.at(-1);
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  try{
    await page.goto(origin+'/paint.html?project='+id);
    await page.locator('[data-area-mode="modeling"]').click();
    await page.locator('.editor-viewport[data-state=ready]').first().waitFor();
    const tree=page.getByLabel('场景物体列表',{exact:true});
    await tree.press('Home');
    const pick=name=>tree.getByText(name,{exact:true}).click();
    const inspector=page.locator('.object-property-editor');
    await pick('涂装面');
    const roughness=inspector.getByLabel('模型材质粗糙度',{exact:true});
    assert.equal(await roughness.inputValue(),'0.6');
    assert.equal(await inspector.locator('.source-texture-channel:visible').count(),0);
    assert.ok(await inspector.getByLabel('模型材质透射',{exact:true}).isHidden());
    assert.equal(await roughness.isVisible(),true);
    await pick('遮挡面');
    const layer=inspector.getByRole('button',{name:'查看图层属性'});
    await layer.waitFor();
    assert.equal(await roughness.isVisible(),false);
    assert.equal(await roughness.isDisabled(),true);
    assert.ok((await inspector.innerText()).includes('遮挡材料'));
    const search=page.getByRole('searchbox',{name:'搜索当前属性'});
    await search.fill('模型材质粗糙度');
    await page.getByText('没有匹配的设置',{exact:true}).waitFor();
    await search.fill('');
    await layer.click();
    assert.equal(await page.getByRole('tab',{name:'材质属性',exact:true}).getAttribute('aria-selected'),'true');
    await page.locator('.property-editor-material').getByLabel('粗糙度',{exact:true}).waitFor();
    await pick('涂装面');
    await roughness.waitFor();
    assert.equal(await roughness.inputValue(),'0.6');
    const viewport=page.locator('.editor-viewport[data-state=ready]').first();
    const box=await viewport.boundingBox(),x=Math.floor(box.x+box.width*.5),y=Math.floor(box.y+box.height*.74);
    await page.mouse.click(x,y);
    assert.equal(await inspector.getByLabel('模型材质粗糙度').inputValue(),'0.6');
    const canvas=viewport.locator('canvas').first();
    await canvas.press('c');await canvas.press('c');await canvas.press('c');
    await viewport.and(page.locator('[data-inspected-channel=roughness]')).waitFor();
    assert.deepEqual(await pixelAt(page,x,y),[153,153,153]);
    const field=await roughness.locator('..').boundingBox();
    const startX=Math.floor(field.x+field.width/2),startY=Math.floor(field.y+field.height/2);
    const scrub=async delta=>{
      await page.mouse.move(startX,startY);await page.mouse.down();
      await page.mouse.move(startX+delta,startY,{steps:5});
    };
    const revision=(await api('/api/projects/'+id)).revision;
    await scrub(-20);
    assert.deepEqual(await pixelAt(page,x,y),[102,102,102]);
    assert.equal((await api('/api/projects/'+id)).revision,revision);
    await page.keyboard.press('Escape');await page.mouse.up();
    assert.deepEqual(await pixelAt(page,x,y),[153,153,153]);
    assert.equal(await roughness.inputValue(),'0.6');
    await scrub(-40);
    assert.deepEqual(await pixelAt(page,x,y),[51,51,51]);
    assert.equal((await api('/api/projects/'+id)).revision,revision);
    await page.mouse.up();
    await until(async()=>(await api('/api/projects/'+id)).paint.sourceMaterials?.['表面材料']?.roughness===.2);
    assert.deepEqual(await pixelAt(page,x,y),[51,51,51]);
    assert.equal((await api('/api/projects/'+id)).revision,revision+1);
    await page.keyboard.press('Control+z');
    await until(async()=>await roughness.inputValue()==='0.6',5000);
    assert.deepEqual(await pixelAt(page,x,y),[153,153,153]);
    await page.keyboard.press('Control+Shift+z');
    await until(async()=>await roughness.inputValue()==='0.2',5000);
    assert.deepEqual(await pixelAt(page,x,y),[51,51,51]);
    await canvas.press('m');
    await viewport.and(page.locator('[data-inspected-channel]')).waitFor({state:'hidden'});
    await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();
    await page.locator('#undo').click();
    await until(async()=>await roughness.inputValue()==='0.6');
    console.log('PASS source roughness edit changes the picked surface pixel, full material and undo restore');
    console.log('PASS object properties follow painted and original surfaces without exposing the previous material');
    await page.locator('[data-area-mode=material]').click();
    await viewport.waitFor();
    const materialBox=await viewport.boundingBox(),properties=page.locator('.editor-area[data-editor=properties]');
    const pickSurface=(u,v)=>page.mouse.click(materialBox.x+u*materialBox.width,materialBox.y+v*materialBox.height);
    const original=properties.locator('.surface-properties');
    const before=await api('/api/projects/'+id);
    const sourceRough=original.getByRole('spinbutton',{name:'模型材质粗糙度'});
    await sourceRough.waitFor();
    assert.equal(await sourceRough.inputValue(),'0.6');
    const owner=page.locator('.editor-area[data-editor=layers]:visible .layer-stack-owner');
    assert.equal(await owner.innerText(),'主材质\n'+before.source.material);
    const addToPrimary=page.getByRole('button',{name:'＋ 主材质绘制层',exact:true});
    assert.ok((await addToPrimary.getAttribute('title')).includes(before.source.material));
    assert.ok((await original.innerText()).includes('表面材料'));
    assert.equal(await properties.locator('.editor-properties').isVisible(),false);
    // Hold the response after the real commit to inspect the value while saving.
    const release=Promise.withResolvers();
    const delayed=async route=>{
      const response=await route.fetch();
      await release.promise;await route.fulfill({response});
    };
    await page.route('**/paint/commands',delayed,{times:1});
    try{
      await sourceRough.fill('0.22');await sourceRough.press('Enter');
      await until(async()=>(await api('/api/projects/'+id)).paint.sourceMaterials?.['表面材料']?.roughness===.22);
      assert.equal(await sourceRough.inputValue(),'0.22');
    }finally{release.resolve();}
    await until(async()=>sourceRough.isEnabled());
    assert.deepEqual((await api('/api/projects/'+id)).paint.base,before.paint.base);
    // Hover over a different object after the edit; inspection must not pick it.
    await page.mouse.move(materialBox.x+.55*materialBox.width,materialBox.y+.48*materialBox.height);
    await page.keyboard.press('c');
    await viewport.and(page.locator('[data-inspected-channel=color]')).waitFor();
    assert.equal(await sourceRough.inputValue(),'0.22');
    await page.keyboard.press('m');
    await viewport.and(page.locator('[data-inspected-channel]')).waitFor({state:'hidden'});
    await pickSurface(.55,.48);
    await properties.locator('.editor-properties').waitFor();
    assert.ok(await owner.isHidden());
    await canvas.press('c');
    await viewport.and(page.locator('[data-inspected-channel=color]')).waitFor();
    const pigmentPixel=()=>pixelAt(page,Math.floor(materialBox.x+.55*materialBox.width),Math.floor(materialBox.y+.48*materialBox.height));
    const originalPixel=await pigmentPixel();
    const colorState=await api('/api/projects/'+id);
    await properties.locator('.editor-properties').getByLabel('颜色',{exact:true}).click();
    const hex=page.getByRole('textbox',{name:'HEX 颜色',exact:true});
    await hex.fill('#e12462');
    await until(async()=>{const [r,g,b]=await pigmentPixel();return r>180&&g<80&&b>70&&b<130;},12000);
    assert.equal((await api('/api/projects/'+id)).revision,colorState.revision);
    await hex.press('Escape');
    await until(async()=>String(await pigmentPixel())===String(originalPixel),12000);
    assert.deepEqual((await api('/api/projects/'+id)).paint,colorState.paint);
    await properties.locator('.editor-properties').getByLabel('颜色',{exact:true}).click();
    await hex.fill('#e12462');await hex.press('Enter');
    const readyPigment=properties.locator('form:focus[aria-busy=false]').getByLabel('颜色',{exact:true});
    async function colorSettled(color){
      await until(async()=>await readyPigment.count()&&await readyPigment.inputValue()===color,5000);
      assert.equal((await api('/api/projects/'+id)).paint.layers.find(l=>l.id===coat.id).values.color,color);
    }
    await colorSettled('#e12462');
    await page.keyboard.press('Control+z');
    await colorSettled(coat.values.color);
    await until(async()=>String(await pigmentPixel())===String(originalPixel),12000);
    await page.keyboard.press('Control+Shift+z');
    await colorSettled('#e12462');
    await page.keyboard.press('Control+z');
    await colorSettled(coat.values.color);
    console.log('PASS painted color preview, cancel and keyboard undo/redo from the property that committed it');
    await canvas.press('m');
    await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();await page.locator('#undo').click();
    await until(async()=>JSON.stringify((await api('/api/projects/'+id)).paint)===JSON.stringify(before.paint));
    await pickSurface(.5,.74);await sourceRough.waitFor();
    await until(async()=>await sourceRough.inputValue()==='0.6',5000);
    await addToPrimary.click();
    await until(async()=>(await api('/api/projects/'+id)).paint.layers.length===before.paint.layers.length+1);
    assert.deepEqual((await api('/api/projects/'+id)).paint.sourceMaterials,before.paint.sourceMaterials);
    await properties.locator('.editor-properties').waitFor();
    await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();await page.locator('#undo').click();
    await until(async()=>JSON.stringify((await api('/api/projects/'+id)).paint)===JSON.stringify(before.paint));
    await page.getByRole('button',{name:coat.name,exact:true}).click();
    await properties.locator('.editor-properties').waitFor();
    assert.equal(await original.isVisible(),false);
    await pickSurface(.55,.48);
    await page.locator('[data-area-mode=modeling]').click();
    await viewport.waitFor();
    await inspector.getByText('遮挡材料',{exact:true}).filter({visible:true}).waitFor();
    assert.ok(await inspector.getByRole('button',{name:'查看图层属性'}).isVisible());
    await page.locator('[data-area-mode=material]').click();
    await viewport.waitFor();
    await properties.locator('.editor-properties').waitFor();
    await page.locator('[data-area-mode=modeling]').click();
    await inspector.getByText('遮挡材料',{exact:true}).filter({visible:true}).waitFor();
    assert.deepEqual((await api('/api/projects/'+id)).paint,before.paint);
    const end=await api('/api/projects/'+id);
    const cleared=await api('/api/projects/'+id+'/paint/commands',{revision:end.revision,operations:[{op:'remove',id:coat.id}]});
    assert.deepEqual(cleared.paint,originalProject.paint);
    console.log('PASS switching workspaces follows the single object into its material and back to the newly picked object');
    console.log('PASS clicking a source in the material workspace edits that material and preserves the paint-layer target on undo');
  }finally{await page.close();}
}

async function verifyMultiMaterialPick(){
  // Split the existing test rectangle at its diagonal. Both materials belong to one object.
  const {gltf,binary}=sampleModel();
  gltf.nodes=[{name:'双色试片',mesh:0}];gltf.scenes[0].nodes=[0];
  gltf.meshes.length=1;gltf.accessors[2].count=3;
  gltf.accessors.push({...gltf.accessors[2],byteOffset:6});
  const primitives=gltf.meshes[0].primitives;
  primitives.push({...primitives[0],material:1,indices:3});
  // A second object uses the orange material twice. A third is in an inactive scene.
  gltf.meshes.push({primitives:primitives.map(p=>({...p,material:1}))});
  gltf.nodes.push({name:'饰片',mesh:1,translation:[-.55,.04,-.55],scale:[.12,1,.12]},{name:'另一场景的饰片',mesh:1});
  gltf.scenes[0].nodes.push(1);gltf.scenes.unshift({nodes:[2]});gltf.scene=1;
  const response=await fetch(origin+'/api/projects/model-import?material=0',{
    method:'POST',headers:{'Content-Type':'model/gltf-binary',Origin:origin},body:glbBytes(gltf,binary)
  });
  const doc=await response.json();assert.ok(response.ok,JSON.stringify(doc));
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  try{
    await page.goto(origin+'/paint.html?project='+doc.id);
    const workspace=mode=>page.locator('[data-area-mode='+mode+']').click();
    await workspace('modeling');
    const view=page.locator('.editor-viewport[data-state=ready]').first();await view.waitFor();
    const inspector=page.locator('.object-property-editor:visible'),slot=inspector.getByRole('button',{name:'物体材质槽'});
    const box=await view.boundingBox(),hit=x=>page.mouse.click(box.x+box.width*x,box.y+box.height*.55);
    await hit(.775);await until(async()=>await slot.innerText()==='遮挡材料',10000);
    // The Z handle covers the blue half of the already selected two-material mesh.
    const handleX=box.x+box.width*.494,handleY=box.y+box.height*.424;
    await page.mouse.click(handleX,handleY);
    await until(async()=>await slot.innerText()==='表面材料',5000);
    assert.equal((await api('/api/projects/'+doc.id)).revision,doc.revision);
    await hit(.775);
    await page.mouse.move(handleX,handleY);await page.mouse.down();
    await page.mouse.move(handleX,handleY-22,{steps:4});
    await page.mouse.move(handleX,handleY,{steps:4});await page.mouse.up();
    assert.equal(await slot.innerText(),'遮挡材料');
    assert.equal((await api('/api/projects/'+doc.id)).revision,doc.revision);
    await page.mouse.move(handleX,handleY);await page.mouse.down();
    await page.mouse.move(handleX,handleY-22,{steps:5});await page.mouse.up();
    const moved=await until(async()=>{const d=await api('/api/projects/'+doc.id);return d.modeling?.steps?.length&&d;});
    assert.equal(moved.modeling.steps.length,1);
    assert.equal(await slot.innerText(),'遮挡材料');
    const menuUndo=page.locator('#undo');
    await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();await menuUndo.click();
    await until(async()=>!(await api('/api/projects/'+doc.id)).modeling?.steps?.length);
    console.log('PASS tapping a transform handle picks the surface beneath it and dragging still transforms the selected object once');
    const rough=inspector.getByLabel('模型材质粗糙度');
    assert.equal(Number(await rough.inputValue()),.7);
    const users=inspector.locator('.source-material-users');
    await users.getByText('2 个物体共用此材质').click();
    await users.getByText('饰片',{exact:true}).waitFor();
    assert.deepEqual((await users.locator('li').allTextContents()).sort(),['双色试片','饰片'].sort());
    const shader=page.locator('.editor-area[data-editor=shader]');
    assert.equal(await shader.locator('.shader-material').innerText(),'主材质 · 表面材料');
    assert.equal(await shader.getByRole('button',{name:'启用节点材质'}).getAttribute('title'),'为「表面材料」启用节点');
    const saved=page.waitForResponse(r=>r.url().endsWith('/paint/commands')&&r.request().method()==='POST');
    await rough.fill('.24');await rough.press('Enter');assert.ok((await saved).ok());
    const changed=await api('/api/projects/'+doc.id);
    assert.equal(changed.paint.sourceMaterials['遮挡材料'].roughness,.24);
    assert.deepEqual(changed.paint.layers,doc.paint.layers);
    await hit(.36);await inspector.getByRole('button',{name:'打开材质工作区'}).waitFor();assert.equal(await slot.innerText(),'表面材料');
    await hit(.775);await workspace('material');await view.waitFor();
    const picked=page.locator('.surface-properties:visible').getByLabel('模型材质粗糙度');
    await picked.waitFor();assert.equal(Number(await picked.inputValue()),.24);
    assert.equal(await page.locator('.surface-properties:visible .source-material-users summary').innerText(),'2 个物体共用此材质');
    const screen=view.locator('canvas').first();
    for(let i=0;i<3;i++)await screen.press('c');
    await view.and(page.locator('[data-inspected-channel=roughness]')).waitFor();
    const area=await view.boundingBox();
    const pixel=x=>pixelAt(page,Math.floor(area.x+area.width*x),Math.floor(area.y+area.height*.53));
    assert.deepEqual(await pixel(.81),[61,61,61]);assert.deepEqual(await pixel(.48),[153,153,153]);
    await screen.press('m');
    await workspace('modeling');await rough.waitFor();assert.equal(await slot.innerText(),'遮挡材料');
    await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();await page.locator('#undo').click();
    await until(async()=>Number(await rough.inputValue())===.7,10000);
    assert.deepEqual((await api('/api/projects/'+doc.id)).paint,doc.paint);
    await slot.click();await page.getByRole('option',{name:'表面材料',exact:true}).click();
    await inspector.getByRole('button',{name:'打开材质工作区'}).click();await view.waitFor();
    await page.locator('.editor-area[data-editor=properties]').getByText('请选择材质图层',{exact:true}).filter({visible:true}).waitFor();
    await workspace('modeling');await inspector.getByRole('button',{name:'打开材质工作区'}).waitFor();
    assert.equal(await slot.innerText(),'表面材料');
    console.log('PASS face picking and manual slot choice edit the correct material on a multi-material object across both workspaces');
    await page.locator('[data-scene-object-id] .editor-layer-name').getByText('饰片',{exact:true}).click();
    const beforeFocus=await api('/api/projects/'+doc.id);
    await workspace('material');await view.waitFor();
    const focusedObject=page.locator('.surface-properties:visible .render-settings-readout').filter({hasText:/^饰片$/});
    await focusedObject.waitFor();
    // Deliver F immediately before pointerup reaches the canvas pick handler,
    // so a repaint cannot mask a stale camera matrix between these two actions.
    await screen.evaluate(canvas=>canvas.addEventListener('pointerup',()=>{
      canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',bubbles:true,cancelable:true}));
    },{once:true,capture:true}));
    const framed=await screen.boundingBox();
    await page.mouse.click(framed.x+framed.width/2,framed.y+framed.height/2);
    await view.and(page.locator('[data-frame-mode=selection]')).waitFor();
    await focusedObject.waitFor();
    assert.equal((await api('/api/projects/'+doc.id)).revision,beforeFocus.revision);
    console.log('PASS material focus centers the picked object when another visible object shares its material');
  }finally{await page.close();}
}

async function verifyMarkedMaterialInspection(){
  const response=await fetch(origin+'/api/projects/model-import?material=1',{
    method:'POST',headers:{'Content-Type':'model/gltf-binary',Origin:origin},body:model.bytes
  });
  const project=await response.json();assert.ok(response.ok,JSON.stringify(project));
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  try{
    const png=await page.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
      const brush=canvas.getContext('2d');brush.fillStyle='#fac040';brush.fillRect(6,6,4,4);
      return canvas.toDataURL().split(',')[1];
    });
    const path='/api/projects/'+project.id+'/paint';
    const painted=await api(path+'/commands',{revision:project.revision,operations:[{op:'add',kind:'fill',patch:{name:'机壳罩漆'}}]});
    const {asset,document}=await api(path+'/assets',{revision:painted.revision,name:'校准块.png',data:png});
    await page.goto(origin+'/paint.html?project='+project.id);
    await page.locator('[data-area-mode=material]').click();
    await page.getByRole('button',{name:'机壳罩漆',exact:true}).click();
    const view=page.locator('.editor-viewport[data-state=ready]').first();await view.waitFor();
    const box=await view.boundingBox(),x=Math.floor(box.x+box.width*.5),y=Math.floor(box.y+box.height*.74);
    await page.mouse.click(x,y);
    const fields=page.locator('.surface-properties:visible'),base=fields.getByLabel('模型材质底色');
    await base.waitFor();
    await view.locator('canvas').first().press('c');
    await view.and(page.locator('[data-inspected-channel=color]')).waitFor();
    const before=await pixelAt(page,x,y);
    let reloads=0;page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/model.glb'))reloads++;});
    const added=page.waitForResponse(r=>r.url().endsWith('/paint/source-mark'));
    await view.evaluate((el,{id,revision,image,x,y})=>{
      const transfer=new DataTransfer();transfer.setData('application/x-arachne-asset',image);
      transfer.setData('application/x-arachne-asset-origin',JSON.stringify({projectId:id,revision}));
      el.dispatchEvent(new DragEvent('drop',{clientX:x,clientY:y,dataTransfer:transfer,bubbles:true,cancelable:true}));
    },{id:project.id,revision:document.revision,image:asset.id,x,y});
    const result=await added;assert.ok(result.ok(),await result.text());
    const mark=[250,192,64],blue=[58,112,180],rgbAt=(dx=0)=>pixelAt(page,x+dx,y);
    const shows=(dx,color)=>until(async()=>JSON.stringify(await rgbAt(dx))===JSON.stringify(color),10000);
    await shows(0,mark);
    const uncovered=await rgbAt(75);assert.deepEqual(uncovered,before);
    const revision=(await api('/api/projects/'+project.id)).revision;
    const picker=page.getByRole('dialog',{name:'模型材质底色选色',exact:true}),hex=picker.getByLabel('HEX 颜色');
    await base.click();await hex.fill('#3a70b4');
    await shows(75,blue);assert.deepEqual(await rgbAt(),mark);
    assert.equal((await api('/api/projects/'+project.id)).revision,revision);
    await hex.press('Escape');await shows(75,before);
    await base.click();await hex.fill('#3a70b4');await shows(75,blue);
    await hex.press('Enter');await until(async()=>(await api('/api/projects/'+project.id)).revision===revision+1);
    assert.deepEqual(await rgbAt(75),blue);assert.deepEqual(await rgbAt(),mark);
    const travel=async direction=>{
      await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();
      await page.locator('#'+direction).click();
    };
    const markBefore=(await api('/api/projects/'+project.id)).paint.sourceMaterials['表面材料'].mark;
    const reset=fields.getByRole('button',{name:'恢复材质参数'});
    await reset.click();await shows(75,before);assert.deepEqual(await rgbAt(),mark);
    assert.deepEqual((await api('/api/projects/'+project.id)).paint.sourceMaterials['表面材料'],{mark:markBefore});
    assert.ok(await reset.isDisabled());
    await travel('undo');await shows(75,blue);assert.deepEqual(await rgbAt(),mark);
    await fields.getByRole('button',{name:'移除标记'}).click();await shows(0,blue);
    await travel('undo');await shows(0,mark);assert.deepEqual(await rgbAt(75),blue);
    await travel('redo');await shows(0,blue);
    assert.equal(await view.getAttribute('data-inspected-channel'),'color');
    assert.equal(reloads,0);
    console.log('PASS original-UV mark, background color, removal and undo/redo update the actual inspected pixels without reloading the GLB');
    await travel('undo');await shows(0,mark);
    const restored=await api('/api/projects/'+project.id);
    await page.reload();await fields.getByText('校准块.png',{exact:true}).click();
    const viewer=page.locator('.image-viewer[open]');
    await viewer.getByRole('heading',{name:'校准块.png · 16×16'}).waitFor();
    const sourceImage=viewer.locator('img').first();
    await until(()=>sourceImage.evaluate(img=>img.naturalWidth===16));
    assert.equal(new URL(await sourceImage.getAttribute('src'),origin).pathname,path+'/assets/'+asset.id);
    await page.keyboard.press('Escape');await viewer.waitFor({state:'hidden'});
    assert.equal(await fields.locator('.source-mark-preview:focus').count(),1);
    await shows(0,mark);await shows(75,blue);
    const gate=Promise.withResolvers();
    await page.route('**/model.glb*',async route=>{await gate.promise;await route.continue();},{times:1});
    try{
      const loading=page.waitForRequest('**/model.glb*');
      await page.reload({waitUntil:'domcontentloaded'});await loading;
      await page.getByRole('button',{name:'机壳罩漆',exact:true}).click();
    }finally{gate.resolve();}
    await view.waitFor();await view.and(page.locator('[data-inspected-channel=color]')).waitFor();
    await shows(0,mark);
    assert.ok(await fields.isHidden());
    assert.ok(await page.locator('.editor-area[data-editor=properties] .editor-properties').isVisible());
    assert.equal((await api('/api/projects/'+project.id)).revision,restored.revision);
    console.log('PASS reopening restores the marked surface and honors a newer layer selection made while loading the GLB');
    await page.mouse.click(x,y);
    const filename=fields.getByText('校准块.png',{exact:true});
    await filename.waitFor();
    async function reloadPickedSurface(action){
      const geometry=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/model.glb'));
      await action();assert.ok((await geometry).ok());await view.waitFor();await filename.waitFor();
      assert.deepEqual(await fields.locator('.render-settings-readout').allTextContents(),['涂装面','表面材料']);
      await shows(0,mark);
      return (await api('/api/projects/'+project.id)).source.reviewSource;
    }
    const updatedSource=await reloadPickedSurface(async()=>{
      const choosing=page.waitForEvent('filechooser');
      await page.locator('.paint-menu summary').getByText('文件',{exact:true}).click();
      await page.locator('#update-project-model').click();
      await (await choosing).setFiles({name:'调整遮挡面.glb',mimeType:'model/gltf-binary',buffer:sampleModel(true,.26).bytes});
    });
    assert.notEqual(updatedSource,restored.source.reviewSource);
    assert.equal(await reloadPickedSurface(()=>travel('undo')),restored.source.reviewSource);
    assert.equal(await reloadPickedSurface(()=>travel('redo')),updatedSource);
    console.log('PASS updating the GLB and traveling its history keep the marked surface editable at the original view');
  }finally{await page.close();}
}

async function verifyRenderedSurfacePicking(id){
  const page=await browser.newPage({viewport:{width:1200,height:800}});
  try{
    await page.addInitScript(()=>localStorage.setItem('arachne-cycles-viewport-v1',JSON.stringify({maxSamples:4,denoise:false})));
    await page.goto(origin+'/paint.html?project='+id);
    await page.locator('[data-area-mode=modeling]').click();
    const view=page.locator('.editor-viewport[data-state=ready]').first();await view.waitFor();
    const pickFront=async()=>{
      const box=await view.boundingBox();
      await page.mouse.click(box.x+.55*box.width,box.y+.48*box.height);
    };
    const shade=mode=>page.getByRole('button',{name:mode,exact:true}).click();
    const tree=page.getByLabel('场景物体列表',{exact:true});await tree.press('Home');
    const flags=await api('/api/projects/'+id);
    await page.getByRole('button',{name:'从渲染排除 遮挡面',exact:true}).click();
    await until(async()=>(await api('/api/projects/'+id)).paint.renderVisibility?.['遮挡面']===false);
    await shade('渲染预览');
    await view.and(page.locator('[data-render-phase=ready]')).waitFor({timeout:90000});
    await pickFront();
    const object=page.locator('.object-property-editor:visible');
    await object.getByText('表面材料',{exact:true}).filter({visible:true}).waitFor();
    await page.locator('[data-area-mode=material]').click();await view.waitFor();
    await shade('材质预览');await pickFront();
    await page.locator('.editor-area[data-editor=properties] .editor-properties:visible').waitFor();
    await shade('渲染预览');
    await view.and(page.locator('[data-render-phase=ready]')).waitFor({timeout:90000});
    const originalSamples=await view.evaluate(el=>{
      window.sampleCounts=[];
      new MutationObserver(()=>window.sampleCounts.push(+el.dataset.renderSamples))
        .observe(el,{attributes:true,attributeFilter:['data-render-samples']});
      return +el.dataset.renderSamples;
    });
    assert.ok(originalSamples>1);
    await pickFront();
    await page.locator('.surface-properties:visible').getByText('表面材料',{exact:true}).waitFor();
    const [phase,samples,minimum]=await view.evaluate(async el=>{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return [el.dataset.renderPhase,+el.dataset.renderSamples,Math.min(+el.dataset.renderSamples,...window.sampleCounts)];
    });
    assert.deepEqual([phase,samples,minimum],['ready',originalSamples,originalSamples]);
    const screen=view.locator('canvas').first();
    for(let i=0;i<3;i++)await screen.press('c');
    await view.and(page.locator('[data-inspected-channel=roughness]')).waitFor();
    const box=await view.boundingBox();
    assert.deepEqual(await pixelAt(page,Math.floor(box.x+box.width*.55),Math.floor(box.y+box.height*.48)),[153,153,153]);
    await pickFront();
    await page.locator('.surface-properties:visible').getByText('表面材料',{exact:true}).waitFor();
    await screen.press('m');
    await view.and(page.locator('[data-shading=cycles][data-render-phase=ready]:not([data-inspected-channel])')).waitFor({timeout:90000});
    await page.locator('.paint-menu summary').getByText('编辑',{exact:true}).click();await page.locator('#undo').click();
    await until(async()=>JSON.stringify((await api('/api/projects/'+id)).paint)===JSON.stringify(flags.paint));
    await pickFront();
    await page.locator('.editor-area[data-editor=properties] .editor-properties:visible').waitFor();
    console.log('PASS rendered picks follow the visible surface in object and material modes, preserve accumulated samples, and follow undo');
  }finally{await page.close();}
}

async function verifyModelWorkflows(){
  assert.deepEqual(await api('/api/projects'),[]);
  const noUv=await fetch(origin+'/api/projects/model-import?material=1',{
    method:'POST',headers:{'Content-Type':'model/gltf-binary',Origin:origin},body:sampleModel(false).bytes
  });
  assert.equal(noUv.status,400);
  assert.deepEqual(await noUv.json(),{error:'所选材质没有有效 TEXCOORD_0 或 UV 超出 0–1'});
  assert.deepEqual(await api('/api/projects'),[]);

  await assert.rejects(fs.stat(path.join(data,'model-geometry')),{code:'ENOENT'});
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  await page.goto(origin);
  const welcome=page.locator('.project-welcome');
  await welcome.getByRole('button',{name:'新建工程',exact:true}).click();
  const newDialog=page.locator('#new-paint-dialog');
  const modelInput=newDialog.locator('#new-paint-model');
  const modelName=newDialog.locator('#new-paint-name');
  const profileOptions=page.locator('#new-profile-options');
  const profileUpload=text=>({name:'双色检修片.svg',mimeType:'image/svg+xml',buffer:Buffer.from(text)});
  await modelInput.setInputFiles(profileUpload('<svg xmlns="http://www.w3.org/2000/svg"><g id="壳"><rect width="12" height="8" fill="#ce673d"/></g><circle id="帽" cx="6" cy="4" r="1"/></svg>'));
  await profileOptions.waitFor({state:'visible'});
  await profileOptions.getByLabel('厚度',{exact:true}).fill('6');
  await profileOptions.getByLabel('倒角',{exact:true}).fill('3');
  await profileOptions.getByLabel('倒角',{exact:true}).press('Tab');
  await newDialog.locator('#new-paint-submit').click();
  await newDialog.getByRole('alert').filter({hasText:'倒角'}).waitFor();
  await profileOptions.getByLabel('倒角',{exact:true}).fill('.7');
  await profileOptions.getByLabel('仅看当前部件').check();
  const profileDownload=page.waitForEvent('download');
  await profileOptions.getByRole('button',{name:'保存轮廓设置…'}).click();
  const sourceFile=await (await profileDownload).path();
  const savedProfile=await fs.readFile(sourceFile,'utf8');
  await newDialog.getByRole('button',{name:'使用模板'}).click();
  await modelInput.setInputFiles(profileUpload(savedProfile));
  await profileOptions.waitFor({state:'visible'});
  assert.equal(await profileOptions.getByLabel('厚度',{exact:true}).inputValue(),'6');
  assert.equal(Number(await profileOptions.getByLabel('倒角',{exact:true}).inputValue()),.7);
  // A replacement SVG must also render on-screen after disposing the first context.
  await page.waitForFunction(()=>{
    const canvas=document.querySelector('#profile-preview');
    return canvas.width===Math.floor(canvas.clientWidth*Math.min(devicePixelRatio,2))&&
      !!canvas.getContext('webgl2')&&!canvas.getContext('webgl2').isContextLost()&&
      !document.querySelector('#new-paint-error').textContent;
  });
  await newDialog.getByRole('button',{name:'使用模板'}).click();
  await modelInput.setInputFiles({name:'not-a-model.glb',mimeType:'model/gltf-binary',buffer:Buffer.from('invalid')});
  await newDialog.getByText('请选择有效的 GLB 2.0 模型').waitFor();
  assert.equal(await newDialog.locator('#new-paint-submit').isDisabled(),true);
  await newDialog.getByRole('button',{name:'使用模板'}).click();
  assert.equal(await newDialog.locator('#new-paint-submit').isEnabled(),true);
  await modelName.fill('手工输入的工程名');
  await modelInput.setInputFiles(fixture);
  await newDialog.getByText('uncached-model.glb',{exact:true}).waitFor();
  assert.equal(await modelName.inputValue(),'手工输入的工程名');
  await newDialog.getByRole('button',{name:'关闭',exact:true}).click();
  const transfer=await page.evaluateHandle(bytes=>{
    const data=new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)],'uncached-model.glb',{type:'model/gltf-binary'}));
    return data;
  },[...model.bytes]);
  await welcome.dispatchEvent('dragover',{dataTransfer:transfer});
  assert.equal(await welcome.getAttribute('data-file-drop'),'');
  await welcome.dispatchEvent('drop',{dataTransfer:transfer});
  await transfer.dispose();
  await newDialog.getByText('uncached-model.glb',{exact:true}).waitFor();
  assert.equal(await modelName.inputValue(),'uncached-model');
  assert.deepEqual(await api('/api/projects'),[]);
  await newDialog.getByRole('button',{name:'涂装材质',exact:true}).click();
  await newDialog.getByRole('option',{name:'表面材料',exact:true}).waitFor();
  await newDialog.getByRole('option',{name:'遮挡材料',exact:true}).click();
  await newDialog.locator('#new-paint-submit').click();
  const id=await until(async()=>new URL(page.url()).searchParams.get('project'));
  const route='/api/projects/'+id,paint=route+'/paint';
  await verifyObjectMaterialNavigation(id);
  await verifyRenderedSurfacePicking(id);
  const registered=await api(route),manifest=await api(route+'/viewport');
  assert.equal(registered.source.format,'glb');
  assert.equal(registered.source.material,'遮挡材料');
  assert.equal(manifest.metadata.input_sha256,digest(model.bytes));
  assert.equal(manifest.metadata.uv_before,registered.source.uvSha256);
  const glb=Buffer.from(await (await fetch(origin+manifest.modelUrl)).arrayBuffer());
  const length=glb.readUInt32LE(12);
  assert.deepEqual(glb.subarray(28+length),model.binary);
  const registeredGltf=JSON.parse(glb.subarray(20,20+length).toString());
  const topologyState=await api(route+'/viewport/topology',{});
  const topology=await api(topologyState.url);
  assert.equal(topology.modelSha256,manifest.modelSha256);
  assert.deepEqual(topology.primitives['0:0'].polygons,[0,1]);
  await until(async()=>(await api(paint+'/model-state')).status==='ready');
  const baseline=path.dirname(registered.source.cacheRun);
  const originalGuide=await fs.readFile(path.join(baseline,'guides','top','receiver.png'));
  // Remove the atlas and its report as if the local surface cache was cleared.
  await fs.rm(baseline,{recursive:true,force:true});
  const angle=.3,c=Math.cos(angle),s=Math.sin(angle);
  const steps=[
    {matrix:[c,0,-s,0,0,1,0,0,s,0,c,0,-.85,0,0,1],targets:[{id:1}]},
    {matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,.25,0,1],targets:[{mesh:0,vertices:[0]}]}
  ];
  let doc=await api(paint+'/model',{revision:registered.revision,modeling:{
    version:1,binding:manifest.key,modelSha256:manifest.modelSha256,steps,nativeSteps:nativeModelSteps(registeredGltf,steps,topology)
  }});
  const camera={projection:'orthographic',eye:[2,5,2],target:[0,0,0],up:[0,1,0],fov:38,orthoHeight:3.1};
  const preset=captureRenderPreset(updateDeliveryOptions({},{framing:'saved',width:384,height:288,samples:8,maxBounces:4,transparent:true}));
  doc=await api(paint+'/commands',{revision:doc.revision,operations:[
    {op:'renderCamera',camera},{op:'renderPreset',preset},{op:'base',patch:{color:'#287aab'}}
  ]});
  await page.goto(origin+'/?project='+id);
  await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  await page.locator('[data-area-mode=modeling]').click();
  const renderProperties=page.locator('.editor-area[data-editor=renderSettings]').first();
  await renderProperties.getByRole('tab',{name:'渲染属性',exact:true}).click();
  await renderProperties.getByText('场景布光',{exact:true}).click();
  await renderProperties.getByRole('checkbox',{name:'调整场景布光',exact:true}).check();
  await renderProperties.getByRole('button',{name:'布光预设',exact:true}).click();
  await page.getByRole('option',{name:'自定义',exact:true}).click();
  await renderProperties.getByRole('button',{name:'添加区域灯',exact:true}).click();
  const lightName=renderProperties.getByRole('textbox',{name:'灯光名称',exact:true});
  await lightName.fill('蓝色轮廓光');
  await lightName.press('Tab');
  const lightColor=renderProperties.getByLabel('灯光颜色',{exact:true});
  await lightColor.fill('#608cff');
  await until(async()=>(await api(route)).paint.renderLighting?.lights?.some(light=>light.name==='蓝色轮廓光'&&light.color==='#608cff'));
  doc=await api(route);
  assert.equal(doc.paint.renderLighting.lights.length,4);
  const viewport=page.locator('.editor-viewport[data-state=ready]').first();
  await page.getByRole('button',{name:'渲染预览',exact:true}).first().click();
  await page.locator('.editor-viewport[data-render-lighting=project][data-render-phase=ready]').first().waitFor({timeout:90000});
  await viewport.screenshot({path:path.join(data,'project-lighting-viewport.png')});
  const shading=page.getByRole('button',{name:'着色设置',exact:true}).first();
  await shading.click();
  await page.getByRole('checkbox',{name:'使用工程布光',exact:true}).uncheck();
  await page.keyboard.press('Escape');
  await page.locator('.editor-viewport[data-render-lighting=viewport][data-render-phase=ready]').first().waitFor({timeout:90000});
  await shading.click();
  await page.getByRole('checkbox',{name:'使用工程布光',exact:true}).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'材质预览',exact:true}).first().click();
  await page.getByText('渲染',{exact:true}).filter({visible:true}).first().click();
  await page.locator('#open-paint-render').click();
  await page.getByRole('button',{name:'出图 PNG 颜色空间',exact:true}).click();
  await page.getByRole('option',{name:'Display P3',exact:true}).click();
  await page.locator('#start-paint-render').click();
  const result=await until(async()=>{
    const job=(await api(route+'/jobs')).find(item=>item.type==='paint-render');
    if(job?.status==='failed')throw Error(await (await fetch(origin+route+'/jobs/'+job.id+'/files/run.log')).text());
    return job?.status==='completed'&&job;
  });
  assert.equal(result.render.engine,'PATH_TRACING');
  assert.equal(result.render.uvSha256,registered.source.uvSha256);
  assert.equal(result.paintReport.modelFingerprint,(await api(paint+'/model-state')).fingerprint);
  assert.equal(result.reusedPaintBake,undefined);
  assert.deepEqual(result.render.camera,camera);
  assert.deepEqual(result.render.lighting,doc.paint.renderLighting);
  const rebuiltGuide=await fs.readFile(path.join(baseline,'guides','top','receiver.png'));
  assert.deepEqual(rebuiltGuide,originalGuide);
  const editedFolders=await fs.readdir(path.join(data,'model-geometry'));
  assert.equal(editedFolders.length,1);
  const edited=path.join(data,'model-geometry',editedFolders[0]);
  const geometry=JSON.parse(await fs.readFile(path.join(edited,'cache','geometry_report.json')));
  assert.equal(geometry.engine,'glb');
  assert.equal(geometry.uv_before_sha256,registered.source.uvSha256);
  assert.notDeepEqual(await fs.readFile(path.join(edited,'guides','top','receiver.png')),originalGuide);
  const download=page.locator('#paint-render-download');
  const [file]=await Promise.all([page.waitForEvent('download'),download.click()]);
  const pngPath=path.join(data,'render.png');
  await file.saveAs(pngPath);
  const png=await fs.readFile(pngPath);
  assert.equal(digest(png),result.render.sha256);
  assert.equal(result.render.pngSpace,'display-p3');
  execFileSync(pythonExecutable(),['-B','-c',`from PIL import Image,ImageCms
from io import BytesIO
import sys
im=Image.open(sys.argv[1])
assert 'P3' in ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(BytesIO(im.info['icc_profile'])))
assert im.getextrema()[3]==(0,255)`,pngPath]);
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[384,288]);
  await page.goto(origin+'/?project='+id);
  await page.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  await page.getByText('文件',{exact:true}).filter({visible:true}).first().click();
  await page.locator('#open-delivery').click();
  await page.getByRole('button',{name:'贴图输出预设',exact:true}).click();
  await page.getByRole('option',{name:'Unreal · ORM',exact:true}).click();
  assert.equal(await page.locator('#delivery').isDisabled(),true);
  await page.locator('#delivery-preview-button').click();
  await page.locator('#approved').check({timeout:120000});
  await page.getByRole('button',{name:'交付渲染格式',exact:true}).click();
  await page.getByRole('option',{name:'OpenEXR · 32 位浮点',exact:true}).click();
  await page.getByRole('button',{name:'交付 EXR 颜色空间',exact:true}).click();
  await page.getByRole('option',{name:'ACEScg（AP1）',exact:true}).click();
  assert.equal(await page.locator('#approved').isChecked(),false);
  await page.locator('#approved').check();
  await page.screenshot({path:path.join(data,'texture-export-presets.png')});
  await page.locator('#delivery').click();
  const delivery=await until(async()=>{
    const job=(await api(route+'/jobs')).find(item=>item.type==='paint-export');
    if(job?.status==='failed')throw Error(await (await fetch(origin+route+'/jobs/'+job.id+'/files/run.log')).text());
    return job?.status==='completed'&&job;
  });
  assert.deepEqual(delivery.render.camera,camera);
  assert.equal(delivery.render.engine,'PATH_TRACING');
  assert.equal(delivery.render.colorInteropID,'lin_ap1_scene');
  assert.equal(delivery.blendUrl,undefined);
  assert.equal(delivery.texturePreset,'unreal-orm');
  const zip=path.join(data,'delivery.zip');
  const [archive]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'交付 ZIP · r'+doc.revision}).click()]);
  await archive.saveAs(zip);
  execFileSync(pythonExecutable(),['-c',[
    'import hashlib, io, json, sys, zipfile',
    'from PIL import Image',
    'from model_glb import Model',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' r=json.loads(z.read("project-report.json"))',
    ' assert r["bake"]["previewId"]==sys.argv[2]',
    ' assert not any(name.endswith(".blend") for name in z.namelist())',
    ' assert set(z.namelist())==set(r["fileSha256"])|{"project-report.json"}',
    ' for name,expected in r["fileSha256"].items():',
    '  data=z.read(name)',
    '  assert hashlib.sha256(data).hexdigest()==expected',
    '  if name.startswith("textures/"):',
    '   with Image.open(io.BytesIO(data)) as texture:',
    '    assert texture.size==(4096,4096)',
    '    texture.load()',
    ' mat=json.loads(z.read("materials.json"))',
    ' assert len(mat["channels"])==8 and {c["file"]:c["sha256"] for c in mat["channels"].values()}==r["bake"]["files"]',
    ' output=r["textureOutput"]; assert output["preset"]=="unreal-orm" and output["resolution"]==[4096,4096]',
    ' assert all(r["fileSha256"][name]==item["sha256"] for name,item in output["files"].items())',
    ' def png(name): return Image.open(io.BytesIO(z.read(name)))',
    ' uv=(1100,2100)',
    ' def original(key): return png(mat["channels"][key]["file"]).getpixel(uv)',
    ' orm=png("presets/unreal-orm/ORM.png")',
    ' assert orm.mode=="RGB" and orm.info["gamma"]==1 and orm.getpixel(uv)==tuple(original(key) for key in ("ao","roughness","metallic"))',
    ' color=png("presets/unreal-orm/BaseColor.png")',
    ' assert color.mode=="RGBA" and color.info["srgb"]==0 and color.getpixel(uv)==(*original("color"),original("alpha"))',
    ' normal=png("presets/unreal-orm/Normal_DirectX.png"); r0,g0,b0=original("normal")',
    ' assert normal.getpixel(uv)==(r0,255-g0,b0)',
    ' model=Model(z.extract("model.glb",sys.argv[3]))',
    ' assert model.uv_digest()==mat["uvSha256"]',
    ' assert model.primitives[0]["positions"][0,1]==0.25',
    ' assert "baseColorTexture" not in model.primitives[0]["material"]["pbrMetallicRoughness"]',
    ' assert model.primitives[0]["material"]["pbrMetallicRoughness"]["baseColorFactor"]==[.03,.2,.36,1]',
    ' assert model.primitives[1]["material"]["pbrMetallicRoughness"]["baseColorTexture"]',
    ' with Image.open(io.BytesIO(z.read("render.png"))) as frame:',
    '  assert frame.size==(384,288)',
    '  frame.load()'
  ].join('\n'),zip,delivery.paintPreviewId,data],{cwd:root,stdio:'inherit'});
  const bytes=Buffer.from(await (await fetch(origin+delivery.outputUrl)).arrayBuffer());
  assert.equal(digest(bytes),delivery.outputSha256);
  const exr=new EXRLoader().setDataType(FloatType).parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  assert.deepEqual([exr.width,exr.height],[384,288]);
  assert.ok(exr.header.channels.every(channel=>channel.pixelType===2));
  assert.ok(exr.data.every(Number.isFinite));

  const clean=path.join(data,'clean');await fs.mkdir(clean);
  const other=await start(clean);
  const reopened=await browser.newPage();
  await reopened.goto(other);
  await reopened.locator('.project-welcome').getByRole('button',{name:'打开涂装 ZIP…'}).click();
  const importDialog=reopened.locator('#paint-import-dialog');
  const archiveInput=importDialog.locator('#paint-import-file');
  const importSubmit=importDialog.locator('#paint-import-submit');
  assert.equal(await importSubmit.isDisabled(),true);
  await archiveInput.setInputFiles({name:'not-a-project.zip',mimeType:'application/zip',buffer:Buffer.from('invalid')});
  await importDialog.getByText('请选择有效的涂装 ZIP').waitFor();
  assert.equal(await importSubmit.isDisabled(),true);
  await archiveInput.setInputFiles(zip);
  await importDialog.getByText(path.basename(zip),{exact:true}).waitFor();
  await importSubmit.click();
  const restoredId=await until(async()=>new URL(reopened.url()).searchParams.get('project'));
  const restored=await fetch(other+'/api/projects/'+restoredId).then(response=>response.json());
  assert.deepEqual(restored.paint,doc.paint);
  assert.deepEqual(restored.modeling,doc.modeling);
  await reopened.reload();
  await reopened.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  console.log('PASS GLB drag and drop, invalid file validation, ZIP chooser and project reopen');
  console.log('PASS editable area lights shared by path-traced viewport, frozen output and restored project');
  execFileSync(process.execPath,['scripts/seed-native-demo.mjs'],{cwd:root,stdio:'inherit',
    env:{...process.env,ARACHNE_DATA_DIR:clean,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:probe},timeout:30000});
  const seed=await fetch(other+'/api/projects/'+nativeDemoProjectId).then(response=>response.json());
  assert.equal(seed.source.format,'glb');
  assert.equal(seed.source.material,'Housing');
  const created=await fetch(other+'/api/projects',{method:'POST',headers:{Origin:other,'Content-Type':'application/json'},
    body:JSON.stringify({workflowType:'pbr_paint',name:'原生示例验收'})});
  assert.equal(created.status,201);
  const sample=await created.json();
  assert.deepEqual(sample.source.files,seed.source.files);
  const nativeRoute='/api/projects/'+sample.id;
  const nativeView=await fetch(other+nativeRoute+'/viewport').then(response=>response.json());
  assert.equal(nativeView.metadata.uv_before,seed.source.uvSha256);
  const nativeBake=await fetch(other+nativeRoute+'/paint/preview',{method:'POST',
    headers:{Origin:other,'Content-Type':'application/json'},body:JSON.stringify({revision:sample.revision,requestId:'native-demo-4k'})});
  assert.equal(nativeBake.status,202);
  const {id:sampleJob}=await nativeBake.json();
  const bakedSample=await until(async()=>{
    const job=await fetch(other+nativeRoute+'/jobs/'+sampleJob).then(response=>response.json());
    if(job.status==='failed')throw Error(job.error);
    return job.status==='completed'&&job;
  });
  assert.equal(bakedSample.paintReport.uv_unchanged,true);
  assert.equal(Object.keys(bakedSample.paintReport.files).length,8);
  await assert.rejects(fs.stat(path.dirname(seed.source.cacheRun)),{code:'ENOENT'});
  assert.ok((await fs.readdir(path.join(clean,'model-geometry'))).length);
  // The bundled sample has no in-place cache. Editing its cap requires the portable original UV mask.
  const capMatrix=[1,0,0,0,0,1,0,0,0,0,1,0,.4,0,0,1];
  await api(nativeRoute+'/paint/model',{revision:sample.revision,modeling:{
    version:1,binding:nativeView.key,modelSha256:nativeView.modelSha256,
    steps:[{targets:[{id:1}],matrix:capMatrix}],nativeSteps:[{matrix:capMatrix,targets:[{object:'Cover'}]}]
  }},other);
  const layout=await fetch(other+nativeRoute+'/paint/uv-layout');
  assert.equal(layout.status,200);
  assert.equal(layout.headers.get('x-uv-sha256'),seed.source.uvSha256);
  assert.deepEqual([...new Uint8Array(await layout.arrayBuffer()).subarray(0,8)],[137,80,78,71,13,10,26,10]);
  await assert.rejects(fs.stat(path.dirname(seed.source.cacheRun)),{code:'ENOENT'});
  console.log('PASS native example creation and eight-channel 4K bake without Blender or writes to sample sources');

  await reopened.locator('summary').filter({hasText:/^文件$/}).click();
  await reopened.locator('#new').click();
  const templateDialog=reopened.locator('#new-paint-dialog');
  await templateDialog.getByRole('button',{name:'模型模板',exact:true}).click();
  await templateDialog.getByRole('option',{name:'立方体',exact:true}).click();
  assert.equal(await templateDialog.locator('#new-paint-name').inputValue(),'立方体 · PBR 涂装');
  await templateDialog.locator('#new-paint-submit').click();
  const cubeId=await until(()=>{
    const id=new URL(reopened.url()).searchParams.get('project');
    return id!==restoredId&&id;
  });
  await reopened.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  origin=other;
  const cubeRoute='/api/projects/'+cubeId;
  const cube=await api(cubeRoute),cubeView=await api(cubeRoute+'/viewport');
  assert.equal(cube.source.format,'glb');
  assert.equal(cubeView.metadata.uv_before,cube.source.uvSha256);
  assert.equal(cubeView.metadata.vertex_count,24);
  const templates=await Promise.all(['cube','plane','sphere','cylinder'].map(modelTemplate=>
    api('/api/projects',{workflowType:'pbr_paint',modelTemplate})));
  assert.notEqual(templates[0].id,cube.id);
  assert.deepEqual(templates[0].source,cube.source);
  assert.equal(new Set(templates.map(item=>item.source.uvSha256)).size,4);

  await reopened.locator('[data-area-mode=modeling]').click();
  const cubeEditor=reopened.locator('.editor-area[data-editor=viewport]').first();
  const cubeViewport=cubeEditor.locator('.editor-viewport[data-state=ready]');
  await cubeViewport.waitFor();
  const cubeCanvas=cubeViewport.locator('canvas').first();
  await cubeCanvas.click();
  await cubeEditor.getByRole('button',{name:'交互模式',exact:true}).click();
  await reopened.getByRole('option',{name:'编辑模式',exact:true}).click();
  await cubeEditor.getByRole('button',{name:'选择类型',exact:true}).click();
  await reopened.getByRole('option',{name:'面',exact:true}).click();
  const selectionStatus=cubeEditor.locator('.editor-message');
  await selectionStatus.filter({hasText:'已选 0 面'}).waitFor();
  await cubeCanvas.click();
  await selectionStatus.filter({hasText:'已选 1 面'}).waitFor();
  await cubeEditor.getByRole('button',{name:'建模选择',exact:true}).click();
  await reopened.getByRole('menuitem',{name:'选择关联',exact:true}).click();
  await selectionStatus.filter({hasText:'已选 6 面'}).waitFor();
  await reopened.keyboard.press('Control+i');
  await selectionStatus.filter({hasText:'已选 0 面'}).waitFor();
  await cubeCanvas.hover();
  await reopened.keyboard.press('l');
  await selectionStatus.filter({hasText:'已选 6 面'}).waitFor();
  await reopened.keyboard.press('Shift+l');
  await selectionStatus.filter({hasText:'已选 0 面'}).waitFor();
  await cubeCanvas.click();
  await selectionStatus.filter({hasText:'已选 1 面'}).waitFor();
  await cubeEditor.getByLabel('变换 Z',{exact:true}).fill('0.15');
  await cubeEditor.getByRole('button',{name:'应用',exact:true}).click();
  const cubeEdited=await until(async()=>{const doc=await api(cubeRoute);return doc.modeling?.steps.length&&doc;});
  assert.equal(cubeEdited.modeling.steps[0].targets[0].vertices.length,12);
  assert.equal(cubeEdited.modeling.nativeSteps[0].targets[0].vertices.length,4);
  assert.equal(cubeEdited.source.uvSha256,cube.source.uvSha256);
  console.log('PASS connected and inverse face selection, hover shortcuts and seam-safe movement across split vertices');

  // The server can already expose the new revision while the editing viewport
  // is still applying it and ignores selection shortcuts.
  await until(()=>cubeEditor.getByRole('button',{name:'建模选择',exact:true}).isEnabled());
  await cubeCanvas.press('a');
  await selectionStatus.filter({hasText:'已选 6 面'}).waitFor();
  const smoothDialog=reopened.getByRole('dialog',{name:'平滑顶点',exact:true});
  async function openSmooth(){
    await cubeEditor.getByRole('button',{name:'网格',exact:true}).click();
    await reopened.getByRole('menuitem',{name:'平滑顶点…',exact:true}).click();
    await smoothDialog.waitFor();
  }
  await openSmooth();
  await reopened.keyboard.press('Escape');
  await smoothDialog.waitFor({state:'hidden'});
  assert.deepEqual((await api(cubeRoute)).modeling,cubeEdited.modeling);
  await openSmooth();
  await smoothDialog.getByRole('spinbutton',{name:'平滑系数'}).fill('0.2');
  await smoothDialog.getByRole('spinbutton',{name:'重复次数'}).fill('2');
  await smoothDialog.getByRole('checkbox',{name:'Y',exact:true}).uncheck();
  await smoothDialog.getByRole('checkbox',{name:'Z',exact:true}).uncheck();
  await reopened.screenshot({path:path.join(data,'model-smoothing.png')});
  await smoothDialog.getByRole('button',{name:'应用平滑',exact:true}).click();
  await smoothDialog.waitFor({state:'hidden'});
  const smoothed=await api(cubeRoute),deformation=smoothed.modeling.steps.at(-1);
  assert.equal(smoothed.modeling.version,2);
  assert.equal(deformation.type,'vertexPositions');
  assert.equal(deformation.targets[0].vertices.length,24);
  assert.equal(smoothed.modeling.nativeSteps.at(-1).targets[0].vertices.length,8);
  assert.equal(smoothed.source.uvSha256,cube.source.uvSha256);
  await reopened.keyboard.press('Control+z');
  await until(async()=> (await api(cubeRoute)).modeling.steps.length===1);
  await reopened.keyboard.press('Control+Shift+z');
  await until(async()=> (await api(cubeRoute)).modeling.steps.length===2);
  await reopened.reload();
  await cubeViewport.waitFor({timeout:30000});
  assert.deepEqual((await api(cubeRoute)).modeling,smoothed.modeling);
  console.log('PASS mesh smoothing dialog, seam-safe positions, cancellation, undo, redo and project reopen');

  await reopened.locator('[data-area-mode=drawing]').click();
  const drawing=reopened.locator('.editor-area[data-editor=image]').first();
  await drawing.getByRole('button',{name:'新建图像',exact:true}).click();
  await reopened.getByRole('dialog',{name:'新建图像'}).getByRole('button',{name:'创建',exact:true}).click();
  const documentCanvas=drawing.locator('canvas[aria-label="图像文档画布"]');
  await documentCanvas.waitFor();
  await drawing.getByRole('button',{name:'渐变工具',exact:true}).click();
  await drawing.getByRole('button',{name:'渐变颜色',exact:true}).click();
  await reopened.getByRole('option',{name:'前景色到透明',exact:true}).click();
  const ink=drawing.getByLabel('图像前景色',{exact:true});
  await ink.click();
  const colorPicker=reopened.getByRole('dialog',{name:'图像前景色选色',exact:true});
  const hexField=colorPicker.getByRole('textbox',{name:'HEX 颜色',exact:true});
  await hexField.fill('#d97732');
  await hexField.press('Enter');
  assert.equal(await ink.inputValue(),'#d97732');
  await ink.click();
  await colorPicker.getByRole('button',{name:'使用 #D97732',exact:true}).waitFor();
  await colorPicker.locator('.paint-color-sv').click({position:{x:40,y:55}});
  assert.notEqual(await hexField.inputValue(),'#d97732');
  await colorPicker.screenshot({path:path.join(data,'color-picker.png')});
  await reopened.keyboard.press('Escape');
  await colorPicker.waitFor({state:'hidden'});
  assert.equal(await ink.inputValue(),'#d97732');
  const box=await documentCanvas.boundingBox(),point=(x,y)=>[box.x+x*box.width,box.y+y*box.height];
  const {mouse,keyboard}=reopened;
  const beforeGradient=await api(cubeRoute);
  await mouse.move(...point(.22,.5));await mouse.down();
  await mouse.move(...point(.68,.5),{steps:8});
  await keyboard.press('Escape');await mouse.up();
  assert.deepEqual(await api(cubeRoute),beforeGradient);
  await mouse.move(...point(.22,.5));await mouse.down();
  await keyboard.down('Shift');
  await mouse.move(...point(.68,.54),{steps:8});
  await mouse.up();await keyboard.up('Shift');
  const ramp=async()=>Object.values((await api(cubeRoute)).paint.imageDocuments)[0].layers.find(layer=>layer.kind==='gradient');
  const gradient=await until(ramp);
  assert.equal(gradient.gradient.kind,'linear');
  assert.ok(Math.abs(gradient.gradient.start[1]-gradient.gradient.end[1])<.0001);
  assert.deepEqual(gradient.gradient.colors,['#d97732','#d97732']);
  assert.deepEqual(gradient.gradient.alpha,[1,0]);
  await drawing.getByRole('button',{name:'渐变形状',exact:true}).click();
  await reopened.getByRole('option',{name:'径向',exact:true}).click();
  await until(async()=>(await ramp()).gradient.kind==='radial');
  await drawing.getByRole('button',{name:'渐变形状',exact:true}).and(drawing.locator('button:enabled')).waitFor();
  await drawing.locator('[data-gradient-handle=end]').hover();
  const radialBox=await documentCanvas.boundingBox();
  await mouse.down();
  await drawing.locator('[data-gradient-dragging]').waitFor({timeout:3000});
  await mouse.move(radialBox.x+radialBox.width*.78,radialBox.y+radialBox.height*.5,{steps:6});await mouse.up();
  const changed=await until(async()=>{const layer=await ramp();return layer.gradient.end[0]>.75&&layer;});
  assert.equal(changed.id,gradient.id);
  assert.deepEqual(changed.gradient.start,gradient.gradient.start);
  await drawing.getByRole('button',{name:'应用至材质',exact:true}).click();
  const cubePainted=await until(async()=>{
    const state=await api(cubeRoute);
    return state.paint.layers.some(layer=>layer.documentMaps?.color)&&state;
  });
  const imageId=cubePainted.paint.layers.find(layer=>layer.documentMaps?.color).documentMaps.color;
  await reopened.reload();
  await reopened.locator('[data-area-mode=drawing]').click();
  await drawing.getByRole('button',{name:'渐变工具',exact:true}).waitFor();
  assert.deepEqual(await ramp(),changed);
  const imageResponse=await fetch(origin+cubeRoute+'/paint/image-export',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({revision:cubePainted.revision,documentId:imageId})
  });
  assert.equal(imageResponse.status,200);
  const gradientPng=path.join(data,'gradient.png');
  await fs.writeFile(gradientPng,Buffer.from(await imageResponse.arrayBuffer()));
  execFileSync(pythonExecutable(),['-c',[
    'import sys',
    'from PIL import Image',
    'with Image.open(sys.argv[1]) as im:',
    ' assert im.size==(4096,4096)',
    ' assert im.getpixel((901,2048))[:3]==(217,119,50)',
    ' assert im.getpixel((901,2048))[3]>250',
    ' assert im.getpixel((4095,4095))[3]==0'
  ].join('\n'),gradientPng],{stdio:'inherit'});
  await reopened.screenshot({path:path.join(data,'gradient-editor.png')});

  const imageLayers=reopened.locator('.editor-area[data-editor=imageLayers]').first();
  await imageLayers.getByRole('button',{name:'渐变填充',exact:true}).click();
  await imageLayers.getByRole('button',{name:'添加蒙版',exact:true}).click();
  const maskThumb=imageLayers.getByRole('button',{name:'选择蒙版 渐变填充',exact:true});
  await maskThumb.and(imageLayers.locator('[aria-pressed=true]')).waitFor();
  await ink.click();
  await colorPicker.getByRole('slider',{name:'灰度',exact:true}).waitFor();
  await colorPicker.getByRole('slider',{name:'色相',exact:true}).waitFor({state:'hidden'});
  await colorPicker.getByRole('button',{name:'取消',exact:true}).click();
  await drawing.getByRole('button',{name:'渐变工具',exact:true}).click();
  const shapeOption=drawing.getByRole('button',{name:'渐变形状',exact:true});
  await shapeOption.click();
  await reopened.getByRole('option',{name:'线性',exact:true}).click();
  await drawing.getByRole('button',{name:'渐变颜色',exact:true}).click();
  await reopened.getByRole('option',{name:'前景色到背景色',exact:true}).click();
  const maskBox=await documentCanvas.boundingBox(),maskPoint=(x,y)=>[maskBox.x+x*maskBox.width,maskBox.y+y*maskBox.height];
  await mouse.move(...maskPoint(.3,.30));await mouse.down();
  await mouse.move(...maskPoint(.3,.56),{steps:8});await mouse.up();
  const masked=await until(async()=>{const layer=await ramp();return layer.maskGradient&&layer;});
  assert.deepEqual(masked.gradient,changed.gradient);
  assert.deepEqual(masked.maskGradient.colors,['#000000','#ffffff']);
  await drawing.getByRole('button',{name:'画笔',exact:true}).click();
  await mouse.move(...maskPoint(.26,.62));await mouse.down();
  await mouse.move(...maskPoint(.34,.62),{steps:4});await mouse.up();
  const brushed=await until(async()=>{const layer=await ramp();return layer.maskStrokes?.length===1&&layer;});
  assert.deepEqual(brushed.maskGradient,masked.maskGradient);
  const brushAvailable=drawing.getByRole('button',{name:'画笔',exact:true}).and(drawing.locator('button:enabled'));
  await documentCanvas.focus();await keyboard.press('Control+i');
  await until(async()=>(await ramp()).maskGradient.colors[0]==='#ffffff');
  await brushAvailable.waitFor();
  await documentCanvas.focus();await keyboard.press('Control+z');
  await until(async()=>(await ramp()).maskGradient.colors[0]==='#000000');
  assert.deepEqual(await ramp(),brushed);
  const maskedDoc=await api(cubeRoute),maskedImage=await fetch(origin+cubeRoute+'/paint/image-export',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({revision:maskedDoc.revision,documentId:imageId})
  });
  assert.equal(maskedImage.status,200);
  const maskedPng=path.join(data,'gradient-mask.png');
  await fs.writeFile(maskedPng,Buffer.from(await maskedImage.arrayBuffer()));
  execFileSync(pythonExecutable(),['-c',[
    'import sys',
    'from PIL import Image',
    'with Image.open(sys.argv[1]) as im:',
    ' assert im.size==(4096,4096)',
    ' assert im.getpixel((1228,1024))[3]==0',
    ' assert im.getpixel((1228,2458))[3]>160',
    ' assert im.getpixel((1228,2540))[3]==0'
  ].join('\n'),maskedPng],{stdio:'inherit'});
  const cubePreview=await api(cubeRoute+'/paint/preview',{revision:maskedDoc.revision,requestId:'cube-template-4k'});
  const cubeBake=await until(async()=>{
    const job=await api(cubeRoute+'/jobs/'+cubePreview.id);
    if(job.status==='failed')throw Error(job.error);
    return job.status==='completed'&&job;
  });
  assert.equal(cubeBake.paintReport.uv_unchanged,true);
  assert.equal(Object.keys(cubeBake.paintReport.files).length,8);
  assert.equal(cubeBake.paintReport.modelFingerprint,(await api(cubeRoute+'/paint/model-state')).fingerprint);
  const cubePaint=cubeRoute+'/paint';
  const shots=[
    {id:'top',name:'顶视验收',optics:'source',lighting:{...renderLightingDefaults,preset:'daylight',environmentColor:'#ecce90'},
      camera:{projection:'orthographic',eye:[0,5,0],target:[0,0,0],up:[0,0,-1],fov:38,orthoHeight:3.2}},
    {id:'perspective',name:'透视验收',optics:{...renderOpticsDefaults,focusMode:'distance',focusDistance:5.4,fStop:1.8},camera:{projection:'perspective',eye:[3,2,3],target:[0,0,0],up:[0,1,0],fov:38,orthoHeight:4}}
  ];
  const batchDoc=await api(cubePaint+'/commands',{revision:maskedDoc.revision,operations:[
    ...shots.map(({id,...patch})=>({op:'renderBookmark',action:'add',id,patch})),
    {op:'renderOptics',optics:{...renderOpticsDefaults,fStop:5.6}},
    {op:'renderPreset',preset:captureRenderPreset(updateDeliveryOptions({},{width:192,height:144,samples:3,maxBounces:3}))}
  ]});
  const badBatch=await fetch(origin+cubePaint+'/render-batch',{method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({
      revision:batchDoc.revision,requestId:'invalid-batch',bookmarkIds:['top','missing'],settings:{width:192,height:144,samples:3}
    })
  });
  assert.equal(badBatch.status,400);
  assert.ok((await api(cubeRoute+'/jobs')).every(job=>!job.renderBookmark));
  await reopened.reload();
  const renderMenu=reopened.getByText('渲染',{exact:true}).filter({visible:true}).first();
  await renderMenu.click();
  await reopened.locator('#open-render-batch').click();
  const batchDialog=reopened.getByRole('dialog',{name:'相机批量出图'});
  await batchDialog.getByText('192 × 144 · PNG', {exact:false}).waitFor();
  const allCameras=batchDialog.getByRole('checkbox',{name:'全选相机书签'});
  await allCameras.uncheck();
  assert.equal(await batchDialog.getByRole('button',{name:'加入队列',exact:true}).isDisabled(),true);
  await batchDialog.getByRole('checkbox',{name:'顶视验收',exact:true}).check();
  await batchDialog.getByRole('checkbox',{name:'透视验收',exact:true}).check();
  const [batchResponse]=await Promise.all([
    reopened.waitForResponse(response=>response.url().endsWith('/render-batch')),
    batchDialog.getByRole('button',{name:'加入队列 · 2',exact:true}).click()
  ]);
  assert.equal(batchResponse.status(),202);
  const batchRequest=batchResponse.request().postDataJSON(),queued=(await batchResponse.json()).jobs;
  assert.deepEqual(queued.map(job=>job.renderBookmark.name),shots.map(shot=>shot.name));
  assert.deepEqual((await api(cubePaint+'/render-batch',batchRequest)).jobs.map(job=>job.id),queued.map(job=>job.id));
  const batchMonitor=reopened.locator('#task-monitor');
  await batchMonitor.getByRole('button',{name:/顶视验收/}).waitFor();
  await batchMonitor.getByRole('button',{name:/透视验收/}).waitFor();
  await api(cubePaint+'/commands',{revision:batchDoc.revision,operations:[{op:'base',patch:{color:'#223355'}}]});
  const outputs=await Promise.all(queued.map(item=>until(async()=>{
    const job=await api(cubeRoute+'/jobs/'+item.id);
    if(job.status==='failed')throw Error(job.error);
    return job.status==='completed'&&job;
  })));
  assert.notEqual(outputs[0].render.pngSha256,outputs[1].render.pngSha256);
  for(const [index,job] of outputs.entries()){
    assert.deepEqual(job.render.resolution,[192,144]);
    assert.deepEqual(job.render.camera,shots[index].camera);
    assert.deepEqual(job.render.lighting,shots[index].lighting??batchDoc.paint.renderLighting??null);
    assert.deepEqual(job.render.optics,shots[index].optics==='source'?null:shots[index].optics);
    assert.deepEqual(job.render.cameraBookmark,{id:shots[index].id,name:shots[index].name});
    assert.equal(job.render.revision,batchDoc.revision);
    assert.deepEqual(job.paintReport.files,cubeBake.paintReport.files);
  }
  await batchMonitor.getByRole('button',{name:/透视验收/}).click();
  const shotDownload=batchMonitor.locator('#task-monitor-download');
  await shotDownload.waitFor();
  assert.match(await shotDownload.getAttribute('download'),/透视验收.*\.png$/);
  console.log('PASS two-camera batch render, request retry without duplicates, frozen revision and named output files');
  await batchMonitor.getByRole('button',{name:'关闭',exact:true}).click();
  const beforeLens=await api(cubeRoute);
  const optics={...renderOpticsDefaults,focusMode:'distance',focusDistance:4,fStop:2.1,blades:5};
  const lensDoc=await api(cubePaint+'/commands',{revision:beforeLens.revision,operations:[
    {op:'renderCamera',camera:shots[1].camera},{op:'renderOptics',optics}
  ]});
  await reopened.reload();
  await reopened.locator('[data-area-mode=modeling]').click();
  const renderSide=reopened.locator('.editor-area[data-editor=renderSettings]').first();
  await renderSide.getByRole('tab',{name:'输出属性',exact:true}).click();
  await renderSide.getByRole('button',{name:'查看相机',exact:true}).click();
  await reopened.getByRole('button',{name:'渲染预览',exact:true}).first().click();
  const depthOfField=reopened.locator('.editor-viewport[data-render-depth-of-field][data-render-phase=ready]').first();
  await depthOfField.waitFor({timeout:90000});
  await depthOfField.screenshot({path:path.join(data,'camera-depth-of-field.png')});
  await api(cubePaint+'/commands',{revision:lensDoc.revision,operations:[{op:'renderOptics',optics:{...optics,enabled:false}}]});
  await depthOfField.waitFor({state:'hidden',timeout:30000});
  await reopened.locator('.editor-viewport[data-render-phase=ready]:not([data-render-depth-of-field])').first().waitFor({timeout:90000});
  console.log('PASS project camera depth of field in progressive viewport and live disable');
  console.log('PASS four native geometry templates, distinct UVs, independent projects and cube 4K bake');
  console.log('PASS gradient draw, cancel, angle snapping, endpoint editing, material binding, reload and 4K RGBA PNG');
  console.log('PASS editable gradient mask, brush touch-up, inversion, undo and verified 4K alpha');

  const {texturedFile,differentUV}=prepareTexturedModel();
  await verifyOriginalTextureChannels(texturedFile);
  async function chooseTextured(file){
    await reopened.getByText('文件',{exact:true}).filter({visible:true}).first().click();
    await reopened.locator('#new').click();
    const dialog=reopened.locator('#new-paint-dialog');
    await dialog.locator('#new-paint-model').setInputFiles(file);
    await dialog.getByLabel('保留源贴图').waitFor();
    assert.equal(await dialog.getByLabel('保留源贴图').isChecked(),true);
    return dialog;
  }
  const alternateDialog=await chooseTextured(differentUV);
  await alternateDialog.locator('#new-paint-submit').click();
  await alternateDialog.getByText(/源贴图使用其他 UV 通道/).waitFor();
  await alternateDialog.getByLabel('保留源贴图').uncheck();
  await alternateDialog.locator('#new-paint-submit').click();
  await alternateDialog.waitFor({state:'hidden'});
  const blankId=new URL(reopened.url()).searchParams.get('project');
  assert.deepEqual((await api('/api/projects/'+blankId)).paint.layers,[]);
  const texturedDialog=await chooseTextured(texturedFile);
  await texturedDialog.locator('#new-paint-submit').click();
  await texturedDialog.waitFor({state:'hidden'});
  const texturedId=new URL(reopened.url()).searchParams.get('project');
  const texturedRoute='/api/projects/'+texturedId,texturedPaint=texturedRoute+'/paint';
  const textured=await api(texturedRoute),sourceLayer=textured.paint.layers[0];
  assert.equal(sourceLayer.name,'源材质贴图');
  assert.deepEqual(Object.keys(sourceLayer.maps).sort(),['alpha','ao','color','emission','metallic','normal','roughness']);
  const fileFor=channel=>path.join(clean,'projects',texturedId,'assets',textured.paint.assets[sourceLayer.maps[channel]].file);
  const pixels=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import json,sys',
    'from PIL import Image',
    'print(json.dumps([Image.open(name).getpixel((0,0)) for name in sys.argv[1:]]))',
  ].join('\n'),...['color','metallic','roughness','alpha','ao','emission'].map(fileFor)],{encoding:'utf8'}));
  assert.deepEqual(pixels,[[188,0,0],30,40,64,136,[137,0,0]]);
  await reopened.locator('[data-area-mode=material]').click();
  await reopened.getByRole('button',{name:'源材质贴图',exact:true}).waitFor();
  await reopened.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  await reopened.screenshot({path:path.join(data,'imported-source-material.png')});
  async function texturedJob(queued){
    return until(async()=>{
      const result=await api(texturedRoute+'/jobs/'+queued.id);
      if(result.status==='failed')throw Error(result.error);
      return result.status==='completed'&&result;
    });
  }
  async function restorePortable(url,kind){
    const zip=Buffer.from(await (await fetch(origin+url)).arrayBuffer());
    const file=path.join(data,kind+'.zip');
    await fs.writeFile(file,zip);
    execFileSync(pythonExecutable(),['-X','utf8','-c',[
      'import hashlib,json,sys,zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as z:',
      ' report=json.loads(z.read("project-report.json"))',
      ' assert report["registration"]["uvSha256"]==sys.argv[2]',
      ' assert set(report["registration"]["files"])=={"registration/"+name for name in ("model.glb","base.png","metadata.json","registration.json")}',
      ' assert ("bake" in report)==(sys.argv[3]=="portable-textures")',
      ' assert "render.png" not in z.namelist()',
      ' for member,expected in report["fileSha256"].items():',
      '  assert hashlib.sha256(z.read(member)).hexdigest()==expected',
    ].join('\n'),file,textured.source.uvSha256,kind]);
    const destination=await start(path.join(data,kind));
    assert.deepEqual(await (await fetch(destination+'/api/projects')).json(),[]);
    const response=await fetch(destination+'/api/projects/paint-import',{
      method:'POST',headers:{'Content-Type':'application/zip'},body:zip
    });
    const imported=await response.json();
    assert.equal(response.status,201,JSON.stringify(imported));
    assert.deepEqual(imported.paint,textured.paint);
    assert.equal(imported.source.uvSha256,textured.source.uvSha256);
    assert.equal(imported.source.files[imported.source.reviewSource],textured.source.files[textured.source.reviewSource]);
    return {destination,imported};
  }
  const backup=await texturedJob(await api(texturedPaint+'/backup',{revision:0,requestId:'portable-backup'}));
  assert.equal(backup.portable,true);
  const portable=await restorePortable(backup.archiveUrl,'portable-backup');
  const portableView=await browser.newPage();
  await portableView.goto(portable.destination+'/?project='+portable.imported.id);
  await portableView.locator('[data-area-mode=material]').click();
  await portableView.getByRole('button',{name:'源材质贴图',exact:true}).waitFor();
  await portableView.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  await portableView.close();
  const sourcePreview=await api(texturedPaint+'/preview',{revision:0,requestId:'source-maps'});
  const bakedSource=await texturedJob(sourcePreview);
  assert.deepEqual(bakedSource.paintReport.resolution,[4096,4096]);
  assert.equal(bakedSource.paintReport.uv_unchanged,true);
  const bakedFiles=['color','alpha'].map(channel=>path.join(data,'source-bake-'+channel+'.png'));
  for(const [index,url] of [bakedSource.colorUrl,bakedSource.materialUrls.alpha].entries())
    await fs.writeFile(bakedFiles[index],Buffer.from(await (await fetch(origin+url)).arrayBuffer()));
  const corners=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import json,sys',
    'from PIL import Image',
    'print(json.dumps([[Image.open(file).getpixel(pos) for pos in ((0,0),(4095,4095))] for file in sys.argv[1:]]))',
  ].join('\n'),...bakedFiles],{encoding:'utf8'}));
  assert.deepEqual(corners,[[[188,0,0],[188,137,255]],[64,0]]);
  const texturePackage=await texturedJob(await api(texturedPaint+'/export-textures',{
    revision:0,previewId:bakedSource.id,confirmed:true,texturePreset:'unity-hdrp',requestId:'portable-textures'
  }));
  assert.equal(texturePackage.portable,true);
  assert.equal(texturePackage.texturePreset,'unity-hdrp');
  const reusedRequest=await fetch(origin+texturedPaint+'/export-textures',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({
      revision:0,previewId:bakedSource.id,confirmed:true,texturePreset:'unreal-orm',requestId:'portable-textures'
    })
  });
  assert.equal(reusedRequest.status,400);
  assert.match((await reusedRequest.json()).error,/其他贴图输出预设/);
  await restorePortable(texturePackage.packageUrl,'portable-textures');
  execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import hashlib,io,json,sys,zipfile',
    'from PIL import Image',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' r=json.loads(z.read("project-report.json"))',
    ' data=z.read("presets/unity-hdrp/MaskMap.png")',
    ' assert r["textureOutput"]["preset"]=="unity-hdrp"',
    ' assert hashlib.sha256(data).hexdigest()==r["textureOutput"]["files"]["presets/unity-hdrp/MaskMap.png"]["sha256"]',
    ' def raw(key): return Image.open(io.BytesIO(z.read("textures/f_16xl_"+key+".png"))).getpixel((0,0))',
    ' mask=Image.open(io.BytesIO(data))',
    ' assert mask.mode=="RGBA" and mask.size==(4096,4096) and mask.info["gamma"]==1',
    ' assert mask.getpixel((0,0))==(raw("metallic"),raw("ao"),0,255-raw("roughness"))',
    ' assert z.read("presets/unity-hdrp/Normal_OpenGL.png")==z.read("textures/f_16xl_normal.png")'
  ].join('\n'),path.join(data,'portable-textures.zip')],{cwd:root});
  console.log('PASS Unreal ORM and Unity HDRP packed exports, linear channels, normal conventions, alpha, SHA-256 and independent restore');
  console.log('PASS editable backup without bake and texture ZIP restore in separate empty profiles, with hashes and native UV');
  await api(texturedPaint+'/commands',{revision:0,operations:[{op:'update',id:sourceLayer.id,patch:{visible:false}}]});
  await api(texturedPaint+'/undo',{revision:1});
  await reopened.reload();
  assert.deepEqual((await api(texturedRoute)).paint.layers,[sourceLayer]);
  console.log('PASS GLB source maps, sRGB factors, transformed ORM, cutout alpha, unsupported UV feedback, 4K bake and layer undo');
  const details=await api(texturedPaint+'/commands',{revision:2,operations:[{op:'add',kind:'fill',patch:{
    name:'粗糙和法线细节',channels:{color:false,metallic:false,roughness:true,normal:true},
    values:{color:'#000000',metallic:0,roughness:.4,normal:'#80b8ef'}
  }}]});
  const detail=details.paint.layers.at(-1);
  await reopened.locator('[data-area-mode=material]').click();
  await reopened.getByRole('button',{name:detail.name,exact:true}).click();
  const stackChannel=reopened.getByRole('button',{name:'图层栈通道',exact:true});
  const blendMode=reopened.getByRole('button',{name:'图层混合模式',exact:true});
  await stackChannel.click();
  await reopened.getByRole('option',{name:'粗糙度',exact:true}).click();
  await blendMode.click();
  await reopened.getByRole('option',{name:'正片叠底',exact:true}).click();
  await until(async()=>(await api(texturedRoute)).paint.layers.at(-1).channelBlend?.roughness==='multiply');
  const opacity=reopened.locator('#drawing-layer-opacity');
  await opacity.fill('50');
  await opacity.press('Tab');
  await until(async()=>(await api(texturedRoute)).paint.layers.at(-1).channelOpacity?.roughness===.5);
  await stackChannel.click();
  await reopened.getByRole('option',{name:'法线',exact:true}).click();
  await blendMode.click();
  assert.equal(await reopened.getByRole('option',{name:'正片叠底',exact:true}).count(),0);
  await reopened.getByRole('option',{name:'叠加法线细节',exact:true}).click();
  const mixed=await until(async()=>{
    const current=await api(texturedRoute);
    return current.paint.layers.at(-1).channelBlend?.normal==='normalCombine'&&current;
  });
  assert.equal(mixed.paint.layers.at(-1).opacity,1);
  assert.equal(mixed.paint.layers.at(-1).blend,'normal');
  const invalidBlend=await fetch(origin+texturedPaint+'/commands',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({revision:mixed.revision,operations:[{op:'update',id:detail.id,patch:{channelBlend:{normal:'multiply'}}}]})
  });
  assert.equal(invalidBlend.status,400);
  await reopened.screenshot({path:path.join(data,'material-channel-blending.png')});
  const mixBake=await texturedJob(await api(texturedPaint+'/preview',{revision:mixed.revision,requestId:'channel-blending'}));
  const mixedMaps=['roughness','normal'].map(channel=>path.join(data,'mixed-'+channel+'.png'));
  for(const [index,channel] of ['roughness','normal'].entries())
    await fs.writeFile(mixedMaps[index],Buffer.from(await (await fetch(origin+mixBake.materialUrls[channel])).arrayBuffer()));
  const [rough,normal]=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',
    'import json,sys;from PIL import Image;print(json.dumps([Image.open(f).getpixel((0,0)) for f in sys.argv[1:]]))',
    ...mixedMaps],{encoding:'utf8'}));
  assert.equal(rough,28);
  assert.ok(normal[0]>151&&normal[1]>165&&normal[2]>215);
  await api(texturedPaint+'/undo',{revision:mixed.revision});
  assert.deepEqual((await api(texturedRoute)).paint.layers.at(-1).channelBlend,{roughness:'multiply'});
  console.log('PASS per-channel material opacity, linear roughness blending, normal detail, guarded inputs and undo');

  const sidecarFolder=path.join(data,'glTF 配套 文件');
  await fs.mkdir(sidecarFolder);
  const sidecarModel=path.join(sidecarFolder,'机翼 外部贴图.gltf');
  const bufferName='顶点 数据.bin',uvName='UV 数据.bin',imageName='涂装 色彩.png';
  const sidecarPaths=[bufferName,uvName,imageName].map(name=>path.join(sidecarFolder,name));
  const texturedBytes=await fs.readFile(texturedFile),texturedJsonLength=texturedBytes.readUInt32LE(12);
  const sidecarScene=JSON.parse(texturedBytes.subarray(20,20+texturedJsonLength).toString());
  const texturedBin=texturedBytes.subarray(28+texturedJsonLength);
  const originalDataLength=sidecarScene.buffers[0].byteLength,vertexLength=sidecarScene.bufferViews[0].byteLength;
  const colorImage=sidecarScene.images[0],colorView=sidecarScene.bufferViews[colorImage.bufferView];
  await Promise.all([
    fs.writeFile(sidecarPaths[0],texturedBin.subarray(0,vertexLength)),
    fs.writeFile(sidecarPaths[1],texturedBin.subarray(vertexLength,originalDataLength)),
    fs.writeFile(sidecarPaths[2],texturedBin.subarray(colorView.byteOffset,colorView.byteOffset+colorView.byteLength))
  ]);
  sidecarScene.buffers=[{byteLength:vertexLength,uri:encodeURIComponent(bufferName)},
    {byteLength:originalDataLength-vertexLength,uri:'data/'+encodeURIComponent(uvName)}];
  for(const view of sidecarScene.bufferViews.slice(1)){
    view.buffer=1;
    view.byteOffset-=vertexLength;
  }
  delete colorImage.bufferView;
  colorImage.uri='images/'+encodeURIComponent(imageName);
  await fs.writeFile(sidecarModel,JSON.stringify(sidecarScene));
  const droppedGltf=await reopened.evaluateHandle(({name,bytes})=>{
    const transfer=new DataTransfer();
    transfer.items.add(new File([bytes],name,{type:'model/gltf+json'}));
    return transfer;
  },{name:path.basename(sidecarModel),bytes:JSON.stringify(sidecarScene)});
  await reopened.locator('.editor-viewport').first().dispatchEvent('drop',{dataTransfer:droppedGltf});
  await droppedGltf.dispose();
  const gltfDialog=reopened.locator('#new-paint-dialog');
  const gltfInput=gltfDialog.locator('#new-paint-model');
  await gltfDialog.getByText('缺少 glTF 配套文件：'+bufferName).waitFor();
  assert.equal(await gltfDialog.getByRole('button',{name:'添加文件…',exact:true}).isVisible(),true);
  await gltfInput.setInputFiles(sidecarPaths.slice(0,2));
  await gltfDialog.getByText('缺少 glTF 配套文件：'+imageName).waitFor();
  assert.equal(await gltfDialog.locator('#new-paint-submit').isDisabled(),true);
  await gltfInput.setInputFiles(sidecarPaths[2]);
  await gltfDialog.getByText('机翼 外部贴图.gltf',{exact:true}).waitFor();
  await until(()=>gltfDialog.locator('#new-paint-submit').isEnabled());
  await reopened.screenshot({path:path.join(data,'gltf-model-import.png')});
  await gltfDialog.locator('#new-paint-submit').click();
  await gltfDialog.waitFor({state:'hidden',timeout:90000});
  const gltfId=new URL(reopened.url()).searchParams.get('project');
  const gltfRoute='/api/projects/'+gltfId,sidecarProject=await api(gltfRoute);
  assert.equal(sidecarProject.source.uvSha256,textured.source.uvSha256);
  for(const [channel,asset] of Object.entries(sourceLayer.maps)){
    const imported=sidecarProject.paint.layers[0].maps[channel];
    assert.equal(sidecarProject.paint.assets[imported].sha256,textured.paint.assets[asset].sha256);
  }
  await fs.rm(sidecarFolder,{recursive:true});
  await reopened.reload();
  const gltfBake=await api(gltfRoute+'/paint/preview',{revision:0,requestId:'separate-gltf'});
  const gltfResult=await until(async()=>{
    const job=await api(gltfRoute+'/jobs/'+gltfBake.id);
    if(job.status==='failed')throw Error(job.error);
    return job.status==='completed'&&job;
  });
  assert.deepEqual(Object.keys(gltfResult.materialUrls).sort(),Object.keys(bakedSource.materialUrls).sort());
  for(const [channel,url] of Object.entries(gltfResult.materialUrls)){
    const [a,b]=await Promise.all([url,bakedSource.materialUrls[channel]].map(source=>fetch(origin+source).then(response=>response.arrayBuffer())));
    assert.equal(digest(Buffer.from(a)),digest(Buffer.from(b)));
  }
  console.log('PASS glTF with multiple buffers, escaped Chinese sidecar paths, missing-file feedback and matching UV and 4K maps after source removal');

  const objFiles=path.join(data,'OBJ 测试 文件');
  await fs.mkdir(objFiles);
  const objFile=path.join(objFiles,'凹形机翼.obj'),mtlFile=path.join(objFiles,'表面 材质.mtl');
  const objColor=path.join(objFiles,'表面 # 色彩.png'),objRoughness=path.join(objFiles,'粗糙度 图.png');
  await fs.writeFile(objFile,[
    'mtllib 表面 材质.mtl','o 外壳#凹形机翼 # 物体注释','s 1',
    'v -1 -1 0 # 顶点注释','v 1 -1 0','v 1 1 0','v 0 0 0','v -1 1 0',
    'vt 0 0','vt 1 0','vt 1 1','vt .5 .5','vt 0 1',
    'usemtl 机翼#表面 # 材质注释','f -5/-5 -4/-4 -3/-3 -2/-2 -1/-1 # 面注释',
    'o 支架','usemtl 支架材料','v -1 -1 -1','v 1 -1 -1','v 0 0 -1',
    'f -3/1 -2/2 -1/4',''
  ].join('\n'));
  await fs.writeFile(mtlFile,[
    'newmtl 机翼#表面 # 材质注释','Kd 1 1 1','map_Kd "表面 # 色彩.png" # 贴图注释','map_Pr 粗糙度 图.png',
    'newmtl 支架材料','Kd .2 .3 .4','Pr .65',''
  ].join('\n'));
  execFileSync(pythonExecutable(),['-X','utf8','-c',[
    'import sys',
    'from PIL import Image',
    'image = Image.new("RGBA",(2,2))',
    'image.putdata([(192,32,10,255),(192,32,10,255),(12,36,128,64),(12,36,128,64)])',
    'image.save(sys.argv[1]); Image.new("L",(2,2),90).save(sys.argv[2])'
  ].join('\n'),objColor,objRoughness]);
  const countBeforeObj=(await api('/api/projects')).length;
  const objDialog=await chooseTextured(objFile);
  await objDialog.locator('#new-paint-submit').click();
  await objDialog.getByText(/缺少 MTL/).waitFor();
  assert.equal((await api('/api/projects')).length,countBeforeObj);
  await objDialog.locator('#new-paint-model').setInputFiles([objFile,mtlFile,objColor,objRoughness]);
  await objDialog.getByText(/3 个配套文件/).waitFor();
  await objDialog.getByRole('button',{name:'向上轴',exact:true}).click();
  await objDialog.getByRole('option',{name:'Z 向上',exact:true}).click();
  await objDialog.getByRole('button',{name:'涂装材质',exact:true}).click();
  await objDialog.getByRole('option',{name:'机翼#表面',exact:true}).click();
  await reopened.screenshot({path:path.join(data,'obj-import-options.png')});
  await objDialog.locator('#new-paint-submit').click();
  await objDialog.waitFor({state:'hidden'});
  const objId=new URL(reopened.url()).searchParams.get('project'),objRoute='/api/projects/'+objId,objPaint=objRoute+'/paint';
  const objDoc=await api(objRoute),objManifest=await api(objRoute+'/viewport');
  assert.equal(objDoc.name,'凹形机翼');
  assert.equal(objDoc.source.format,'glb');
  assert.equal(objDoc.source.material,'机翼#表面');
  assert.equal(objDoc.source.uvSha256,objManifest.metadata.uv_before);
  assert.deepEqual(Object.keys(objDoc.paint.layers[0].maps).sort(),['alpha','color','metallic','roughness']);
  const objGlb=Buffer.from(await (await fetch(origin+objManifest.modelUrl)).arrayBuffer());
  const objJsonSize=objGlb.readUInt32LE(12);
  const objGltf=JSON.parse(objGlb.subarray(20,20+objJsonSize).toString());
  assert.ok(objGltf.nodes.some(node=>node.name==='外壳#凹形机翼'));
  const readFloats=(accessorIndex)=>{
    const accessor=objGltf.accessors[accessorIndex],view=objGltf.bufferViews[accessor.bufferView];
    return Array.from({length:view.byteLength/4},(_,index)=>objGlb.readFloatLE(28+objJsonSize+(view.byteOffset||0)+index*4));
  };
  const primitive=objGltf.meshes[0].primitives[0];
  assert.equal(objGltf.accessors[primitive.indices].count,9);
  assert.deepEqual(readFloats(primitive.attributes.TEXCOORD_0),[0,1,1,1,1,0,.5,.5,0,0]);
  assert.deepEqual(readFloats(primitive.attributes.POSITION).slice(0,3),[-1,0,1]);
  const objTopologyState=await api(objRoute+'/viewport/topology',{});
  const objTopology=await api(objTopologyState.url);
  assert.deepEqual(objTopology.primitives['0:0'].polygons,[0,0,0]);
  const objSteps=[{matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,.25,0,1],targets:[{id:0}]}];
  const movedObj=await api(objPaint+'/model',{revision:objDoc.revision,modeling:{
    version:1,binding:objManifest.key,modelSha256:objManifest.modelSha256,steps:objSteps,
    nativeSteps:nativeModelSteps(objGltf,objSteps,objTopology)
  }});
  await reopened.reload();
  await reopened.locator('.editor-viewport[data-state=ready]').first().waitFor({timeout:30000});
  await reopened.screenshot({path:path.join(data,'obj-material-viewport.png')});
  assert.deepEqual((await api(objRoute)).modeling,movedObj.modeling);
  const objQueued=await api(objPaint+'/preview',{revision:movedObj.revision,requestId:'obj-original-uv'});
  const objBake=await until(async()=>{
    const job=await api(objRoute+'/jobs/'+objQueued.id);
    if(job.status==='failed')throw Error(await (await fetch(origin+objRoute+'/jobs/'+job.id+'/files/run.log')).text());
    return job.status==='completed'&&job;
  });
  assert.equal(objBake.paintReport.uv_unchanged,true);
  assert.deepEqual(objBake.paintReport.resolution,[4096,4096]);
  const objFilesToCheck=[objBake.colorUrl,objBake.materialUrls.alpha,objBake.materialUrls.roughness];
  const objMaps=[];
  for(const [index,url] of objFilesToCheck.entries()){
    const file=path.join(data,'obj-bake-'+index+'.png');
    await fs.writeFile(file,Buffer.from(await (await fetch(origin+url)).arrayBuffer()));objMaps.push(file);
  }
  const objPixels=JSON.parse(execFileSync(pythonExecutable(),['-X','utf8','-c',
    'import json,sys;from PIL import Image;print(json.dumps([[Image.open(f).getpixel(p) for p in ((0,0),(0,4095))] for f in sys.argv[1:]]))',
    ...objMaps],{encoding:'utf8'}));
  assert.deepEqual(objPixels,[[[192,32,10],[12,36,128]],[255,64],[90,90]]);
  console.log('PASS OBJ with Chinese sidecar paths, concave face, original UV orientation, model edit, reopen and 4K bake');

  await verifyProceduralMasks(templates[0].id);
  await verifyMultiMaterialPick();
  await verifyMarkedMaterialInspection();

  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  console.log('PASS GLB import, cache rebuild, original UV, edited model, native PNG/EXR/4K ZIP, and clean restore without Blender');
}

try{
  origin=await start(data);
  if(process.argv.includes('--model-update-only'))await verifyModelUpdate();
  else if(process.argv.includes('--material-inspection-only')){
    const response=await fetch(origin+'/api/projects/model-import?material=1',{
      method:'POST',headers:{'Content-Type':'model/gltf-binary',Origin:origin},body:model.bytes
    });
    const result=await response.json();assert.ok(response.ok,JSON.stringify(result));
    browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    await verifyObjectMaterialNavigation(result.id);
    await verifyMultiMaterialPick();
    await verifyMarkedMaterialInspection();
    await verifyRenderedSurfacePicking(result.id);
    await verifyOriginalTextureChannels(prepareTexturedModel().texturedFile);
  }else if(process.argv.includes('--mask-only')){
    browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const cube=await api('/api/projects',{workflowType:'pbr_paint',modelTemplate:'cube'});
    await verifyProceduralMasks(cube.id);
  }else {await verifyModelWorkflows();await verifyModelUpdate();}
}finally{
  await browser?.close();
  for(const service of services)if(service.exitCode===null&&service.signalCode===null){
    const done=once(service,'exit');service.kill();await done;
  }
  console.log(logs,'验收文件',data);
}
