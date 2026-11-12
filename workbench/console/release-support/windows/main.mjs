import {app,BrowserWindow,dialog,ipcMain,Menu,nativeTheme,screen,session,shell} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startRelease,userRoot} from '../workspace/workbench/console/scripts/release-runtime.mjs';
import {restoreWindowState} from './window-state.mjs';

const appName='阿拉克涅',projectId=/^[\w-]{1,100}$/;
const stateFile=path.join(userRoot,'desktop.json');
const icon=path.join(import.meta.dirname,'arachne.ico');
const controller=new AbortController();
const downloads=new Set();
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
    if(main&&!main.isDestroyed()&&sameOrigin(main.webContents.getURL()))
      void main.webContents.executeJavaScript('window.arachneNativeHost?.command('+JSON.stringify(name)+')').catch(console.error);
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
      {label:'剪切',role:'cut'},{label:'复制',role:'copy'},{label:'粘贴',role:'paste'},{label:'全选',role:'selectAll'},
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
    try{
      for(let n=0;n<20;n++){
        status=(await win.webContents.executeJavaScript('(async()=>{const host=window.arachneNativeHost;return (host?.prepareToCloseAsync?await host.prepareToCloseAsync():host?.prepareToClose())?.state;})()'))||'unavailable';
        if(status!=='saving')break;
        await delay(100);
      }
    }catch{status='unavailable';}
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
  if(downloads.size)status='downloads';
  if(status==='ready')return true;
  const block=['saving','editing'].includes(status);
  const detail={
    saving:'正在保存或导入工程，请等待当前操作完成。',error:'工程最近一次保存失败。',editing:'请先确认或取消当前编辑。',
    jobs:'退出会中断由此应用启动的后台任务。',downloads:'文件正在下载。'
  }[status]||'无法检查保存或任务状态。退出可能丢失未保存的修改。';
  const {response}=await dialog.showMessageBox(win,{type:'warning',message:block?'请先完成当前操作':'退出阿拉克涅？',detail,
    buttons:block?['继续工作']:['继续工作','退出'],defaultId:0,cancelId:0,noLink:true});
  return !block&&response===1;
}

function configureSession(){
  const desktop=session.defaultSession;
  desktop.setPermissionCheckHandler((_contents,permission,requestingOrigin)=>
    permission==='clipboard-sanitized-write'&&requestingOrigin===origin);
  desktop.setPermissionRequestHandler((_contents,permission,callback,details)=>
    callback(permission==='clipboard-sanitized-write'&&sameOrigin(details.requestingUrl)));
  desktop.on('will-download',(event,item,contents,frame)=>{
    if(!sameOrigin(frame?.url??contents.getURL())||!sameOrigin(item.getURL())){event.preventDefault();return;}
    downloads.add(item);
    item.setSaveDialogOptions({title:'保存文件'});
    item.once('done',()=>downloads.delete(item));
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
  win.on('close',event=>{
    if(closing)return;
    event.preventDefault();
    if(checkingClose)return;
    checkingClose=true;
    void canClose(win).then(approved=>{
      if(approved&&!win.isDestroyed()){rememberWindow(win);closing=true;win.close();}
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
