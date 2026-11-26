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

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-banner-'));
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
  let doc=await api('/api/projects',{workflowType:'pbr_paint',name:'横幅边界验收',modelTemplate:'plane'},201);
  const route='/api/projects/'+doc.id,paint=route+'/paint';
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1580,height:960}}),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e);});
  await page.goto(base+'/paint.html?project='+doc.id);
  await page.locator('[data-area-mode=drawing]').click();
  const editor=page.locator('[data-editor=image]').first(),canvas=editor.getByLabel('图像文档画布');
  const stack=page.locator('[data-editor=imageLayers]').first(),mod=process.platform==='darwin'?'Meta':'Control';
  async function saved(label){
    const last=doc.revision;
    doc=await until(async()=>{const next=await api(route);return next.revision>last&&next;},label);
    console.log('PASS',label);
  }
  await editor.getByRole('button',{name:'新建图像',exact:true}).click();
  const dialog=page.locator('dialog.image-size-dialog[open]');
  const width=dialog.getByLabel('宽度（像素）'),height=dialog.getByLabel('高度（像素）');
  await dialog.getByRole('button',{name:/全高清/}).click();
  await dialog.getByRole('button',{name:'纵向'}).click();
  assert.deepEqual([await width.inputValue(),await height.inputValue()],['1080','1920']);
  assert.equal(await dialog.getByRole('button',{name:/全高清/}).getAttribute('aria-pressed'),'true');
  for(const button of [dialog.getByRole('button',{name:/全高清/}),dialog.getByRole('button',{name:'纵向'}),dialog.getByRole('button',{name:'创建',exact:true})]){
    const background=await button.evaluate(el=>getComputedStyle(el).backgroundColor);
    assert.match(background,/^rgba?\((\d+), \1, \1(?:, [\d.]+)?\)$/,'neutral button surface: '+background);
  }
  await page.setViewportSize({width:540,height:680});
  const presets=await dialog.getByRole('region',{name:'画布预设'}).boundingBox();
  const details=await dialog.getByRole('region',{name:'图像设置'}).boundingBox();
  assert.ok(details.y>=presets.y+presets.height-1&&details.x+details.width<=540);
  const paper=dialog.locator('.new-image-paper');
  const portrait=await paper.boundingBox();
  assert.ok(Math.abs(portrait.width/portrait.height-1080/1920)<.02);
  await page.setViewportSize({width:390,height:600});
  const confirm=await dialog.getByRole('button',{name:'创建',exact:true}).boundingBox();
  assert.ok(confirm.y>=0&&confirm.y+confirm.height<=600);
  await dialog.getByRole('button',{name:'颜色空间',exact:true}).click();
  const spaceMenu=dialog.getByRole('listbox',{name:'颜色空间',exact:true});
  const searchSpace=spaceMenu.getByRole('searchbox',{name:'搜索颜色空间'});
  await searchSpace.fill('场景线性');
  assert.equal(await spaceMenu.getByRole('option').count(),3);
  assert.equal(await spaceMenu.getByRole('group').count(),1);
  await searchSpace.fill('灰度');
  assert.equal(await spaceMenu.getByRole('option').count(),2);
  await searchSpace.fill('');
  await dialog.getByRole('option',{name:'数据（线性）',exact:true}).click();
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1580,height:960});
  assert.equal(Object.keys((await api(route)).paint.imageDocuments??{}).length,0);
  for(const [colorSpace,label,description] of [['adobe-rgb','Adobe RGB (1998)','A98C'],['rec2020','Rec.2020','2020'],['acescg','ACEScg（AP1 线性）','ACEScg - Arachne Linear RGB'],['aces2065-1','ACES2065-1（AP0 线性）','ACES2065-1 - Arachne Linear RGB'],['linear-srgb','线性 sRGB（颜色）','cRGB'],['gray-g22','灰度（Gamma 2.2）','Arachne Gray Gamma 2.2'],['gray-linear','灰度（线性光）','Arachne Linear Gray']]){
    await editor.getByRole('button',{name:'创建第一个图像文档'}).click();
    await width.fill('63');await height.fill('31');
    await dialog.getByRole('button',{name:'背景内容',exact:true}).click();
    await dialog.getByRole('option',{name:'自定颜色',exact:true}).click();
    const sourceHex=colorSpace==='acescg'?'#00ff00':'#4477aa';
    await dialog.getByLabel('背景颜色').fill(sourceHex);
    assert.equal(await paper.evaluate(e=>getComputedStyle(e).backgroundColor),colorSpace==='acescg'?'rgb(0, 255, 0)':'rgb(68, 119, 170)');
    await dialog.getByRole('button',{name:'颜色空间',exact:true}).click();
    for(const name of ['Display P3','Adobe RGB (1998)','ProPhoto RGB','Rec.709','Rec.2020','Rec.2020（Gamma 2.4）','DCI-P3（影院）','线性 sRGB（颜色）'])assert.ok(await dialog.getByRole('option',{name,exact:true}).isVisible());
    await dialog.getByRole('option',{name:label,exact:true}).click();
    const swatch=await paper.evaluate(e=>getComputedStyle(e).backgroundColor.match(/\d+/g).map(Number));
    await dialog.getByRole('button',{name:'创建',exact:true}).click();await saved('创建带 '+label+' 背景的图像');
    const colored=Object.values(doc.paint.imageDocuments)[0];
    assert.equal(colored.colorSpace,colorSpace);
    assert.deepEqual(colored.layers.map(l=>l.kind),['shape','pixel']);
    await editor.locator('.document-image-stage[data-preview-revision="'+doc.revision+'"]').waitFor();
    const backgroundFile=path.join(data,'background.png');
    const downloadBackground=page.waitForEvent('download');
    await editor.getByRole('button',{name:'导出当前图像 PNG'}).click();
    await (await downloadBackground).saveAs(backgroundFile);
    const expectedDisplay=execFileSync(pythonExecutable(),['-c',`from PIL import Image
import sys
from PIL import ImageCms
from io import BytesIO
im=Image.open(sys.argv[1])
profile=ImageCms.ImageCmsProfile(BytesIO(im.info['icc_profile']))
assert ImageCms.getProfileDescription(profile).strip()==sys.argv[2]
gray=profile.profile.xcolor_space.strip()=='GRAY'
assert im.mode==('LA' if gray else 'RGBA')
proof=ImageCms.profileToProfile(im.getchannel('L') if gray else im,profile,ImageCms.createProfile('sRGB'),outputMode='RGBA',renderingIntent=1)
proof.putalpha(im.getchannel('A'))
print(*proof.getpixel((30,15)))
assert im.size==(63,31)
from PIL import ImageColor
rgb=ImageColor.getrgb(sys.argv[3])
gamma=2.2 if sys.argv[2].endswith('2.2') else 1.0
expected=(round(255*sum(w*(n/255)**gamma for w,n in zip((.2126,.7152,.0722),rgb))**(1/gamma)),255) if gray else rgb+(255,)
assert im.getextrema()==tuple((n,n) for n in expected),im.getextrema()`,backgroundFile,description,sourceHex],{encoding:'utf8'}).trim().split(/\s+/).map(Number);
    swatch.forEach((value,i)=>assert.ok(Math.abs(value-expectedDisplay[i])<=1,label+' 新建预览色块'));
    async function checkDisplay(){
      await until(async()=>{
        const pixel=await canvas.evaluate(c=>[...c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data]);
        return pixel.every((n,i)=>Math.abs(n-expectedDisplay[i])<=1);
      },label+' 画布与导出 ICC 色块一致');
    }
    if(colorSpace==='adobe-rgb'){
      const props=page.locator('[data-editor=imageProperties]').first();
      const sourceId=Object.keys(doc.paint.imageDocuments)[0];
      await props.getByRole('button',{name:'建立关联色彩副本',exact:true}).click();
      await page.getByRole('listbox',{name:'建立关联色彩副本'}).getByRole('option',{name:'灰度（线性光）',exact:true}).click();await saved('从 Adobe RGB 建立关联线性灰度副本');
      const copies=Object.entries(doc.paint.imageDocuments).filter(([key])=>key!==sourceId);
      assert.equal(copies.length,1);
      const [copyId,linked]=copies[0],instance=linked.layers[0];
      assert.deepEqual(instance.embedded,{documentId:sourceId,width:63,height:31});
      const layerRow=id=>stack.locator('[data-image-layer-id="'+id+'"] .document-layer-select');
      await layerRow(instance.id).waitFor();
      async function linkedPNG(name){
        await editor.locator('.document-image-stage[data-preview-size="4096"][data-preview-revision="'+doc.revision+'"]').waitFor({timeout:90000});
        const result=page.waitForEvent('download');
        await editor.getByRole('button',{name:'导出当前图像 PNG'}).click();
        const file=path.join(data,name+'.png');await (await result).saveAs(file);return file;
      }
      const converted=await linkedPNG('linked-converted');
      execFileSync(pythonExecutable(),['-c',`import sys
from io import BytesIO
from PIL import Image,ImageCms
original,out=map(Image.open,sys.argv[1:])
def profile(im): return ImageCms.ImageCmsProfile(BytesIO(im.info['icc_profile']))
reference=ImageCms.profileToProfile(original.convert('RGB'),profile(original),profile(out),outputMode='L',renderingIntent=1)
assert out.mode=='LA' and out.size==original.size==(63,31)
assert reference.tobytes()==out.getchannel('L').tobytes()
assert original.getchannel('A').tobytes()==out.getchannel('A').tobytes()`,backgroundFile,converted]);
      await layerRow(instance.id).dblclick();
      await editor.getByRole('button',{name:'返回原稿',exact:true}).waitFor();
      await editor.getByRole('button',{name:'画笔',exact:true}).click();
      const b=await canvas.boundingBox();await page.mouse.click(b.x+b.width/2,b.y+b.height/2);await saved('从关联副本打开原稿并修改像素');
      await editor.getByRole('button',{name:'返回原稿',exact:true}).click();
      const edited=await linkedPNG('linked-edited');
      async function history(key,name){
        await canvas.focus();await page.keyboard.press(mod+key);await saved(name);
      }
      await history('+z','撤销原稿笔触');const undone=await linkedPNG('linked-undone');
      await history('+Shift+z','重做原稿笔触');const redone=await linkedPNG('linked-redone');
      await page.reload();
      await editor.getByRole('button',{name:'图像文档',exact:true}).click();
      await page.getByRole('listbox',{name:'图像文档',exact:true}).getByRole('option',{name:linked.name,exact:true}).click();
      const reopened=await linkedPNG('linked-reopened');
      execFileSync(pythonExecutable(),['-c',`from PIL import Image
import sys
before,after,undone,redone,reopened=[Image.open(p).tobytes() for p in sys.argv[1:]]
assert before!=after and before==undone and after==redone==reopened`,converted,edited,undone,redone,reopened]);
      await history('+z','恢复原稿像素');await history('+z','撤销建立色彩副本');
      assert.deepEqual(Object.keys(doc.paint.imageDocuments),[sourceId]);
      await history('+Shift+z','重做建立色彩副本');
      assert.deepEqual(doc.paint.imageDocuments[copyId].layers[0].embedded,instance.embedded);
      await history('+z','返回单一原稿');
      console.log('PASS 关联色彩副本实际像素、返工、双向历史及重开');
    }
    if(colorSpace.startsWith('gray-')){
      await editor.getByLabel('图像前景色',{exact:true}).click();
      const chooser=page.getByRole('dialog',{name:'图像前景色选色'});
      await chooser.getByRole('slider',{name:'灰度',exact:true}).waitFor();
      assert.equal(await chooser.getByRole('slider',{name:'色相',exact:true}).isVisible(),false);
      await chooser.getByLabel('HEX 颜色').fill('#808080');
      const chip=await chooser.locator('.paint-color-sample').evaluate(el=>getComputedStyle(el).backgroundColor);
      const level=colorSpace==='gray-linear'?188:129;
      assert.equal(chip,'rgb('+[level,level,level].join(', ')+')');
      await chooser.getByRole('button',{name:'取消',exact:true}).click();
    }
    if(colorSpace==='acescg'){
      const revisionBefore=(await api(route)).revision;
      await checkDisplay();
      const front=editor.getByLabel('图像前景色',{exact:true});
      const originalForeground=await front.inputValue();
      await front.click();const picker=page.locator('.paint-color-picker:popover-open');
      await picker.getByRole('textbox',{name:'HEX 颜色'}).fill('#808080');
      const chip=await picker.locator('.paint-color-sample').evaluate(el=>getComputedStyle(el).backgroundColor);
      assert.equal(chip,'rgb(188, 188, 188)','ACEScg 线性中灰在拾色器中应与画布相同');
      assert.deepEqual(await picker.locator('.paint-color-sv canvas').evaluate(c=>[...c.getContext('2d').getImageData(0,66,1,1).data]),[188,188,188,255]);
      await picker.getByRole('button',{name:'输入 Lab（D50）'}).click();
      const lightness=picker.getByLabel('Lab L*',{exact:true});
      assert.ok(Math.abs(Number(await lightness.inputValue())-76.2)<.1);
      await lightness.fill('50');
      assert.equal(await picker.getByLabel('HEX 颜色').inputValue(),'#2f2f2f');
      await picker.getByLabel('Lab a*',{exact:true}).fill('127');await picker.getByLabel('Lab b*',{exact:true}).fill('-128');
      assert.match(await picker.getByRole('status').textContent(),/超出原稿色域/);
      await lightness.fill('-1');assert.ok(await picker.getByRole('button',{name:'确定',exact:true}).isDisabled());
      await picker.getByLabel('HEX 颜色').fill('#808080');
      await picker.screenshot({path:path.join(data,'aces-lab-picker.png')});
      await picker.getByRole('button',{name:'输入 RGB'}).click();
      const red=picker.getByLabel('红色通道 R');
      await red.fill('256');assert.ok(await picker.getByRole('button',{name:'确定',exact:true}).isDisabled());
      await red.fill('131');assert.equal(await picker.getByRole('textbox',{name:'HEX 颜色'}).inputValue(),'#838080');
      await red.fill('128');await red.press('Enter');
      assert.equal(await front.inputValue(),'#808080');
      const swatchFile=path.join(data,'aces-foreground-chip.png');await front.screenshot({path:swatchFile});
      execFileSync(pythonExecutable(),['-c',`import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB');assert im.getpixel((im.width//2,im.height//2))==(188,188,188)`,swatchFile]);
      await front.click();await picker.getByRole('textbox',{name:'HEX 颜色'}).fill(originalForeground);
      await picker.getByRole('button',{name:'确定',exact:true}).click();
      const viewButton=editor.getByRole('button',{name:'画布视图',exact:true});
      await viewButton.click();
      const warning=editor.getByRole('checkbox',{name:'sRGB 色域警告'});
      await warning.check();
      assert.deepEqual(await canvas.evaluate(c=>[...c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data]),[255,173,54,255]);
      assert.match(await editor.locator('.editor-message').innerText(),/sRGB 色域警告/);
      await viewButton.click();
      await editor.getByRole('button',{name:'选择导出颜色空间',exact:true}).click();
      const asSRGB=page.waitForEvent('download');
      await page.getByRole('menuitem',{name:'颜色（sRGB）',exact:true}).click();
      const copy=await asSRGB;
      assert.ok(copy.suggestedFilename().endsWith('-srgb.png'));
      const converted=path.join(data,'acescg-to-srgb.png');
      await copy.saveAs(converted);
      const png=execFileSync(pythonExecutable(),['-c',`import sys
from PIL import Image
im=Image.open(sys.argv[1]);assert im.size==(63,31) and im.info['srgb']==0
print(*im.getpixel((30,15)))`,converted],{encoding:'utf8'}).trim().split(/\s+/).map(Number);
      assert.ok(png.every((v,i)=>Math.abs(v-expectedDisplay[i])<=1),'sRGB 输出副本与受色彩管理的原稿预览一致');
      assert.equal((await api(route)).revision,revisionBefore);
      await viewButton.click();await warning.uncheck();await viewButton.click();
      // A wide display must retain colors outside sRGB in the backing surface.
      // Reopen under a P3 display and read the canvas explicitly in P3.
      const session=await page.context().newCDPSession(page);
      await session.send('Emulation.setEmulatedMedia',{features:[{name:'color-gamut',value:'p3'}]});
      await page.reload();
      assert.equal(await page.evaluate(()=>matchMedia('(color-gamut: p3)').matches),true);
      await editor.locator('.document-image-stage[data-preview-revision="'+doc.revision+'"]').waitFor();
      const sampleP3=()=>canvas.evaluate(c=>{
        const ctx=c.getContext('2d');
        return [ctx.getContextAttributes().colorSpace,...ctx.getImageData(c.width>>1,c.height>>1,1,1,{colorSpace:'display-p3'}).data];
      });
      assert.deepEqual(await sampleP3(),['display-p3',0,255,0,255]);
      assert.match(await editor.locator('.editor-message').innerText(),/Display P3 预览/);
      const backdrop=stack.locator('.document-layer-row').filter({hasText:'背景'}).locator('canvas.document-layer-thumb');
      let thumbnailPixel;
      await until(async()=>{
        thumbnailPixel=await backdrop.evaluate(c=>{
          if(c.width===300&&c.height===150)return null;
          const ctx=c.getContext('2d');
          return [c.width,c.height,ctx.getContextAttributes().colorSpace,...ctx.getImageData(c.width>>1,c.height>>1,1,1,{colorSpace:'display-p3'}).data];
        });
        return thumbnailPixel?.join(',')==='63,31,display-p3,0,255,0,255';
      },'P3 图层缩略图保留超色域颜色').catch(error=>{throw Error(error.message+' '+JSON.stringify(thumbnailPixel));});
      await viewButton.click();await warning.check();
      assert.deepEqual(await sampleP3(),['display-p3',243,177,80,255]);
      await warning.uncheck();await viewButton.click();
      await session.send('Emulation.setEmulatedMedia',{features:[{name:'color-gamut',value:'srgb'}]});
      await page.reload();await session.detach();
      console.log('PASS P3 画布保留超出 sRGB 的绿色，切换色域警告可恢复');
      const profiles=[[path.resolve('public/color-profiles/DisplayP3-v4.icc'),'RGBA','png']];
      for(const [file,mode,ext] of [
        [process.env.ARACHNE_TEST_CMYK_PROFILE||'/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc','CMYK','tif'],
        [process.env.ARACHNE_TEST_GRAY_PROFILE||'/System/Library/ColorSync/Profiles/Generic Gray Gamma 2.2 Profile.icc','LA','png']
      ])if(await fs.access(file).then(()=>true,()=>false))profiles.push([file,mode,ext]);
      for(const [profile,mode,ext] of profiles){
        await editor.getByRole('button',{name:'选择导出颜色空间',exact:true}).click();
        await page.getByRole('menuitem',{name:'按 ICC 导出副本…',exact:true}).click();
        const profileDialog=page.getByRole('dialog',{name:'按 ICC 导出副本'});
        const chooser=profileDialog.getByLabel('目标 ICC');
        const confirm=profileDialog.getByRole('button',{name:'导出副本',exact:true});
        assert.ok(await confirm.isDisabled());
        await chooser.setInputFiles({name:'broken.icc',mimeType:'application/octet-stream',buffer:Buffer.from('broken')});
        await until(async()=>(await profileDialog.locator('output').textContent()).includes('不完整'),'损坏配置提示');
        assert.ok(await confirm.isDisabled());
        await chooser.setInputFiles(profile);
        await profileDialog.getByRole('button',{name:'预览校样'}).click();
        const comparison=profileDialog.locator('figure img');
        await comparison.waitFor();
        async function readProof(){
          return comparison.evaluate(img=>{
            const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
            const context=canvas.getContext('2d');context.drawImage(img,0,0);
            return [canvas.width,canvas.height,...[.25,.75].map(x=>[...context.getImageData(Math.floor(x*canvas.width),Math.floor(canvas.height/2),1,1).data])];
          });
        }
        const initialProof=await readProof();
        assert.deepEqual(initialProof.slice(0,2),[126,31]);
        let paperProof;
        if(mode==='CMYK'){
          const url=await comparison.getAttribute('src');
          await profileDialog.getByLabel('模拟纸白').check();
          await until(async()=>await comparison.isVisible()&&(await comparison.getAttribute('src'))!==url,'纸白模拟图更新');
          paperProof=await readProof();
          await profileDialog.screenshot({path:path.join(data,'icc-proof-wide.png')});
          const desktop=page.viewportSize();await page.setViewportSize({width:1000,height:680});
          const bounds=await profileDialog.boundingBox();
          assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=1000&&bounds.y+bounds.height<=680);
          await profileDialog.screenshot({path:path.join(data,'icc-proof-compact.png')});
          await page.setViewportSize(desktop);
        }else assert.equal(await profileDialog.getByLabel('模拟纸白').isVisible(),false);
        const fileName=path.join(data,'proof-'+mode+'.'+ext);
        const result=page.waitForEvent('download');
        await confirm.click();
        const file=await result;
        assert.equal(path.extname(file.suggestedFilename()),'.'+ext);await file.saveAs(fileName);
        execFileSync(pythonExecutable(),['-B','-c',`import sys
from io import BytesIO
from pathlib import Path
from PIL import Image,ImageCms
from image_color_spaces import profile_bytes
im=Image.open(sys.argv[1]);dest=Path(sys.argv[2]).read_bytes();mode=sys.argv[3]
assert im.size==(63,31) and im.mode==mode and im.info['icc_profile']==dest
assert im.format==('TIFF' if mode=='CMYK' else 'PNG')
src=Image.new('RGB',(1,1),(0,255,0))
ref=ImageCms.profileToProfile(src,BytesIO(profile_bytes('acescg')),BytesIO(dest),outputMode={'CMYK':'CMYK','RGBA':'RGB','LA':'L'}[mode],
    renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC).getpixel((0,0))
if mode=='LA': ref=(ref,255)
if mode=='RGBA': ref=(*ref,255)
assert im.getpixel((30,15))==ref,(im.getpixel((30,15)),ref)`,fileName,profile,mode],{cwd:new URL('..',import.meta.url)});
        assert.equal((await api(route)).revision,revisionBefore);
        const expectedProof=JSON.parse(execFileSync(pythonExecutable(),['-B','-c',`import json,sys
from io import BytesIO
from PIL import Image,ImageCms
from image_color_spaces import profile_bytes
file=Image.open(sys.argv[1]); target=profile_bytes('srgb')
def screen(im,source,intent):
 return [*ImageCms.profileToProfile(im,BytesIO(source),BytesIO(target),outputMode='RGB',renderingIntent=intent).getpixel((0,0)),255]
original=screen(Image.new('RGB',(1,1),(0,255,0)),profile_bytes('acescg'),1)
device=file.crop((30,15,31,16)).convert({'CMYK':'CMYK','RGBA':'RGB','LA':'L'}[file.mode])
print(json.dumps([original,screen(device,file.info['icc_profile'],1),screen(device,file.info['icc_profile'],3)]))`,
            fileName],{encoding:'utf8',cwd:new URL('..',import.meta.url)}));
        assert.deepEqual(initialProof.slice(2),expectedProof.slice(0,2));
        if(paperProof)assert.deepEqual(paperProof.slice(2),[expectedProof[0],expectedProof[2]]);
        console.log('PASS 选择 ICC 导出',mode,ext);
      }
      if(process.platform==='darwin'){
        await editor.getByRole('button',{name:'选择导出颜色空间'}).click();
        await page.getByRole('menuitem',{name:'按 ICC 导出副本…'}).click();
        const sysDialog=page.getByRole('dialog',{name:'按 ICC 导出副本'});
        await sysDialog.getByRole('button',{name:'本机 ICC 配置',exact:true}).click();
        await sysDialog.getByRole('searchbox',{name:'搜索本机 ICC 配置'}).fill('Generic CMYK Profile');
        await sysDialog.getByRole('option',{name:/Generic CMYK Profile\.icc/}).click();
        await sysDialog.getByRole('button',{name:'预览校样'}).click();
        await sysDialog.getByRole('img',{name:/校样/}).waitFor();
        const profileLayout=await sysDialog.evaluate(el=>{
          const label=el.querySelector('.profile-file>label');
          const choice=el.querySelector('.profile-installed .custom-select-button');
          return [label.getBoundingClientRect().height,choice.getBoundingClientRect().width];
        });
        assert.ok(profileLayout[0]<26&&profileLayout[1]>220,'配置名与文件标签有足够空间 '+profileLayout);
        await sysDialog.screenshot({path:path.join(data,'installed-print-profile.png')});
        const pickDownload=page.waitForEvent('download');
        await sysDialog.getByRole('button',{name:'导出副本',exact:true}).click();
        const picked=path.join(data,'system-CMYK.tif');await (await pickDownload).saveAs(picked);
        execFileSync(pythonExecutable(),['-B','-c',`import sys
from PIL import Image
from pathlib import Path
im=Image.open(sys.argv[1])
assert im.mode=='CMYK' and im.size==(63,31)
assert im.info['icc_profile']==Path('/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc').read_bytes()`,picked]);
        assert.equal((await api(route)).revision,revisionBefore);
        console.log('PASS 从真实 ColorSync 目录搜索印刷 ICC、校样并导出同配置 TIFF');
      }
      await editor.getByRole('button',{name:'选择导出颜色空间'}).click();
      const labDownload=page.waitForEvent('download');
      await page.getByRole('menuitem',{name:'Lab D50 · TIFF（白底）'}).click();
      const labFile=path.join(data,'mural-Lab.tif'),labResult=await labDownload;
      assert.match(labResult.suggestedFilename(),/-lab\.tif$/);await labResult.saveAs(labFile);
      execFileSync(pythonExecutable(),['-B','-c',`import sys
from io import BytesIO
from PIL import Image,ImageCms
from image_color_spaces import profile_bytes
im=Image.open(sys.argv[1])
assert im.size==(63,31) and im.mode=='LAB' and im.tag_v2[262]==8
assert ImageCms.ImageCmsProfile(BytesIO(im.info['icc_profile'])).profile.xcolor_space.strip()=='Lab'
expected=ImageCms.profileToProfile(Image.new('RGB',im.size,(0,255,0)),BytesIO(profile_bytes('acescg')),ImageCms.createProfile('LAB'),outputMode='LAB',renderingIntent=1)
assert im.tobytes()==expected.tobytes()
`,labFile],{cwd:new URL('..',import.meta.url)});
      const [placeLab]=await Promise.all([page.waitForEvent('filechooser'),editor.getByRole('button',{name:'导入图片至画布'}).click()]);
      await placeLab.setFiles(labFile);await saved('重新置入 Lab D50 三通道 TIFF');
      const labLayer=Object.values(doc.paint.imageDocuments)[0].layers.find(layer=>layer.kind==='image');
      const labAsset=doc.paint.assets[labLayer.asset];
      execFileSync(pythonExecutable(),['-B','-c',`import sys
from io import BytesIO
from PIL import Image,ImageCms
from image_color_spaces import profile_bytes
im=Image.open(sys.argv[1]); placed=Image.open(sys.argv[2])
expected=ImageCms.profileToProfile(im,BytesIO(im.info['icc_profile']),BytesIO(profile_bytes('acescg')),outputMode='RGB',renderingIntent=1)
assert placed.mode=='RGB' and placed.size==expected.size and placed.tobytes()==expected.tobytes()
`,labFile,path.join(data,'projects',doc.id,'assets',labAsset.file)],{cwd:new URL('..',import.meta.url)});
      await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销置入 Lab TIFF');
      if(profiles.some(([,mode])=>mode==='CMYK')){
        const fileName=path.join(data,'proof-CMYK.tif');
        const [chooser]=await Promise.all([page.waitForEvent('filechooser'),editor.getByRole('button',{name:'导入图片至画布'}).click()]);
        await chooser.setFiles(fileName);await saved('将印刷 TIFF 回置到同一份原稿');
        const placed=Object.values(doc.paint.imageDocuments)[0].layers.find(l=>l.kind==='image');
        assert.equal(placed.scale,63/4096);
        const asset=doc.paint.assets[placed.asset];
        execFileSync(pythonExecutable(),['-B','-c',`import sys
from io import BytesIO
from PIL import Image,ImageCms
from image_color_spaces import profile_bytes
im=Image.open(sys.argv[1]);result=Image.open(sys.argv[2]);target=profile_bytes('acescg')
expected=ImageCms.profileToProfile(im,BytesIO(im.info['icc_profile']),BytesIO(target),outputMode='RGB',renderingIntent=1)
assert result.size==(63,31) and result.info['icc_profile']==target and result.tobytes()==expected.tobytes()`,
          fileName,path.join(data,'projects',doc.id,'assets',asset.file)],{cwd:new URL('..',import.meta.url)});
        await page.reload();await editor.locator('.document-image-stage[data-preview-revision="'+doc.revision+'"]').waitFor();
        await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销置入印刷 TIFF');
        assert.ok(!Object.values(doc.paint.imageDocuments)[0].layers.some(l=>l.id===placed.id));
        console.log('PASS 实际导出的 CMYK TIFF 回置至 ACEScg、原尺寸、独立转换像素与撤销重开');
      }
    }
    await checkDisplay();
    await page.reload();await checkDisplay();
    assert.equal((await api(route)).paint.imageDocuments[Object.keys(doc.paint.imageDocuments)[0]].colorSpace,colorSpace);
    await canvas.focus();await page.keyboard.press(mod+'+z');await saved('一次撤销整张图像');
    assert.equal(Object.keys(doc.paint.imageDocuments??{}).length,0);
  }
  await editor.getByRole('button',{name:'创建第一个图像文档'}).click();
  await dialog.getByRole('button',{name:/横幅/}).click();
  assert.equal(await dialog.getByRole('button',{name:/横幅/}).getAttribute('aria-pressed'),'true');
  await height.fill('500');
  assert.equal(await dialog.getByRole('button',{name:/横幅/}).getAttribute('aria-pressed'),'false');
  await height.fill('512');
  await dialog.getByLabel('名称',{exact:true}).fill('横幅样稿');
  await dialog.getByRole('button',{name:'创建',exact:true}).click();await saved('创建横幅');
  const documentId=Object.keys(doc.paint.imageDocuments)[0],image=()=>doc.paint.imageDocuments[documentId];
  assert.equal(image().name,'横幅样稿');assert.equal(image().colorSpace,'srgb');
  const pixelId=image().layers[0].id;
  // Wait for the selected document frame, not a preview left from the previous revision.
  const detailed=()=>editor.locator('.document-image-stage[data-preview-size="4096"][data-preview-revision="'+doc.revision+'"]').waitFor({timeout:65000});
  await detailed();
  assert.deepEqual(await canvas.evaluate(c=>[c.width,c.height]),[2048,512]);
  async function point(x,y){
    const b=await canvas.boundingBox();
    return [b.x+b.width*x/2048,b.y+b.height*y/512];
  }
  async function dot(x,y){
    await page.mouse.click(...await point(x,y));await saved('写入像素 '+x+','+y);
  }
  await editor.getByRole('button',{name:'画笔',exact:true}).click();
  await dot(32,256);await dot(1980,455);
  await stack.getByRole('button',{name:'添加蒙版',exact:true}).click();await saved('添加图层蒙版');
  await editor.locator('.document-edit-target').getByText('蒙版',{exact:true}).waitFor();
  await dot(2004,455);
  await stack.locator('[data-image-layer-id="'+pixelId+'"] .document-layer-select').click();
  await editor.getByRole('button',{name:'文字工具',exact:true}).click();
  await page.mouse.click(...await point(300,160));
  const input=editor.getByRole('textbox',{name:'画布文字',exact:true});
  await input.fill('BANNER 01');await input.press(mod+'+Enter');await saved('创建可编辑文字');
  await editor.getByRole('button',{name:'形状工具',exact:true}).click();
  await editor.getByRole('button',{name:'形状类型',exact:true}).click();
  await page.getByRole('option',{name:'椭圆',exact:true}).click();
  await page.mouse.move(...await point(1200,128));await page.mouse.down();
  await page.mouse.move(...await point(1456,384),{steps:6});await page.mouse.up();await saved('绘制圆');
  const originalLayers=structuredClone(image().layers);
  assert.ok(originalLayers.some(l=>l.shape?.kind==='ellipse'));
  assert.ok(originalLayers.some(l=>l.text?.content==='BANNER 01'));
  assert.ok(originalLayers.find(l=>l.id===pixelId).maskEnabled);
  async function png(name){
    await detailed();
    const dl=page.waitForEvent('download');
    await editor.getByRole('button',{name:'导出当前图像 PNG'}).click();
    await (await dl).saveAs(path.join(data,name+'.png'));
  }
  async function size(menu,fields,anchor){
    await editor.getByRole('button',{name:'图像尺寸操作',exact:true}).click();
    await page.getByRole('option',{name:menu,exact:true}).click();
    for(const [name,value] of fields)await dialog.getByLabel(name+'（像素）').fill(String(value));
    if(anchor)await dialog.getByRole('button',{name:anchor,exact:true}).click();
    await dialog.getByRole('button',{name:'应用',exact:true}).click();await saved(menu);
  }
  const thumbnail=stack.locator('[data-image-layer-id="'+pixelId+'"] .document-layer-thumb');
  await until(()=>thumbnail.evaluate(c=>c.width===64&&c.height===16),'横幅图层缩略图');
  await png('original');
  await size('画布尺寸…',[['宽度',2304]],'左中');await png('extended');
  await editor.getByRole('button',{name:'图像尺寸操作',exact:true}).click();
  await page.getByRole('option',{name:'裁切…',exact:true}).click();
  const cropBox=await dialog.locator('.image-crop-preview').boundingBox();
  await page.mouse.move(cropBox.x+8,cropBox.y+10);await page.mouse.down();
  await page.mouse.move(cropBox.x+cropBox.width-16,cropBox.y+cropBox.height-6,{steps:4});await page.mouse.up();
  const firstWidth=Number(await dialog.getByLabel('宽度（像素）').inputValue());
  const handle=await dialog.locator('[data-edge=e]').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();
  await page.mouse.move(handle.x-24,handle.y+handle.height/2,{steps:4});await page.mouse.up();
  assert.ok(Number(await dialog.getByLabel('宽度（像素）').inputValue())<firstWidth);
  await dialog.getByRole('button',{name:'取消'}).click();
  assert.equal((await api(route)).revision,doc.revision);
  await size('裁切…',[['左边距',128],['宽度',2176]]);await png('cut');
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销裁切');
  assert.equal(image().width,2304);await png('undo');
  await canvas.focus();await page.keyboard.press(mod+'+Shift+z');await saved('重做裁切');
  await size('画布尺寸…',[['宽度',2304]],'右中');await png('restored');
  await size('图像尺寸…',[['宽度',1152]]);assert.equal(image().height,256);await png('half');
  await page.reload();await detailed();await png('reopened');
  assert.deepEqual(await canvas.evaluate(c=>[c.width,c.height]),[1152,256]);
  await editor.getByRole('button',{name:'实际像素',exact:true}).click();
  assert.match(await editor.locator('.document-status-bar').innerText(),/100.0%.*1152 × 256/);
  await editor.getByRole('button',{name:'适应画布',exact:true}).click();
  await editor.screenshot({path:path.join(data,'banner-workspace.png')});
  const display=await canvas.evaluate(c=>c.toDataURL('image/png').split(',')[1]);
  await fs.writeFile(path.join(data,'canvas.png'),Buffer.from(display,'base64'));
  assert.deepEqual((await api(route)).paint.imageDocuments[documentId].layers,originalLayers);
  execFileSync(pythonExecutable(),['-c',`from PIL import Image
import numpy as np, sys, os
def load(n): return np.asarray(Image.open(os.path.join(sys.argv[1],n+'.png')))
src,ext,cut=map(load,['original','extended','cut'])
assert src.shape==(512,2048,4) and src[455,1968,3]>0 and src[455,1980,3]==0 and src[256,32,3]>0
assert ext.shape==(512,2304,4) and np.array_equal(ext[:,:2048],src) and not ext[:,2048:,3].any()
assert np.array_equal(cut,ext[:,128:])
assert np.array_equal(load('undo'),ext) and np.array_equal(load('restored'),ext)
half=load('half')
assert half.shape==(256,1152,4) and np.array_equal(half,load('reopened'))
canvas=load('canvas')
assert np.array_equal(half[:,:,3],canvas[:,:,3])
assert np.array_equal(np.asarray(Image.fromarray(half).convert('RGBa')),np.asarray(Image.fromarray(canvas).convert('RGBa')))
assert np.array_equal(half,np.asarray(Image.fromarray(ext).resize((1152,256),Image.Resampling.BICUBIC)))
`,data],{stdio:'inherit'});
  await editor.getByRole('button',{name:'图像尺寸操作',exact:true}).click();
  await page.getByRole('option',{name:'图像尺寸…',exact:true}).click();
  await dialog.getByLabel('锁定宽高比').uncheck();
  await dialog.getByLabel('宽度（像素）').fill('256');await dialog.getByLabel('高度（像素）').fill('512');
  await dialog.getByRole('button',{name:'应用',exact:true}).click();await saved('分别缩放宽高为竖图');
  await detailed();assert.deepEqual(await canvas.evaluate(c=>[c.width,c.height]),[256,512]);
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销非等比缩放');await detailed();
  const title=image().layers.find(layer=>layer.text);
  await stack.locator('[data-image-layer-id="'+title.id+'"] .document-layer-select').click();
  await page.locator('[data-editor=imageProperties]').first().getByRole('button',{name:'编辑文字…',exact:true}).click();
  const textDialog=page.getByRole('dialog',{name:'编辑文字',exact:true});
  await textDialog.locator('textarea').fill('BANNER 02');
  await textDialog.getByRole('button',{name:'应用',exact:true}).click();await saved('缩放后重开并修改标题');
  assert.equal(image().layers.find(layer=>layer.id===title.id).text.content,'BANNER 02');
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销标题修改');
  assert.deepEqual(image().layers,originalLayers);
  const profilePicker=page.getByRole('button',{name:'图像颜色空间',exact:true});
  await profilePicker.click();await page.getByRole('option',{name:'Display P3',exact:true}).click();
  await saved('将已有文档指定为 Display P3');assert.equal(image().colorSpace,'display-p3');
  await canvas.focus();await page.keyboard.press(mod+'+z');await saved('撤销指定空间');assert.equal(image().colorSpace,'srgb');
  await page.keyboard.press(mod+'+Shift+z');await saved('重做指定空间');assert.equal(image().colorSpace,'display-p3');
  await editor.getByRole('button',{name:'应用至材质',exact:true}).click();await saved('绑定非方形颜色通道');
  await page.locator('[data-area-mode=material]').click();
  await page.locator('.editor-viewport[data-rendered-paint-revision="'+doc.revision+'"][data-rendered-paint-resolution="4096"]').first().waitFor({timeout:90000});
  const preview=await fetch(base+paint+'/live',{method:'POST',headers,body:JSON.stringify({revision:doc.revision,resolution:256,format:'pbr8'})});
  assert.equal(preview.status,200);
  await fs.writeFile(path.join(data,'preview.raw'),Buffer.from(await preview.arrayBuffer()));
  const job=await api(paint+'/preview',{requestId:'banner-color',revision:doc.revision},202);
  const bake=await until(async()=>{
    const j=await api(route+'/jobs/'+job.id);if(j.status==='failed')throw Error(j.error);
    return j.status==='completed'&&j;
  },'非方形文档烘焙');
  const baked=await fetch(new URL(bake.colorUrl,base));assert.equal(baked.status,200);
  await fs.writeFile(path.join(data,'bake.png'),Buffer.from(await baked.arrayBuffer()));
  execFileSync(pythonExecutable(),['-c',`from PIL import Image
import numpy as np, sys, os
p=sys.argv[1]
live=np.fromfile(os.path.join(p,'preview.raw'),dtype=np.uint8).reshape(256,256,15)
baked=np.asarray(Image.open(os.path.join(p,'bake.png')))
assert baked.shape[:2]==(4096,4096)
# Interior of circle, transparent extension, and surviving ink at lower right.
colors=[]
for x,y in [(147,128),(249,220),(218,227),(3,128)]:
    a=live[y,x,:3];b=baked[y*16+8,x*16+8,:3]
    print('UV',x,y,'live',a,'bake',b)
    assert np.max(np.abs(a.astype(int)-b.astype(int)))<=1
    colors.append(tuple(b))
assert len(set(colors))>=2`,data],{stdio:'inherit'});
  const backup=await api(paint+'/backup',{requestId:'banner-editable',revision:doc.revision},202);
  const packed=await until(async()=>{
    const j=await api(route+'/jobs/'+backup.id);if(j.status==='failed')throw Error(j.error);
    return j.status==='completed'&&j;
  },'保存可重新打开的横幅工程');
  const archive=await fetch(new URL(packed.archiveUrl,base));assert.equal(archive.status,200);
  const bytes=Buffer.from(await archive.arrayBuffer());
  await fs.writeFile(path.join(data,'banner-project.zip'),bytes);
  const imported=await fetch(base+'/api/projects/paint-import',{method:'POST',headers:{Origin:base,'Content-Type':'application/zip'},body:bytes});
  const restored=await imported.json();assert.equal(imported.status,201,JSON.stringify(restored).slice(0,180));
  assert.deepEqual(restored.paint.imageDocuments[documentId],image());
  assert.deepEqual(errors,[]);
  console.log('PASS banner PNG pixels, transparency, mark, circle, editable layers, history and reopen',data);
}finally{
  try{await browser?.close();}finally{
    if(server.exitCode===null&&server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
  }
}
