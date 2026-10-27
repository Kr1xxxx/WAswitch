// 辅助工具：list_quick_replies（读话术库）、translate_text（用软件的翻译设置翻一段文字）、get_customer_time（按号码查客户当地时间）。
//
// 默认关，要在 MCP 接口设置里单独打开；关着时 AI 看不到这三个工具。都不弹窗确认：
//   - 话术是你自己写的常用回复，不是聊天内容
//   - 翻译只翻 AI 给的文字，不读聊天、不带对话上下文；用的是你在 设置 › 翻译 里配的服务商（花你的额度），所以限了速
//   - 客户时间只按号码算，不读页面，号码不记录
// 都不往 WhatsApp 页面注入脚本，也不发送任何消息。
const { z } = require('zod');
const { zoneOfNumber, fromText } = require('../customer-time');

const MAX_TEXT = 4000; // 和 translate.js 的 MAX_INPUT 一样
const TR_PER_MIN = 20; // 每个连接每分钟最多翻译几次
const REPLY_LIMIT = 50;
const REPLY_MAX = 200;

// 软件里的语言名（translate.js 的 LANGS）和 AI 常用的写法
const LANG_ALIASES = {
  英语: ['en', 'en-us', 'en-gb', 'english'],
  西班牙语: ['es', 'spanish', 'español', 'espanol'],
  葡萄牙语: ['pt', 'pt-br', 'pt-pt', 'portuguese', 'português', 'portugues'],
  法语: ['fr', 'french', 'français', 'francais'],
  德语: ['de', 'german', 'deutsch'],
  意大利语: ['it', 'italian', 'italiano'],
  俄语: ['ru', 'russian'],
  阿拉伯语: ['ar', 'arabic'],
  土耳其语: ['tr', 'turkish'],
  印地语: ['hi', 'hindi'],
  印尼语: ['id', 'indonesian'],
  马来语: ['ms', 'malay'],
  泰语: ['th', 'thai'],
  越南语: ['vi', 'vietnamese'],
  菲律宾语: ['fil', 'tl', 'filipino', 'tagalog'],
  日语: ['ja', 'japanese'],
  韩语: ['ko', 'korean'],
  中文: ['zh', 'zh-cn', 'zh-hans', 'chinese', '汉语', '简体中文'],
};
const LANG_NAMES = Object.keys(LANG_ALIASES);
function normLang(v) {
  const s = String(v || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s) return '';
  for (const [name, list] of Object.entries(LANG_ALIASES)) if (s === name || list.includes(s)) return name;
  return null;
}

// 没指定翻译模式时用的：忠实翻译，和“标准”模式一样
const PLAIN_MODE = { name: '标准', direction: 'out', prompt: '把用户的文字忠实地翻译成{目标语言}。保留数字、链接、表情和换行，不增不减内容。', temperature: 0.3 };

// 号码 → 数字。+ 或 00 开头按国际号码；纯数字（WhatsApp 里常见的 4915112345678）也当带国家码；单个 0 开头是本地写法，认不出国家
function phoneDigits(raw) {
  const s = String(raw || '').normalize('NFKC').trim();
  const intl = fromText(s);
  if (intl) return intl;
  const d = s.replace(/[\s\-().]/g, '');
  return /^[1-9]\d{6,14}$/.test(d) ? d : '';
}

const pad = (n) => String(n).padStart(2, '0');
// 某个时区现在的日期时间、星期、和 UTC 差几小时
function localNow(tz, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute);
  const diff = Math.round((asUtc - Math.floor(now.getTime() / 60000) * 60000) / 60000); // 分钟
  const sign = diff < 0 ? '-' : '+';
  const a = Math.abs(diff);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${pad(hour)}:${pad(minute)}`,
    weekday: parts.weekday,
    hour,
    utcOffset: `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`,
  };
}
// 现在适不适合联系：工作时间、早晚、夜里；周六周日算周末
function daypart(hour) {
  if (hour >= 22 || hour < 7) return 'night';
  if (hour < 9) return 'morning';
  if (hour < 18) return 'working_hours';
  return 'evening';
}
const DAYPART_NOTE = {
  night: '客户那边现在是夜里，最好等对方早上再联系。',
  morning: '客户那边是早上，还没到工作时间。',
  working_hours: '客户那边是工作时间。',
  evening: '客户那边已经下班，是晚上。',
};

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

// 每个连接：同时只翻一段，每分钟最多 TR_PER_MIN 次。只在内存里
class TranslateLimit {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.sessions = new Map(); // session -> { running, times: [] }
  }

  // 返回 null 表示可以翻，否则返回给 AI 的说明
  take(session) {
    const s = this.sessions.get(session) || { running: false, times: [] };
    this.sessions.set(session, s);
    if (s.running) return '上一段还在翻译，请等它返回后再调用。';
    const t = this.now();
    s.times = s.times.filter((x) => t - x < 60 * 1000);
    if (s.times.length >= TR_PER_MIN) return `每分钟最多翻译 ${TR_PER_MIN} 次（用的是用户自己的翻译额度），请稍后再试。`;
    s.times.push(t);
    s.running = true;
    return null;
  }

  done(session) { const s = this.sessions.get(session); if (s) s.running = false; }

  clearSession(session) { this.sessions.delete(session); }
}

// hooks（main.js 提供）：
//   listQuickReplies() -> [{ id, title, text, updatedAt }]
//   translateModes() -> [{ id, name, direction, prompt, temperature }]   设置 › 翻译 里的翻译模式
//   translate({ text, mode, target, source }) -> { text, provider, fallback, ms, warn[] } | { error, kind }
//       和面板里点“翻译”走同一条队列，用同样的服务商、备用服务商、角色设定和网络设置
// options: { limit: TranslateLimit, sessionOf(extra) -> string, now() }
// 返回三个工具，开关由 server.js 控制
function registerHelperTools(server, hooks, { limit, sessionOf = (extra) => extra.sessionId || 'unknown', now = () => new Date() }) {
  const replies = server.registerTool('list_quick_replies', {
    title: '列出话术',
    description: `列出用户在 WAswitch 话术库里存的常用回复（标题和内容），按最近修改排在前面。可以用 query 搜标题和内容。默认最多返回 ${REPLY_LIMIT} 条。这里只是读，用的时候可以配合 draft_reply 放进输入框，由用户自己发送。`,
    inputSchema: {
      query: z.string().trim().max(100).optional().describe('只返回标题或内容里包含这段文字的话术（不分大小写）'),
      limit: z.number().int().min(1).max(REPLY_MAX).optional().describe(`最多返回几条，默认 ${REPLY_LIMIT}，最多 ${REPLY_MAX}`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, limit: n }) => {
    const q = String(query || '').toLowerCase();
    const all = hooks.listQuickReplies()
      .filter((r) => r && r.text && (!q || `${r.title || ''}\n${r.text}`.toLowerCase().includes(q)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const list = all.slice(0, n || REPLY_LIMIT).map((r) => ({ id: r.id, title: r.title || '', text: r.text }));
    return json({ total: all.length, returned: list.length, replies: list, ...(all.length ? {} : { note: q ? '没有找到包含这段文字的话术。' : '话术库是空的。' }) });
  });

  const translate = server.registerTool('translate_text', {
    title: '翻译文字',
    description: [
      '用 WAswitch 里设置好的翻译服务（设置 › 翻译 的默认服务商、备用服务商和角色设定）翻译一段文字，返回译文。',
      '只翻你给的文字，不读聊天、不带对话上下文，不会发送。',
      `target 是目标语言，可以写 ${LANG_NAMES.join('、')}，也可以写 en、de、fr、es 这类代码或英文名。`,
      'mode 可选，是用户在设置里建的翻译模式名称（例如“商务正式”），不填就忠实直译。',
      `用的是用户自己的翻译额度：每个连接同时只翻一段，每分钟最多 ${TR_PER_MIN} 次，一次最多 ${MAX_TEXT} 字。`,
    ].join(''),
    inputSchema: {
      text: z.string().min(1).max(MAX_TEXT).describe(`要翻译的文字，最多 ${MAX_TEXT} 字`),
      target: z.string().trim().min(1).max(20).describe('目标语言，例如 英语、德语、en、de、French'),
      source: z.string().trim().max(20).optional().describe('原文语言，可不填（自动认）'),
      mode: z.string().trim().max(40).optional().describe('翻译模式名称，来自 设置 › 翻译，不填就忠实直译'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ text, target, source, mode }, extra) => {
    if (!text.trim()) return fail('要翻译的文字是空的。');
    const to = normLang(target);
    if (!to) return fail(`不认识目标语言「${target}」。可以用：${LANG_NAMES.join('、')}`);
    const from = source ? normLang(source) : '';
    if (from === null) return fail(`不认识原文语言「${source}」。可以不填，让服务商自己认。`);
    let m = PLAIN_MODE;
    if (mode) {
      const modes = hooks.translateModes() || [];
      m = modes.find((x) => x && x.name === mode);
      if (!m) return fail(`没有叫「${mode}」的翻译模式。可以用：${modes.map((x) => x.name).join('、') || '（没有）'}，或者不填 mode。`);
    }
    const session = sessionOf(extra);
    const limited = limit.take(session);
    if (limited) return fail(limited);
    let r;
    try {
      r = await hooks.translate({ text, mode: m, target: to, source: from || '' });
    } finally {
      limit.done(session);
    }
    if (!r || r.error) {
      const why = (r && r.error) || '翻译失败';
      const hint = r && (r.kind === 'config' || r.kind === 'auth')
        ? '请用户在 WAswitch 的 设置 › 翻译 里设置服务商和密钥。'
        : r && r.kind === 'busy' ? '软件正在翻译别的内容，请稍后再试。' : '';
      return fail(`翻译失败：${why}${hint ? `。${hint}` : ''}`);
    }
    return json({
      text: r.text,
      target: to,
      mode: m.name,
      provider: r.provider,
      ...(r.fallback ? { fallback: true } : {}),
      ...(r.warn && r.warn.length ? { warning: `译文里出现了原文没有的联系方式或链接：${r.warn.join('、')}，请核对。` } : {}),
    });
  });

  const time = server.registerTool('get_customer_time', {
    title: '客户当地时间',
    description: [
      '按客户的手机号（要带国家码，例如 +49 151 12345678、0049…，或 WhatsApp 里的 4915112345678）算出客户所在的时区和那边现在几点、星期几、是不是工作时间。',
      '只按号码算，不读聊天，号码不记录。一个国家有多个时区又分不出来时 approx 为 true（按主时区估计）。',
      '0 开头的本地写法（例如 0151…）认不出国家，要换成带国家码的写法。',
    ].join(''),
    inputSchema: {
      phone: z.string().trim().min(5).max(40).describe('客户手机号，带国家码'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ phone }) => {
    const digits = phoneDigits(phone);
    if (!digits) return fail('认不出这个号码。要带国家码，例如 +49 151 12345678 或 4915112345678；0 开头的本地写法认不出国家。');
    const z0 = zoneOfNumber(digits);
    if (!z0) return fail('认不出这个号码的国家码，算不出时区。');
    const t = localNow(z0.tz, now());
    const part = daypart(t.hour);
    const weekend = t.weekday === 'Saturday' || t.weekday === 'Sunday';
    return json({
      timezone: z0.tz,
      place: z0.place,
      approx: z0.approx,
      local_date: t.date,
      local_time: t.time,
      weekday: t.weekday,
      utc_offset: t.utcOffset,
      daypart: part,
      weekend,
      note: `${z0.approx ? '这个国家有多个时区，按主时区估计。' : ''}${weekend ? '客户那边是周末。' : ''}${DAYPART_NOTE[part]}`,
    });
  });

  return [replies, translate, time];
}

module.exports = { registerHelperTools, TranslateLimit, normLang, phoneDigits, localNow, daypart, LANG_NAMES, PLAIN_MODE, TR_PER_MIN, MAX_TEXT };
