// 把 MCP 接到 WAswitch：控制器、设置窗口和它的 IPC。
// 这部分代码不在安装包里：发版时打成单独下载的文件（见 src/mcp-module.js 和 scripts/build-mcp.js），
// 主程序下载、校验后调用 setupMcp(...)。设置窗口的页面（settings.html / settings.js / preload.js）留在安装包里，路径由 uiDir 传进来。
// 卸载时调用 dispose()：关服务、关窗口、注销 IPC，之后可以再次 setupMcp。
const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
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
  // 第二层：第一次打开时先说明隐私影响
  handle('mcp:set-layer2', async (e, on) => {
    if (on && !controller.settings.layer2Acknowledged) {
      const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
        type: 'warning',
        buttons: ['取消', '我知道了，打开'],
        defaultId: 0,
        cancelId: 0,
        title: '打开第二层：读对话',
        message: '打开后，AI 可以在你确认后读取对话列表和聊天消息',
        detail: '读到的对话名称、聊天消息（以及你另外打开的消息预览）会发给你用的 AI 服务商，例如 Anthropic。聊天对方不会知道。\n\n每次读取都会弹窗让你确认，读消息时会写明读哪个对话；读取是只读的，不会点开别的对话、不会标已读，内容不会保存到电脑上。网页版账号只能读当前打开的那个对话，轻量版账号可以读任意对话。',
      });
      if (response !== 1) return view();
    }
    controller.setLayer2(on);
    return view();
  });
  // 打开预览就是开始读消息内容，再确认一次
  handle('mcp:set-preview', async (e, on) => {
    if (on && !controller.settings.preview) {
      const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
        type: 'warning',
        buttons: ['取消', '打开预览'],
        defaultId: 0,
        cancelId: 0,
        title: '允许读取消息预览',
        message: '预览是消息内容',
        detail: '打开后，AI 读对话列表时还会读到每个对话的最后一条消息（截到 100 字），这些内容会发给你用的 AI 服务商。聊天对方不会知道。\n\n之前给过的“10 分钟内允许”会全部清掉，下次读取会重新问你。',
      });
      if (response !== 1) return view();
    }
    controller.setPreview(on);
    return view();
  });
  // 起草回复：第一次打开时说明一下（放进输入框，不发送）
  handle('mcp:set-drafts', async (e, on) => {
    if (on && !controller.settings.drafts) {
      const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
        type: 'question',
        buttons: ['取消', '打开'],
        defaultId: 0,
        cancelId: 0,
        title: '打开起草回复',
        message: '打开后，AI 可以把写好的回复放进聊天输入框',
        detail: '只放进输入框，不会发送：发不发、什么时候发，都由你自己按。一次只能起草一条，不能群发。\n\n只有你正看着那个对话、30 秒内没打字、输入框是空的时候才会直接放进去；其他时候会在窗口顶部给你看草稿，你点“放进输入框”才放。网页版放的时候会借用一下剪贴板，放完换回去。',
      });
      if (response !== 1) return view();
    }
    controller.setDrafts(on);
    return view();
  });
  // 辅助工具：不弹窗，设置页上写清楚会发什么出去
  handle('mcp:set-helpers', (_e, on) => { controller.setHelpers(on); return view(); });
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
