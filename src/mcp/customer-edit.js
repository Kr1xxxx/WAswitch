// 修改客户资料（update_customer）：AI 改客户名单里的名字、标签、备注、下次跟进时间，或者新建客户。
//
// 不弹窗确认（shen 2026-10-27 定的），换成：每次改动都记进「AI 操作记录」，在 MCP 接口设置里一键撤销。
// 默认关，要在 MCP 接口设置里单独打开；关着时 AI 看不到这个工具。不能删除客户，不碰 WhatsApp 页面。
//
// 撤销按字段来：只把“现在还是 AI 改成的那个值”的字段改回去；之后被人（或别的 AI 操作）改过的字段不动，
// 免得撤销把用户后来手动改的内容冲掉。撤销新建 = 删除这个客户，但它被改过就不删，请用户自己去客户名单删。
//
// 记录存在本机 <userData>/mcp-ai-log.json（和 customers.json 一样是明文，不上传），最多 100 条。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const { writeJsonAtomic } = require('../atomic');

const LOG_FILE = 'mcp-ai-log.json';
const LOG_MAX = 100;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20; // 同一个连接每分钟最多改 20 次，防止 AI 跑飞了一下子改一大片
const FIELDS = ['name', 'phone', 'tags', 'note', 'followUpAt'];
const LABEL = { name: '名字', phone: '电话', tags: '标签', note: '备注', followUpAt: '下次跟进' };
const MAX_FOLLOW_UP_MS = 5 * 366 * 24 * 3600 * 1000; // 跟进时间最多设到 5 年后

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const phoneDigits = (p) => String(p || '').replace(/\D/g, '');
const EMPTY = { name: '', phone: '', tags: [], note: '', followUpAt: 0, reminded: false };
const pick = (c) => ({ name: c.name || '', phone: c.phone || '', tags: [...(c.tags || [])], note: c.note || '', followUpAt: c.followUpAt || 0, reminded: c.reminded === true });

// 「AI 操作记录」：增加、读取、撤销。hooks 见 registerCustomerEditTools 上面的说明
class AiLog {
  constructor({ dir, hooks, now = Date.now, onChange = () => {} }) {
    this.file = path.join(dir, LOG_FILE);
    this.hooks = hooks;
    this.now = now;
    this.onChange = onChange;
    this.rate = new Map(); // session -> [调用时间]
    this.entries = this.read();
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(raw) ? raw.filter((e) => e && typeof e.id === 'string' && typeof e.customerId === 'string').slice(0, LOG_MAX) : [];
    } catch {
      return [];
    }
  }

  save() {
    try { writeJsonAtomic(this.file, this.entries, 1); } catch (e) { console.warn('AI 操作记录保存失败', e.message); }
  }

  // 返回 null 表示可以改，否则返回给 AI 的说明
  limit(session) {
    const t = this.now();
    const recent = (this.rate.get(session) || []).filter((x) => t - x < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) {
      this.rate.set(session, recent);
      return `每分钟最多改 ${RATE_MAX} 次客户资料，请 ${Math.ceil((RATE_WINDOW_MS - (t - recent[0])) / 1000)} 秒后再试。`;
    }
    recent.push(t);
    this.rate.set(session, recent);
    return null;
  }

  clearSession(session) { this.rate.delete(session); }

  add({ op, client, accountName, customerId, before, after, changed }) {
    const entry = { id: crypto.randomUUID(), at: this.now(), op, client, account: accountName, customerId, before, after, changed, undone: false, undoNote: '' };
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, LOG_MAX);
    this.save();
    this.onChange();
    return entry;
  }

  // 给设置页看的：每条改了什么（之前 → 之后）
  view() {
    return this.entries.map((e) => ({
      id: e.id,
      at: e.at,
      op: e.op,
      client: e.client,
      account: e.account,
      customer: (e.after && (e.after.name || e.after.phone)) || (e.before && (e.before.name || e.before.phone)) || '一位客户',
      changes: (e.changed || []).map((f) => ({ field: f, label: LABEL[f] || f, before: e.before ? e.before[f] : null, after: e.after[f] })),
      undone: e.undone,
      undoNote: e.undoNote || '',
    }));
  }

  // 撤销一条。返回 { ok, message }（message 给设置页显示）
  undo(id) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return { ok: false, message: '找不到这条记录' };
    if (e.undone) return { ok: false, message: '这条已经撤销过了' };
    const cur = this.hooks.customerGet(e.customerId);
    const done = (message, ok = true) => {
      if (ok) { e.undone = true; e.undoNote = message; this.save(); this.onChange(); }
      return { ok, message };
    };
    if (!cur) return done('这个客户已经不在客户名单里了（被删除，或者它的账号停用了），没有可撤销的', false);

    if (e.op === 'create') {
      const changedSince = FIELDS.filter((f) => !same(cur[f], e.after[f]));
      if (changedSince.length) {
        return done(`新建之后「${changedSince.map((f) => LABEL[f]).join('、')}」又被改过，没有删除。确实不要的话，请在客户名单里删除`, false);
      }
      this.hooks.customerRemove(e.customerId);
      return done('已撤销：删除了这个新建的客户');
    }

    const restore = {};
    const kept = [];
    for (const f of e.changed) {
      if (same(cur[f], e.after[f])) restore[f] = e.before[f];
      else kept.push(f);
    }
    if (!Object.keys(restore).length) return done(`「${kept.map((f) => LABEL[f]).join('、')}」之后又被改过，没有改回`, false);
    // 改回跟进时间时，“提醒过没有”也一起还原，免得已经过去的跟进时间又弹一次提醒
    const reminded = 'followUpAt' in restore ? e.before.reminded === true : undefined;
    if (!this.hooks.customerRestore(e.customerId, restore, reminded)) return done('没能改回（客户资料保存失败）', false);
    return done(kept.length
      ? `已撤销「${Object.keys(restore).map((f) => LABEL[f]).join('、')}」；「${kept.map((f) => LABEL[f]).join('、')}」之后又被改过，没动`
      : '已撤销');
  }
}

// 跟进时间：ISO 8601，例如 2026-11-03T10:00:00+01:00；不带时区的按这台电脑的时区。空字符串 = 清除
function parseFollowUp(v, now) {
  if (v === '') return { at: 0 };
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(s)) return { error: 'follow_up_at 要用 ISO 8601 格式，例如 2026-11-03T10:00:00+01:00；清除跟进时间传空字符串' };
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T09:00` : s.replace(' ', 'T'));
  if (!Number.isFinite(at)) return { error: 'follow_up_at 不是有效的时间' };
  if (at > now + MAX_FOLLOW_UP_MS) return { error: '跟进时间不能超过 5 年后' };
  return { at };
}

const cleanTag = (t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 20);

// hooks（main.js 提供，只能看到没停用的账号名下的客户）：
//   listAccounts() -> 见 tools.js
//   customerGet(id) -> { id, accountId, name, phone, tags, note, followUpAt, reminded } | null
//   customerFind(accountId, phone) -> 同上 | null   （同一账号下，电话只比数字）
//   customerSave(data) -> 同上 | null   data 带 id 是修改（只改给出的字段），不带是新建
//   customerRestore(id, fields, reminded?) -> boolean   撤销时用
//   customerRemove(id) -> boolean   撤销新建时用
// options: { log: AiLog, sessionInfo(extra) -> { session, client } }
function registerCustomerEditTools(server, hooks, { log, sessionInfo }) {
  const tagList = z.array(z.string().trim().min(1).max(20)).max(10);
  return server.registerTool('update_customer', {
    title: '修改客户资料',
    description: [
      '修改 WAswitch 客户名单里一个客户的名字、标签、备注、下次跟进时间，或者新建一个客户。',
      '找客户：给 customer_id；或者给 account_id + phone，同一账号下电话相同（只比数字）的客户会被修改，没有就新建。',
      '新建客户要给 account_id，以及 name 或 phone。',
      '标签：tags 整体替换；add_tags / remove_tags 只加或只减，不能和 tags 一起用。最多 10 个，每个最多 20 字。',
      '备注：note 整体替换；append_note 在原备注后面另起一行追加，两个不能一起用。最多 500 字。',
      'follow_up_at：下次跟进时间，ISO 8601（例如 2026-11-03T10:00:00+01:00，不带时区按用户电脑的时区；只写日期按当天 9 点），到时间 WAswitch 会提醒用户；传空字符串清除。',
      '不会弹窗问用户：每次修改都记进 MCP 接口设置里的「AI 操作记录」，用户可以一键撤销。不能删除客户。',
      '返回里只有客户 id 和改了哪些字段，不返回客户的其他资料。',
    ].join(''),
    inputSchema: {
      customer_id: z.string().min(1).max(80).optional().describe('客户 id（search_customers 或之前 update_customer 返回的 id）'),
      account_id: z.string().min(1).optional().describe('账号 id，来自 list_accounts。新建客户、或按电话找客户时要给'),
      phone: z.string().trim().min(1).max(40).optional().describe('客户电话，带国家码，例如 +49 151 2345678。没给 customer_id 时用来找客户；新建时存进去'),
      name: z.string().trim().min(1).max(60).optional().describe('客户名字'),
      tags: tagList.optional().describe('整体替换标签'),
      add_tags: tagList.optional().describe('加上这些标签'),
      remove_tags: tagList.optional().describe('去掉这些标签'),
      note: z.string().max(500).optional().describe('整体替换备注（空字符串 = 清空）'),
      append_note: z.string().trim().min(1).max(500).optional().describe('在原备注后面另起一行追加'),
      follow_up_at: z.string().max(40).optional().describe('下次跟进时间，ISO 8601；空字符串清除'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (a, extra) => {
    if (a.tags && (a.add_tags || a.remove_tags)) return fail('tags 是整体替换，不能和 add_tags / remove_tags 一起用。');
    if (a.note !== undefined && a.append_note) return fail('note 是整体替换，不能和 append_note 一起用。');
    let followUpAt;
    if (a.follow_up_at !== undefined) {
      const r = parseFollowUp(a.follow_up_at, log.now());
      if (r.error) return fail(r.error);
      followUpAt = r.at;
    }

    // 找客户
    let cur = null;
    if (a.customer_id) {
      cur = hooks.customerGet(a.customer_id);
      if (!cur) return fail(`客户名单里没有 id 为 ${a.customer_id} 的客户`);
      if (a.account_id && a.account_id !== cur.accountId) return fail('这个客户不在 account_id 指定的账号下。');
    } else if (a.account_id && a.phone) {
      if (!phoneDigits(a.phone)) return fail('phone 里没有数字。');
      cur = hooks.customerFind(a.account_id, a.phone);
    }
    const accountId = cur ? cur.accountId : a.account_id;
    const account = hooks.listAccounts().find((x) => x.id === accountId);
    if (!cur && !accountId) return fail('要给 customer_id；或者给 account_id + phone；新建客户要给 account_id。');
    if (accountId && !account) return fail(`没有 id 为 ${accountId} 的账号`);

    // 算出改完的样子
    const before = cur ? pick(cur) : null;
    const next = pick(cur || EMPTY);
    if (a.name !== undefined) next.name = a.name;
    if (!cur && a.phone !== undefined) next.phone = a.phone;
    // 用 customer_id 找到的客户，给了 phone 就是改电话；按电话找到的，电话本来就一样，不改写格式
    if (cur && a.customer_id && a.phone !== undefined) next.phone = a.phone;
    if (a.tags) next.tags = a.tags.map(cleanTag);
    if (a.add_tags) next.tags = [...next.tags, ...a.add_tags.map(cleanTag)];
    if (a.remove_tags) {
      const drop = new Set(a.remove_tags.map((t) => cleanTag(t).toLowerCase()));
      next.tags = next.tags.filter((t) => !drop.has(t.toLowerCase()));
    }
    // 去重：大小写不同算同一个标签，留先有的那个
    const seen = new Set();
    next.tags = next.tags.filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
    if (next.tags.length > 10) return fail('标签最多 10 个。');
    if (a.note !== undefined) next.note = a.note.replace(/\r\n?/g, '\n').trim();
    if (a.append_note) next.note = next.note ? `${next.note}\n${a.append_note}` : a.append_note;
    if (next.note.length > 500) return fail(`备注最多 500 字，追加后会有 ${next.note.length} 字。`);
    if (followUpAt !== undefined) next.followUpAt = followUpAt;
    if (!cur && !next.name && !next.phone) return fail('新建客户至少要给 name 或 phone。');

    const changed = FIELDS.filter((f) => !same((before || EMPTY)[f], next[f]));
    if (cur && !changed.length) return text({ ok: true, created: false, customer_id: cur.id, changed: [], next: '内容和原来一样，没有修改。' });

    const { session, client } = sessionInfo(extra);
    const limited = log.limit(session);
    if (limited) return fail(limited);

    const fields = {};
    for (const f of (cur ? changed : FIELDS)) fields[f] = next[f];
    const saved = hooks.customerSave(cur ? { id: cur.id, ...fields } : { accountId, ...fields });
    if (!saved) return fail('客户资料没能保存（内容不合格或已被删除）。');
    const after = pick(saved);
    const realChanged = FIELDS.filter((f) => !same((before || EMPTY)[f], after[f]));
    if (realChanged.length) log.add({ op: cur ? 'update' : 'create', client, accountName: account ? account.name : '', customerId: saved.id, before, after, changed: realChanged });
    return text({
      ok: true,
      created: !cur,
      customer_id: saved.id,
      changed: realChanged,
      next: '已保存。用户可以在 WAswitch 的 MCP 接口设置 → AI 操作记录里一键撤销。',
    });
  });
}

const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

module.exports = { registerCustomerEditTools, AiLog, parseFollowUp, LOG_FILE, LOG_MAX, RATE_MAX };
