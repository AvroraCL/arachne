const {contextBridge,ipcRenderer}=require('electron');

contextBridge.exposeInMainWorld('arachneDesktop',Object.freeze({
  notifyProject:(id,name)=>ipcRenderer.send('arachne:project',id,name)
}));
