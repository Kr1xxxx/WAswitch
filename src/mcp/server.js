// 本机 MCP 服务器（Streamable HTTP），跑在 Electron 主进程里。
//
// 安全措施：
//   - 只监听 127.0.0.1，并且只接受来自本机回环地址的连接
//   - Host 头只接受 127.0.0.1 / localhost，防止 DNS 重绑定
//   - 带 Origin 头的请求一律拒绝：浏览器网页发起的请求都会带 Origin，MCP 客户端不会
//   - 每个请求都要带 Authorization: Bearer <token>
//   - 默认关闭；关闭时删除 token 文件，重新开启时换新 token
//
// 只在开启时才加载 MCP 相关代码，关闭时不占内存。
const http = require('http');
const crypto = require('crypto');
const cfg = require('./config');

const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const MAX_SESSIONS = 8;
const SESSION_IDLE_MS = 30 * 60 * 1000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求太大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function reply(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

class McpController {
  // hooks：见 tools.js；另外 onChange() 在状态变化时调用（刷新设置窗口）
  constructor({ dataDir, version, hooks, onChange }) {
    this.dataDir = dataDir;
    this.version = version;
    this.hooks = hooks;
    this.onChange = onChange || (() => {});
    this.settings = cfg.loadSettings(dataDir);
    this.token = null;
    this.httpServer = null;
    this.sessions = new Map(); // sessionId -> { transport, server, connectedAt, lastSeen, calls }
    this.error = '';
    this.sweeper = null;
  }

  status() {
    return {
      enabled: this.settings.enabled,
      running: !!this.httpServer,
      port: this.settings.port,
      url: `http://127.0.0.1:${this.settings.port}/mcp`,
      token: this.token,
      tokenFile: cfg.tokenPath(this.dataDir),
      error: this.error,
      clients: [...this.sessions.values()].map((s) => {
        const c = s.server.server.getClientVersion();
        return {
          name: c ? `${c.name}${c.version ? ` ${c.version}` : ''}` : '未知客户端',
        connectedAt: s.connectedAt,
        lastSeen: s.lastSeen,
          calls: s.calls,
        };
      }),
    };
  }

  // 软件启动时调用：上次开着就继续开，沿用 token 文件里的 token（HTTP 客户端的配置不用改）
  async init() {
    if (!this.settings.enabled) { cfg.removeTokenFile(this.dataDir); return; }
    const saved = cfg.readTokenFile(this.dataDir);
    this.token = saved && saved.port === this.settings.port ? saved.token : cfg.newToken();
    await this.listen();
  }

  async setEnabled(enabled) {
    this.settings.enabled = !!enabled;
    cfg.saveSettings(this.dataDir, this.settings);
    if (enabled) {
      this.token = cfg.newToken();
      await this.listen();
    } else {
      await this.close();
      this.token = null;
      cfg.removeTokenFile(this.dataDir);
    }
    this.onChange();
  }

  // 断开所有客户端并换新 token，旧配置立即失效
  async regenerateToken() {
    if (!this.settings.enabled) return;
    await this.close();
    this.token = cfg.newToken();
    await this.listen();
    this.onChange();
  }

  async listen() {
    this.error = '';
    const { port } = this.settings;
    // 依赖只在开启时加载
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
    const { registerAccountTools } = require('./tools');
    this.sdk = { McpServer, StreamableHTTPServerTransport, isInitializeRequest, registerAccountTools };

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => reply(res, e.status || 500, e.status ? e.message : '内部错误'));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    } catch (e) {
      this.error = e.code === 'EADDRINUSE' ? `端口 ${port} 被其他程序占用` : e.message;
      this.onChange();
      return;
    }
    this.httpServer = server;
    cfg.writeTokenFile(this.dataDir, { port, token: this.token });
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.sweeper.unref?.();
    this.onChange();
  }

  async close() {
    clearInterval(this.sweeper);
    this.sweeper = null;
    for (const id of [...this.sessions.keys()]) await this.dropSession(id);
    if (this.httpServer) {
      const s = this.httpServer;
      this.httpServer = null;
      s.closeAllConnections?.();
      await new Promise((resolve) => s.close(() => resolve()));
    }
  }

  async dropSession(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try { await s.transport.close(); } catch { /* 已经断开 */ }
    try { await s.server.close(); } catch { /* 已经断开 */ }
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastSeen > SESSION_IDLE_MS) this.dropSession(id);
    this.onChange();
  }

  // 返回 null 表示通过，否则返回 [状态码, 原因]
  check(req) {
    const addr = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return [403, '只接受本机连接'];
    const host = String(req.headers.host || '').toLowerCase();
    const port = this.settings.port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return [403, 'Host 不允许'];
    if (req.headers.origin !== undefined) return [403, '不接受浏览器网页发起的请求'];
    const auth = String(req.headers.authorization || '');
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m || !this.token || !safeEqual(m[1].trim(), this.token)) return [401, 'token 无效'];
    const path = (req.url || '').split('?')[0];
    if (path !== '/mcp') return [404, '地址应为 /mcp'];
    return null;
  }

  async handle(req, res) {
    const bad = this.check(req);
    if (bad) return reply(res, bad[0], bad[1]);

    const sid = req.headers['mcp-session-id'];
    const body = req.method === 'POST' ? await readBody(req) : undefined;

    if (sid) {
      const s = this.sessions.get(String(sid));
      if (!s) return reply(res, 404, '会话已失效，请重新连接');
      s.lastSeen = Date.now();
      if (body && [].concat(body).some((m) => m && m.method === 'tools/call')) s.calls += 1;
      await s.transport.handleRequest(req, res, body);
      if (req.method === 'DELETE') this.dropSession(String(sid));
      this.onChange();
      return;
    }

    if (req.method !== 'POST' || !this.sdk.isInitializeRequest(body)) return reply(res, 400, '缺少 mcp-session-id');

    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      await this.dropSession(oldest[0]);
    }

    const entry = { transport: null, server: null, connectedAt: Date.now(), lastSeen: Date.now(), calls: 0 };
    const server = new this.sdk.McpServer(
      { name: 'waswitch', version: this.version },
      { instructions: '管理 WAswitch 里的多个 WhatsApp 账号。当前只开放账号管理（一层），不能读取或发送消息。' },
    );
    this.sdk.registerAccountTools(server, this.hooks, { confirmTimeoutMs: CONFIRM_TIMEOUT_MS });
    const transport = new this.sdk.StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, entry);
        this.onChange();
      },
    });
    transport.onclose = () => {
      if (transport.sessionId && this.sessions.get(transport.sessionId) === entry) {
        this.sessions.delete(transport.sessionId);
        this.onChange();
      }
    };
    entry.transport = transport;
    entry.server = server;
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

module.exports = { McpController, CONFIRM_TIMEOUT_MS };
