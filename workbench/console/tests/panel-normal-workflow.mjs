import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export async function verifyPanelNormal({page,api,url,paint,origin,folder,panel,python}){
  const high=path.join(folder,'relief.glb');
  execFileSync(python,[panel,'create-high',high]);
  const before=await api(url);
  await page.locator('.paint-menu > summary').filter({hasText:/^渲染$/}).click();
  await page.locator('#open-normal-bake').click();
  const dialog=page.locator('#normal-bake-dialog');
  await dialog.locator('[name=high]').setInputFiles(high);
  await dialog.getByRole('button',{name:'贴图尺寸',exact:true}).click();
  await page.getByRole('option',{name:'512',exact:true}).click();
  async function bake(front){
    await dialog.locator('[name=front]').fill(front);
    const response=page.waitForResponse(r=>r.url().includes('/mesh-normal?'));
    await dialog.getByRole('button',{name:'烘焙',exact:true}).click();
    const r=await response;await dialog.getByRole('button',{name:'关闭',exact:true}).waitFor();
    return [r.ok(),await dialog.locator('output').innerText()];
  }
  const [miss,error]=await bake('.01');
  assert.equal(miss,false);assert.match(error,/没有命中高模/);
  assert.equal((await api(url)).revision,before.revision);
  const [ok,result]=await bake('.25');
  assert.ok(ok,result);
  const [,hits,valid]=result.match(/命中 (\d+) \/ (\d+)/);assert.ok(+hits>1000&&+hits<+valid);
  await dialog.getByText(/已添加法线填充层/).waitFor();
  const current=await api(url),layer=current.paint.layers.at(-1);
  assert.ok(current.paint.assets[layer.maps.normal]);
  assert.deepEqual(Object.keys(layer.channels).filter(k=>layer.channels[k]),['normal']);
  const response=await fetch(origin+paint+'/assets/'+layer.maps.normal);
  assert.ok(response.ok);
  await fs.writeFile(path.join(folder,'projected.png'),Buffer.from(await response.arrayBuffer()));
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  const undone=await api(paint+'/undo',{revision:current.revision});assert.deepEqual(undone.paint.layers,before.paint.layers);
  const redone=await api(paint+'/redo',{revision:undone.revision});assert.deepEqual(redone.paint.layers,current.paint.layers);
  await page.reload();assert.deepEqual((await api(url)).paint.layers,current.paint.layers);
  const job=await api(paint+'/preview',{revision:redone.revision,requestId:'panel-normal'});
  const deadline=Date.now()+180000;
  let finished;
  while(Date.now()<deadline){
    const state=await api(url+'/jobs/'+job.id);
    if(state.status==='failed')throw Error(state.error);
    if(state.status==='completed'){finished=state;break;}
    await delay(250);
  }
  assert.ok(finished?.materialUrls.normal);
  const material=await fetch(origin+finished.materialUrls.normal);assert.ok(material.ok);
  await fs.writeFile(path.join(folder,'projected-4k.png'),Buffer.from(await material.arrayBuffer()));
  execFileSync(python,['-c',[
    'import sys,numpy as np','from PIL import Image','from pathlib import Path',
    'p=Path(sys.argv[1])','n=np.array([-.4,-.3,1]); n/=np.linalg.norm(n)',
    'for file,size in [("projected.png",512),("projected-4k.png",4096)]:',
    ' im=Image.open(p/file).convert("RGB"); assert im.size==(size,size)',
    ' for u,expected in [(.28,n),(.84,n*[-1,-1,1]),(.68,[0,0,1])]:',
    '  pixel=im.getpixel((round(u*size),size//2)); want=np.rint((np.array(expected)*.5+.5)*255)',
    '  assert np.max(np.abs(want-pixel))<=1,(file,u,want,pixel)'
  ].join('\n'),folder]);
}
