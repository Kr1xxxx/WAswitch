const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcp', {
  status: () => ipcRenderer.invoke('mcp:status'),
  setEnabled: (on) => ipcRenderer.invoke('mcp:set-enabled', on),
  regenerate: () => ipcRenderer.invoke('mcp:regenerate'),
  setLayer2: (on) => ipcRenderer.invoke('mcp:set-layer2', on),
  setPreview: (on) => ipcRenderer.invoke('mcp:set-preview', on),
  setDrafts: (on) => ipcRenderer.invoke('mcp:set-drafts', on),
  setHelpers: (on) => ipcRenderer.invoke('mcp:set-helpers', on),
  revoke: (key) => ipcRenderer.invoke('mcp:revoke', key),
  copy: (key) => ipcRenderer.invoke('mcp:copy', key),
  onUpdate: (cb) => ipcRenderer.on('mcp:update', (_e, s) => cb(s)),
});
