// 直连网页号跟随系统代理上网：在 Clash 里换节点后出口变了，时区也要跟着变，
// 不然 WhatsApp 里的消息时间还是旧节点那边的。直连网页号的编辑页不让选时区，全由这里定。
const { regionForTimezone, timezoneOf } = require('./regions');

const POLL_MS = 30 * 60 * 1000; // Clash 换节点时系统代理地址不变，看不出来，只能定时查
const CONFIRM_MS = 2 * 60 * 1000; // 出口变了过一会儿再查一次，两次一样才改（自动选节点的组会来回切）
const IDLE_S = 10 * 60; // 电脑闲着时不定时查

function createDirectTz({ accounts, isDirectWeb, testSystem, save, viewOf, onChange, idleSeconds = () => 0, confirmMs = CONFIRM_MS }) {
  let running = null;
  let again = false;
  let seen = null; // 上次查到、还没确认的出口地区
  let confirmTimer = null;

  // 改一个号的时区：页面不重开（不打断正在打的字），之后显示的消息时间按新时区
  async function apply(acc, region) {
    acc.fingerprint.region = region;
    const wc = viewOf(acc.id);
    if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
      await wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: timezoneOf(region) }).catch((e) => console.warn('换时区失败', e.message));
    }
  }

  async function once() {
    const list = accounts().filter(isDirectWeb);
    if (!list.length) { seen = null; return []; }
    const res = await testSystem();
    const region = res && res.ok ? regionForTimezone(res.timezone) : null;
    if (!region) return [];
    const stale = list.filter((a) => a.fingerprint.region !== region);
    if (!stale.length) { seen = region; return []; }
    if (seen !== region) {
      // 第一次看到这个出口：先不改，过一会儿再查一次
      seen = region;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => sync().catch(() => {}), confirmMs);
      return [];
    }
    for (const acc of stale) await apply(acc, region);
    save();
    onChange(stale, region);
    return stale;
  }

  // 返回改了时区的账号。正在查时又被叫：查完再补一次，不漏掉中途的变化
  function sync() {
    if (running) { again = true; return running; }
    running = (async () => {
      let changed = [];
      do {
        again = false;
        changed = changed.concat(await once());
      } while (again);
      return changed;
    })().finally(() => { running = null; });
    return running;
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (idleSeconds() > IDLE_S) return;
      sync().catch((e) => console.warn('直连号时区同步失败', e));
    }, POLL_MS);
    setTimeout(() => sync().catch(() => {}), 15000); // 启动后等账号都开起来再查
  }
  return { sync, start, apply };
}

module.exports = { createDirectTz, POLL_MS };
