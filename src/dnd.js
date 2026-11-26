// 勿扰的时长菜单，只在 Mac 上有：菜单栏图标、Dock 图标、侧栏右键账号共用（shen 2026-11-26「仅限 MAC」）。
// Windows 托盘还是原来的「勿扰（新消息不弹窗）」勾选项。
// 选 1 / 3 / 8 / 24 小时，到时间自动关；设置里「通知」那个开关打开的勿扰不限时，要手动关。
// 勿扰期间新消息不弹不响；掉线、退出登录、新版本这类提醒照弹，不响（见 popup.js）
const DND_HOURS = [1, 3, 8, 24];
const HOUR_MS = 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

// 勿扰到什么时候：今天写钟点，明天写「明天 9:30」，再往后写日期
function untilText(until, now = Date.now()) {
  const d = new Date(until);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (t) => { const x = new Date(t); return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
  const diff = Math.round((day(until) - day(now)) / (24 * HOUR_MS));
  if (diff <= 0) return hm;
  if (diff === 1) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// 勿扰到期了没有（限时的勿扰过了时间算到期）
function dndExpired(settings, now = Date.now()) {
  return !!settings.popupDnd && settings.popupDndUntil > 0 && settings.popupDndUntil <= now;
}

// 菜单里的一项（带子菜单）。set(hours)：hours 是 0 表示关掉
function dndMenuItem({ settings, now = Date.now(), set }) {
  const on = !!settings.popupDnd && !dndExpired(settings, now);
  const label = !on ? '勿扰' : settings.popupDndUntil > 0 ? `勿扰到 ${untilText(settings.popupDndUntil, now)}` : '勿扰中';
  return {
    label,
    submenu: [
      ...DND_HOURS.map((h) => ({ label: `${h} 小时`, click: () => set(h) })),
      ...(on ? [{ type: 'separator' }, { label: '关闭勿扰', click: () => set(0) }] : []),
    ],
  };
}

// 选了时长以后的设置值
function dndPatch(hours, now = Date.now()) {
  return hours > 0 ? { popupDnd: true, popupDndUntil: now + hours * HOUR_MS } : { popupDnd: false, popupDndUntil: 0 };
}

module.exports = { DND_HOURS, untilText, dndExpired, dndMenuItem, dndPatch };
