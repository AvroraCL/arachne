import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {defaultLibraryMaterial} from '../public/paint-library.mjs';
import {chromium} from 'playwright-core';
import {menuShortcut} from '../public/menu-shortcut.mjs';

assert.equal(menuShortcut('Mod+Alt+Shift+E','MacIntel'),'⇧⌥⌘E');
assert.equal(menuShortcut('Mod+Alt+Shift+E','Win32'),'Ctrl+Alt+Shift+E');

const data=await fs.mkdtemp(path.join(os.tmpdir(),'arachne-workspaces-'));
const evidence=process.env.ARACHNE_WORKSPACE_SCREENSHOTS||data;
await fs.mkdir(evidence,{recursive:true});
const socket=net.createServer().listen(0,'127.0.0.1');
await once(socket,'listening');
const {port}=socket.address();
await new Promise(resolve=>socket.close(resolve));
const origin='http://127.0.0.1:'+port,headers={Origin:origin,'Content-Type':'application/json'};
const server=spawn(process.execPath,['server.mjs','--port',String(port)],{cwd:new URL('..',import.meta.url),windowsHide:true,
  env:{...process.env,ARACHNE_DATA_DIR:data,ARACHNE_ALLOW_EXTERNAL_DATA:'1',ARACHNE_BLENDER:path.join(data,'no-blender')}});
let browser,logs='';
for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-8000);});
async function until(read,label,timeout=25000){
  for(const end=Date.now()+timeout;Date.now()<end;){
    const result=await read();if(result)return result;await delay(100);
  }
  throw Error('等待超时：'+label);
}
async function api(route,body){
  const response=await fetch(origin+route,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});
  const json=await response.json();assert.ok(response.ok,JSON.stringify(json));return json;
}
try{
  await until(()=>fetch(origin+'/api/health').then(response=>response.ok,()=>false),'本机服务');
  const project=await api('/api/projects',{workflowType:'pbr_paint',modelTemplate:'cube',name:'高分辨率工业外壳与防护涂层测试工程'});
  const route='/api/projects/'+project.id,paint=route+'/paint',documentId='detail-color',layerId='stripe';
  await api(paint+'/commands',{revision:project.revision,operations:[
    ...['灰蓝色防护涂层与拉丝金属表面 · 样张 A','橙色维护标识 · 样张 B'].map((name,index)=>({
      op:'library',action:'create',library:'materials',id:'sample-'+index,patch:{name,graph:defaultLibraryMaterial()}
    })),
    {op:'add',kind:'fill',patch:{name:'深海蓝 · 抗氧化半哑光金属底漆',values:{color:'#26415f',metallic:.64,roughness:.38}}},
    {op:'image',action:'create',documentId,patch:{name:'外壳颜色贴图 · 主涂装工作样张'}},
    {op:'image',action:'addLayer',documentId,layerId,kind:'pixel',patch:{name:'橙色标记条纹与细节修正图层'}},
    {op:'image',action:'stroke',documentId,layerId,target:'pixels',stroke:{uv:true,rect:[.2,.45,.8,.55],color:'#dda14d',opacity:1,erase:false}}
  ]});
  browser=await chromium.launch({executablePath:process.env.ARACHNE_BROWSER,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:940},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/?project='+project.id);
  await page.evaluate(()=>document.fonts.ready);
  const viewport=page.locator('.editor-viewport[data-state=ready]').first();
  const canvas=page.getByLabel('图像文档画布',{exact:true}).first();
  const library=page.locator('.editor-area[data-editor=library]').first();
  const shelf=name=>library.getByRole('tab',{name,exact:true});
  const scope=library.getByRole('button',{name:'资源库范围',exact:true});
  const resourceSearch=library.getByRole('searchbox',{name:'搜索资源',exact:true});
  async function show(workspace){
    await page.locator('[data-area-mode='+workspace+']').click();
    if(workspace==='drawing'){
      await canvas.waitFor();
      await page.getByRole('button',{name:'画笔',exact:true}).first().click();
      await page.locator('.document-image-stage[data-preview-size="4096"]').first().waitFor({timeout:30000});
    }else await viewport.waitFor();
  }
  const list=page.getByRole('listbox');
  const trigger=(area,name)=>area.getByRole('button',{name,exact:true});
  const hasFocus=control=>control.evaluate(element=>element===document.activeElement);
  async function exerciseMenu(control,choice,previous,size){
    const name=await control.getAttribute('aria-label');
    await control.click();
    await list.getByRole('option',{name:choice,exact:true}).click();
    assert.ok(await hasFocus(control),name+' returns mouse selection to its trigger');
    await control.press('ArrowDown');
    const selected=list.locator('[role=option][aria-selected=true]');
    assert.equal(await selected.getAttribute('aria-label'),choice);
    assert.equal(await selected.locator('.select-option-check:visible').count(),1);
    await page.keyboard.press('ArrowUp');
    assert.equal(await list.locator('.active').getAttribute('aria-label'),previous);
    assert.equal(await list.locator('.select-option-check:visible').count(),1);
    const active=list.locator('.custom-select-option.active');
    if(name==='变换工具'){
      const offsets=await active.evaluate(row=>{
        const r=row.getBoundingClientRect(),label=row.querySelector('.select-option-label').getBoundingClientRect();
        return [Math.round(label.left-r.left),Math.round(r.right-row.querySelector('kbd').getBoundingClientRect().right),r.height];
      });
      assert.deepEqual(offsets,[30,7,28],'transform picker and context commands share the same columns');
    }
    assert.notEqual(await active.evaluate(row=>getComputedStyle(row).backgroundColor),
      await selected.evaluate(row=>getComputedStyle(row).backgroundColor),name+' separates the next choice from the saved value');
    await list.screenshot({path:path.join(evidence,size+'-'+name+'.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    assert.ok(await hasFocus(control),name+' preserves focus on cancel');
    assert.equal(await control.getAttribute('aria-description'),choice);
    await control.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    assert.ok(await hasFocus(control),name+' preserves focus on keyboard confirmation');
    assert.equal(await control.getAttribute('aria-description'),previous);
  }
  async function checkVisiblePickers(root){
    for(const button of await root.locator('.custom-select-button:visible:enabled').all()){
      if(!await button.evaluate(el=>el.previousElementSibling.options.length))continue;
      await button.press('ArrowDown');
      const chosen=list.locator('[role=option][aria-selected=true]:enabled');
      if(await chosen.count())assert.equal(await chosen.locator('.select-option-check:visible').count(),1);
      await page.keyboard.press('Escape');
      assert.ok(await hasFocus(button),await button.getAttribute('aria-label'));
    }
  }
  async function checkMapDialog(size){
    await trigger(library,'从贴图创建材质').click();
    const dialog=page.getByRole('dialog',{name:'从贴图创建材质'});
    const files=await Promise.all(['../public/arachne-icon.png','../../../examples/mavic-4-pro-studio/calibration-mark.png']
      .map(name=>fs.readFile(new URL(name,import.meta.url))));
    const prefix=size+'_工业设备维护标记与保护涂层_面板左侧';
    await dialog.getByLabel('导入材质贴图').setInputFiles(['BaseColor','Albedo'].map((suffix,index)=>({
      name:prefix+'_'+suffix+'.png',mimeType:'image/png',buffer:files[index]
    })));
    await dialog.getByRole('status').filter({hasText:'项待选择'}).waitFor();
    const color=trigger(dialog,'颜色');
    await color.click();
    const candidate=list.locator('.select-option-with-detail').first();
    const plain=list.locator('[role=option]').first();
    assert.ok(await candidate.locator('img').count());
    assert.ok(await candidate.locator('.select-option-label').evaluate(label=>label.scrollWidth<=label.clientWidth),
      'The full candidate filename can be read inside the menu');
    const start=locator=>locator.evaluate(el=>el.getBoundingClientRect().left);
    assert.ok(Math.abs(await start(plain.locator('.select-option-label'))-await start(candidate.locator('.select-option-label')))<1);
    const chosenName=await candidate.getAttribute('aria-label');
    await candidate.click();await color.press('ArrowDown');
    assert.equal(await list.locator('[aria-selected=true]').getAttribute('aria-label'),chosenName);
    await list.screenshot({path:path.join(evidence,size+'-map-picker.png'),animations:'disabled'});
    await page.keyboard.press('Escape');assert.ok(await hasFocus(color));
    await checkVisiblePickers(dialog);
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
  }
  async function contextPreview(target,size,workspace){
    await target.click({button:'right'});
    const menu=page.getByRole('menu').filter({visible:true}),rows=menu.locator('[role=menuitem]:enabled');
    await rows.nth(1).hover();
    assert.ok(await hasFocus(rows.nth(1)),workspace+' hover moves the keyboard cursor');
    const hoverFill=await rows.nth(1).evaluate(row=>getComputedStyle(row).backgroundColor);
    await page.keyboard.press('ArrowDown');
    assert.ok(await hasFocus(rows.nth(2)),workspace+' keyboard navigation starts at the hovered command');
    assert.equal(await rows.nth(2).evaluate(row=>getComputedStyle(row).backgroundColor),hoverFill);
    assert.notEqual(await rows.nth(1).evaluate(row=>getComputedStyle(row).backgroundColor),hoverFill);
    const layout=await menu.getByRole('menuitem').evaluateAll(items=>items.map(item=>{
      const row=item.getBoundingClientRect(),label=item.querySelector('.scene-menu-label').getBoundingClientRect();
      const kbd=item.querySelector('kbd').getBoundingClientRect();
      return [Math.round(label.left-row.left),Math.round(row.right-kbd.right),row.height];
    }));
    assert.ok(layout.every(([left,right,height])=>left===30&&right===7&&height>=28),workspace+' command columns');
    const bounds=await menu.boundingBox(),view=page.viewportSize();
    assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=view.width&&bounds.y+bounds.height<=view.height);
    await rows.nth(1).hover();
    await menu.screenshot({path:path.join(evidence,size+'-'+workspace+'-context.png'),animations:'disabled'});
    if(workspace==='drawing'){
      const platform=await page.evaluate(()=>navigator.platform);
      assert.equal(await menu.getByRole('menuitem',{name:'盖印可见图层'}).locator('kbd').textContent(),menuShortcut('Mod+Alt+Shift+E',platform));
      await page.screenshot({path:path.join(evidence,'drawing-menu-'+size+'.png'),animations:'disabled'});
    }
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'hidden'});
  }
  async function checkSearch(input){
    const read=()=>input.evaluate(el=>{
      const field=el.closest('.editor-search-field'),css=getComputedStyle(field);
      return [field.getBoundingClientRect().height,css.backgroundImage,css.paddingLeft,css.borderTopColor,getComputedStyle(el).outlineStyle];
    });
    await input.blur();await page.mouse.move(0,0);
    const rest=await read();
    await input.hover();const hover=await read();
    await input.fill('搜索测试');const focus=await read();
    assert.notEqual(hover[3],rest[3],await input.getAttribute('aria-label')+' hover');assert.notEqual(focus[3],hover[3]);
    assert.equal(focus[4],'none','only the search field edge indicates focus');
    await input.fill('');await input.blur();
    return [rest,hover,focus];
  }
  async function menuAndSelection(size){
    await show('modeling');
    const model=page.locator('.editor-area[data-editor=viewport]').first();
    const header=model.locator(':scope > .area-header');
    await page.mouse.move(0,0);
    const surface=button=>button.evaluate(el=>{
      const style=getComputedStyle(el);
      return [el.getBoundingClientRect().height,style.backgroundColor,style.backgroundImage,style.borderRadius];
    });
    const more=header.locator('.area-menu>summary');
    const plain=()=>more.evaluate(el=>[getComputedStyle(el).backgroundColor,getComputedStyle(el).color]);
    const idle=await plain();assert.equal(idle[0],'rgba(0, 0, 0, 0)');
    await more.hover();assert.deepEqual(await plain(),idle);
    await more.click();assert.ok(await more.evaluate(el=>el.parentElement.open));assert.deepEqual(await plain(),idle);
    await page.keyboard.press('Escape');
    const outline=page.getByRole('searchbox',{name:'搜索物体',exact:true}),properties=page.getByRole('searchbox',{name:'搜索当前属性',exact:true});
    const left=input=>input.evaluate(el=>el.closest('.editor-search-field').getBoundingClientRect().left);
    assert.ok(Math.abs(await left(outline)-await left(properties))<2,'sidebar searches share a leading edge');
    const searchStyle=await checkSearch(outline);assert.deepEqual(await checkSearch(properties),searchStyle);
    await properties.focus();await page.screenshot({path:path.join(evidence,size+'-header-search.png')});await properties.blur();
    const strip=await header.locator('.editor-toolbar.area-header-controls').evaluate(el=>{
      const style=getComputedStyle(el);
      return [style.backgroundColor,style.borderBottomWidth];
    });
    assert.deepEqual(strip,['rgba(0, 0, 0, 0)','0px'],size+' controls blend into the viewport header');
    const reference=await surface(trigger(header,'交互模式'));
    assert.notEqual(reference[2],'none','Collapsed menus advertise that they can expand');
    for(const picker of await page.getByRole('button',{name:'编辑器类型',exact:true}).all()){
      const style=await picker.evaluate(button=>{
        const css=getComputedStyle(button),arrow=getComputedStyle(button,'::after');
        return [button.offsetWidth,css.backgroundColor,css.backgroundImage,arrow.width,arrow.borderRightWidth];
      });
      assert.deepEqual(style,[30,'rgba(0, 0, 0, 0)','none','4px','1px'],size+' compact editor switcher');
    }
    for(const name of ['建模选择','变换工具','变换坐标系','变换枢轴','三维游标','操纵器设置','叠加层设置','着色设置'])
      assert.deepEqual(await surface(trigger(header,name)),reference,size+' collapsed '+name);
    assert.equal(await trigger(header,'框选').evaluate(el=>getComputedStyle(el).backgroundImage),'none');
    const pressed=header.locator('.viewport-display-button[aria-pressed=true]').first();
    const chrome=await pressed.evaluate(button=>({
      pressed:getComputedStyle(button).backgroundColor,
      textSelection:getComputedStyle(button,'::selection').backgroundColor
    }));
    for(const [state,color] of Object.entries(chrome))
      assert.match(color,/^rgba?\((\d+), \1, \1(?:, [\d.]+)?\)$/,size+' '+state+' '+color);
    await header.screenshot({path:path.join(evidence,size+'-viewport-header.png'),animations:'disabled'});
    await contextPreview(page.getByRole('button',{name:'立方体',exact:true}),size,'modeling');
    const selectMenu=trigger(header,'建模选择');
    await selectMenu.click();
    assert.equal(await selectMenu.getAttribute('aria-expanded'),'true');
    assert.equal((await surface(selectMenu))[2],reference[2],'The disclosure arrow persists on hover and open');
    await page.keyboard.press('Escape');
    assert.equal(await selectMenu.getAttribute('aria-expanded'),'false');
    await exerciseMenu(trigger(model,'变换工具'),'旋转','移动',size);
    const nodeArea=page.locator('.editor-area[data-editor=shader]').first();
    const id=await nodeArea.getAttribute('data-area-id');
    const area=page.locator('[data-area-id="'+id+'"].editor-area');
    await exerciseMenu(trigger(area,'编辑器类型'),'材质图层','材质节点编辑器',size);
    await model.locator('summary[aria-label="着色设置"]').press('ArrowDown');
    await until(()=>hasFocus(trigger(model,'视口材质通道')),'focus visible channel picker');
    await exerciseMenu(trigger(model,'视口材质通道'),'颜色','完整材质',size);
    await page.keyboard.press('Escape');
    await show('material');
    const stack=page.locator('.editor-area[data-editor=layers]').first(),filter=trigger(stack,'图层栈通道');
    assert.deepEqual(await checkSearch(resourceSearch),searchStyle);
    const layerSearch=page.locator('#layer-search');
    await page.locator('#toggle-layer-search').click();assert.deepEqual(await checkSearch(layerSearch),searchStyle);await page.locator('#toggle-layer-search').click();
    await exerciseMenu(filter,'颜色','全部通道',size);
    for(const button of [filter,trigger(stack,'图层混合模式')])
      assert.ok(await button.evaluate(el=>el.scrollWidth<=el.clientWidth),
        size+' '+await button.getAttribute('aria-label')+' '+await button.evaluate(el=>[el.clientWidth,el.scrollWidth]));
    const tileA=library.locator('[data-resource-id=sample-0]'),tileB=library.locator('[data-resource-id=sample-1]');
    await tileA.click();await tileB.hover();
    const layer=page.locator('.editor-area[data-editor=layers] :is(.editor-layer-name,.layer-select)').first();
    const tabStops=await page.locator('button:visible:enabled,input:visible:enabled,[tabindex="0"]:visible,summary:visible').count();
    for(let tab=0;tab<tabStops&&!await hasFocus(layer);tab++)await page.keyboard.press('Tab');
    assert.equal(await tileA.getAttribute('aria-pressed'),'true');
    assert.equal(await tileB.getAttribute('aria-pressed'),'false');
    assert.ok(await tileB.evaluate(b=>b.matches(':hover')));
    assert.ok(await layer.evaluate(b=>b.matches(':focus-visible')));
    assert.ok(await hasFocus(layer));
    await library.screenshot({path:path.join(evidence,size+'-resources.png')});
    await page.screenshot({path:path.join(evidence,size+'-layer-focus.png')});
    await layer.press('Enter');
    assert.equal(await layer.getAttribute('aria-pressed'),'true');
    assert.ok(await hasFocus(layer),'selecting the layer keeps keyboard focus in its row');
    await contextPreview(layer,size,'material');
    await show('drawing');
    const imageFilter=page.getByRole('button',{name:'筛选图像图层',exact:true});await imageFilter.click();
    assert.deepEqual(await checkSearch(page.getByRole('searchbox',{name:'搜索图像图层',exact:true})),searchStyle);await imageFilter.click();
  }
  for(const [size,dimensions] of [['wide',{width:1440,height:940}],['narrow',{width:900,height:630}]]){
    await page.setViewportSize(dimensions);
    await menuAndSelection(size);
    const statusHeights=[];
    for(const workspace of ['modeling','material','drawing']){
      await show(workspace);
      if(workspace==='drawing')assert.equal(await shelf('图片').getAttribute('aria-selected'),'true');
      if(workspace==='material')assert.equal(await shelf('材质').getAttribute('aria-selected'),'true');
      await checkVisiblePickers(page.locator('#workspace'));
      const widths=await page.evaluate(()=>({document:document.documentElement.scrollWidth,window:innerWidth}));
      assert.ok(widths.document<=widths.window);
      const statuses=page.locator(':is(.document-status-bar,.editor-preview-status,.shader-status,.editor-scene-footer):visible');
      statusHeights.push(...await statuses.evaluateAll(bars=>bars.map(bar=>bar.getBoundingClientRect().height)));
      if(workspace==='drawing'){
        await contextPreview(page.locator('.document-layer-name:visible').first(),size,'drawing');
        const fit=await page.locator('.document-layer-actions:visible').first().evaluate(bar=>{
          const bounds=bar.getBoundingClientRect();
          return [...bar.querySelectorAll('button')].every(button=>{
            const r=button.getBoundingClientRect();
            return r.width>0&&r.left>=bounds.left&&r.right<=bounds.right+.5&&r.bottom<=bounds.bottom+.5;
          });
        });
        assert.ok(fit,'all eight layer actions fit inside the footer');
        await page.getByRole('button',{name:'图像尺寸操作',exact:true}).click();
        await page.getByRole('option',{name:'画布尺寸…',exact:true}).click();
        const dialog=page.getByRole('dialog',{name:'画布尺寸',exact:true});
        const left=dialog.getByRole('button',{name:'左中',exact:true});
        await left.click();
        assert.equal(await left.getAttribute('aria-pressed'),'true');
        await dialog.getByLabel('宽度（像素）').focus();
        await page.mouse.move(0,0);
        const footer=await dialog.locator('footer').boundingBox(),apply=await dialog.getByRole('button',{name:'应用',exact:true}).boundingBox();
        assert.ok(apply.y>footer.y&&apply.y+apply.height<footer.y+footer.height,'dialog actions fit inside the footer');
        const fills=await dialog.locator('.image-anchor-grid button').evaluateAll(buttons=>new Set(buttons.map(b=>getComputedStyle(b).backgroundColor)).size);
        assert.ok(fills>1,'selected anchor has a visible fill');
        await dialog.screenshot({path:path.join(evidence,'canvas-size-'+size+'.png')});
        await dialog.getByRole('button',{name:'取消',exact:true}).click();
      }else if(workspace==='material'){
        const settings=page.locator('#drawing-layer-settings:visible');
        const mode=await settings.locator('.custom-select-button').boundingBox();
        const opacity=await settings.locator('label').boundingBox();
        assert.ok(Math.abs((mode.y+mode.height/2)-(opacity.y+opacity.height/2))<2,'blend and opacity share one row');
        const sets=page.locator('.texture-set-editor:visible').first(),toggle=sets.getByRole('button',{name:'纹理集',exact:true});
        await toggle.click();
        await sets.getByRole('button',{name:'纹理集材质槽',exact:true}).waitFor();
        const fields=sets.locator('fieldset');
        await fields.waitFor();
        const mask=fields.locator('details').filter({has:page.locator('canvas')});
        await mask.locator('summary').click();
        assert.equal(await mask.locator('canvas').isVisible(),false);
        await mask.locator('summary').press('Enter');
        await mask.locator('canvas').scrollIntoViewIfNeeded();
        const title=await toggle.boundingBox(),body=await sets.locator('.texture-set-body').boundingBox();
        assert.ok(title.y+title.height<=body.y+1,'active material slot stays visible while scrolling settings');
        assert.ok((await sets.locator('[data-slot-caption]').innerText()).trim());
        await sets.locator('.texture-set-body').evaluate(el=>{el.scrollTop=0;});
        await sets.screenshot({path:path.join(evidence,'texture-sets-'+size+'.png')});
        await toggle.click();
      }
      await page.screenshot({path:path.join(evidence,workspace+'-'+size+'.png')});
    }
    assert.ok(statusHeights.length>=4);
    assert.equal(new Set(statusHeights).size,1,'status bars have the same rendered height');
  }
  const imageEditor=page.locator('.editor-area[data-editor=image]').first();
  const toolOptions=imageEditor.getByRole('group',{name:'图像工具选项',exact:true});
  const measureToolbar=()=>toolOptions.evaluate(control=>({height:control.clientHeight,top:control.getBoundingClientRect().top}));
  const brushGeometry=await measureToolbar();
  for(const tool of ['橡皮擦','矩形选区','多边形套索','渐变工具','形状工具','抓手','画笔']){
    await imageEditor.getByRole('button',{name:tool,exact:true}).click();
    assert.deepEqual(await measureToolbar(),brushGeometry,tool+' must not resize the toolbar');
  }
  const tip=imageEditor.getByRole('button',{name:'笔尖参数',exact:true});
  await tip.click();
  const tipOptions=imageEditor.getByRole('dialog',{name:'笔尖参数',exact:true});
  await tipOptions.waitFor();
  await tipOptions.getByRole('spinbutton',{name:'流量',exact:true}).waitFor();
  await page.screenshot({path:path.join(evidence,'drawing-narrow-brush-tip.png')});
  await page.keyboard.press('Escape');
  await tipOptions.waitFor({state:'hidden'});
  const modifier=process.platform==='darwin'?'Meta':'Control';
  await canvas.focus();await page.keyboard.press(modifier+'+a');await page.keyboard.press(modifier+'+t');
  await toolOptions.locator('.document-current-tool').filter({hasText:'自由变换'}).waitFor();
  assert.deepEqual(await measureToolbar(),brushGeometry);
  await page.screenshot({path:path.join(evidence,'drawing-narrow-transform.png')});
  assert.equal(await page.evaluate(()=>dispatchEvent(new Event('beforeunload',{cancelable:true}))),false);
  assert.equal((await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync())).state,'editing');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>dispatchEvent(new Event('beforeunload',{cancelable:true}))),true);
  assert.equal((await api(route)).revision,project.revision+1);
  await shelf('笔刷').click();
  await scope.click();
  await page.getByRole('option',{name:'个人',exact:true}).click();
  await resourceSearch.fill('喷涂');
  await show('material');
  assert.equal(await shelf('材质').getAttribute('aria-selected'),'true');
  assert.equal(await resourceSearch.inputValue(),'');
  assert.match(await scope.innerText(),/当前项目/);
  await show('drawing');
  assert.equal(await shelf('笔刷').getAttribute('aria-selected'),'true');
  assert.equal(await resourceSearch.inputValue(),'喷涂');
  assert.match(await scope.innerText(),/个人/);
  await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync());
  await page.reload();
  await shelf('笔刷').waitFor();
  assert.equal(await shelf('笔刷').getAttribute('aria-selected'),'true');
  assert.equal(await resourceSearch.inputValue(),'喷涂');
  assert.match(await scope.innerText(),/个人/);

  await page.setViewportSize({width:1200,height:800});
  const libraryArea=await library.getAttribute('data-area-id');
  const secondary=page.locator('.editor-area[data-area-id="'+libraryArea+'"]');
  const editorPicker=secondary.getByRole('button',{name:'编辑器类型',exact:true});
  await editorPicker.click();
  await page.getByRole('option',{name:'材质节点编辑器',exact:true}).click();
  await secondary.locator('.shader-editor').waitFor();
  await canvas.focus();
  await secondary.getByRole('button',{name:'启用节点材质',exact:true}).focus();
  for(const action of ['copyMerged','pasteInPlace'])
    assert.equal(await page.evaluate(action=>window.arachneNativeHost.command(action,{nativeEdit:true}),action),false);
  await canvas.focus();
  assert.equal(await page.evaluate(()=>window.arachneNativeHost.command('copyMerged',{nativeEdit:true})),true);
  await imageEditor.getByText(/已合并复制 4096 × 4096 px/).waitFor();
  await editorPicker.click();
  await page.getByRole('option',{name:'资源库',exact:true}).click();
  assert.equal(await shelf('笔刷').getAttribute('aria-selected'),'true');

  await show('modeling');
  const cdp=await page.context().newCDPSession(page);
  const readBuffer=()=>viewport.evaluate(host=>{
    const canvas=host.querySelector('canvas');
    return {ratio:Number(host.dataset.pixelRatio),width:canvas.width,height:canvas.height,cssWidth:host.clientWidth,cssHeight:host.clientHeight};
  });
  const first=await readBuffer();
  assert.deepEqual([first.ratio,first.width,first.height],[1,first.cssWidth,first.cssHeight]);
  for(const ratio of [1.25,2,1]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:ratio,mobile:false});
    const next=await until(async()=>{const frame=await readBuffer();return frame.ratio===ratio&&frame;},'viewport scale '+ratio);
    assert.deepEqual([next.cssWidth,next.cssHeight],[first.cssWidth,first.cssHeight]);
    assert.deepEqual([next.width,next.height],[Math.floor(first.cssWidth*ratio),Math.floor(first.cssHeight*ratio)]);
  }
  await cdp.detach();
  const split=page.getByRole('separator',{name:'调整区域高度',exact:true}).first();
  const ratio=()=>split.getAttribute('aria-valuenow');
  const defaultRatio=await ratio();
  await split.focus();await split.press('ArrowUp');
  const customRatio=await ratio();assert.notEqual(customRatio,defaultRatio);
  await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync());
  await page.reload();await viewport.waitFor();
  assert.equal(await ratio(),customRatio,'Reload retains the user-resized layout');
  await page.evaluate(()=>{
    const write=Storage.prototype.setItem;
    window.restoreLayoutStorage=()=>{Storage.prototype.setItem=write;};
    Storage.prototype.setItem=function(key,value){
      if(key==='arachne-area-workspaces-v1')throw new DOMException('layout quota test','QuotaExceededError');
      return write.call(this,key,value);
    };
  });
  await split.focus();await split.press('ArrowUp');
  const pendingRatio=await ratio();assert.notEqual(pendingRatio,customRatio);
  const recovery=page.locator('.area-layout-save');
  await recovery.getByRole('alert').filter({hasText:'浏览器存储空间不足'}).waitFor();
  assert.equal(await page.locator('#project-save-state').textContent(),'布局未保存');
  assert.equal((await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync())).state,'unsaved');
  assert.equal(await ratio(),pendingRatio);
  await page.evaluate(()=>window.restoreLayoutStorage());
  await recovery.getByRole('button',{name:'重试保存布局',exact:true}).click();
  await recovery.waitFor({state:'hidden'});
  assert.equal((await page.evaluate(()=>window.arachneNativeHost.prepareToCloseAsync())).state,'ready');
  await page.reload();await viewport.waitFor();
  assert.equal(await ratio(),pendingRatio);
  for(const [size,width,height] of [['wide',1440,940],['narrow',900,630]]){
    await page.setViewportSize({width,height});await show('material');await checkMapDialog(size);
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await checkVisiblePickers(page.locator('#settings-dialog'));
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.locator('.paint-menu>summary').filter({hasText:'文件'}).click();
    await page.locator('#open-delivery').click();
    await checkVisiblePickers(page.locator('#delivery-dialog'));
    await page.keyboard.press('Escape');
    await page.locator('#delivery-dialog').waitFor({state:'hidden'});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS checked menu values, pointer and keyboard selection, focus return, resource hover and layer focus at both sizes');
  console.log('PASS long map candidates align names across rows with and without thumbnail previews');
  console.log('PASS all three workspaces at 1440 and 900 px; viewport reallocates its buffer at 125%, 200% and 100% without a CSS resize');
  console.log('PASS narrow drawing toolbar keeps its height across eight tools and transform, with reachable brush settings');
  console.log('PASS drawing defaults to image assets, and drawing and material remember their separate library tabs after reload');
  console.log('PASS native image clipboard commands follow the focused editor in a mixed workspace');
  console.log('PASS custom layout reload, browser quota error, quit protection and retry without losing the layout');
}catch(error){console.error(logs);throw error;}
finally{
  await browser?.close();
  if(server.exitCode===null&&server.signalCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
  console.log('Workspace verification images:',evidence);
}
