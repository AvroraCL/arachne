import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

export async function verifyPanelAnchors({page,api,url,paint,origin}){
  const current=await api(url);
  const ready=await api(paint+'/commands',{revision:current.revision,operations:[
    {op:'add',kind:'paint',patch:{name:'下层划痕'}},
    {op:'add',kind:'fill',patch:{name:'显色面漆',maskEnabled:true,channels:{color:true,metallic:false,roughness:false},
      values:{color:'#00ff00',metallic:0,roughness:.5}}}
  ]});
  const [source,target]=ready.paint.layers.slice(-2);
  const layer=page.locator('.editor-area[data-editor=layers]');
  async function saved(action){
    const saved=page.waitForResponse(r=>r.url().endsWith('/paint/commands'));
    await action();const r=await saved;assert.ok(r.ok(),await r.text());return r.json();
  }
  async function frame(doc,mask=true,layerId=target.id){
    const response=await fetch(origin+paint+'/live',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({revision:doc.revision,resolution:256,format:'pbr8',...(mask?{inspectMask:layerId}:{})})});
    assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());
  }
  const coverage=bytes=>bytes.reduce((n,v,i)=>n+(i%15===0&&v>0),0);
  await page.reload();
  const view=page.locator('.editor-viewport[data-state=ready]').first();
  await view.waitFor();
  await layer.getByRole('button',{name:source.name,exact:true}).click();
  const publish=page.getByRole('checkbox',{name:'发布涂装锚点'});
  if(!await publish.isVisible())await page.locator('summary:visible').filter({hasText:'图层设置'}).first().click();
  await saved(()=>publish.check());
  await page.getByRole('button',{name:'绘制蒙版 · '+target.name,exact:true}).click();
  await page.getByRole('button',{name:'添加效果',exact:true}).click();
  const linked=await saved(()=>page.getByRole('option',{name:'引用锚点',exact:true}).click());
  assert.equal(linked.paint.layers.at(-1).maskEffects[0].source,source.id);
  assert.equal(coverage(await frame(linked)),0);
  await layer.getByRole('button',{name:source.name,exact:true}).click();
  const editor=page.locator('.editor-area[data-editor=viewport]').first();
  const mode=editor.getByRole('button',{name:'交互模式',exact:true});
  await mode.click();await page.getByRole('option',{name:'材质绘制',exact:true}).click();
  await editor.getByLabel('前景色',{exact:true}).fill('#ff0000');
  const box=await view.boundingBox(),totals=[],frames=[];
  let doc=linked;
  for(const [offset,n] of [[-.09,1],[0,2],[.09,3]]){
    const commit=page.waitForResponse(r=>r.url().endsWith('/paint/commands')&&r.request().postDataJSON().operations?.[0]?.op==='stroke',{timeout:12000});
    const y=box.y+box.height*(.5+offset);
    await page.mouse.move(box.x+box.width*.46,y);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.52,y,{steps:7});await page.mouse.up();
    const response=await commit;assert.ok(response.ok(),await response.text());doc=await response.json();
    assert.equal(doc.paint.layers.find(l=>l.id===source.id).strokes.length,n);
    await page.waitForFunction(rev=>document.querySelector('.editor-viewport[data-rendered-paint-revision="'+rev+'"][data-rendered-paint-draft=false]'),String(doc.revision));
    frames.push(await frame(doc));totals.push(coverage(frames.at(-1)));
    assert.ok(totals.at(-1)>(totals.at(-2)??0),JSON.stringify(totals));
  }
  const undo=await api(paint+'/undo',{revision:doc.revision});assert.deepEqual(await frame(undo),frames[1]);
  const redo=await api(paint+'/redo',{revision:undo.revision});assert.deepEqual(await frame(redo),frames[2]);
  const material=await frame(redo,false);
  const green=Array.from({length:256*256},(_,i)=>i).find(i=>frames[2][i*15]===255&&material[i*15]===0&&material[i*15+1]===255);
  assert.notEqual(green,undefined,'上层绿色应显示在红色笔触上');
  const savedEffect=redo.paint.layers.at(-1).maskEffects[0];
  const tone=await api(paint+'/commands',{revision:redo.revision,operations:[{op:'update',id:target.id,
    patch:{maskEffects:[{...savedEffect,channel:'luminance'}]}}]});
  assert.equal((await frame(tone))[green*15],54);
  const restored=await api(paint+'/undo',{revision:tone.revision});
  await page.goto(origin);await page.goto(origin+'/paint.html?project='+doc.id);await view.waitFor();
  const reopened=await api(url);
  assert.equal(reopened.paint.layers.at(-1).maskEffects[0].source,source.id);
  assert.deepEqual(await frame(reopened),frames[2]);assert.deepEqual(await frame(reopened,false),material);
  await assert.rejects(api(paint+'/commands',{revision:restored.revision,operations:[{op:'remove',id:source.id}]}),/下层锚点/);
  await assert.rejects(api(paint+'/commands',{revision:restored.revision,operations:[{op:'move',id:source.id,index:restored.paint.layers.length-1}]}),/下层锚点/);
  const job=await api(paint+'/preview',{revision:restored.revision,requestId:'anchor-bake'});
  let result;
  for(let n=0;n<900;n++){
    result=await api(url+'/jobs/'+job.id);if(result.status==='failed')throw Error(result.error);
    if(result.status==='completed')break;await delay(200);
  }
  assert.equal(result.status,'completed');assert.equal(result.paintReport.uv_unchanged,true);
  const folder=await api(paint+'/commands',{revision:restored.revision,operations:[
    {op:'add',kind:'group',patch:{name:'引用笔迹的文件夹',maskEffects:[savedEffect]}}
  ]});
  assert.deepEqual(await frame(folder,true,folder.paint.layers.at(-1).id),frames[2]);
  const faded=await api(paint+'/commands',{revision:folder.revision,operations:[
    {op:'update',id:source.id,patch:{name:'改名后的划痕',opacity:.5}}
  ]});
  assert.equal((await frame(faded))[green*15],128);
  const hidden=await api(paint+'/commands',{revision:faded.revision,operations:[{op:'update',id:source.id,patch:{visible:false}}]});
  assert.equal(coverage(await frame(hidden)),0);
  console.log('Panel anchor verified: covered texels after 3 pointer strokes at 256 px:',totals.join(', '),'red luminance: 54');
  return {colorUrl:result.colorUrl,mask:frames[2],material};
}
