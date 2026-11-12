import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {windowsVenv,windowsVenvPython} from '../python-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const python=process.env.ARACHNE_PYTHON||windowsVenvPython;
const [action]=process.argv.slice(2);

function run(executable,args){
  execFileSync(executable,args,{cwd:root,stdio:'inherit',windowsHide:true});
}

function check(executable,args,help){
  const result=spawnSync(executable,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:20000});
  if(result.status!==0)throw Error(help);
}

function setup(){
  if(!process.env.ARACHNE_PYTHON&&!existsSync(python)){
    const version='import sys; sys.exit(sys.version_info[:2] != (3, 12))';
    const candidates=[['py.exe','-3.12'],['python.exe']];
    const base=candidates.find(([exe,...args])=>spawnSync(exe,[...args,'-c',version],{
      cwd:root,windowsHide:true,timeout:10000,stdio:'ignore'
    }).status===0);
    if(!base)throw Error('请安装 Python 3.12，并启用 Python 启动器或将 Python 加入 PATH。');
    run(base[0],[...base.slice(1),'-m','venv',windowsVenv]);
  }
  check(python,['-c','import sys; sys.exit(sys.version_info[:2] != (3, 12))'],
    '无法使用 Python 3.12。请检查 ARACHNE_PYTHON 或仓库内的 .venv。');
  const npm=process.env.npm_execpath;
  if(!npm)throw Error('请在仓库根目录运行 npm run setup:win。');
  run(process.execPath,[npm,'ci']);
  run(python,['-m','pip','install','-r','requirements.txt']);
  process.env.ARACHNE_PYTHON=python;
  run(process.execPath,['scripts/seed-native-demo.mjs']);
}

async function start(){
  if((!process.env.ARACHNE_PYTHON&&!existsSync(python))||
     !existsSync(path.join(root,'node_modules','three','package.json'))||
     !['.demo-native','.demo'].some(folder=>existsSync(path.join(root,folder,'project.json')))){
    throw Error('首次运行请先在仓库根目录执行 npm run setup:win。');
  }
  process.env.ARACHNE_PYTHON=python;
  await import('../server.mjs');
}

try{
  if(process.platform!=='win32')throw Error('这个命令用于 Windows。macOS 请使用 npm start。');
  if(Number(process.versions.node.split('.')[0])<24)throw Error('请安装 Node.js 24 或更新版本。');
  if(action==='setup')setup();
  else if(action==='start')await start();
  else throw Error('请使用 npm run setup:win 或 npm run start:win。');
}catch(error){
  console.error(error.message);
  process.exitCode=1;
}
