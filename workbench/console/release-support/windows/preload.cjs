const {contextBridge,ipcRenderer}=require('electron');

contextBridge.exposeInMainWorld('arachneDesktop',Object.freeze({
  notifyProject:(id,name)=>ipcRenderer.send('arachne:project',id,name),
  writeImageClipboard:bytes=>ipcRenderer.invoke('arachne:clipboard-image',bytes),
  readImageClipboard:()=>ipcRenderer.invoke('arachne:read-clipboard-image'),
  writeNodeClipboard:text=>ipcRenderer.invoke('arachne:clipboard-nodes',text),
  readNodeClipboard:()=>ipcRenderer.invoke('arachne:read-clipboard-nodes')
}));
