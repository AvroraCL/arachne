import {app,BrowserWindow,clipboard,dialog,ipcMain,Menu,nativeImage,nativeTheme,screen,session,shell} from 'electron';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {startRelease,userRoot} from '../workspace/workbench/console/scripts/release-runtime.mjs';
import {restoreWindowState} from './window-state.mjs';
import {downloadTarget} from './download-target.mjs';
import {checkRendererClose} from './close-check.mjs';

const appName='阿拉克涅',projectId=/^[\w-]{1,100}$/;
const {ClipboardItem}=createRequire(import.meta.url)('electron');
const stateFile=path.join(userRoot,'desktop.json');
const icon=path.join(import.meta.dirname,'arachne.ico');
const controller=new AbortController();
const downloads=new Set();
const clipboardImageLimit=24*1024*1024;
const isNodeClipboard=text=>typeof text==='string'&&text.length<=128*1024&&text.startsWith('arachne-material-nodes/v1\n');
let service,starting,main,origin,checkingClose=false,closing=false,quitStarted=false,quitReady=false;
let state={},windowSaveTimer;

function sameOrigin(value){
  try{const url=new URL(value);return url.origin===origin&&!url.username&&!url.password;}catch{return false;}
}

function focus(){
  if(!main||main.isDestroyed())return;
  if(main.isMinimized())main.restore();
  main.show();
  main.focus();
}

function saveState(){
  try{
    const pending=stateFile+'.tmp';
    fs.writeFileSync(pending,JSON.stringify(state));
    fs.renameSync(pending,stateFile);
  }catch(error){console.error('无法保存桌面设置',error);}
}

function rememberWindow(win){
  clearTimeout(windowSaveTimer);
  if(win.isDestroyed()||win.isMinimized()||win.isFullScreen())return;
  state.window={bounds:win.getNormalBounds(),maximized:win.isMaximized()};
  saveState();
}

function buildMenus(){
  const command=(label,name,accelerator)=>({label,accelerator,click:()=>{
    const contents=main&&!main.isDestroyed()&&main.webContents;
    if(contents&&sameOrigin(contents.getURL()))
      void contents.executeJavaScript('window.arachneNativeHost?.command('+JSON.stringify(name)+',{nativeEdit:true})').then(result=>{
        if(result!=='native-text'||contents.isDestroyed()||!sameOrigin(contents.getURL()))return;
        if(name==='cut')contents.cut();
        if(name==='copy')contents.copy();
        if(name==='paste')contents.paste();
        if(name==='selectAll')contents.selectAll();
      }).catch(console.error);
  }});
  const separator={type:'separator'};
  const menu=[
    {label:'文件',submenu:[
      command('新建工程…','newProject','CmdOrCtrl+N'),command('打开工程…','openProject','CmdOrCtrl+O'),
      command('打开涂装 ZIP…','importArchive'),command('迁移为 GLB 工程…','migrateModel'),separator,command('保存工程','save','CmdOrCtrl+S'),
      command('另存为工程…','saveProjectCopy','CmdOrCtrl+Shift+S'),command('生成工程副本','createBackup'),command('下载工程副本…','downloadBackup'),
      command('工程详情…','projectDetails'),command('导出…','export','CmdOrCtrl+E'),separator,
      {label:'显示工程目录',click:()=>void shell.openPath(service.data)},{label:'退出',role:'quit'}
    ]},
    {label:'编辑',submenu:[
      command('撤销','undo','CmdOrCtrl+Z'),command('重做','redo','CmdOrCtrl+Shift+Z'),separator,
      command('剪切','cut','CmdOrCtrl+X'),command('复制','copy','CmdOrCtrl+C'),command('粘贴','paste','CmdOrCtrl+V'),
      command('合并复制','copyMerged','CmdOrCtrl+Shift+C'),
      command('原位粘贴','pasteInPlace','CmdOrCtrl+Shift+V'),command('全选','selectAll','CmdOrCtrl+A'),
      separator,command('历史记录…','history'),command('搜索命令…','searchCommands','CmdOrCtrl+K'),command('设置…','settings')
    ]},
    {label:'渲染',submenu:[command('渲染设置…','renderSettings'),command('后台任务…','renderTasks')]},
    {label:'窗口',submenu:[command('工作区布局…','workspaceLayouts'),separator,{label:'最小化',role:'minimize'},{label:'切换全屏',role:'togglefullscreen'},{label:'关闭窗口',role:'close'}]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}

async function canClose(win){
  let status='unavailable';
  if(sameOrigin(win.webContents.getURL())){
    status=await checkRendererClose(()=>win.webContents.executeJavaScript(
      '(async()=>{const host=window.arachneNativeHost;return (host?.prepareToCloseAsync?await host.prepareToCloseAsync():host?.prepareToClose())?.state;})()'));
  }
  if(['ready','jobs'].includes(status)){
    if(!service.owned)status='ready';
    else try{
      const response=await fetch(origin+'/api/desktop-activity',{signal:AbortSignal.timeout(4000)});
      if(!response.ok)throw Error('无法读取本机工作台状态');
      const activity=(await response.json()).state;
      status=['ready','saving','jobs'].includes(activity)?activity:'unavailable';
    }catch{status='unavailable';}
  }
  const force=['unresponsive','unavailable'].includes(status);
  if(downloads.size&&!['saving','editing','unsaved','unresponsive'].includes(status))status='downloads';
  if(status==='ready')return 'close';
  const block=['saving','editing','unsaved'].includes(status);
  const detail={
    saving:'正在保存或导入工程，请等待当前操作完成。',error:'工程最近一次保存失败。',editing:'请先确认或取消当前编辑。',
    jobs:'退出会中断由此应用启动的后台任务。',downloads:'文件正在下载。',unsaved:'请先在工作台恢复待保存的笔触或布局。',
    unresponsive:'工作台在 4 秒内没有响应，无法确认保存状态。强制退出可能丢失未保存的修改。'
  }[status]||'无法检查保存或任务状态。退出可能丢失未保存的修改。';
  const {response}=await dialog.showMessageBox(win,{type:'warning',message:block?'请先完成当前操作':'退出阿拉克涅？',detail,
    buttons:block?['继续工作']:['继续工作',force?'强制退出':'退出'],defaultId:0,cancelId:0,noLink:true});
  return !block&&response===1?(force?'destroy':'close'):false;
}

function configureSession(){
  const desktop=session.defaultSession;
  desktop.setPermissionCheckHandler((_contents,permission,requestingOrigin)=>
    permission==='clipboard-sanitized-write'&&requestingOrigin===origin);
  desktop.setPermissionRequestHandler((_contents,permission,callback,details)=>
    callback(permission==='clipboard-sanitized-write'&&sameOrigin(details.requestingUrl)));
  desktop.on('will-download',(event,item,contents,frame)=>{
    if(!sameOrigin(frame?.url??contents.getURL())||!sameOrigin(item.getURL())){event.preventDefault();return;}
    const filename=path.basename(item.getFilename())||'阿拉克涅导出';
    let preferred=app.getPath('downloads');
    try{
      if(typeof state.downloadFolder==='string'&&path.isAbsolute(state.downloadFolder)&&
         fs.statSync(state.downloadFolder,{throwIfNoEntry:false})?.isDirectory())preferred=state.downloadFolder;
    }catch{}
    const options={title:'保存文件',defaultPath:path.join(preferred,filename)};
    const parent=BrowserWindow.fromWebContents(contents);
    let target;
    try{
      const selected=parent?dialog.showSaveDialogSync(parent,options):dialog.showSaveDialogSync(options);
      if(!selected){event.preventDefault();return;}
      target=downloadTarget(selected);
      item.setSavePath(target.temporary);
      state.downloadFolder=path.dirname(selected);saveState();
    }catch(error){event.preventDefault();dialog.showErrorBox('无法准备下载',error.message);return;}
    downloads.add(item);
    item.once('done',(_done,result)=>{
      downloads.delete(item);
      if(result==='cancelled'){
        try{fs.rmSync(target.temporary,{force:true});}catch{}
        return;
      }
      try{
        if(result!=='completed')throw Error('下载未完成');
        target.finish();
      }catch(error){
        const partial=fs.existsSync(target.temporary)?'\n下载内容保存在：\n'+target.temporary:'';
        dialog.showErrorBox('无法保存导出文件',error.message+partial);
      }
    });
  });
}

function restrictNavigation(contents){
  const verify=event=>{if(!sameOrigin(event.url))event.preventDefault();};
  contents.on('will-frame-navigate',verify);
  contents.on('will-redirect',verify);
  contents.on('will-attach-webview',event=>event.preventDefault());
  contents.setWindowOpenHandler(({url})=>{
    if(!sameOrigin(url))return {action:'deny'};
    return {action:'allow',overrideBrowserWindowOptions:{width:900,height:680,autoHideMenuBar:true,
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}};
  });
}

async function start(){
  service=await startRelease({signal:controller.signal});
  if(quitStarted)return;
  const target=new URL(service.url);
  origin=target.origin;
  try{
    const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    if(saved&&typeof saved==='object'&&!Array.isArray(saved))state=saved;
  }catch{}
  if(projectId.test(state.project||'')&&
     await fetch(origin+'/api/projects/'+state.project,{signal:AbortSignal.timeout(3000)}).then(r=>r.ok,()=>false))
    target.searchParams.set('project',state.project);
  controller.signal.throwIfAborted();

  configureSession();
  app.on('web-contents-created',(_event,contents)=>restrictNavigation(contents));
  const {bounds,minWidth,minHeight,maximized}=restoreWindowState(state.window,
    screen.getAllDisplays().map(display=>display.workArea),screen.getPrimaryDisplay().workArea);
  const win=main=new BrowserWindow({title:appName,icon,...bounds,minWidth,minHeight,
    backgroundColor:'#202124',show:false,webPreferences:{preload:path.join(import.meta.dirname,'preload.cjs'),
      contextIsolation:true,sandbox:true,nodeIntegration:false,webviewTag:false,navigateOnDragDrop:false}});
  win.on('page-title-updated',event=>event.preventDefault());
  let recoveringRenderer=false;
  win.webContents.on('render-process-gone',(_event,details)=>{
    if(closing||quitStarted||recoveringRenderer||win.isDestroyed()||details.reason==='clean-exit')return;
    recoveringRenderer=true;
    console.error('工作台显示进程已停止',details.reason,details.exitCode);
    void (async()=>{
      const {response}=await dialog.showMessageBox(win,{type:'warning',message:'工作台显示进程已停止',
        detail:'重新载入后会打开最新保存的工程，并检查此窗口可恢复的笔触。',buttons:['重新载入','关闭窗口'],defaultId:0,cancelId:1,noLink:true});
      if(win.isDestroyed()||closing)return;
      if(response!==0){win.close();return;}
      const current=win.webContents.getURL();
      const recovery=new URL(sameOrigin(current)?current:target.href);
      if(projectId.test(state.project||''))recovery.searchParams.set('project',state.project);
      await win.loadURL(recovery.href);
    })().catch(error=>{
      if(!win.isDestroyed()&&!closing)dialog.showErrorBox('工作台无法重新载入',error.message);
    }).finally(()=>recoveringRenderer=false);
  });
  win.on('close',event=>{
    if(closing)return;
    event.preventDefault();
    if(checkingClose)return;
    checkingClose=true;
    void canClose(win).then(action=>{
      if(action&&!win.isDestroyed()){
        rememberWindow(win);closing=true;
        if(action==='destroy')win.destroy();else win.close();
      }
    }).catch(console.error).finally(()=>checkingClose=false);
  });
  win.on('closed',()=>{clearTimeout(windowSaveTimer);main=null;app.quit();});
  for(const event of ['move','resize','maximize','unmaximize','leave-full-screen'])win.on(event,()=>{
    clearTimeout(windowSaveTimer);
    windowSaveTimer=setTimeout(()=>rememberWindow(win),250);
  });
  ipcMain.on('arachne:project',(event,id,name)=>{
    if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||
       !sameOrigin(event.senderFrame?.url)||typeof id!=='string'||!projectId.test(id)||typeof name!=='string')return;
    win.setTitle(name?name.slice(0,160)+' · '+appName:appName);
    if(state.project!==id){state.project=id;saveState();}
  });
  const trustedClipboard=event=>event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&sameOrigin(event.senderFrame?.url);
  ipcMain.handle('arachne:clipboard-nodes',async(event,text)=>{
    if(!trustedClipboard(event)||!win.isFocused()||!isNodeClipboard(text))return false;
    await clipboard.writeText(text);return true;
  });
  ipcMain.handle('arachne:read-clipboard-nodes',async event=>{
    if(!trustedClipboard(event)||!win.isFocused())return null;
    const text=await clipboard.readText();
    return !win.isDestroyed()&&trustedClipboard(event)&&win.isFocused()&&isNodeClipboard(text)?text:null;
  });
  ipcMain.handle('arachne:clipboard-image',async(event,bytes)=>{
    if(!trustedClipboard(event)||!(bytes instanceof ArrayBuffer)||bytes.byteLength<24||bytes.byteLength>clipboardImageLimit)return false;
    const png=Buffer.from(bytes);
    if(png.readUInt32BE(0)!==0x89504e47||png.readUInt32BE(4)!==0x0d0a1a0a||
       ![png.readUInt32BE(16),png.readUInt32BE(20)].every(side=>side>0&&side<=4096))return false;
    const image=nativeImage.createFromBuffer(png);
    if(image.isEmpty())return false;
    if(ClipboardItem)await clipboard.write([new ClipboardItem({'image/png':new Blob([png],{type:'image/png'})})]);
    else clipboard.writeImage(image);
    return true;
  });
  ipcMain.handle('arachne:read-clipboard-image',async event=>{
    if(!trustedClipboard(event)||!win.isFocused())return null;
    let png;
    if(ClipboardItem){
      const item=(await clipboard.read()).find(item=>item.types.includes('image/png'));
      if(item){
        const blob=await item.getType('image/png');
        if(blob.size>clipboardImageLimit)throw Error('剪贴板图片超过 24 MiB');
        png=await blob.arrayBuffer();
      }
    }
    if(!png){
      const image=clipboard.readImage();
      if(image.isEmpty())return null;
      if(Object.values(image.getSize()).some(side=>side>8192))throw Error('剪贴板图片边长超过 8192 像素');
      png=new Uint8Array(image.toPNG()).buffer;
    }
    if(png.byteLength>clipboardImageLimit)throw Error('剪贴板图片超过 24 MiB');
    return png;
  });
  buildMenus();
  win.once('ready-to-show',()=>{if(maximized)win.maximize();focus();});
  await win.loadURL(target.href);
  if(service.owned)void service.exit.then(()=>{
    if(quitStarted||closing)return;
    dialog.showErrorBox('工作台服务已退出','请重新打开阿拉克涅。启动日志保存在 '+path.join(userRoot,'logs'));
    closing=true;
    app.quit();
  });
}

app.setName('Arachne');
app.setAppUserModelId('com.arachne.workbench.windows');
const profile=path.join(userRoot,'desktop');
fs.mkdirSync(profile,{recursive:true});
app.setPath('userData',profile);
nativeTheme.themeSource='dark';
if(!app.requestSingleInstanceLock())app.exit(0);
else{
  app.on('second-instance',focus);
  app.on('before-quit',event=>{
    if(quitReady)return;
    event.preventDefault();
    if(main&&!main.isDestroyed()&&!closing){main.close();return;}
    if(quitStarted)return;
    quitStarted=true;
    controller.abort();
    void Promise.resolve(starting).catch(()=>{}).then(()=>service?.stop?.()).catch(console.error).finally(()=>{
      quitReady=true;
      app.quit();
    });
  });
  starting=app.whenReady().then(start).catch(error=>{
    if(quitStarted)return;
    dialog.showErrorBox('无法启动阿拉克涅',error.message+'\n'+path.join(userRoot,'logs'));
    closing=true;
    app.quit();
  });
}
