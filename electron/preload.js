const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('edunova', {
  install: scope => ipcRenderer.invoke('install', scope),
  saveConfig: values => ipcRenderer.invoke('save-config', values),
  launch: () => ipcRenderer.invoke('launch'),
  hasConfig: () => ipcRenderer.invoke('has-config'),
  onLog: callback => ipcRenderer.on('log', (_event, value) => callback(value))
});
