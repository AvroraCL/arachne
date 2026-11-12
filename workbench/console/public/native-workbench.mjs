import {trackTextComposition} from './text-input.mjs';

// A narrow, one-way interface for desktop hosts. Project mutations still go
// through the same buttons, keyboard handlers and revision checks as the Web UI.
const commands={newProject:'new',openProject:'open-projects',saveProjectCopy:'open-project-copy',projectDetails:'open-project-details',
  importArchive:'open-paint-import',migrateModel:'open-glb-migration',searchCommands:'open-command-picker',workspaceLayouts:'open-workspace-layouts',createBackup:'create-paint-backup',downloadBackup:'download-paint-backup',
  export:'open-delivery',history:'open-history',renderTasks:'open-task-monitor',renderSettings:'open-render-settings',settings:'open-settings'};

const textTarget='textarea,[contenteditable]:not([contenteditable="false"]),input:is(:not([type]),[type=text],[type=search],[type=url],[type=email],[type=tel],[type=password],[type=number])';
const clipboardActions=new Set(['cut','copy','paste','selectAll']);

export function createNativeWorkbench({window,document,status,flush,imageCommand,editorCommand,save}){
  const composing=trackTextComposition(document);
  function command(name,{nativeEdit=false}={}){
    if(composing())return false;
    const focused=document.activeElement;
    const text=focused?.matches?.(textTarget),modal=document.querySelector('dialog[open]');
    if(name==='save'){
      if(modal)return false;
      if(text)focused.blur();
      save?.();
      return true; // Project writes are automatic; blur commits an active field.
    }
    if(name==='undo'||name==='redo'){
      if(text)return document.execCommand(name);
      if(modal)return false;
      const handled=editorCommand?.(name,focused);
      if(handled!==undefined)return handled;
      const control=document.getElementById(name);
      if(!control||control.disabled)return false;
      control.click();return true;
    }
    if(clipboardActions.has(name)){
      const fallback=()=>nativeEdit?'native-text':document.execCommand(name);
      if(text)return fallback();
      if(modal)return name==='paste'&&nativeEdit?'native-text':false;
      const handled=editorCommand?.(name,focused);
      if(handled!==undefined)return handled;
      if(name==='cut')return imageCommand?.('cutSelection',focused)===true;
      if(name==='paste'&&nativeEdit)return imageCommand?.('pasteSystemImage',focused)===true?true:'native-text';
      return name==='copy'&&window.getSelection?.()?.toString()?fallback():false;
    }
    if(['copyMerged','pasteInPlace'].includes(name)){
      if(text||modal)return false;
      return imageCommand?.(name,focused)===true;
    }
    const id=commands[name];
    if(!id||document.querySelector('dialog[open]'))return false;
    const element=document.getElementById(id);
    if(!element||element.disabled||element.hidden)return false;
    element.click();return true;
  }
  function prepareToClose(){
    if(composing())return {state:'editing'};
    if(document.querySelector('dialog[open]'))return status();
    const focused=document.activeElement;
    if(focused?.matches?.(textTarget)){
      if(focused.validity&&!focused.validity.valid)return {state:'editing'};
      focused.blur();
    }
    return status();
  }
  async function prepareToCloseAsync(){
    const before=prepareToClose();
    if(!['ready','jobs'].includes(before.state))return before;
    if(await flush?.()===false)return {state:'unsaved'};
    return status();
  }
  return Object.freeze({command,status,prepareToClose,prepareToCloseAsync});
}

export function notifyNativeProject(window,project){
  if(!project?.id)return;
  try{
    if(window.arachneDesktop)window.arachneDesktop.notifyProject(project.id,project.name||'');
    else window.webkit?.messageHandlers?.arachne?.postMessage({type:'project',id:project.id,name:project.name||''});
  }catch{}
}
