// 软件界面：左侧账号栏、顶栏、右侧卡片里的页面（代理断开提示、编辑账号、设置、首次打开）。
// WhatsApp 页面本身是主进程叠在卡片上面的独立视图，这里不碰它。
// 所有来自用户或账号的数据一律用 textContent 显示，不拼 HTML。

const COLORS = ['#16A34A', '#7C3AED', '#EA580C', '#2563EB', '#DB2777', '#475569'];
const COLOR_NAMES = ['绿色', '紫色', '橙色', '蓝色', '粉色', '灰色'];
const PRESETS = [['直连', ''], ['Clash 7891', 'socks5://127.0.0.1:7891'], ['Clash 7892', 'socks5://127.0.0.1:7892'], ['Clash 7893', 'socks5://127.0.0.1:7893']];

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
const $content = document.getElementById('content');
let s = null; // 主进程推过来的状态
let shown = ''; // 当前卡片里画的是哪个页面，用来决定是否重画
let settingsTab = 'memory';
let checkResult = null;
let checkRunning = false;

const active = () => (s.accounts || []).find((a) => a.id === s.activeId);
const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);

function tint(color) {
  // 背景 = 账号颜色 22% + 浅灰
  return color ? `color-mix(in srgb, ${color} 22%, #EEF0F3)` : '#E6E9ED';
}

// ---------- 侧栏 ----------

function accountRow(acc) {
  const on = acc.id === s.activeId && s.page === 'account';
  const avatar = h('span', { class: 'avatar', style: { background: acc.color } }, acc.name.trim().charAt(0) || '?');
  if (acc.problem || acc.needsQr) avatar.append(h('span', { class: 'dot bad' }, '!'));
  else if (s.collapsed && acc.unread) avatar.append(h('span', { class: `dot${acc.muted ? ' quiet' : ''}` }, acc.unread > 9 ? '9+' : acc.unread));
  const tip = [acc.name, acc.unread ? `${acc.unread} 个未读对话` : '', acc.problem, acc.needsQr ? '需要扫码登录' : ''].filter(Boolean).join('\n');
  return h('button', {
    class: `row${on ? ' on' : ''}`, title: tip, 'aria-current': on ? 'true' : null,
    onclick: () => window.wa.switchTo(acc.id),
    oncontextmenu: (e) => { e.preventDefault(); window.wa.context(acc.id); },
  },
  avatar,
  h('span', { class: 'meta' },
    h('span', { class: 'name' }, acc.name),
    h('span', { class: `sub${acc.problem || acc.needsQr ? ' bad' : ''}` }, acc.problem ? acc.problemShort : acc.needsQr ? '需要扫码登录' : acc.proxyLabel)),
  acc.muted ? h('span', { class: 'mute', title: '不弹通知', style: { color: '#4A505A' } }, icon('mute', 13)) : null,
  acc.unread ? h('span', { class: `pill${acc.muted ? ' quiet' : ''}` }, acc.unread) : null);
}

function renderSide() {
  const mac = s.platform === 'darwin';
  $side.replaceChildren();
  $side.append(h('div', { class: 'drag' }));
  if (s.page === 'settings') {
    $side.append(
      h('button', { class: 'back', onclick: () => window.wa.showPage('account') }, icon('back', 14), '返回账号'),
      h('div', { class: 'label' }, '设置'),
      h('div', { class: 'list' }, [['memory', '内存'], ['notify', '通知'], ['general', '通用'], ['check', '隔离自检'], ['about', '关于']].map(([id, label]) =>
        h('button', { class: `tab${settingsTab === id ? ' on' : ''}`, onclick: () => { settingsTab = id; render(true); } }, label))));
    return;
  }
  const label = s.collapsed ? '展开侧栏' : '收起侧栏';
  $side.append(...kids(
    h('div', { class: 'head' },
      s.collapsed ? null : h('span', { class: 'brand' }, 'WAswitch'),
      h('button', { class: 'icon-btn', title: label, 'aria-label': label, onclick: () => window.wa.toggleCollapse() }, icon('panel'))),
    s.collapsed ? null : h('div', { class: 'label' }, `账号 · ${s.accounts.length}`),
    h('div', { class: 'list' },
      s.accounts.map(accountRow),
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
  $side.append(h('div', { class: 'foot' },
    h('button', { class: 'icon-btn', title: '设置', 'aria-label': '设置', onclick: () => window.wa.showPage('settings') }, icon('gear', 17))));
  document.body.classList.toggle('mac', mac);
}

// ---------- 顶栏 ----------

function renderTop() {
  const acc = active();
  $top.hidden = !(s.page === 'account' && acc);
  if ($top.hidden) return;
  $top.replaceChildren(...kids(
    icon('lock', 14), h('span', null, 'web.whatsapp.com'), h('span', { class: 'who' }, `· ${acc.name}`),
    h('span', { class: 'grow' }),
    h('span', { class: `chip${acc.problem ? ' bad' : ''}`, title: '网络线路' }, icon('globe', 12), acc.problem ? acc.problemShort : acc.proxyLabel),
    h('span', { class: 'chip', title: '时区和语言' }, icon('clock', 12), acc.regionLabel),
    acc.memMB ? h('span', { class: 'chip', title: '内存占用（近似值）' }, `${acc.memMB} MB`) : null,
    h('button', { class: 'icon-btn', title: '刷新', 'aria-label': '刷新', onclick: () => window.wa.reload(acc.id) }, icon('reload', 15)),
    h('button', { class: 'icon-btn', title: '账号菜单（右键账号也可以打开）', 'aria-label': '账号菜单', onclick: () => window.wa.context(acc.id) }, icon('more', 15))));
}

// ---------- 卡片里的页面 ----------

function problemPage(acc) {
  return h('div', { class: 'center' }, h('div', { class: 'panel' },
    h('div', { class: 'warnicon' }, icon('warn', 26)),
    h('h2', null, acc.problemTitle || '代理连不上，这个账号已暂停联网'),
    h('p', null, acc.problem),
    acc.retrying ? h('p', { class: 'hint' }, '正在自动重试，网络或 Clash 恢复后会自动连上。') : null,
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: () => window.wa.edit(acc.id) }, '修改代理'),
      h('button', { class: 'btn primary', onclick: () => window.wa.retry(acc.id) }, '重新连接'))));
}

function welcomePage() {
  const step = (n, title, text) => h('li', null, h('span', { class: 'n' }, n), h('span', { class: 'meta' }, h('b', null, title), h('small', null, text)));
  return h('div', { class: 'center', style: { background: '#fff' } }, h('div', { class: 'col', style: { maxWidth: '640px', gap: '26px' } },
    h('div', { class: 'col', style: { gap: '10px' } },
      h('h1', { style: { fontSize: '30px' } }, '一个窗口，同时登录多个 WhatsApp'),
      h('p', { class: 'lead' }, '每个账号独立隔离：登录和缓存分开存，可以走各自的代理线路，时区和语言跟着线路走。')),
    h('ol', { class: 'steps' },
      step(1, '起个名字，选个颜色', '比如“客服号”“店铺号”。颜色会铺满窗口背景，一眼认出在用哪个号。'),
      step(2, '选网络线路（可以跳过）', '在 Clash 里给每个号开一个本地端口，填进来点“测试”。设置方法见软件目录里的 docs/clash.md。'),
      step(3, '手机扫码登录', 'WhatsApp › 设置 › 已关联的设备 › 关联新设备。')),
    h('div', null, h('button', { class: 'btn primary', style: { height: '46px', padding: '0 26px' }, onclick: () => window.wa.add() }, '添加第一个账号'))));
}

// 编辑账号（新建和修改共用）
function editorPage(id) {
  const root = h('div', { class: 'page' }, h('div', { class: 'col' }, h('p', { class: 'lead' }, '正在加载…')));
  window.wa.editorLoad(id).then((d) => {
    let color = d.color;
    let tested = null;
    const name = h('input', { type: 'text', value: d.name, 'aria-label': '名称', maxlength: '40' });
    const proxyInput = h('input', { type: 'text', class: 'mono', value: d.proxy, placeholder: '留空表示直连，例如 socks5://127.0.0.1:7891', 'aria-label': '代理地址' });
    const password = h('input', { type: 'password', autocomplete: 'off', 'aria-label': '代理密码', placeholder: d.hasPassword ? '已保存，留空表示不修改' : '' });
    const passwordRow = h('label', { class: 'field' }, '代理密码', password, h('span', { class: 'hint' }, '用系统钥匙串加密后保存在本机。'));
    const result = h('div', { role: 'status' });
    const region = h('select', { 'aria-label': '地区' }, d.regions.map((r) => h('option', { value: r.key }, r.label)));
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
      onclick: () => { color = c; drawSwatches(); },
    })));
    const drawPresets = () => presets.replaceChildren(...PRESETS.map(([label, v]) => h('button', {
      class: `preset${proxyInput.value.trim() === v ? ' on' : ''}`, type: 'button',
      onclick: () => { proxyInput.value = v; onProxyChange(); },
    }, label)));
    const drawTags = () => {
      const opt = d.regions.find((r) => r.key === region.value);
      const auto = region.value === 'auto';
      tags.replaceChildren(
        h('span', { class: 'tag' }, auto ? '时区和语言：跟本机一致' : `时区和语言：${opt ? opt.label : ''}`),
        h('span', { class: 'tag' }, 'Chrome · 跟随本机系统'),
        h('span', { class: 'tag' }, proxyInput.value.trim() ? 'WebRTC 只走代理' : '直连：用本机真实 IP'));
    };
    const onProxyChange = () => {
      passwordRow.hidden = !/^https?:\/\/[^/@]+@/i.test(proxyInput.value.trim());
      result.replaceChildren();
      tested = null;
      drawPresets();
      drawTags();
    };
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
      if (res.region) { region.value = res.region; text += ' 已按出口所在地选好时区和语言。'; } else text += ' 没有匹配的地区预设，请手动选最接近的。';
      if (res.sameAs) text += `\n注意：和「${res.sameAs}」的出口 IP 相同，两个号会被认为在同一个地方。`;
      result.replaceChildren(h('div', { class: `note ${res.sameAs ? 'bad' : 'ok'}`, style: { whiteSpace: 'pre-line' } }, text));
      drawTags();
    };

    saveBtn.onclick = async () => {
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = '请填写名称'; name.focus(); return; }
      saveBtn.disabled = true;
      const res = await window.wa.editorSave({ id: d.id, name: name.value.trim(), color, proxy: proxyInput.value, password: password.value, region: region.value });
      saveBtn.disabled = false;
      if (res && res.error) error.textContent = res.error;
    };

    drawSwatches();
    onProxyChange();
    root.replaceChildren(
      h('div', { class: 'col' },
        h('div', { class: 'col', style: { gap: '6px' } },
          h('h1', null, d.isNew ? '添加账号' : '编辑账号'),
          h('p', { class: 'lead' }, '每个账号的登录、缓存、网络线路和时区语言都互相独立。')),
        h('div', { class: 'hstack', style: { alignItems: 'flex-end', gap: '14px' } },
          h('label', { class: 'field', style: { flex: '1' } }, '名称', name),
          h('div', { class: 'field' }, '颜色', swatches)),
        h('div', { class: 'field' }, '网络线路（代理）', presets, h('div', { class: 'hstack' }, proxyInput, testBtn), result,
          h('span', { class: 'hint' }, '测试会通过这个代理访问 ipinfo.io 查询出口 IP。代理连不上时这个账号会暂停联网，不会改用直连。socks5 不支持密码，带密码的代理请用 http://。Clash 设置方法见 docs/clash.md。')),
        passwordRow,
        h('label', { class: 'field' }, '时区和语言', region, tags, h('span', { class: 'hint' }, '应该和代理出口所在地一致，点“测试”会自动选好。')),
        error,
        h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: () => window.wa.showPage('account') }, '取消'), saveBtn)),
      h('div', { class: 'side-panel' },
        d.isNew ? [h('div', { class: 'qr' }, '保存后右边会打开 WhatsApp 登录页，显示二维码'),
          h('ol', null, h('li', null, '手机打开 WhatsApp'), h('li', null, '设置 › 已关联的设备'), h('li', null, '关联新设备，扫码'))]
          : h('span', null, '修改代理或时区后，这个账号的页面会重新加载，不需要重新扫码。')));
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

function settingsPage() {
  const st = s.settings;
  const page = h('div', { class: 'page narrow' });
  if (settingsTab === 'memory') {
    const max = Math.max(800, ...s.accounts.map((a) => a.memMB || 0));
    const select = h('select', { 'aria-label': '回收阈值', onchange: (e) => window.wa.setSetting('recycleMB', Number(e.target.value)) },
      s.recycleChoices.map((n) => h('option', { value: n }, `${n} MB`)));
    select.value = String(st.recycleMB || 800);
    page.append(
      h('div', { class: 'col', style: { gap: '6px' } }, h('h1', null, '内存'),
        h('p', { class: 'lead' }, '不会让账号休眠，所有账号一直在线收消息。后台账号自动降速，省下来的主要靠下面两项。')),
      h('div', { class: 'box' },
        h('div', { class: 'hstack', style: { justifyContent: 'space-between' } }, h('b', null, '当前占用'), h('b', { style: { fontSize: '22px' } }, mb(s.totalMB || 0))),
        s.accounts.map((a) => h('div', { class: 'memrow' },
          h('span', null, h('span', { class: 'sw', style: { background: a.color } }), a.name),
          h('span', { class: 'bar' }, h('span', { style: { width: `${((a.memMB || 0) / max) * 100}%`, background: a.color } })),
          h('b', { style: { textAlign: 'right' } }, `${a.memMB || 0} MB`),
          h('span', { class: 'hint' }, a.problem ? a.problemShort : a.id === s.activeId ? '正在看' : '后台 · 已降速'))),
        h('span', { class: 'hint' }, '近似值：只统计每个账号的主页面进程，实际会略高一点。')),
      setRow('自动回收', '后台账号超过设定值、没有未读、在后台 5 分钟以上时，悄悄刷新一次。同一个号至少隔 30 分钟。',
        sw(st.recycleMB > 0, '自动回收', (v) => window.wa.setSetting('recycleMB', v ? 800 : 0)),
        st.recycleMB > 0 ? h('label', { class: 'inline' }, '超过', select, '时回收') : null),
      setRow(h('span', null, '省内存模式 ', h('span', { class: 'badge-warn' }, '重启后生效')), '关闭显卡加速，整体再省一些内存。代价是滚动和动画没那么顺滑。',
        sw(st.lowMemoryMode, '省内存模式', (v) => window.wa.setSetting('lowMemoryMode', v))));
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
        s.canLoginItem ? setRow('开机自动启动', '开机后自动打开 WAswitch 并缩在托盘里。',
          sw(st.openAtLogin, '开机自动启动', (v) => window.wa.setSetting('openAtLogin', v))) : null,
        setRow('侧栏只显示图标', '给聊天留更多空间。随时可以用左上角按钮切换。',
          sw(st.sidebarCollapsed, '侧栏只显示图标', (v) => window.wa.setSetting('sidebarCollapsed', v))),
        setRow('快捷键', `${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'} + 1 到 9 切换到第几个账号。`, h('span'))));
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
        h('span', { class: 'meta' }, h('span', null, c.title), c.detail ? h('span', { class: 'hint' }, c.detail) : null)))),
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
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => window.wa.openLogs() }, '打开日志文件夹')),
      h('span', { class: 'hint' }, '遇到问题时把日志文件夹里最近的文件发过来。日志只记录软件运行情况，不记录聊天内容和号码。'));
  }
  return page;
}

// ---------- 总渲染 ----------

function render(forceContent = false) {
  document.body.style.setProperty('--side', s.collapsed && s.page !== 'settings' ? '64px' : '200px');
  document.body.classList.toggle('collapsed', s.collapsed && s.page !== 'settings');
  const acc = active();
  document.body.style.background = s.page === 'account' && acc ? tint(acc.color) : s.page === 'editor' ? tint(s.editorColor) : '#E6E9ED';
  renderSide();
  renderTop();

  // 卡片内容：账号页每次都画（很轻）；编辑页只在打开时画一次，避免打字时被重置
  const key = s.page === 'editor' ? `editor:${s.editorId || 'new'}:${s.editorNonce}` : s.page;
  if (s.page === 'editor') {
    if (forceContent || key !== shown) $content.replaceChildren(editorPage(s.editorId));
  } else if (s.page === 'settings') {
    // 设置页里的下拉框打开时不重画，免得被关掉
    if (forceContent || key !== shown || !$content.contains(document.activeElement) || document.activeElement.tagName !== 'SELECT') $content.replaceChildren(settingsPage());
  } else if (s.page === 'welcome') {
    if (key !== shown) $content.replaceChildren(welcomePage());
  } else {
    $content.replaceChildren(acc && acc.problem ? problemPage(acc) : '');
  }
  shown = key;
}

window.wa.onState((state) => { s = state; render(); });
