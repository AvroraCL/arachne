import {trackTextComposition} from './text-input.mjs';

// A narrow, one-way interface for desktop hosts. Project mutations still go
// through the same buttons, keyboard handlers and revision checks as the Web UI.
const commands={newProject:'new',openProject:'open-projects',saveProjectCopy:'open-project-copy',projectDetails:'open-project-details',
  importArchive:'open-paint-import',migrateModel:'open-glb-migration',searchCommands:'open-command-picker',workspaceLayouts:'open-workspace-layouts',createBackup:'create-paint-backup',downloadBackup:'download-paint-backup',
  export:'open-delivery',history:'open-history',renderTasks:'open-task-monitor',renderSettings:'open-render-settings',settings:'open-settings'};

export function createNativeWorkbench({window,document,status,flush,imageCommand}){
  const composing=trackTextComposition(document);
  function command(name){
    if(composing())return false;
    const focused=document.activeElement;
    if(name==='save'){
      if(document.querySelector('dialog[open]'))return false;
      if(focused?.matches?.('input,textarea,[contenteditable="true"]'))focused.blur();
      return true; // Project writes are automatic; blur commits an active field.
    }
    if(name==='undo'||name==='redo'){
      if(focused?.matches?.('input,textarea,[contenteditable="true"]'))return document.execCommand(name);
      if(document.querySelector('dialog[open]'))return false;
      const control=document.getElementById(name);
      if(!control||control.disabled)return false;
      control.click();return true;
    }
    if(name==='cut'||name==='pasteInPlace'){
      if(focused?.matches?.('input,textarea,[contenteditable="true"]'))
        return name==='cut'&&document.execCommand('cut');
      if(document.querySelector('dialog[open]'))return false;
      return imageCommand?.(name==='cut'?'cutSelection':'pasteInPlace')===true;
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
    if(focused?.matches?.('input,textarea,[contenteditable="true"]')){
      if(focused.validity&&!focused.validity.valid)return {state:'editing'};
      focused.blur();
    }
    return status();
  }
  async function prepareToCloseAsync(){
    const before=prepareToClose();
    if(!['ready','jobs'].includes(before.state))return before;
    await flush?.();
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
