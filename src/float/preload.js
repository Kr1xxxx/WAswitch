// 悬浮翻译窗能调用的接口（只有这几个，和软件界面的接口分开）。WhatsApp 页面拿不到这些。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fl', {
  onState: (cb) => ipcRenderer.on('float:state', (_e, s) => cb(s)),
  ready: () => ipcRenderer.send('float:ready'),
  translateItem: (h) => ipcRenderer.invoke('float:item', h),
  setAuto: (on) => ipcRenderer.invoke('float:auto', on === true),
  consent: (kind, ids) => ipcRenderer.invoke('float:consent', { kind, ids }),
  compose: (data) => ipcRenderer.invoke('float:compose', data),
  cancel: () => ipcRenderer.invoke('float:cancel'),
  insert: (accountId, text) => ipcRenderer.invoke('float:insert', { accountId, text }),
  copy: (text) => ipcRenderer.invoke('float:copy', text),
  setInMode: (id) => ipcRenderer.invoke('float:inmode', id),
  setLang: (accountId, lang) => ipcRenderer.invoke('float:lang', { accountId, lang }),
  move: (dx, dy) => ipcRenderer.send('float:move', { dx, dy }),
  moveEnd: () => ipcRenderer.send('float:moveend'),
  collapse: (on) => ipcRenderer.send('float:collapse', on === true),
  close: () => ipcRenderer.send('float:close'),
});
