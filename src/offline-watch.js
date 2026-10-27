// 账号断线提醒：一个号连续断线满 2 分钟，弹一次桌面通知，托盘上标出来。
//
// 只看软件已经知道的状态（网页号的问题页 P1/N1、轻量号的连接状态），不额外发请求。
// - 断线不满 2 分钟就恢复：什么都不做（网络切换、Clash 重启这类短暂断开不打扰人）
// - 满 2 分钟：弹一次；这次断线期间不再弹，恢复时也不弹
// - 弹过以后 30 分钟内又断线（节点时好时坏）：只在托盘上标，不再弹
// - 电脑睡眠醒来：断线时间从醒来重新算，不会一醒来就弹
const DELAY_MS = 2 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;

class OfflineWatch {
  constructor({ delayMs = DELAY_MS, cooldownMs = COOLDOWN_MS, now = () => Date.now() } = {}) {
    this.delayMs = delayMs;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.since = new Map(); // id -> 这次断线开始的时间
    this.alerted = new Set(); // 这次断线已经处理过（弹过或在冷却里跳过）
    this.lastPop = new Map(); // id -> 上次弹通知的时间
    this.lastKey = ''; // 上次托盘上标出的号，变了才刷新托盘
  }

  // offline：现在断线的账号 id 集合。返回这一刻该弹通知的 id；changed 表示托盘标记要刷新
  update(offline) {
    const now = this.now();
    for (const id of [...this.since.keys()]) {
      if (!offline.has(id)) { this.since.delete(id); this.alerted.delete(id); }
    }
    const due = [];
    for (const id of offline) {
      if (!this.since.has(id)) this.since.set(id, now);
      if (this.alerted.has(id) || now - this.since.get(id) < this.delayMs) continue;
      this.alerted.add(id);
      const last = this.lastPop.get(id);
      if (last !== undefined && now - last < this.cooldownMs) continue;
      this.lastPop.set(id, now);
      due.push(id);
    }
    const key = this.markedKey();
    const changed = key !== this.lastKey;
    this.lastKey = key;
    return { due, changed };
  }

  // 断线满 2 分钟的号（托盘和托盘菜单标“断线”）
  marked(id) {
    return this.since.has(id) && this.now() - this.since.get(id) >= this.delayMs;
  }

  markedIds() {
    return [...this.since.keys()].filter((id) => this.marked(id));
  }

  markedKey() {
    return this.markedIds().sort().join(',');
  }

  // 睡眠醒来：还没满 2 分钟的断线从现在重新算
  restart() {
    const now = this.now();
    for (const id of this.since.keys()) {
      if (!this.alerted.has(id)) this.since.set(id, now);
    }
  }

  forget(id) {
    this.since.delete(id);
    this.alerted.delete(id);
    this.lastPop.delete(id);
  }
}

// 轻量号哪些状态算“断线”：在连、在重连、代理不通、后台进程重启中、需要手动处理的停止状态。
// 扫码相关（需要扫码不是断网）不算；退出登录、被封、反复失败已经当场弹过，不再算。
const LITE_OFFLINE = new Set(['connecting', 'reconnecting', 'proxyDown', 'crashed', 'crashLoop', 'replaced', 'outdated']);
// 网页号：P1 代理连不上、N1 页面打不开
const WEB_OFFLINE = new Set(['proxy', 'network']);

// 通知文案：一个号写号名，几个号同时到点合成一条
function offlineMessage(names) {
  if (names.length === 1) {
    return { title: names[0], body: '断线 2 分钟了，客户发来的消息现在收不到。点这里查看原因。' };
  }
  const list = names.length > 3 ? `${names.slice(0, 3).join('、')} 等` : names.join('、');
  return { title: `${names.length} 个号断线了`, body: `${list}断线 2 分钟了，客户发来的消息现在收不到。点这里查看。` };
}

module.exports = { OfflineWatch, LITE_OFFLINE, WEB_OFFLINE, offlineMessage, DELAY_MS, COOLDOWN_MS };
