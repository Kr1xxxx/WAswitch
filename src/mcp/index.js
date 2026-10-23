// 把 MCP 接到 WAswitch：控制器、设置窗口和它的 IPC。
// main.js 只需要调用 setupMcp(...)，并在托盘菜单里放一个“MCP 接口设置”入口。
const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
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

  // 给设置窗口的数据：显示的命令里 token 打码，点“复制”时才取真实 token
  function view() {
    const s = controller.status();
    const { token, ...rest } = s;
    const shown = snippets(s);
    if (token) shown.claudeCode = shown.claudeCode.replace(token, `${token.slice(0, 4)}••••••••`);
    return { ...rest, snippets: shown };
  }

  ipcMain.handle('mcp:status', () => view());
  ipcMain.handle('mcp:set-enabled', async (_e, on) => { await controller.setEnabled(on); return view(); });
  ipcMain.handle('mcp:regenerate', async () => { await controller.regenerateToken(); return view(); });
  // 第二层：第一次打开时先说明隐私影响
  ipcMain.handle('mcp:set-layer2', async (e, on) => {
    if (on && !controller.settings.layer2Acknowledged) {
      const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
        type: 'warning',
        buttons: ['取消', '我知道了，打开'],
        defaultId: 0,
        cancelId: 0,
        title: '打开第二层：读对话列表',
        message: '打开后，AI 可以在你确认后读取对话列表',
        detail: '读到的对话名称（以及你另外打开的消息预览）会发给你用的 AI 服务商，例如 Anthropic。聊天对方不会知道。\n\n每次读取都会弹窗让你确认；读取是只读的，不会点开对话、不会标已读，内容不会保存到电脑上。',
      });
      if (response !== 1) return view();
    }
    controller.setLayer2(on);
    return view();
  });
  ipcMain.handle('mcp:set-preview', (_e, on) => { controller.setPreview(on); return view(); });
  ipcMain.handle('mcp:revoke', (_e, key) => { controller.gate.revoke(key); return view(); });
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
