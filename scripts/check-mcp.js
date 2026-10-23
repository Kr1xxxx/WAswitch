// MCP 接口自检：不需要 Electron、不需要 WhatsApp 账号，用假的账号数据跑一遍。
// 检查：token 文件权限、7 个一层工具、安全校验（token / Host / Origin / 路径）、stdio 桥接、关闭后清理。
// 运行：npm run check:mcp
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { McpController } = require('../src/mcp/server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

// 假的账号数据，接口和 main.js 提供的一样
function fakeHooks() {
  let accounts = [
    { id: 'a1', name: '工作号', muted: false, unread: 3, status: 'ready', problem: '' },
    { id: 'a2', name: '客服号', muted: true, unread: 1, status: 'error', problem: '代理连不上' },
  ];
  let active = 'a1';
  const state = { removeAnswer: 'cancelled', removeCalls: [] };
  return {
    state,
    listAccounts: () => accounts.map((a) => ({ ...a, active: a.id === active })),
    regions: () => [{ key: 'auto', label: '自动' }, { key: 'us', label: '美国' }],
    activate: (id) => { active = id; },
    openAddAccount: ({ name, region }) => { state.editorOpened = { name, region }; },
    renameAccount: (id, name) => {
      const a = accounts.find((x) => x.id === id);
      if (!a) return false;
      a.name = name;
      return true;
    },
    removeAccount: async (id, opts) => {
      state.removeCalls.push(opts);
      if (!accounts.find((a) => a.id === id)) return 'not_found';
      if (state.removeAnswer === 'removed') accounts = accounts.filter((a) => a.id !== id);
      return state.removeAnswer;
    },
  };
}

function rawRequest(port, { host, origin, token, path: p = '/mcp' } = {}) {
  return new Promise((resolve) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: host || `127.0.0.1:${port}`,
    };
    if (origin) headers.origin = origin;
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve('refused'));
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }));
  });
}

const json = (res) => JSON.parse(res.content[0].text);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-mcp-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ enabled: false, port }));
  const hooks = fakeHooks();
  const ctl = new McpController({ dataDir: dir, version: '0.0.0-test', hooks });
  const tokenFile = path.join(dir, 'mcp-token.json');

  await ctl.init();
  check(!ctl.status().running && !fs.existsSync(tokenFile), '默认关闭，没有 token 文件');

  await ctl.setEnabled(true);
  const s = ctl.status();
  check(s.running, `开启后在 ${s.url} 监听`);
  const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  check(tokenData.token === s.token && tokenData.port === port, 'token 文件内容正确');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(tokenFile).mode & 0o777;
    check(mode === 0o600, `token 文件权限是 0600（实际 ${mode.toString(8)}）`);
  }

  // 安全校验
  check(await rawRequest(port, {}) === 401, '不带 token 被拒绝（401）');
  check(await rawRequest(port, { token: 'x'.repeat(43) }) === 401, '错误 token 被拒绝（401）');
  check(await rawRequest(port, { token: s.token, host: `evil.example:${port}` }) === 403, '非本机 Host 被拒绝（403，防 DNS 重绑定）');
  check(await rawRequest(port, { token: s.token, origin: 'https://evil.example' }) === 403, '浏览器网页请求（带 Origin）被拒绝（403）');
  check(await rawRequest(port, { token: s.token, path: '/other' }) === 404, '其他路径 404');
  check(await rawRequest(port, { token: s.token, host: `localhost:${port}` }) === 200, 'Host 为 localhost 时可以连接');

  // 用官方 SDK 客户端走一遍工具
  const client = new Client({ name: 'check-mcp', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.token}` } } }));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ['add_account', 'get_connection_status', 'get_unread_counts', 'list_accounts', 'remove_account', 'rename_account', 'switch_account'];
  check(JSON.stringify(names) === JSON.stringify(expected), `工具列表：${names.join(', ')}`);
  check(!names.some((n) => /message|chat|send|batch/.test(n)), '没有读消息或发消息的工具');

  const list = json(await client.callTool({ name: 'list_accounts', arguments: {} }));
  check(list.length === 2 && list[0].active && !list[1].active, 'list_accounts 返回账号和当前账号');
  const unread = json(await client.callTool({ name: 'get_unread_counts', arguments: {} }));
  check(unread.total === 4, `get_unread_counts 总数 ${unread.total}`);
  const st = json(await client.callTool({ name: 'get_connection_status', arguments: { id: 'a2' } }));
  check(st.status === 'error' && st.problem === '代理连不上', 'get_connection_status 返回错误说明');
  json(await client.callTool({ name: 'switch_account', arguments: { id: 'a2' } }));
  check(hooks.listAccounts().find((a) => a.id === 'a2').active, 'switch_account 切换成功');
  const bad = await client.callTool({ name: 'switch_account', arguments: { id: 'nope' } });
  check(bad.isError, '不存在的账号返回错误');
  const added = json(await client.callTool({ name: 'add_account', arguments: { name: '新号', region: 'us' } }));
  check(added.ok && added.created === false && hooks.listAccounts().length === 2, 'add_account 不直接创建账号');
  check(hooks.state.editorOpened && hooks.state.editorOpened.name === '新号' && hooks.state.editorOpened.region === 'us', 'add_account 打开预填名称和地区的添加窗口');
  const badRegion = await client.callTool({ name: 'add_account', arguments: { region: 'mars' } });
  check(badRegion.isError, 'add_account 拒绝不存在的地区');
  json(await client.callTool({ name: 'rename_account', arguments: { id: 'a1', name: '工作号2' } }));
  check(hooks.listAccounts()[0].name === '工作号2', 'rename_account 改名成功');

  hooks.state.removeAnswer = 'cancelled';
  const rm1 = await client.callTool({ name: 'remove_account', arguments: { id: 'a1' } });
  check(rm1.isError && hooks.listAccounts().length === 2, 'remove_account：用户没确认时账号保留');
  check(hooks.state.removeCalls[0].timeoutMs === 120000, 'remove_account 的确认弹窗 2 分钟超时');
  hooks.state.removeAnswer = 'busy';
  const rmBusy = await client.callTool({ name: 'remove_account', arguments: { id: 'a1' } });
  check(rmBusy.isError && /已经有一个删除确认框/.test(rmBusy.content[0].text), 'remove_account：已有确认框时返回忙');
  hooks.state.removeAnswer = 'removed';
  const rm2 = await client.callTool({ name: 'remove_account', arguments: { id: 'a1' } });
  check(!rm2.isError && hooks.listAccounts().length === 1, 'remove_account：用户确认后删除');

  check(ctl.status().clients.some((c) => c.name.startsWith('check-mcp')), '设置页能看到已连接的客户端');
  await client.close();

  // stdio 桥接：像 Claude Desktop 一样启动 bin/waswitch-mcp.js
  const bridge = new Client({ name: 'check-bridge', version: '1.0.0' });
  await bridge.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'bin', 'waswitch-mcp.js')],
    env: { ...process.env, WASWITCH_TOKEN_FILE: tokenFile },
  }));
  const bt = await bridge.listTools();
  check(bt.tools.length === 7, `桥接程序转发工具列表（${bt.tools.length} 个）`);
  const bl = json(await bridge.callTool({ name: 'list_accounts', arguments: {} }));
  check(bl.length === 1, '桥接程序转发工具调用');

  // 换 token：旧 token 失效，桥接程序自动用新 token 重连
  const oldToken = ctl.status().token;
  await ctl.regenerateToken();
  const oldStatus = await rawRequest(port, { token: oldToken });
  check(ctl.status().token !== oldToken && oldStatus === 401, `换 token 后旧 token 失效（${oldStatus}）`);
  const bl2 = json(await bridge.callTool({ name: 'list_accounts', arguments: {} }));
  check(bl2.length === 1, '换 token 后桥接程序自动重连');
  await bridge.close();

  // 重启软件：沿用 token
  const keep = ctl.status().token;
  await ctl.close();
  const ctl2 = new McpController({ dataDir: dir, version: '0.0.0-test', hooks });
  await ctl2.init();
  check(ctl2.status().running && ctl2.status().token === keep, '重启后自动开启并沿用 token');

  await ctl2.setEnabled(false);
  check(!ctl2.status().running && !fs.existsSync(tokenFile), '关闭后停止监听并删除 token 文件');
  check(await rawRequest(port, { token: keep }) === 'refused', '关闭后连不上');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
