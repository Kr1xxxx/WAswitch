// 省内存：在不漏消息的前提下，尽量少占内存。
//
// 1. 自动回收：WhatsApp 网页开久了内存会越涨越多。后台账号超过设定值、并且没有未读消息时，
//    在后台刷新一次。刷新只要几秒，期间收到的消息会从手机同步过来，不会丢。
// 2. 后台降级：不在看的账号设为“隐藏”，Chromium 会降低它的优先级、节流定时器、释放画面缓存。
//    WhatsApp 的消息是服务器推送的，节流不会耽误收消息。
// 1b. 总上限：所有账号加起来超过上限（默认 4 GB）时，从占用最大的后台账号开始刷新，直到降回上限以内。
//     同样不碰正在看的账号、有未读的账号和正在加载的账号。
//     每个账号打开或刷新 5 分钟后记一个“底数”，只有比底数涨了 400 MB 以上才刷新；
//     所有账号底数加起来就超过上限时（账号太多），不再为上限刷新，只在内存页提示调高上限。
//     要在后台待满 30 分钟，同一个号至少隔 60 分钟，全部加起来每小时最多 3 次，不会反复重连。
// 默认值故意放宽（2026-10 起）：宁可多占一点内存，也不要频繁刷新带来意想不到的问题。
// 1c. 立即清理：用户手动点，把所有没有未读的后台账号刷新一遍，不退出登录、不丢消息。
// 3. 省内存模式：关闭显卡加速，整体再省一些内存，代价是动画没那么顺滑。需要重启生效。
// 4. 统计每个账号占用的内存，显示在托盘菜单里。只统计主页面进程，是近似值，略低于实际。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { writeJsonAtomic } = require('./atomic');

// settings.json 里的所有设置（不只内存相关），缺失或写坏的字段用默认值
const DEFAULTS = {
  lowMemoryMode: false, // 关闭显卡加速
  autoRecycle: true, // 总开关：自动回收后台账号。关掉后下面两条线都不起作用
  recycleMB: 1024, // 后台账号超过这个值就自动刷新，0 表示不限（聊天多的号常态 400–700 MB）
  closeToTray: true, // 关闭窗口时缩到托盘
  openAtLogin: false, // 开机自动启动（启动后缩在托盘）
  sidebarCollapsed: false, // 侧栏只显示图标
  showUpdateButton: false, // 侧栏底部显示“检查更新”按钮
  recycleLastMB: 1024, // 关掉自动回收后再打开时，用上次选的值
  lastAccountId: '', // 上次在看的账号，启动时打开它
  capMB: 4096, // 所有账号加起来的总上限，超过就回收后台账号，0 表示不限
  memDefaults: 3, // 第几版默认值；老设置里这个数比现在小时，把还停在旧默认值的项改成新默认值（每版只改一次）
  lockMinutes: 15, // 聊天锁：电脑这么多分钟没有键盘鼠标操作就遮住聊天区，0 表示关闭
  popupSeconds: 6, // 通知弹窗多少秒后自动收走，0 表示不自动收
  popupSound: true, // 弹窗时放提示音
  popupDnd: false, // 勿扰：不弹窗，只记进通知记录
};
const POPUP_SECONDS = [4, 6, 10, 0];
const PANEL_TABS = ['replies', 'customers', 'translate'];
const RECYCLE_CHOICES = [600, 800, 1024, 1500, 2000];
const CAP_CHOICES = [0, 1024, 1536, 2048, 3072, 4096, 6144];
const LOCK_CHOICES = [0, 1, 3, 5, 10, 15, 30];
const CHECK_EVERY_MS = 60 * 1000;
const MIN_RECYCLE_GAP_MS = 60 * 60 * 1000; // 同一个账号两次刷新至少间隔 60 分钟
const BACKGROUND_FOR_MS = 30 * 60 * 1000; // 至少在后台待了 30 分钟才回收
const CAP_GAP_MS = 60 * 60 * 1000; // 超总上限时，同一个账号两次刷新至少隔 60 分钟
const CAP_BACKGROUND_MS = 30 * 60 * 1000; // 超总上限时，也要在后台待满 30 分钟才回收
const CAP_MAX_PER_CHECK = 1; // 每分钟最多刷新 1 个，免得一下子全部重新加载
const CAP_MAX_PER_HOUR = 3; // 因为总上限刷新的，全部账号加起来每小时最多 3 次
const FRESH_PAGE_MB = 300; // 还没量到时，假定刚打开的 WhatsApp 网页占这么多
const BASELINE_AFTER_MS = 5 * 60 * 1000; // 打开或刷新 5 分钟后量一次，作为这个账号的“底数”
const GROWTH_MB = 400; // 比底数多出这么多才值得刷新，否则刷了也省不下来
const MANUAL_GROWTH_MB = 100; // 手动清理时，比底数多出这么多才刷新
const MANUAL_BACKGROUND_MS = 30 * 1000; // 手动清理时，刚切走 30 秒内的账号不动（可能有没打完的字或正在上传）
const MANUAL_GAP_MS = 2500; // 手动清理时，账号之间隔一会儿再刷新，避免卡顿

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// 0 表示关闭；其他值取最接近的一档（老版本存的 500 会变成 600）
function nearestRecycle(v) {
  if (v === 0) return 0;
  if (!Number.isFinite(v) || v < 0) return DEFAULTS.recycleMB;
  return RECYCLE_CHOICES.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best));
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    const bool = (k) => (typeof raw[k] === 'boolean' ? raw[k] : DEFAULTS[k]);
    // 老版本的默认值（800 MB 回收线、2 GB 总上限）压得太紧：还停在旧默认值的改成新默认值，用户自己选过别的值不动
    const ver = Number(raw.memDefaults) || 0;
    if (ver < 2) {
      if (raw.recycleMB === 800) raw.recycleMB = DEFAULTS.recycleMB;
      if (raw.recycleLastMB === 800) raw.recycleLastMB = DEFAULTS.recycleLastMB;
      if (raw.capMB === 2048) raw.capMB = DEFAULTS.capMB;
    }
    // 老版本没有总开关：两条线都关着的，就当总开关是关的
    const autoRecycle = typeof raw.autoRecycle === 'boolean' ? raw.autoRecycle : !(raw.recycleMB === 0 && raw.capMB === 0);
    // 第 3 版：聊天锁默认从 5 分钟改成 15 分钟（5 分钟太短，回个电话就锁了），还停在 5 分钟的改成 15
    if (ver < 3 && raw.lockMinutes === 5) raw.lockMinutes = DEFAULTS.lockMinutes;
    return {
      lowMemoryMode: bool('lowMemoryMode'),
      autoRecycle,
      recycleMB: nearestRecycle(raw.recycleMB),
      closeToTray: bool('closeToTray'),
      openAtLogin: bool('openAtLogin'),
      sidebarCollapsed: bool('sidebarCollapsed'),
      showUpdateButton: bool('showUpdateButton'),
      recycleLastMB: nearestRecycle(raw.recycleLastMB) || DEFAULTS.recycleLastMB,
      lastAccountId: typeof raw.lastAccountId === 'string' ? raw.lastAccountId.slice(0, 40) : '',
      capMB: CAP_CHOICES.includes(raw.capMB) ? raw.capMB : DEFAULTS.capMB,
      lockMinutes: LOCK_CHOICES.includes(raw.lockMinutes) ? raw.lockMinutes : DEFAULTS.lockMinutes,
      popupSeconds: POPUP_SECONDS.includes(raw.popupSeconds) ? raw.popupSeconds : DEFAULTS.popupSeconds,
      popupSound: bool('popupSound'),
      popupDnd: bool('popupDnd'),
      memDefaults: DEFAULTS.memDefaults,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// 先写临时文件再改名，写到一半断电也不会把设置文件写坏
function saveSettings(settings) {
  const file = settingsFile();
  writeJsonAtomic(file, settings, 2);
}

// 必须在 app ready 之前调用
function applyStartupSwitches(settings) {
  if (settings.lowMemoryMode) app.disableHardwareAcceleration();
}

class MemoryManager {
  // hooks: { views: Map, isBackground(id), unreadOf(id), onUpdate(), extraUsage(byPid)（可选：不是网页的账号的占用），
  //         skip(id)（可选：出错、停用等不该刷新的账号） }
  constructor(settings, hooks) {
    this.settings = settings;
    this.hooks = hooks;
    this.usageMB = new Map(); // id -> 当前占用（MB）
    this.lastRecycle = new Map(); // id -> 上次自动刷新的时间
    this.backgroundSince = new Map(); // id -> 进入后台的时间
    this.timer = null;
    this.cleaning = false;
    this.baselineMB = new Map(); // id -> 打开或刷新 5 分钟后的占用
    this.measureFrom = new Map(); // id -> 从什么时候起可以量底数（第一次见到或刷新的时间）
    this.capReloads = []; // 因为总上限刷新的时间，用来限制每小时次数
    this.recycleInfo = new Map(); // id -> { at, mb } 上次刷新回收的时间和当时的占用，给顶栏提示用
    this.capAdvice = 0; // 账号太多、上限达不到时，建议调到的上限（MB），0 表示没问题
  }

  start() {
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.check();
  }

  // 切换账号时调用，记下哪些账号进入了后台
  markBackground(id, inBackground) {
    if (inBackground) {
      if (!this.backgroundSince.has(id)) this.backgroundSince.set(id, Date.now());
    } else {
      this.backgroundSince.delete(id);
    }
  }

  forget(id) {
    this.usageMB.delete(id);
    this.lastRecycle.delete(id);
    this.backgroundSince.delete(id);
    this.baselineMB.delete(id);
    this.measureFrom.delete(id);
    this.recycleInfo.delete(id);
  }

  baseline(id) {
    return this.baselineMB.get(id) || FRESH_PAGE_MB;
  }

  totalMB() {
    let sum = 0;
    for (const mb of this.usageMB.values()) sum += mb;
    return sum;
  }

  measure() {
    const byPid = new Map();
    for (const m of app.getAppMetrics()) {
      // Windows 上用私有内存更准确，其他系统用常驻内存。单位是 KB
      const kb = m.memory.privateBytes || m.memory.workingSetSize;
      byPid.set(m.pid, kb / 1024);
    }
    for (const [id, mb] of (this.hooks.extraUsage ? this.hooks.extraUsage(byPid) : [])) this.usageMB.set(id, mb);
    for (const [id, view] of this.hooks.views) {
      const wc = view.webContents;
      if (wc.isDestroyed()) continue;
      const mb = Math.round(byPid.get(wc.getOSProcessId()) || 0);
      this.usageMB.set(id, mb);
      // 打开或刷新满 5 分钟、已经加载完，记下底数
      const now = Date.now();
      if (!this.measureFrom.has(id)) this.measureFrom.set(id, now);
      const from = this.measureFrom.get(id);
      if (from && now - from >= BASELINE_AFTER_MS && !wc.isLoading() && mb > 0) {
        this.baselineMB.set(id, mb);
        this.measureFrom.set(id, 0); // 0 表示这一轮已经量过
      }
    }
  }

  // 可以安全刷新的后台账号：不是正在看的、没有未读、没在加载、没出错
  canRecycle(id, wc) {
    if (wc.isDestroyed() || wc.isLoading()) return false;
    if (!this.hooks.isBackground(id)) return false;
    if (this.hooks.unreadOf(id) > 0) return false; // 有未读时不动，免得用户回来看到页面在加载
    if (this.hooks.skip && this.hooks.skip(id)) return false;
    return true;
  }

  recycle(id, wc, why) {
    console.log(`账号 ${id} 占用 ${this.usageMB.get(id) || 0} MB，${why}，后台刷新回收内存`);
    this.lastRecycle.set(id, Date.now());
    this.recycleInfo.set(id, { at: Date.now(), mb: this.usageMB.get(id) || 0 });
    this.measureFrom.set(id, Date.now()); // 刷新后重新量底数
    wc.reload();
  }

  check() {
    this.measure();
    const now = Date.now();
    const done = new Set();

    // 单个账号超过阈值
    const on = this.settings.autoRecycle !== false;
    const limit = on ? this.settings.recycleMB : 0;
    if (limit) {
      for (const [id, view] of this.hooks.views) {
        const wc = view.webContents;
        const mb = this.usageMB.get(id) || 0;
        if (mb < limit || mb < this.baseline(id) + GROWTH_MB || !this.canRecycle(id, wc)) continue;
        if (now - (this.backgroundSince.get(id) || now) < BACKGROUND_FOR_MS) continue;
        if (now - (this.lastRecycle.get(id) || 0) < MIN_RECYCLE_GAP_MS) continue;
        this.recycle(id, wc, `超过 ${limit} MB`);
        done.add(id);
      }
    }

    // 所有账号加起来超过总上限：从涨得最多的后台账号开始刷新
    const cap = on ? this.settings.capMB : 0;
    this.capAdvice = 0;
    if (cap) {
      // 刷新也降不下去的部分：网页账号的底数 + 轻量模式等其他占用
      let floor = this.totalMB();
      for (const [id] of this.hooks.views) floor -= Math.max(0, (this.usageMB.get(id) || 0) - this.baseline(id));
      if (floor > cap * 0.9) {
        // 账号太多，底数加起来就快到上限了：不为上限刷新，免得反复重连还省不下来
        this.capAdvice = CAP_CHOICES.find((c) => c >= floor * 1.3) || 0;
        if (!this.capAdvice) this.capAdvice = -1; // -1：建议不限
      } else {
        let total = this.totalMB();
        for (const id of done) total -= Math.max(0, (this.usageMB.get(id) || 0) - this.baseline(id));
        this.capReloads = this.capReloads.filter((t) => now - t < 60 * 60 * 1000);
        const growth = (id) => (this.usageMB.get(id) || 0) - this.baseline(id);
        if (total > cap) {
          const list = [...this.hooks.views]
            .filter(([id, view]) => !done.has(id) && this.canRecycle(id, view.webContents)
              && growth(id) >= GROWTH_MB
              && now - (this.backgroundSince.get(id) || now) >= CAP_BACKGROUND_MS
              && now - (this.lastRecycle.get(id) || 0) >= CAP_GAP_MS)
            .sort((a, b) => growth(b[0]) - growth(a[0]));
          let n = 0;
          for (const [id, view] of list) {
            if (total <= cap || n >= CAP_MAX_PER_CHECK || this.capReloads.length >= CAP_MAX_PER_HOUR) break;
            total -= growth(id);
            this.recycle(id, view.webContents, `总占用超过上限 ${cap} MB`);
            this.capReloads.push(now);
            n += 1;
          }
        }
      }
    }
    this.hooks.onUpdate();
  }

  // 立即清理：把所有可以安全刷新、并且比底数涨了不少的后台账号刷新一遍（不看阈值和间隔）。
  // 返回刷新了几个、跳过了几个（有未读、刚切走、在加载或下载）、几个本来就不大、估计能省下多少
  async cleanNow() {
    if (this.cleaning) return { error: '正在清理，请稍等' };
    this.cleaning = true;
    try {
      this.measure();
      let recycled = 0;
      let skipped = 0;
      let savedMB = 0;
      let fresh = 0;
      const list = [...this.hooks.views].sort((a, b) => (this.usageMB.get(b[0]) || 0) - (this.usageMB.get(a[0]) || 0));
      for (const [id, view] of list) {
        const wc = view.webContents;
        if (wc.isDestroyed()) continue;
        if (!this.hooks.isBackground(id)) continue;
        const growth = (this.usageMB.get(id) || 0) - this.baseline(id);
        if (growth < MANUAL_GROWTH_MB) { fresh += 1; continue; } // 刚刷新过或本来就不大，刷了也省不下
        const ok = () => this.canRecycle(id, wc) && Date.now() - (this.backgroundSince.get(id) || Date.now()) >= MANUAL_BACKGROUND_MS;
        if (!ok()) { skipped += 1; continue; }
        if (recycled) await new Promise((resolve) => { setTimeout(resolve, MANUAL_GAP_MS); });
        if (!ok()) { skipped += 1; continue; } // 等的这一会儿里来了消息或切了过去
        savedMB += growth;
        this.recycle(id, wc, '手动清理');
        recycled += 1;
      }
      this.hooks.onUpdate();
      return { ok: true, recycled, skipped, fresh, savedMB };
    } finally {
      this.cleaning = false;
    }
  }
}

module.exports = { DEFAULTS, PANEL_TABS, POPUP_SECONDS, RECYCLE_CHOICES, CAP_CHOICES, MemoryManager, loadSettings, saveSettings, applyStartupSwitches, LOCK_CHOICES };
