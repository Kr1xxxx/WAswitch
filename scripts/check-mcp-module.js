// MCP 单独下载模块自检：不需要 Electron、不联网。
// 检查：打包出的单文件能当 MCP 服务和 stdio 桥接用；下载、校验、加载、取消、坏文件、软件更新后补下、卸载。
// 运行：node scripts/check-mcp-module.js（npm run check:mcp 会一起跑）
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { McpModule, loadExpected, BRIDGE_ARG } = require('../src/mcp-module');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// 在 Electron 里 'electron' 是内置模块；这里用普通 Node 跑，下载到临时目录的文件要能找到仓库里的 electron 包
process.env.NODE_PATH = path.join(__dirname, '..', 'node_modules');
require('module').Module._initPaths();

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

const root = path.join(__dirname, '..');
const hooks = {
  listAccounts: () => [{ id: 'a1', name: '工作号', active: true, unread: 0, muted: false, status: 'ready', login: 'logged_in', problem: '' }],
  regions: () => [{ key: 'auto', label: '自动' }],
  activate: () => 'done',
  openAddAccount: () => 'done',
  renameAccount: () => true,
  removeAccount: async () => 'cancelled',
  checkLogin: async () => 'logged_in',
  readChatList: async () => ({ ok: false, reason: 'empty' }),
  confirmRead: async () => 'deny',
};

async function checkBundle(bundle, tmp) {
  // 主进程那样 require：导出 setupMcp
  const mod = require(bundle);
  check(typeof mod.setupMcp === 'function' && mod.BRIDGE_ARG === BRIDGE_ARG, '打包文件导出 setupMcp');
  // 用打包文件里的服务端跑一遍：工具列表、调用
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
  fs.writeFileSync(path.join(dataDir, 'mcp.json'), JSON.stringify({ enabled: true, port: 39000 + Math.floor(Math.random() * 900) }));
  const ctl = new mod.McpController({ dataDir, version: 'test', hooks });
  await ctl.init();
  const st = ctl.status();
  check(st.running, `打包文件里的 MCP 服务能启动（${st.error || st.url}）`);
  const client = new Client({ name: 'check-module', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(st.url), { requestInit: { headers: { Authorization: `Bearer ${st.token}` } } }));
  const tools = await client.listTools();
  check(tools.tools.length === 7, `打包文件的工具列表（${tools.tools.length} 个）`);
  await client.close();
  // 像 Claude Desktop 那样用打包文件 + 桥接参数启动
  const bridge = new Client({ name: 'check-bridge', version: '1.0.0' });
  await bridge.connect(new StdioClientTransport({
    command: process.execPath,
    args: [bundle, BRIDGE_ARG],
    env: { ...process.env, WASWITCH_TOKEN_FILE: st.tokenFile },
  }));
  const bt = await bridge.listTools();
  check(bt.tools.length === 7, `打包文件当 stdio 桥接用（${bt.tools.length} 个工具）`);
  await bridge.close();
  await ctl.close();
}

// 假的下载：按块把 bytes 交给 onData；hold 为 true 时停在半路等取消
function fakeFetch(state) {
  return async (url, { onData, signal }) => {
    state.urls.push(url);
    const bytes = state.bytes;
    const step = Math.ceil(bytes.length / 4);
    for (let i = 0; i < bytes.length; i += step) {
      if (signal.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
      onData(bytes.subarray(i, i + step), Math.min(bytes.length, i + step), bytes.length);
      if (state.hold) {
        await new Promise((resolve) => { signal.addEventListener('abort', resolve); });
        throw Object.assign(new Error('已取消'), { cancelled: true });
      }
    }
    if (state.fail) throw new Error(state.fail);
    return bytes.length;
  };
}

function makeModule(dataDir, expected, state) {
  const calls = { start: [], dispose: 0, changes: 0 };
  const m = new McpModule({
    dir: path.join(dataDir, 'modules', 'mcp'),
    dataDir,
    appDir: root,
    uiDir: path.join(root, 'src', 'mcp'),
    expected,
    dev: false,
    owner: 'Kr1xxxx',
    repo: 'WAswitch',
    fetch: fakeFetch(state),
    loadDev: () => { throw new Error('不该用开发版'); },
    start: async (setupMcp, extra) => {
      calls.start.push({ ok: typeof setupMcp === 'function', ...extra });
      let enabled = false;
      return {
        controller: { status: () => ({ enabled, running: enabled, url: 'http://127.0.0.1:1/mcp', error: '' }), setEnabled: async (on) => { enabled = on; } },
        dispose: async () => { calls.dispose += 1; },
        close: async () => {},
        openSettings: () => {},
      };
    },
    stopped: () => {},
    onChange: () => { calls.changes += 1; },
  });
  return { m, calls };
}

async function checkLoader(bundleFile, expected, tmp) {
  const bytes = fs.readFileSync(bundleFile);
  const dataDir = fs.mkdtempSync(path.join(tmp, 'user-'));
  const dir = path.join(dataDir, 'modules', 'mcp');
  // 旧版本开着 MCP
  fs.writeFileSync(path.join(dataDir, 'mcp.json'), JSON.stringify({ enabled: true, port: 39393, layer2: true, layer2Acknowledged: true }));
  fs.writeFileSync(path.join(dataDir, 'mcp-token.json'), JSON.stringify({ token: 'x'.repeat(40), url: 'u' }));

  const state = { bytes, urls: [] };
  let { m, calls } = makeModule(dataDir, expected, state);
  await m.init();
  check(m.status === 'none' && !state.urls.length && !calls.start.length, '没下载过：启动时不下载、不加载');
  check(m.view().legacy === true, '旧版本开着 MCP 的人看到“现在要单独下载”的提示');
  check(m.view().sizeMB > 0, `显示大小（约 ${m.view().sizeMB} MB）`);

  // 校验不通过
  state.bytes = Buffer.concat([bytes, Buffer.from('\n// 被改过')]);
  await m.download();
  check(m.status === 'error' && /校验/.test(m.error), `下载的文件被改过：报错（${m.error}）`);
  check(!fs.existsSync(path.join(dir, 'waswitch-mcp.js')) && !fs.existsSync(path.join(dir, 'waswitch-mcp.js.part')) && !calls.start.length, '被改过的文件删掉、不加载');

  // 下载中取消
  state.bytes = bytes;
  state.hold = true;
  const p = m.download();
  await wait(20);
  check(m.status === 'downloading' && m.view().percent > 0, `下载中显示进度（${m.view().percent}%）`);
  m.cancel();
  await p;
  check(m.status === 'none' && !m.error && !fs.existsSync(path.join(dir, 'waswitch-mcp.js.part')), '取消下载：回到未下载，不留半截文件');
  state.hold = false;

  // 正常下载
  await m.download();
  if (m.status !== 'ready') console.log(`  （状态 ${m.status}：${m.error}）`);
  const url = state.urls[state.urls.length - 1];
  check(url === `https://github.com/Kr1xxxx/WAswitch/releases/download/v${expected.version}/${expected.file}`, `下载地址是同版本的 Release 文件（${url}）`);
  const conf = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp.json'), 'utf8'));
  check(m.status === 'ready' && conf.enabled === false && conf.layer2 === true, '第一次下载后开关是关的（其他设置保留）');
  check(calls.start.length === 0, '开关关着时不加载 MCP 代码（不占内存）');
  check(m.view().legacy === false && m.view().enabled === false && m.available(), '下载后提示消失，开关显示关，托盘里有 MCP 设置');
  await m.setEnabled(true);
  check(calls.start.length === 1 && calls.start[0].ok && m.view().enabled === true, '打开开关时校验并加载');
  check(calls.start[0].bridgeArgs[0] === path.join(dir, 'waswitch-mcp.js') && calls.start[0].bridgeArgs[1] === BRIDGE_ARG, '桥接用固定文件名，升级后 Claude Desktop 配置不用改');
  fs.writeFileSync(path.join(dataDir, 'mcp.json'), JSON.stringify({ ...conf, enabled: true }));

  // 重启：开关开着，直接加载，不再下载
  const n = state.urls.length;
  ({ m, calls } = makeModule(dataDir, expected, state));
  await m.init();
  check(m.status === 'ready' && state.urls.length === n && calls.start.length === 1, '重启后校验本地文件直接加载，不重新下载');

  // 重启：开关关着，不加载；点“详细设置”时才加载
  fs.writeFileSync(path.join(dataDir, 'mcp.json'), JSON.stringify({ ...conf, enabled: false }));
  ({ m, calls } = makeModule(dataDir, expected, state));
  await m.init();
  check(m.status === 'ready' && calls.start.length === 0, '重启后开关关着：不加载');
  await m.openSettings();
  check(calls.start.length === 1, '打开详细设置时才加载');

  // 开关关着时本地文件被改：打开开关时发现，不加载，报错可重试
  fs.appendFileSync(path.join(dir, 'waswitch-mcp.js'), '\n// 坏了');
  ({ m, calls } = makeModule(dataDir, expected, state));
  await m.init();
  await m.setEnabled(true);
  check(m.status === 'error' && calls.start.length === 0 && /校验/.test(m.error) && m.view().installed, `本地文件被改过：打开时不加载，报错（${m.error}）`);
  await m.download();
  check(m.status === 'ready' && state.urls.length === n + 1, '点“重试”重新下载');
  fs.writeFileSync(path.join(dataDir, 'mcp.json'), JSON.stringify({ ...conf, enabled: true }));

  // 开关开着时本地文件被改：启动时不加载坏文件，自动重新下载
  fs.appendFileSync(path.join(dir, 'waswitch-mcp.js'), '\n// 坏了');
  ({ m, calls } = makeModule(dataDir, expected, state));
  await m.init();
  for (let i = 0; i < 50 && m.status === 'downloading'; i += 1) await wait(10);
  check(m.status === 'ready' && state.urls.length === n + 2 && calls.start.length === 1, '本地文件被改过：不加载坏文件，自动重新下载后加载');

  // 软件更新后：版本对不上，自动补下，开关状态不变
  fs.writeFileSync(path.join(dataDir, 'mcp.json'), JSON.stringify({ ...conf, enabled: true }));
  fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ version: '0.0.1', sha512: 'old' }));
  ({ m, calls } = makeModule(dataDir, expected, state));
  await m.init();
  check(m.updating === true, '软件更新后自动补下配套的 MCP');
  for (let i = 0; i < 50 && m.status === 'downloading'; i += 1) await wait(10);
  const conf2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp.json'), 'utf8'));
  check(m.status === 'ready' && conf2.enabled === true && calls.start.length === 1, '补下后照常加载，开关保持原来的状态');

  // 卸载
  fs.writeFileSync(path.join(dataDir, 'mcp-token.json'), JSON.stringify({ token: 'x'.repeat(40), url: 'u' }));
  await m.uninstall();
  const conf3 = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp.json'), 'utf8'));
  check(m.status === 'none' && calls.dispose === 1, '卸载：关掉 MCP');
  check(!fs.existsSync(path.join(dir, 'waswitch-mcp.js')) && !fs.existsSync(path.join(dir, 'installed.json')) && !fs.existsSync(path.join(dataDir, 'mcp-token.json')), '卸载：删掉文件和 token');
  check(conf3.enabled === false && conf3.layer2 === true && m.view().legacy === false, '卸载：开关关掉，其他设置保留，不显示旧版本提示');
  ({ m, calls } = makeModule(dataDir, expected, state));
  await m.init();
  check(m.status === 'none' && calls.start.length === 0, '卸载后重启：不自动下载');

  // 安装包里没带信息（不是开发版）
  const u = makeModule(dataDir, null, state).m;
  check(u.status === 'unavailable', '安装包没带 MCP 信息时显示不可用');
}

async function main() {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-mcp.js')], { stdio: 'inherit' });
  const expected = loadExpected(path.join(root, 'dist-mcp', 'mcp-module.json'));
  check(!!expected, '生成了 mcp-module.json');
  const bundle = path.join(root, 'dist-mcp', expected.file);
  const sha = crypto.createHash('sha512').update(fs.readFileSync(bundle)).digest('base64');
  check(sha === expected.sha512, 'mcp-module.json 里的 sha512 和文件一致');
  const src = fs.readFileSync(bundle, 'utf8');
  check(!/require\("(@modelcontextprotocol|zod)/.test(src), '打包文件不依赖安装包里的库');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mcpmod-'));
  try {
    await checkBundle(bundle, tmp);
    await checkLoader(bundle, expected, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
