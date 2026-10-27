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
const { ChatGate } = require('./chats');
const { DraftLog } = require('./drafts');
const { TranslateLimit } = require('./helpers');

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
    // 二层的“10 分钟内允许”和读取记录，只在内存里
    this.gate = new ChatGate({ hooks, onChange: () => this.onChange() });
    // 起草回复的记录（谁给哪个对话起草了几个字，不含内容），只在内存里
    this.drafts = new DraftLog({ onChange: () => this.onChange() });
    // 辅助工具里翻译的限速（每个连接），只在内存里
    this.trLimit = new TranslateLimit();
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
      layer2: this.settings.layer2,
      preview: this.settings.preview,
      layer2Acknowledged: this.settings.layer2Acknowledged,
      drafts: this.settings.drafts,
      draftLog: this.drafts.log,
      helpers: this.settings.helpers,
      allows: this.gate.activeAllows(),
      readLog: this.gate.log,
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

  // 第二层开关。打开/关闭时通知已连接的客户端工具列表变了（tools/list_changed）
  setLayer2(on) {
    this.settings.layer2 = !!on;
    if (on) this.settings.layer2Acknowledged = true;
    cfg.saveSettings(this.dataDir, this.settings);
    if (!on) this.gate.clearAll();
    for (const s of this.sessions.values()) {
      // 「读对话」组：list_chats 和 read_messages 一起开关
      for (const tool of [s.chatTool, s.messageTool]) {
        if (!tool) continue;
        if (on) tool.enable(); else tool.disable();
      }
    }
    this.onChange();
  }

  // 起草回复开关，和第二层一样关着时工具不出现在列表里
  setDrafts(on) {
    this.settings.drafts = !!on;
    cfg.saveSettings(this.dataDir, this.settings);
    for (const s of this.sessions.values()) {
      if (!s.draftTool) continue;
      if (on) s.draftTool.enable(); else s.draftTool.disable();
    }
    this.onChange();
  }

  // 辅助工具开关（话术、翻译、客户时间），关着时三个工具都不出现在列表里
  setHelpers(on) {
    this.settings.helpers = !!on;
    cfg.saveSettings(this.dataDir, this.settings);
    for (const s of this.sessions.values()) {
      for (const t of s.helperTools || []) { if (on) t.enable(); else t.disable(); }
    }
    this.onChange();
  }

  setPreview(on) {
    const turnedOn = !this.settings.preview && !!on;
    this.settings.preview = !!on;
    cfg.saveSettings(this.dataDir, this.settings);
    if (turnedOn) this.gate.previewTurnedOn();
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
    const { registerChatTools } = require('./chats');
    const { registerMessageTools } = require('./messages');
    const { registerDraftTools } = require('./drafts');
    const { registerHelperTools } = require('./helpers');
    this.sdk = { McpServer, StreamableHTTPServerTransport, isInitializeRequest, registerAccountTools, registerChatTools, registerMessageTools, registerDraftTools, registerHelperTools };

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
    this.gate.clearSession(id);
    this.drafts.clearSession(id);
    this.trLimit.clearSession(id);
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

    const entry = { transport: null, server: null, chatTool: null, messageTool: null, draftTool: null, helperTools: [], connectedAt: Date.now(), lastSeen: Date.now(), calls: 0 };
    const server = new this.sdk.McpServer(
      { name: 'waswitch', version: this.version },
      { instructions: '管理 WAswitch 里的多个 WhatsApp 账号。账号管理随时可用；用户在设置里打开第二层后，可以用 list_chats 读对话列表、用 read_messages 读某个对话最近的消息（每次要用户确认）；打开“起草回复”后，可以用 draft_reply 把一条回复放进输入框，由用户自己按发送；打开“辅助工具”后，可以读话术（list_quick_replies）、用软件的翻译设置翻译文字（translate_text）、按号码查客户当地时间（get_customer_time）。不能发送消息，也不能群发。' },
    );
    this.sdk.registerAccountTools(server, this.hooks, { confirmTimeoutMs: CONFIRM_TIMEOUT_MS });
    entry.chatTool = this.sdk.registerChatTools(server, this.hooks, {
      gate: this.gate,
      previewAllowed: () => this.settings.preview,
      confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
      sessionInfo: (extra) => {
        const c = server.server.getClientVersion();
        return { session: extra.sessionId || 'unknown', client: c ? `${c.name}${c.version ? ` ${c.version}` : ''}` : '未知客户端' };
      },
    });
    entry.messageTool = this.sdk.registerMessageTools(server, this.hooks, {
      gate: this.gate,
      confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
      sessionInfo: (extra) => {
        const c = server.server.getClientVersion();
        return { session: extra.sessionId || 'unknown', client: c ? `${c.name}${c.version ? ` ${c.version}` : ''}` : '未知客户端' };
      },
    });
    // 第二层关着时工具不出现在列表里
    if (!this.settings.layer2) { entry.chatTool.disable(); entry.messageTool.disable(); }
    entry.draftTool = this.sdk.registerDraftTools(server, this.hooks, {
      log: this.drafts,
      sessionInfo: (extra) => {
        const c = server.server.getClientVersion();
        return { session: extra.sessionId || 'unknown', client: c ? `${c.name}${c.version ? ` ${c.version}` : ''}` : '未知客户端' };
      },
    });
    if (!this.settings.drafts) entry.draftTool.disable();
    entry.helperTools = this.sdk.registerHelperTools(server, this.hooks, { limit: this.trLimit });
    if (!this.settings.helpers) for (const t of entry.helperTools) t.disable();
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
