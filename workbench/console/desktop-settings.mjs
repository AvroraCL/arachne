import fs from 'node:fs';
import path from 'node:path';
import {DATA,atomic} from './store.mjs';
import {normalizeSettingsBundle} from './public/paint-preferences.mjs';

const file=path.join(DATA,'workbench-settings.json');

export function readDesktopSettings(){
  let raw;
  try{raw=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){
    if(error.code==='ENOENT')return {revision:0,settings:null};
    if(error instanceof SyntaxError)throw Error('本机设置文件损坏');
    throw error;
  }
  if(!Number.isSafeInteger(raw?.revision)||raw.revision<1)throw Error('本机设置版本无效');
  return {revision:raw.revision,settings:normalizeSettingsBundle(raw.settings)};
}

export function writeDesktopSettings({revision,settings}){
  const before=readDesktopSettings();
  if(revision!==before.revision)throw Object.assign(Error('本机设置已在其他窗口修改，请重新打开设置'),{status:409,currentRevision:before.revision});
  const next={revision:before.revision+1,settings:normalizeSettingsBundle(settings)};
  atomic(file,next);
  return next;
}
