// 把本机加密队列里的聊天传到来财（/api/device/chats）。主进程每 2 分钟调一次 run()（队列里有东西时）。
// 规则：
//   - 只传团队号；来财回 200 才动本机队列（失败下一轮自动重传，本机最多留 30 天）
//   - 来财对每条回一个结果（results）：stored / duplicate / rejected 删掉；held（对方还不是来财客户）
//     留在本机的 held 表里，每小时再传一次，30 天后自动删（queue.js）
//   - 旧后台 200 不带 results：这批全部删掉（以前的做法）；results 条数对不上：这批留着下一轮再传
//   - 不认识的结果当 held（留着、每小时再传，30 天后删）
//   - 每次最多约 200 KB、500 条；每个号每轮最多传 3 次（来财限制每个号每 10 分钟 20 次）
//   - 503（来财还没开、推送暂停）：这一轮停，聊天留在本机；409（这个号没开）、429（太频繁）：这个号下一轮再传
//   - 429 + error 'budget'（来财今天的上传额度用完了）：所有号都停，聊天留在本机，过 retry_after_s 秒再传
//   - 不跟随跳转、不走账号代理（用 TeamSync.post）
const MAX_BODY = 200 * 1024;
const MAX_ITEMS = 500;
const PER_ACCOUNT = 3;
const BUDGET_WAIT_S = 3600; // 额度用完但没说等多久：1 小时后再试
const BUDGET_MAX_S = 2 * 24 * 3600;
const BUDGET_TEXT = '今天的上传额度用完了，明天继续';

function pickBatch(items) {
  const out = [];
  let size = 200; // 外层 JSON
  for (const x of items) {
    const item = { k: x.k || x.h, peer: x.peer, out: x.out, at: x.at, approx: x.approx, text: x.text, ...(x.name ? { name: x.name } : {}) };
    const len = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (out.length && (out.length >= MAX_ITEMS || size + len > MAX_BODY)) break;
    out.push({ h: x.h, item });
    size += len;
  }
  return out;
}

const errorOf = (d) => (d && typeof d.error === 'string' ? d.error : '');

class CrmUploader {
  // deps: { queue, team, accounts: () => [...], crmOn: (acc) => bool, now }
  constructor({ queue, team, accounts, crmOn, now = Date.now }) {
    this.queue = queue;
    this.team = team;
    this.accounts = accounts;
    this.crmOn = crmOn;
    this.now = now;
    this.running = null;
    this.last = { at: 0, error: '' };
    this.waitUntil = 0; // 来财的上传额度用完了：这之前不传
  }

  // 有没有要传的（待发的，或者先留着、到了再传时间的）
  due() {
    if (this.now() < this.waitUntil) return false;
    return this.accounts().some((acc) => this.crmOn(acc) && (this.queue.peek(acc.id, 1).length || this.queue.peekHeld(acc.id, 1).length));
  }

  run() {
    if (!this.running) this.running = this.doRun().finally(() => { this.running = null; });
    return this.running;
  }

  async doRun() {
    if (!this.team.enrolled()) return { skipped: true };
    if (this.now() < this.waitUntil) return { skipped: true, budget: true };
    const token = this.team.tokenPlain();
    if (!token) return { skipped: true };
    let sent = 0;
    let held = 0;
    for (const acc of this.accounts()) {
      if (!this.crmOn(acc)) continue;
      // 先传新的，再传先留着、到了时间的；一个号一轮合计最多 PER_ACCOUNT 次
      let calls = 0;
      for (const pick of [() => this.queue.peek(acc.id, MAX_ITEMS), () => this.queue.peekHeld(acc.id, MAX_ITEMS)]) {
        while (calls < PER_ACCOUNT) {
          const batch = pickBatch(pick());
          if (!batch.length) break;
          calls += 1;
          let r;
          try {
            r = await this.team.post('/api/device/chats', { v: 1, team_id: acc.teamId, items: batch.map((b) => b.item) }, token);
          } catch (e) {
            this.last = { at: this.now(), error: e.name === 'AbortError' ? '超时' : '连不上来财' };
            return { offline: true, sent, held };
          }
          const d = r.data || {};
          if (r.status === 200 && d.ok === true) {
            if (Array.isArray(d.results) && d.results.length !== batch.length) {
              // 结果条数对不上：不知道哪条成了，这批全部留着，下一轮再传（来财按编号去重）
              this.last = { at: this.now(), error: '来财的回答不对，聊天先留在本机' };
              calls = PER_ACCOUNT;
              break;
            }
            if (Array.isArray(d.results)) {
              // 不认识的结果当 held：留着，一小时后再传
              const n = this.queue.settle(acc.id, batch.map((b, i) => ({ h: b.h, status: d.results[i] })));
              sent += n.done;
              held += n.held;
            } else {
              // 旧后台：不合格被拒收的也一起删，再传也不会变合格
              this.queue.ack(acc.id, batch.map((b) => b.h));
              sent += batch.length;
            }
            this.last = { at: this.now(), error: '' };
            continue;
          }
          if (r.status === 503) {
            this.last = { at: this.now(), error: '来财暂时不收，聊天先留在本机' };
            return { paused: true, sent, held };
          }
          if (r.status === 429 && errorOf(d) === 'budget') {
            const s = Number.isInteger(d.retry_after_s) && d.retry_after_s > 0 ? Math.min(d.retry_after_s, BUDGET_MAX_S) : BUDGET_WAIT_S;
            this.waitUntil = this.now() + s * 1000;
            this.last = { at: this.now(), error: BUDGET_TEXT };
            return { budget: true, sent, held };
          }
          // 409 这个号没开（坐席同步会关掉本机开关并清队列）、429 太频繁、其它错误：这个号下一轮再传
          this.last = { at: this.now(), error: r.status === 429 || errorOf(d) === 'rate' ? '太频繁，稍后再传' : `上传失败（${r.status}）` };
          calls = PER_ACCOUNT;
          break;
        }
      }
    }
    return { ok: true, sent, held };
  }
}

module.exports = { CrmUploader, pickBatch, BUDGET_TEXT };
