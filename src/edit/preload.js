const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('editor', {
  load: (id) => ipcRenderer.invoke('editor:load', id),
  test: (data) => ipcRenderer.invoke('editor:test', data),
  save: (data) => ipcRenderer.invoke('editor:save', data),
});
