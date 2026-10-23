// 省内存：在不漏消息的前提下，尽量少占内存。
//
// 1. 自动回收：WhatsApp 网页开久了内存会越涨越多。后台账号超过设定值、并且没有未读消息时，
//    在后台刷新一次。刷新只要几秒，期间收到的消息会从手机同步过来，不会丢。
// 2. 后台降级：不在看的账号设为“隐藏”，Chromium 会降低它的优先级、节流定时器、释放画面缓存。
//    WhatsApp 的消息是服务器推送的，节流不会耽误收消息。
// 3. 省内存模式：关闭显卡加速，整体再省一些内存，代价是动画没那么顺滑。需要重启生效。
// 4. 统计每个账号占用的内存，显示在托盘菜单里。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  lowMemoryMode: false, // 关闭显卡加速
  recycleMB: 500, // 后台账号超过这个值就自动刷新，0 表示不自动刷新
};
const CHECK_EVERY_MS = 60 * 1000;
const MIN_RECYCLE_GAP_MS = 30 * 60 * 1000; // 同一个账号两次刷新至少间隔 30 分钟
const BACKGROUND_FOR_MS = 5 * 60 * 1000; // 至少在后台待了 5 分钟才回收

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return {
      lowMemoryMode: raw.lowMemoryMode === true,
      recycleMB: Number.isFinite(raw.recycleMB) && raw.recycleMB >= 0 ? raw.recycleMB : DEFAULTS.recycleMB,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// 必须在 app ready 之前调用
function applyStartupSwitches(settings) {
  if (settings.lowMemoryMode) app.disableHardwareAcceleration();
}

class MemoryManager {
  // hooks: { views: Map, isBackground(id), unreadOf(id), onUpdate() }
  constructor(settings, hooks) {
    this.settings = settings;
    this.hooks = hooks;
    this.usageMB = new Map(); // id -> 当前占用（MB）
    this.lastRecycle = new Map(); // id -> 上次自动刷新的时间
    this.backgroundSince = new Map(); // id -> 进入后台的时间
    this.timer = null;
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
  }

  totalMB() {
    let sum = 0;
    for (const mb of this.usageMB.values()) sum += mb;
    return sum;
  }

  check() {
    const byPid = new Map();
    for (const m of app.getAppMetrics()) {
      // Windows 上用私有内存更准确，其他系统用常驻内存。单位是 KB
      const kb = m.memory.privateBytes || m.memory.workingSetSize;
      byPid.set(m.pid, kb / 1024);
    }
    const now = Date.now();
    for (const [id, view] of this.hooks.views) {
      const wc = view.webContents;
      if (wc.isDestroyed()) continue;
      const mb = Math.round(byPid.get(wc.getOSProcessId()) || 0);
      this.usageMB.set(id, mb);

      const limit = this.settings.recycleMB;
      if (!limit || mb < limit) continue;
      if (!this.hooks.isBackground(id)) continue;
      if (now - (this.backgroundSince.get(id) || now) < BACKGROUND_FOR_MS) continue;
      if (this.hooks.unreadOf(id) > 0) continue; // 有未读时不动，免得用户回来看到页面在加载
      if (now - (this.lastRecycle.get(id) || 0) < MIN_RECYCLE_GAP_MS) continue;
      if (wc.isLoading()) continue;
      console.log(`账号 ${id} 占用 ${mb} MB，超过 ${limit} MB，后台刷新回收内存`);
      this.lastRecycle.set(id, now);
      wc.reload();
    }
    this.hooks.onUpdate();
  }
}

module.exports = { MemoryManager, loadSettings, saveSettings, applyStartupSwitches };
