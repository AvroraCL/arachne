import {normalizeSettingsBundle,preferenceKey,saveSettingsBundle} from './paint-preferences.mjs';

const endpoint='/api/desktop-settings';
const keys=[preferenceKey,'arachne-paint-brush-v1','arachne-paint-display'];

export async function connectDesktopSettings(window,storage){
  if(!window.arachneDesktop&&!window.webkit?.messageHandlers?.arachne)return null;
  let revision=null,initial=null,legacy=false;
  try{legacy=keys.some(key=>storage.getItem(key)!==null);}catch{}

  async function request(options){
    const response=await fetch(endpoint,{...options,signal:AbortSignal.timeout(2000)});
    const result=await response.json();
    if(!response.ok)throw Object.assign(Error(result.error||'无法读取本机设置'),{status:response.status});
    return result;
  }
  function accept(result){
    if(!Number.isSafeInteger(result.revision)||result.revision<0)throw Error('本机设置版本无效');
    const settings=result.settings===null?null:normalizeSettingsBundle(result.settings);
    const changed=revision!==result.revision;
    revision=result.revision;
    if(changed&&settings)try{saveSettingsBundle(storage,settings);}catch{}
    return changed?settings:null;
  }
  async function refresh(){return accept(await request());}
  async function save(settings){
    if(revision===null)await refresh();
    const result=await request({method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({revision,settings})});
    return accept(result)||normalizeSettingsBundle(result.settings);
  }
  try{initial=await refresh();}
  catch(error){if(error.status===404)return null;}
  return {initial,refresh,save,migrate:legacy&&revision===0};
}
