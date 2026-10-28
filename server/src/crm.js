// 同步到 CRM 第 2 步：员工电脑上传聊天 → 团队后台加密暂存 → 定时推给来财。
// 规则（设计文档 + 审计 + 来财审查）：
//   - 只有推送配置齐（CRM_PUSH=1、CRM_KEY、LAICRM_SECRET、LAICRM 绑定）才收上传；没配齐回 503，电脑留着自己的队列
//   - 暂存用 AES-GCM，每批随机 IV，AAD = 批编号|账号|电脑；密钥只在 Worker secret 里
//   - 每个号每 10 分钟最多上传 3 次；每次最多 300 KB
//   - 推给来财：每批 ≤100 条且 ≤256 KB（按 UTF-8 字节拆），HMAC 签名，消息编号 = HMAC(账号|对方号码|WhatsApp 消息编号)
//   - 来财回 stored / duplicate / unmatched 都算处理完，这批删掉；unmatched 不暂存、不重推（shen 2026-10-25 定）
//   - 关同步、删号时这个号还没推出去的批次一起删；超过 7 天没推出去的也删
//   - 日志里只写批编号、条数、状态码，不写消息内容
import { json, fail, now, uuid, readJson, HttpError } from './util.js';

export const CRM_MAX_UPLOAD = 300 * 1024;
const UPLOAD_LIMIT = 3;
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;
const MAX_ITEMS = 500;
const MAX_TEXT = 4000; // Unicode 字符（码点）
const MAX_AGE_MS = 7 * 864e5;
const PUSH_MAX_MSGS = 100;
const PUSH_MAX_BYTES = 250 * 1024; // 留一点余量给 256 KB
const RUN_MAX_MSGS = 800; // 每次定时任务最多处理这么多条（免费版定时任务 CPU 只有 10 毫秒）
const RUN_MAX_BATCHES = 20;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => {
  const data = new Uint8Array(bytes);
  const chunks = [];
  for (let i = 0; i < data.length; i += 0x8000) chunks.push(String.fromCharCode(...data.subarray(i, i + 0x8000)));
  return btoa(chunks.join(''));
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function keyBytes(env) {
  try {
    const k = unb64(String(env.CRM_KEY || ''));
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

// 推送配置齐了才算开着
export function pushReady(env) {
  return env.CRM_PUSH === '1' && !!keyBytes(env) && typeof env.LAICRM_SECRET === 'string' && env.LAICRM_SECRET.length >= 32
    && !!env.LAICRM && typeof env.LAICRM.fetch === 'function';
}

const aesKey = (env, use) => crypto.subtle.importKey('raw', keyBytes(env), 'AES-GCM', false, [use]);
const hmacKey = (raw, use = 'sign') => crypto.subtle.importKey('raw', typeof raw === 'string' ? enc.encode(raw) : raw, { name: 'HMAC', hash: 'SHA-256' }, false, [use]);

async function seal(env, aad, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aesKey(env, 'encrypt'), enc.encode(JSON.stringify(data)));
  return { iv: b64(iv), data: b64(ct) };
}

async function open(env, aad, iv, data) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, await aesKey(env, 'decrypt'), unb64(data));
  return JSON.parse(dec.decode(pt));
}

// 一条上传的消息：不合格的返回 null
function cleanItem(x, t) {
  if (!x || typeof x !== 'object') return null;
  const k = typeof x.k === 'string' && /^[A-Za-z0-9]{6,64}$/.test(x.k) ? x.k : null;
  const peer = typeof x.peer === 'string' && /^\d{8,15}$/.test(x.peer) ? x.peer : null;
  const at = Number.isSafeInteger(x.at) ? x.at : null;
  if (!k || !peer || at === null || at < t - MAX_AGE_MS || at > t + 10 * 60 * 1000) return null;
  if (typeof x.text !== 'string' || !x.text) return null;
  const text = Array.from(x.text).slice(0, MAX_TEXT).join('');
  return { k, peer, out: x.out === true, at, approx: x.approx === true, text };
}

// POST /api/device/chats { v, team_id, items: [{ k, peer, out, at, approx, text }] }
// 回 { ok, accepted, rejected }；电脑收到 200 就把这批从本机队列删掉
export async function uploadChats(request, env, dev) {
  const db = env.DB;
  if (!pushReady(env)) return fail(503, '聊天同步还没开', { crm_paused: true });
  const body = await readJson(request, CRM_MAX_UPLOAD);
  if (body.v !== 1) throw new HttpError(426, '这个版本的 WAswitch 太旧，请先更新');
  const accountId = typeof body.team_id === 'string' && /^[0-9a-f-]{36}$/.test(body.team_id) ? body.team_id : '';
  // 这个号必须在这台电脑上、可见、没删、开着同步
  const acc = accountId && await db.prepare(`SELECT a.id FROM wa_accounts a
    JOIN device_seats s ON s.account_id = a.id AND s.device_id = a.device_id AND s.visible = 1
    WHERE a.id = ? AND a.device_id = ? AND a.deleted_at IS NULL AND a.crm_sync = 1`).bind(accountId, dev.id).first();
  if (!acc) return fail(409, '这个号没开聊天同步', { crm_off: true });
  const t = now();
  const row = await db.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END
    RETURNING count`).bind(`chats:${accountId}`, t, t - UPLOAD_WINDOW_MS, t - UPLOAD_WINDOW_MS, t).first();
  if (row.count > UPLOAD_LIMIT) return fail(429, '上传太频繁，稍后再传');
  const raw = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  const items = raw.map((x) => cleanItem(x, t)).filter(Boolean);
  const rejected = (Array.isArray(body.items) ? body.items.length : 0) - items.length;
  if (items.length) {
    const id = uuid();
    const box = await seal(env, `${id}|${accountId}|${dev.id}`, items);
    await db.prepare('INSERT INTO crm_batches (id, account_id, device_id, n, iv, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, accountId, dev.id, items.length, box.iv, box.data, t).run();
  }
  return json({ ok: true, accepted: items.length, rejected });
}

// 来财的消息编号：同一条消息不管从哪台电脑、网页版还是轻量版传上来都一样
async function msgIds(env, accountId, items) {
  const key = await hmacKey(keyBytes(env));
  return Promise.all(items.map(async (x) => hex(await crypto.subtle.sign('HMAC', key, enc.encode(`msgid|${accountId}|${x.peer}|${x.k}`))).slice(0, 32)));
}

// 按条数和 UTF-8 字节拆成几批
export function chunkMessages(envelope, messages, maxMsgs = PUSH_MAX_MSGS, maxBytes = PUSH_MAX_BYTES) {
  const base = enc.encode(JSON.stringify({ ...envelope, messages: [] })).length;
  const out = [];
  let cur = [];
  let size = base;
  for (const m of messages) {
    const len = enc.encode(JSON.stringify(m)).length + 1;
    if (cur.length && (cur.length >= maxMsgs || size + len > maxBytes)) { out.push(cur); cur = []; size = base; }
    cur.push(m);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function sendOne(env, body) {
  const ts = String(now());
  const sig = hex(await crypto.subtle.sign('HMAC', await hmacKey(env.LAICRM_SECRET), enc.encode(`${ts}.${body}`)));
  return env.LAICRM.fetch(new Request('https://laicrm.internal/waswitch/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-waswitch-timestamp': ts, 'x-waswitch-signature': `sha256=${sig}` },
    body,
  }));
}

const STATUSES = new Set(['stored', 'duplicate', 'unmatched']);

// 定时任务：每 30 分钟推一次
export async function pushCrm(env) {
  const db = env.DB;
  const t = now();
  await db.prepare('DELETE FROM crm_batches WHERE created_at < ?').bind(t - MAX_AGE_MS).run();
  if (!pushReady(env)) return { paused: true };
  const rows = (await db.prepare('SELECT id, account_id, device_id, n, iv, data FROM crm_batches ORDER BY created_at LIMIT ?').bind(RUN_MAX_BATCHES).all()).results;
  let budget = RUN_MAX_MSGS;
  const done = { batches: 0, stored: 0, unmatched: 0 };
  for (const row of rows) {
    if (row.n > budget && done.batches > 0) break;
    budget -= row.n;
    const acc = await db.prepare(`SELECT a.id, a.label, a.number_label, a.crm_sync, a.deleted_at, u.name AS staff
      FROM wa_accounts a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = ?`).bind(row.account_id).first();
    if (!acc || acc.crm_sync !== 1 || acc.deleted_at) {
      await db.prepare('DELETE FROM crm_batches WHERE id = ?').bind(row.id).run();
      continue;
    }
    let items;
    try {
      items = await open(env, `${row.id}|${row.account_id}|${row.device_id}`, row.iv, row.data);
    } catch {
      console.error('crm batch unreadable', row.id);
      await db.prepare('DELETE FROM crm_batches WHERE id = ?').bind(row.id).run();
      continue;
    }
    items.sort((a, b) => a.at - b.at);
    const ids = await msgIds(env, acc.id, items);
    const messages = items.map((x, i) => ({ id: ids[i], peer: x.peer, dir: x.out ? 'out' : 'in', at: x.at, approx: x.approx, text: x.text }));
    const phone = String(acc.number_label || '').replace(/\D/g, '');
    const envelope = { v: 1, batch_id: row.id, account: { id: acc.id, label: acc.label, phone: /^\d{8,15}$/.test(phone) ? phone : '' }, staff: { name: acc.staff || '' } };
    let stored = 0;
    let unmatched = 0;
    let finished = true;
    for (const chunk of chunkMessages(envelope, messages)) {
      let res;
      try {
        res = await sendOne(env, JSON.stringify({ ...envelope, messages: chunk }));
      } catch {
        console.error('crm push failed', row.id, 'network');
        return done; // 来财不通：这一轮停，下一轮整批重推（来财按编号去重）
      }
      if (res.status === 401 || res.status === 403) {
        console.error('crm push auth', row.id, res.status);
        await db.prepare("INSERT INTO meta (key, value) VALUES ('crm_auth_fail_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(t).run();
        return done;
      }
      if (res.status === 400 || res.status === 413) {
        // 来财说格式不对：重推也没用，这几条算丢弃
        console.error('crm push rejected', row.id, res.status, chunk.length);
        unmatched += chunk.length;
        continue;
      }
      if (res.status !== 200) {
        console.error('crm push failed', row.id, res.status);
        return done;
      }
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      const sent = new Set(chunk.map((m) => m.id));
      const got = new Map();
      for (const r of data && Array.isArray(data.results) ? data.results : []) {
        if (r && sent.has(r.id) && STATUSES.has(r.status)) got.set(r.id, r.status);
      }
      if (got.size !== sent.size) { finished = false; console.error('crm push incomplete', row.id, got.size, sent.size); break; }
      for (const s of got.values()) if (s === 'unmatched') unmatched += 1; else stored += 1;
    }
    if (!finished) continue; // 有没回结果的：这批留着，下一轮重推
    await db.batch([
      db.prepare('DELETE FROM crm_batches WHERE id = ?').bind(row.id),
      db.prepare('UPDATE wa_accounts SET crm_stored = crm_stored + ?, crm_dropped = crm_dropped + ?, crm_pushed_at = ? WHERE id = ?').bind(stored, unmatched, t, acc.id),
      db.prepare("UPDATE meta SET value = 0 WHERE key = 'crm_auth_fail_at' AND value != 0"),
    ]);
    done.batches += 1;
    done.stored += stored;
    done.unmatched += unmatched;
  }
  return done;
}
