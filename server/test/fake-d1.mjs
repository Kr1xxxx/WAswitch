// 测试用：用 Node 自带的 node:sqlite 模拟 D1 绑定（prepare/bind/first/all/run/batch）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    for (const a of args) if (a === undefined || typeof a === 'boolean' || (typeof a === 'object' && a !== null)) throw new Error(`D1 不接受这个参数类型：${typeof a}（${this.sql.slice(0, 60)}）`);
    return new Stmt(this.db, this.sql, args);
  }
  _s() { return this.db.prepare(this.sql); }
  async first() { const r = this._s().get(...this.args); return r === undefined ? null : { ...r }; }
  async all() { return { results: this._s().all(...this.args).map((r) => ({ ...r })) }; }
  async run() { const r = this._s().run(...this.args); return { meta: { changes: Number(r.changes) } }; }
  _runSync() { return this._s().run(...this.args); }
}

// migrations：迁移文件夹（按文件名顺序全部执行，和 wrangler d1 migrations apply 一样）或单个文件
export function fakeD1(migrations) {
  const db = new DatabaseSync(':memory:');
  const files = fs.statSync(migrations).isDirectory()
    ? fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(migrations, f))
    : [migrations];
  for (const f of files) db.exec(fs.readFileSync(f, 'utf8'));
  let writes = 0;
  const wrap = {
    prepare: (sql) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes += 1;
      return new Stmt(db, sql);
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => ({ meta: { changes: Number(s._runSync().changes) } })); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    get writes() { return writes; },
    raw: db,
  };
  return wrap;
}
