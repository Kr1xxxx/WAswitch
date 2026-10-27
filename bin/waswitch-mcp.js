#!/usr/bin/env node
// stdio 桥接：给只支持 stdio 的 MCP 客户端（例如 Claude Desktop）用。
// 它从 WAswitch 的 mcp-token.json 读取端口和 token，把请求转发给正在运行的 WAswitch。
//
// 用法（WAswitch 的“MCP 接口设置”窗口会生成完整配置）：
//   WASWITCH_TOKEN_FILE=<userData>/mcp-token.json node bin/waswitch-mcp.js
// 也可以用 WAswitch 自带的 Electron 运行：设置 ELECTRON_RUN_AS_NODE=1。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// 没指定时按 Electron 的默认 userData 位置找
function candidates() {
  if (process.env.WASWITCH_TOKEN_FILE) return [process.env.WASWITCH_TOKEN_FILE];
  const base = process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return ['WAswitch', 'waswitch'].map((n) => path.join(base, n, 'mcp-token.json'));
}

function readToken() {
  for (const file of candidates()) {
    try {
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (t.token && t.url) return t;
    } catch { /* 下一个 */ }
  }
  return null;
}

const log = (msg) => process.stderr.write(`[waswitch-mcp] ${msg}\n`);

async function main() {
  const conf = readToken();
  const server = new Server({ name: 'waswitch', version: '0.1.0' }, { capabilities: { tools: {} } });
  let client = null;

  // 每次需要时才连接；WAswitch 重启或换 token 后自动重连
  async function getClient() {
    if (client) return client;
    const t = readToken() || conf;
    if (!t) throw new Error('找不到 WAswitch 的连接文件。请打开 WAswitch，在 设置 › AI 接口 里下载并开启 MCP。');
    const c = new Client({ name: 'waswitch-mcp-bridge', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(t.url), {
      requestInit: { headers: { Authorization: `Bearer ${t.token}` } },
    });
    try {
      await c.connect(transport);
    } catch (e) {
      throw new Error(`连不上 WAswitch（${e.message}）。请确认 WAswitch 正在运行并已开启 MCP。`);
    }
    transport.onclose = () => { client = null; };
    client = c;
    return c;
  }

  async function withRetry(fn) {
    try {
      return await fn(await getClient());
    } catch (e) {
      // 只有会话失效（WAswitch 重启 → 404，换了 token → 401）时才重连重试一次。
      // 其他错误不重试，避免同一个操作执行两次。
      if (e.code !== 404 && e.code !== 401) throw e;
      client = null;
      return fn(await getClient());
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async (req) => withRetry((c) => c.listTools(req.params)));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await withRetry((c) => c.callTool(req.params));
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  if (!conf) log('暂时找不到连接文件，等 WAswitch 开启 MCP 后再调用即可。');
}

main().catch((e) => { log(e.stack || e.message); process.exit(1); });
