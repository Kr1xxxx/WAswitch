const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcp', {
  status: () => ipcRenderer.invoke('mcp:status'),
  setEnabled: (on) => ipcRenderer.invoke('mcp:set-enabled', on),
  regenerate: () => ipcRenderer.invoke('mcp:regenerate'),
  copy: (key) => ipcRenderer.invoke('mcp:copy', key),
  onUpdate: (cb) => ipcRenderer.on('mcp:update', (_e, s) => cb(s)),
});
