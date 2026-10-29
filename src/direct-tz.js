// 直连网页号跟随系统代理上网：在 Clash 里换节点后出口变了，时区也要跟着变，
// 不然 WhatsApp 里的消息时间还是旧节点那边的。
const { regionForTimezone, timezoneOf } = require('./regions');

const POLL_MS = 10 * 60 * 1000; // Clash 换节点时系统代理地址不变，看不出来，只能定时查一次出口

function createDirectTz({ accounts, isDirectWeb, testSystem, save, viewOf, onChange }) {
  let running = null;
  // 返回改了时区的账号
  async function sync() {
    if (running) return running;
    running = (async () => {
      const list = accounts().filter(isDirectWeb);
      if (!list.length) return [];
      const res = await testSystem();
      const region = res && res.ok ? regionForTimezone(res.timezone) : null;
      if (!region) return [];
      const changed = list.filter((a) => a.fingerprint.region !== region);
      for (const acc of changed) {
        acc.fingerprint.region = region;
        // 页面不重开（不打断正在打的字），直接换时区；之后显示的消息时间按新时区
        const wc = viewOf(acc.id);
        if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
          await wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: timezoneOf(region) }).catch((e) => console.warn('换时区失败', e.message));
        }
      }
      if (changed.length) { save(); onChange(changed, region); }
      return changed;
    })().finally(() => { running = null; });
    return running;
  }
  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => sync().catch((e) => console.warn('直连号时区同步失败', e)), POLL_MS);
    setTimeout(() => sync().catch(() => {}), 15000); // 启动后等账号都开起来再查
  }
  return { sync, start };
}

module.exports = { createDirectTz, POLL_MS };
