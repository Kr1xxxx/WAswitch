// 起草回复（draft_reply）：AI 写好一条回复，放进指定账号、指定对话的输入框。
//
// 只放进输入框，永远不发送：不按回车、不点发送、不模拟按键，发不发由人决定。
// 一次只能起草一条，没有批量参数：上一条还在等用户处理时，新的直接拒绝。
// 默认关，要在 MCP 接口设置里单独打开；关着时 AI 看不到这个工具。
// 草稿内容不落盘；设置页只记录谁、什么时候、给哪个号的哪个对话起草了几个字，号码只记后 4 位（也只在内存里）。
// 放进输入框的具体做法在主进程的 src/draft-place.js（不往 WhatsApp 页面注入脚本），这里只通过 hooks.placeDraft 调用。
const { z } = require('zod');
const { maskPhone } = require('./open-chat');

const MAX_TEXT = 4000;
const RATE_MS = 3 * 1000; // 同一个连接每 3 秒最多起草一次
const LOG_MAX = 20;

// 设置页记录里的对话：名字照记，像手机号的一段（至少 6 位数字，和 draft-place.js 的 looksLikePhone 一样）只留后 4 位
function maskChat(chat) {
  return String(chat || '').replace(/[+(]?\d[\d\s().-]*\d/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 6 ? maskPhone(d) : m;
  });
}

// 去掉控制字符（换行、制表符保留）和改变文字方向的隐藏字符，统一换行符。AI 给的文字只当普通文字
function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '')
    .slice(0, MAX_TEXT);
}

class DraftLog {
  constructor({ now = Date.now, onChange = () => {} } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.last = new Map(); // session -> 上次起草时间
    this.log = []; // { at, client, account, chat, chars, result }
  }

  // 返回 null 表示可以起草，否则返回给 AI 的说明
  limit(session) {
    const last = this.last.get(session);
    const t = this.now();
    if (last && t - last < RATE_MS) return `每 3 秒最多起草一条，请 ${Math.ceil((RATE_MS - (t - last)) / 1000)} 秒后再试。`;
    this.last.set(session, t);
    return null;
  }

  clearSession(session) { this.last.delete(session); }

  record(entry) {
    this.log.unshift({ at: this.now(), ...entry });
    this.log.length = Math.min(this.log.length, LOG_MAX);
    this.onChange();
  }
}

// hooks（main.js 提供）：
//   listAccounts() -> 见 tools.js（含 mode: web | lite）
//   checkLogin(id) -> 'logged_in' | 'needs_qr' | 'unknown'
//   placeDraft({ accountId, chat, text, client }) -> { result: 'placed' | 'pending' | 'busy' | 'gone', why?, unconfirmed? }
// options: { log: DraftLog, sessionInfo(extra) -> { session, client } }
function registerDraftTools(server, hooks, { log, sessionInfo }) {
  return server.registerTool('draft_reply', {
    title: '起草回复',
    description: [
      '把一条写好的回复放进某个账号、某个对话的输入框，由用户检查后自己按发送。',
      '这个工具不会发送消息：不按回车、不点发送。一次只能起草一条，不能群发；上一条还在等用户处理时会被拒绝。',
      'chat 要和 WhatsApp 里对话顶部显示的名称一致（可以用 list_chats 返回的 name），也可以填对方手机号。',
      '只有这个对话正开着、用户没在打字、输入框是空的时候才直接放进去（placed: true）；',
      '否则在 WAswitch 窗口顶部给用户看草稿，用户点“放进输入框”才放（pending: true），不要重复调用。',
      '网页版账号要用户自己在 WhatsApp 里打开这个对话；轻量模式账号用户点按钮时会自动打开。',
    ].join(''),
    inputSchema: {
      id: z.string().min(1).describe('账号 id，来自 list_accounts'),
      chat: z.string().trim().min(1).max(100).describe('对话名称（对话顶部显示的名字）或对方手机号'),
      text: z.string().min(1).max(MAX_TEXT).describe(`回复内容，最多 ${MAX_TEXT} 字。只放进输入框，不会发送`),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ id, chat, text }, extra) => {
    const account = hooks.listAccounts().find((a) => a.id === id);
    if (!account) return fail(`没有 id 为 ${id} 的账号`);
    const body = cleanText(text);
    if (!body.trim()) return fail('回复内容是空的。');
    const login = await hooks.checkLogin(id);
    if (login !== 'logged_in') {
      return fail(login === 'needs_qr'
        ? '这个账号已退出登录，需要用户在 WAswitch 里重新扫码。'
        : '这个账号还没连上（未加载、加载中或认不出是否已登录），请稍后再试。');
    }
    const { session, client } = sessionInfo(extra);
    const limited = log.limit(session);
    if (limited) return fail(limited);

    const r = await hooks.placeDraft({ accountId: id, chat, text: body, client });
    log.record({ client, account: account.name, chat: maskChat(chat), chars: body.length, result: r.result });
    if (r.result === 'gone') return fail(`没有 id 为 ${id} 的账号`);
    if (r.result === 'busy') return fail('上一条草稿还在 WAswitch 窗口顶部等用户处理，一次只能起草一条。请等用户处理完再试。');
    const out = { ok: true, account: { id: account.id, name: account.name }, chat, sent: false };
    if (r.result === 'placed') {
      return text_({
        ...out,
        placed: true,
        next: r.unconfirmed
          ? '已把草稿粘贴进输入框，但没能确认它已出现（剪贴板里也留着这段）。没有发送。请用户看一下输入框，检查后自己按发送。'
          : '草稿已在输入框里，没有发送。请用户检查后自己按发送。',
      });
    }
    return text_({ ...out, placed: false, pending: true, why: r.why || '', next: '已在 WAswitch 窗口顶部给用户看草稿，用户点“放进输入框”后才会放进去，发送也由用户自己按。不要重复调用。' });
  });
}

const text_ = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
function fail(message) { return { content: [{ type: 'text', text: message }], isError: true }; }

module.exports = { registerDraftTools, DraftLog, cleanText, maskChat, MAX_TEXT, RATE_MS };
