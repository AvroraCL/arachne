import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {mappedLibraryMaterial} from '../public/paint-library-maps.mjs';

export async function verifyPanelProjection({page,api,url,paint,origin,folder,python}){
  const pixels=path.join(import.meta.dirname,'panel-projection-pixels.py');
  execFileSync(python,[pixels,'pattern',folder]);
  let doc=await api(url);
  const maps={};
  for(const channel of ['color','normal']){
    const data=(await fs.readFile(path.join(folder,channel+'.png'))).toString('base64');
    const uploaded=await api(paint+'/assets',{revision:doc.revision,name:channel+'.png',data});
    maps[channel]=uploaded.asset.id;doc=uploaded.document;
  }
  const graph=mappedLibraryMaterial(maps,doc.paint.assets);
  doc=await api(paint+'/commands',{revision:doc.revision,operations:[
    {op:'library',library:'materials',id:'arrows',action:'create',patch:{name:'箭头条纹',graph}},
    {op:'add',kind:'fill',patch:{name:'方向标记',materialId:'arrows',channels:{color:true,normal:true,metallic:false,roughness:false}}}
  ]});
  const id=doc.paint.layers.at(-1).id;
  await page.goto(origin+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=material]').click();
  await page.getByRole('button',{name:'方向标记',exact:true}).click();
  const panel=page.locator('details[data-property-section=uv]:visible').first();
  if(await panel.getAttribute('open')===null)await panel.locator('summary').click();
  const view=page.locator('.editor-viewport[data-state=ready]').first();
  async function sample(current,file){
    const response=await fetch(origin+paint+'/live',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({revision:current.revision,resolution:256,format:'pbr8'})});
    assert.equal(response.status,200);
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,256*256*15);
    if(file)await fs.writeFile(path.join(folder,file+'.raw'),bytes);
    return bytes;
  }
  async function edit(action){
    await panel.locator('xpath=ancestor::form[@aria-busy="false"]').waitFor();
    const saving=page.waitForResponse(r=>r.url().endsWith('/paint/commands'));
    await action();const response=await saving;assert.ok(response.ok(),await response.text());return response.json();
  }
  async function mode(name){
    return edit(async()=>{await panel.getByRole('button',{name:'投影方式',exact:true}).click();
      await page.getByRole('option',{name,exact:true}).click();});
  }
  async function number(label,value){
    return edit(async()=>{const input=panel.getByRole('spinbutton',{name:label,exact:true});await input.fill(String(value));await input.press('Tab');});
  }
  async function shown(current,name){
    await page.waitForFunction(rev=>document.querySelector('.editor-viewport[data-rendered-paint-revision="'+rev+'"][data-rendered-paint-draft=false]'),String(current.revision));
    await view.screenshot({path:path.join(folder,name+'.png')});
  }
  const uv=await sample(doc,'uv');await shown(doc,'uv-view');
  const tri=await mode('三平面');const defaultTri=await sample(tri,'tri');await shown(tri,'tri-view');
  assert.ok(!uv.equals(defaultTri));
  const hard=await number('轴向混合',0);const hardFrame=await sample(hard,'hard');assert.ok(!hardFrame.equals(defaultTri));
  const soft=await number('轴向混合',.8);
  const softFrame=await sample(soft);
  const scaled=await number('投影缩放',.57);const scaledFrame=await sample(scaled);assert.ok(!softFrame.equals(scaledFrame));
  const x=await number('旋转 X (°)',22);
  const xFrame=await sample(x);assert.ok(!xFrame.equals(scaledFrame));
  const y=await number('旋转 Y (°)',-16);const yFrame=await sample(y);assert.ok(!xFrame.equals(yFrame));
  const rotated=await number('旋转 Z (°)',35);
  const final=await sample(rotated,'final');assert.ok(!yFrame.equals(final));
  const oldUV=await mode('UV');assert.ok((await sample(oldUV)).equals(uv));
  const undo=await api(paint+'/undo',{revision:oldUV.revision});assert.ok((await sample(undo)).equals(final));
  const redo=await api(paint+'/redo',{revision:undo.revision});assert.ok((await sample(redo)).equals(uv));
  doc=await api(paint+'/undo',{revision:redo.revision});await page.goto(origin);
  await page.goto(origin+'/paint.html?project='+doc.id);await page.getByRole('button',{name:'方向标记',exact:true}).click();
  assert.equal(await panel.getByRole('button',{name:'投影方式'}).innerText(),'三平面');
  assert.deepEqual((await api(url)).paint.layers.at(-1).fillProjection,{mode:'triplanar',scale:.57,rotation:[22,-16,35],blend:.8});
  assert.ok((await sample(doc)).equals(final));await shown(doc,'rotated-view');
  // The same PNGs assigned directly to channels use the same plane coordinates as the library graph.
  const direct=await api(paint+'/commands',{revision:doc.revision,operations:[
    {op:'update',id,patch:{materialId:null,maps}}
  ]});
  const bytes=await sample(direct);
  const maxima=Array(15).fill(0);
  for(let i=0;i<bytes.length;i++)maxima[i%15]=Math.max(maxima[i%15],Math.abs(bytes[i]-final[i]));
  assert.deepEqual(maxima,Array(15).fill(0),'direct maps versus library: '+maxima);
  doc=await api(paint+'/undo',{revision:direct.revision});
  const job=await api(paint+'/preview',{revision:doc.revision,requestId:'triplanar-fold'});
  let result;
  for(let n=0;n<900;n++){
    result=await api(url+'/jobs/'+job.id);if(result.status==='failed')throw Error(result.error);
    if(result.status==='completed')break;await delay(200);
  }
  assert.equal(result.status,'completed');assert.equal(result.paintReport.uv_unchanged,true);
  assert.equal(result.paintReport.protectedTexelsWritten,0);
  for(const [name,location] of [['color',result.colorUrl],['normal',result.materialUrls.normal]]){
    const response=await fetch(origin+location);assert.ok(response.ok,location);
    await fs.writeFile(path.join(folder,'baked-'+name+'.png'),Buffer.from(await response.arrayBuffer()));
  }
  console.log(execFileSync(python,[pixels,'check',folder],{encoding:'utf8'}).trim());
  if(process.env.ARACHNE_PROJECTION_EVIDENCE){
    const evidence=process.env.ARACHNE_PROJECTION_EVIDENCE;
    await fs.mkdir(evidence,{recursive:true});
    for(const name of ['uv-view','tri-view','rotated-view'])await fs.copyFile(path.join(folder,name+'.png'),path.join(evidence,name+'.png'));
  }
}
