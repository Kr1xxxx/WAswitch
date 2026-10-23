// 软件界面（侧栏、顶栏、设置、编辑账号）能调用的全部接口。WhatsApp 页面拿不到这些。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wa', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  switchTo: (id) => ipcRenderer.send('switch', id),
  add: () => ipcRenderer.send('add'),
  edit: (id) => ipcRenderer.send('edit', id),
  context: (id) => ipcRenderer.send('context', id),
  reload: (id) => ipcRenderer.send('reload', id),
  retry: (id) => ipcRenderer.send('retry', id),
  toggleCollapse: () => ipcRenderer.send('collapse'),
  showPage: (page) => ipcRenderer.send('page', page),
  setSetting: (key, value) => ipcRenderer.send('setting', { key, value }),
  setMuted: (id, muted) => ipcRenderer.send('mute', { id, muted }),
  runCheck: () => ipcRenderer.invoke('check:run'),
  openLogs: () => ipcRenderer.send('open-logs'),
  openSource: () => ipcRenderer.send('open-source'),
  editorLoad: (id) => ipcRenderer.invoke('editor:load', id),
  editorTest: (data) => ipcRenderer.invoke('editor:test', data),
  editorSave: (data) => ipcRenderer.invoke('editor:save', data),
});
