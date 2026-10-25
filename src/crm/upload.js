// 同步到 CRM 第 2 步（电脑端）：每 10 分钟把本机加密队列里的聊天传到团队后台。
// 规则：
//   - 只传开着同步的团队号；后台回 200 才从本机队列删（失败下一轮自动重传，本机最多留 7 天）
//   - 每次最多约 200 KB，每个号每轮最多传 3 次（后台限制每 10 分钟 3 次）
//   - 后台回 503 crm_paused（推送还没开）：这一轮停，聊天留在本机
//   - 不跟随跳转、不走账号代理（用 TeamSync.post）
const MAX_BODY = 200 * 1024;
const MAX_ITEMS = 500;
const PER_ACCOUNT = 3;

function pickBatch(items) {
  const out = [];
  let size = 200; // 外层 JSON
  for (const x of items) {
    const item = { k: x.k || x.h, peer: x.peer, out: x.out, at: x.at, approx: x.approx, text: x.text };
    const len = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (out.length && (out.length >= MAX_ITEMS || size + len > MAX_BODY)) break;
    out.push({ h: x.h, item });
    size += len;
  }
  return out;
}

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
  }

  run() {
    if (!this.running) this.running = this.doRun().finally(() => { this.running = null; });
    return this.running;
  }

  async doRun() {
    if (!this.team.enrolled()) return { skipped: true };
    const token = this.team.tokenPlain();
    if (!token) return { skipped: true };
    let sent = 0;
    for (const acc of this.accounts()) {
      if (!this.crmOn(acc)) continue;
      for (let i = 0; i < PER_ACCOUNT; i += 1) {
        const batch = pickBatch(this.queue.peek(acc.id, MAX_ITEMS));
        if (!batch.length) break;
        let r;
        try {
          r = await this.team.post('/api/device/chats', { v: 1, team_id: acc.teamId, items: batch.map((b) => b.item) }, token);
        } catch (e) {
          this.last = { at: this.now(), error: e.name === 'AbortError' ? '超时' : '连不上后台' };
          return { offline: true, sent };
        }
        if (r.status === 200 && r.data && r.data.ok === true) {
          // 不合格被后台拒收的也一起删：再传也不会变合格
          this.queue.ack(acc.id, batch.map((b) => b.h));
          sent += batch.length;
          this.last = { at: this.now(), error: '' };
          continue;
        }
        if (r.status === 503 && r.data && r.data.crm_paused === true) {
          this.last = { at: this.now(), error: '后台还没开推送，聊天先留在本机' };
          return { paused: true, sent };
        }
        // 409 这个号没开（坐席同步会关掉本机开关并清队列）、429 太频繁、其它错误：这个号下一轮再传
        this.last = { at: this.now(), error: `上传失败（${r.status}）` };
        break;
      }
    }
    return { ok: true, sent };
  }
}

module.exports = { CrmUploader, pickBatch };
