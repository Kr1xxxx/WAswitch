// 把 MCP 接到 WAswitch：控制器、设置窗口和它的 IPC。
// 这部分代码不在安装包里：发版时打成单独下载的文件（见 src/mcp-module.js 和 scripts/build-mcp.js），
// 主程序下载、校验后调用 setupMcp(...)。设置窗口的页面（settings.html / settings.js / preload.js）留在安装包里，路径由 uiDir 传进来。
// 卸载时调用 dispose()：关服务、关窗口、注销 IPC，之后可以再次 setupMcp。
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const { McpController } = require('./server');

// bridgeArgs：Claude Desktop 配置里用 WAswitch 自带的 Electron 运行 stdio 桥接时的参数
// onStatus：状态变了（开关、运行、出错）时通知主程序刷新设置页
function setupMcp({ hooks, lockLocalPage, uiDir = __dirname, bridgeArgs, onStatus = () => {} }) {
  let win = null;
  const controller = new McpController({
    dataDir: app.getPath('userData'),
    version: app.getVersion(),
    hooks,
    onChange: () => {
      if (win && !win.isDestroyed()) win.webContents.send('mcp:update', view());
      onStatus();
    },
  });

  function snippets(s) {
    if (!s.running) return { claudeCode: '', claudeDesktop: '' };
    const args = bridgeArgs || [path.join(app.getAppPath(), 'bin', 'waswitch-mcp.js')];
    return {
      claudeCode: `claude mcp add --transport http waswitch ${s.url} --header "Authorization: Bearer ${s.token}"`,
      claudeDesktop: JSON.stringify({
        mcpServers: {
          waswitch: {
            command: process.execPath,
            args,
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

  // 用 handle() 注册，dispose() 时一起注销
  const channels = [];
  const handle = (ch, fn) => { ipcMain.removeHandler(ch); ipcMain.handle(ch, fn); channels.push(ch); };
  handle('mcp:status', () => view());
  handle('mcp:set-enabled', async (_e, on) => { await controller.setEnabled(on); return view(); });
  handle('mcp:regenerate', async () => { await controller.regenerateToken(); return view(); });
  // 这些开关打开时不弹说明：随时能关，读对话、读消息、搜客户每次都另有确认，AI 改客户资料可以在「AI 操作记录」里撤销
  handle('mcp:set-layer2', (_e, on) => { controller.setLayer2(on); return view(); });
  handle('mcp:set-preview', (_e, on) => { controller.setPreview(on); return view(); });
  handle('mcp:set-drafts', (_e, on) => { controller.setDrafts(on); return view(); });
  handle('mcp:set-customers', (_e, on) => { controller.setCustomers(on); return view(); });
  handle('mcp:revoke-customers', (_e, key) => { controller.customerGate.revoke(key); return view(); });
  // 辅助工具：不弹窗，设置页上写清楚会发什么出去
  handle('mcp:set-helpers', (_e, on) => { controller.setHelpers(on); return view(); });
  handle('mcp:set-customer-edit', (_e, on) => { controller.setCustomerEdit(on); return view(); });
  // 撤销一条 AI 操作，返回 { view, message }
  handle('mcp:undo', (_e, id) => {
    const r = typeof id === 'string' ? controller.aiLog.undo(id) : { ok: false, message: '找不到这条记录' };
    return { view: view(), ...r };
  });
  handle('mcp:revoke', (_e, key) => { controller.gate.revoke(key); return view(); });
  handle('mcp:copy', (_e, key) => {
    const text = snippets(controller.status())[key];
    if (text) clipboard.writeText(text);
  });

  function openSettings() {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
    win = new BrowserWindow({
      width: 620, height: 680, minimizable: false, maximizable: false, title: 'MCP 接口设置',
      webPreferences: { preload: path.join(uiDir, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenu(null);
    lockLocalPage(win.webContents);
    win.loadFile(path.join(uiDir, 'settings.html'));
    win.on('closed', () => { win = null; });
  }

  async function dispose() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    for (const ch of channels) ipcMain.removeHandler(ch);
    await controller.close();
  }

  return { controller, openSettings, init: () => controller.init(), close: () => controller.close(), dispose };
}

module.exports = { setupMcp };
