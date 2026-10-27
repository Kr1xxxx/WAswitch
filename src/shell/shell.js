// 软件界面：左侧账号栏、顶栏、右侧卡片里的页面（代理断开提示、编辑账号、设置、首次打开）。
// WhatsApp 页面本身是主进程叠在卡片上面的独立视图，这里不碰它。
// 所有来自用户或账号的数据一律用 textContent 显示，不拼 HTML。

const COLORS = ['#16A34A', '#7C3AED', '#EA580C', '#2563EB', '#DB2777', '#475569'];
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
  right: '<path d="m9 6 6 6-6 6"/>',
  warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  update: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.9-3.9L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.9L21 15"/><path d="M21 20v-5h-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  copy: '<rect x="4" y="8" width="12" height="12" rx="2.5"/><path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/>',
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

// ---------- 过渡动画 ----------
// 界面每次状态变化都整块重画，CSS transition 接不上。这里按“槽位”记住上次的值，值真的变了才给新元素放一次动画。
// 动画只用 opacity/transform，时长在 shell.css 的 --fx-* 里统一改；系统开了“减少动态效果”就不动
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
let settingsTab = 'general';
let checkResult = null;
let checkRunning = false;
// 团队页：登记表单里填的内容（状态推送会重画页面，值存在这里不丢）
const teamForm = { server: '', code: '', deviceName: '', picked: null, consent: false, busy: false, result: '', showUpload: false };
// 缓存大小：进入“内存”设置时查一次（30 秒内不重复查）
let cacheInfo = { mb: null, at: 0, busy: false, result: '' };
let memClean = { busy: false, result: '' };
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
  // 开了“同步到 CRM”的号：头像外圈蓝色、名字旁边 CRM 标记，侧栏收起时也看得到
  const avatar = h('span', { class: `avatar${acc.crm ? ' crm' : ''}`, style: { background: acc.color } }, acc.name.trim().charAt(0) || '?');
  // 从没登录过的号停在二维码页是正常的第一步：灰色“等待扫码”，不标红
  const waiting = acc.needsQr && !acc.everLoggedIn && !acc.problem;
  const lost = acc.needsQr && !waiting;
  if (acc.problem || lost) avatar.append(h('span', { class: 'dot bad' }, '!'));
  else if (s.collapsed && acc.unread) avatar.append(h('span', { class: `dot${quiet ? ' quiet' : ''}` }, acc.unread > 9 ? '9+' : acc.unread));
  const tip = [acc.name, acc.phone, acc.crm ? '这个号的单聊文字正在同步到公司 CRM' : '', acc.note, acc.unread ? `${acc.unread} 个未读对话` : '', acc.problem, waiting ? '等待扫码登录' : lost ? '需要扫码登录' : ''].filter(Boolean).join('\n');
  const row = h('button', {
    class: `row${on ? ' on' : ''}${on && sideFx ? ' fx-on' : ''}`, title: tip, 'aria-current': on ? 'true' : null,
    onclick: () => window.wa.switchTo(acc.id),
    oncontextmenu: (e) => { e.preventDefault(); window.wa.context(acc.id); },
  },
  avatar,
  h('span', { class: 'meta' },
    h('span', { class: 'name' }, acc.name, acc.crm ? h('span', { class: 'crm-tag', title: '这个号的单聊文字正在同步到公司 CRM' }, 'CRM') : null),
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
  // 箭头一直是朝下的那个，折起来转 -90°；刚点过就放一次转动
  const chev = g ? icon('down', 12) : null;
  if (chev) { chev.classList.add('gchev'); fx(`grp:${g.id}`, !!g.collapsed, chev, g.collapsed ? 'fx-rot-close' : 'fx-rot-open', false); }
  const head = h('button', {
    class: `group-head${g && g.collapsed ? ' closed' : ''}`,
    title: g ? `${name} · ${g.count} 个号${g.muted ? ' · 整组不弹通知' : ''}${g.collapsed ? '（已折叠，点开）' : ''}\n右键：改名、整组不弹通知、解散` : '没有放进分组的号',
    'aria-expanded': g ? String(!g.collapsed) : null,
    onclick: () => { if (g) window.wa.groupToggle(g.id); },
    oncontextmenu: (e) => { e.preventDefault(); if (g) window.wa.groupContext(g.id); },
  },
  chev,
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
    const rows = s.accounts.filter((a) => a.groupId === g.id && (!g.collapsed || (a.id === s.activeId && s.page === 'account'))).map(accountRow);
    // 刚展开的组：里面的号淡入
    if (fxChanged(`grprows:${g.id}`, !!g.collapsed, false) && !g.collapsed) rows.forEach((r) => fxPlay(r));
    out.push(...rows);
  }
  return out;
}

let sideFx = false;
function renderSide() {
  if (dragId) { sideStale = true; return; }
  // 正在给分组改名：不重画，免得输入框被换掉
  const editing = document.activeElement && document.activeElement.classList.contains('group-name');
  if (editing && s.editGroupId) return;
  const mac = s.platform === 'darwin';
  // 侧栏高亮换了（切账号、切设置页）：新高亮那一行淡入
  sideFx = fxChanged('side-on', s.page === 'account' ? `a:${s.activeId}` : s.page === 'editor' ? `e:${s.editorId || ''}` : s.page, false);
  const setFx = s.page === 'settings' && fxChanged('set-tab', settingsTab, false);
  $side.replaceChildren();
  $side.append(h('div', { class: 'win-drag' }));
  if (s.page === 'settings') {
    $side.append(
      h('button', { class: 'back', onclick: () => window.wa.showPage('account') }, icon('back', 14), '返回账号'),
      h('div', { class: 'label' }, '设置'),
      h('div', { class: 'list' }, settingsGroups().map(([title, tabs], i) => [
        i ? h('div', { class: 'tab-group' }, title) : null,
        ...tabs.map(([id, label]) =>
          h('button', { class: `tab${settingsTab === id ? ` on${setFx ? ' fx-on' : ''}` : ''}`, onclick: () => { settingsTab = id; render(true); } }, label,
            id === 'about' && updateReady() ? h('span', { class: 'tab-dot', title: '有新版本' }) : null))]).flat()));
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
      h('button', { class: `row${s.page === 'editor' && !s.editorId ? ` on${sideFx ? ' fx-on' : ''}` : ''}`, title: '添加账号', onclick: () => window.wa.add() },
        h('span', { class: 'avatar add' }, icon('plus', 14)), h('span', { class: 'text', style: { fontSize: '13px' } }, '添加账号'))),
    h('div', { class: 'grow' })));
  const upd = updateCard();
  if (upd) $side.append(upd);
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
    h('button', { class: 'icon-btn', title: updateReady() ? `设置 · 新版本 ${s.update.version} 已就绪` : '设置', 'aria-label': '设置', onclick: () => window.wa.showPage('settings') }, icon('gear', 17),
      updateReady() ? h('span', { class: 'dot new', 'aria-hidden': 'true' }) : null),
    s.settings?.showUpdateButton ? checkUpdateBtn() : null,
    bell));
  document.body.classList.toggle('mac', mac);
}

// 侧栏底部的“检查更新”按钮（设置里打开才显示）：点了只是立刻检查一次，下载和安装照旧走更新卡片
function checkUpdateBtn() {
  const u = s.update;
  const st = u ? u.status : 'dev';
  const busy = st === 'checking' || st === 'downloading';
  const title = {
    dev: '检查更新 · 开发版不检查更新',
    off: '检查更新 · 这种安装方式不能自动更新',
    checking: '正在检查更新…',
    downloading: `正在下载 ${u && u.version}`,
    downloaded: `新版本 ${u && u.version} 已就绪`,
    none: '检查更新 · 已是最新版本',
    error: '检查更新 · 上次没检查成功',
  }[st] || '检查更新';
  return h('button', { class: `icon-btn upd-check${busy ? ' busy' : ''}`, title, 'aria-label': '检查更新', disabled: st === 'dev' || st === 'off',
    onclick: () => { if (st === 'downloaded') { settingsTab = 'about'; window.wa.showPage('settings'); } else if (!busy) window.wa.updateCheckOnly(); } }, icon('sync', 16));
}

// ---------- 侧栏里的更新提示 ----------
// 下载中显示进度，下载好显示“重启更新”。点“稍后”只在这次运行里藏起这个版本的提示（关于页和设置图标上的小点还在）
let updateHidden = '';
const updateReady = () => !!(s.update && s.update.status === 'downloaded');
// 设置侧栏分组：常用设置在前，诊断和其他在后。
// 团队页只在登记过后台后常驻；没登记时从「关于 › 加入团队…」点进去才临时出现。
function settingsGroups() {
  const showTeam = (s.team && s.team.joined) || settingsTab === 'team';
  return [
    ['设置', [['general', '通用'], ['translate', '翻译'], ['notify', '通知'], ['memory', '内存']]],
    ['诊断', [['check', '隔离自检'], ['net', '连接记录']]],
    ['其他', [showTeam ? ['team', '团队'] : null, ['about', '关于']].filter(Boolean)],
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

// 内存数字的说明：后台号涨到回收线会悄悄刷新一次，刷新后数字会一下变小，再慢慢涨回 300 MB 左右
function memTitle(acc, lite) {
  if (lite) return '轻量模式账号共用一个后台进程，这里是平均到每个号的近似值';
  const r = acc.lastRecycle;
  const tip = '内存占用（近似值，只算这个号的页面进程）';
  if (!r || !r.at) return tip;
  const t = new Date(r.at);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return `${tip}\n${hm} 在后台自动刷新过一次（当时 ${r.mb} MB），刷新后数字会先变小，几分钟内涨回正常。登录和聊天记录都不受影响。`;
}

// 顶栏的缩放比例：点一下展开 − / + 自己调，再点比例或点别处收起
let zoomOpenFor = '';
function zoomChip(acc) {
  const pct = `${Math.round((acc.zoom || 0.9) * 100)}%`;
  const key = s.platform === 'darwin' ? 'Cmd' : 'Ctrl';
  const toggle = (e) => { e.stopPropagation(); zoomOpenFor = zoomOpenFor === acc.id ? '' : acc.id; renderTop(); };
  if (zoomOpenFor !== acc.id) {
    return h('button', { class: 'chip', type: 'button', title: `页面缩放 ${pct}，点一下调整（${key} + = / - / 0 也能调）`, onclick: toggle }, pct);
  }
  const step = (dir) => (e) => { e.stopPropagation(); window.wa.zoom(acc.id, dir); };
  const z = acc.zoom || 0.9;
  return h('span', { class: 'chip zoom-ctl', onclick: (e) => e.stopPropagation() },
    h('button', { type: 'button', class: 'zbtn', title: '缩小', 'aria-label': '缩小', disabled: z <= 0.5, onclick: step(-1) }, '−'),
    h('button', { type: 'button', class: 'zpct', title: '收起', onclick: toggle }, pct),
    h('button', { type: 'button', class: 'zbtn', title: '放大', 'aria-label': '放大', disabled: z >= 2, onclick: step(1) }, '+'),
    z !== 0.9 ? h('button', { type: 'button', class: 'zreset', title: '还原到默认 90%', onclick: step(0) }, '默认') : null);
}
const closeZoom = () => { if (zoomOpenFor) { zoomOpenFor = ''; renderTop(); } };
document.addEventListener('click', closeZoom);
window.addEventListener('blur', closeZoom); // 点进 WhatsApp 页面时也收起

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
    !lite ? zoomChip(acc) : null,
    clockChip(acc),
    acc.memMB ? h('span', { class: 'chip', title: memTitle(acc, lite) }, `${acc.memMB} MB`) : null,
    h('button', { class: `icon-btn${s.panelOpen ? ' on' : ''}`, title: `工作台：客户资料、话术、翻译（${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + Shift + K）`, 'aria-label': '工作台', 'aria-pressed': String(!!s.panelOpen), onclick: () => window.wa.panelToggle() }, icon('book', 15)),
    h('button', { class: 'icon-btn', title: lite ? '重新连接' : '刷新', 'aria-label': lite ? '重新连接' : '刷新', onclick: () => window.wa.reload(acc.id) }, icon('reload', 15)),
    h('button', { class: 'icon-btn', title: '账号菜单（右键账号也可以打开）', 'aria-label': '账号菜单', onclick: () => window.wa.context(acc.id) }, icon('more', 15))));
}

// 右侧工作台顶部的切页：客户资料 / 话术 / 翻译（翻译有未读数）
function panelHead() {
  const tabFx = fxChanged('wb-tab-head', s.panelTab || 'replies', false);
  const tab = (id, label, ic) => {
    const on = s.panelTab === id;
    const badge = id === 'translate' && !on && dk.unread > 0 ? h('span', { class: 'tb-badge', 'aria-label': `${dk.unread} 条新消息` }, dk.unread > 99 ? '99+' : String(dk.unread)) : null;
    return h('button', { class: `tb-tab${on ? ` on${tabFx ? ' fx-on' : ''}` : ''}`, role: 'tab', 'aria-selected': String(on), onclick: () => { if (!on) window.wa.panelTab(id); } }, ic ? icon(ic, 15) : null, label, badge);
  };
  return h('div', { class: 'wb-tabs', role: 'tablist', 'aria-label': '工作台' },
    tab('customers', '客户资料'), tab('replies', '话术'), tab('translate', '翻译', 'translate'),
    h('span', { class: 'grow' }),
    h('button', { class: 'icon-btn', title: '收起', 'aria-label': '收起工作台', onclick: () => window.wa.panelToggle(false) }, icon('back', 14)));
}
function refreshPanelHead() {
  const old = $panel.querySelector('.wb-tabs');
  if (old) old.replaceWith(panelHead());
}

// AI（MCP 客户端）想切换账号或打开添加页，但用户正在打字：问一下，不直接切
function renderAi() {
  const r = s.aiRequest;
  $ai.hidden = !r;
  if (fxChanged('ai', !!r, false) && r) fxPlay($ai, 'fx-down');
  if (!r) return;
  const what = r.kind === 'add'
    ? (r.name ? `AI 想打开“添加账号”（预填「${r.name}」）` : 'AI 想打开“添加账号”')
    : `AI 想切到「${r.name}」`;
  $ai.replaceChildren(
    h('span', { class: 'grow' }, what),
    h('button', { class: 'btn', onclick: () => window.wa.aiAnswer(false) }, '忽略'),
    h('button', { class: 'btn primary', onclick: () => window.wa.aiAnswer(true) }, r.kind === 'add' ? '打开' : '切换'));
}

// 删除、清空前的确认框（软件里统一用这一个）。on: 'panel' 只盖住右侧面板（账号页时 WhatsApp 页面盖着中间，盖不住）；
// 不传就盖住整个卡片内容区。默认焦点在“取消”，Esc 或点外面也是取消。返回 true 表示确认。
function confirmDelete({ title, detail = '', ok = '删除', on } = {}) {
  return new Promise((resolve) => {
    const body = document.getElementById('body');
    const panel = document.getElementById('panel');
    const prevFocus = document.activeElement;
    const cancelBtn = h('button', { class: 'btn', type: 'button' }, '取消');
    const okBtn = h('button', { class: 'btn danger-fill', type: 'button' }, ok);
    const box = h('div', { class: 'cfm-box', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'cfm-title' }, title),
      detail ? h('div', { class: 'cfm-detail' }, detail) : null,
      h('div', { class: 'cfm-btns' }, cancelBtn, okBtn));
    const wrap = h('div', { class: 'cfm' }, box);
    if (on === 'panel' && panel && !panel.hidden) {
      const b = body.getBoundingClientRect(), r = panel.getBoundingClientRect();
      Object.assign(wrap.style, { left: `${r.left - b.left}px`, width: `${r.width}px` });
    }
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      // 淡出后再拿掉；结果马上给，不等动画
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), fxReduced() ? 0 : 140);
      try { prevFocus?.focus?.(); } catch {}
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === cancelBtn ? okBtn : cancelBtn).focus(); }
    };
    cancelBtn.onclick = () => done(false);
    okBtn.onclick = () => done(true);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(false); });
    document.addEventListener('keydown', onKey, true);
    body.append(wrap);
    cancelBtn.focus();
  });
}
// 名字太长时截一下，免得确认框被撑开
const delName = (t, n = 30) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

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
    acc.retrying ? h('p', { class: 'hint' }, acc.direct ? '正在自动重试，网络恢复后会自动连上。' : '正在自动重试，网络或 Clash 恢复后会自动连上。') : null,
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
    h('summary', null, `详细信息 · ${acc.problemCode}`),
    h('p', null, `问题代码 ${acc.problemCode}，日志里也记着这个代码。`, ' ', logs));
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
      notifLogCache.length ? h('button', { class: 'btn', onclick: async () => { if (!await confirmDelete({ title: '清空通知记录？', detail: `会删掉这里的 ${notifLogCache.length} 条记录，不影响未读数和聊天。`, ok: '清空' })) return; await window.wa.notifClear(); loadNotifLog(); } }, '清空记录') : null),
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

// ---------- 右侧面板：话术库和客户名单 ----------
// 只存本机。点“复制”放进剪贴板；点“插入”等于帮你按一次 Ctrl+V 贴进当前聊天框（会覆盖剪贴板），不会自动发送
const pn = { tab: 'replies', q: '', all: false, edit: null, msg: '', bad: false, data: { replies: [], customers: [] }, loaded: false, accountId: null, sig: '' };
async function panelLoad() {
  try { pn.data = await window.wa.panelData(); pn.loaded = true; } catch {}
  renderPanel(true);
}
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
  const phone = h('input', { value: c.phone || '', maxlength: '40', placeholder: '电话（例如 +81 90 1234 5678）', 'aria-label': '电话' });
  const tags = h('input', { value: (c.tags || []).join('，'), maxlength: '220', placeholder: '标签，用逗号隔开', 'aria-label': '标签' });
  const note = h('textarea', { maxlength: '500', placeholder: '备注', 'aria-label': '备注' }, c.note || '');
  const due = h('input', { type: 'datetime-local', value: toLocalInput(c.followUpAt), 'aria-label': '下次跟进时间' });
  const lang = h('select', { 'aria-label': '翻译用的语言' }, h('option', { value: '' }, '翻译语言：跟随账号'), ((tr.cfg && tr.cfg.langs) || []).map((l) => h('option', { value: l }, `翻译成${l}`)));
  lang.value = c.lang || '';
  const acc = h('select', { 'aria-label': '属于哪个号' }, s.accounts.map((a) => h('option', { value: a.id }, a.name)));
  acc.value = s.accounts.some((a) => a.id === c.accountId) ? c.accountId : (s.activeId || '');
  requestAnimationFrame(() => name.focus());
  return h('div', { class: 'pn-form' }, name, phone, tags, note,
    h('label', { class: 'hint' }, '下次跟进（到时间弹一条只写名字的提醒）'), due,
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
  if (!list.length) return [h('div', { class: 'hint', style: { padding: '8px 2px' } }, pn.data.replies.length ? '没有找到。' : '还没有话术。点“新建”加一条常用回复。')];
  return list.map((r) => h('div', { class: 'pn-item' },
    r.title ? h('span', { class: 't' }, r.title) : null,
    h('span', { class: 'x' }, r.text),
    h('span', { class: 'acts' },
      h('button', { class: 'pn-btn primary', title: '贴进当前聊天框（会覆盖剪贴板），不会自动发送', onclick: () => panelInsert(r.text) }, '插入'),
      h('button', { class: 'pn-btn', onclick: async (e) => { const b = e.currentTarget; await window.wa.panelCopy(r.text); copyFlash(b); } }, '复制'),
      h('button', { class: 'pn-btn', onclick: () => { pn.edit = { ...r }; renderPanel(true); } }, '编辑'),
      h('button', { class: 'pn-btn', onclick: async () => { if (!await confirmDelete({ on: 'panel', title: `删除话术「${delName(r.title || r.text)}」？`, detail: '删除后不能恢复。' })) return; pn.data = await window.wa.replyDelete(r.id); panelSay('已删除'); } }, '删除'))));
}
function customerItems() {
  const q = pn.q.toLowerCase();
  const list = pn.data.customers
    .filter((c) => pn.all || c.accountId === pn.accountId)
    .filter((c) => !q || `${c.name}\n${c.phone}\n${c.tags.join(',')}\n${c.note}`.toLowerCase().includes(q))
    .sort((a, b) => (a.followUpAt || Infinity) - (b.followUpAt || Infinity) || b.updatedAt - a.updatedAt);
  if (!list.length) return [h('div', { class: 'hint', style: { padding: '8px 2px' } }, pn.data.customers.length ? '没有找到。' : '还没有客户。点“新建”记一个。')];
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
      h('button', { class: 'pn-btn', onclick: async () => { if (!await confirmDelete({ on: 'panel', title: `删除客户「${delName(c.name || c.phone)}」？`, detail: '会删掉这个客户的资料、标签、备注和跟进时间，不能恢复。WhatsApp 里的聊天不受影响。' })) return; pn.data = await window.wa.custDelete(c.id); panelSay('已删除'); } }, '删除'))));
}
// ---------- 翻译（面板里的第三个标签） ----------
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
// 翻译设置的缓存（设置 › 翻译、客户表单的语言选项用）；面板“翻译”页在 dock.js
const tr = { cfg: null, modes: [], outMode: LS('tr.outMode') || '' };
async function trLoad() {
  if (tr.loading) return;
  tr.loading = true;
  try { const r = await window.wa.trConfig(); tr.cfg = r.config; tr.modes = r.modes; } catch {}
  tr.loading = false;
  if (!tr.cfg) return; // 读不到就不重画，免得一直重试
  if (s.page === 'settings' && settingsTab === 'translate') render(true);
}
const modesFor = (dir) => tr.modes.filter((m) => m.direction === dir || m.direction === 'both');
// ---------- 设置 › 翻译 ----------
let trEdit = null; // 正在编辑的服务商 { id?, preset, name, baseUrl, model, key }
let trModeEdit = null;
let trSay = '';
let trTestRes = {};
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
async function trOpenKey(pid) {
  if (!tr.cfg) { try { const r = await window.wa.trConfig(); tr.cfg = r.config; tr.modes = r.modes; } catch {} }
  const p = tr.cfg && tr.cfg.providers.find((x) => x.id === pid);
  if (trAdvanced) { trEdit = p ? { ...p } : trEdit; trFocusKey = !!p; } else trKeyFocus = p ? p.id : '';
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
  const key = h('input', { type: 'password', value: '', autocomplete: 'off', placeholder: e.hasKey ? `已设置（尾号 ${e.keyTail}），不改就留空` : 'API 密钥' });
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
  return h('div', { class: 'box tr-form' },
    h('b', null, e.id ? '修改服务商' : '添加服务商'),
    setRow('类型', deepl ? 'DeepL 只做翻译，不会按“模式”改语气，也不会纠错。适合当备用。' : '选好会自动填地址和模型。', preset),
    setRow('名称', '可不填。', name),
    deepl ? null : setRow('接口地址', preset.value === 'hunyuan' ? '腾讯混元海外账号填 https://tokenhub-intl.tencentcloudmaas.com/v1。' : '一般不用改。', base),
    deepl ? null : setRow('模型', listFor(preset.value) ? '' : 'OpenRouter 的模型名去它网站上复制，例如 deepseek/deepseek-chat。', modelBox),
    setRow('API 密钥', deepl ? 'DeepL 网站账户里的 API 密钥。免费版（以 :fx 结尾）和付费版都行，会自动选对地址。会加密保存。' : `${{ hunyuan: '填腾讯云 TokenHub 的密钥。', zhipu: '智谱开放平台（bigmodel.cn）里的 API 密钥。' }[preset.value] || ''}会加密保存。`, key,
      preset.value === 'zhipu' ? h('a', { href: '#', class: 'tr-keylink', onclick: (ev) => { ev.preventDefault(); window.wa.openLink(ZHIPU_KEYS); } }, '没有密钥？去智谱开放平台申请（glm-4-flash 免费）') : null),
    deepl ? null : setRow('深度思考', isMt ? '混元翻译模型用不上这项。' : '翻译用不上，选“禁用”更快。', think),
    h('div', { class: 'hstack', style: { paddingTop: '12px' } },
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await window.wa.trProviderSave({ id: e.id, preset: preset.value, name: name.value, baseUrl: base.value, model: model.value, key: key.value, thinking: think.value });
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
    placeholder: '例如：\n你是睫毛产品的外贸业务员，翻译要专业、礼貌。\n这些词固定这样翻译：\n睫毛盘 = lash tray\n贴牌 = private label' },
  trRoleDraft ?? (c.rolePrompt || ''));
  ta.addEventListener('input', () => { trRoleDraft = ta.value; });
  return h('div', { class: 'col', style: { gap: '8px' } }, ta,
    h('div', { class: 'hstack' }, h('button', { class: 'btn primary', onclick: async () => {
      const r = await window.wa.trRole(ta.value);
      if (!r.error) { trRoleDraft = null; trSay = '角色设定已保存'; }
      apply(r);
    } }, '保存角色设定')));
}
// 简单版：每个服务商一行，只填密钥。保存时其他设置照原样带回去
function trKeysBox(c, apply) {
  if (!c.providers.length) return h('div', { class: 'box' }, h('span', { class: 'hint' }, '还没有翻译服务商，点上面的“详细设置”添加。'));
  const order = (p) => (p.id === c.primaryId ? 0 : p.id === c.fallbackId ? 1 : p.id === c.fixId ? 2 : 3);
  const tag = (t) => h('span', { class: 'pn-tag', style: { marginLeft: '6px' } }, t);
  return h('div', { class: 'box tr-keys' }, [...c.providers].sort((a, b) => order(a) - order(b)).map((p) => {
    const key = h('input', { type: 'password', value: '', autocomplete: 'off', 'aria-label': `${p.name} 的 API 密钥`,
      placeholder: p.hasKey ? `已填（尾号 ${p.keyTail}），不改就留空` : '粘贴 API 密钥' });
    const save = async () => {
      if (!key.value.trim()) { trSay = `先把「${p.name}」的密钥粘贴进来`; render(true); return; }
      const r = await window.wa.trProviderSave({ id: p.id, preset: p.preset, name: p.name, baseUrl: p.baseUrl, model: p.model, key: key.value, thinking: p.thinking });
      if (!r.error) { trSay = `「${p.name}」的密钥已保存`; trTestRes[p.id] = ''; }
      apply(r);
    };
    key.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
    if (trKeyFocus === p.id) requestAnimationFrame(() => { if (trKeyFocus !== p.id || !key.isConnected) return; trKeyFocus = ''; key.scrollIntoView({ block: 'center' }); key.focus(); });
    const link = p.preset === 'zhipu' && !p.hasKey ? h('a', { href: '#', class: 'tr-keylink', onclick: (ev) => { ev.preventDefault(); window.wa.openLink(ZHIPU_KEYS); } }, '没有密钥？去智谱开放平台申请（glm-4-flash 免费）') : null;
    const roles = [p.id === c.primaryId ? tag('默认') : null, p.id === c.fallbackId ? tag('备用') : null, p.id === c.fixId ? tag('纠错') : null];
    return h('div', { class: 'tr-krow' },
      h('div', { class: 'meta' },
        h('span', { class: 'title' }, h('b', null, p.name), ...roles),
        h('span', { class: 'desc' }, p.hasKey ? `已填密钥 · ${p.preset === 'deepl' ? '机器翻译' : p.model}` : `还没填密钥 · ${p.preset === 'deepl' ? '机器翻译' : p.model}`),
        trTestRes[p.id] ? h('span', { class: 'desc' }, trTestRes[p.id]) : null,
        link),
      h('span', { class: 'hstack', style: { gap: '6px' } }, key,
        h('button', { class: 'btn primary sm', onclick: save }, '保存'),
        h('button', { class: 'btn sm', disabled: !p.hasKey, title: p.hasKey ? '' : '先填密钥', onclick: async () => { trTestRes[p.id] = '测试中…'; render(true); const r = await window.wa.trTest(p.id); trTestRes[p.id] = r.ok ? `通了，${r.ms} ms` : r.error; render(true); } }, '测试')));
  }));
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
    h('option', { value: '' }, '用默认的'), c.providers.filter((p) => p.preset !== 'deepl' || p.id === c.fixId).map((p) => h('option', { value: p.id }, p.model ? `${p.name}（${p.model}）` : p.name)),
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
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
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
    h('div', { class: 'col', style: { gap: '6px' } },
      h('div', { class: 'tr-head' }, h('h1', null, '翻译'), toggle),
      h('p', { class: 'lead' }, `在右侧面板的“翻译”里用。每个号默认都会把客户发来的消息自动翻成中文，不想要的号在${trAdvanced ? '下面' : '“详细设置”里'}关掉。你的回复翻好后要自己按发送，不会自动发出。`)),
    trSay ? h('div', { class: 'hint', role: 'status' }, trSay) : null,
    !c.canEncrypt ? h('div', { class: 'tr-warn' }, '这台电脑不支持加密保存，暂时不能保存密钥。') : null,
  ];
  if (!trAdvanced) {
    page.append(...kids(...head,
      h('h2', { class: 'ov-h2' }, 'API 密钥'),
      h('p', { class: 'hint' }, '填好密钥就能翻译。服务商、网络、纠错、翻译模式都已经设好，一般不用改；要改点右上角“详细设置”。'),
      trKeysBox(c, apply)));
    return;
  }
  page.append(...kids(...head,
    h('h2', { class: 'ov-h2' }, '服务商'),
    h('div', { class: 'box' }, c.providers.length ? c.providers.map((p) => h('div', { class: 'tr-prow' },
      h('span', null, h('b', null, p.name), p.id === c.primaryId ? h('span', { class: 'pn-tag', style: { marginLeft: '6px' } }, '默认') : p.id === c.fallbackId ? h('span', { class: 'pn-tag', style: { marginLeft: '6px' } }, '备用') : null,
        p.id === c.fixId ? h('span', { class: 'pn-tag', style: { marginLeft: '6px' } }, '纠错') : null),
      h('span', { class: 'hint' }, `${p.preset === 'deepl' ? '机器翻译' : p.model} · ${p.hasKey ? `密钥尾号 ${p.keyTail}` : '没有密钥'}`),
      h('span', { class: 'hint' }, trTestRes[p.id] || ''),
      h('span', { class: 'hstack', style: { gap: '4px' } },
        h('button', { class: 'pn-btn', onclick: async () => { trTestRes[p.id] = '测试中…'; render(true); const r = await window.wa.trTest(p.id); trTestRes[p.id] = r.ok ? `通了，${r.ms} ms` : r.error; render(true); } }, '测试'),
        p.id !== c.primaryId ? h('button', { class: 'pn-btn', onclick: async () => apply(await window.wa.trRoles(p.id, c.fallbackId === p.id ? '' : c.fallbackId)) }, '设为默认') : null,
        h('button', { class: 'pn-btn', onclick: () => { trEdit = { ...p }; render(true); } }, '修改'),
        h('button', { class: 'pn-btn', onclick: async () => { if (!await confirmDelete({ title: `删除服务商「${delName(p.name)}」？`, detail: `保存的密钥也会一起删掉。${p.id === c.primaryId ? '它是现在的默认服务商，删了以后要重新选一个。' : ''}` })) return; apply(await window.wa.trProviderDelete(p.id)); } }, '删除'))))
      : h('span', { class: 'hint' }, '还没有。')),
    trEdit ? trProviderForm() : h('div', null, h('button', { class: 'btn', onclick: () => { trEdit = { preset: 'zhipu' }; trSay = ''; render(true); } }, '+ 添加服务商')),
    c.providers.length > 1 ? setRow('备用服务商', '默认的连不上或出错时，自动换这个再试一次。', fb) : null,
    c.providers.length ? setRow('纠错服务商', '点“纠错”时用这个。混元翻译模型和 DeepL 不会纠错，建议用智谱 glm-4-flash。',
      h('span', { class: 'col', style: { gap: '4px' } }, fixSel,
        fixP && (/^hy-mt/i.test(fixP.model) || fixP.preset === 'deepl') ? h('span', { class: 'hint' }, '这个服务商不会纠错，只会重翻一遍。') : null)) : null,
    setRow('翻译的网络', '和 WhatsApp 账号分开。OpenRouter 在国内一般要选代理。',
      // “已保存”跟在后面；出错的话比较长，放到下面一行
      h('span', { class: 'col', style: { flex: '0 1 auto', gap: '4px', maxWidth: '420px', marginTop: '-7px' } },
        h('span', { class: 'hstack', style: { gap: '6px' } }, netSel, netMode === 'proxy' ? proxyIn : null, trNetErr ? null : netSay),
        trNetErr ? netSay : null)),
    s.accounts.length ? setRow('自动翻译收到的消息', '默认都开。关掉的号不再自动翻，手动点“翻译”照常能用。和右侧面板“翻译”里的开关是同一个。',
      h('span', { class: 'col tr-auto' }, s.accounts.map((a) => h('span', { class: 'hstack tr-auto-row' },
        h('span', { class: 'tr-auto-name' }, h('span', { class: 'sw', style: { background: a.color } }), a.name),
        a.mode === 'lite' ? h('span', { class: 'hint', title: '轻量模式读不到对话，不能自动翻译' }, '轻量模式不支持')
          : sw(c.accountAuto[a.id] !== false, `${a.name} 自动翻译`, async (v) => apply(await window.wa.trAuto(a.id, v))))))) : null,
    setRow('每个号每天最多自动翻译', '超了就停到第二天，手动翻译不受影响。',
      (() => { const sel = h('select', { 'aria-label': '每天上限', onchange: async (e) => apply(await window.wa.trDailyCap(Number(e.target.value))) }, (c.dailyCaps || [500]).map((n) => h('option', { value: String(n) }, `${n} 条`))); sel.value = String(c.dailyCap || 500); return sel; })()),
    h('h2', { class: 'ov-h2' }, '角色设定'),
    h('div', { class: 'box tr-form' },
      trRoleBox(c, apply),
      h('span', { class: 'desc', style: { fontSize: '13px', lineHeight: '1.6', color: 'var(--muted)', whiteSpace: 'pre-line' } },
        '告诉 AI 你是谁、哪些词怎么翻，可以不填。一行一个“中文 = 外语”就是固定译法。\n'
        + '混元翻译模型只认固定译法，其他文字不起作用。')),
    h('h2', { class: 'ov-h2' }, '翻译模式'),
    h('p', { class: 'hint' }, '每个模式是一段提示词。“发出”的模式用在“翻译”按钮，“收到”的用来翻客户发来的消息。'),
    trModeEdit ? trModeForm() : null,
    h('div', { class: 'box' }, tr.modes.map((m) => h('div', { class: 'tr-prow' },
      h('b', null, m.name), h('span', { class: 'hint' }, { out: '发出', in: '收到', both: '都可以' }[m.direction]),
      h('span', { class: 'hint', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.prompt),
      h('span', { class: 'hstack', style: { gap: '4px' } },
        h('button', { class: 'pn-btn', onclick: () => { trModeEdit = { ...m }; render(true); } }, '修改'),
        h('button', { class: 'pn-btn', onclick: async () => { if (!await confirmDelete({ title: `删除翻译模式「${delName(m.name)}」？`, detail: '删除后不能恢复。' })) return; apply(await window.wa.tmodeDelete(m.id)); } }, '删除'))))),
    h('div', { class: 'hstack' },
      h('button', { class: 'btn', onclick: () => { trModeEdit = { direction: 'out', temperature: 0.3 }; trSay = ''; render(true); } }, '+ 新建模式'),
      h('button', { class: 'btn', onclick: async () => { const r = await window.wa.panelImport('tmodes'); if (!r) return; if (r.error) trSay = `导入失败：${r.error}`; else { trSay = `导入了 ${r.added} 个${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`; tr.modes = r.modes; } render(true); } }, '导入'),
      h('button', { class: 'btn', onclick: async () => { const r = await window.wa.panelExport('tmodes', 'json'); if (r) { trSay = `导出了 ${r.count} 个`; render(true); } } }, '导出'))));
}

// force：用户在面板里操作了；不 force 时，面板里正在输入就不重画
function renderPanel(force = false) {
  const show = !!s.panelOpen && !s.locked && s.page === 'account';
  $panel.hidden = !show;
  if (fxChanged('panel-open', show, false) && show) fxPlay($panel, 'fx-panel');
  if (!show) return;
  if (!pn.loaded) { pn.loaded = true; panelLoad(); }
  const tab = s.panelTab || 'replies';
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
      return panelSay(`导入了 ${r.added} 条${r.skipped ? `，跳过 ${r.skipped} 条` : ''}`);
    }
    const r = await window.wa.panelExport(kind, what);
    if (r) panelSay(`导出了 ${r.count} 条`);
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
      h('button', { class: 'pn-btn', onclick: () => io('csv') }, '导出 CSV'),
      h('button', { class: 'pn-btn', onclick: () => io('json') }, '导出 JSON'),
      h('span', { class: 'hint', style: { width: '100%' } }, '只存在这台电脑上，不上传。“插入”会占用剪贴板，不会自动发送。'))));
  // 切了页或打开/关掉编辑表单：下面的内容淡入
  const editChanged = fxChanged('pn-edit', !!pn.edit, false);
  if (tabChanged || editChanged) [...$panel.children].slice(1).forEach((el) => fxPlay(el, 'fx-fade'));
}

function welcomePage() {
  const step = (n, title, text) => h('li', null, h('span', { class: 'n' }, n), h('span', { class: 'meta' }, h('b', null, title), h('small', null, text)));
  return h('div', { class: 'center', style: { background: '#fff' } }, h('div', { class: 'col', style: { maxWidth: '640px', gap: '26px' } },
    h('div', { class: 'col', style: { gap: '10px' } },
      h('h1', { style: { fontSize: '30px' } }, '一个窗口，同时登录多个 WhatsApp'),
      h('p', { class: 'lead' }, '每个账号独立隔离：登录和缓存分开存，可以走各自的代理线路，时区跟着线路走，WhatsApp 界面统一中文。')),
    h('ol', { class: 'steps' },
      step(1, '起个名字，选个颜色', '比如“客服号”“店铺号”。颜色会铺满窗口背景，一眼认出在用哪个号。'),
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
        !d.liteAvailable ? h('span', { class: 'hint' }, '这台电脑不支持加密保存，不能使用轻量模式。') : null)
      : h('div', { class: 'field' }, '账号类型', h('div', { class: 'tags' }, h('span', { class: 'tag' }, mode === 'lite' ? '轻量模式（添加后不能改）' : '网页版（添加后不能改）')));
    const name = h('input', { type: 'text', value: d.name, 'aria-label': '名称', maxlength: '40' });
    const note = h('input', { type: 'text', value: d.note || '', 'aria-label': '备注', maxlength: '200', placeholder: '可不填，例如：日本客户群 · 小王负责' });
    const phone = h('input', { type: 'text', class: 'mono', value: d.phone || '', 'aria-label': '手机号', maxlength: '24', placeholder: '登录后自动填写，也可以自己填' });
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
        h('span', { class: 'tag' }, auto
          ? (proxyInput.value.trim() ? '时区：还没识别，点“测试”自动选好' : '时区：跟本机一致')
          : `时区：${opt ? opt.label : ''}`),
        h('span', { class: 'tag' }, `界面语言：${d.uiLanguage || '中文'}`),
        h('span', { class: 'tag' }, 'Chrome · 跟随本机系统'),
        h('span', { class: 'tag' }, proxyInput.value.trim() ? 'WebRTC 只走代理' : '直连：用本机真实 IP'));
    };
    // 选直连：轻量号、或已经有别的直连号时提醒一句（同一出口 IP），不拦
    const others = (d.otherDirect || []).map((n) => `「${n}」`).join('、');
    const liteDirectHint = h('span', { class: 'hint', style: { color: '#B54708' } });
    const drawLiteDirect = () => {
      const direct = !proxyInput.value.trim();
      liteDirectHint.hidden = !(direct && (mode === 'lite' || others));
      // 轻量号直连不用测试，“填了代理要先测试”那句只在填了代理时显示
      proxyHint.hidden = direct && mode === 'lite';
      liteDirectHint.textContent = others ? `提示：和${others}都是直连，用同一个出口 IP，有被关联的风险。` : '提示：轻量小号直连会用这台电脑的真实 IP，有被关联的风险。';
    };
    const onProxyChange = () => {
      drawLiteDirect();
      passwordRow.hidden = !/^https?:\/\/[^/@]+@/i.test(proxyInput.value.trim());
      callsRow.hidden = mode === 'lite' || !!proxyInput.value.trim();
      result.replaceChildren();
      tested = null;
      drawPresets();
      drawPortNote();
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
      ? [h('div', { class: 'qr' }, mode === 'lite' ? '保存后右边会显示登录二维码' : '保存后右边会打开 WhatsApp 登录页，显示二维码'),
        h('ol', null, h('li', null, '手机打开 WhatsApp'), h('li', null, '设置 › 已关联的设备'), h('li', null, '关联新设备，扫码'))]
      : [h('span', null, mode === 'lite' ? '修改代理后会重新连接，不需要重新扫码。' : '修改代理或时区后，这个账号的页面会重新加载，不需要重新扫码。')]);
    const sidePanel = h('div', { class: 'side-panel' });
    proxyInput.addEventListener('input', onProxyChange);
    region.addEventListener('change', drawTags);

    testBtn.onclick = async () => {
      if (!proxyInput.value.trim()) {
        result.replaceChildren(h('div', { class: 'note plain' }, mode === 'lite' ? '直连不需要测试，轻量号会直接用这台电脑的网络（不经过系统代理，Clash 要开 TUN 模式）。' : '直连不需要测试，这个账号会跟随电脑的系统代理：Clash 开着系统代理时走 Clash，关了就是本机网络。'));
        return;
      }
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      result.replaceChildren(h('div', { class: 'note plain' }, '正在通过这个代理访问 ipinfo.io …'));
      const res = await window.wa.editorTest({ id: d.id, proxy: proxyInput.value, password: password.value });
      testBtn.disabled = false;
      testBtn.textContent = '重新测试';
      if (localProxyPort(proxyInput.value)) probePorts();
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
      // 直连不用测试；填了代理的轻量号仍要先测试通过
      if (mode === 'lite' && proxyInput.value.trim() && !tested && (d.isNew || proxyInput.value.trim() !== d.proxy || password.value)) { error.textContent = '请先点“测试”，代理测试通过后才能保存'; saveBtn.disabled = false; return; }
      const res = await window.wa.editorSave({ id: d.id, name: name.value.trim(), note: note.value, phone: phone.value, color, proxy: proxyInput.value, password: password.value, region: region.value, mode, primary: mode === 'web' && primary.checked, liteConfirm: liteConfirm.checked, allowCalls: allowCalls.checked });
      saveBtn.disabled = false;
      if (res && res.error) error.textContent = res.error;
    };

    drawSwatches();
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
    root.addEventListener('click', (e) => { if (e.target.closest('.swatch, .mode, .preset')) markDirty(); });
    root.replaceChildren(
      h('div', { class: 'col' },
        h('div', { class: 'col', style: { gap: '6px' } },
          h('h1', null, d.isNew ? '添加账号' : '编辑账号'),
          h('p', { class: 'lead' }, '每个账号的登录、缓存、网络线路和时区都互相独立。')),
        h('div', { class: 'hstack', style: { alignItems: 'flex-end', gap: '14px' } },
          h('label', { class: 'field', style: { flex: '1' } }, '名称', name),
          h('div', { class: 'field' }, '颜色', swatches)),
        h('label', { class: 'field' }, '手机号', phone, h('span', { class: 'hint' }, '登录后自动读出这个号的手机号，鼠标停在侧栏账号上就能看到。自己填了就以你填的为准，清空后重新自动读取。')),
        h('label', { class: 'field' }, '备注', note, h('span', { class: 'hint' }, '只给自己看：显示在顶栏和侧栏（鼠标停在账号上）。')),
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
    h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '连接记录'),
      h('p', { class: 'lead' }, '最近 7 天每个号的掉线和恢复。“用时”每 30 分钟测一次，可当网速参考。')),
    h('div', { class: 'box' }, s.accounts.map((a) => {
      const drops = netLogCache.filter((e) => e.id === a.id && e.at >= dayAgo && (e.kind === 'down' || e.kind === 'qr')).length;
      return h('div', { class: 'tr-prow' },
        h('span', null, h('span', { class: 'sw', style: { background: a.color } }), a.name),
        h('span', { class: 'hint' }, a.direct ? '直连 · 不检测' : a.latency ? `最近用时 ${a.latency.ms} ms` : '还没测过'),
        h('b', { style: { textAlign: 'right', color: drops ? 'var(--danger)' : null } }, `24 小时掉线 ${drops} 次`),
        h('span', { class: 'hint' }, a.problem ? a.problemShort : '正常'));
    })),
    h('div', { class: 'hstack', style: { justifyContent: 'space-between' } }, filterSel,
      netLogCache.length ? h('button', { class: 'btn', onclick: async () => { if (!await confirmDelete({ title: '清空连接记录？', detail: `会删掉全部 ${netLogCache.length} 条掉线和重连记录，“24 小时掉线次数”也会从 0 开始算。`, ok: '清空' })) return; await window.wa.netLogClear(); loadNetLog(); } }, '清空记录') : null),
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
    const autoOn = st.autoRecycle !== false;
    const select = h('select', { 'aria-label': '单个账号刷新线', onchange: (e) => window.wa.setSetting('recycleMB', Number(e.target.value)) },
      [0, ...s.recycleChoices].map((n) => h('option', { value: n }, n ? `${n} MB` : '不限')));
    select.value = String(st.recycleMB ?? 1024);
    const capSelect = h('select', { 'aria-label': '总内存上限', onchange: (e) => window.wa.setSetting('capMB', Number(e.target.value)) },
      (s.capChoices || [0, 4096]).map((n) => h('option', { value: n }, n ? mb(n) : '不限')));
    capSelect.value = String(st.capMB ?? 4096);
    const over = autoOn && st.capMB > 0 && (s.totalMB || 0) > st.capMB;
    page.append(
      h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '内存'),
        h('p', { class: 'lead' }, '账号不会休眠，一直在线收消息。')),
      h('div', { class: 'box' },
        h('div', { class: 'hstack', style: { justifyContent: 'space-between' } }, h('b', null, '当前占用'),
          h('b', { style: { fontSize: '22px' } }, mb(s.totalMB || 0), autoOn && st.capMB > 0 ? h('span', { class: over ? 'bad-text' : 'hint', style: { fontSize: '13px', fontWeight: 'normal' } }, ` / 上限 ${mb(st.capMB)}`) : null)),
        s.accounts.map((a) => h('div', { class: 'memrow' },
          h('span', null, h('span', { class: 'sw', style: { background: a.color } }), a.name),
          h('span', { class: 'bar' }, h('span', { style: { width: `${((a.memMB || 0) / max) * 100}%`, background: a.color } })),
          h('b', { style: { textAlign: 'right' } }, `${a.memMB || 0} MB`),
          h('span', { class: 'hint' }, a.problem ? a.problemShort : a.mode === 'lite' ? '轻量模式' : a.id === s.activeId ? '正在看' : '后台'))),
        h('span', { class: 'hint' }, '大概数字，实际会略高一点。')),
      setRow('立即清理内存', '把内存涨得多的后台账号刷新一下。不会退出登录，不会漏消息。',
        h('button', { class: 'btn', disabled: memClean.busy || !s.accounts.length, onclick: async () => {
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
        } }, memClean.busy ? '清理中…' : '立即清理'),
        memClean.result ? h('span', { class: 'hint', role: 'status' }, memClean.result) : null),
      setRow('自动回收后台账号', '后台账号内存涨多了，就自动刷新一下。不退出登录，不漏消息；正在看的和有未读的不动。',
        sw(autoOn, '自动回收后台账号', (v) => window.wa.setSetting('autoRecycle', v)),
        autoOn ? h('div', { class: 'col', style: { gap: '2px' } },
          h('label', { class: 'inline' }, '单个后台账号超过', select, '时刷新它'),
          h('label', { class: 'inline' }, '所有账号加起来超过', capSelect, '时刷新占用最多的'),
          st.capMB > 0 && s.capAdvice ? h('span', { class: 'inline', role: 'status' },
            h('span', { class: 'bad-text' }, '账号多，总上限够不着，现在不起作用。'),
            h('button', { class: 'btn', style: { height: '28px', padding: '0 12px' }, onclick: () => window.wa.setSetting('capMB', 0) }, '改为不限')) : null) : null),
      setRow(h('span', null, '省内存模式 ', h('span', { class: 'badge-warn' }, '重启后生效')), '再省一些内存，但滚动没那么顺滑。',
        h('span', { class: 'hstack', style: { gap: '10px' } },
          s.restartNeeded ? h('button', { class: 'btn primary', style: { height: '32px', padding: '0 14px' }, onclick: () => window.wa.restart() }, '立即重启') : null,
          sw(st.lowMemoryMode, '省内存模式', (v) => window.wa.setSetting('lowMemoryMode', v)))),
      setRow('清理缓存文件',
        `释放硬盘空间。不会退出登录，不删聊天记录。${cacheInfo.mb === null ? '' : `当前缓存约 ${mb(cacheInfo.mb)}。`}`,
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
        h('p', { class: 'lead' }, '通知标题显示账号名，点通知直接打开那个号。不显示消息内容。')),
      h('div', null, s.accounts.length ? s.accounts.map((a) => h('div', { class: 'setrow', style: { alignItems: 'center' } },
        h('span', { class: 'avatar', style: { background: a.color } }, a.name.trim().charAt(0) || '?'),
        h('span', { class: 'meta' }, a.name),
        h('span', { class: 'hint' }, a.muted ? '不弹通知' : '弹通知'),
        sw(!a.muted, `${a.name}的通知`, (v) => window.wa.setMuted(a.id, !v)))) : h('p', { class: 'lead' }, '还没有账号。')),
      h('span', { class: 'hint' }, '关掉通知的号，未读数照样计入。'));
  } else if (settingsTab === 'general') {
    page.append(h('h1', null, '通用'),
      h('div', null,
        setRow('关闭窗口时缩到托盘', '关掉窗口后继续在后台收消息。',
          sw(st.closeToTray, '关闭窗口时缩到托盘', (v) => window.wa.setSetting('closeToTray', v))),
        s.canLoginItem ? setRow('开机自动启动', '开机后缩在托盘里，在后台收消息。',
          sw(st.openAtLogin, '开机自动启动', (v) => window.wa.setSetting('openAtLogin', v))) : null,
        setRow('侧栏只显示图标', '给聊天留更多空间。',
          sw(st.sidebarCollapsed, '侧栏只显示图标', (v) => window.wa.setSetting('sidebarCollapsed', v))),
        setRow('显示检查更新按钮', '在侧栏底部齿轮旁边，点一下立刻检查新版本。有新版会在后台下载，好了提醒你，不会自己重启。',
          sw(st.showUpdateButton, '显示检查更新按钮', (v) => window.wa.setSetting('showUpdateButton', v))),
        setRow('聊天锁', `这么久不动电脑，就遮住聊天，右滑解锁。消息照常收。随时按 ${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + L 立即锁定。`,
          h('select', { 'aria-label': '聊天锁等待时间', onchange: (e) => window.wa.setSetting('lockMinutes', Number(e.target.value)) },
            (s.lockChoices || [0, 5]).map((m) => h('option', { value: String(m), selected: st.lockMinutes === m }, m ? `${m} 分钟` : '关闭')))),
        setRow('快捷键', `${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + 1 到 9 切换到第几个账号；${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + L 立即锁定聊天。`, h('span'))));
  } else if (settingsTab === 'net') {
    netPage(page);
  } else if (settingsTab === 'translate') {
    translatePage(page);
  } else if (settingsTab === 'team') {
    page.append(teamPage(s.team, s.accounts));
  } else if (settingsTab === 'check') {
    const run = h('button', { class: 'btn primary', disabled: checkRunning || !s.accounts.length, onclick: async () => {
      checkRunning = true; render(true);
      checkResult = await window.wa.runCheck();
      checkRunning = false; render(true);
    } }, checkRunning ? '检查中…' : (checkResult ? '重新检查' : '开始检查'));
    page.append(
      h('div', { class: 'hstack', style: { justifyContent: 'space-between', alignItems: 'flex-end' } },
        h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '隔离自检'),
          h('p', { class: 'lead' }, '看看有没有号用了本机 IP、有没有两个号是同一个 IP。不用登录 WhatsApp。')),
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
          } }, `地区改成 ${c.fix.label}`)) : null,
          c.logs ? h('span', null, h('button', { class: 'btn', style: { height: '30px', padding: '0 14px', marginTop: '4px' }, onclick: () => window.wa.openLogs() }, '打开日志文件夹')) : null)))),
      h('span', { class: 'hint' }, `检查时间：${checkResult.time}`));
    }
  } else {
    const a = s.about;
    if (Date.now() - trDirAt > 10000) loadTrDir();
    page.append(
      h('div', { class: 'hstack', style: { gap: '18px' } },
        h('img', { src: '../../assets/icon.png', alt: '', width: '64', height: '64', style: { borderRadius: '16px', boxShadow: '0 4px 12px rgba(0,0,0,.25)' } }),
        h('div', { class: 'col', style: { gap: '2px' } }, h('h1', null, 'WAswitch'), h('span', { class: 'hint', style: { fontSize: '14px' } }, `版本 ${a.version}`))),
      h('div', { class: 'kv' },
        h('span', null, '浏览器版本'), h('span', null, `Chrome ${a.chrome}`),
        h('span', null, '数据位置'), h('span', { class: 'mono', style: { fontSize: '12px', wordBreak: 'break-all' } }, a.dataDir),
        h('span', null, '译文位置'), h('div', { class: 'col', style: { gap: '2px' } },
          h('div', { class: 'mono', style: { fontSize: '12px', wordBreak: 'break-all' } }, trDir ? trDir.dir : '正在读取…'),
          trDir ? h('div', { class: 'hint', style: { fontSize: '12px' } }, `共 ${fmtBytes(trDir.bytes)}，${trDir.files} 个对话`) : null),
        h('span', null, '源码'), h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.wa.openSource(); } }, 'github.com/Kr1xxxx/WAswitch')),
        ...(s.team && !s.team.joined ? [h('span', null, '团队'), h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); settingsTab = 'team'; render(true); } }, '加入团队…'))] : [])),
      updateBox(s.update),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => window.wa.openLogs() }, '打开日志文件夹'),
        h('button', { class: 'btn', onclick: () => window.wa.openTrDir() }, '打开译文文件夹')),
      h('span', { class: 'hint' }, '日志里记着出错原因和问题代码，没有聊天内容和号码。'));
  }
  return page;
}

// 关于页的「译文位置」：收到的消息的译文存在哪、占多大（每次打开关于页最多 10 秒读一次）
let trDir = null;
let trDirAt = 0;
async function loadTrDir() {
  trDirAt = Date.now();
  try { trDir = await window.wa.trDirInfo(); } catch { trDir = null; }
  if (s.page === 'settings' && settingsTab === 'about') render(true);
}
function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(n ? 1 : 0, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
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
    h('p', { class: 'hint', style: { margin: '0', fontSize: '12px' } }, last),
    list.map((a) => h('div', { class: 'setrow', style: { alignItems: 'center', padding: '6px 0' } },
      h('span', { class: `avatar${a.crm ? ' crm' : ''}`, style: { background: a.color } }, a.name.trim().charAt(0) || '?'),
      h('span', { class: 'meta' }, a.name),
      h('span', { class: 'hint', style: { fontSize: '12px' } }, a.crm
        ? `本机排队 ${a.crm.queued} 条${a.crm.skipped ? `，${a.crm.skipped} 条认不出对方号码（没有同步）` : ''}${a.crm.notime ? `，${a.crm.notime} 条打开对话前就有、读不出时间（没有同步）` : ''}`
        : '这台电脑不能加密保存，没有采集'))));
}

function teamPage(t, accounts = []) {
  const wrap = h('div', { class: 'col', style: { gap: '16px' } });
  if (!t) return wrap;
  const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '还没有');
  const fieldList = (title, items) => h('div', { class: 'col', style: { gap: '4px' } }, h('b', null, title), h('ul', { style: { margin: '0', paddingLeft: '20px' } }, items.map((x) => h('li', { class: 'hint', style: { fontSize: '13px' } }, x))));
  const result = teamForm.result ? h('div', { class: `note ${teamForm.result.startsWith('✓') ? 'ok' : 'bad'}`, role: 'status' }, teamForm.result) : null;
  wrap.append(h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '团队'),
    h('p', { class: 'lead' }, '登记后，管理员可以给你分配账号、查看每个号的状态。不登记不影响使用。')));

  if (t.joined && !t.revoked) {
    const ok = !t.offline && !t.lastError;
    wrap.append(...kids(
      h('div', { class: 'kv' },
        h('span', null, '后台地址'), h('span', { class: 'mono', style: { fontSize: '12px', wordBreak: 'break-all' } }, t.server),
        h('span', null, '团队账号'), h('span', null, `${t.teamCount} 个`),
        h('span', null, '上次同步'), h('span', null, when(t.lastOkAt)),
        h('span', null, '私人号'), h('span', null, t.allowPrivate ? '允许保留' : '管理员不允许，私人号已暂停并隐藏（数据没删）')),
      ok ? null : h('div', { class: 'note warn' }, `${t.lastError || '后台暂时连不上'}。账号照常收发，连上后自动补上。`),
      t.held ? h('div', { class: 'note warn' }, `后台要一次收回 ${t.held} 个号，数量太多，先暂停，等管理员确认。`) : null,
      h('div', { class: 'btns' },
        h('button', { class: 'btn', disabled: teamForm.busy, onclick: async () => {
          teamForm.busy = true; render(true);
          const r = await window.wa.teamSync();
          teamForm.busy = false;
          teamForm.result = r && r.ok ? '✓ 已同步' : (r && r.error) || '同步没成功';
          render(true);
        } }, teamForm.busy ? '同步中…' : '立即同步'),
        h('button', { class: 'btn', onclick: () => { teamForm.showUpload = !teamForm.showUpload; render(true); } }, teamForm.showUpload ? '收起上传内容' : '查看上传内容')),
      result,
      teamForm.showUpload ? h('pre', { class: 'mono note plain', style: { whiteSpace: 'pre-wrap', fontSize: '11px', maxHeight: '320px', overflow: 'auto' } }, t.lastUpload || '还没有上传过。') : null));
    if (t.privateAccounts.length && t.allowPrivate) {
      wrap.append(h('div', { class: 'col', style: { gap: '6px' } }, h('b', null, '没加入团队的号'),
        t.privateAccounts.map((a) => h('div', { class: 'setrow', style: { alignItems: 'center', padding: '8px 0' } },
          h('span', { class: 'avatar', style: { background: a.color } }, a.name.trim().charAt(0) || '?'),
          h('span', { class: 'meta' }, a.name),
          h('button', { class: 'btn', onclick: async () => {
            const r = await window.wa.teamJoin([a.id]);
            teamForm.result = r && r.ok ? `✓ 「${a.name}」已加入团队` : (r && r.error) || '加入没成功';
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
    h('label', { class: 'field' }, '登记码（管理员在后台生成，15 分钟内有效）', input('code', { class: 'mono', placeholder: 'XXXXX-XXXXX', 'aria-label': '登记码', maxlength: '11' })),
    h('label', { class: 'field' }, '这台电脑的名字（给管理员看）', input('deviceName', { placeholder: '例如：前台 1 号机', maxlength: '40', 'aria-label': '电脑名字' })),
    t.privateAccounts.length ? h('div', { class: 'field' }, '哪些号加入团队（没勾的留作私人号）',
      t.privateAccounts.map((a) => h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: teamForm.picked.has(a.id), onchange: (e) => { if (e.target.checked) teamForm.picked.add(a.id); else teamForm.picked.delete(a.id); } }),
        a.name))) : null,
    h('div', { class: 'box' }, fieldList('登记后会上传', t.uploadFields), fieldList('不会上传', t.neverUpload),
      h('label', { class: 'check-row' }, consent, '我看过上面的清单，同意上传这些内容')),
    h('div', { class: 'btns' }, h('button', { class: 'btn primary', disabled: !teamForm.consent || teamForm.busy, onclick: async () => {
      teamForm.busy = true; teamForm.result = ''; render(true);
      const r = await window.wa.teamEnroll({ server: teamForm.server, code: teamForm.code, deviceName: teamForm.deviceName, localIds: [...teamForm.picked], consent: teamForm.consent });
      teamForm.busy = false;
      teamForm.result = r && r.ok ? '✓ 已登记到团队' : (r && r.error) || '登记没成功';
      if (r && r.ok) { teamForm.code = ''; teamForm.picked = null; }
      render(true);
    } }, teamForm.busy ? '登记中…' : '登记')),
    result));
  return wrap;
}

// 关于页里的“软件更新”：状态图标、标题、进度条、上次检查的时间和结果。连续失败 3 次标黄
function updateBox(u) {
  if (!u) return null;
  const when = u.lastCheckAt ? new Date(u.lastCheckAt).toLocaleString('zh-CN', { hour12: false }) : '还没检查过';
  const [title, line, tone] = {
    dev: ['开发版', '开发版不检查更新。', 'idle'],
    off: ['不支持自动更新', '这种安装方式不能自动更新，请到下载页下载新版。', 'idle'],
    idle: ['自动更新已开启', '每 6 小时自动检查一次。', 'idle'],
    checking: ['正在检查更新…', '', 'busy'],
    none: ['已是最新版本', '有新版会自动下载，好了提醒你。', 'ok'],
    downloading: [`正在下载 ${u.version}`, u.userAsked ? (u.manual ? '下载完会自动打开安装包。' : '下载完，等你 30 秒没打字就自动重启并安装，账号和聊天都在。') : '不影响收发消息。', 'busy'],
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
      : h('button', { class: 'btn', disabled: busy, onclick: () => window.wa.updateCheck() }, busy ? '检查中…' : '检查并更新');
  return h('div', { class: `update-box ${t}`, role: 'status' },
    h('div', { class: 'upd-main' },
      h('span', { class: 'upd-mark' }, mark),
      h('div', { class: 'upd-text' }, h('span', { class: 'upd-label' }, '软件更新'), h('b', null, title), line ? h('span', null, line) : null),
      action),
    u.status === 'downloading' ? h('div', { class: 'upd-progress' },
      h('div', { class: 'progress' }, h('span', { style: { width: `${u.percent}%` } })),
      h('span', { class: 'pct' }, `${u.percent}%`)) : null,
    u.warn ? h('div', { class: 'note warn' }, `连续 ${u.failures} 次没检查成功，可能是网络问题。可以去下载页手动下载。`) : null,
    h('span', { class: 'hint upd-foot' }, `上次检查：${when}${u.lastResult ? ` · ${u.lastResult}` : ''}`));
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

// 锁着时只盖住账号页面（网页版和轻量模式的聊天），设置、编辑、总览这些页面照常能打开使用。
// 锁定状态一直保留：从设置页切回任何账号，看到的还是锁屏卡片，要右滑解锁才能看聊天
function renderLock() {
  const on = !!s.locked && s.page === 'account';
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
  document.body.style.background = s.page === 'account' && acc ? tint(acc.color) : s.page === 'editor' ? tint(liveColor || s.editorColor) : '#E6E9ED';
  renderSide();
  renderAi();
  renderTop();
  renderLock();
  renderPanel();
  // 刚进 设置 › 翻译：重新读一次配置（面板或悬浮窗里可能拨过某个号的自动翻译）
  const onTr = s.page === 'settings' && settingsTab === 'translate';
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
  // 换了页面（设置里换了分页、切到别的号的出错页）：卡片内容淡入。WhatsApp 页面本身不动
  const fxKey = s.page === 'settings' ? `${key}|${settingsTab}` : s.page === 'account' ? `${key}|${s.activeId}|${acc && acc.problem ? 'p' : acc && acc.mode === 'lite' ? 'l' : ''}` : key;
  if (fxChanged('content', fxKey) && $content.firstElementChild) fxPlay($content.firstElementChild);
  liteForget(s.accounts.map((a) => a.id));
  shown = key;
}

window.wa.onState((state) => { s = state; render(); });
