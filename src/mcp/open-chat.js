// 打开对话（open_chat）：在某个账号里打开和某个号码的对话，方便用户接着看、接着回（或者接着用 draft_reply 起草）。
//
// 属于“起草”这一组，和 draft_reply 共用 MCP 设置里的“起草回复和打开对话”开关，默认关；关着时 AI 看不到这个工具。
// 只打开，不发送、不标已读。用户正在打字时不直接开，在窗口顶部问用户（和 switch_account 一样）。
// 网页版靠跳到 WhatsApp 自己的 /send?phone= 网址打开（不注入脚本），轻量模式直接选中对话。具体做法在 src/chat-open.js。
// 设置页记录谁、什么时候、在哪个号打开了对话（号码只记后 4 位），只在内存里，和起草记录放在一起。
const { z } = require('zod');

const RATE_MS = 5 * 1000; // 同一个连接每 5 秒最多打开一次：网页版每次打开都会刷新页面

// 只留数字，单个 0 开头（本国拨号，不知道国家码）不认。和 src/chat-open.js 的 normalizePhone 一致
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!/^[+\d\s().-]+$/.test(s)) return '';
  let d = s.replace(/\D/g, '');
  if (s.startsWith('+')) d = d.replace(/^0+/, '');
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) return '';
  return d.length >= 7 && d.length <= 15 ? d : '';
}

// 号码打码：设置页只显示后 4 位
const maskPhone = (d) => `…${String(d).slice(-4)}`;

const REASONS = {
  not_loaded: '这个账号的页面还没加载好（可能是省内存模式还没打开它），请稍后再试，或请用户先点开这个账号。',
  problem: '这个账号的页面有问题（例如代理连不上），先在 WAswitch 里处理好再试。',
  no_chat: '页面已经跳到这个号码，但 40 秒内没看到对话打开。可能这个号码没有注册 WhatsApp（页面上会有提示），或者网络慢还在加载。请用户看一下 WAswitch 窗口。',
  gone: '这个账号在打开过程中被删除或重新加载了。',
};

// hooks（main.js 提供）：
//   listAccounts() -> 见 tools.js（含 mode: web | lite）
//   checkLogin(id) -> 'logged_in' | 'needs_qr' | 'unknown'
//   openChat({ accountId, phone, client }) -> { result: 'opened' | 'already' | 'pending' | 'busy' | 'gone' | 'failed', why?, reason?, unconfirmed?, found?, title? }
// options: { log: DraftLog（借用它的记录）, sessionInfo(extra) -> { session, client }, now }
function registerOpenChatTool(server, hooks, { log, sessionInfo, now = () => Date.now() }) {
  const last = new Map(); // session -> 上次打开时间
  return server.registerTool('open_chat', {
    title: '打开对话',
    description: [
      '在 WAswitch 的某个账号里打开和某个手机号的对话，并切到这个账号（不抢键盘焦点）。只打开，不发送消息、不标已读。',
      'phone 要带国家码，例如 +49 151 2345678 或 0049 151 2345678；本国拨号格式（单个 0 开头）认不出国家，会被拒绝。',
      '网页版账号会让页面跳到 WhatsApp 的打开对话网址，页面会刷新一次，最多等 40 秒对话出现；这个对话已经开着时不刷新（already: true）。',
      '轻量模式账号直接选中对话；本机还没有和这个号码的聊天记录时打开的是空对话（found: false）。',
      '用户正在打字、或者这个号的输入框里有还没发的字时，不直接开，在 WAswitch 窗口顶部问用户，返回 pending: true，开不开由用户决定，不要重复调用。',
      '打开后可以用 draft_reply 起草回复（chat 填同一个号码）。',
    ].join(''),
    inputSchema: {
      id: z.string().min(1).describe('账号 id，来自 list_accounts'),
      phone: z.string().trim().min(1).max(30).describe('对方手机号，带国家码，例如 +49 151 2345678'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, phone }, extra) => {
    const account = hooks.listAccounts().find((a) => a.id === id);
    if (!account) return fail(`没有 id 为 ${id} 的账号`);
    const digits = normalizePhone(phone);
    if (!digits) return fail('认不出这个号码。请给带国家码的完整手机号，例如 +49 151 2345678（不要用 0 开头的本国拨号格式）。');
    const login = await hooks.checkLogin(id);
    if (login !== 'logged_in') {
      return fail(login === 'needs_qr'
        ? '这个账号已退出登录，需要用户在 WAswitch 里重新扫码。'
        : '这个账号还没连上（未加载、加载中或认不出是否已登录），请稍后再试。');
    }
    const { session, client } = sessionInfo(extra);
    const t = now();
    const prev = last.get(session);
    if (prev && t - prev < RATE_MS) return fail(`每 5 秒最多打开一次对话，请 ${Math.ceil((RATE_MS - (t - prev)) / 1000)} 秒后再试。`);
    last.set(session, t);

    const r = await hooks.openChat({ accountId: id, phone: digits, client });
    log.record({ client, account: account.name, chat: maskPhone(digits), kind: 'open', result: r.result });
    if (r.result === 'gone') return fail(`没有 id 为 ${id} 的账号`);
    if (r.result === 'busy') return fail('WAswitch 窗口顶部已经有一个打开对话或起草回复的请求在等用户处理，请等用户处理完再试。');
    if (r.result === 'failed') return fail(REASONS[r.reason] || REASONS.no_chat);
    const out = { ok: true, account: { id: account.id, name: account.name }, phone: `+${digits}`, sent: false };
    if (r.result === 'pending') {
      return text({ ...out, opened: false, pending: true, why: r.why || '', next: '已在 WAswitch 窗口顶部询问用户是否打开这个对话，用户点“打开”才会打开。不要重复调用。' });
    }
    if (r.result === 'already') return text({ ...out, opened: true, already: true, next: '这个对话本来就开着，没有刷新页面。' });
    if (account.mode === 'lite') {
      return text({ ...out, opened: true, found: !!r.found, next: r.found ? '已在轻量模式里选中这个对话。' : '本机还没有和这个号码的聊天记录，已打开一个空对话。' });
    }
    return text({
      ...out,
      opened: true,
      confirmed: !r.unconfirmed,
      next: r.unconfirmed
        ? '页面已打开一个对话，但看不出它的号码（对方可能已存成联系人），没能确认就是这个号码。请用户看一下。'
        : '已打开这个号码的对话。',
    });
  });
}

const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
function fail(message) { return { content: [{ type: 'text', text: message }], isError: true }; }

module.exports = { registerOpenChatTool, normalizePhone, maskPhone, RATE_MS };
