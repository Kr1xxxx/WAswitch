// 自检：一条新消息只响一种提示音（WAswitch 弹窗的，或者 WhatsApp 网页版自己的），见 src/wa-sound.js。
// 做法：真的 Electron 页面当网页号，来消息时像 WhatsApp 那样放提示音（不挂在页面上的 new Audio，也试 Web Audio），
// 标题改成 "(1) WhatsApp"；真的 Notifier + PopupWindow（不建窗口，只看它要不要响）决定 WAswitch 响不响；
// 页面静音照 main.js 的 syncWaSound 同步。「听到」WhatsApp 的声音 = 页面在出声并且没静音。
//   1. 没看着这个号、弹窗提示音开着：只响 WAswitch 的
//   2. 正看着这个号：WAswitch 不弹，只响 WhatsApp 的
//   3. 弹窗提示音关了：只响 WhatsApp 的
//   4. 勿扰：都不响
//   5. 这个号在 WAswitch 里不弹通知：都不响
//   6. 正在听语音时切走：语音放完才静音，之后来消息只响 WAswitch 的
//   8. 开了允许通话的直连号：从不静音（来电铃声、通话中停顿后的声音）
// 运行：xvfb-run -a npx electron --no-sandbox scripts/check-wa-sound.js
const { app, BrowserWindow } = require('electron');
const { Notifier } = require('../src/notify');
const { PopupWindow } = require('../src/popup');
const waSound = require('../src/wa-sound');

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

// ---------- 什么时候静音 ----------
const W = waSound.wantMute;
check(W({ looking: false, sound: true }) === true, '没看着、弹窗提示音开着：静音');
check(W({ looking: false, sound: undefined }) === true, '没设过（默认开）：静音');
check(W({ looking: true, sound: true, dnd: true, muted: true }) === false, '正看着：不静音');
check(W({ looking: false, sound: false }) === false, '弹窗提示音关了：不静音');
check(W({ looking: false, sound: false, dnd: true }) === true, '勿扰：静音');
check(W({ looking: false, sound: false, muted: true }) === true, '号不弹通知：静音');
check(W({ looking: false, sound: true, dnd: true, muted: true, calls: true }) === false, '开了允许通话的直连号：从不静音（来电铃声、通话声音）');

// 像 WhatsApp 一样放提示音：new Audio(...).play()，不挂在页面上；kind=webaudio 时用 Web Audio
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title></head><body>
<div id="app"><div id="side"><div id="pane-side"><div role="row"><span title="Emma Schneider">Emma Schneider</span><span title="Hallo!">Hallo!</span></div></div></div></div>
<script>
function wav(seconds) {
  const sr = 8000, n = Math.round(sr * seconds), b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 660 / sr) * 20000, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
const ding = wav(0.6);
let unread = 0;
window.incoming = async (kind) => {
  unread += 1;
  document.title = '(' + unread + ') WhatsApp';
  if (kind === 'webaudio') {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); o.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.6);
    return 'played';
  }
  try { await new Audio(ding).play(); return 'played'; } catch (e) { return 'error ' + e.message; }
};
window.voice = async (seconds) => { try { await new Audio(wav(seconds)).play(); return 'played'; } catch (e) { return 'error ' + e.message; } };
</script></body></html>`;

app.whenReady().then(async () => {
  const page = new BrowserWindow({ show: true, width: 500, height: 400 });
  const wc = page.webContents;
  await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);

  // 状态：主窗口在不在前台、正开着哪个号、设置、号是不是关了提醒
  const state = { focused: false, activeId: 'a1', settings: { popupSound: true, popupDnd: false, popupSeconds: 6 }, muted: false, calls: false };
  const fakeWin = { isVisible: () => true, isFocused: () => state.focused, isDestroyed: () => false };
  const acc = { id: 'a1', name: '销售 DE' };
  const popup = new PopupWindow({ getWindow: () => fakeWin, account: () => ({ name: acc.name, color: 'blue' }), locked: () => false, settings: () => state.settings, onOpen() {}, onLater() {}, idleSeconds: () => 0 });
  popup.ensureWindow = () => {};
  popup.render = () => {};
  let ours = 0;
  const show = popup.show.bind(popup);
  popup.show = (card) => { const r = show(card); if (popup.pendingSound) { ours += 1; popup.pendingSound = false; popup.lastSound = 0; } return r; };
  let count = 0; // 页面标题里的未读数，对话列表里 Emma 的未读条数跟着涨
  const notifier = new Notifier({
    getAccounts: () => [acc], getWindow: () => fakeWin, activate() {}, quit() {}, popup,
    readChats: async () => [{ name: 'Emma Schneider', unread: count, preview: `Hallo! (${count})` }],
    isMuted: () => state.muted, isActive: (id) => id === state.activeId,
  });
  notifier.refresh = () => {};
  // 和 main.js 的 syncWaSound 一样
  const isActive = () => state.activeId === acc.id;
  const sync = () => waSound.apply(wc, waSound.wantMute({ looking: notifier.looking(isActive()), sound: state.settings.popupSound, dnd: state.settings.popupDnd, muted: state.muted, calls: state.calls }));
  wc.on('audio-state-changed', sync);
  wc.on('page-title-updated', (_e, title) => {
    const m = title.match(/^\((\d+)\)/);
    count = m ? Number(m[1]) : 0;
    notifier.update(acc, count, { isActive: isActive() });
  });

  // 「听到」WhatsApp 的声音：出声的时候没静音
  let heard = 0;
  let sampling = null;
  const listen = () => { let was = false; sampling = setInterval(() => { const now = wc.isCurrentlyAudible() && !wc.isAudioMuted(); if (now && !was) heard += 1; was = now; }, 20); };
  const stop = () => clearInterval(sampling);

  async function message(label, kind = 'audio') {
    sync();
    ours = 0; heard = 0;
    listen();
    const r = await wc.executeJavaScript(`window.incoming(${JSON.stringify(kind)})`);
    await sleep(1500);
    stop();
    if (r !== 'played') check(false, `${label}：页面没放出声（${r}）`);
    return { ours, heard, total: ours + heard };
  }

  let r = await message('没看着');
  check(r.ours === 1 && r.heard === 0, `1. 没看着这个号、弹窗提示音开着：只响 WAswitch 的（WAswitch ${r.ours} 次，WhatsApp ${r.heard} 次）`);
  r = await message('没看着 Web Audio', 'webaudio');
  check(r.ours === 1 && r.heard === 0, `1b. WhatsApp 用 Web Audio 放也一样（WAswitch ${r.ours} 次，WhatsApp ${r.heard} 次）`);
  state.activeId = 'a2'; state.focused = true;
  r = await message('看着别的号');
  check(r.ours === 1 && r.heard === 0, `1c. WAswitch 在前台但开着别的号：只响 WAswitch 的（WAswitch ${r.ours} 次，WhatsApp ${r.heard} 次）`);

  state.activeId = 'a1'; state.focused = true;
  r = await message('看着');
  check(r.ours === 0 && r.heard === 1, `2. 正看着这个号：只响 WhatsApp 的（WAswitch ${r.ours} 次，WhatsApp ${r.heard} 次）`);

  state.focused = false; state.settings.popupSound = false;
  r = await message('弹窗提示音关了');
  check(r.ours === 0 && r.heard === 1, `3. 弹窗提示音关了：只响 WhatsApp 的（WAswitch ${r.ours} 次，WhatsApp ${r.heard} 次）`);

  state.settings.popupSound = true; state.settings.popupDnd = true;
  r = await message('勿扰');
  check(r.total === 0, `4. 勿扰：都不响（WAswitch ${r.ours} 次，WhatsApp ${r.heard} 次）`);

  state.settings.popupDnd = false; state.muted = true;
  r = await message('号不弹通知');
  check(r.total === 0, `5. 号在 WAswitch 里不弹通知：都不响（WAswitch ${r.ours} 次，WhatsApp ${r.heard} 次）`);
  state.muted = false;

  // 6. 正看着这个号听一条 2 秒的语音，听到一半切走
  state.focused = true; sync();
  check(!wc.isAudioMuted(), '6. 看着的时候页面没静音');
  await wc.executeJavaScript('window.voice(2)');
  await sleep(500);
  state.focused = false; sync();
  check(!wc.isAudioMuted() && wc.isCurrentlyAudible(), '6. 语音还在放时切走：先不静音，语音接着放');
  await sleep(2500);
  check(wc.isAudioMuted(), '6. 语音放完：自动静音');
  r = await message('切走以后');
  check(r.ours === 1 && r.heard === 0, `6. 之后来消息只响 WAswitch 的（WAswitch ${r.ours} 次，WhatsApp ${r.heard} 次）`);

  // 7. 回来看这个号：马上不静音（不等）
  state.focused = true; sync();
  check(!wc.isAudioMuted(), '7. 回到这个号：页面马上不静音');

  // 8. 开了允许通话的直连号：没看着也不静音，通话中对方停 3 秒不说话也不会被静音
  state.calls = true; state.focused = false; sync();
  check(!wc.isAudioMuted(), '8. 允许通话的号没看着：不静音（来电铃声能听到）');
  await wc.executeJavaScript(`(() => { const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g).connect(ctx.destination); o.start();
    const t = ctx.currentTime; g.gain.setValueAtTime(1, t); g.gain.setValueAtTime(0, t + 0.5); g.gain.setValueAtTime(1, t + 3.5); o.stop(t + 4.5); return true; })()`);
  await sleep(4000);
  check(!wc.isAudioMuted() && wc.isCurrentlyAudible(), '8. 通话中对方停 3 秒再说话：页面没被静音');
  await sleep(1000);
  state.calls = false;

  console.error(failures ? `wa-sound 自检失败 ${failures} 项` : 'wa-sound 自检全部通过');
  app.exit(failures ? 1 : 0);
});
app.on('window-all-closed', () => {});
