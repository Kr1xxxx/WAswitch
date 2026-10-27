// 通知弹窗页面能调用的接口（只有这几个）。WhatsApp 页面拿不到这些。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pp', {
  onState: (cb) => ipcRenderer.on('popup:state', (_e, s) => cb(s)),
  ready: () => ipcRenderer.send('popup:ready'),
  hover: (on) => ipcRenderer.send('popup:hover', on === true),
  act: (uid, action) => ipcRenderer.send('popup:act', { uid: Number(uid), action: String(action) }),
});
