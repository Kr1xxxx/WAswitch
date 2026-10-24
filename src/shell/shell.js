// 软件界面：左侧账号栏、顶栏、右侧卡片里的页面（代理断开提示、编辑账号、设置、首次打开）。
// WhatsApp 页面本身是主进程叠在卡片上面的独立视图，这里不碰它。
// 所有来自用户或账号的数据一律用 textContent 显示，不拼 HTML。

const COLORS = ['#16A34A', '#7C3AED', '#EA580C', '#2563EB', '#DB2777', '#475569'];
const COLOR_NAMES = ['绿色', '紫色', '橙色', '蓝色', '粉色', '灰色'];
const PRESETS = [['直连', ''], ['Clash 7891', 'socks5://127.0.0.1:7891'], ['Clash 7892', 'socks5://127.0.0.1:7892'], ['Clash 7893', 'socks5://127.0.0.1:7893'], ['带密码的 http', 'http://用户名@代理IP:端口']];
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
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};

function icon(name, size = 16) {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.style.display = 'flex';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// 小工具：h('div', { class: 'x', onclick() {} }, '文字', 子元素...)
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

// 去掉条件不成立时留下的 null，避免 append 把它当成文字 "null"
const kids = (...xs) => xs.flat().filter((x) => x !== null && x !== undefined && x !== false);

const $side = document.getElementById('side');
const $top = document.getElementById('topbar');
const $ai = document.getElementById('aibar');
const $content = document.getElementById('content');
const $lock = document.getElementById('lock');
let s = null; // 主进程推过来的状态
let shown = ''; // 当前卡片里画的是哪个页面，用来决定是否重画
let settingsTab = 'memory';
let checkResult = null;
let checkRunning = false;
// 缓存大小：进入“内存”设置时查一次（30 秒内不重复查）
let cacheInfo = { mb: null, at: 0, busy: false, result: '' };
function refreshCacheSize() {
  if (cacheInfo.busy || Date.now() - cacheInfo.at < 30000) return;
  cacheInfo.at = Date.now();
  window.wa.cacheSize().then((r) => { cacheInfo.mb = Math.round(r.bytes / 1048576); render(true); }, () => {});
}

const active = () => (s.accounts || []).find((a) => a.id === s.activeId);
const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);

function tint(color) {
  // 背景 = 账号颜色 22% + 浅灰
  return color ? `color-mix(in srgb, ${color} 22%, #EEF0F3)` : '#E6E9ED';
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
  const avatar = h('span', { class: 'avatar', style: { background: acc.color } }, acc.name.trim().charAt(0) || '?');
  // 从没登录过的号停在二维码页是正常的第一步：灰色“等待扫码”，不标红
  const waiting = acc.needsQr && !acc.everLoggedIn && !acc.problem;
  const lost = acc.needsQr && !waiting;
  if (acc.problem || lost) avatar.append(h('span', { class: 'dot bad' }, '!'));
  else if (s.collapsed && acc.unread) avatar.append(h('span', { class: `dot${quiet ? ' quiet' : ''}` }, acc.unread > 9 ? '9+' : acc.unread));
  const tip = [acc.name, acc.note, acc.unread ? `${acc.unread} 个未读对话` : '', acc.problem, waiting ? '等待扫码登录' : lost ? '需要扫码登录' : ''].filter(Boolean).join('\n');
  const row = h('button', {
    class: `row${on ? ' on' : ''}`, title: tip, 'aria-current': on ? 'true' : null,
    onclick: () => window.wa.switchTo(acc.id),
    oncontextmenu: (e) => { e.preventDefault(); window.wa.context(acc.id); },
  },
  avatar,
  h('span', { class: 'meta' },
    h('span', { class: 'name' }, acc.name),
    h('span', { class: `sub${acc.problem || lost ? ' bad' : acc.exitChange ? ' warn' : ''}` }, acc.problem ? acc.problemShort : waiting ? '等待扫码' : lost ? '需要扫码登录' : acc.exitChange ? '出口 IP 变了' : acc.mode === 'lite' ? `轻量 · ${acc.proxyLabel}` : acc.proxyLabel)),
  quiet ? h('span', { class: 'mute', title: acc.muted ? '不弹通知' : '所在分组整组不弹通知', style: { color: '#4A505A' } }, icon('mute', 13)) : null,
  acc.unread ? h('span', { class: `pill${quiet ? ' quiet' : ''}` }, acc.unread) : null);
  draggable(row, acc.id);
  dropOn(row, acc.groupId || '', acc.id);
  return row;
}

// 分组的组头：点一下折叠/展开，右键改名、整组静音、解散；把号拖到组头上就放进这个组的最后
function groupHead(g) {
  const name = g ? g.name : '未分组';
  const gid = g ? g.id : '';
  if (g && s.editGroupId === g.id && !s.collapsed) {
    let done = false;
    const commit = (name) => { if (done) return; done = true; window.wa.groupRename(g.id, name); };
    const input = h('input', {
      class: 'group-name', value: g.name, maxlength: '20', 'aria-label': '分组名称',
      onkeydown: (e) => { if (e.key === 'Enter') commit(input.value); if (e.key === 'Escape') commit(g.name); },
      onblur: () => commit(input.value),
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return h('div', { class: 'group-head editing' }, icon('down', 12), input);
  }
  const quiet = g && g.muted;
  const head = h('button', {
    class: `group-head${g && g.collapsed ? ' closed' : ''}`,
    title: g ? `${name} · ${g.count} 个号${g.muted ? ' · 整组不弹通知' : ''}${g.collapsed ? '（已折叠，点开）' : ''}\n右键：改名、整组不弹通知、解散` : '没有放进分组的号',
    'aria-expanded': g ? String(!g.collapsed) : null,
    onclick: () => { if (g) window.wa.groupToggle(g.id); },
    oncontextmenu: (e) => { e.preventDefault(); if (g) window.wa.groupContext(g.id); },
  },
  g ? icon(g.collapsed ? 'right' : 'down', 12) : null,
  h('span', { class: 'gname' }, g && g.collapsed ? `${name} · ${g.count}` : name),
  quiet ? h('span', { class: 'mute', title: '整组不弹通知' }, icon('mute', 12)) : null,
  g && g.collapsed && g.unread ? h('span', { class: `pill${quiet ? ' quiet' : ''}` }, g.unread) : null);
  dropOn(head, gid, null);
  return head;
}

// 账号列表：没有分组时和以前一样；有分组时先是“未分组”，再按组排
function accountList() {
  const groups = s.groups || [];
  if (!groups.length) return s.accounts.map(accountRow);
  const out = [groupHead(null), ...s.accounts.filter((a) => !a.groupId).map(accountRow)];
  for (const g of groups) {
    out.push(groupHead(g));
    // 折叠的组只藏起侧栏里的行（页面照常开着、照常收消息）；正在看的那个号仍然露出来
    out.push(...s.accounts.filter((a) => a.groupId === g.id && (!g.collapsed || (a.id === s.activeId && s.page === 'account'))).map(accountRow));
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
  $side.append(h('div', { class: 'drag' }));
  if (s.page === 'settings') {
    $side.append(
      h('button', { class: 'back', onclick: () => window.wa.showPage('account') }, icon('back', 14), '返回账号'),
      h('div', { class: 'label' }, '设置'),
      h('div', { class: 'list' }, [['memory', '内存'], ['notify', '通知'], ['general', '通用'], ['check', '隔离自检'], ['net', '连接记录'], ['about', '关于']].map(([id, label]) =>
        h('button', { class: `tab${settingsTab === id ? ' on' : ''}`, onclick: () => { settingsTab = id; render(true); } }, label))));
    return;
  }
  const label = s.collapsed ? '展开侧栏' : '收起侧栏';
  $side.append(...kids(
    h('div', { class: 'head' },
      s.collapsed ? null : h('span', { class: 'brand' }, 'WAswitch'),
      h('button', { class: 'icon-btn', title: label, 'aria-label': label, onclick: () => window.wa.toggleCollapse() }, icon('panel'))),
    s.collapsed ? null : h('div', { class: 'label side-label' }, h('span', null, `账号 · ${s.accounts.length}`),
      s.accounts.length > 1 || (s.groups || []).length ? h('button', { class: 'link-btn', title: '新建一个分组，再把号拖进去（或右键号 › 移到分组）', onclick: () => window.wa.groupCreate() }, '+ 分组') : null),
    h('div', { class: 'list' },
      accountList(),
      h('button', { class: `row${s.page === 'editor' && !s.editorId ? ' on' : ''}`, title: '添加账号', onclick: () => window.wa.add() },
        h('span', { class: 'avatar add' }, icon('plus', 14)), h('span', { class: 'text', style: { fontSize: '13px' } }, '添加账号'))),
    h('div', { class: 'grow' })));
  if (s.accounts.length && s.totalMB) {
    const total = s.accounts.reduce((n, a) => n + (a.memMB || 0), 0) || 1;
    $side.append(h('div', { class: 'membox', title: '近似值：只统计每个账号的主页面进程' },
      h('div', { class: 'top' }, h('span', null, '内存'), h('b', null, mb(s.totalMB))),
      h('div', { class: 'bars' }, s.accounts.map((a) => h('span', { style: { width: `${((a.memMB || 0) / total) * 100}%`, background: a.color } }))),
      h('small', null, '后台账号已降速，消息照常收')));
  }
  const totalUnread = s.accounts.reduce((n, a) => n + (a.unread || 0), 0);
  const bell = h('button', { class: `icon-btn bell${s.page === 'overview' ? ' on' : ''}`, title: `未读总览和通知记录${totalUnread ? ` · 共 ${totalUnread} 个未读对话` : ''}`, 'aria-label': '未读总览', onclick: () => window.wa.showPage('overview') }, icon('bell', 17));
  if (totalUnread) bell.append(h('span', { class: 'dot' }, totalUnread > 99 ? '99+' : totalUnread));
  $side.append(h('div', { class: 'foot' },
    h('button', { class: 'icon-btn', title: '设置', 'aria-label': '设置', onclick: () => window.wa.showPage('settings') }, icon('gear', 17)),
    bell));
  document.body.classList.toggle('mac', mac);
}

// ---------- 顶栏 ----------

// 鼠标停在线路上：出口 IP 和上次测到的时间
function exitTitle(acc) {
  if (acc.direct) return '网络线路：直连（这台电脑的真实 IP）';
  if (!acc.exitIp) return '网络线路。还没测过出口 IP，可以在编辑里点“测试”，或跑一次隔离自检';
  const at = acc.exitAt ? `（上次测到：${new Date(acc.exitAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）` : '';
  const lat = acc.latency ? `\n最近一次巡检用时 ${acc.latency.ms} ms（设置 › 连接记录 里有掉线和延迟记录）` : '';
  return `网络线路 · 出口 IP ${acc.exitIp}${at}${lat}`;
}

// 线路：出口 IP 直接显示；巡检发现 IP 变了就标黄，点一下表示知道了
function exitChip(acc) {
  if (acc.problem) return h('span', { class: 'chip bad', title: exitTitle(acc) }, icon('globe', 12), acc.problemShort);
  const ch = acc.exitChange;
  if (ch) {
    const when = new Date(ch.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const moved = ch.fromLabel && ch.toLabel && ch.fromLabel !== ch.toLabel;
    return h('button', {
      class: 'chip night', type: 'button',
      title: `${when} 巡检发现出口 IP 变了：${ch.from} → ${ch.to}${moved ? `（${ch.fromLabel} → ${ch.toLabel}，国家也变了，时区可能对不上，建议跑一次隔离自检）` : ''}。机场节点常会自动换 IP，频繁变化容易被 WhatsApp 当成异常。点一下表示知道了。`,
      onclick: () => window.wa.exitAck(acc.id),
    }, icon('globe', 12), `出口 IP 变了${moved ? `（${ch.toLabel}）` : ''} · ${ch.to}`);
  }
  return h('span', { class: 'chip', title: exitTitle(acc) }, icon('globe', 12), acc.exitIp && !acc.direct ? `${acc.proxyLabel} · ${acc.exitIp}` : acc.proxyLabel);
}

// 当地时间：按账号的时区显示，深夜（22:00–8:00）变黄，提醒这时候发消息不像真人
const clockFormats = new Map();
function clockParts(tz) {
  const key = tz || '';
  if (!clockFormats.has(key)) {
    clockFormats.set(key, new Intl.DateTimeFormat('zh-CN', { ...(tz ? { timeZone: tz } : {}), hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }));
  }
  const parts = Object.fromEntries(clockFormats.get(key).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  return { text: `${parts.weekday} ${parts.hour}:${parts.minute}`, night: hour >= 22 || hour < 8 };
}
function clockChip(acc) {
  const place = acc.timezone ? acc.regionLabel.replace(/^出口时区（.*\/(.+)）$/, '$1').replace(/_/g, ' ') : '本机';
  const chip = h('span', { class: 'chip clock' }, icon('clock', 12), h('span'));
  const draw = () => {
    const c = clockParts(acc.timezone);
    chip.lastChild.textContent = `${place} ${c.text}${c.night ? ' · 深夜' : ''}`;
    chip.classList.toggle('night', c.night);
    chip.title = `当地时间（${acc.timezone || '跟随本机时区'}）${c.night ? '。这个号所在地现在是深夜，这时候大量发消息不像真人' : ''}`;
  };
  draw();
  chip.draw = draw;
  return chip;
}
// 每 20 秒只刷新时钟文字，不重画整个顶栏
setInterval(() => {
  if ($top.hidden || document.hidden) return;
  const c = $top.querySelector('.chip.clock');
  if (c && c.draw) c.draw();
}, 20000);

function renderTop() {
  const acc = active();
  $top.hidden = !(s.page === 'account' && acc);
  if ($top.hidden) return;
  // 锁着时顶栏只留一句“已锁定”：账号名、出口 IP、内存这些都不露出来
  if (s.locked) { $top.replaceChildren(icon('lock', 14), h('span', null, '聊天已锁定')); return; }
  const lite = acc.mode === 'lite';
  $top.replaceChildren(...kids(
    icon('lock', 14), h('span', null, lite ? '轻量模式' : 'web.whatsapp.com'), h('span', { class: 'who', title: acc.note || null }, acc.note ? `· ${acc.name} · ${acc.note}` : `· ${acc.name}`),
    h('span', { class: 'grow' }),
    exitChip(acc),
    // 缩放过的号显示比例，点一下还原到 100%
    !lite && acc.zoom && acc.zoom !== 1 ? h('button', { class: 'chip', type: 'button', title: `这个号的页面缩放到了 ${Math.round(acc.zoom * 100)}%。点一下还原到 100%（${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + = / - / 0 也能调）`, onclick: () => window.wa.zoom(acc.id, 0) }, `${Math.round(acc.zoom * 100)}%`) : null,
    clockChip(acc),
    acc.memMB ? h('span', { class: 'chip', title: lite ? '轻量模式账号共用一个后台进程，这里是平均到每个号的近似值' : '内存占用（近似值）' }, `${acc.memMB} MB`) : null,
    h('button', { class: 'icon-btn', title: lite ? '重新连接' : '刷新', 'aria-label': lite ? '重新连接' : '刷新', onclick: () => window.wa.reload(acc.id) }, icon('reload', 15)),
    h('button', { class: 'icon-btn', title: '账号菜单（右键账号也可以打开）', 'aria-label': '账号菜单', onclick: () => window.wa.context(acc.id) }, icon('more', 15))));
}

// AI（MCP 客户端）想切换账号或打开添加页，但用户正在打字：问一下，不直接切
function renderAi() {
  const r = s.aiRequest;
  $ai.hidden = !r;
  if (!r) return;
  const what = r.kind === 'add'
    ? (r.name ? `AI 想打开“添加账号”（预填「${r.name}」）` : 'AI 想打开“添加账号”')
    : `AI 想切到「${r.name}」`;
  $ai.replaceChildren(
    h('span', { class: 'grow' }, what),
    h('button', { class: 'btn', onclick: () => window.wa.aiAnswer(false) }, '忽略'),
    h('button', { class: 'btn primary', onclick: () => window.wa.aiAnswer(true) }, r.kind === 'add' ? '打开' : '切换'));
}

// ---------- 卡片里的页面 ----------

const RELEASES = 'https://github.com/Kr1xxxx/WAswitch/releases';

// 按出错的类型配按钮：重连没用的情况不给“重新连接”，直连号不提代理和 Clash
function problemButtons(acc) {
  const btn = (text, onclick, primary) => h('button', { class: `btn${primary ? ' primary' : ''}`, onclick }, text);
  const del = () => btn('删除这个号…', () => window.wa.remove(acc.id));
  const retry = (text = '重新连接', primary = true) => btn(text, () => window.wa.retry(acc.id), primary);
  switch (acc.problemKind) {
    case 'authError': return [del()];
    case 'banned': return [del(), retry('仍要重试', false)];
    case 'outdated': return [btn('检查更新', () => { settingsTab = 'about'; window.wa.showPage('settings'); window.wa.updateCheck(); }), btn('去下载新版', () => window.wa.openLink(RELEASES), true)];
    case 'loggedOut': case 'qrExpired': return [retry('重新扫码')];
    default: return [acc.direct ? null : btn('修改代理', () => window.wa.edit(acc.id)), retry(acc.mode === 'lite' && acc.needsQr ? '重新扫码' : '重新连接')];
  }
}

function problemPage(acc) {
  return h('div', { class: 'center' }, h('div', { class: 'panel' },
    h('div', { class: 'warnicon' }, icon('warn', 26)),
    h('h2', null, acc.problemTitle || '代理连不上，这个账号已暂停联网'),
    h('p', null, acc.problem),
    acc.retrying ? h('p', { class: 'hint' }, acc.direct ? '正在自动重试，网络恢复后会自动连上。' : '正在自动重试，网络或 Clash 恢复后会自动连上。') : null,
    h('div', { class: 'btns' }, ...kids(...problemButtons(acc)))));
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
  page.append(
    h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '未读总览'),
      h('p', { class: 'lead' }, total ? `${unread.length} 个号共有 ${total} 个未读对话。点一下切过去。` : '所有号都没有未读对话。')),
    unread.length ? h('div', { class: 'box ov-list' }, unread.map((a) => h('button', { class: 'ov-row', onclick: () => window.wa.switchTo(a.id) },
      h('span', { class: 'sw', style: { background: a.color } }),
      h('span', { class: 'ov-name' }, a.name, groupName(a) ? h('span', { class: 'hint' }, ` · ${groupName(a)}`) : null),
      a.muted || a.groupMuted ? h('span', { class: 'hint' }, '不弹通知') : null,
      h('span', { class: `pill${a.muted || a.groupMuted ? ' quiet' : ''}` }, a.unread)))) : null,
    h('div', { class: 'hstack', style: { justifyContent: 'space-between', marginTop: '8px' } },
      h('h2', { class: 'ov-h2' }, '通知记录'),
      notifLogCache.length ? h('button', { class: 'btn', onclick: async () => { await window.wa.notifClear(); loadNotifLog(); } }, '清空记录') : null),
    h('p', { class: 'hint', style: { margin: 0 } }, '每次有号的未读变多都记一条（最多 300 条），只记哪个号、什么时候、几个未读，不记消息内容。“没弹”表示当时这个号或分组不弹通知，或者你正看着它。'),
    notifLogCache.length
      ? h('div', { class: 'box ov-log' }, notifLogCache.map((e) => {
        const a = byId.get(e.id);
        const t = new Date(e.at);
        const today = t.toDateString() === new Date().toDateString();
        return h(a ? 'button' : 'div', { class: 'ov-logrow', onclick: a ? () => window.wa.switchTo(a.id) : null },
          h('span', { class: 'hint ov-time' }, t.toLocaleString('zh-CN', today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
          h('span', { class: 'sw', style: { background: a ? a.color : '#c4c8ce' } }),
          h('span', { class: 'ov-name' }, a ? a.name : '已删除的号'),
          h('span', { class: 'hint' }, `${e.count} 个未读${e.popped ? '' : ' · 没弹'}`));
      }))
      : h('div', { class: 'box' }, h('span', { class: 'hint' }, '还没有记录。')));
  return page;
}

function welcomePage() {
  const step = (n, title, text) => h('li', null, h('span', { class: 'n' }, n), h('span', { class: 'meta' }, h('b', null, title), h('small', null, text)));
  return h('div', { class: 'center', style: { background: '#fff' } }, h('div', { class: 'col', style: { maxWidth: '640px', gap: '26px' } },
    h('div', { class: 'col', style: { gap: '10px' } },
      h('h1', { style: { fontSize: '30px' } }, '一个窗口，同时登录多个 WhatsApp'),
      h('p', { class: 'lead' }, '每个账号独立隔离：登录和缓存分开存，可以走各自的代理线路，时区跟着线路走，WhatsApp 界面统一中文。')),
    h('ol', { class: 'steps' },
      step(1, '起个名字，选个颜色', '比如“客服号”“店铺号”。颜色会铺满窗口背景，一眼认出在用哪个号。'),
      step(2, '选网络线路', ['第一个号可以直连；从第二个号起，在 Clash 里给每个号开一个本地端口（填 socks5://127.0.0.1:端口），点“测试”。详见', clashLink(), '。']),
      step(3, '手机扫码登录', 'WhatsApp › 设置 › 已关联的设备 › 关联新设备。')),
    h('div', null, h('button', { class: 'btn primary', style: { height: '46px', padding: '0 26px' }, onclick: () => window.wa.add() }, '添加第一个账号'))));
}

// 编辑账号（新建和修改共用）
function editorPage(id) {
  liveColor = null;
  const root = h('div', { class: 'page' }, h('div', { class: 'col' }, h('p', { class: 'lead' }, '正在加载…')));
  window.wa.editorLoad(id).then((d) => {
    let color = d.color;
    let tested = null;
    let mode = d.mode;
    // 主号：只能用网页版。已经是主号的不能在这里取消，要在别的号里勾选来更换
    const primary = h('input', { type: 'checkbox', checked: d.primary, disabled: d.primary && !d.isNew });
    const primaryHint = h('span', { class: 'hint' },
      d.primary && !d.isNew ? '要换主号，在另一个网页版账号里勾选。'
        : d.primaryName ? `现在的主号是「${d.primaryName}」，勾选后改为这个号。` : '第一个网页版账号默认是主号。');
    const primaryRow = h('div', { class: 'field' }, '主号',
      h('label', { class: 'check-row' }, primary, h('span', null, '这是主号（主号只能用网页版）')), primaryHint);
    const liteConfirm = h('input', { type: 'checkbox' });
    const liteBox = h('div', { class: 'note bad lite-risk' },
      h('b', null, '轻量模式不是官方客户端'),
      h('span', null, '它直接连 WhatsApp 服务器，不开网页，每个号只占几十 MB 内存；但 WhatsApp 可能识别出来并封号（通常在几天到几周内）。只能收发文字，图片、语音等只显示类型。'),
      d.isNew ? h('label', { class: 'check-row' }, liteConfirm, h('span', null, '我知道这个号可能被封。我会先用不重要的号试用两周，再考虑用在正式号上。')) : null);
    const modeCard = (value, title, desc) => h('button', {
      type: 'button', class: `mode${mode === value ? ' on' : ''}`, 'aria-pressed': String(mode === value), 'data-mode': value,
      onclick: () => { if (!modeBtnDisabled(value)) { mode = value; onModeChange(); } },
    }, h('b', null, title), h('span', null, desc));
    const modeCards = h('div', { class: 'modes' },
      modeCard('web', '网页版（推荐）', '和浏览器里的 WhatsApp Web 一样，最稳。每个号约 300 MB 内存。主号必须用这个。'),
      modeCard('lite', '轻量模式（小号）', '不开网页，每个号几十 MB。只收发文字，有封号风险。'));
    const modeBtnDisabled = (value) => value === 'lite' && (primary.checked || !d.liteAvailable);
    // 轻量模式卡片灰掉的原因直接写在下面，不只放在悬停提示里
    const liteReason = h('span', { class: 'hint' });
    const modeRow = d.isNew
      ? h('div', { class: 'field' }, '账号类型', modeCards, liteReason,
        !d.liteAvailable ? h('span', { class: 'hint' }, d.platform === 'linux'
          ? '这台电脑没有系统钥匙串，不能加密保存，所以不能使用轻量模式。安装 gnome-keyring 或 KWallet 后重启 WAswitch 即可。'
          : '这台电脑不支持加密保存，不能使用轻量模式。') : null)
      : h('div', { class: 'field' }, '账号类型', h('div', { class: 'tags' }, h('span', { class: 'tag' }, mode === 'lite' ? '轻量模式（添加后不能改）' : '网页版（添加后不能改）')));
    const name = h('input', { type: 'text', value: d.name, 'aria-label': '名称', maxlength: '40' });
    const note = h('input', { type: 'text', value: d.note || '', 'aria-label': '备注', maxlength: '200', placeholder: '可不填，例如：+81 90-xxxx · 日本客户群 · 小王负责' });
    const proxyInput = h('input', { type: 'text', class: 'mono', value: d.proxy, placeholder: '留空表示直连，例如 socks5://127.0.0.1:7891', 'aria-label': '代理地址' });
    const password = h('input', { type: 'password', autocomplete: 'off', 'aria-label': '代理密码', placeholder: d.hasPassword ? '已保存，留空表示不修改' : '' });
    const passwordRow = h('label', { class: 'field' }, '代理密码', password, h('span', { class: 'hint' }, '用系统钥匙串加密后保存在本机。'));
    // 直连号才有：允许网页版通话（WebRTC 用 UDP 走本机网卡）
    const allowCalls = h('input', { type: 'checkbox', checked: d.allowCalls });
    const callsRow = h('div', { class: 'field' }, '通话',
      h('label', { class: 'check-row' }, allowCalls, h('span', null, '允许通话（直连号）')),
      h('span', { class: 'hint' }, '打开后这个号能在网页版里打语音、视频电话，通话走这台电脑的真实 IP。Clash 开着“系统代理”时请不要打开（网页和通话会是两个不同的 IP），或者把 Clash 改成 TUN 模式。'));
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
    const error = h('div', { class: 'hint', role: 'alert', style: { color: '#B42318', minHeight: '18px' } });
    const swatches = h('div', { class: 'swatches' });
    const presets = h('div', { class: 'presets' });
    const testBtn = h('button', { class: 'btn', type: 'button' }, '测试');
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, d.isNew ? '保存并扫码登录' : '保存');

    const drawSwatches = () => swatches.replaceChildren(...COLORS.map((c, i) => h('button', {
      class: `swatch${c === color ? ' on' : ''}`, type: 'button', style: { background: c, '--c': c },
      'aria-label': COLOR_NAMES[i] + (c === color ? '，已选' : ''),
      onclick: () => { color = c; liveColor = c; document.body.style.background = tint(c); drawSwatches(); },
    })));
    const drawPresets = () => presets.replaceChildren(...PRESETS.map(([label, v]) => h('button', {
      class: `preset${proxyInput.value.trim() === v ? ' on' : ''}`, type: 'button', hidden: mode === 'lite' && !v,
      onclick: () => {
        proxyInput.value = v;
        onProxyChange();
        // 带密码的模板：选中“用户名@代理IP:端口”，直接输入替换
        if (v.includes('用户名')) { proxyInput.focus(); proxyInput.setSelectionRange(7, v.length); }
      },
    }, label)));
    const drawTags = () => {
      const opt = d.regions.find((r) => r.key === region.value) || (region.selectedOptions[0] && { label: region.selectedOptions[0].textContent });
      const auto = region.value === 'auto';
      tags.replaceChildren(
        h('span', { class: 'tag' }, auto
          ? (proxyInput.value.trim() ? '时区：还没识别，点“测试”自动选好' : '时区：跟本机一致')
          : `时区：${opt ? opt.label : ''}`),
        h('span', { class: 'tag' }, `界面语言：${d.uiLanguage || '中文'}`),
        h('span', { class: 'tag' }, 'Chrome · 跟随本机系统'),
        h('span', { class: 'tag' }, proxyInput.value.trim() ? 'WebRTC 只走代理' : '直连：用本机真实 IP'));
    };
    const onProxyChange = () => {
      passwordRow.hidden = !/^https?:\/\/[^/@]+@/i.test(proxyInput.value.trim());
      callsRow.hidden = mode === 'lite' || !!proxyInput.value.trim();
      result.replaceChildren();
      tested = null;
      drawPresets();
      drawTags();
    };
    const regionRow = h('label', { class: 'field' }, '时区', region, tags, h('span', { class: 'hint' }, `应该和代理出口所在地一致，点“测试”会自动选好。WhatsApp 界面语言：${d.uiLanguage || '中文'}（所有账号统一）。`));
    const proxyHint = h('span', { class: 'hint' });
    const onModeChange = () => {
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
      proxyInput.placeholder = lite ? '必填，例如 socks5://127.0.0.1:7891' : '留空表示直连，例如 socks5://127.0.0.1:7891';
      primaryRow.hidden = lite;
      regionRow.hidden = lite;
      callsRow.hidden = lite || !!proxyInput.value.trim();
      liteBox.hidden = !lite;
      proxyHint.replaceChildren(...(lite
        ? ['必须走代理并先“测试”通过，出口 IP 不能和主号相同。带密码的代理请用 http://。']
        : ['代理连不上时这个号会暂停联网，不会改用直连。带密码的代理请用 http://。']));
      for (const b of presets.children) if (b.textContent === '直连') b.hidden = lite;
      sidePanel.replaceChildren(...sideText());
    };
    primary.addEventListener('change', () => { if (primary.checked && mode === 'lite') mode = 'web'; onModeChange(); });
    const sideText = () => (d.isNew
      ? [h('div', { class: 'qr' }, mode === 'lite' ? '保存后右边会显示登录二维码' : '保存后右边会打开 WhatsApp 登录页，显示二维码'),
        h('ol', null, h('li', null, '手机打开 WhatsApp'), h('li', null, '设置 › 已关联的设备'), h('li', null, '关联新设备，扫码'))]
      : [h('span', null, mode === 'lite' ? '修改代理后会重新连接，不需要重新扫码。' : '修改代理或时区后，这个账号的页面会重新加载，不需要重新扫码。')]);
    const sidePanel = h('div', { class: 'side-panel' });
    proxyInput.addEventListener('input', onProxyChange);
    region.addEventListener('change', drawTags);

    testBtn.onclick = async () => {
      if (!proxyInput.value.trim()) {
        result.replaceChildren(h('div', { class: 'note plain' }, '直连不需要测试，这个账号会用你电脑当前的网络。'));
        return;
      }
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      result.replaceChildren(h('div', { class: 'note plain' }, '正在通过这个代理访问 ipinfo.io …'));
      const res = await window.wa.editorTest({ id: d.id, proxy: proxyInput.value, password: password.value });
      testBtn.disabled = false;
      testBtn.textContent = '重新测试';
      if (res.error) { result.replaceChildren(h('div', { class: 'note bad' }, res.error)); return; }
      tested = res;
      const place = [res.country, res.city].filter(Boolean).join(' · ');
      let text = `连接成功 · 出口 IP ${res.ip} · ${place} · ${res.ms} ms。`;
      if (res.region) { addTzOption(res.region, res.regionLabel); region.value = res.region; text += ' 已按出口所在地选好时区。'; } else text += ' 出口时区无法识别，请手动选最接近的。';
      if (res.sameAs) {
        text += res.sameAt
          ? `\n注意：和「${res.sameAs}」上次测到（${new Date(res.sameAt).toLocaleString('zh-CN')}）的出口 IP 相同，两个号可能会被认为在同一个地方。`
          : `\n注意：和「${res.sameAs}」的出口 IP 相同，两个号会被认为在同一个地方。`;
      }
      result.replaceChildren(h('div', { class: `note ${res.sameAs ? 'bad' : 'ok'}`, style: { whiteSpace: 'pre-line' } }, text));
      drawTags();
    };

    saveBtn.onclick = async () => {
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = '请填写名称'; name.focus(); return; }
      saveBtn.disabled = true;
      if (mode === 'lite' && d.isNew && !liteConfirm.checked) { error.textContent = '请先勾选风险确认'; saveBtn.disabled = false; return; }
      if (mode === 'lite' && !tested && (d.isNew || proxyInput.value.trim() !== d.proxy || password.value)) { error.textContent = '请先点“测试”，代理测试通过后才能保存'; saveBtn.disabled = false; return; }
      const res = await window.wa.editorSave({ id: d.id, name: name.value.trim(), note: note.value, color, proxy: proxyInput.value, password: password.value, region: region.value, mode, primary: mode === 'web' && primary.checked, liteConfirm: liteConfirm.checked, allowCalls: allowCalls.checked });
      saveBtn.disabled = false;
      if (res && res.error) error.textContent = res.error;
    };

    drawSwatches();
    onProxyChange();
    // 有改动就告诉主进程：离开编辑页（切号、点通知等）前会先问一句
    let dirty = false;
    const markDirty = () => { if (!dirty) { dirty = true; window.wa.editorDirty(true); } };
    root.addEventListener('input', markDirty);
    root.addEventListener('change', markDirty);
    root.addEventListener('click', (e) => { if (e.target.closest('.swatch, .mode, .preset')) markDirty(); });
    root.replaceChildren(
      h('div', { class: 'col' },
        h('div', { class: 'col', style: { gap: '6px' } },
          h('h1', null, d.isNew ? '添加账号' : '编辑账号'),
          h('p', { class: 'lead' }, '每个账号的登录、缓存、网络线路和时区都互相独立。')),
        h('div', { class: 'hstack', style: { alignItems: 'flex-end', gap: '14px' } },
          h('label', { class: 'field', style: { flex: '1' } }, '名称', name),
          h('div', { class: 'field' }, '颜色', swatches)),
        h('label', { class: 'field' }, '备注', note, h('span', { class: 'hint' }, '只给自己看：显示在顶栏和侧栏（鼠标停在账号上）。')),
        modeRow,
        primaryRow,
        h('div', { class: 'field' },
          h('span', { class: 'field-head' }, '网络线路（代理）', h('a', { href: '#', class: 'help', onclick: (e) => { e.preventDefault(); window.wa.openLink(CLASH_DOC); } }, '怎么在 Clash 里开端口？')),
          presets, h('div', { class: 'hstack' }, proxyInput, testBtn), result, proxyHint),
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
  return h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, onclick: () => onchange(!on) });
}
function setRow(title, desc, control, extra) {
  return h('div', { class: 'setrow' }, h('div', { class: 'meta' }, h('span', { class: 'title' }, title), h('span', { class: 'desc' }, desc), extra), control);
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
  crash: (e) => `页面进程退出（${e.detail || '未知'}），已自动重建`,
  exit: (e) => `出口巡检正常，用时 ${e.ms} ms`,
  exit_fail: () => '出口巡检失败（代理没响应）',
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
    h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '连接记录'),
      h('p', { class: 'lead' }, '最近 7 天每个号的掉线、恢复和出口巡检。不会为此多发任何网络请求；“用时”是每 30 分钟测一次出口 IP 的往返时间，可以当延迟参考。')),
    h('div', { class: 'box' }, s.accounts.map((a) => {
      const drops = netLogCache.filter((e) => e.id === a.id && e.at >= dayAgo && (e.kind === 'down' || e.kind === 'qr')).length;
      return h('div', { class: 'memrow netrow' },
        h('span', null, h('span', { class: 'sw', style: { background: a.color } }), a.name),
        h('span', { class: 'hint' }, a.direct ? '直连 · 不巡检' : a.latency ? `最近用时 ${a.latency.ms} ms` : '还没测过'),
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
          h('span', { class: 'sw', style: { background: a ? a.color : '#c4c8ce' } }),
          h('span', { class: 'ov-name', style: { flex: 'none', width: '110px' } }, a ? a.name : '已删除的号'),
          h('span', { class: `ov-name${['down', 'qr', 'crash', 'exit_fail'].includes(e.kind) ? ' bad-text' : ''}` }, (NET_TEXT[e.kind] || (() => e.kind))(e)));
      }))
      : h('div', { class: 'box' }, h('span', { class: 'hint' }, '还没有记录。')));
  return page;
}

function settingsPage() {
  const st = s.settings;
  const page = h('div', { class: 'page narrow' });
  if (settingsTab === 'memory') {
    const max = Math.max(800, ...s.accounts.map((a) => a.memMB || 0));
    const select = h('select', { 'aria-label': '回收阈值', onchange: (e) => window.wa.setSetting('recycleMB', Number(e.target.value)) },
      s.recycleChoices.map((n) => h('option', { value: n }, `${n} MB`)));
    select.value = String(st.recycleMB || st.recycleLastMB || 800);
    page.append(
      h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '内存'),
        h('p', { class: 'lead' }, '不会让账号休眠，所有账号一直在线收消息。后台账号自动降速，省下来的主要靠下面几项。')),
      h('div', { class: 'box' },
        h('div', { class: 'hstack', style: { justifyContent: 'space-between' } }, h('b', null, '当前占用'), h('b', { style: { fontSize: '22px' } }, mb(s.totalMB || 0))),
        s.accounts.map((a) => h('div', { class: 'memrow' },
          h('span', null, h('span', { class: 'sw', style: { background: a.color } }), a.name),
          h('span', { class: 'bar' }, h('span', { style: { width: `${((a.memMB || 0) / max) * 100}%`, background: a.color } })),
          h('b', { style: { textAlign: 'right' } }, `${a.memMB || 0} MB`),
          h('span', { class: 'hint' }, a.problem ? a.problemShort : a.mode === 'lite' ? '轻量模式' : a.id === s.activeId ? '正在看' : '后台 · 已降速'))),
        h('span', { class: 'hint' }, '近似值：只统计每个账号的主页面进程，实际会略高一点。')),
      setRow('自动回收', '后台账号超过设定值、没有未读、在后台 5 分钟以上时，悄悄刷新一次。同一个号至少隔 30 分钟。',
        sw(st.recycleMB > 0, '自动回收', (v) => window.wa.setSetting('recycleMB', v ? st.recycleLastMB || 800 : 0)),
        st.recycleMB > 0 ? h('label', { class: 'inline' }, '超过', select, '时回收') : null),
      setRow(h('span', null, '省内存模式 ', h('span', { class: 'badge-warn' }, '重启后生效')), '关闭显卡加速，整体再省一些内存。代价是滚动和动画没那么顺滑。',
        h('span', { class: 'hstack', style: { gap: '10px' } },
          s.restartNeeded ? h('button', { class: 'btn primary', style: { height: '32px', padding: '0 14px' }, onclick: () => window.wa.restart() }, '立即重启') : null,
          sw(st.lowMemoryMode, '省内存模式', (v) => window.wa.setSetting('lowMemoryMode', v)))),
      setRow('清理磁盘缓存',
        `清掉网页版账号可以重新下载的缓存，释放磁盘空间。登录状态和聊天记录不会被清，不会退出登录；部分已下载的图片可能需要重新加载；不包含轻量模式账号。${cacheInfo.mb === null ? '' : `当前缓存约 ${mb(cacheInfo.mb)}。`}`,
        h('button', { class: 'btn', disabled: cacheInfo.busy || !s.accounts.length, onclick: async () => {
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
        } }, cacheInfo.busy ? '清理中…' : '清理'),
        cacheInfo.result ? h('span', { class: 'hint', role: 'status' }, cacheInfo.result) : null));
    refreshCacheSize();
  } else if (settingsTab === 'notify') {
    page.append(
      h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '通知'),
        h('p', { class: 'lead' }, '通知标题是账号名，一眼看出是哪个号，点通知直接切到那个号。通知里不显示消息内容。')),
      h('div', null, s.accounts.length ? s.accounts.map((a) => h('div', { class: 'setrow', style: { alignItems: 'center' } },
        h('span', { class: 'avatar', style: { background: a.color } }, a.name.trim().charAt(0) || '?'),
        h('span', { class: 'meta' }, a.name),
        h('span', { class: 'hint' }, a.muted ? '不弹通知' : '弹通知'),
        sw(!a.muted, `${a.name}的通知`, (v) => window.wa.setMuted(a.id, !v)))) : h('p', { class: 'lead' }, '还没有账号。')),
      h('span', { class: 'hint' }, '关掉通知的账号仍然计入托盘和任务栏的总未读数。'));
  } else if (settingsTab === 'general') {
    page.append(h('h1', null, '通用'),
      h('div', null,
        setRow('关闭窗口时缩到托盘', '窗口关掉后继续在后台收消息，从托盘菜单退出。关掉这项则关闭窗口就退出软件。',
          sw(st.closeToTray, '关闭窗口时缩到托盘', (v) => window.wa.setSetting('closeToTray', v))),
        s.canLoginItem ? setRow('开机自动启动', s.platform === 'darwin' ? '开机后自动打开 WAswitch。' : '开机后自动打开 WAswitch 并缩在托盘里。',
          sw(st.openAtLogin, '开机自动启动', (v) => window.wa.setSetting('openAtLogin', v))) : null,
        setRow('侧栏只显示图标', '给聊天留更多空间。随时可以用左上角按钮切换。',
          sw(st.sidebarCollapsed, '侧栏只显示图标', (v) => window.wa.setSetting('sidebarCollapsed', v))),
        setRow('聊天锁', '电脑这么久没有键盘鼠标操作，就遮住聊天区，右滑解锁。只防路过的人看到，消息和通知照常。',
          h('select', { 'aria-label': '聊天锁等待时间', onchange: (e) => window.wa.setSetting('lockMinutes', Number(e.target.value)) },
            (s.lockChoices || [0, 5]).map((m) => h('option', { value: String(m), selected: st.lockMinutes === m }, m ? `${m} 分钟` : '关闭')))),
        setRow('快捷键', `${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + 1 到 9 切换到第几个账号；${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + L 立即锁定聊天。`, h('span'))));
  } else if (settingsTab === 'net') {
    netPage(page);
  } else if (settingsTab === 'check') {
    const run = h('button', { class: 'btn primary', disabled: checkRunning || !s.accounts.length, onclick: async () => {
      checkRunning = true; render(true);
      checkResult = await window.wa.runCheck();
      checkRunning = false; render(true);
    } }, checkRunning ? '检查中…' : (checkResult ? '重新检查' : '开始检查'));
    page.append(
      h('div', { class: 'hstack', style: { justifyContent: 'space-between', alignItems: 'flex-end' } },
        h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '隔离自检'),
          h('p', { class: 'lead' }, '逐个测试每个账号的代理出口，检查有没有号走了真实 IP、有没有两个号共用同一个出口。不需要登录 WhatsApp。')),
        run));
    if (checkResult) {
      page.append(h('div', { class: 'checks' }, checkResult.items.map((c) => h('div', { class: 'check' },
        h('span', { class: `mark${c.level === 'bad' ? ' bad' : c.level === 'warn' ? ' warn' : ''}` }, c.level === 'ok' ? '✓' : '!'),
        h('span', { class: 'meta' }, h('span', null, c.title), c.detail ? h('span', { class: 'hint' }, c.detail) : null,
          c.fix ? h('span', null, h('button', { class: 'btn', style: { height: '30px', padding: '0 14px', marginTop: '4px' }, onclick: async (e) => {
            e.currentTarget.disabled = true;
            const r = await window.wa.checkFix(c.fix.id, c.fix.region);
            if (r && r.ok) { c.level = 'ok'; c.detail = `已改成「${c.fix.label}」，页面已重新加载。`; c.fix = null; }
            render(true);
          } }, `改成和出口一致（${c.fix.label}）`)) : null)))),
      h('span', { class: 'hint' }, `检查时间：${checkResult.time}`));
    }
  } else {
    const a = s.about;
    page.append(
      h('div', { class: 'hstack', style: { gap: '18px' } },
        h('span', { class: 'avatar', style: { width: '64px', height: '64px', borderRadius: '18px', fontSize: '26px', background: 'linear-gradient(135deg, #22C55E, #15803D)' } }, 'W'),
        h('div', { class: 'col', style: { gap: '2px' } }, h('h1', null, 'WAswitch'), h('span', { class: 'hint', style: { fontSize: '14px' } }, `版本 ${a.version} · 团队内部使用`))),
      h('div', { class: 'kv' },
        h('span', null, '内核'), h('span', null, `Electron ${a.electron} · Chrome ${a.chrome}`),
        h('span', null, '数据位置'), h('span', { class: 'mono', style: { fontSize: '12px', wordBreak: 'break-all' } }, a.dataDir),
        h('span', null, '源码'), h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.wa.openSource(); } }, 'github.com/Kr1xxxx/WAswitch'))),
      updateBox(s.update),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => window.wa.openLogs() }, '打开日志文件夹')),
      h('span', { class: 'hint' }, '遇到问题时把日志文件夹里最近的文件发过来。日志只记录软件运行情况，不记录聊天内容和号码。'));
  }
  return page;
}

// 关于页里的“软件更新”：状态、进度条、上次检查的时间和结果。连续失败 3 次标黄
function updateBox(u) {
  if (!u) return null;
  const when = u.lastCheckAt ? new Date(u.lastCheckAt).toLocaleString('zh-CN') : '还没检查过';
  const line = {
    dev: '开发版不检查更新。',
    off: '这种安装方式不支持自动更新，请到 Releases 页面下载新版。',
    idle: '启动 1 分钟后自动检查，之后每 6 小时检查一次。',
    checking: '正在检查…',
    none: '已是最新版本。',
    downloading: `正在下载新版本 ${u.version}… ${u.percent}%`,
    downloaded: u.mac
      ? `新版本 ${u.version} 已下载并校验通过。打开安装包，把 WAswitch 拖进“应用程序”替换旧版。`
      : `新版本 ${u.version} 已下载。缩到托盘后，没有未读、10 分钟没有新消息时会自动安装并重启；也可以现在重启。`,
    error: '这次检查没成功，会在 6 小时后自动再试。',
  }[u.status] || '';
  const busy = ['checking', 'downloading'].includes(u.status);
  return h('div', { class: `note ${u.warn ? 'warn' : 'plain'} update-box` },
    h('b', null, '软件更新'),
    h('span', null, line),
    u.status === 'downloading' ? h('div', { class: 'progress' }, h('span', { style: { width: `${u.percent}%` } })) : null,
    h('span', { class: 'hint' }, `上次检查：${when}${u.lastResult ? ` · ${u.lastResult}` : ''}`),
    u.warn ? h('span', null, `已经连续 ${u.failures} 次检查失败，可能是网络连不上 GitHub。可以到 Releases 页面手动下载新版。`) : null,
    u.status === 'dev' || u.status === 'off' ? null : h('div', { class: 'btns' },
      u.status === 'downloaded'
        ? h('button', { class: 'btn primary', onclick: () => window.wa.updateInstall() }, u.mac ? '打开安装包' : '现在重启并更新')
        : h('button', { class: 'btn', disabled: busy, onclick: () => window.wa.updateCheck() }, u.status === 'downloading' ? '正在下载…' : busy ? '检查中…' : '检查更新')));
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
  thumb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); unlock(); } });
  lockEl = h('div', { class: 'lockpage' },
    h('div', { class: 'lock-card' },
      h('span', { class: 'lock-icon' }, icon('lock', 22)),
      h('h1', null, '聊天已锁定'),
      h('p', { class: 'lead' }, '离开一会儿后自动遮住聊天内容。消息照常接收，通知和未读数不受影响。'),
      track,
      h('span', { class: 'hint' }, `在 设置 › 通用 里可以改等待时间或关闭。${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + L 立即锁定。`)));
  // 每次重新锁上时：滑块回到最左，焦点放到滑块上（按回车也能解锁）
  lockEl.reset = () => { startX = null; place(0); requestAnimationFrame(() => thumb.focus()); };
  return lockEl;
}

// 锁着时盖住整个内容区（网页版、轻量模式、编辑页、设置页都盖），下面的内容原样保留，编辑页没保存的不会丢
function renderLock() {
  const on = !!s.locked;
  const was = !$lock.hidden;
  $lock.hidden = !on;
  $content.hidden = on;
  if (on && !was) {
    const el = lockPage();
    if ($lock.firstChild !== el) $lock.replaceChildren(el);
    el.reset();
  }
}

function render(forceContent = false) {
  document.body.style.setProperty('--side', s.collapsed && s.page !== 'settings' ? '64px' : '200px');
  document.body.classList.toggle('collapsed', s.collapsed && s.page !== 'settings');
  const acc = active();
  if (s.page !== 'editor') liveColor = null;
  document.body.style.background = s.page === 'account' && acc ? tint(acc.color) : s.page === 'editor' ? tint(liveColor || s.editorColor) : '#E6E9ED';
  renderSide();
  renderAi();
  renderTop();
  renderLock();

  // 卡片内容：账号页每次都画（很轻）；编辑页只在打开时画一次，避免打字时被重置
  const key = s.page === 'editor' ? `editor:${s.editorId || 'new'}:${s.editorNonce}` : s.page;
  if (s.page === 'editor') {
    if (forceContent || key !== shown) $content.replaceChildren(editorPage(s.editorId));
  } else if (s.page === 'settings') {
    // 设置页里的下拉框打开时不重画，免得被关掉
    if (forceContent || key !== shown || !$content.contains(document.activeElement) || document.activeElement.tagName !== 'SELECT') $content.replaceChildren(settingsPage());
  } else if (s.page === 'overview') {
    // 只有内容变了才重画，免得滚动位置被打回顶部
    const sig = JSON.stringify([s.accounts.map((a) => [a.id, a.name, a.color, a.unread, a.muted, a.groupMuted, a.groupId]), s.groups, notifLogCache.length, notifLogCache[0]?.at]);
    if (key !== shown) loadNotifLog();
    if (forceContent || key !== shown || sig !== overviewSig) { overviewSig = sig; $content.replaceChildren(overviewPage()); }
    // 有新的未读时顺便刷新记录
    else if (s.accounts.reduce((n, a) => n + (a.unread || 0), 0) !== overviewTotal) loadNotifLog();
    overviewTotal = s.accounts.reduce((n, a) => n + (a.unread || 0), 0);
  } else if (s.page === 'welcome') {
    if (key !== shown) $content.replaceChildren(welcomePage());
  } else if (acc && !acc.problem && acc.mode === 'lite') {
    // 轻量模式聊天页：同一个元素反复更新，不重建
    const el = litePage(acc, s.lite);
    if ($content.firstChild !== el || $content.childNodes.length !== 1) $content.replaceChildren(el);
  } else {
    $content.replaceChildren(acc && acc.problem ? problemPage(acc) : '');
  }
  liteForget(s.accounts.map((a) => a.id));
  shown = key;
}

window.wa.onState((state) => { s = state; render(); });
