import {APP_VERSION} from './app-version.mjs';
import {preferenceDefaults,brushDefaults,normalizeSettingsBundle,saveSettingsBundle} from './paint-preferences.mjs';
import {sceneOptions} from './scene-options.mjs';
import {setSelectValue,enhanceSelectMenu} from './paint-select.mjs';

const $=id=>document.getElementById(id);
export function setupPaintSettings({snapshot,apply,canOpen}){
  document.querySelector('#settings-title+small').textContent='阿拉克涅 · '+APP_VERSION;
  const dialog=$('settings-dialog'),form=$('settings-form'),error=$('settings-error');
  const controls=[...form.querySelectorAll('[data-setting]')];
  const tabs=[...dialog.querySelectorAll('[data-settings-tab]')];
  const sections=[...dialog.querySelectorAll('[data-settings-section]')];
  const status=$('settings-save-state');
  let draft=null,focusBefore=null,baseline=null;
  const message=text=>{error.textContent=text;};
  function showTab(id){
    for(const tab of tabs){const active=tab.dataset.settingsTab===id;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}
    for(const section of sections)section.hidden=section.dataset.settingsSection!==id;
  }
  for(const tab of tabs){
    tab.onclick=()=>showTab(tab.dataset.settingsTab);
    tab.onkeydown=event=>{
      const index=tabs.indexOf(tab),next={ArrowDown:(index+1)%tabs.length,ArrowUp:(index+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[event.key];
      if(next===undefined)return;
      event.preventDefault();showTab(tabs[next].dataset.settingsTab);tabs[next].focus();
    };
  }
  function updateReadouts(){
    for(const control of controls){
      const output=control.parentElement.querySelector('output');
      if(output)output.textContent=control.dataset.setting==='detailDelay'?(Number(control.value)/1000).toFixed(1)+' 秒':
        control.dataset.setting==='uvRadius'?control.value+' px':Number(control.value).toFixed(control.step==='1'?0:2);
    }
    $('settings-detail-delay').disabled=!$('settings-auto-detail').checked;
  }
  function populate(bundle){
    draft=structuredClone(bundle);
    for(const control of controls){
      const value=draft[control.dataset.group][control.dataset.setting];
      if(control.type==='checkbox')control.checked=value;
      else if(control.tagName==='SELECT')setSelectValue(control,String(value));
      else control.value=value;
    }
    updateReadouts();
  }
  function collect(){
    const next=structuredClone(draft);
    for(const control of controls)next[control.dataset.group][control.dataset.setting]=
      control.type==='checkbox'?control.checked:['range','number'].includes(control.type)?Number(control.value):control.value;
    return normalizeSettingsBundle(next);
  }
  function changed(){
    updateReadouts();
    status.textContent=JSON.stringify(collect())===JSON.stringify(baseline)?'设置保存在此浏览器':'有未保存的更改';message('');
  }
  for(const control of controls)for(const type of ['input','change'])control.addEventListener(type,changed);
  function open(){
    if(dialog.open)return;
    if(!canOpen()||document.querySelector('dialog[open]'))return;
    focusBefore=document.activeElement;
    document.querySelectorAll('.paint-menu[open]').forEach(menu=>menu.open=false);
    baseline=snapshot();populate(baseline);status.textContent='设置保存在此浏览器';message('');showTab('interface');
    dialog.showModal();tabs[0].focus();
  }
  const close=()=>dialog.close();
  $('open-settings').onclick=open;$('close-settings').onclick=close;$('cancel-settings').onclick=close;
  dialog.addEventListener('close',()=>{message('');if(focusBefore?.isConnected)focusBefore.focus({preventScroll:true});});
  dialog.addEventListener('cancel',()=>message(''));
  document.addEventListener('keydown',event=>{
    if((event.metaKey||event.ctrlKey)&&event.key===','){
      event.preventDefault();event.stopImmediatePropagation();open();
    }
  },true);
  form.onsubmit=event=>{
    event.preventDefault();
    try{const bundle=saveSettingsBundle(localStorage,collect());apply(bundle);close();}
    catch(e){message(e.message);}
  };
  $('reset-settings').onclick=()=>{
    populate({version:1,preferences:{...preferenceDefaults},brush:{...brushDefaults},display:sceneOptions()});
    status.textContent='默认值已载入，保存后生效';message('');
  };
  $('export-settings').onclick=()=>{
    try{
      const bundle=collect(),url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)+'\n'],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='arachne-settings.json';document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);message('');
    }catch(e){message(e.message);}
  };
  $('import-settings').onclick=()=>$('settings-file').click();
  $('settings-file').onchange=async()=>{
    const file=$('settings-file').files?.[0];$('settings-file').value='';if(!file)return;
    try{
      if(file.size>32768)throw Error('设置文件不能超过 32 KiB');
      const bundle=normalizeSettingsBundle(JSON.parse(await file.text()));if(!dialog.open)return;
      populate(bundle);status.textContent='设置已导入，保存后生效';message('');
    }catch(e){if(dialog.open)message(e instanceof SyntaxError?'设置文件不是有效的 JSON':e.message);}
  };
  for(const select of form.querySelectorAll('select'))enhanceSelectMenu(select);
  return {open};
}
