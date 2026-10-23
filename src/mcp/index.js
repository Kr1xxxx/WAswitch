// 把 MCP 接到 WAswitch：控制器、设置窗口和它的 IPC。
// main.js 只需要调用 setupMcp(...)，并在托盘菜单里放一个“MCP 接口设置”入口。
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const { McpController } = require('./server');

function setupMcp({ hooks, lockLocalPage }) {
  let win = null;
  const controller = new McpController({
    dataDir: app.getPath('userData'),
    version: app.getVersion(),
    hooks,
    onChange: () => { if (win && !win.isDestroyed()) win.webContents.send('mcp:update', view()); },
  });

  function snippets(s) {
    if (!s.running) return { claudeCode: '', claudeDesktop: '' };
    const bridge = path.join(app.getAppPath(), 'bin', 'waswitch-mcp.js');
    return {
      claudeCode: `claude mcp add --transport http waswitch ${s.url} --header "Authorization: Bearer ${s.token}"`,
      claudeDesktop: JSON.stringify({
        mcpServers: {
          waswitch: {
            command: process.execPath,
            args: [bridge],
            env: { ELECTRON_RUN_AS_NODE: '1', WASWITCH_TOKEN_FILE: s.tokenFile },
          },
        },
      }, null, 2),
    };
  }

  // 给设置窗口的数据：token 只出现在复制用的命令里
  function view() {
    const s = controller.status();
    const { token, ...rest } = s;
    return { ...rest, snippets: snippets(s) };
  }

  ipcMain.handle('mcp:status', () => view());
  ipcMain.handle('mcp:set-enabled', async (_e, on) => { await controller.setEnabled(on); return view(); });
  ipcMain.handle('mcp:regenerate', async () => { await controller.regenerateToken(); return view(); });
  ipcMain.handle('mcp:copy', (_e, key) => {
    const text = snippets(controller.status())[key];
    if (text) clipboard.writeText(text);
  });

  function openSettings() {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
    win = new BrowserWindow({
      width: 620, height: 680, minimizable: false, maximizable: false, title: 'MCP 接口设置',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenu(null);
    lockLocalPage(win.webContents);
    win.loadFile(path.join(__dirname, 'settings.html'));
    win.on('closed', () => { win = null; });
  }

  return { controller, openSettings, init: () => controller.init(), close: () => controller.close() };
}

module.exports = { setupMcp };
