import fs from 'node:fs';
import path from 'node:path';
import {DATA,atomic} from './store.mjs';
import {validateLayout,workspaceNames} from './public/workspace-state.mjs';

const file=path.join(DATA,'workbench-layout.json');

function checked(layout){
  if(!layout||layout.layerEditorVersion!==2||!Object.hasOwn(workspaceNames,layout.activeWorkspace))
    throw Error('本机工作区布局格式无效');
  const trees=Object.fromEntries(Object.keys(workspaceNames).map(name=>[name,validateLayout(layout[name])]));
  return {...trees,activeWorkspace:layout.activeWorkspace,layerEditorVersion:2};
}

export function readDesktopWorkspace(){
  let raw;
  try{raw=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){
    if(error.code==='ENOENT')return {revision:0,layout:null};
    if(error instanceof SyntaxError)throw Error('本机工作区布局文件损坏');
    throw error;
  }
  if(!Number.isSafeInteger(raw?.revision)||raw.revision<1)throw Error('本机工作区布局版本无效');
  return {revision:raw.revision,layout:checked(raw.layout)};
}

export function writeDesktopWorkspace({revision,layout}){
  const before=readDesktopWorkspace();
  if(revision!==before.revision)
    throw Object.assign(Error('本机布局已在其他窗口修改'),{status:409,currentRevision:before.revision});
  const next={revision:before.revision+1,layout:checked(layout)};
  atomic(file,next);
  return next;
}
