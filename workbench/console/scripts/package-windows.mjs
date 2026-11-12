import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {registry} from 'playwright-core/lib/server/registry/index';
import {stageReleaseDemo} from './release-demo.mjs';
import {APP_VERSION,PACKAGE_VERSION} from '../public/app-version.mjs';
import {workspaceRoot} from '../workspace-paths.mjs';
import {pythonExecutable} from '../python-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const python=process.env.ARACHNE_PACKAGE_PYTHON||pythonExecutable();
const output=path.resolve(process.env.ARACHNE_PACKAGE_OUTPUT_DIR||path.join(root,'release'));
const cache=path.resolve(process.env.ARACHNE_WIN_RUNTIME_CACHE||path.join(os.tmpdir(),'arachne-windows-runtime'));
const includeBlender=process.env.ARACHNE_PACKAGE_INCLUDE_BLENDER==='1';
const baseName='Arachne-'+APP_VERSION+'-windows-x64'+(includeBlender?'-with-blender':'');
const electron='45.3.0',pythonVersion='3.13.17',blender='5.2.3';
const archives=[
  ['electron-v'+electron+'-win32-x64.zip','https://github.com/electron/electron/releases/download/v'+electron+'/',
    'b43b532e712a4323f4224627b73808a039c9769fdf7ba1dbc3cb49c1dbfa350b'],
  ['python-'+pythonVersion+'-embed-amd64.zip','https://www.python.org/ftp/python/'+pythonVersion+'/',
    '9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38'],
  ...(includeBlender?[['blender-'+blender+'-windows-x64.zip','https://download.blender.org/release/Blender5.2/',
    '723f08a4401502561eb763cdeacf8745b31e5f3f154d287d3830d97cf75dc2fb']]:[])
];
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n');};
const copy=async(from,to)=>{await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to);};
const tree=(from,to)=>fs.cp(from,to,{recursive:true,filter:file=>!['.DS_Store','__pycache__'].includes(path.basename(file))&&!file.endsWith('.pyc')});
const exists=file=>fs.access(file).then(()=>true,()=>false);
const run=(file,args,options={})=>execFileSync(file,args,{cwd:root,windowsHide:true,stdio:'inherit',...options});
async function hash(file){
  const digest=createHash('sha256');
  for await(const bytes of createReadStream(file))digest.update(bytes);
  return digest.digest('hex');
}

async function download([name,url,expected]){
  const file=path.join(cache,name);
  if(await exists(file)){
    if(await hash(file)===expected)return file;
    throw Error('Cached archive checksum mismatch: '+file);
  }
  const pending=file+'.'+randomUUID()+'.tmp';
  try{
    run(process.platform==='win32'?'curl.exe':'curl',
      ['--fail','--location','--retry','2','--max-time','900','--output',pending,url+name]);
    if(await hash(pending)!==expected)throw Error('Archive checksum mismatch: '+name);
    await fs.rename(pending,file);
    return file;
  }finally{await fs.rm(pending,{force:true});}
}

async function stageWorkbench(workspace){
  const target=path.join(workspace,'workbench/console'),pkg=await read(path.join(root,'package.json'));
  if(pkg.version!==PACKAGE_VERSION)throw Error('Version metadata disagrees');
  for(const entry of await fs.readdir(root))
    if(/\.(mjs|py)$/.test(entry)||['package.json','package-lock.json'].includes(entry))
      await copy(path.join(root,entry),path.join(target,entry));
  await tree(path.join(root,'public'),path.join(target,'public'));
  for(const name of ['release-runtime.mjs','release-mcp.mjs'])
    await copy(path.join(import.meta.dirname,name),path.join(target,'scripts',name));
  for(const [name,version] of Object.entries(pkg.dependencies)){
    const dependency=path.join(root,'node_modules',name);
    if((await read(path.join(dependency,'package.json'))).version!==version)throw Error('Unexpected dependency version: '+name);
    await tree(dependency,path.join(target,'node_modules',name));
  }
  const tools=path.join(root,'../tools');
  for(const name of await fs.readdir(tools))
    if(name.endsWith('.py'))await copy(path.join(tools,name),path.join(workspace,'workbench/tools',name));
  for(const name of ['workspace-paths.json','LICENSE','THIRD_PARTY.md'])
    await copy(path.join(workspaceRoot,name),path.join(workspace,name));

  return stageReleaseDemo(workspace,python);
}

async function stageIcon(staging,app){
  const instance=await chromium.launch(process.env.ARACHNE_PACKAGE_BROWSER?
    {executablePath:process.env.ARACHNE_PACKAGE_BROWSER}:{});
  const png=path.join(staging,'icon.png');
  try{
    const page=await instance.newPage({viewport:{width:256,height:256}});
    const svg=await fs.readFile(path.join(root,'public/arachne-mark.svg'),'utf8');
    await page.setContent('<style>body{margin:0}svg{width:256px;height:256px}</style>'+svg);
    await page.screenshot({path:png,omitBackground:true});
  }finally{await instance.close();}
  run(python,['-c','from PIL import Image; import sys; Image.open(sys.argv[1]).save(sys.argv[2], format="ICO")',png,path.join(app,'arachne.ico')]);
}

await fs.mkdir(output,{recursive:true});
await fs.mkdir(cache,{recursive:true});
const destination=path.join(output,baseName),zip=destination+'.zip';
if(await exists(destination)||await exists(zip))throw Error('Windows release already exists: '+destination);
const staging=await fs.mkdtemp(path.join(output,'.windows-'));
try{
  const [electronZip,pythonZip,blenderZip]=await Promise.all(archives.map(download));
  const bundle=path.join(staging,baseName),resources=path.join(bundle,'resources');
  const pythonRoot=path.join(resources,'runtime/python'),blenderRoot=path.join(resources,'runtime/blender');
  const extract=(file,target)=>run(python,['-m','zipfile','-e',file,target]);
  extract(electronZip,bundle);
  await fs.rename(path.join(bundle,'electron.exe'),path.join(bundle,'Arachne.exe'));
  await fs.rm(path.join(resources,'default_app.asar'),{force:true});
  extract(pythonZip,pythonRoot);
  if(blenderZip){
    extract(blenderZip,staging);
    await fs.rename(path.join(staging,path.basename(blenderZip,'.zip')),blenderRoot);
  }

  const wheelCache=path.join(cache,'wheels'),packages=path.join(pythonRoot,'Lib/site-packages');
  const pinned=path.join(root,'release-support/windows/python-wheels.txt');
  const wheelArgs=['--only-binary=:all:','--platform','win_amd64','--python-version','3.13','--implementation','cp','--abi','cp313','--require-hashes','-r',pinned];
  const wheelFiles=(await fs.readFile(pinned,'utf8')).split(/\r?\n/).filter(line=>line&&!line.startsWith('#'))
    .map(line=>line.split('==')[0].toLowerCase()+'-');
  const cachedWheels=await fs.readdir(wheelCache).catch(()=>[]);
  if(!wheelFiles.every(prefix=>cachedWheels.some(name=>name.toLowerCase().startsWith(prefix))))
    run(python,['-m','pip','download','--dest',wheelCache,...wheelArgs]);
  run(python,['-m','pip','install','--no-index','--no-compile','--find-links',wheelCache,'--target',packages,...wheelArgs]);
  await fs.writeFile(path.join(pythonRoot,'python313._pth'),
    'python313.zip\r\n.\r\nLib/site-packages\r\n../../workspace/workbench/console\r\n');

  const renderBrowser=process.env.ARACHNE_PACKAGE_WIN_BROWSER||
    path.dirname(registry.findExecutable('chromium-headless-shell').executablePath());
  if(!await exists(path.join(renderBrowser,'chrome-headless-shell.exe')))
    throw Error('请先安装 Windows Chromium Headless Shell，跨平台构建可设置 ARACHNE_PACKAGE_WIN_BROWSER');
  await tree(renderBrowser,path.join(resources,'runtime/browser'));
  const inputs=await stageWorkbench(path.join(resources,'workspace'));
  const native=path.join(root,'release-support/windows'),app=path.join(resources,'app');
  await copy(path.join(native,'app.json'),path.join(app,'package.json'));
  for(const name of ['main.mjs','preload.cjs','window-state.mjs','download-target.mjs','close-check.mjs'])await copy(path.join(native,name),path.join(app,name));
  await stageIcon(staging,app);
  const mcp=await fs.readFile(path.join(native,'ArachneMCP.cmd'),'utf8');
  await fs.writeFile(path.join(bundle,'ArachneMCP.cmd'),mcp.replace(/\r?\n/g,'\r\n'));
  await copy(path.join(native,'Windows.md'),path.join(bundle,'使用说明.md'));
  const sourceCommit=run('git',['rev-parse','HEAD'],{stdio:'pipe',encoding:'utf8'}).trim();
  const info={version:APP_VERSION,packageVersion:PACKAGE_VERSION,buildId:randomUUID(),sourceCommit,platform:'windows-x64',
    electron,python:pythonVersion,blender:includeBlender?blender:null,inputs,created:new Date().toISOString()};
  await write(path.join(resources,'build-info.json'),info);

  console.log('Compressing Windows desktop package');
  const packed=path.join(staging,baseName+'.zip');
  run(python,['-c',[
    'from pathlib import Path',
    'import sys, zipfile',
    'folder=Path(sys.argv[1])',
    'with zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED,compresslevel=3) as archive:',
    ' for file in sorted(folder.rglob("*")):',
    '  if file.is_file(): archive.write(file,file.relative_to(folder.parent).as_posix())'
  ].join('\n'),bundle,packed]);
  const digest=await hash(packed);
  await fs.rename(bundle,destination);
  await fs.rename(packed,zip);
  await fs.writeFile(zip+'.sha256',digest+'  '+path.basename(zip)+'\n');
  console.log(zip);
}finally{await fs.rm(staging,{recursive:true,force:true});}
