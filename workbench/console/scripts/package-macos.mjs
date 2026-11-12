// Reproducible public alpha bundle. Only explicitly selected code, runtimes and bound inputs.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {stageReleaseDemo} from './release-demo.mjs';
import {APP_VERSION,PACKAGE_VERSION,RELEASE_TAG} from '../public/app-version.mjs';
import {dataDirectory} from '../release-paths.mjs';
import {workspaceRoot} from '../workspace-paths.mjs';

if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('This builder requires Apple Silicon macOS');
const root=path.resolve(import.meta.dirname,'..'),releaseRoot=path.resolve(process.env.ARACHNE_PACKAGE_OUTPUT_DIR||path.join(root,'release')),versionDir=path.join(releaseRoot,APP_VERSION);
const python=process.env.ARACHNE_PACKAGE_PYTHON||process.env.ARACHNE_PYTHON||'python3';
const run=(file,args,options={})=>execFileSync(file,args,{cwd:root,encoding:'utf8',...options});
const readJSON=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function writeJSON(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n');}
async function hash(file){const h=crypto.createHash('sha256');for await(const data of createReadStream(file))h.update(data);return h.digest('hex');}
async function copy(from,to){await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to);}
async function tree(from,to,filter=()=>true){await fs.cp(from,to,{recursive:true,dereference:true,filter:p=>filter(p)&&!['__pycache__','.DS_Store'].includes(path.basename(p))&&!p.endsWith('.pyc')});}
const pkg=await readJSON(path.join(root,'package.json')),lock=await readJSON(path.join(root,'package-lock.json'));
if(pkg.version!==PACKAGE_VERSION||lock.version!==PACKAGE_VERSION||lock.packages[''].version!==PACKAGE_VERSION)throw Error('Version metadata disagrees');
await fs.mkdir(path.dirname(versionDir),{recursive:true});
try{await fs.access(versionDir);throw Error('Release already exists: '+versionDir);}catch(e){if(e.code!=='ENOENT')throw e;}
const staging=await fs.mkdtemp(path.join(releaseRoot,'.build-'+APP_VERSION+'-'));
const app=path.join(staging,'阿拉克涅.app'),contents=path.join(app,'Contents'),resources=path.join(contents,'Resources'),workspace=path.join(resources,'workspace'),consoleOut=path.join(workspace,'workbench/console');
const licenses=path.join(resources,'licenses');await fs.mkdir(licenses,{recursive:true});
try{
  console.log('Copying Web workbench and production dependencies');
  await fs.mkdir(consoleOut,{recursive:true});
  for(const entry of await fs.readdir(root))if(/\.(mjs|py)$/.test(entry)||['package.json','package-lock.json'].includes(entry))await copy(path.join(root,entry),path.join(consoleOut,entry));
  await tree(path.join(root,'public'),path.join(consoleOut,'public'));
  for(const name of ['release-runtime.mjs','release-mcp.mjs'])await copy(path.join(import.meta.dirname,name),path.join(consoleOut,'scripts',name));
  for(const name of Object.keys(pkg.dependencies)){
    const folder=path.join(root,'node_modules',name),dep=await readJSON(path.join(folder,'package.json'));
    if(dep.version!==pkg.dependencies[name])throw Error('Dependency version differs: '+name);
    await tree(folder,path.join(consoleOut,'node_modules',name));
  }
  const toolRoot=path.join(root,'../tools');
  for(const name of await fs.readdir(toolRoot))if(name.endsWith('.py'))await copy(path.join(toolRoot,name),path.join(workspace,'workbench/tools',name));
  const aliases=await readJSON(path.join(workspaceRoot,'workspace-paths.json'));await writeJSON(path.join(workspace,'workspace-paths.json'),aliases);
  console.log('Copying and verifying the generated demo');
  const inputs=await stageReleaseDemo(workspace,python);

  console.log('Bundling Node, Python and the local render browser');
  const py=JSON.parse(run(python,['-c','import sys,numpy,PIL,fontTools,json; print(json.dumps({"prefix":sys.base_prefix,"version":sys.version.split()[0],"packages":[numpy.__path__[0],PIL.__path__[0],fontTools.__path__[0]]}))']));
  const pyOut=path.join(resources,'runtime/python');
  await copy(await fs.realpath(process.execPath),path.join(resources,'runtime/node/bin/node'));
  await copy(path.join(py.prefix,'bin/python3.12'),path.join(pyOut,'bin/python3.12'));
  const excluded=new Set(['site-packages','test','tests','idlelib','ensurepip','turtledemo','__pycache__']);
  await tree(path.join(py.prefix,'lib/python3.12'),path.join(pyOut,'lib/python3.12'),p=>!path.relative(path.join(py.prefix,'lib/python3.12'),p).split(path.sep).some(s=>excluded.has(s)));
  for(const module of py.packages){
    const site=path.dirname(module),name=path.basename(module),metadata=(await fs.readdir(site)).filter(n=>n.toLowerCase().startsWith(name==='PIL'?'pillow-':name.toLowerCase()+'-')&&n.endsWith('.dist-info'));
    if(metadata.length!==1)throw Error('Missing Python license/metadata: '+name);
    for(const entry of [name,...metadata,...(await fs.readdir(site)).filter(n=>n.toLowerCase()===name.toLowerCase()+'.libs')])await tree(path.join(site,entry),path.join(pyOut,'lib/python3.12/site-packages',entry));
  }
  const pyEnv={...process.env,PYTHONHOME:pyOut,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'};delete pyEnv.PYTHONPATH;delete pyEnv.VIRTUAL_ENV;
  run(path.join(pyOut,'bin/python3.12'),['-c','import numpy,PIL,fontTools,ssl;print("Embedded Python imports passed")'],{env:pyEnv});
  const browsers=process.env.PLAYWRIGHT_BROWSERS_PATH;
  let browser=process.env.ARACHNE_PACKAGE_BROWSER;
  if(!browser&&browsers){const names=(await fs.readdir(browsers)).filter(n=>n.startsWith('chromium_headless_shell-')).sort();browser=path.join(browsers,names.at(-1)||'', 'chrome-headless-shell-mac-arm64');}
  if(!browser)throw Error('Set ARACHNE_PACKAGE_BROWSER to the headless-shell directory');
  await tree(browser,path.join(resources,'runtime/browser'));
  await copy(path.join(root,'release-support/licenses/Node-LICENSE.txt'),path.join(licenses,'Node-LICENSE.txt'));
  await copy(path.join(py.prefix,'lib/python3.12/LICENSE.txt'),path.join(licenses,'Python-LICENSE.txt'));
  await fs.writeFile(path.join(licenses,'README.txt'),'Bundled component notices remain beside their components:\nNode: Node-LICENSE.txt\nPython: Python-LICENSE.txt\nNumPy, Pillow, fontTools: runtime/python/lib/python3.12/site-packages/*dist-info/\nChromium: runtime/browser/LICENSE.headless_shell\nJavaScript dependencies: workspace/workbench/console/node_modules/*/LICENSE*\nInterface fonts: workspace/workbench/console/public/fonts/\nBlender is installed separately and is not redistributed.\n');

  console.log('Building the native Mac launcher and application icon');
  await fs.mkdir(path.join(contents,'MacOS'),{recursive:true});
  run('/usr/bin/swiftc',['-swift-version','5','-O','-target','arm64-apple-macos14.0','-module-cache-path',path.join(staging,'.swift-cache'),'-framework','AppKit','-framework','WebKit',path.join(root,'release-support/Launcher.swift'),path.join(root,'release-support/NativeWorkbench.swift'),'-o',path.join(contents,'MacOS/Arachne')]);
  await copy(path.join(contents,'MacOS/Arachne'),path.join(contents,'MacOS/ArachneMCP'));
  const appIcon=path.join(resources,'Arachne.icns');
  const localIcon=process.env.ARACHNE_PACKAGE_MAC_ICON||path.join(dataDirectory(root),'workbench-macos.icns');
  const iconData=await fs.readFile(localIcon).catch(error=>{
    if(error.code!=='ENOENT'||process.env.ARACHNE_PACKAGE_MAC_ICON)throw error;
    return null;
  });
  if(iconData){
    if(iconData.length<8||iconData.toString('ascii',0,4)!=='icns'||iconData.readUInt32BE(4)!==iconData.length)
      throw Error('Invalid macOS application icon: '+localIcon);
    await fs.writeFile(appIcon,iconData);
  }else{
    const {chromium}=await import('playwright-core');
    const instance=await chromium.launch({executablePath:path.join(resources,'runtime/browser/chrome-headless-shell')});
    const iconset=path.join(staging,'.icon.iconset');
    await fs.mkdir(iconset);
    try{
      const page=await instance.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1});
      const mark=await fs.readFile(path.join(root,'public/arachne-mark.svg'),'utf8');
      await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block}</style>'+mark);
      await page.screenshot({path:path.join(iconset,'icon_512x512@2x.png'),omitBackground:true});
    }finally{await instance.close();}
    for(const [name,size] of Object.entries({'16x16':16,'16x16@2x':32,'32x32':32,'32x32@2x':64,'128x128':128,'128x128@2x':256,'256x256':256,'256x256@2x':512,'512x512':512}))run('/usr/bin/sips',['-z',String(size),String(size),path.join(iconset,'icon_512x512@2x.png'),'--out',path.join(iconset,'icon_'+name+'.png')]);
    run('/usr/bin/iconutil',['-c','icns',iconset,'-o',appIcon]);
    await fs.rm(iconset,{recursive:true});
  }
  await fs.writeFile(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleName</key><string>阿拉克涅</string><key>CFBundleDisplayName</key><string>阿拉克涅</string><key>CFBundleIdentifier</key><string>com.arachne.workbench.public</string><key>CFBundleExecutable</key><string>Arachne</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIconFile</key><string>Arachne</string><key>CFBundleShortVersionString</key><string>0.0.1</string><key>CFBundleVersion</key><string>1</string><key>ArachneReleaseVersion</key><string>${APP_VERSION}</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/><key>LSMultipleInstancesProhibited</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>\n`);
  for(const name of ['LICENSE','THIRD_PARTY.md'])await copy(path.join(workspaceRoot,name),path.join(workspace,name));
  await copy(path.join(root,'release-support/使用说明.md'),path.join(staging,'使用说明.md'));
  const info={version:APP_VERSION,packageVersion:PACKAGE_VERSION,tag:RELEASE_TAG,buildId:crypto.randomUUID(),sourceCommit:run('git',['rev-parse','HEAD']).trim(),platform:'macos-arm64',minimumMacOS:'14.0',node:process.version,python:py.version,browser:run(path.join(resources,'runtime/browser/chrome-headless-shell'),['--version']).trim(),created:new Date().toISOString(),inputs};
  await writeJSON(path.join(resources,'build-info.json'),info);
  run('/usr/bin/codesign',['--force','--sign','-',app]);run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  const files={};async function manifest(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await manifest(file);else if(entry.isFile())files[path.relative(staging,file)]=await hash(file);else throw Error('Unexpected symlink in release: '+file);}}
  // Build scratch is never included in the archive.
  await fs.rm(path.join(staging,'.swift-cache'),{recursive:true,force:true});
  await manifest(staging);await writeJSON(path.join(staging,'release-manifest.json'),{...info,files});
  await fs.rename(staging,versionDir);
  const zip=path.join(path.dirname(versionDir),`Arachne-${APP_VERSION}-macos-arm64.zip`);
  console.log('Compressing verified Mac application');run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',versionDir,zip],{timeout:600000});
  await fs.writeFile(zip+'.sha256',await hash(zip)+'  '+path.basename(zip)+'\n');
  console.log(JSON.stringify({app:path.join(versionDir,'阿拉克涅.app'),zip,bytes:(await fs.stat(zip)).size,sourceCommit:info.sourceCommit}));
}catch(error){console.error('Build retained for inspection: '+staging);throw error;}
