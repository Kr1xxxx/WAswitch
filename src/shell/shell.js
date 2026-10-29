// 软件界面：左侧账号栏、顶栏、右侧卡片里的页面（代理断开提示、编辑账号、设置、首次打开）。
// WhatsApp 页面本身是主进程叠在卡片上面的独立视图，这里不碰它。
// 所有来自用户或账号的数据一律用 textContent 显示，不拼 HTML。

const COLORS = RADIX.ACCOUNT_COLORS; // src/colors/radix.js
const COLOR_NAMES = ['绿色', '紫色', '橙色', '蓝色', '粉色', '灰色'];
// 代理预设：直连 + Clash 本机端口（7891–7893 一直显示，7890–7899 里别的端口开着或被别的号用着才显示）+ 带密码模板
const PORT_DEFAULT = [7891, 7892, 7893];
const PORT_RANGE = [7890, 7891, 7892, 7893, 7894, 7895, 7896, 7897, 7898, 7899];
const portUrl = (port) => `socks5://127.0.0.1:${port}`;
// 本机端口代理的端口号（socks5://127.0.0.1:7891 → { port: 7891, socks: true }），别的地址返回 null
function localProxyPort(raw) {
  const m = /^(socks5|socks4|https?):\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})\/?$/i.exec(String(raw || '').trim());
  return m ? { port: Number(m[2]), socks: m[1].toLowerCase().startsWith('socks') } : null;
}
// 名字太长时截短（完整的放在悬停提示里）
const shortName = (n) => (n.length > 8 ? `${n.slice(0, 7)}…` : n);
const usedText = (names) => `已被「${shortName(names[0])}」${names.length > 1 ? `等 ${names.length} 个号` : ''}使用`;
// 一个端口在预设按钮上的状态：[class, 文字, 悬停说明]
function portStatus(st) {
  if (!st) return ['wait', '检测中…', '正在检测这个端口有没有开'];
  if (st.usedBy.length) return ['used', usedText(st.usedBy), `「${st.usedBy.join('」「')}」已经在用这个端口，两个号会是同一个出口 IP。${st.open ? '' : '（端口现在也没开）'}`];
  if (!st.open) return ['off', '没开', '这个端口现在没开：Clash 没开，或者还没在 Clash 里开这个端口'];
  if (!st.socks) return ['bad', '不能用', '端口被别的程序占着，或者要密码，不能当 socks5 代理用'];
  return ['ok', '能用', '端口开着，可以当代理用。点“测试”看出口 IP'];
}
let liveColor = null; // 编辑页里点了色块、还没保存的颜色（窗口背景先跟着变）

// 固定的图标，不含任何外部数据
const ICONS = {
  panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  reload: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  mute: '<path d="M18 8a6 6 0 0 0-9.3-5M6 8c0 7-3 9-3 9h13M13.7 21a2 2 0 0 1-3.4 0M3 3l18 18"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M8 7h7M8 11h5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  update: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.9-3.9L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.9L21 15"/><path d="M21 20v-5h-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="4" y="8" width="12" height="12" rx="2.5"/><path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/>',
  swap: '<path d="M4 9h15l-4-4M20 15H5l4 4"/>',
  translate: '<path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.6 5.5 7M11 5c-.7 3.4-3 6.4-6.5 8"/><path d="M13 21l4-9 4 9M14.5 18h5"/>',
};

function icon(name, size = 16) {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.style.display = 'flex';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// 复制成功：按钮原地换成绿色小对勾（同位置同大小，缩放+描线动画），约 1.5 秒后变回原样。不弹提示（shen 2026-10-26）
function copyFlash(btn) {
  if (btn._copyTimer) clearTimeout(btn._copyTimer);
  else {
    btn._copyOld = { kids: [...btn.childNodes], title: btn.title, minWidth: btn.style.minWidth, height: btn.style.height };
    btn.style.minWidth = `${btn.offsetWidth}px`;
    btn.style.height = `${btn.offsetHeight}px`;
  }
  const size = btn.classList.contains('dk-tool') ? 18 : 14;
  btn.replaceChildren(icon('check', size));
  btn.title = '已复制';
  btn.classList.remove('copy-back');
  btn.classList.add('copy-ok');
  btn._copyTimer = setTimeout(() => {
    const o = btn._copyOld;
    btn.replaceChildren(...o.kids);
    btn.title = o.title;
    btn.style.minWidth = o.minWidth;
    btn.style.height = o.height;
    btn.classList.remove('copy-ok');
    btn.classList.add('copy-back');
    btn._copyTimer = null;
    btn._copyOld = null;
  }, 1500);
}

// 状态按钮：点了要等结果的按钮，在原位置转圈，再显示 ✓ 或 ✗ 一会儿，然后变回原样。
// 几种状态的文字叠在同一格里，按钮宽度取最宽的那个，切换时不跳。
// 界面经常整块重画，状态记在 morphState[key] 里，重画出来的新按钮照样显示；结束后按 key 找到页面上的按钮更新。
// run() 返回 { ok: true/false }；返回别的（比如没填完就提前 return）直接回到原样。
// labels: { idle, busy, ok?, err? }，没给 ok/err 就不显示那一步。
// 状态由主进程推送决定时传 attrs.busy（true/false）：点了先转圈，之后跟着推送重画
const morphState = {};
const MORPH_HOLD = 1800;
function morphPaint(b) {
  const m = morphState[b.dataset.morph];
  const st = b._busy ? 'busy' : (m && m.st) || 'idle';
  if (b._st && b._st !== st) { b.classList.remove('mb-anim'); void b.offsetWidth; b.classList.add('mb-anim'); }
  b._st = st;
  b.dataset.st = st;
  // 转圈时不用 disabled：disabled 会把键盘焦点丢掉。点击由下面的判断挡住
  b.disabled = b._off;
  b.setAttribute('aria-disabled', String(b._off || st === 'busy'));
  b.setAttribute('aria-busy', String(st === 'busy'));
}
function morphBtn(key, labels, run, attrs = {}) {
  const { disabled, busy, ...rest } = attrs;
  const part = (st, mark, text) => (text ? h('span', { class: `mb-${st}` }, mark, text) : null);
  const b = h('button', { type: 'button', ...rest, class: `${rest.class || 'btn'} morph`, 'data-morph': key, 'aria-live': 'polite' },
    part('idle', null, labels.idle),
    part('busy', h('span', { class: 'mb-spin', 'aria-hidden': 'true' }), labels.busy),
    part('ok', icon('check', 14), labels.ok),
    part('err', icon('x', 14), labels.err));
  b._off = !!disabled;
  b._busy = !!busy;
  if (busy !== undefined) {
    b.addEventListener('click', () => { if (b._busy) return; b._busy = true; morphPaint(b); run(); });
    morphPaint(b);
    return b;
  }
  b.addEventListener('click', async () => {
    const m = morphState[key];
    if ((m && m.st === 'busy') || b._busy) return;
    if (m) clearTimeout(m.timer);
    const set = (st) => {
      morphState[key] = { st };
      document.querySelectorAll(`[data-morph="${CSS.escape(key)}"]`).forEach(morphPaint);
    };
    set('busy');
    let r;
    try { r = await run(); } catch (e) { console.error('[morphBtn]', key, e); r = { ok: false }; }
    const st = r && r.ok === true && labels.ok ? 'ok' : r && r.ok === false && labels.err ? 'err' : 'idle';
    set(st);
    if (st !== 'idle') morphState[key].timer = setTimeout(() => set('idle'), MORPH_HOLD);
  });
  morphPaint(b);
  return b;
}
// key 里带一次性部分（比如编辑页每开一次换一个 editorNonce）时，开新的之前把同前缀的旧状态删掉，morphState 不会越攒越多
function morphDrop(prefix, keep) {
  for (const k of Object.keys(morphState)) if (k.startsWith(prefix) && k !== keep) { clearTimeout(morphState[k].timer); delete morphState[k]; }
}

// 小工具：h('div', { class: 'x', onclick() {} }, '文字', 子元素...)
// 几段并排的短文字，用间距隔开，不用中点（shen 2026-10-28）。样式 .seg 在 shell.css
function segs(...xs) {
  return xs.filter((x) => x !== null && x !== undefined && x !== false && x !== '').map((x) => h('span', { class: 'seg' }, x));
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val; }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// 报错的原话（英文错误码、服务商原话）收在“详细信息”里，平时不占地方，排查时点开看。
// 界面经常整块重画，点开过的记下来，重画后还是开着
const rawOpen = new Set();
function rawDetail(text) {
  if (!text) return null;
  const el = h('details', { class: 'err-raw', open: rawOpen.has(text) }, h('summary', null, '详细信息'), h('code', null, text));
  el.addEventListener('toggle', () => { if (el.open) rawOpen.add(text); else rawOpen.delete(text); if (rawOpen.size > 50) rawOpen.clear(); });
  return el;
}

// ---------- 过渡动画 ----------
// 界面每次状态变化都整块重画，CSS transition 接不上。这里按“槽位”记住上次的值，值真的变了才给新元素放一次动画。
// 动画只用 opacity/transform，时长在 src/tokens.css 的 --fx 里统一改；系统开了“减少动态效果”就不动
const fxLast = new Map();
function fxChanged(slot, key, first = true) {
  const had = fxLast.has(slot);
  const prev = fxLast.get(slot);
  if (fxLast.size > 3000) fxLast.clear();
  fxLast.set(slot, key);
  return had ? prev !== key : first;
}
// 给元素放一次动画；同一个元素再放时先摘掉 class 重排一下，才能重新开始
function fxPlay(el, cls = 'fx-in') {
  if (!el || !el.classList) return el;
  if (el.classList.contains(cls)) { el.classList.remove(cls); void el.offsetWidth; }
  el.classList.add(cls);
  return el;
}
function fx(slot, key, el, cls = 'fx-in', first = true) {
  if (el && fxChanged(slot, key, first)) fxPlay(el, cls);
  return el;
}
const fxReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// 去掉条件不成立时留下的 null，避免 append 把它当成文字 "null"
const kids = (...xs) => xs.flat().filter((x) => x !== null && x !== undefined && x !== false);

const $side = document.getElementById('side');
const $top = document.getElementById('topbar');
const $ai = document.getElementById('aibar');
const $content = document.getElementById('content');
const $lock = document.getElementById('lock');
const $panel = document.getElementById('panel');
let s = null; // 主进程推过来的状态
let shown = ''; // 当前卡片里画的是哪个页面，用来决定是否重画
let settingsTab = 'quick'; // 打开设置先看到「快捷设置」
let checkResult = null;
let checkRunning = false;
// 跑一次隔离自检（自检页和快捷设置共用，结果也共用）
let checkAutoRan = false;
async function runCheckNow() {
  checkRunning = true; render(true);
  try { checkResult = await window.wa.runCheck(); } finally { checkRunning = false; render(true); }
}
// 团队页：登记表单里填的内容（状态推送会重画页面，值存在这里不丢）
const teamForm = { server: '', code: '', deviceName: '', picked: null, consent: false, busy: false, result: '', detail: '', showUpload: false };
// 缓存大小：进入“内存”设置时查一次（30 秒内不重复查）
let cacheInfo = { mb: null, at: 0, busy: false, result: '' };
let memClean = { busy: false, result: '' };
// 立即清理内存（内存页和快捷设置共用）
async function runMemClean() {
  memClean.busy = true; memClean.result = ''; render(true);
  const r = await window.wa.memClean();
  memClean.busy = false;
  if (r.error) memClean.result = r.error;
  else {
    const skip = r.skipped ? `${r.skipped} 个有未读、刚切走或正在加载/下载的跳过了。` : '';
    if (r.recycled) memClean.result = `已刷新 ${r.recycled} 个后台账号，预计省下约 ${mb(r.savedMB)}，一分钟内占用数字会更新。${skip}`;
    else if (r.skipped) memClean.result = `这次没有刷新。${skip}`;
    else memClean.result = '后台账号都刚刷新过或占用不大，不用清理。';
  }
  render(true);
  return { ok: !r.error };
}
const memCleanBtn = (cls) => morphBtn('memClean', { idle: '立即清理', busy: '清理中', ok: '完成', err: '失败' }, runMemClean, { class: cls, disabled: !s.accounts.length });
function refreshCacheSize() {
  if (cacheInfo.busy || Date.now() - cacheInfo.at < 30000) return;
  cacheInfo.at = Date.now();
  window.wa.cacheSize().then((r) => { cacheInfo.mb = Math.round(r.bytes / 1048576); render(true); }, () => {});
}

const active = () => (s.accounts || []).find((a) => a.id === s.activeId);
const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);

// 账号头像：打包的 emoji 图（src/emoji），Mac 和 Windows 显示一样。没有 emoji 的（不该出现）退回名字第一个字
function emojiImg(a, size) {
  const e = a && window.EMOJI ? window.EMOJI.get(a.emoji) : null;
  return e ? h('img', { class: 'emo', src: `../emoji/svg/${e.id}.svg`, alt: '', width: size, height: size, draggable: 'false' }) : null;
}
function avatarOf(a, extra = '') {
  const img = emojiImg(a, 24);
  return h('span', { class: `avatar${img ? ' emoji' : ''}${extra}`, style: img ? null : { background: a.color } }, img || a.name.trim().charAt(0) || '?');
}
// 列表里名字前面的小图标（以前是颜色小方块）
const mini = (a) => emojiImg(a, 16) || h('span', { class: 'sw', style: { background: a ? a.color : 'var(--slate-7)' } });

function tint(color) {
  // 窗口底色 = 账号同色系的 3 号（Radix 的浅底色），没有账号时用 slate 3
  return `var(--${RADIX.accountFamily(color)}-3)`;
}

// ---------- 侧栏 ----------

// 拖动排序：拖的过程中不重画侧栏（重画会打断拖动），松手后再画
let dragId = null;
let sideStale = false;
function dropOn(el, groupId, beforeId) {
  el.addEventListener('dragover', (e) => {
    if (!dragId || dragId === beforeId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop');
    const id = dragId;
    dragId = null;
    if (id && id !== beforeId) window.wa.moveAccount(id, groupId, beforeId || '');
  });
}
function draggable(el, id) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    dragId = null;
    el.classList.remove('dragging');
    if (sideStale) { sideStale = false; renderSide(); }
  });
}

function accountRow(acc) {
  const on = acc.id === s.activeId && s.page === 'account';
  // 自己关了通知，或者所在分组整组关了，都显示成灰色
  const quiet = acc.muted || acc.groupMuted;
  // 开了“同步到 CRM”的号：头像外圈蓝色、名字旁边 CRM 标记，侧栏收起时也看得到
  const avatar = avatarOf(acc, acc.crm ? ' crm' : '');
  // 从没登录过的号停在二维码页是正常的第一步：灰色“等待扫码”，不标红
  const waiting = acc.needsQr && !acc.everLoggedIn && !acc.problem;
  const lost = acc.needsQr && !waiting;
  if (acc.problem || lost) avatar.append(h('span', { class: 'dot bad' }, '!'));
  else if (s.collapsed && acc.unread) avatar.append(h('span', { class: `dot${quiet ? ' quiet' : ''}` }, acc.unread > 9 ? '9+' : acc.unread));
  const via = acc.mode === 'lite' ? `轻量模式，${acc.proxyLabel}` : acc.proxyLabel;
  const tip = [acc.name, s.locked ? '' : acc.phone, via, acc.crm ? '这个号的单聊文字正在同步到公司 CRM' : '', acc.note, acc.unread ? `${acc.unread} 个未读对话` : '', acc.problem, waiting ? '等待扫码登录' : lost ? '需要扫码登录' : ''].filter(Boolean).join('\n');
  // 名字下面一行：有问题时写问题，平时写这个号登录的手机号（连接方式在悬停提示里）。锁着时不露手机号
  const sub = acc.problem ? acc.problemShort : waiting ? '等待扫码' : lost ? '需要扫码登录' : acc.primaryClash ? '和主号同一个 IP' : acc.exitChange ? '出口 IP 变了' : s.locked ? '' : acc.phone;
  const row = h('button', {
    class: `row${on ? ' on' : ''}`, title: tip, 'aria-current': on ? 'true' : null,
    onclick: () => window.wa.switchTo(acc.id),
    oncontextmenu: (e) => { e.preventDefault(); window.wa.context(acc.id); },
  },
  avatar,
  h('span', { class: 'meta' },
    h('span', { class: 'name' }, h('span', { class: 'name-text' }, acc.name), acc.crm ? h('span', { class: 'crm-tag', title: '这个号的单聊文字正在同步到公司 CRM' }, 'CRM') : null),
    sub ? h('span', { class: `sub${acc.problem || lost ? ' bad' : acc.primaryClash || acc.exitChange ? ' warn' : ''}` }, sub) : null),
  quiet ? h('span', { class: 'mute', title: acc.muted ? '不弹通知' : '所在分组整组不弹通知', style: { color: 'var(--slate-11)' } }, icon('mute', 13)) : null,
  acc.unread ? h('span', { class: `pill${quiet ? ' quiet' : ''}` }, acc.unread) : null);
  draggable(row, acc.id);
  dropOn(row, acc.groupId || '', acc.id);
  return row;
}

// 分组的组头：点一下折叠/展开，右键改名、整组静音、解散；把号拖到组头上就放进这个组的最后
// 没放进分组的号排在最前面，不加组头
function groupHead(g) {
  if (s.editGroupId === g.id && !s.collapsed) {
    let done = false;
    const commit = (name) => { if (done) return; done = true; window.wa.groupRename(g.id, name); };
    const input = h('input', {
      class: 'group-name', value: g.name, maxlength: '20', 'aria-label': '分组名称',
      onkeydown: (e) => {
        if (e.isComposing || e.keyCode === 229) return; // 输入法还在选字，这个回车是上屏，不算改完
        if (e.key === 'Enter') commit(input.value);
        if (e.key === 'Escape') commit(g.name);
      },
      onblur: () => commit(input.value),
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return h('div', { class: 'group-head editing' }, icon('down', 12), input);
  }
  // 箭头一直是朝下的那个，折起来转 -90°（不放动画）
  const chev = icon('down', 12);
  chev.classList.add('gchev');
  const head = h('button', {
    class: `group-head${g.collapsed ? ' closed' : ''}`,
    title: `${g.name}：${g.count} 个号${g.muted ? '，整组不弹通知' : ''}${g.collapsed ? '（已折叠，点开）' : ''}\n右键：改名、整组不弹通知、解散`,
    'aria-expanded': String(!g.collapsed),
    onclick: () => window.wa.groupToggle(g.id),
    oncontextmenu: (e) => { e.preventDefault(); window.wa.groupContext(g.id); },
  },
  chev,
  h('span', { class: 'gname' }, g.collapsed ? segs(g.name, h('span', { class: 'count' }, g.count)) : g.name),
  g.muted ? h('span', { class: 'mute', title: '整组不弹通知' }, icon('mute', 12)) : null,
  g.collapsed && g.unread ? h('span', { class: `pill${g.muted ? ' quiet' : ''}` }, g.unread) : null);
  dropOn(head, g.id, null);
  return head;
}

// 侧栏「账号」旁的 + 号：弹出菜单选添加账号还是添加分组（菜单在主进程里弹，和右键菜单一样）
function addBtn() {
  const on = s.page === 'editor' && !s.editorId;
  return h('button', {
    class: `icon-btn add-btn${on ? ' on' : ''}`, title: '添加', 'aria-label': '添加', 'aria-haspopup': 'menu',
    onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); window.wa.addMenu(Math.round(r.left), Math.round(r.bottom + 4)); },
  }, icon('plus', 14));
}

// 「账号」那一行：把号拖到这里就移出分组，放到最前面那段的最后（没放进分组的号一个都不剩时也能拖回来）
function sideLabel() {
  const el = h('div', { class: 'label side-label' }, s.collapsed ? null : h('span', null, ...segs('账号', h('span', { class: 'count' }, s.accounts.length))), addBtn());
  if ((s.groups || []).length) dropOn(el, '', null);
  return el;
}

// 账号列表：没放进分组的号排在最前面（不加组头），再按组排
function accountList() {
  const groups = s.groups || [];
  if (!groups.length) return s.accounts.map(accountRow);
  const out = s.accounts.filter((a) => !a.groupId).map(accountRow);
  for (const g of groups) {
    out.push(groupHead(g));
    // 折叠的组只藏起侧栏里的行（页面照常开着、照常收消息）；正在看的那个号仍然露出来
    const rows = s.accounts.filter((a) => a.groupId === g.id && (!g.collapsed || (a.id === s.activeId && s.page === 'account'))).map(accountRow);
    out.push(...rows);
  }
  return out;
}

function renderSide() {
  if (dragId) { sideStale = true; return; }
  // 正在给分组改名：不重画，免得输入框被换掉
  const editing = document.activeElement && document.activeElement.classList.contains('group-name');
  if (editing && s.editGroupId) return;
  const mac = s.platform === 'darwin';
  $side.replaceChildren();
  $side.append(h('div', { class: 'win-drag' }));
  if (s.page === 'settings') {
    $side.append(
      h('button', { class: 'back', onclick: () => window.wa.showPage('account') }, icon('back', 14), '返回账号'),
      h('div', { class: 'list' }, settingsGroups().map(([title, tabs], i) => [
        i ? h('div', { class: 'tab-group' }, title) : null,
        ...tabs.map(([id, label]) =>
          h('button', { class: `tab${settingsTab === id ? ' on' : ''}`, onclick: () => { settingsTab = id; trSay = ''; render(true); } }, label,
            id === 'about' && updateReady() ? h('span', { class: 'tab-dot', title: '有新版本' }) : null))]).flat()));
    return;
  }
  const label = s.collapsed ? '展开侧栏' : '收起侧栏';
  $side.append(...kids(
    h('div', { class: 'head' },
      s.collapsed ? null : h('span', { class: 'brand' }, 'WAswitch'),
      h('button', { class: 'icon-btn', title: label, 'aria-label': label, onclick: () => window.wa.toggleCollapse() }, icon('panel'))),
    sideLabel(),
    h('div', { class: 'list' }, accountList()),
    s.collapsed ? null : h('div', { class: 'label side-tools' }, '工具'),
    h('button', { class: `row tool-row${s.page === 'translate' ? ' on' : ''}`, title: '翻译', 'aria-label': '翻译', 'aria-current': s.page === 'translate' ? 'page' : null, onclick: () => window.wa.showPage('translate') },
      h('span', { class: 'avatar tool' }, icon('translate', 16)), s.collapsed ? null : h('span', { class: 'name' }, '翻译')),
    h('div', { class: 'grow' })));
  const upd = updateCard();
  if (upd) $side.append(upd);
  // 内存卡平时不占位置：设了总上限、用到八成以上才出现（到八成黄，超过上限红）
  const memLevel = sideMemLevel();
  if (memLevel) {
    const total = s.accounts.reduce((n, a) => n + (a.memMB || 0), 0) || 1;
    $side.append(h('div', { class: `membox ${memLevel}`, title: `近似值：只统计每个账号的主页面进程\n上限 ${mb(s.settings.capMB)}` },
      h('div', { class: 'top' }, h('span', null, '内存'), h('b', null, mb(s.totalMB))),
      h('div', { class: 'bars' }, s.accounts.map((a) => h('span', { style: { width: `${((a.memMB || 0) / total) * 100}%`, background: a.color } })))));
  }
  const totalUnread = s.accounts.reduce((n, a) => n + (a.unread || 0), 0);
  const bell = h('button', { class: `icon-btn bell${s.page === 'overview' ? ' on' : ''}`, title: `未读总览和通知记录${totalUnread ? `\n共 ${totalUnread} 个未读对话` : ''}`, 'aria-label': '未读总览', onclick: () => window.wa.showPage('overview') }, icon('bell', 17));
  if (totalUnread) bell.append(h('span', { class: 'dot' }, totalUnread > 99 ? '99+' : totalUnread));
  $side.append(h('div', { class: 'foot' },
    h('button', { class: 'icon-btn', title: updateReady() ? `设置\n新版本 ${s.update.version} 已就绪` : '设置', 'aria-label': '设置', onclick: () => { settingsTab = 'quick'; window.wa.showPage('settings'); render(true); } }, icon('gear', 17),
      updateReady() ? h('span', { class: 'dot new', 'aria-hidden': 'true' }) : null),
    s.settings?.showUpdateButton ? checkUpdateBtn() : null,
    bell));
  document.body.classList.toggle('mac', mac);
}

// 侧栏内存卡：'' 不显示，'warn' 用到总上限的八成，'bad' 超过上限
function sideMemLevel() {
  const st = s.settings || {};
  const used = s.totalMB || 0;
  if (!s.accounts.length || !used || st.autoRecycle === false || !(st.capMB > 0)) return '';
  return used > st.capMB ? 'bad' : used >= st.capMB * 0.8 ? 'warn' : '';
}

// 侧栏底部的“检查更新”按钮（设置里打开才显示）：点了只是立刻检查一次，下载和安装照旧走更新卡片
function checkUpdateBtn() {
  const u = s.update;
  const st = u ? u.status : 'dev';
  const busy = st === 'checking' || st === 'downloading';
  const title = {
    dev: '检查更新\n开发版不检查更新',
    off: '检查更新\n这种安装方式不能自动更新',
    checking: '正在检查更新…',
    downloading: `正在下载 ${u && u.version}`,
    downloaded: `新版本 ${u && u.version} 已就绪`,
    none: '检查更新\n已是最新版本',
    error: '检查更新\n上次没检查成功',
  }[st] || '检查更新';
  return h('button', { class: `icon-btn upd-check${busy ? ' busy' : ''}`, title, 'aria-label': '检查更新', disabled: st === 'dev' || st === 'off',
    onclick: () => { if (st === 'downloaded') { settingsTab = 'about'; window.wa.showPage('settings'); } else if (!busy) window.wa.updateCheckOnly(); } }, icon('sync', 16));
}

// ---------- 侧栏里的更新提示 ----------
// 下载中显示进度，下载好显示“重启更新”。点“稍后”只在这次运行里藏起这个版本的提示（关于页和设置图标上的小点还在）
let updateHidden = '';
const updateReady = () => !!(s.update && s.update.status === 'downloaded');
// 设置侧栏分组：最上面是快捷设置（不带分组标题），常用设置在前，诊断和其他在后。
// 团队页只在登记过后台后常驻；没登记时从「关于 › 加入团队…」点进去才临时出现。
function settingsGroups() {
  const showTeam = (s.team && s.team.joined) || settingsTab === 'team';
  return [
    ['', [['quick', '快捷设置']]],
    ['分项设置', [['general', '通用'], ['translate', '翻译'], ['notify', '通知'], ['memory', '内存']]],
    ['诊断', [['check', '隔离自检'], ['net', '连接记录']]],
    ['其他', [showTeam ? ['team', '团队'] : null, ['mcp', 'AI 接口'], ['about', '关于']].filter(Boolean)],
  ];
}

function openAbout() { settingsTab = 'about'; window.wa.showPage('settings'); render(true); }
function updateCard() {
  const u = s.update;
  if (!u || s.collapsed || !['downloading', 'downloaded'].includes(u.status)) return null;
  if (u.status === 'downloaded' && updateHidden === u.version) return null;
  if (u.status === 'downloading') {
    return h('button', { class: 'updcard busy', title: u.userAsked ? '下载完，等你 30 秒没打字就自动重启并安装' : '下载好后会提示你；也可以在 设置 › 关于 里看', onclick: openAbout },
      h('div', { class: 'top' }, h('span', { class: 'updicon' }, icon('update', 13)), h('span', { class: 'grow' }, `正在下载 ${u.version}`), h('b', null, `${u.percent}%`)),
      h('div', { class: 'progress thin' }, h('span', { style: { width: `${u.percent}%` } })));
  }
  return h('div', { class: 'updcard ready', role: 'status' },
    h('div', { class: 'top' }, h('span', { class: 'updicon' }, icon('update', 13)), h('b', { class: 'grow' }, `新版本 ${u.version} 已就绪`)),
    h('small', null, u.manual ? '打开后把新的 WAswitch 拖进“应用程序”替换旧版。'
      : u.waitReason ? `你停手 30 秒后会自动重启（现在${u.waitReason}）。账号和聊天记录都在。` : '重启后生效，账号和聊天记录都在。'),
    h('div', { class: 'updbtns' },
      h('button', { class: 'later', onclick: () => { updateHidden = u.version; if (u.waitReason) window.wa.updateLater(); render(); } }, '稍后'),
      h('button', { class: 'go', onclick: () => window.wa.updateInstall() }, u.manual ? '打开安装包' : '重启更新')));
}

// ---------- 顶栏 ----------

// 鼠标停在线路上：出口 IP 和上次测到的时间
function exitTitle(acc) {
  if (acc.direct) return acc.mode === 'lite' ? '网络线路：直连（这台电脑的真实 IP）' : '网络线路：直连（跟随电脑的系统代理）';
  if (!acc.exitIp) return '网络线路。还没测过出口 IP，可以在编辑里点“测试”，或跑一次隔离自检';
  const at = acc.exitAt ? `（上次测到：${new Date(acc.exitAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）` : '';
  const lat = acc.latency ? `\n最近一次检测用时 ${acc.latency.ms} ms（设置 › 连接记录 里有掉线和延迟记录）` : '';
  return `网络线路：出口 IP ${acc.exitIp}${at}${lat}`;
}

// 线路：出口 IP 直接显示；巡检发现 IP 变了就标黄，点一下表示知道了
function exitChip(acc) {
  if (acc.problem) return h('span', { class: 'chip exit bad', title: exitTitle(acc) }, icon('globe', 12), h('span', null, acc.problemShort));
  // 换主号后后台比对发现这个轻量小号和主号出口相同：标黄，换个代理端口或节点后消失
  if (acc.primaryClash) return h('span', { class: 'chip exit night', title: `和主号的出口 IP 相同：${acc.primaryClash}。请在编辑账号里换一个代理端口或节点。` }, icon('globe', 12), h('span', null, `和主号同一个 IP ${acc.primaryClash}`));
  const ch = acc.exitChange;
  if (ch) {
    const when = new Date(ch.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const moved = ch.fromLabel && ch.toLabel && ch.fromLabel !== ch.toLabel;
    return h('button', {
      class: 'chip exit night', type: 'button',
      title: `${when} 巡检发现出口 IP 变了：${ch.from} → ${ch.to}${moved ? `（${ch.fromLabel} → ${ch.toLabel}，国家也变了，时区可能对不上，建议跑一次隔离自检）` : ''}。机场节点常会自动换 IP，频繁变化容易被 WhatsApp 当成异常。点一下表示知道了。`,
      onclick: () => window.wa.exitAck(acc.id),
    }, icon('globe', 12), h('span', null, ...segs(`出口 IP 变了${moved ? `（${ch.toLabel}）` : ''}`, ch.to)));
  }
  return h('span', { class: 'chip exit', title: exitTitle(acc) }, icon('globe', 12), h('span', null, ...(acc.exitIp && !acc.direct ? segs(acc.proxyLabel, acc.exitIp) : [acc.proxyLabel])));
}

// 当地时间：按账号的时区显示，22:00–8:00 变黄，提醒这时候发消息不像真人。5:00 前写“深夜”，5:00–8:00 写“清晨”
const clockFormats = new Map();
function clockParts(tz) {
  const key = tz || '';
  if (!clockFormats.has(key)) {
    clockFormats.set(key, new Intl.DateTimeFormat('zh-CN', { ...(tz ? { timeZone: tz } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  const parts = Object.fromEntries(clockFormats.get(key).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  const night = hour >= 22 || hour < 8;
  return { text: `${parts.hour}:${parts.minute}`, night, when: night ? (hour >= 5 && hour < 8 ? '清晨' : '深夜') : '' };
}
// 当前对话的客户在哪个时区（主进程按客户号码算好推过来，不带号码）：{ accountId, zone: { tz, place, approx } | null }
let peer = null;
// 认不出客户（群聊、查不到号码）时，同时显示伦敦、纽约、加州的时间（客户在欧美，不显示本机时间，shen 2026-10-27）
const DEFAULT_ZONES = [{ tz: 'Europe/London', place: '伦敦' }, { tz: 'America/New_York', place: '纽约' }, { tz: 'America/Los_Angeles', place: '加州' }];
function clockChip(acc) {
  const chip = h('span', { class: 'chip clock' }, icon('clock', 12), h('span'));
  const draw = () => {
    // 认得出客户号码：显示客户当地时间；认不出：显示伦敦、纽约、加州时间
    const z = peer && peer.accountId === acc.id ? peer.zone : null;
    if (z) {
      const c = clockParts(z.tz);
      chip.lastChild.replaceChildren(...segs(`客户 ${z.approx ? '约 ' : ''}${z.place} ${c.text}`, c.night ? c.when : null));
      chip.classList.toggle('night', c.night);
      chip.classList.add('peer');
      chip.title = `客户当地时间（按客户号码的国家码和区号推算：${z.tz}）${z.approx ? '。这个国家有好几个时区，号码看不出具体在哪，按主要时区显示，仅供参考' : ''}${c.night ? `。客户那边现在是${c.when}，这时候发消息容易打扰客户` : ''}`;
      return;
    }
    // 只写城市和时间，不写星期（设计复查第 2 条）：“伦敦 16:44  纽约 11:44  加州 08:44”
    const zones = DEFAULT_ZONES.map((d) => ({ ...d, ...clockParts(d.tz) }));
    chip.lastChild.replaceChildren(...segs(...zones.map((x) => `${x.place} ${x.text}`)));
    const night = zones.every((x) => x.night); // 几个地方都是深夜 / 清晨才标黄
    chip.classList.toggle('night', night);
    chip.classList.remove('peer');
    const own = acc.timezone ? `。这个号的出口时区是 ${acc.timezone}，现在 ${clockParts(acc.timezone).text}` : '';
    chip.title = `${zones.map((x) => `${x.place}（${x.tz}）`).join('、')}的时间，认不出客户时默认显示。打开有号码的私聊时，这里会换成客户的当地时间${night ? '。这几个地方现在都是休息时间' : ''}${own}`;
  };
  draw();
  chip.draw = () => { draw(); fitTop(); };
  return chip;
}
window.wa.onPeerZone((z) => {
  peer = z && typeof z === 'object' ? z : null;
  const c = $top.querySelector('.chip.clock');
  if (c && c.draw) c.draw();
});
// 每 20 秒只刷新时钟文字，不重画整个顶栏
setInterval(() => {
  if ($top.hidden || document.hidden) return;
  const c = $top.querySelector('.chip.clock');
  if (c && c.draw) c.draw();
}, 20000);

// 顶栏放不下时按优先级整块藏起来，不出现省略号（设计复查第 2 条）。
// data-fit 小的先藏：备注 → 线路 → 时钟 → 有问题的线路。账号名和右边三个按钮一直留着
function fitTop() {
  if ($top.hidden) return;
  const items = [...$top.querySelectorAll('[data-fit]')].sort((x, y) => x.dataset.fit - y.dataset.fit);
  items.forEach((el) => el.classList.remove('fit-off'));
  $top.classList.add('fitting');
  for (const el of items) {
    if ($top.scrollWidth <= $top.clientWidth) break;
    el.classList.add('fit-off');
  }
  $top.classList.remove('fitting');
}
// 顶栏按自己的宽度重排，不看窗口：拖窗口、收起展开侧栏，宽度一变就重新藏放
let topW = 0;
new ResizeObserver(([e]) => {
  const w = Math.round(e.contentRect.width);
  if (w && w !== topW) { topW = w; fitTop(); }
}).observe($top);

function renderTop() {
  const acc = active();
  $top.hidden = !(s.page === 'account' && acc);
  if ($top.hidden) return;
  // 锁着时顶栏留空：账号名、出口 IP、内存这些都不露出来；「聊天已锁定」只在中间的锁屏卡片上写一次
  if (s.locked) { $top.replaceChildren(); return; }
  const lite = acc.mode === 'lite';
  // 缩放和内存在右边“⋯”菜单里（设计复查第 2 条）
  const exit = exitChip(acc);
  exit.dataset.fit = acc.problem || exit.classList.contains('night') ? 4 : 2;
  const clock = clockChip(acc);
  clock.dataset.fit = 3;
  $top.replaceChildren(...kids(
    emojiImg(acc, 16), h('span', { class: 'who', title: acc.note || null }, acc.name),
    acc.note ? h('span', { class: 'who-note', 'data-fit': 1 }, acc.note) : null,
    h('span', { class: 'grow' }),
    exit,
    clock,
    // 右边三个按钮放成一组：刷新、工作台、账号菜单（shen 2026-10-27 把刷新挪到最前）
    h('span', { class: 'top-acts' },
      h('button', { class: 'icon-btn', title: lite ? '重新连接' : '刷新', 'aria-label': lite ? '重新连接' : '刷新', onclick: () => window.wa.reload(acc.id) }, icon('reload', 15)),
      h('button', { class: `icon-btn${s.panelOpen ? ' on' : ''}`, title: `工作台：客户资料、话术、翻译（${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + Shift + K）`, 'aria-label': '工作台', 'aria-pressed': String(!!s.panelOpen), onclick: () => window.wa.panelToggle() }, icon('book', 15)),
      h('button', { class: 'icon-btn', title: '账号菜单（右键账号也可以打开）', 'aria-label': '账号菜单', onclick: () => window.wa.context(acc.id, 'top') }, icon('more', 15)))));
  fitTop();
}

// 右侧工作台顶部的切页：客户资料 / 话术 / 翻译（翻译有未读数）。翻译页时右边是自动翻译开关；
// 没有收起按钮了（shen 2026-10-27），收起用顶栏的“工作台”按钮或 Ctrl/Cmd + Shift + K
function panelHead() {
  const tab = (id, label, ic) => {
    const on = s.panelTab === id;
    const badge = id === 'translate' && !on && dk.unread > 0 ? h('span', { class: 'tb-badge', 'aria-label': `${dk.unread} 条新消息` }, dk.unread > 99 ? '99+' : String(dk.unread)) : null;
    return h('button', { class: `tb-tab${on ? ' on' : ''}`, role: 'tab', 'aria-selected': String(on), onclick: () => { if (!on) window.wa.panelTab(id); } }, ic ? icon(ic, 15) : null, label, badge);
  };
  return h('div', { class: 'wb-tabs', role: 'tablist', 'aria-label': '工作台' },
    tab('customers', '客户资料'), tab('replies', '话术'), tab('translate', '翻译', 'translate'),
    h('span', { class: 'grow' }),
    s.panelTab === 'translate' ? dockTabTools() : null);
}
function refreshPanelHead() {
  const old = $panel.querySelector('.wb-tabs');
  if (old) old.replaceWith(panelHead());
}

// AI（MCP 客户端）想切换账号或打开添加页，但用户正在打字：问一下，不直接切
function renderAi() {
  const r = s.aiRequest;
  $ai.hidden = !r;
  if (!r) return;
  if (r.kind === 'draft') {
    // AI 起草了一条回复：给用户看开头，点“放进输入框”才放，发送永远自己按
    const what = r.locked ? 'AI 起草了一条回复（解锁后查看）'
      : r.note ? r.note
      : `AI 给「${r.name}」的「${r.chat}」起草了回复：${r.preview}`;
    $ai.replaceChildren(
      h('span', { class: `grow${r.note ? ' bad' : ''}`, title: r.locked ? null : `${r.chat}：${r.preview}` }, what),
      h('button', { class: 'btn', onclick: () => window.wa.aiAnswer(false) }, '忽略'),
      r.locked ? null : h('button', { class: 'btn primary', title: '放进输入框，不会发送，发送自己按', onclick: () => window.wa.aiAnswer(true) }, '放进输入框'));
    return;
  }
  if (r.kind === 'open') {
    // AI 想打开和某个号码的对话。网页版输入框里有没发的字时提醒会刷新页面
    const who = r.phone ? `和 ${r.phone} 的对话` : '一个对话（解锁后查看号码）';
    $ai.replaceChildren(
      h('span', { class: `grow${r.warn ? ' bad' : ''}` }, `AI 想在「${r.name}」里打开${who}${r.warn ? '。要刷新这个号的页面，输入框里没发的字可能会丢' : ''}`),
      h('button', { class: 'btn', onclick: () => window.wa.aiAnswer(false) }, '忽略'),
      h('button', { class: 'btn primary', onclick: () => window.wa.aiAnswer(true) }, '打开'));
    return;
  }
  const what = r.kind === 'add'
    ? (r.name ? `AI 想打开“添加账号”（预填「${r.name}」）` : 'AI 想打开“添加账号”')
    : `AI 想切到「${r.name}」`;
  $ai.replaceChildren(
    h('span', { class: 'grow' }, what),
    h('button', { class: 'btn', onclick: () => window.wa.aiAnswer(false) }, '忽略'),
    h('button', { class: 'btn primary', onclick: () => window.wa.aiAnswer(true) }, r.kind === 'add' ? '打开' : '切换'));
}

// 删除、清空、解散分组不先问，直接做，然后在旁边给几秒“撤销”（主进程发来 undo:offer）。
// 放在用户刚才操作的地方，而且不能被 WhatsApp 页面盖住：panel 右侧面板列表底部；
// 账号页的其他操作（侧栏解散分组）放顶栏；其他页面（设置、未读总览）放内容区底部。再删别的，换成新的这一条
const UNDO_SHOW_MS = 8000;
const UNDO_MAX_MS = 14000; // 主进程 15 秒后就不认了：鼠标停在上面也最多留这么久
let undoBox = null;
let undoTimer = null;
let undoCap = null;
let undoGone = null;
function hideUndo() {
  clearTimeout(undoTimer);
  clearTimeout(undoCap);
  undoTimer = null;
  undoCap = null;
  if (undoBox) undoBox.remove();
  undoBox = null;
  const g = undoGone;
  undoGone = null;
  if (g) g();
}
function undoRect(where) {
  const visible = (el) => el && !el.hidden && el.getBoundingClientRect().width > 0;
  const panel = document.getElementById('panel');
  const list = panel && panel.querySelector('.pn-list');
  if (where === 'panel' && visible(panel)) return { r: (visible(list) ? list : panel).getBoundingClientRect(), at: 'bottom' };
  const hist = document.querySelector('.tp-hist');
  if (where === 'tp-hist' && s.page === 'translate' && visible(hist)) return { r: hist.getBoundingClientRect(), at: 'middle' };
  if (s.page === 'account' && visible($top)) return { r: $top.getBoundingClientRect(), at: 'middle' };
  return { r: document.getElementById('body').getBoundingClientRect(), at: 'bottom' };
}
function placeUndo() {
  if (!undoBox) return;
  const { r, at } = undoRect(undoBox.dataset.where);
  const w = Math.max(0, r.width - 16);
  Object.assign(undoBox.style, { left: `${r.left + r.width / 2}px`, maxWidth: `${w}px` });
  if (at === 'middle') Object.assign(undoBox.style, { top: `${r.top + r.height / 2}px`, bottom: '', transform: 'translate(-50%, -50%)' });
  else Object.assign(undoBox.style, { top: '', bottom: `${window.innerHeight - r.bottom + 12}px`, transform: 'translateX(-50%)' });
}
async function runUndo(o) {
  hideUndo();
  let ok = false;
  try { ok = await window.wa.undo(o.token); } catch {}
  if (!ok) return;
  if (o.kind === 'panel') { try { pn.data = await window.wa.panelData(); } catch {} renderPanel(true); }
  else if (o.kind === 'tr') { try { const r = await window.wa.trConfig(); tr.cfg = r.config; tr.modes = r.modes; } catch {} render(true); }
  else if (o.kind === 'notif') loadNotifLog();
  else if (o.kind === 'netlog') loadNetLog();
}
// 也给只存在界面里的东西用（翻译页的最近记录）：onUndo 自己放回去，onGone 在撤销条没点就消失时调用
function showUndo(text, where, onUndo, onGone) {
  hideUndo();
  undoGone = onGone || null;
  const btn = h('button', { class: 'undo-btn', type: 'button', onclick: () => { undoGone = null; hideUndo(); onUndo(); } }, '撤销');
  undoBox = h('div', { class: 'undo', role: 'status', 'data-where': where || 'body' }, h('span', { class: 'undo-text' }, String(text || '')), btn);
  // 鼠标停在上面时不消失
  const arm = () => { clearTimeout(undoTimer); undoTimer = setTimeout(hideUndo, UNDO_SHOW_MS); };
  undoBox.addEventListener('mouseenter', () => clearTimeout(undoTimer));
  undoBox.addEventListener('mouseleave', arm);
  document.body.append(undoBox);
  placeUndo();
  arm();
  undoCap = setTimeout(hideUndo, UNDO_MAX_MS);
}
window.wa.onUndoOffer((o) => {
  if (!o || !Number.isInteger(o.token)) return;
  showUndo(o.text, o.where, () => runUndo(o));
});
window.addEventListener('resize', placeUndo);

// ---------- 卡片里的页面 ----------

const RELEASES = 'https://github.com/Kr1xxxx/WAswitch/releases';

// 按出错的类型配按钮：重连没用的情况不给“重新连接”，直连号不提代理和 Clash
function problemButtons(acc) {
  const btn = (text, onclick, primary) => h('button', { class: `btn${primary ? ' primary' : ''}`, onclick }, text);
  const del = () => btn('删除这个号…', () => window.wa.remove(acc.id));
  // 正在自动重试时不给「重新连接」，免得用户不知道要不要点（顶栏的刷新按钮照样能马上重连）
  const retry = (text = '重新连接', primary = true) => (acc.retrying && text === '重新连接' ? null : btn(text, () => window.wa.retry(acc.id), primary));
  switch (acc.problemKind) {
    case 'authError': return [del()];
    case 'banned': return [del(), retry('仍要重试', false)];
    case 'outdated': return [btn('检查并更新', () => { settingsTab = 'about'; window.wa.showPage('settings'); window.wa.updateCheck(); }), btn('去下载新版', () => window.wa.openLink(RELEASES), true)];
    case 'loggedOut': case 'qrExpired': return [retry('重新扫码')];
    case 'teamProxy': return [btn('设置代理', () => window.wa.edit(acc.id), true)];
    case 'crashLoop': case 'crashed': return [btn('打开日志文件夹', () => window.wa.openLogs()), retry()];
    default: return [acc.direct ? null : btn('修改代理', () => window.wa.edit(acc.id)), retry(acc.mode === 'lite' && acc.needsQr ? '重新扫码' : '重新连接')];
  }
}

function problemPage(acc) {
  return h('div', { class: 'center' }, h('div', { class: 'panel' },
    h('div', { class: 'warnicon' }, icon('warn', 26)),
    h('h2', null, acc.problemTitle || '代理连不上，这个账号已暂停联网'),
    h('p', null, acc.problem),
    acc.retrying ? h('p', { class: 'hint' }, '正在自动重试…') : null,
    h('div', { class: 'btns' }, ...kids(...problemButtons(acc))),
    problemDetails(acc)));
}

// 折起来的详细信息：问题代码（日志里也记着同一个代码）和日志文件夹。
// 界面会整块重画，记住展开的是哪个号的哪个问题，重画后保持展开
let detailsOpenKey = '';
function problemDetails(acc) {
  if (!acc.problemCode) return null;
  const key = `${acc.id}|${acc.problemKind}`;
  const logs = h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.wa.openLogs(); } }, '打开日志文件夹');
  return h('details', { class: 'pdetails', open: detailsOpenKey === key, ontoggle: (e) => { if (e.currentTarget.open) detailsOpenKey = key; else if (detailsOpenKey === key) detailsOpenKey = ''; } },
    h('summary', null, ...segs('详细信息', acc.problemCode)),
    // 系统的原话（英文错误码），排查时看
    acc.problemDetail ? h('code', null, acc.problemDetail) : null,
    h('p', null, '日志里也记着这个代码。', ' ', logs));
}

// Clash 说明在 GitHub 上（安装包里不带 docs/），用浏览器打开
const CLASH_DOC = 'https://github.com/Kr1xxxx/WAswitch/blob/main/docs/clash.md';
const clashLink = () => h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.wa.openLink(CLASH_DOC); } }, 'Clash 设置说明');

// ---------- 未读总览 ----------
// 上半：哪些号有未读（多的在前），点一下切过去；下半：最近的通知记录（只有号、时间、未读数）
let notifLogCache = [];
let overviewTotal = 0;
let overviewSig = '';
async function loadNotifLog() {
  try { notifLogCache = await window.wa.notifLog(); } catch { notifLogCache = []; }
  if (s.page === 'overview') render(true);
}
function overviewPage() {
  const page = h('div', { class: 'page narrow' });
  const byId = new Map(s.accounts.map((a) => [a.id, a]));
  const unread = s.accounts.filter((a) => a.unread).sort((a, b) => b.unread - a.unread);
  const total = unread.reduce((n, a) => n + a.unread, 0);
  const groupName = (a) => (s.groups || []).find((g) => g.id === a.groupId)?.name || '';
  // 没有未读时中间那块是 null：要过一遍 kids，不然页面上会显示 “null”
  page.append(...kids(
    h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '未读总览'),
      h('p', { class: 'lead' }, total ? `${unread.length} 个号共有 ${total} 个未读对话。` : '所有号都没有未读对话。')),
    unread.length ? h('div', { class: 'box ov-list' }, unread.map((a) => h('button', { class: 'ov-row', onclick: () => window.wa.switchTo(a.id) },
      mini(a),
      h('span', { class: 'ov-name' }, ...segs(a.name, groupName(a) ? h('span', { class: 'hint' }, groupName(a)) : null)),
      a.muted || a.groupMuted ? h('span', { class: 'hint' }, '不弹通知') : null,
      h('span', { class: `pill${a.muted || a.groupMuted ? ' quiet' : ''}` }, a.unread)))) : null,
    h('div', { class: 'hstack', style: { justifyContent: 'space-between', marginTop: '8px' } },
      h('h2', { class: 'ov-h2' }, '通知记录'),
      notifLogCache.length ? h('button', { class: 'btn', onclick: async () => { await window.wa.notifClear(); loadNotifLog(); } }, '清空记录') : null),
    notifLogCache.length
      ? h('div', { class: 'box ov-log' }, notifLogCache.map((e) => {
        const a = byId.get(e.id);
        const t = new Date(e.at);
        const today = t.toDateString() === new Date().toDateString();
        return h(a ? 'button' : 'div', { class: 'ov-logrow', onclick: a ? () => window.wa.switchTo(a.id) : null },
          h('span', { class: 'hint ov-time' }, t.toLocaleString('zh-CN', today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
          mini(a),
          h('span', { class: 'ov-name' }, a ? a.name : '已删除的号'),
          h('span', { class: 'hint' }, ...segs(`${e.count} 个未读`, e.popped ? null : '没弹')));
      }))
      : h('div', { class: 'box' }, h('span', { class: 'hint' }, '还没有记录。'))));
  return page;
}

// ---------- 右侧面板：话术库和客户名单 ----------
// 只存本机。点“复制”放进剪贴板；点“插入”等于帮你按一次 Ctrl+V 贴进当前聊天框（会覆盖剪贴板），不会自动发送
const pn = { tab: 'replies', q: '', all: false, edit: null, msg: '', bad: false, data: { replies: [], customers: [] }, loaded: false, accountId: null, sig: '' };
async function panelLoad() {
  try { pn.data = await window.wa.panelData(); pn.loaded = true; } catch {}
  renderPanel(true);
}
// MCP 改了客户名单（或在 MCP 设置里撤销了）：重新拿数据，只换列表。正在编辑表单时不重画，免得冲掉正在打的字
window.wa.onPanelChanged(async () => {
  if (!pn.loaded) return;
  try { pn.data = await window.wa.panelData(); } catch { return; }
  if (pn.edit || pn.tab !== 'customers' || $panel.hidden) return;
  const list = $panel.querySelector('.pn-list');
  if (list) list.replaceChildren(...customerItems());
});
// 导入结果：新加几条，已经有的、内容不全的各跳过几条
const importSay = (r, unit) => `导入了 ${r.added} ${unit}${r.dup ? `，${r.dup} ${unit}已经有了` : ''}${r.bad ? `，${r.bad} ${unit}内容不全跳过` : ''}`;
function panelSay(msg, bad = false) { pn.msg = msg; pn.bad = bad; renderPanel(true); }
async function panelInsert(text) {
  const acc = active();
  if (!acc || acc.id !== pn.accountId) return panelSay('当前账号变了，请再点一次', true);
  if (acc.mode === 'lite') {
    // 轻量模式的输入框就在软件界面里：直接填进去，不碰剪贴板
    const box = $content.querySelector('.lite-compose textarea');
    if (!box) return panelSay('先在左边打开一个对话', true);
    const at = box.selectionStart ?? box.value.length;
    box.value = box.value.slice(0, at) + text + box.value.slice(box.selectionEnd ?? at);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    return panelSay('已填进输入框，检查后自己按发送');
  }
  const r = await window.wa.panelInsert(pn.accountId, text);
  if (r === 'ok') panelSay('已贴进聊天框（剪贴板也换成了这段），检查后自己按发送');
  else if (r === 'focus') panelSay('光标不在聊天输入框里，没有贴。先点一下对话下方写消息的地方，再点“放进输入框”', true);
  else panelSay(r === 'changed' ? '当前账号变了、已锁定或页面没打开，没有贴' : '没有贴进去', true);
}
const fmtDue = (t) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const toLocalInput = (t) => { if (!t) return ''; const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function replyForm() {
  const r = pn.edit;
  const title = h('input', { value: r.title || '', maxlength: '60', placeholder: '标题（可不填）', 'aria-label': '标题' });
  const text = h('textarea', { maxlength: '2000', placeholder: '话术内容', 'aria-label': '话术内容' }, r.text || '');
  requestAnimationFrame(() => (r.title ? text : title).focus());
  return h('div', { class: 'pn-form' }, title, text,
    h('div', { class: 'pn-item acts', style: { border: 'none', padding: 0, background: 'none', flexDirection: 'row' } },
      h('button', { class: 'pn-btn primary', onclick: async () => {
        const d = await window.wa.replySave({ id: r.id, title: title.value, text: text.value });
        if (!d) return panelSay('内容不能是空的', true);
        pn.data = d; pn.edit = null; panelSay('已保存');
      } }, '保存'),
      h('button', { class: 'pn-btn', onclick: () => { pn.edit = null; renderPanel(true); } }, '取消')));
}
function customerForm() {
  const c = pn.edit;
  const name = h('input', { value: c.name || '', maxlength: '60', placeholder: '名字', 'aria-label': '名字' });
  const phone = h('input', { value: c.phone || '', maxlength: '40', placeholder: '电话（例如 +49 151 2345678）', 'aria-label': '电话' });
  const tags = h('input', { value: (c.tags || []).join('，'), maxlength: '220', placeholder: '标签，用逗号隔开', 'aria-label': '标签' });
  const note = h('textarea', { maxlength: '500', placeholder: '备注', 'aria-label': '备注' }, c.note || '');
  const due = h('input', { type: 'datetime-local', value: toLocalInput(c.followUpAt), 'aria-label': '下次跟进时间' });
  const lang = h('select', { 'aria-label': '翻译用的语言' }, h('option', { value: '' }, '翻译语言：跟随账号'), ((tr.cfg && tr.cfg.langs) || []).map((l) => h('option', { value: l }, `翻译成${l}`)));
  lang.value = c.lang || '';
  const acc = h('select', { 'aria-label': '属于哪个号' }, s.accounts.map((a) => h('option', { value: a.id }, a.name)));
  acc.value = s.accounts.some((a) => a.id === c.accountId) ? c.accountId : (s.activeId || '');
  requestAnimationFrame(() => name.focus());
  return h('div', { class: 'pn-form' }, name, phone, tags, note,
    h('label', { class: 'hint' }, '下次跟进'), due,
    h('label', { class: 'hint' }, '属于哪个号'), acc, tr.cfg ? lang : null,
    h('div', { class: 'acts', style: { display: 'flex', gap: '4px' } },
      h('button', { class: 'pn-btn primary', onclick: async () => {
        const t = due.value ? new Date(due.value).getTime() : 0;
        const d = await window.wa.custSave({ id: c.id, accountId: acc.value, name: name.value, phone: phone.value, tags: tags.value, note: note.value, followUpAt: Number.isFinite(t) ? t : 0, lang: tr.cfg ? lang.value : c.lang });
        if (!d) return panelSay('名字和电话至少填一个', true);
        pn.data = d; pn.edit = null; panelSay('已保存');
      } }, '保存'),
      h('button', { class: 'pn-btn', onclick: () => { pn.edit = null; renderPanel(true); } }, '取消')));
}
function replyItems() {
  const q = pn.q.toLowerCase();
  const list = pn.data.replies.filter((r) => !q || `${r.title}\n${r.text}`.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) return [h('div', { class: 'hint', style: { padding: '8px 2px' } }, pn.data.replies.length ? '没有找到。' : '还没有话术。')];
  return list.map((r) => h('div', { class: 'pn-item' },
    r.title ? h('span', { class: 't' }, r.title) : null,
    h('span', { class: 'x' }, r.text),
    h('span', { class: 'acts' },
      h('button', { class: 'pn-btn primary', title: '贴进当前聊天框（会覆盖剪贴板），不会自动发送', onclick: () => panelInsert(r.text) }, '插入'),
      h('button', { class: 'pn-btn', onclick: async (e) => { const b = e.currentTarget; await window.wa.panelCopy(r.text); copyFlash(b); } }, '复制'),
      h('button', { class: 'pn-btn', onclick: () => { pn.edit = { ...r }; renderPanel(true); } }, '编辑'),
      h('button', { class: 'pn-btn', onclick: async () => { pn.data = await window.wa.replyDelete(r.id); pn.msg = ''; renderPanel(true); } }, '删除'))));
}
function customerItems() {
  const q = pn.q.toLowerCase();
  const list = pn.data.customers
    .filter((c) => pn.all || c.accountId === pn.accountId)
    .filter((c) => !q || `${c.name}\n${c.phone}\n${c.tags.join(',')}\n${c.note}`.toLowerCase().includes(q))
    .sort((a, b) => (a.followUpAt || Infinity) - (b.followUpAt || Infinity) || b.updatedAt - a.updatedAt);
  if (!list.length) return [h('div', { class: 'hint', style: { padding: '8px 2px' } }, pn.data.customers.length ? '没有找到。' : '还没有客户。')];
  const now = Date.now();
  return list.map((c) => h('div', { class: 'pn-item' },
    h('span', { class: 't' }, c.name || c.phone),
    c.name && c.phone ? h('span', { class: 'x' }, c.phone) : null,
    pn.all ? h('span', { class: 'hint' }, c.accountName || '已删除的账号') : null,
    c.tags.length ? h('span', null, c.tags.map((t) => h('span', { class: 'pn-tag' }, t))) : null,
    c.note ? h('span', { class: 'x' }, c.note) : null,
    c.followUpAt ? h('span', { class: `pn-due${c.followUpAt < now ? ' late' : ''}` }, `下次跟进：${fmtDue(c.followUpAt)}${c.followUpAt < now ? '（已到）' : ''}`) : null,
    h('span', { class: 'acts' },
      c.phone ? h('button', { class: 'pn-btn', onclick: async (e) => { const b = e.currentTarget; await window.wa.panelCopy(c.phone); copyFlash(b); } }, '复制电话') : null,
      h('button', { class: 'pn-btn', onclick: () => { pn.edit = { ...c }; renderPanel(true); } }, '编辑'),
      h('button', { class: 'pn-btn', onclick: async () => { pn.data = await window.wa.custDelete(c.id); pn.msg = ''; renderPanel(true); } }, '删除'))));
}
// ---------- 翻译（面板里的第三个标签） ----------
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
// 翻译设置的缓存（设置 › 翻译、客户表单的语言选项用）；面板“翻译”页在 dock.js
const tr = { cfg: null, modes: [] };
async function trLoad() {
  if (tr.loading) return;
  tr.loading = true;
  try { const r = await window.wa.trConfig(); tr.cfg = r.config; tr.modes = r.modes; } catch {}
  tr.loading = false;
  if (!tr.cfg) return; // 读不到就不重画，免得一直重试
  if (s.page === 'settings' && (settingsTab === 'translate' || settingsTab === 'quick')) render(true);
}
const modesFor = (dir) => tr.modes.filter((m) => m.direction === dir || m.direction === 'both');
// ---------- 设置 › 翻译 ----------
let trEdit = null; // 正在编辑的服务商 { id?, preset, name, baseUrl, model, key }
let trModeEdit = null;
let trSay = '';
let trTestRes = {};
let trTestRaw = {}; // 测试失败时服务商的原话
let trNetDraft = null; // 选了“指定代理”但代理地址还没存好：{ url }
let trNetSay = ''; // “翻译的网络”这一行的提示：已保存 / 出错原因
let trNetErr = false;
let trNetTimer = 0;
let trNetBusy = false; // 正在存：重画时旧输入框的失焦不再存一次
let trNetLastUrl = ''; // 上次存好的代理地址：切到直连再切回来时帮你填上
let trFocusKey = false; // 从“去填密钥”打开的表单：光标直接放进密钥框
// 翻译页默认是简单版：只填密钥。点“详细设置”才显示服务商、网络、纠错、模式这些（记在本机）
let trAdvanced = LS('trAdvanced') === '1';
let trKeyFocus = ''; // 简单版里“去填密钥”：光标放进这个服务商的密钥框
const ZHIPU_KEYS = 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys'; // 智谱开放平台的 API 密钥页
// 翻译报“还没填密钥 / 密钥不对”时的“去填密钥”：打开 设置 › 翻译 里这个服务商的表单
// preset：列表里还没有这个服务商时（翻译页右上角点「未启用」的混元等），直接给它开一个填密钥的地方
async function trOpenKey(pid, preset) {
  if (!tr.cfg) { try { const r = await window.wa.trConfig(); tr.cfg = r.config; tr.modes = r.modes; } catch {} }
  const p = tr.cfg && tr.cfg.providers.find((x) => x.id === pid);
  const add = !p && TR_KEY_PRESETS.includes(preset) ? preset : '';
  if (trAdvanced) { trEdit = p ? { ...p } : add ? { preset: add } : trEdit; trFocusKey = !!(p || add); } else trKeyFocus = p ? p.id : add ? `new:${add}` : '';
  trSay = '';
  settingsTab = 'translate';
  window.wa.showPage('settings');
  if (s.page === 'settings') render(true);
}
function trProviderForm() {
  const e = trEdit;
  const presets = tr.cfg.presets;
  const preset = h('select', { 'aria-label': '服务商' }, presets.map((p) => h('option', { value: p.id }, p.name)));
  preset.value = e.preset || 'zhipu';
  const name = h('input', { value: e.name || '', maxlength: '40', placeholder: '显示名称（可不填）' });
  const base = h('input', { value: e.baseUrl || '', placeholder: 'https://…/v1' });
  const modelIn = h('input', { value: e.model || '', placeholder: '模型名，例如 gpt-4o-mini' });
  // 有固定模型列表的服务商（腾讯混元、智谱）只能下拉选，不能手填
  const modelSel = h('select', { 'aria-label': '模型' });
  const listFor = (id) => (presets.find((x) => x.id === id) || {}).models || null;
  const model = { get value() { return listFor(preset.value) ? modelSel.value : modelIn.value; } };
  const modelBox = h('span', { style: { display: 'contents' } });
  const showModel = (want) => {
    const list = listFor(preset.value);
    if (list) {
      modelSel.replaceChildren(...list.map((m) => h('option', { value: m }, m)));
      modelSel.value = list.includes(want) ? want : list[0];
      modelBox.replaceChildren(modelSel);
    } else { modelIn.value = want || ''; modelBox.replaceChildren(modelIn); }
  };
  const key = h('input', { type: 'password', value: '', autocomplete: 'off', placeholder: e.hasKey ? `已保存 ••${e.keyTail}` : 'API 密钥' });
  preset.addEventListener('change', () => {
    const p = presets.find((x) => x.id === preset.value);
    if (p && p.id !== 'custom') { base.value = p.baseUrl; showModel(p.model || ''); } else showModel(modelIn.value);
  });
  if (!e.id && !e.baseUrl) { const p = presets.find((x) => x.id === preset.value); base.value = p.baseUrl; showModel(p.model); } else showModel(e.model || '');
  // 状态推送会重画设置页：填到一半的内容先记在 trEdit 里（密钥除外，密钥不留在界面状态里）
  // 深度思考：默认 = 不传参数。智谱、OpenRouter 新加的默认禁用
  const think = h('select', { 'aria-label': '深度思考' }, [['', '默认'], ['disabled', '禁用思考'], ['enabled', '启用思考']].map(([v, l]) => h('option', { value: v }, l)));
  const thinkDefault = (id) => (id === 'zhipu' || id === 'openrouter' ? 'disabled' : '');
  think.value = typeof e.thinking === 'string' ? e.thinking : thinkDefault(preset.value);
  preset.addEventListener('change', () => { think.value = thinkDefault(preset.value); });
  const keep = () => Object.assign(e, { preset: preset.value, name: name.value, baseUrl: base.value, model: model.value, thinking: think.value });
  for (const el of [preset, name, base, modelIn, modelSel, think]) { el.addEventListener('input', keep); el.addEventListener('change', keep); }
  for (const el of [name, base, key]) el.style.width = '260px';
  // 设置页可能连着重画几次：等画到页面上的那一次再把光标放进去
  if (trFocusKey) requestAnimationFrame(() => { if (!trFocusKey || !key.isConnected) return; trFocusKey = false; key.scrollIntoView({ block: 'center' }); key.focus(); });
  const isMt = /^hy-mt/i.test(model.value);
  // DeepL 是机器翻译：没有地址、模型、深度思考可选；各类型的说明也不一样，换类型时重画表单
  const deepl = preset.value === 'deepl';
  preset.addEventListener('change', () => render(true));
  const capIn = deepl ? trCapInput(tr.cfg) : null;
  return h('div', { class: 'box tr-form' },
    h('b', null, e.id ? '修改服务商' : '添加服务商'),
    setRow('类型', deepl ? 'DeepL 不按模式改语气，也不会纠错。' : '', preset),
    setRow('名称', '', name),
    deepl ? null : setRow('接口地址', preset.value === 'hunyuan' ? '腾讯混元海外账号填 https://tokenhub-intl.tencentcloudmaas.com/v1。' : '', base),
    deepl ? null : setRow('模型', listFor(preset.value) ? '' : 'OpenRouter 的模型名去它网站上复制，例如 deepseek/deepseek-chat。', modelBox),
    setRow('API 密钥', preset.value === 'hunyuan' ? '填腾讯云 TokenHub 的密钥。' : '', key,
      preset.value === 'zhipu' ? h('a', { href: '#', class: 'tr-keylink', onclick: (ev) => { ev.preventDefault(); window.wa.openLink(ZHIPU_KEYS); } }, '没有密钥？去智谱开放平台申请（glm-4-flash 免费）') : null),
    deepl ? null : setRow('深度思考', isMt ? '混元翻译模型用不上这项。' : '', think),
    deepl ? setRow('每月上限', '', h('label', { class: 'tr-cap' }, capIn, '字符')) : null,
    h('div', { class: 'hstack', style: { paddingTop: '12px' } },
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await window.wa.trProviderSave({ id: e.id, preset: preset.value, name: name.value, baseUrl: base.value, model: model.value, key: key.value, thinking: think.value, ...(capIn ? { monthCap: Number(capIn.value) } : {}) });
        tr.cfg = r.config; tr.modes = r.modes;
        if (r.error) { trSay = r.error; } else { trSay = '已保存'; trEdit = null; }
        render(true);
      } }, '保存'),
      h('button', { class: 'btn', onclick: () => { trEdit = null; render(true); } }, '取消')));
}
function trModeForm() {
  const m = trModeEdit;
  const name = h('input', { value: m.name || '', maxlength: '40', placeholder: '模式名字，例如 商务正式' });
  const dir = h('select', { 'aria-label': '方向' }, [['out', '发出（中文→外语）'], ['in', '收到（外语→中文）'], ['both', '都可以']].map(([v, l]) => h('option', { value: v }, l)));
  dir.value = m.direction || 'out';
  const prompt = h('textarea', { maxlength: '4000', placeholder: '写给 AI 的要求，例如：翻译得正式、礼貌。可以用 {目标语言} 和 {原文语言}', style: { minHeight: '120px' } }, m.prompt || '');
  const temp = h('input', { type: 'number', min: '0', max: '1.5', step: '0.1', value: String(m.temperature ?? 0.3), style: { width: '80px' } });
  const keep = () => Object.assign(m, { name: name.value, direction: dir.value, prompt: prompt.value, temperature: Number(temp.value) });
  for (const el of [name, dir, prompt, temp]) { el.addEventListener('input', keep); el.addEventListener('change', keep); }
  return h('div', { class: 'box tr-form', style: { gap: '8px' } },
    h('b', null, m.id ? '修改模式' : '新建模式'), name, h('label', { class: 'inline' }, '方向', dir), prompt,
    h('label', { class: 'inline' }, '随机度（越低越稳定）', temp),
    h('div', { class: 'hstack' },
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await window.wa.tmodeSave({ id: m.id, name: name.value, direction: dir.value, prompt: prompt.value, temperature: Number(temp.value) });
        tr.cfg = r.config; tr.modes = r.modes;
        if (r.error) trSay = r.error; else { trSay = '已保存'; trModeEdit = null; }
        render(true);
      } }, '保存'),
      h('button', { class: 'btn', onclick: () => { trModeEdit = null; render(true); } }, '取消')));
}
let trRoleDraft = null; // 没保存的角色设定（重画时不丢）
function trRoleBox(c, apply) {
  const ta = h('textarea', { maxlength: '4000', 'aria-label': '角色设定', style: { minHeight: '160px' },
    placeholder: '例如：\n你是睫毛产品的外贸业务员，翻译要专业、礼貌。\n这些词固定这样翻译：\n贴牌 = private label' },
  trRoleDraft ?? (c.rolePrompt || ''));
  ta.addEventListener('input', () => { trRoleDraft = ta.value; });
  return h('div', { class: 'col', style: { gap: '8px' } }, ta,
    h('div', { class: 'hstack' }, h('button', { class: 'btn primary', onclick: async () => {
      const r = await window.wa.trRole(ta.value);
      if (!r.error) { trRoleDraft = null; trSay = '角色设定已保存'; }
      apply(r);
    } }, '保存角色设定')));
}
// 内置行业词汇开关：假发、睫毛（都默认开），各自单独存。打开后词表跟在角色设定后面一起带去翻译
function trWigBox(c, apply) {
  // 每个词条不拆行（“胶片发”不会断成两行）
  const terms = (list) => h('span', { class: 'desc' }, (list || []).flatMap((t, i) => [i ? '　' : '', h('span', { style: { whiteSpace: 'nowrap' } }, `${t.zh} = ${t.en}`)]));
  const row = (title, on, list, set) => setRow(title, '',
    sw(on, title, async (v) => { const r = await set(v); if (!r.error) trSay = v ? `${title}已打开` : `${title}已关闭`; apply(r); }), terms(list));
  // 最后一行不画底线（和 API 密钥框一样），提示句直接跟在下面
  const last = row('睫毛词汇', c.lashTerms !== false, c.lashList, (v) => window.wa.trLash(v));
  last.style.borderBottom = 'none';
  return h('div', { class: 'box' },
    row('假发词汇', c.wigTerms !== false, c.wigList, (v) => window.wa.trWig(v)),
    last,
    h('span', { class: 'hint' }, '角色设定里写过的词以你写的为准。DeepL 不用词表。'));
}
// 简单版：每个服务商一行，只填密钥。保存时其他设置照原样带回去
// 简单设置里总有这三个服务商的密钥框（翻译页右上角也是这三个）。列表里没有的（0.5.4 起新装的没有混元，或被删了）先占个位，填了密钥才真的加上
// trKeyMorph：占位行保存后变成真的服务商（新 id），按钮还用原来的 key，「保存中 / 已保存 / 未通过」才接得上
const trKeyMorph = {};
const TR_KEY_PRESETS = ['zhipu', 'hunyuan', 'deepl'];
const TR_KEY_NAMES = { zhipu: '智谱', hunyuan: '腾讯混元', deepl: 'DeepL' };
const TR_KEY_MODELS = { zhipu: 'glm-4-flash', hunyuan: 'hy-mt2-plus', deepl: '' };
function trKeyRows(c) {
  const order = (p) => (p.id === c.primaryId ? 0 : p.id === c.fallbackId ? 1 : p.id === c.fixId ? 2 : 3);
  const rows = [...c.providers].sort((a, b) => order(a) - order(b)).map((p) => ({ ...p, rowId: p.id }));
  const presets = c.presets || [];
  for (const id of TR_KEY_PRESETS) {
    if (c.providers.some((p) => p.preset === id)) continue;
    const pr = presets.find((x) => x.id === id) || {};
    rows.push({ id: '', rowId: `new:${id}`, preset: id, name: pr.name || TR_KEY_NAMES[id], baseUrl: pr.baseUrl || '', model: id === 'deepl' ? '' : pr.model || TR_KEY_MODELS[id], hasKey: false, keyTail: '' });
  }
  return rows;
}
function trKeysBox(c, apply) {
  const tag = (t) => h('span', { class: 'pn-tag', style: { marginLeft: '6px' } }, t);
  return h('div', { class: 'box tr-keys' }, trKeyRows(c).map((p) => {
    const key = h('input', { type: 'password', value: '', autocomplete: 'off', 'aria-label': `${p.name} 的 API 密钥`,
      placeholder: p.hasKey ? `已保存 ••${p.keyTail}` : '粘贴 API 密钥' });
    const save = async () => {
      if (!key.value.trim()) { trSay = `先把「${p.name}」的密钥粘贴进来`; render(true); return null; }
      // 占位的行：不带 id，保存时新加这个服务商（不改默认、备用、纠错）
      const r = await window.wa.trProviderSave({ ...(p.id ? { id: p.id } : {}), preset: p.preset, name: p.name, baseUrl: p.baseUrl, model: p.model, key: key.value, ...(p.thinking !== undefined ? { thinking: p.thinking } : {}) });
      if (r.error) { apply(r); return { ok: false }; }
      const pid = p.id || r.id;
      if (!p.id) trKeyMorph[pid] = p.rowId;
      trSay = ''; trTestRes[pid] = ''; trTestRaw[pid] = '';
      apply(r);
      // 保存后自动测一次（每行只留「保存」一个按钮）；没通过的原因写在服务商下面
      let t;
      try { t = await window.wa.trTest(pid); } catch { t = { ok: false, error: '测试失败' }; }
      if (!t.ok) { trTestRes[pid] = t.error || '测试没通过'; trTestRaw[pid] = t.detail || ''; render(true); }
      return { ok: !!t.ok };
    };
    const saveBtn = morphBtn(`trKeySave:${trKeyMorph[p.id] || p.rowId}`, { idle: '保存', busy: '保存中', ok: '已保存', err: '未通过' }, save, { class: 'btn primary sm' });
    key.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) saveBtn.click(); });
    if (trKeyFocus === p.rowId) requestAnimationFrame(() => { if (trKeyFocus !== p.rowId || !key.isConnected) return; trKeyFocus = ''; key.scrollIntoView({ block: 'center' }); key.focus(); });
    const link = p.preset === 'zhipu' && !p.hasKey ? h('a', { href: '#', class: 'tr-keylink', onclick: (ev) => { ev.preventDefault(); window.wa.openLink(ZHIPU_KEYS); } }, '没有密钥？去智谱开放平台申请（glm-4-flash 免费）') : null;
    const roles = p.id ? [p.id === c.primaryId ? tag('默认') : null, p.id === c.fallbackId ? tag('备用') : null, p.id === c.fixId ? tag('纠错') : null] : [];
    const cap = p.preset === 'deepl' ? trCapBox(c, apply) : null;
    return h('div', { class: 'tr-krow' },
      h('div', { class: 'meta' },
        h('span', { class: 'title' }, h('b', null, p.name), ...roles),
        h('span', { class: 'desc' }, p.preset === 'deepl' ? '机器翻译' : p.model),
        trTestRes[p.id] ? h('span', { class: 'desc' }, trTestRes[p.id]) : null,
        link),
      h('span', { class: 'hstack', style: { gap: '6px' } }, key, saveBtn),
      cap);
  }));
}
// DeepL 每月字符上限（整个软件一个，默认 10 万）：改完离开输入框或按回车就保存
function trCapInput(c) {
  return h('input', { type: 'number', class: 'tr-cap-in', min: '1000', step: '1000', value: String(c.deeplCap || 100000), 'aria-label': 'DeepL 每月字符上限' });
}
function trCapBox(c, apply) {
  const box = trCapInput(c);
  box.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) box.blur(); });
  box.addEventListener('change', async () => {
    const r = await window.wa.trDeeplCap(Number(box.value));
    trSay = r.error || 'DeepL 每月上限已保存';
    apply(r);
  });
  return h('label', { class: 'tr-cap' }, '每月上限', box, '字符');
}
// 不会纠错的服务商：DeepL 和混元翻译模型（hy-mt）只会重翻一遍
const trNoFix = (p) => p.preset === 'deepl' || /^hy-mt/i.test(p.model || '');
// 服务商「测试」：结果在按钮上显示，没通过的原因写在服务商下面
function trTestBtn(p, attrs) {
  return morphBtn(`trTest:${p.id}`, { idle: '测试', busy: '测试中', ok: '通过', err: '未通过' }, async () => {
    if (trTestRes[p.id]) { trTestRes[p.id] = ''; trTestRaw[p.id] = ''; render(true); }
    const r = await window.wa.trTest(p.id);
    if (!r.ok) { trTestRes[p.id] = r.error; trTestRaw[p.id] = r.detail || ''; }
    render(true);
    return { ok: !!r.ok };
  }, attrs);
}
function translatePage(page) {
  if (!tr.cfg) { trLoad(); page.append(h('h1', null, '翻译'), h('p', { class: 'lead' }, '加载中…')); return; }
  const c = tr.cfg;
  const apply = (r) => { tr.cfg = r.config; tr.modes = r.modes; if (r.error) trSay = r.error; render(true); };
  const fb = h('select', { 'aria-label': '备用服务商', onchange: async (e) => apply(await window.wa.trRoles(c.primaryId, e.target.value)) },
    h('option', { value: '' }, '不用备用'), c.providers.filter((p) => p.id !== c.primaryId).map((p) => h('option', { value: p.id }, p.name)));
  fb.value = c.fallbackId || '';
  const hasZhipu = c.providers.some((p) => p.preset === 'zhipu' && p.model === 'glm-4-flash');
  const fixSel = h('select', { 'aria-label': '纠错服务商', onchange: async (e) => {
    if (e.target.value === '+zhipu') { const r = await window.wa.trFixZhipu(); if (!r.error) trSay = '已添加智谱 glm-4-flash 并设为纠错，在上面“服务商”里点“修改”填密钥。'; apply(r); return; }
    apply(await window.wa.trRoles(c.primaryId, c.fallbackId, e.target.value));
  } },
    h('option', { value: '' }, '用默认的'), c.providers.filter((p) => !trNoFix(p) || p.id === c.fixId).map((p) => h('option', { value: p.id }, p.model ? `${p.name}（${p.model}）` : p.name)),
    hasZhipu ? null : h('option', { value: '+zhipu' }, '+ 添加智谱（glm-4-flash）'));
  fixSel.value = c.fixId || '';
  const fixP = c.providers.find((p) => p.id === c.fixId);
  // 翻译的网络：改了就保存（选项一改就存，代理地址点别处或按回车存），不用再点“应用”
  if (c.network.mode === 'proxy' && c.network.proxyUrl) trNetLastUrl = c.network.proxyUrl;
  const netSay = h('span', { id: 'tr-net-say', class: 'hint', role: 'status', style: { color: trNetErr ? 'var(--danger)' : '' } }, trNetSay);
  const saveNet = async (mode, url) => {
    trNetBusy = true;
    let r;
    try { r = await window.wa.trNetwork(mode, url); } finally { trNetBusy = false; }
    clearTimeout(trNetTimer);
    if (r.error) { trNetSay = r.error; trNetErr = true; trNetDraft = mode === 'proxy' ? { url } : null; }
    else {
      trNetSay = '已保存'; trNetErr = false; trNetDraft = null;
      // 两秒后把“已保存”收掉：只改这一行的文字，不重画整页（别把正在别处打字的光标弄丢）
      trNetTimer = setTimeout(() => { if (trNetSay === '已保存') { trNetSay = ''; const el = document.getElementById('tr-net-say'); if (el) el.textContent = ''; } }, 2000);
    }
    tr.cfg = r.config; tr.modes = r.modes; render(true);
  };
  const netMode = trNetDraft ? 'proxy' : c.network.mode;
  const netUrl = trNetDraft ? trNetDraft.url : (c.network.proxyUrl || '');
  const netSel = h('select', { 'aria-label': '翻译走的网络', onchange: (e) => {
    const v = e.target.value;
    if (v !== 'proxy') { saveNet(v, ''); return; }
    // 选了“指定代理”：框里已经有地址就直接存，没有就等填好
    const url = (trNetDraft && trNetDraft.url) || trNetLastUrl;
    if (url.trim()) { saveNet('proxy', url); return; }
    trNetDraft = { url: '' }; trNetSay = ''; trNetErr = false; render(true);
    const el = document.getElementById('tr-net-url'); if (el) el.focus();
  } }, [['system', '跟随系统代理'], ['direct', '直连'], ['proxy', '指定代理']].map(([v, l]) => h('option', { value: v }, l)));
  netSel.value = netMode;
  const proxyIn = h('input', { id: 'tr-net-url', 'aria-label': '翻译代理地址', value: netUrl, placeholder: 'http://127.0.0.1:7890', style: { width: '200px', flex: 'none' },
    oninput: (e) => { if (trNetDraft) trNetDraft.url = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) e.target.blur(); },
    onblur: (e) => {
      if (trNetBusy || !e.target.isConnected) return;
      const url = e.target.value;
      if (c.network.mode === 'proxy' && !trNetDraft && url.trim() === (c.network.proxyUrl || '')) return; // 没改
      if (!url.trim()) { trNetDraft = { url: '' }; trNetSay = '填好代理地址才会保存'; trNetErr = false; const el = document.getElementById('tr-net-say'); if (el) el.textContent = trNetSay; return; }
      saveNet('proxy', url);
    } });
  const toggle = h('button', { class: 'btn sm', 'aria-expanded': String(trAdvanced), onclick: () => {
    trAdvanced = !trAdvanced; LS('trAdvanced', trAdvanced ? '1' : '0'); trSay = '';
    if (!trAdvanced) { trEdit = null; trModeEdit = null; }
    render(true);
  } }, trAdvanced ? '回到简单设置' : '详细设置');
  const head = [
    h('div', { class: 'tr-head' }, h('h1', null, '翻译'), toggle),
    trSay ? h('div', { class: 'hint', role: 'status' }, trSay) : null,
    !c.canEncrypt ? h('div', { class: 'tr-warn' }, '这台电脑不支持加密保存，暂时不能保存密钥。') : null,
  ];
  if (!trAdvanced) {
    page.append(...kids(...head,
      h('h2', { class: 'ov-h2' }, 'API 密钥'),
      trKeysBox(c, apply),
      h('h2', { class: 'ov-h2' }, '行业词汇'),
      trWigBox(c, apply)));
    return;
  }
  page.append(...kids(...head,
    h('h2', { class: 'ov-h2' }, '服务商'),
    h('div', { class: 'box' }, c.providers.length ? c.providers.map((p) => h('div', { class: 'tr-prow' },
      h('span', null, h('b', null, p.name), p.id === c.primaryId ? h('span', { class: 'pn-tag', style: { marginLeft: '6px' } }, '默认') : p.id === c.fallbackId ? h('span', { class: 'pn-tag', style: { marginLeft: '6px' } }, '备用') : null,
        p.id === c.fixId ? h('span', { class: 'pn-tag', style: { marginLeft: '6px' } }, '纠错') : null),
      h('span', { class: 'hint' }, ...segs(p.preset === 'deepl' ? '机器翻译' : p.model, p.hasKey ? `密钥尾号 ${p.keyTail}` : '没有密钥')),
      // 没有测试结果时不占地方，模型和密钥尾号少被截断
      h('span', { class: 'hint', style: trTestRes[p.id] ? null : { flex: 'none' } }, trTestRes[p.id] || '', rawDetail(trTestRaw[p.id])),
      h('span', { class: 'hstack', style: { gap: '4px' } },
        trTestBtn(p, { class: 'pn-btn' }),
        // 每行按钮一样多，上下对齐：已经是默认 / 纠错的，或不会纠错的（DeepL、混元翻译模型），按钮还在，只是点不了
        h('button', { class: 'pn-btn', disabled: p.id === c.primaryId, onclick: async () => apply(await window.wa.trRoles(p.id, c.fallbackId === p.id ? '' : c.fallbackId)) }, '设为默认'),
        h('button', { class: 'pn-btn', disabled: p.id === c.fixId || trNoFix(p), title: trNoFix(p) ? '不会纠错' : null, onclick: async () => apply(await window.wa.trRoles(undefined, undefined, p.id)) }, '设为纠错'),
        h('button', { class: 'pn-btn', onclick: () => { trEdit = { ...p }; render(true); } }, '修改'),
        h('button', { class: 'pn-btn', onclick: async () => apply(await window.wa.trProviderDelete(p.id)) }, '删除'))))
      : h('span', { class: 'hint' }, '还没有。')),
    trEdit ? trProviderForm() : h('div', null, h('button', { class: 'btn', onclick: () => { trEdit = { preset: 'zhipu' }; trSay = ''; render(true); } }, '+ 添加服务商')),
    c.providers.length > 1 ? setRow('备用服务商', '', fb) : null,
    c.providers.length ? setRow('纠错服务商', '',
      h('span', { class: 'col', style: { gap: '4px' } }, fixSel,
        fixP && trNoFix(fixP) ? h('span', { class: 'hint' }, '这个服务商不会纠错，只会重翻一遍。') : null)) : null,
    setRow('翻译的网络', '',
      // “已保存”跟在后面；出错的话比较长，放到下面一行
      h('span', { class: 'col', style: { flex: '0 1 auto', gap: '4px', maxWidth: '420px' } },
        h('span', { class: 'hstack', style: { gap: '6px' } }, netSel, netMode === 'proxy' ? proxyIn : null, trNetErr ? null : netSay),
        trNetErr ? netSay : null)),
    s.accounts.length ? setRow('自动翻译收到的消息', '',
      h('span', { class: 'col tr-auto' }, s.accounts.map((a) => h('span', { class: 'hstack tr-auto-row' },
        h('span', { class: 'tr-auto-name' }, mini(a), a.name),
        sw(c.accountAuto[a.id] !== false, `${a.name} 自动翻译`, async (v) => apply(await window.wa.trAuto(a.id, v))))))) : null,
    setRow('每个号每天最多自动翻译', '',
      (() => { const sel = h('select', { 'aria-label': '每天上限', onchange: async (e) => apply(await window.wa.trDailyCap(Number(e.target.value))) }, (c.dailyCaps || [500]).map((n) => h('option', { value: String(n) }, `${n} 条`))); sel.value = String(c.dailyCap || 500); return sel; })()),
    h('h2', { class: 'ov-h2' }, '角色设定'),
    h('div', { class: 'box tr-form' },
      trRoleBox(c, apply),
      h('span', { class: 'hint' }, '混元翻译模型只认“中文 = 外语”这样的固定译法。')),
    trWigBox(c, apply),
    h('h2', { class: 'ov-h2' }, '翻译模式'),
    h('p', { class: 'hint' }, '工作台的回复用排第一个的“发出”模式。'),
    trModeEdit ? trModeForm() : null,
    h('div', { class: 'box' }, tr.modes.map((m) => h('div', { class: 'tr-prow' },
      h('b', { title: m.name }, m.name), h('span', { class: 'hint' }, { out: '发出', in: '收到', both: '都可以' }[m.direction]),
      h('span', { class: 'hint', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.prompt),
      h('span', { class: 'hstack', style: { gap: '4px' } },
        h('button', { class: 'pn-btn', onclick: () => { trModeEdit = { ...m }; render(true); } }, '修改'),
        h('button', { class: 'pn-btn', onclick: async () => apply(await window.wa.tmodeDelete(m.id)) }, '删除'))))),
    h('div', { class: 'hstack' },
      h('button', { class: 'btn', onclick: () => { trModeEdit = { direction: 'out', temperature: 0.3 }; trSay = ''; render(true); } }, '+ 新建模式'),
      h('button', { class: 'btn', onclick: async () => { const r = await window.wa.panelImport('tmodes'); if (!r) return; if (r.error) trSay = `导入失败：${r.error}`; else { trSay = importSay(r, '个'); tr.modes = r.modes; } render(true); } }, '导入'),
      h('button', { class: 'btn', onclick: async () => { const r = await window.wa.panelExport('tmodes', 'json'); if (r) { trSay = `导出了 ${r.count} 个`; render(true); } } }, '导出'))));
}

// force：用户在面板里操作了；不 force 时，面板里正在输入就不重画
function renderPanel(force = false) {
  const show = !!s.panelOpen && !s.locked && s.page === 'account';
  $panel.hidden = !show;
  if (!show) return;
  if (!pn.loaded) { pn.loaded = true; panelLoad(); }
  const tab = s.panelTab || 'translate';
  const sig = `${s.activeId}|${tab}|${s.accounts.map((a) => a.id + a.name).join(',')}`;
  if (!force && sig === pn.sig && $panel.firstChild) return;
  if (!force && pn.tab === tab && $panel.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  pn.sig = sig;
  const tabChanged = fxChanged('wb-tab', tab, false);
  if (pn.tab !== tab) { pn.edit = null; pn.q = ''; pn.msg = ''; }
  pn.tab = tab;
  pn.accountId = s.activeId; // 面板画出来时记下目标账号，插入时要对得上
  $panel.classList.toggle('dock', tab === 'translate');
  $panel.setAttribute('aria-label', '工作台');
  if (tab === 'translate') {
    const host = h('div', { class: 'dk-host' });
    $panel.replaceChildren(panelHead(), host);
    dockRender(true);
    // 从设置页回来（可能刚填了密钥、换了默认服务商）：主进程那时不推状态，这里重新拿一次
    if (dk.st) dockFetch();
    if (tabChanged) fxPlay(host, 'fx-fade');
    return;
  }
  const replies = tab === 'replies';
  if (!tr.cfg) trLoad(); // 客户表单里的语言选项要用
  const search = h('input', { type: 'search', value: pn.q, placeholder: replies ? '搜索话术' : '搜索名字、电话、标签', 'aria-label': '搜索' });
  search.addEventListener('input', () => { pn.q = search.value; const list = $panel.querySelector('.pn-list'); if (list) list.replaceChildren(...(pn.tab === 'replies' ? replyItems() : customerItems())); });
  const io = async (what) => {
    const kind = replies ? 'replies' : 'customers';
    if (what === 'import') {
      const r = await window.wa.panelImport(kind);
      if (!r) return;
      if (r.error) return panelSay(`导入失败：${r.error}`, true);
      pn.data = r.data;
      return panelSay(importSay(r, '条'));
    }
    const r = await window.wa.panelExport(kind, what);
    if (r) panelSay(`导出了 ${r.count} 条${r.parked ? `（含已停用账号的 ${r.parked} 条）` : ''}`);
  };
  $panel.replaceChildren(...kids(
    panelHead(),
    pn.edit ? null : h('div', { class: 'pn-tools' }, search,
      h('button', { class: 'pn-btn primary', onclick: () => { pn.edit = replies ? { title: '', text: '' } : { accountId: pn.accountId, tags: [] }; pn.msg = ''; renderPanel(true); } }, '新建')),
    !replies && !pn.edit ? h('label', { class: 'hint', style: { padding: '0 12px 6px', display: 'flex', gap: '6px', alignItems: 'center' } },
      h('input', { type: 'checkbox', checked: pn.all, onchange: (e) => { pn.all = e.target.checked; renderPanel(true); } }), '显示所有号的客户') : null,
    pn.msg ? fx('pn-msg', pn.msg, h('div', { class: `pn-msg${pn.bad ? ' bad' : ''}` }, pn.msg)) : null,
    pn.edit ? (replies ? replyForm() : customerForm()) : h('div', { class: 'pn-list' }, replies ? replyItems() : customerItems()),
    pn.edit ? null : h('div', { class: 'pn-foot' },
      h('button', { class: 'pn-btn', onclick: () => io('import') }, '导入'),
      h('button', { class: 'pn-btn', onclick: () => io('csv') }, '导出'))));
  // 切了页或打开/关掉编辑表单：下面的内容淡入
  const editChanged = fxChanged('pn-edit', !!pn.edit, false);
  if (tabChanged || editChanged) [...$panel.children].slice(1).forEach((el) => fxPlay(el, 'fx-fade'));
}

function welcomePage() {
  const step = (n, title, text) => h('li', null, h('span', { class: 'n' }, n), h('span', { class: 'meta' }, h('b', null, title), text ? h('small', null, text) : null));
  return h('div', { class: 'center', style: { background: 'var(--white)' } }, h('div', { class: 'col', style: { maxWidth: '640px', gap: '26px' } },
    h('h1', null, '一个窗口，同时登录多个 WhatsApp'),
    h('ol', { class: 'steps' },
      step(1, '起个名字，选个颜色'),
      step(2, '选网络线路', ['可以直连（几个号都直连也行，只是出口 IP 相同）；想分开 IP，就在 Clash 里给每个号开一个本地端口（填 socks5://127.0.0.1:端口），点“测试”。详见', clashLink(), '。']),
      step(3, '手机扫码登录', 'WhatsApp › 设置 › 已关联的设备 › 关联新设备。')),
    h('div', null, h('button', { class: 'btn primary', style: { height: '46px', padding: '0 26px' }, onclick: () => window.wa.add() }, '添加第一个账号'))));
}

// 编辑账号（新建和修改共用）
function editorPage(id) {
  liveColor = null;
  const root = h('div', { class: 'page' }, h('div', { class: 'col' }, h('p', { class: 'lead' }, '正在加载…')));
  window.wa.editorLoad(id).then((d) => {
    let color = d.color;
    let emoji = d.emoji;
    let tested = null;
    let mode = d.mode;
    // 主号：只能用网页版。已经是主号的不能在这里取消，要在别的号里勾选来更换
    const primary = h('input', { type: 'checkbox', checked: d.primary, disabled: d.primary && !d.isNew });
    const primaryText = d.primary && !d.isNew ? '要换主号，在另一个网页版账号里勾选。'
      : d.primaryName ? `现在的主号是「${d.primaryName}」，勾选后改为这个号。` : '';
    const primaryHint = primaryText ? h('span', { class: 'hint' }, primaryText) : null;
    const primaryRow = h('div', { class: 'field' }, '主号',
      h('label', { class: 'check-row' }, primary, h('span', null, '这是主号')), primaryHint);
    const liteConfirm = h('input', { type: 'checkbox' });
    const liteBox = h('div', { class: 'note bad lite-risk' },
      h('b', null, '轻量模式不是官方客户端'),
      h('span', null, 'WhatsApp 可能识别出来并封号，通常在几天到几周内。'),
      d.isNew ? h('label', { class: 'check-row' }, liteConfirm, h('span', null, '我知道这个号可能被封。我会先用不重要的号试用两周，再考虑用在正式号上。')) : null);
    const modeCard = (value, title, desc) => h('button', {
      type: 'button', class: `mode${mode === value ? ' on' : ''}`, 'aria-pressed': String(mode === value), 'data-mode': value,
      onclick: () => { if (!modeBtnDisabled(value)) { mode = value; onModeChange(); } },
    }, h('b', null, title), h('span', null, desc));
    const modeCards = h('div', { class: 'modes' },
      modeCard('web', '网页版（推荐）', '最稳，每个号约 300 MB 内存。'),
      modeCard('lite', '轻量模式', '每个号几十 MB，只收发文字，有封号风险。'));
    const modeBtnDisabled = (value) => value === 'lite' && (primary.checked || !d.liteAvailable);
    // 轻量模式卡片灰掉的原因直接写在下面，不只放在悬停提示里
    const liteReason = h('span', { class: 'hint' });
    const modeRow = d.isNew
      ? h('div', { class: 'field' }, '账号类型', modeCards, liteReason,
        !d.liteAvailable ? h('span', { class: 'hint' }, '这台电脑不支持加密保存，不能使用轻量模式。') : null)
      : h('div', { class: 'field' }, '账号类型', h('div', { class: 'tags' }, h('span', { class: 'tag' }, mode === 'lite' ? '轻量模式（添加后不能改）' : '网页版（添加后不能改）')));
    const name = h('input', { type: 'text', value: d.name, 'aria-label': '名称', maxlength: '40' });
    const note = h('input', { type: 'text', value: d.note || '', 'aria-label': '备注', maxlength: '200', placeholder: '可不填，例如：德国客户，小王负责' });
    const phone = h('input', { type: 'text', class: 'mono', value: d.phone || '', 'aria-label': '手机号', maxlength: '24', placeholder: '登录后自动填写，也可以自己填' });
    const proxyInput = h('input', { type: 'text', class: 'mono', value: d.proxy, placeholder: '留空表示直连，例如 socks5://127.0.0.1:7891', 'aria-label': '代理地址' });
    const password = h('input', { type: 'password', autocomplete: 'off', 'aria-label': '代理密码', placeholder: d.hasPassword ? '已保存，留空表示不修改' : '' });
    const passwordRow = h('label', { class: 'field' }, '代理密码', password);
    // 直连号才有：允许网页版通话（WebRTC 用 UDP 走本机网卡）
    const allowCalls = h('input', { type: 'checkbox', checked: d.allowCalls });
    const callsRow = h('div', { class: 'field' }, '通话',
      h('label', { class: 'check-row' }, allowCalls, h('span', null, '允许通话（直连号）')),
      h('span', { class: 'hint' }, '通话走这台电脑的真实 IP。Clash 开着“系统代理”时别打开，或者把 Clash 改成 TUN 模式。'));
    const result = h('div', { role: 'status' });
    const region = h('select', { 'aria-label': '地区' }, d.regions.map((r) => h('option', { value: r.key }, r.label)));
    // 预设里没有的出口时区（tz:...）：加一个选项放在最前面
    const addTzOption = (key, label) => {
      if (!key || !key.startsWith('tz:') || [...region.options].some((o) => o.value === key)) return;
      region.prepend(h('option', { value: key }, label || key));
    };
    addTzOption(d.region, d.regionLabel);
    region.value = d.region;
    const tags = h('div', { class: 'tags' });
    const error = h('div', { class: 'hint', role: 'alert', style: { color: 'var(--red-11)', minHeight: '18px' } });
    const swatches = h('div', { class: 'swatches' });
    const presets = h('div', { class: 'presets' });
    const testKey = `editorTest:${d.id || 'new'}:${s.editorNonce}`;
    morphDrop('editorTest:', testKey);
    const testBtn = morphBtn(testKey, { idle: '测试', busy: '测试中', ok: '通过', err: '未通过' }, () => runTest());
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, d.isNew ? '保存并扫码登录' : '保存');

    // 图标：名称输入框左边的方块，点开下面展开一整套 emoji，点一个就换上并收起
    let emojiOpen = false;
    const emojiBtn = h('button', { class: 'emoji-btn', type: 'button', onclick: () => { emojiOpen = !emojiOpen; drawEmoji(); } });
    const emojiGrid = h('div', { class: 'emoji-grid', role: 'group', 'aria-label': '选一个图标' });
    emojiGrid.addEventListener('keydown', (e) => { if (e.key === 'Escape') { emojiOpen = false; drawEmoji(); emojiBtn.focus(); } });
    const drawEmoji = () => {
      const cur = window.EMOJI.get(emoji);
      emojiBtn.replaceChildren(emojiImg({ emoji }, 24) || '?');
      emojiBtn.setAttribute('aria-label', `图标：${cur ? cur.name : '未选'}`);
      emojiBtn.setAttribute('aria-expanded', String(emojiOpen));
      emojiBtn.classList.toggle('on', emojiOpen);
      emojiGrid.hidden = !emojiOpen;
      emojiGrid.replaceChildren(...(emojiOpen ? window.EMOJI.LIST.map((x) => h('button', {
        class: `emoji-cell${x.id === emoji ? ' on' : ''}`, type: 'button', title: x.name,
        'aria-label': x.name, 'aria-pressed': String(x.id === emoji),
        onclick: () => { emoji = x.id; emojiOpen = false; drawEmoji(); emojiBtn.focus(); },
      }, emojiImg({ emoji: x.id }, 24))) : []));
    };
    const drawSwatches = () => swatches.replaceChildren(...COLORS.map((c, i) => h('button', {
      class: `swatch${c === color ? ' on' : ''}`, type: 'button', style: { background: c, '--c': c },
      'aria-label': COLOR_NAMES[i] + (c === color ? '，已选' : ''),
      onclick: () => { color = c; liveColor = c; document.body.style.background = tint(c); drawSwatches(); },
    })));
    // 本机 7890–7899 端口检测结果：{ 7891: { open, socks, usedBy } }；null 表示还在检测
    let portState = null;
    let probing = 0;
    const probePorts = async () => {
      const n = ++probing;
      try {
        const list = await window.wa.editorPorts(d.id);
        if (n !== probing) return;
        portState = Object.fromEntries(list.map((p) => [p.port, p]));
      } catch { if (n === probing) portState = {}; }
      drawPresets();
      drawPortNote();
    };
    const presetBtn = (label, v, status) => h('button', {
      class: `preset${proxyInput.value.trim() === v ? ' on' : ''}${status ? ` st-${status[0]}` : ''}`, type: 'button', title: status ? status[2] : null,
      onclick: () => {
        proxyInput.value = v;
        onProxyChange();
        // 带密码的模板：选中“用户名@代理IP:端口”，直接输入替换
        if (v.includes('用户名')) { proxyInput.focus(); proxyInput.setSelectionRange(7, v.length); }
      },
    }, label, status ? h('span', { class: 'pst' }, status[1]) : null);
    const drawPresets = () => {
      const cur = localProxyPort(proxyInput.value);
      const shown = PORT_RANGE.filter((p) => PORT_DEFAULT.includes(p) || (cur && cur.port === p)
        || (portState && portState[p] && ((portState[p].open && portState[p].socks) || portState[p].usedBy.length)));
      presets.replaceChildren(
        presetBtn('直连', ''),
        ...shown.map((p) => presetBtn(`Clash ${p}`, portUrl(p), portStatus(portState ? portState[p] : null))),
        presetBtn('带密码的 http', 'http://用户名@代理IP:端口'),
        h('button', { class: 'preset-refresh', type: 'button', title: '重新检测本机 7890–7899 端口', disabled: !portState, onclick: () => { portState = null; drawPresets(); drawPortNote(); probePorts(); } }, portState ? '重新检测' : '检测中…'));
    };
    // 选了（或手动填了）本机端口时，按检测结果说一句：没开怎么办、被谁用了、7890 是 Clash 主端口
    const portNote = h('div', { role: 'status' });
    const drawPortNote = () => {
      const cur = localProxyPort(proxyInput.value);
      const st = cur && portState ? portState[cur.port] : null;
      const lines = [];
      if (st && !st.open) {
        lines.push(h('div', { class: 'note bad' }, `${cur.port} 端口现在没开：要么 Clash 没开，要么还没在 Clash 里开这个端口。按 `, clashLink(), ` 加上这个端口，重新加载配置后点“重新检测”或“测试”。这样保存也可以，端口开好之前这个号会暂停联网，不会改用直连。`));
      } else if (st && cur.socks && !st.socks) {
        lines.push(h('div', { class: 'note bad' }, `${cur.port} 端口被别的程序占着，或者要密码，不能当 socks5 代理用。请换一个端口，详见 `, clashLink(), '。'));
      }
      if (st && st.usedBy.length) {
        lines.push(h('div', { class: 'note warn' }, `「${st.usedBy.join('」「')}」已经在用这个端口，两个号会是同一个出口 IP，有被关联的风险。建议给这个号单独开一个端口。`));
      }
      if (cur && cur.port === 7890 && (!st || st.open)) {
        lines.push(h('div', { class: 'note plain' }, '7890 一般是 Clash 自己的端口，跟着 Clash 界面上选的节点走，节点一换出口 IP 就变，也可能和直连号同一个 IP。建议按 ', clashLink(), ' 给这个号单独开一个端口。'));
      }
      portNote.replaceChildren(...lines);
      portNote.hidden = !lines.length;
    };
    const drawTags = () => {
      const opt = d.regions.find((r) => r.key === region.value) || (region.selectedOptions[0] && { label: region.selectedOptions[0].textContent });
      const auto = region.value === 'auto';
      tags.replaceChildren(
        h('span', { class: 'tag' }, auto ? '时区：还没识别，点“测试”自动选好' : `时区：${opt ? opt.label : ''}`),
        h('span', { class: 'tag' }, `界面语言：${d.uiLanguage || '中文'}`),
        h('span', { class: 'tag' }, '浏览器：Chrome，操作系统跟随本机'),
        h('span', { class: 'tag' }, proxyInput.value.trim() ? 'WebRTC 只走代理' : '直连：跟随系统代理'));
    };
    // 选直连时提醒一句，不拦。网页号直连跟随系统代理，轻量号直连用这台电脑的真实 IP，
    // 只有同一种直连的号才一定是同一个出口 IP
    const names = (list) => (list || []).map((n) => `「${n}」`).join('、');
    const webOthers = names(d.otherDirect);
    const liteOthers = names(d.otherLiteDirect);
    const liteDirectHint = h('span', { class: 'hint', style: { color: 'var(--amber-11)' } });
    const drawLiteDirect = () => {
      const direct = !proxyInput.value.trim();
      const lite = mode === 'lite';
      liteDirectHint.hidden = !(direct && (lite || webOthers));
      // 轻量号直连不用测试，“填了代理要先测试”那句只在填了代理时显示
      proxyHint.hidden = direct && lite;
      liteDirectHint.textContent = lite
        ? `提示：轻量号直连不经过系统代理，用这台电脑的真实 IP${liteOthers ? `，和${liteOthers}是同一个 IP` : ''}，有被关联的风险。`
        : `提示：和${webOthers}都是直连，都跟随系统代理，出口 IP 相同，有被关联的风险。`;
    };
    let testGeneration = 0;
    const invalidateTest = () => {
      testGeneration += 1; tested = null; result.replaceChildren();
      const key = testBtn.dataset.morph;
      const progress = morphState[key];
      if (progress && progress.st !== 'busy') {
        clearTimeout(progress.timer); delete morphState[key]; morphPaint(testBtn);
      }
    };
    const onProxyChange = () => {
      drawLiteDirect();
      passwordRow.hidden = !/^https?:\/\/[^/@]+@/i.test(proxyInput.value.trim());
      callsRow.hidden = mode === 'lite' || !!proxyInput.value.trim();
      invalidateTest();
      drawPresets();
      drawPortNote();
      drawTags();
    };
    const regionRow = h('label', { class: 'field' }, '时区', region, tags);
    // 有分组才出现：新号默认放进正在看的那个号所在的组
    const groupSel = h('select', { 'aria-label': '分组' }, h('option', { value: '' }, '未分组'), (d.groups || []).map((g) => h('option', { value: g.id }, g.name)));
    groupSel.value = d.groupId || '';
    const groupRow = d.groups && d.groups.length ? h('label', { class: 'field' }, '分组', groupSel) : null;
    const proxyHint = h('span', { class: 'hint' });
    const onModeChange = () => {
      invalidateTest();
      const lite = mode === 'lite';
      for (const b of modeCards.children) {
        const on = b.dataset.mode === mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
        b.disabled = modeBtnDisabled(b.dataset.mode);
        b.title = b.dataset.mode === 'lite' && primary.checked ? '主号只能用网页版' : '';
      }
      liteReason.textContent = !d.liteAvailable || !primary.checked ? ''
        : !d.primaryName ? '第一个号必须是网页版主号，之后添加的号才能选轻量模式。' : '主号只能用网页版；取消勾选下面的“这是主号”后可以选轻量模式。';
      proxyInput.placeholder = '留空表示直连，例如 socks5://127.0.0.1:7891';
      primaryRow.hidden = lite;
      regionRow.hidden = lite;
      callsRow.hidden = lite || !!proxyInput.value.trim();
      liteBox.hidden = !lite;
      proxyHint.replaceChildren(...(lite
        ? ['填了代理要先“测试”通过，出口 IP 不能和主号相同。带密码的代理请用 http://。']
        : ['代理连不上时这个号会暂停联网，不会改用直连。带密码的代理请用 http://。']));
      drawLiteDirect();
      sidePanel.replaceChildren(...sideText());
    };
    primary.addEventListener('change', () => { if (primary.checked && mode === 'lite') mode = 'web'; onModeChange(); });
    const sideText = () => (d.isNew
      ? [h('ol', null, h('li', null, '手机打开 WhatsApp'), h('li', null, '设置 › 已关联的设备'), h('li', null, '关联新设备，扫码'))]
      : [h('span', null, mode === 'lite' ? '修改代理后会重新连接，不需要重新扫码。' : '修改代理或时区后，这个账号的页面会重新加载，不需要重新扫码。')]);
    const sidePanel = h('div', { class: 'side-panel' });
    proxyInput.addEventListener('input', onProxyChange);
    password.addEventListener('input', invalidateTest);
    region.addEventListener('change', drawTags);

    const runTest = async () => {
      invalidateTest();
      const generation = testGeneration;
      const res = await window.wa.editorTest({ id: d.id, proxy: proxyInput.value, password: password.value, mode });
      if (generation !== testGeneration) return { ok: false };
      if (localProxyPort(proxyInput.value)) probePorts();
      if (res.error) { result.replaceChildren(h('div', { class: 'note bad' }, res.error, rawDetail(res.detail))); return { ok: false }; }
      tested = res;
      const where = [res.country, res.city].filter(Boolean).join(' ');
      const tail = `${where ? `，${where}` : ''}，用时 ${res.ms} ms。`;
      let text = `连接成功。出口 IP ${res.ip}${tail}`;
      if (res.direct === 'system') text = `直连，跟随系统代理。出口 IP ${res.ip}${tail}`;
      if (res.direct === 'real') text = `直连，用这台电脑的真实 IP ${res.ip}${tail}`;
      // 轻量号没有时区设置，不提时区
      if (mode !== 'lite' && res.region) { addTzOption(res.region, res.regionLabel); region.value = res.region; text += ' 已按出口所在地选好时区。'; } else if (mode !== 'lite') text += ' 出口时区无法识别，请手动选最接近的。';
      if (res.sameAs) {
        text += res.sameAt
          ? `\n注意：和「${res.sameAs}」上次测到（${new Date(res.sameAt).toLocaleString('zh-CN')}）的出口 IP 相同，两个号可能会被认为在同一个地方。`
          : `\n注意：和「${res.sameAs}」的出口 IP 相同，两个号会被认为在同一个地方。`;
      }
      if (res.direct === 'real') text += '\n轻量号直连不经过系统代理；想让它走 Clash，要开 Clash 的 TUN 模式。';
      result.replaceChildren(h('div', { class: `note ${res.sameAs ? 'bad' : 'ok'}`, style: { whiteSpace: 'pre-line' } }, text));
      drawTags();
      return { ok: true };
    };

    saveBtn.onclick = async () => {
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = '请填写名称'; name.focus(); return; }
      saveBtn.disabled = true;
      if (mode === 'lite' && d.isNew && !liteConfirm.checked) { error.textContent = '请先勾选风险确认'; saveBtn.disabled = false; return; }
      // 直连不用测试；填了代理的轻量号仍要先测试通过
      if (mode === 'lite' && proxyInput.value.trim() && !tested && (d.isNew || proxyInput.value.trim() !== d.proxy || password.value)) { error.textContent = '请先点“测试”，代理测试通过后才能保存'; saveBtn.disabled = false; return; }
      const res = await window.wa.editorSave({ id: d.id, name: name.value.trim(), note: note.value, phone: phone.value, color, emoji, proxy: proxyInput.value, password: password.value, region: region.value, mode, primary: mode === 'web' && primary.checked, liteConfirm: liteConfirm.checked, allowCalls: allowCalls.checked, groupId: groupRow ? groupSel.value : undefined });
      saveBtn.disabled = false;
      if (res && res.error) error.textContent = res.error;
    };

    drawSwatches();
    drawEmoji();
    onProxyChange();
    probePorts();
    // 去 Clash 里改完配置再切回来：自动重新检测一次（离开编辑页后自己移除）
    const onFocus = () => { if (!root.isConnected) { window.removeEventListener('focus', onFocus); return; } probePorts(); };
    window.addEventListener('focus', onFocus);
    // 有改动就告诉主进程：离开编辑页（切号、点通知等）前会先问一句
    let dirty = false;
    const markDirty = () => { if (!dirty) { dirty = true; window.wa.editorDirty(true); } };
    root.addEventListener('input', markDirty);
    root.addEventListener('change', markDirty);
    root.addEventListener('click', (e) => { if (e.target.closest('.swatch, .emoji-cell, .mode, .preset')) markDirty(); });
    root.replaceChildren(
      h('div', { class: 'col' },
        h('h1', null, d.isNew ? '添加账号' : '编辑账号'),
        h('div', { class: 'hstack name-row' },
          h('div', { class: 'field name-field' }, '名称', h('div', { class: 'hstack name-input' }, emojiBtn, name)),
          h('div', { class: 'field' }, '颜色', swatches)),
        emojiGrid,
        h('label', { class: 'field' }, '手机号', phone),
        h('label', { class: 'field' }, '备注', note),
        groupRow,
        modeRow,
        primaryRow,
        h('div', { class: 'field' },
          h('span', { class: 'field-head' }, '网络线路（代理）', h('a', { href: '#', class: 'help', onclick: (e) => { e.preventDefault(); window.wa.openLink(CLASH_DOC); } }, '怎么在 Clash 里开端口？')),
          presets, portNote, h('div', { class: 'hstack' }, proxyInput, testBtn), result, proxyHint, liteDirectHint),
        passwordRow,
        callsRow,
        regionRow,
        liteBox,
        error,
        h('div', { class: 'btns sticky-btns' }, h('button', { class: 'btn', type: 'button', onclick: () => window.wa.showPage('account', true) }, '取消'), saveBtn)),
      sidePanel);
    onModeChange();
    name.focus();
  });
  return root;
}

// ---------- 设置 ----------

function sw(on, label, onchange) {
  // 开关刚被拨过：小圆点从另一头滑过来
  const flip = fxChanged(`sw:${label}`, !!on, false);
  return h('button', { class: `switch${flip ? (on ? ' fx-sw-on' : ' fx-sw-off') : ''}`, role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, onclick: () => onchange(!on) });
}
function setRow(title, desc, control, extra) {
  // 只有标题的行：标题和右边的控件上下居中
  return h('div', { class: `setrow${desc || extra ? '' : ' solo'}` }, h('div', { class: 'meta' }, h('span', { class: 'title' }, title), desc ? h('span', { class: 'desc' }, desc) : null, extra), control);
}

// ---------- 连接记录 ----------
let netLogCache = [];
let netLogAt = 0;
let netFilter = '';
async function loadNetLog() {
  netLogAt = Date.now();
  try { netLogCache = await window.wa.netLog(); } catch { netLogCache = []; }
  if (s.page === 'settings' && settingsTab === 'net') render(true);
}
const NET_TEXT = {
  down: (e) => `连不上（${{ proxy: '代理', network: '网络' }[e.detail] || e.detail || '未知'}）`,
  up: (e) => `恢复了${e.ms ? `，断了 ${fmtDur(e.ms)}` : ''}`,
  qr: () => '掉线，需要重新扫码',
  login: () => '重新登录成功',
  crash: (e) => '页面崩溃，已自动重新打开',
  exit: (e) => `网络检测正常，用时 ${e.ms} ms`,
  exit_fail: () => '网络检测失败（代理没响应）',
};
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}
function netPage(page) {
  if (Date.now() - netLogAt > 10000) loadNetLog();
  const byId = new Map(s.accounts.map((a) => [a.id, a]));
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const filterSel = h('select', { 'aria-label': '只看某个号', onchange: (e) => { netFilter = e.target.value; render(true); } },
    h('option', { value: '' }, '全部账号'), s.accounts.map((a) => h('option', { value: a.id }, a.name)));
  filterSel.value = byId.has(netFilter) ? netFilter : '';
  const rows = netLogCache.filter((e) => !netFilter || e.id === netFilter).slice(0, 300);
  page.append(
    h('h1', null, '连接记录'),
    h('div', { class: 'box' }, s.accounts.map((a) => {
      const drops = netLogCache.filter((e) => e.id === a.id && e.at >= dayAgo && (e.kind === 'down' || e.kind === 'qr')).length;
      return h('div', { class: 'tr-prow' },
        h('span', null, mini(a), a.name),
        h('span', { class: 'hint' }, a.direct ? '直连' : a.latency ? `最近用时 ${a.latency.ms} ms` : '还没测过'),
        h('b', { style: { textAlign: 'right', color: drops ? 'var(--danger)' : null } }, `24 小时掉线 ${drops} 次`),
        h('span', { class: 'hint' }, a.problem ? a.problemShort : '正常'));
    })),
    h('div', { class: 'hstack', style: { justifyContent: 'space-between' } }, filterSel,
      netLogCache.length ? h('button', { class: 'btn', onclick: async () => { await window.wa.netLogClear(); loadNetLog(); } }, '清空记录') : null),
    rows.length
      ? h('div', { class: 'box ov-log' }, rows.map((e) => {
        const a = byId.get(e.id);
        const t = new Date(e.at);
        return h('div', { class: 'ov-logrow' },
          h('span', { class: 'hint ov-time' }, t.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
          mini(a),
          h('span', { class: 'ov-name', style: { flex: 'none', width: '110px' } }, a ? a.name : '已删除的号'),
          h('span', { class: `ov-name${['down', 'qr', 'crash', 'exit_fail'].includes(e.kind) ? ' bad-text' : ''}` }, (NET_TEXT[e.kind] || (() => e.kind))(e)));
      }))
      : h('div', { class: 'box' }, h('span', { class: 'hint' }, '还没有记录。')));
  return page;
}

// ---------- 设置 › 快捷设置 ----------
// 设置的第一页：把常用的开关从各分页挑出来。每个开关用的都是原分页那一个（同一个设置、同一个接口），两边一起变。
const goTab = (id) => { settingsTab = id; trSay = ''; render(true); };
function qkHead(title, tab) {
  return h('div', { class: 'qk-head' }, h('h2', { class: 'ov-h2' }, title),
    h('button', { class: 'link-btn qk-more', 'aria-label': `${title}的更多设置`, onclick: () => goTab(tab) }, '更多 ›'));
}
function qkTile(k, v, tone, sub, action) {
  return h('div', { class: 'qk-tile' },
    h('span', { class: 'qk-k' }, k),
    h('b', { class: `qk-v${tone ? ` ${tone}` : ''}` }, v),
    sub ? h('span', { class: 'qk-s' }, sub) : null,
    action instanceof Node ? action : action ? h('button', { class: 'link-btn qk-act', disabled: !!action.disabled, onclick: action.on }, action.label) : null);
}
function quickTiles() {
  const st = s.settings;
  // 内存
  const autoOn = st.autoRecycle !== false;
  const memTile = qkTile('内存', mb(s.totalMB || 0), autoOn && st.capMB > 0 && (s.totalMB || 0) > st.capMB ? 'bad' : '',
    autoOn && st.capMB > 0 ? `上限 ${mb(st.capMB)}` : '不设上限',
    memCleanBtn('link-btn qk-act'));
  // 翻译：默认服务商有没有填密钥
  let trTile;
  if (!tr.cfg) trTile = qkTile('翻译', '读取中…', '', '', null);
  else {
    const p = tr.cfg.providers.find((x) => x.id === tr.cfg.primaryId);
    if (!p) trTile = qkTile('翻译', '没设服务商', 'bad', '', { label: '去设置', on: () => goTab('translate') });
    else if (!p.hasKey) trTile = qkTile('翻译', '还没填密钥', 'bad', p.name, { label: '在下面填', on: () => { const el = document.querySelector('.qk-keys input'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } } });
    else trTile = qkTile('翻译', '可以用', 'ok', p.preset === 'deepl' ? p.name : `${p.name} ${p.model}`, { label: '查看', on: () => goTab('translate') });
  }
  // 隔离自检：显示这次打开软件后最近一次的结果（和自检页同一份）
  let ckTile;
  if (checkRunning) ckTile = qkTile('隔离自检', '检查中…', '', '', null);
  else if (!checkResult) ckTile = qkTile('隔离自检', '未检查', '', '', { label: '开始检查', disabled: !s.accounts.length, on: runCheckNow });
  else {
    const bad = checkResult.items.filter((c) => c.level === 'bad').length;
    const warn = checkResult.items.filter((c) => c.level === 'warn').length;
    const at = `${String(checkResult.time).split(' ').pop().slice(0, 5)} 查的`;
    if (bad || warn) ckTile = qkTile('隔离自检', bad ? `${bad} 个问题` : `${warn} 个提醒`, bad ? 'bad' : 'warn', at, { label: '查看', on: () => goTab('check') });
    else ckTile = qkTile('隔离自检', '全部通过', 'ok', at, { label: '再查一次', on: runCheckNow });
  }
  // 版本和检查更新
  const u = s.update;
  const ust = u ? u.status : 'dev';
  const usub = {
    dev: '开发版不检查更新', off: '这种安装方式不能自动更新', checking: '正在检查…',
    downloading: `正在下载 ${u && u.version}`, downloaded: `${u && u.version} 已就绪`, none: '已是最新', error: '上次没检查成功', idle: '每 6 小时自动检查',
  }[ust] || '';
  const upTile = qkTile('版本', (s.about && s.about.version) || '', ust === 'downloaded' ? 'ok' : '', usub,
    ust === 'downloaded' ? { label: '去更新', on: () => goTab('about') }
      : { label: '检查更新', disabled: ['dev', 'off', 'checking', 'downloading'].includes(ust), on: () => window.wa.updateCheckOnly() });
  return h('div', { class: 'qk-tiles' }, memTile, trTile, ckTile, upTile);
}
function quickPage(page) {
  const st = s.settings;
  if (!tr.cfg) trLoad();
  const apply = (r) => { tr.cfg = r.config; tr.modes = r.modes; if (r.error) trSay = r.error; render(true); };
  page.append(...kids(
    h('h1', null, '快捷设置'),
    quickTiles(),
    memClean.result ? h('span', { class: 'hint', role: 'status' }, memClean.result) : null,
    h('div', null,
      qkHead('消息提醒', 'notify'),
      setRow('提示音', '',
        sw(st.popupSound !== false, '弹窗提示音', (v) => window.wa.setSetting('popupSound', v))),
      setRow('弹窗自动消失', '',
        h('select', { 'aria-label': '弹窗自动消失时间', onchange: (e) => window.wa.setSetting('popupSeconds', Number(e.target.value)) },
          (s.popupChoices || [4, 6, 10, 0]).map((n) => h('option', { value: String(n), selected: st.popupSeconds === n }, n ? `${n} 秒` : '不自动消失'))))),
    h('div', null,
      qkHead('锁定和窗口', 'general'),
      setRow('聊天锁', '',
        h('span', { class: 'hstack', style: { gap: '8px', flex: 'none' } },
          h('select', { 'aria-label': '聊天锁等待时间', onchange: (e) => window.wa.setSetting('lockMinutes', Number(e.target.value)) },
            (s.lockChoices || [0, 5]).map((m) => h('option', { value: String(m), selected: st.lockMinutes === m }, m ? `${m} 分钟` : '关闭'))),
          h('button', { class: 'btn', disabled: !s.accounts.length, title: s.accounts.length ? '' : '还没有账号', onclick: () => window.wa.lock(true) }, '立即锁定'))),
      s.canLoginItem ? setRow('开机自动启动', '',
        sw(st.openAtLogin, '开机自动启动', (v) => window.wa.setSetting('openAtLogin', v))) : null),
    h('div', { class: 'qk-keys' },
      qkHead('翻译密钥', 'translate'),
      trSay ? h('div', { class: 'hint', role: 'status', style: { marginBottom: '8px' } }, trSay) : null,
      tr.cfg && !tr.cfg.canEncrypt ? h('div', { class: 'tr-warn' }, '这台电脑不支持加密保存，暂时不能保存密钥。') : null,
      tr.cfg ? trKeysBox(tr.cfg, apply) : h('div', { class: 'box' }, h('span', { class: 'hint' }, '加载中…'))),
    h('div', null,
      qkHead('内存', 'memory'),
      setRow('自动回收后台账号', '不退出登录，不漏消息。',
        sw(st.autoRecycle !== false, '自动回收后台账号', (v) => window.wa.setSetting('autoRecycle', v))))));
}

function settingsPage() {
  const st = s.settings;
  const page = h('div', { class: 'page narrow' });
  if (settingsTab === 'quick') {
    quickPage(page);
  } else if (settingsTab === 'memory') {
    const max = Math.max(800, ...s.accounts.map((a) => a.memMB || 0));
    const autoOn = st.autoRecycle !== false;
    const select = h('select', { 'aria-label': '单个账号刷新线', onchange: (e) => window.wa.setSetting('recycleMB', Number(e.target.value)) },
      [0, ...s.recycleChoices].map((n) => h('option', { value: n }, n ? `${n} MB` : '不限')));
    select.value = String(st.recycleMB ?? 1024);
    const capSelect = h('select', { 'aria-label': '总内存上限', onchange: (e) => window.wa.setSetting('capMB', Number(e.target.value)) },
      (s.capChoices || [0, 4096]).map((n) => h('option', { value: n }, n ? mb(n) : '不限')));
    capSelect.value = String(st.capMB ?? 4096);
    const over = autoOn && st.capMB > 0 && (s.totalMB || 0) > st.capMB;
    page.append(
      h('h1', null, '内存'),
      h('div', { class: 'box' },
        h('div', { class: 'hstack', style: { justifyContent: 'space-between' } }, h('b', null, '当前占用'),
          h('b', { style: { fontSize: 'var(--fs-xl)' } }, mb(s.totalMB || 0), autoOn && st.capMB > 0 ? h('span', { class: over ? 'bad-text' : 'hint', style: { fontSize: 'var(--fs-s)', fontWeight: 'normal' } }, ` / 上限 ${mb(st.capMB)}`) : null)),
        s.accounts.map((a) => h('div', { class: 'memrow' },
          h('span', { class: 'memname', title: a.name }, mini(a), a.name),
          h('span', { class: 'bar' }, h('span', { style: { width: `${((a.memMB || 0) / max) * 100}%`, background: a.color } })),
          h('b', { style: { textAlign: 'right' } }, `${a.memMB || 0} MB`),
          h('span', { class: 'hint' }, a.problem ? a.problemShort : a.mode === 'lite' ? '轻量模式' : a.id === s.activeId ? '正在看' : '后台')))),
      setRow('立即清理内存', '不退出登录，不漏消息。',
        memCleanBtn('btn'),
        memClean.result ? h('span', { class: 'hint', role: 'status' }, memClean.result) : null),
      setRow('自动回收后台账号', '不影响当前和有未读的账号。',
        sw(autoOn, '自动回收后台账号', (v) => window.wa.setSetting('autoRecycle', v)),
        autoOn ? h('div', { class: 'col', style: { gap: '2px' } },
          h('label', { class: 'inline' }, '单个后台账号超过', select, '时自动刷新'),
          h('label', { class: 'inline' }, '所有账号加起来超过', capSelect, '时刷新占用最多的'),
          st.capMB > 0 && s.capAdvice ? h('span', { class: 'inline', role: 'status' },
            h('span', { class: 'bad-text' }, '账号多，总上限够不着，现在不起作用。'),
            h('button', { class: 'btn', style: { height: '28px', padding: '0 12px' }, onclick: () => window.wa.setSetting('capMB', 0) }, '改为不限')) : null) : null),
      setRow(h('span', null, '省内存模式 ', h('span', { class: 'badge-warn' }, '重启后生效')), '滚动可能变慢。',
        h('span', { class: 'hstack', style: { gap: '10px' } },
          s.restartNeeded ? h('button', { class: 'btn primary', style: { height: '32px', padding: '0 14px' }, onclick: () => window.wa.restart() }, '立即重启') : null,
          sw(st.lowMemoryMode, '省内存模式', (v) => window.wa.setSetting('lowMemoryMode', v)))),
      setRow('磁盘缓存',
        `${cacheInfo.mb === null ? '' : `约 ${mb(cacheInfo.mb)}。`}不退出登录，不删聊天记录。`,
        morphBtn('cacheClean', { idle: '清空', busy: '清空中', ok: '完成', err: '失败' }, async () => {
          cacheInfo.busy = true; cacheInfo.result = ''; render(true);
          const r = await window.wa.clearCache();
          cacheInfo.busy = false;
          if (r.error) cacheInfo.result = r.error;
          else {
            cacheInfo.mb = r.afterMB;
            cacheInfo.at = Date.now();
            cacheInfo.result = `至少释放了 ${mb(r.freedMB)}${r.skipped ? `，${r.skipped} 个正在出错或加载的账号这次跳过了` : ''}。`;
          }
          render(true);
          return { ok: !r.error };
        }, { disabled: cacheInfo.busy || !s.accounts.length }),
        cacheInfo.result ? h('span', { class: 'hint', role: 'status' }, cacheInfo.result) : null));
    refreshCacheSize();
  } else if (settingsTab === 'notify') {
    page.append(
      h('h1', null, '通知'),
      h('div', null,
        setRow('弹窗自动消失', '',
          h('select', { 'aria-label': '弹窗自动消失时间', onchange: (e) => window.wa.setSetting('popupSeconds', Number(e.target.value)) },
            (s.popupChoices || [4, 6, 10, 0]).map((n) => h('option', { value: String(n), selected: st.popupSeconds === n }, n ? `${n} 秒` : '不自动消失')))),
        setRow('提示音', '',
          sw(st.popupSound !== false, '弹窗提示音', (v) => window.wa.setSetting('popupSound', v))),
        setRow('勿扰', '掉线、退出登录、有新版本照样提醒，不响。',
          sw(!!st.popupDnd, '勿扰', (v) => window.wa.setSetting('popupDnd', v))),
        setRow('测试通知', '',
          h('button', { class: 'btn', disabled: !!st.popupDnd, title: st.popupDnd ? '勿扰开着，先关掉勿扰' : '', onclick: () => window.wa.popupTest() }, '发送'))),
      h('h2', { class: 'ov-h2' }, '接收通知的账号'),
      h('div', null, s.accounts.length ? s.accounts.map((a) => h('div', { class: 'setrow', style: { alignItems: 'center' } },
        avatarOf(a),
        h('span', { class: 'meta' }, a.name),
        sw(!a.muted, `${a.name}的通知`, (v) => window.wa.setMuted(a.id, !v)))) : h('p', { class: 'lead' }, '还没有账号。')));
  } else if (settingsTab === 'general') {
    page.append(h('h1', null, '通用'),
      h('div', null,
        setRow('关闭窗口时缩到托盘', '',
          sw(st.closeToTray, '关闭窗口时缩到托盘', (v) => window.wa.setSetting('closeToTray', v))),
        s.canLoginItem ? setRow('开机自动启动', '',
          sw(st.openAtLogin, '开机自动启动', (v) => window.wa.setSetting('openAtLogin', v))) : null,
        setRow('显示检查更新按钮', '在侧栏底部齿轮旁边。',
          sw(st.showUpdateButton, '显示检查更新按钮', (v) => window.wa.setSetting('showUpdateButton', v))),
        setRow('聊天锁', '',
          h('select', { 'aria-label': '聊天锁等待时间', onchange: (e) => window.wa.setSetting('lockMinutes', Number(e.target.value)) },
            (s.lockChoices || [0, 5]).map((m) => h('option', { value: String(m), selected: st.lockMinutes === m }, m ? `${m} 分钟` : '关闭')))),
        setRow('快捷键', `${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + 1 到 9 切换到第几个账号；${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + L 立即锁定聊天。`, h('span'))));
  } else if (settingsTab === 'net') {
    netPage(page);
  } else if (settingsTab === 'translate') {
    translatePage(page);
  } else if (settingsTab === 'team') {
    page.append(teamPage(s.team, s.accounts));
  } else if (settingsTab === 'mcp') {
    mcpPage(page, s.mcp);
  } else if (settingsTab === 'check') {
    // 打开自检页就直接开始查（这次打开软件后还没查过时），不先给一个空白页加按钮
    if (!checkResult && !checkRunning && !checkAutoRan && s.accounts.length) { checkAutoRan = true; setTimeout(runCheckNow, 0); }
    const run = h('button', { class: 'btn primary', disabled: checkRunning || !s.accounts.length, onclick: runCheckNow }, checkRunning ? '检查中…' : (checkResult ? '重新检查' : '开始检查'));
    page.append(
      h('div', { class: 'hstack', style: { justifyContent: 'space-between', alignItems: 'flex-start' } },
        h('h1', null, '隔离自检'),
        run));
    if (checkResult) {
      page.append(h('div', { class: 'checks' }, checkResult.items.map((c) => h('div', { class: 'check' },
        h('span', { class: `mark${c.level === 'bad' ? ' bad' : c.level === 'warn' ? ' warn' : ''}` }, c.level === 'ok' ? '✓' : '!'),
        h('span', { class: 'meta' }, h('span', null, c.title), c.detail ? h('span', { class: 'hint' }, c.detail) : null, rawDetail(c.raw),
          c.fix ? h('span', null, h('button', { class: 'btn', style: { height: '30px', padding: '0 14px', marginTop: '4px' }, onclick: async (e) => {
            e.currentTarget.disabled = true;
            const r = await window.wa.checkFix(c.fix.id, c.fix.region);
            if (r && r.ok) { c.level = 'ok'; c.detail = `已改成「${c.fix.label}」，页面已重新加载。`; c.fix = null; }
            render(true);
          } }, `地区改成 ${c.fix.label}`)) : null,
          c.logs ? h('span', null, h('button', { class: 'btn', style: { height: '30px', padding: '0 14px', marginTop: '4px' }, onclick: () => window.wa.openLogs() }, '打开日志文件夹')) : null)))),
      h('span', { class: 'hint' }, `检查时间：${checkResult.time}`));
    }
  } else {
    const a = s.about;
    page.append(
      h('div', { class: 'hstack', style: { gap: '18px' } },
        h('img', { class: 'about-icon', src: '../../assets/icon.png', alt: '', width: '64', height: '64' }),
        h('div', { class: 'col', style: { gap: '2px' } }, h('h1', null, 'WAswitch'), h('span', { class: 'hint', style: { fontSize: 'var(--fs-m)' } }, `版本 ${a.version}`))),
      h('div', { class: 'kv' },
        h('span', null, '浏览器版本'), h('span', null, `Chrome ${a.chrome}`),
        h('span', null, '源码'), h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.wa.openSource(); } }, 'github.com/Kr1xxxx/WAswitch')),
        ...(s.team && !s.team.joined ? [h('span', null, '团队'), h('span', null, h('button', { class: 'link-btn', type: 'button', onclick: () => { settingsTab = 'team'; render(true); } }, '加入团队…'))] : [])),
      updateBox(s.update),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => window.wa.openLogs() }, '打开日志文件夹'),
        h('button', { class: 'btn', onclick: () => window.wa.openTrDir() }, '打开译文文件夹')));
  }
  return page;
}

// ---------- 设置 › AI 接口（MCP） ----------
// MCP 不在安装包里：先下载（校验 sha512），下载后开关默认关，要自己打开。
function mcpUninstallRow() {
  return setRow('卸载 MCP', '断开所有 AI 客户端，删掉下载的文件，设置会留着。',
    h('button', { class: 'btn', onclick: () => window.wa.mcpUninstall() }, '卸载'));
}
function mcpPage(page, m) {
  page.append(h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, 'AI 接口（MCP）'),
    h('p', { class: 'lead' }, '让 Claude 这类 AI 助手连上 WAswitch。AI 不能自己发消息。')));
  if (!m || m.status === 'unavailable') {
    page.append(h('div', { class: 'note warn' }, '这个版本没带 MCP 的下载信息。更新到新版后就能下载。'));
    return;
  }
  const rows = h('div');
  if (m.legacy) page.append(h('div', { class: 'note warn' }, 'MCP 现在要单独下载。你之前开着 MCP：下载后在这里重新打开，AI 客户端里的连接命令或配置也要重新复制一次。'));
  if (m.status === 'none' || m.status === 'error') {
    rows.append(setRow('下载 MCP', `约 ${m.sizeMB} MB`,
      h('button', { class: 'btn primary', onclick: () => window.wa.mcpDownload() }, m.status === 'error' ? '重试' : '下载')));
    if (m.status === 'error') rows.append(h('div', { class: 'note bad', role: 'status' }, `${m.error}${m.updating ? ' 软件更新后要配套的新版 MCP，30 分钟后会自动再试。' : ''}`));
  } else if (m.status === 'downloading') {
    rows.append(h('div', { class: 'update-box busy', role: 'status' },
      h('div', { class: 'upd-main' },
        h('span', { class: 'upd-mark' }, h('span', { class: 'spin', 'aria-hidden': 'true' })),
        h('div', { class: 'upd-text' }, h('b', null, m.updating ? `软件更新了，正在下载配套的 MCP ${m.version}` : `正在下载 MCP ${m.version}`)),
        h('button', { class: 'btn', onclick: () => window.wa.mcpCancel() }, '取消')),
      h('div', { class: 'upd-progress' },
        h('div', { class: 'progress' }, h('span', { style: { width: `${m.percent}%` } })),
        h('span', { class: 'pct' }, `${m.percent}%`))));
  } else {
    // ready（已下载）或 dev（从源码运行）
    rows.append(...[
      setRow('开启 MCP', m.running ? `运行中：${m.url}` : '',
        sw(m.enabled, '开启 MCP', (v) => window.wa.mcpEnable(v))),
      m.runError ? h('div', { class: 'note bad', role: 'status' }, `没能开启：${m.runError}`) : null,
      setRow('详细设置', '',
        h('button', { class: 'btn', onclick: () => window.wa.mcpOpen() }, '打开…')),
      m.status === 'dev' ? null : mcpUninstallRow(),
    ].filter(Boolean));
  }
  if (m.status === 'error' && m.installed) rows.append(mcpUninstallRow());
  page.append(rows);
  page.append(h('span', { class: 'hint' }, m.status === 'dev' ? '开发版：直接用源码里的 MCP，不下载。' : `MCP ${m.version}，跟着软件一起更新。`));
}

// ---------- 设置 › 团队 ----------
// 同步到 CRM：只显示条数，不显示内容
function crmBox(accounts, upload) {
  const list = accounts.filter((a) => a.team && (a.crm || a.crmWanted));
  if (!list.length) return null;
  const last = upload && upload.at
    ? `上次上传：${new Date(upload.at).toLocaleString('zh-CN', { hour12: false })}${upload.error ? `（${upload.error}）` : '（成功）'}`
    : '还没有上传过';
  return h('div', { class: 'col', style: { gap: '6px' } }, h('b', null, '同步到 CRM'),
    h('p', { class: 'hint', style: { margin: '0' } }, '这些号的单聊文字消息每 10 分钟同步到公司 CRM。群聊不同步；网页版的号只同步你打开过的对话。'),
    h('p', { class: 'hint', style: { margin: '0', fontSize: 'var(--fs-s)' } }, last),
    list.map((a) => h('div', { class: 'setrow', style: { alignItems: 'center', padding: '6px 0' } },
      avatarOf(a, a.crm ? ' crm' : ''),
      h('span', { class: 'meta crm-name', title: a.name }, a.name),
      h('span', { class: 'hint crm-note', style: { fontSize: 'var(--fs-s)' } }, a.crm
        ? `本机排队 ${a.crm.queued} 条${a.crm.skipped ? `，${a.crm.skipped} 条认不出对方号码（没有同步）` : ''}${a.crm.notime ? `，${a.crm.notime} 条打开对话前就有、读不出时间（没有同步）` : ''}`
        : '这台电脑不能加密保存，没有采集'))));
}

function teamPage(t, accounts = []) {
  const wrap = h('div', { class: 'col', style: { gap: '16px' } });
  if (!t) return wrap;
  const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '还没有');
  const fieldList = (title, items) => h('div', { class: 'col', style: { gap: '4px' } }, h('b', null, title), h('ul', { style: { margin: '0', paddingLeft: '20px' } }, items.map((x) => h('li', { class: 'hint', style: { fontSize: 'var(--fs-s)' } }, x))));
  const result = teamForm.result ? h('div', { class: `note ${teamForm.result.startsWith('✓') ? 'ok' : 'bad'}`, role: 'status' }, teamForm.result, teamForm.result.startsWith('✓') ? null : rawDetail(teamForm.detail)) : null;
  wrap.append(h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '团队'),
    h('p', { class: 'lead' }, '登记后，管理员可以给你分配账号、查看每个号的状态。')));

  if (t.joined && !t.revoked) {
    const ok = !t.offline && !t.lastError;
    wrap.append(...kids(
      h('div', { class: 'kv' },
        h('span', null, '后台地址'), h('span', { class: 'mono', style: { fontSize: 'var(--fs-s)', wordBreak: 'break-all' } }, t.server),
        h('span', null, '团队账号'), h('span', null, `${t.teamCount} 个`),
        h('span', null, '上次同步'), h('span', null, when(t.lastOkAt)),
        h('span', null, '私人号'), h('span', null, t.allowPrivate ? '允许保留' : '管理员不允许，私人号已暂停并隐藏（数据没删）')),
      ok ? null : h('div', { class: 'note warn' }, `${t.lastError || '后台暂时连不上'}。账号照常收发，连上后自动补上。`, rawDetail(t.lastErrorDetail)),
      t.held ? h('div', { class: 'note warn' }, `后台要一次收回 ${t.held} 个号，数量太多，先暂停，等管理员确认。`) : null,
      h('div', { class: 'btns' },
        morphBtn('teamSync', { idle: '立即同步', busy: '同步中', ok: '已同步', err: '失败' }, async () => {
          teamForm.result = ''; render(true);
          const r = await window.wa.teamSync();
          teamForm.result = r && r.ok ? '' : (r && r.error) || '同步没成功'; teamForm.detail = (r && r.detail) || '';
          render(true);
          return { ok: !!(r && r.ok) };
        }),
        h('button', { class: 'btn', onclick: () => { teamForm.showUpload = !teamForm.showUpload; render(true); } }, teamForm.showUpload ? '收起上传内容' : '查看上传内容')),
      result,
      teamForm.showUpload ? h('pre', { class: 'mono note plain', style: { whiteSpace: 'pre-wrap', fontSize: 'var(--fs-s)', maxHeight: '320px', overflow: 'auto' } }, t.lastUpload || '还没有上传过。') : null));
    if (t.privateAccounts.length && t.allowPrivate) {
      wrap.append(h('div', { class: 'col', style: { gap: '6px' } }, h('b', null, '没加入团队的号'),
        t.privateAccounts.map((a) => h('div', { class: 'setrow', style: { alignItems: 'center', padding: '8px 0' } },
          avatarOf(a),
          h('span', { class: 'meta' }, a.name),
          h('button', { class: 'btn', onclick: async () => {
            const r = await window.wa.teamJoin([a.id]);
            teamForm.result = r && r.ok ? `✓ 「${a.name}」已加入团队` : (r && r.error) || '加入没成功'; teamForm.detail = (r && r.detail) || '';
            render(true);
          } }, '加入团队')))));
    }
    wrap.append(...[crmBox(accounts, t.crmUpload)].filter(Boolean), fieldList('会上传的内容', t.uploadFields), fieldList('不会上传的内容', t.neverUpload));
    return wrap;
  }

  if (t.revoked) wrap.append(h('div', { class: 'note bad' }, '这台电脑已被管理员停用，团队号已暂停并隐藏（数据还在）。私人号不受影响。要恢复请找管理员。'));
  if (!t.canEncrypt) {
    wrap.append(h('div', { class: 'note bad' }, '这台电脑不支持加密保存，不能登记到团队。'));
    return wrap;
  }
  if (teamForm.picked === null) teamForm.picked = new Set(t.privateAccounts.map((a) => a.id));
  const input = (key, attrs) => h('input', { type: 'text', value: teamForm[key], oninput: (e) => { teamForm[key] = e.target.value; }, ...attrs });
  const consent = h('input', { type: 'checkbox', checked: teamForm.consent, onchange: (e) => { teamForm.consent = e.target.checked; render(true); } });
  wrap.append(...kids(
    h('label', { class: 'field' }, '后台地址', input('server', { class: 'mono', placeholder: 'https://team.example.com', 'aria-label': '后台地址' })),
    h('label', { class: 'field' }, '登记码', input('code', { class: 'mono', placeholder: 'XXXXX-XXXXX', 'aria-label': '登记码', maxlength: '11' })),
    h('label', { class: 'field' }, '电脑名字', input('deviceName', { placeholder: '例如：前台 1 号机', maxlength: '40', 'aria-label': '电脑名字' })),
    t.privateAccounts.length ? h('div', { class: 'field' }, '加入团队的账号',
      t.privateAccounts.map((a) => h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: teamForm.picked.has(a.id), onchange: (e) => { if (e.target.checked) teamForm.picked.add(a.id); else teamForm.picked.delete(a.id); } }),
        a.name))) : null,
    h('div', { class: 'box' }, fieldList('登记后会上传', t.uploadFields), fieldList('不会上传', t.neverUpload),
      h('label', { class: 'check-row' }, consent, '我看过上面的清单，同意上传这些内容')),
    h('div', { class: 'btns' }, morphBtn('teamEnroll', { idle: '登记', busy: '登记中', err: '失败' }, async () => {
      teamForm.busy = true; teamForm.result = ''; render(true);
      const r = await window.wa.teamEnroll({ server: teamForm.server, code: teamForm.code, deviceName: teamForm.deviceName, localIds: [...teamForm.picked], consent: teamForm.consent });
      teamForm.busy = false;
      teamForm.result = r && r.ok ? '✓ 已登记到团队' : (r && r.error) || '登记没成功'; teamForm.detail = (r && r.detail) || '';
      if (r && r.ok) { teamForm.code = ''; teamForm.picked = null; }
      render(true);
      return { ok: !!(r && r.ok) };
    }, { class: 'btn primary', disabled: !teamForm.consent })),
    result));
  return wrap;
}

// 关于页里的“软件更新”：状态图标、标题、进度条、上次检查的时间和结果。连续失败 3 次标黄
function updateBox(u) {
  if (!u) return null;
  const when = u.lastCheckAt ? new Date(u.lastCheckAt).toLocaleString('zh-CN', { hour12: false }) : '还没检查过';
  const [title, line, tone] = {
    dev: ['开发版不检查更新', '', 'idle'],
    off: ['不支持自动更新', '请到下载页下载新版。', 'idle'],
    idle: ['自动更新已开启', '', 'idle'],
    checking: ['正在检查更新…', '', 'busy'],
    none: ['已是最新版本', '', 'ok'],
    downloading: [`正在下载 ${u.version}`, u.userAsked ? (u.manual ? '下载完会自动打开安装包。' : '下载完，等你 30 秒没打字就自动重启并安装，账号和聊天都在。') : '', 'busy'],
    downloaded: u.manual
      ? [`新版本 ${u.version} 已就绪`, `已下载并校验通过。${u.mac ? 'WAswitch 不在「应用程序」里或没有写入权限，没法自动替换：' : ''}打开安装包，把新的 WAswitch 拖进“应用程序”替换旧版。`, 'new']
      : [`新版本 ${u.version} 已就绪`, u.waitReason ? `你停手 30 秒后会自动重启（现在${u.waitReason}），也可以现在重启。账号和聊天都在。` : '空闲时会自动安装，也可以现在重启。账号和聊天都在。', 'new'],
    error: ['这次检查没成功', '会在 6 小时后自动再试。', 'idle'],
  }[u.status] || ['软件更新', '', 'idle'];
  const t = u.warn ? 'warn' : tone;
  const busy = ['checking', 'downloading'].includes(u.status);
  const mark = t === 'ok' ? icon('check', 18) : t === 'warn' ? icon('warn', 18) : t === 'busy' ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : icon('update', 18);
  const action = u.status === 'dev' || u.status === 'off' || (u.status === 'downloading' && u.userAsked) ? null
    : u.status === 'downloading' ? h('button', { class: 'btn', onclick: () => window.wa.updateCheck() }, '下好后自动重启')
    : u.status === 'downloaded'
      ? h('button', { class: 'btn primary', onclick: () => window.wa.updateInstall() }, u.manual ? '打开安装包' : '现在重启并更新')
      : morphBtn('updateCheck', { idle: '检查并更新', busy: '检查中' }, () => window.wa.updateCheck(), { busy });
  return h('div', { class: `update-box ${t}`, role: 'status' },
    h('div', { class: 'upd-main' },
      h('span', { class: 'upd-mark' }, mark),
      h('div', { class: 'upd-text' }, h('span', { class: 'upd-label' }, '软件更新'), h('b', null, title), line ? h('span', null, line) : null),
      action),
    u.status === 'downloading' ? h('div', { class: 'upd-progress' },
      h('div', { class: 'progress' }, h('span', { style: { width: `${u.percent}%` } })),
      h('span', { class: 'pct' }, `${u.percent}%`)) : null,
    u.warn ? h('div', { class: 'note warn' }, `连续 ${u.failures} 次没检查成功，可能是网络问题。可以去下载页手动下载。`) : null,
    u.status === 'dev' ? null : h('span', { class: 'hint upd-foot' }, `上次检查：${when}${u.lastResult ? `，${u.lastResult}` : ''}`),
    u.status === 'error' ? rawDetail(u.lastDetail) : null);
}

// ---------- 总渲染 ----------

// ---------- 聊天锁 ----------

let lockEl = null;
function lockPage() {
  if (lockEl) return lockEl;
  const thumb = h('button', { class: 'lock-thumb', type: 'button', 'aria-label': '向右拖动解锁（也可以按回车）' }, icon('next', 16));
  const track = h('div', { class: 'lock-track' }, h('span', { class: 'lock-text' }, '向右滑动解锁'), thumb);
  let startX = null;
  let dx = 0;
  const max = () => track.clientWidth - thumb.offsetWidth - 8;
  const place = (x) => { dx = Math.max(0, Math.min(max(), x)); thumb.style.transform = `translateX(${dx}px)`; track.style.setProperty('--p', String(dx / Math.max(1, max()))); };
  const unlock = () => window.wa.lock(false);
  thumb.addEventListener('pointerdown', (e) => { startX = e.clientX - dx; thumb.setPointerCapture(e.pointerId); thumb.classList.add('drag'); });
  thumb.addEventListener('pointermove', (e) => { if (startX !== null) place(e.clientX - startX); });
  const end = () => {
    if (startX === null) return;
    startX = null;
    thumb.classList.remove('drag');
    if (dx >= max() * 0.85) { place(max()); unlock(); } else place(0);
  };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('pointercancel', end);
  thumb.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 滑块不会有输入法选字，这行是为了所有回车处理一个写法（check:ime-enter）
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); unlock(); }
  });
  lockEl = h('div', { class: 'lockpage' },
    h('div', { class: 'lock-card' },
      h('span', { class: 'lock-icon' }, icon('lock', 22)),
      h('h1', null, '聊天已锁定'),
      h('p', { class: 'lead' }, '消息照常接收。'),
      track));
  // 每次重新锁上时：滑块回到最左，焦点放到滑块上（按回车也能解锁）
  lockEl.reset = () => { startX = null; place(0); requestAnimationFrame(() => thumb.focus()); };
  return lockEl;
}

// 锁着时只盖住账号页面（网页版和轻量模式的聊天）和翻译页，设置、编辑、总览这些页面照常能打开使用。
// 锁定状态一直保留：从设置页切回任何账号，看到的还是锁屏卡片，要右滑解锁才能看聊天
function renderLock() {
  // 翻译页也盖住：译文和最近记录里有客户原话
  const on = !!s.locked && (s.page === 'account' || s.page === 'translate');
  const was = !$lock.hidden;
  $lock.hidden = !on;
  $content.hidden = on;
  if (on && !was) {
    const el = lockPage();
    if ($lock.firstChild !== el) $lock.replaceChildren(el);
    el.reset();
    fxPlay(el, 'fx-fade');
  }
}

function render(forceContent = false) {
  document.body.style.setProperty('--side', s.collapsed && s.page !== 'settings' ? '64px' : '200px');
  document.body.classList.toggle('collapsed', s.collapsed && s.page !== 'settings');
  const acc = active();
  if (s.page !== 'editor') liveColor = null;
  document.body.style.background = s.page === 'account' && acc ? tint(acc.color) : s.page === 'editor' ? tint(liveColor || s.editorColor) : 'var(--slate-3)';
  renderSide();
  renderAi();
  renderTop();
  renderLock();
  renderPanel();
  placeUndo(); // 换页、开关面板以后“撤销”跟着挪
  // 刚进 设置 › 翻译：重新读一次配置（面板或悬浮窗里可能拨过某个号的自动翻译）
  const onTr = s.page === 'settings' && (settingsTab === 'translate' || settingsTab === 'quick');
  if (fxChanged('tr-view', onTr, false) && onTr && tr.cfg) trLoad();

  // 卡片内容：账号页每次都画（很轻）；编辑页只在打开时画一次，避免打字时被重置
  const key = s.page === 'editor' ? `editor:${s.editorId || 'new'}:${s.editorNonce}` : s.page;
  if (s.page === 'editor') {
    if (forceContent || key !== shown) $content.replaceChildren(editorPage(s.editorId));
  } else if (s.page === 'settings') {
    // 设置页里的下拉框打开时不重画，免得被关掉
    // 输入框正在输入时也不重画（团队页的登记表单）
    if (forceContent || key !== shown || !$content.contains(document.activeElement) || !['SELECT', 'INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) $content.replaceChildren(settingsPage());
  } else if (s.page === 'overview') {
    // 只有内容变了才重画，免得滚动位置被打回顶部
    const sig = JSON.stringify([s.accounts.map((a) => [a.id, a.name, a.color, a.emoji, a.unread, a.muted, a.groupMuted, a.groupId]), s.groups, notifLogCache.length, notifLogCache[0]?.at]);
    if (key !== shown) loadNotifLog();
    if (forceContent || key !== shown || sig !== overviewSig) { overviewSig = sig; $content.replaceChildren(overviewPage()); }
    // 有新的未读时顺便刷新记录
    else if (s.accounts.reduce((n, a) => n + (a.unread || 0), 0) !== overviewTotal) loadNotifLog();
    overviewTotal = s.accounts.reduce((n, a) => n + (a.unread || 0), 0);
  } else if (s.page === 'translate') {
    // 翻译页：同一个元素原地更新，不重建（打字、按钮动画不会被打断）
    const el = trPage(key !== shown);
    if ($content.firstChild !== el || $content.childNodes.length !== 1) $content.replaceChildren(el);
  } else if (s.page === 'welcome') {
    if (key !== shown) $content.replaceChildren(welcomePage());
  } else if (acc && !acc.problem && acc.mode === 'lite') {
    // 轻量模式聊天页：同一个元素反复更新，不重建
    const el = litePage(acc, s.lite);
    if ($content.firstChild !== el || $content.childNodes.length !== 1) $content.replaceChildren(el);
  } else {
    $content.replaceChildren(acc && acc.problem ? problemPage(acc) : '');
  }
  // 换了页面（设置里换了分页、切到别的号的出错页）：卡片内容淡入。WhatsApp 页面本身不动
  const fxKey = s.page === 'settings' ? `${key}|${settingsTab}` : s.page === 'account' ? `${key}|${s.activeId}|${acc && acc.problem ? 'p' : acc && acc.mode === 'lite' ? 'l' : ''}` : key;
  if (fxChanged('content', fxKey) && $content.firstElementChild) fxPlay($content.firstElementChild);
  liteForget(s.accounts.map((a) => a.id));
  shown = key;
}

window.wa.onState((state) => { s = state; render(); });
