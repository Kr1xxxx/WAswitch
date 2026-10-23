const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wa', {
  switchTo: (id) => ipcRenderer.send('switch', id),
  add: () => ipcRenderer.send('add'),
  remove: (id) => ipcRenderer.send('remove', id),
  rename: (id, name) => ipcRenderer.send('rename', { id, name }),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onUnread: (cb) => ipcRenderer.on('unread', (_e, u) => cb(u)),
});
