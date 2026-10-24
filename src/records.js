// 话术库和客户名单：存在本机的 JSON 文件里（和 accounts.json 一样是明文），不同步、不上传。
// 每条记录有随机 id、更新时间 updatedAt（毫秒）和删除标记 deleted（删除只打标记，方便以后同步），
// 删除标记最多留 2 万条。这两个文件不进日志、不进自检输出。
const fs = require('fs');
const crypto = require('crypto');

const TOMBSTONE_MAX = 20000;
const IMPORT_MAX_BYTES = 1024 * 1024;
const IMPORT_MAX_ROWS = 5000;

const str = (v, max) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)).replace(/\r\n?/g, '\n').slice(0, max);
const line = (v, max) => str(v, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);

// 每种记录的字段和长度限制
const KINDS = {
  replies: {
    file: 'quick-replies.json',
    clean(r) {
      return {
        title: line(r.title, 60),
        text: str(r.text, 2000).trim(),
        scope: 'mine', // 以后团队话术是 'team'（只读），本地的永远是 'mine'
      };
    },
    valid: (r) => !!r.text,
  },
  customers: {
    file: 'customers.json',
    clean(r) {
      const tags = (Array.isArray(r.tags) ? r.tags : typeof r.tags === 'string' ? r.tags.split(/[,，;；]/) : [])
        .map((t) => line(t, 20)).filter(Boolean);
      return {
        accountId: line(r.accountId, 40),
        name: line(r.name, 60),
        phone: line(r.phone, 40),
        note: str(r.note, 500).trim(),
        tags: [...new Set(tags)].slice(0, 10),
        followUpAt: Number.isFinite(Number(r.followUpAt)) && Number(r.followUpAt) > 0 ? Math.floor(Number(r.followUpAt)) : 0,
        reminded: r.reminded === true,
      };
    },
    valid: (r) => !!(r.name || r.phone),
  },
};

class Records {
  constructor(dir, kind) {
    this.kind = kind;
    this.def = KINDS[kind];
    this.file = require('path').join(dir, this.def.file);
    this.items = null;
  }

  load() {
    if (this.items) return this.items;
    this.items = [];
    if (!fs.existsSync(this.file)) return this.items;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('not an array');
      const seen = new Set();
      for (const r of raw) {
        if (!r || typeof r.id !== 'string' || seen.has(r.id)) continue;
        seen.add(r.id);
        this.items.push({
          id: r.id,
          ...this.def.clean(r),
          updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
          deleted: r.deleted === true,
        });
      }
    } catch (e) {
      // 坏了先备份，不覆盖（和 accounts.json 一样）。只写文件名，不写内容
      const backup = `${this.file}.broken-${Date.now()}`;
      try { fs.copyFileSync(this.file, backup); } catch {}
      console.warn(`${this.def.file} 无法读取（${e.message}），已备份`);
      this.items = [];
    }
    return this.items;
  }

  save() {
    // 删除标记太多时，丢掉最旧的
    const dead = this.items.filter((r) => r.deleted);
    if (dead.length > TOMBSTONE_MAX) {
      const drop = new Set(dead.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, dead.length - TOMBSTONE_MAX).map((r) => r.id));
      this.items = this.items.filter((r) => !drop.has(r.id));
    }
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items, null, 1));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  list() {
    return this.load().filter((r) => !r.deleted);
  }

  get(id) {
    return this.load().find((r) => r.id === id && !r.deleted) || null;
  }

  // 新建或修改；返回保存后的记录，内容不合格返回 null
  // imported：导入的记录，跟进时间已经过了的当作已提醒，避免导入后一下子弹出一堆通知
  upsert(data, { save = true, imported = false } = {}) {
    this.load();
    const clean = this.def.clean(data || {});
    if (!this.def.valid(clean)) return null;
    const old = typeof data.id === 'string' ? this.items.find((r) => r.id === data.id && !r.deleted) : null;
    let rec;
    if (old) {
      // 改了跟进时间就重新提醒
      if (this.kind === 'customers' && clean.followUpAt !== old.followUpAt) clean.reminded = false;
      else if (this.kind === 'customers') clean.reminded = old.reminded;
      Object.assign(old, clean, { updatedAt: Date.now() });
      rec = old;
    } else {
      if (this.kind === 'customers') clean.reminded = imported && !!clean.followUpAt && clean.followUpAt <= Date.now();
      rec = { id: crypto.randomUUID(), ...clean, updatedAt: Date.now(), deleted: false };
      this.items.push(rec);
    }
    if (save) this.save();
    return rec;
  }

  remove(id) {
    const r = this.load().find((x) => x.id === id && !x.deleted);
    if (!r) return false;
    // 只留 id、时间和删除标记，内容清掉
    for (const k of Object.keys(r)) if (!['id', 'updatedAt', 'deleted'].includes(k)) delete r[k];
    Object.assign(r, this.def.clean({}), { updatedAt: Date.now(), deleted: true });
    this.save();
    return true;
  }

  patch(id, fields) {
    const r = this.get(id);
    if (!r) return;
    Object.assign(r, fields);
    this.save();
  }
}

// ---------- 导入导出 ----------

// CSV 单元格：所有字段都加引号；= + - @ 和制表符开头的前面加单引号，免得 Excel 当成公式（电话号码常以 + 开头）
function csvCell(v) {
  let t = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
}
const COLUMNS = {
  replies: [['title', '标题'], ['text', '内容']],
  customers: [['name', '名字'], ['phone', '电话'], ['tags', '标签'], ['note', '备注'], ['followUpAt', '下次跟进'], ['accountId', '账号编号'], ['accountName', '账号']],
};
function toCsv(kind, rows) {
  const cols = COLUMNS[kind];
  const head = cols.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map((r) => cols.map(([k]) => {
    if (k === 'tags') return csvCell((r.tags || []).join(','));
    if (k === 'followUpAt') return csvCell(r.followUpAt ? new Date(r.followUpAt).toISOString().slice(0, 16).replace('T', ' ') : '');
    return csvCell(r[k]);
  }).join(','));
  return `\ufeff${[head, ...body].join('\r\n')}\r\n`; // 开头写 BOM，Excel 打开中文不乱码
}

// 简单 CSV 解析（支持引号、引号里的逗号和换行）
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
// 导出时加的单引号去掉
const unquote = (t) => (/^'[=+\-@\t\r]/.test(t) ? t.slice(1) : t);

// 读导入文件：返回 { rows } 或 { error }。只接受字符串字段
function readImport(kind, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { error: '文件打不开' }; }
  if (!stat.isFile()) return { error: '不是文件' };
  if (stat.size > IMPORT_MAX_BYTES) return { error: '文件超过 1 MB' };
  let text = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
  let rows = [];
  if (/\.json$/i.test(file)) {
    let raw;
    try { raw = JSON.parse(text); } catch { return { error: 'JSON 格式不对' }; }
    if (!Array.isArray(raw)) return { error: 'JSON 里应该是一个列表' };
    rows = raw.filter((r) => r && typeof r === 'object').map((r) => {
      const o = {};
      for (const [k] of COLUMNS[kind]) if (typeof r[k] === 'string' || (k === 'tags' && Array.isArray(r[k]))) o[k] = k === 'tags' ? r[k].filter((t) => typeof t === 'string') : r[k];
      if (kind === 'customers' && typeof r.followUpAt === 'number') o.followUpAt = r.followUpAt;
      return o;
    });
  } else {
    const table = parseCsv(text);
    if (!table.length) return { error: '文件是空的' };
    const head = table[0].map((c) => unquote(c.trim()));
    const idx = COLUMNS[kind].map(([k, label]) => [k, head.findIndex((c) => c === label || c.toLowerCase() === k.toLowerCase())]);
    if (idx.every(([, i]) => i < 0)) return { error: `第一行要有列名：${COLUMNS[kind].map(([, l]) => l).join('、')}` };
    rows = table.slice(1).map((r) => {
      const o = {};
      for (const [k, i] of idx) if (i >= 0 && r[i] !== undefined) o[k] = unquote(r[i]);
      if (o.followUpAt) { const t = Date.parse(String(o.followUpAt).replace(' ', 'T')); o.followUpAt = Number.isFinite(t) ? t : 0; }
      return o;
    });
  }
  if (rows.length > IMPORT_MAX_ROWS) return { error: `超过 ${IMPORT_MAX_ROWS} 条` };
  return { rows };
}

module.exports = { Records, toCsv, readImport, parseCsv, csvCell };
