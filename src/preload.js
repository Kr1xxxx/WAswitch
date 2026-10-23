const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wa', {
  switchTo: (id) => ipcRenderer.send('switch', id),
  add: () => ipcRenderer.send('add'),
  context: (id) => ipcRenderer.send('context', id),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onUnread: (cb) => ipcRenderer.on('unread', (_e, u) => cb(u)),
});
