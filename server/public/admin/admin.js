// WAswitch 团队后台页面。所有员工写的文字都用 textContent 显示，不拼 HTML。
'use strict';

const STATE_TEXT = {
  ready: ['正常', 'good'], loading: ['加载中', ''], needs_qr: ['需要扫码', 'bad'], proxy_down: ['代理不通', 'bad'],
  needs_proxy: ['等员工填代理', 'warn'], error: ['出错', 'bad'], banned: ['可能被封', 'bad'], stopped: ['已停止', ''],
};
const EVENT_TEXT = { dropped: '掉线', recovered: '恢复', exit_changed: '出口 IP 变了', proxy_down: '代理断开', proxy_up: '代理恢复', banned: '可能被封' };
const ROLE_TEXT = { owner: '老板', supervisor: '主管', agent: '坐席' };
const COLORS = ['#25d366', '#34b7f1', '#ff9f43', '#ee5253', '#a55eea', '#10ac84', '#f368e0', '#576574'];

let me = null;
let tab = 'overview';
let timer = null;

// ---------- 小工具 ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const btn = (text, onclick, cls = '') => el('button', { class: `btn ${cls}`, type: 'button', onclick }, text);
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 4000);
}
function ago(ms, serverNow) {
  if (!ms) return '从未';
  const s = Math.max(0, Math.round((serverNow - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
const time = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

async function api(method, path, body) {
  const res = await fetch(`/api/admin/${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-waswitch-admin': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON（比如 Access 登录页） */ }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}
async function act(fn, okText) {
  try { await fn(); if (okText) toast(okText); await render(); } catch (e) { toast(e.message); }
}

// ---------- 页面 ----------
const TABS = [['overview', '总览'], ['accounts', '账号与坐席'], ['people', '人员与电脑'], ['audit', '操作记录'], ['settings', '设置']];

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.replaceChildren(...TABS.filter(([id]) => id !== 'settings' || me.user.role === 'owner')
    .map(([id, label]) => el('button', { class: tab === id ? 'on' : '', type: 'button', onclick: () => { tab = id; render(); } }, label)));
  document.getElementById('me').textContent = `${me.user.name}（${ROLE_TEXT[me.user.role]}）`;
}

function statusCell(a, now) {
  if (!a.device_id) return el('span', { class: 'muted' }, '未分配');
  if (a.revoked_at) return el('span', { class: 'bad' }, el('span', { class: 'dot bad' }), '电脑已停用');
  const [text, cls] = STATE_TEXT[a.state] || ['还没上报', ''];
  const parts = [el('span', { class: cls }, el('span', { class: `dot ${cls}` }), text)];
  if (!a.device_online) parts.push(el('div', { class: 'muted' }, `电脑离线，最后已知 ${ago(a.last_seen_at, now)}`));
  return el('span', {}, parts);
}

function exitCell(a) {
  if (!a.exit_ip) return el('span', { class: 'muted' }, a.proxy_ok === null || a.proxy_ok === undefined ? '—' : '');
  const mismatch = a.expected_country && a.exit_country && a.expected_country !== a.exit_country;
  return el('span', { class: mismatch || a.exit_changed ? 'warn' : '' }, `${a.exit_ip} ${a.exit_country || ''}`,
    mismatch ? el('div', {}, `应为 ${a.expected_country}`) : null, a.exit_changed ? el('div', {}, 'IP 变了') : null);
}

function proxyCell(a) {
  if (a.proxy_ok === 1) return el('span', { class: 'good' }, `通${a.proxy_ms ? ` · ${a.proxy_ms} ms` : ''}`);
  if (a.proxy_ok === 0) return el('span', { class: 'bad' }, '不通');
  return el('span', { class: 'muted' }, '直连或未测');
}

async function overviewPage() {
  const data = await api('GET', 'overview');
  const list = data.accounts;
  const now = data.server_time;
  const assigned = list.filter((a) => a.device_id);
  const ok = assigned.filter((a) => a.state === 'ready' && a.device_online && a.proxy_ok !== 0);
  const unread = assigned.reduce((n, a) => n + (a.unread || 0), 0);
  return [
    el('div', { class: 'cards' },
      el('div', { class: 'card' }, el('b', {}, assigned.length), '在用的号'),
      el('div', { class: 'card' }, el('b', { class: 'good' }, ok.length), '正常'),
      el('div', { class: 'card' }, el('b', { class: assigned.length - ok.length ? 'bad' : '' }, assigned.length - ok.length), '需要处理'),
      el('div', { class: 'card' }, el('b', {}, unread), '未读合计')),
    el('div', { class: 'wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['账号', '员工 / 电脑', '状态', '未读', '代理', '出口', '上报'].map((h) => el('th', {}, h)))),
      el('tbody', {}, assigned.map((a) => el('tr', {},
        el('td', {}, el('span', { class: 'swatch', style: `background:${a.color || '#999'}` }), a.label, a.number_label ? el('div', { class: 'muted' }, a.number_label) : null),
        el('td', {}, a.user_name || '', el('div', { class: 'muted' }, a.device_name || '')),
        el('td', {}, statusCell(a, now)),
        el('td', { class: a.unread ? 'warn' : 'muted' }, a.unread || 0),
        el('td', {}, proxyCell(a)),
        el('td', {}, exitCell(a)),
        el('td', { class: 'muted' }, a.reported_at ? ago(a.reported_at, now) : '—')))))),
    el('p', { class: 'muted' }, '每 30 秒自动刷新。WAswitch 每 2 分钟上报一次，电脑 6 分钟没上报算离线。'),
  ];
}

async function accountsPage() {
  const [data, people] = await Promise.all([api('GET', 'overview'), api('GET', 'users')]);
  const users = new Map(people.users.map((u) => [u.id, u]));
  const devices = people.devices.filter((d) => !d.revoked_at && users.get(d.user_id) && !users.get(d.user_id).disabled_at);
  const groups = new Map(me.groups.map((g) => [g.id, g.name]));
  const rows = data.accounts.map((a) => {
    const pick = el('select', {}, el('option', { value: '' }, '分配给…'),
      devices.map((d) => el('option', { value: d.id, selected: d.id === a.device_id }, `${users.get(d.user_id).name} · ${d.name}`)));
    pick.addEventListener('change', () => {
      if (!pick.value || pick.value === a.device_id) return;
      const tip = a.device_id ? '原来那台电脑会停止并隐藏这个号（数据保留）。新电脑要填好代理、用手机重新扫码。确定吗？' : '新电脑要填好代理、用手机扫码。确定吗？';
      if (!confirm(tip)) { pick.value = a.device_id || ''; return; }
      act(() => api('POST', `accounts/${a.id}/assign`, { device_id: pick.value }), '已分配');
    });
    return el('tr', {},
      el('td', {}, el('span', { class: 'swatch', style: `background:${a.color || '#999'}` }), a.label, a.number_label ? el('div', { class: 'muted' }, a.number_label) : null),
      el('td', {}, a.mode === 'lite' ? '轻量' : '网页'),
      el('td', {}, a.group_id ? groups.get(a.group_id) || '' : el('span', { class: 'muted' }, '未分组')),
      el('td', {}, a.user_name ? `${a.user_name} · ${a.device_name}` : el('span', { class: 'muted' }, '未分配')),
      el('td', {}, a.expected_country || el('span', { class: 'muted' }, '不检查')),
      el('td', {}, pick,
        btn('编辑', () => editAccount(a)),
        a.device_id ? btn('收回', () => confirm('收回后，那台电脑会停止并隐藏这个号（数据保留，分回去还能接着用）。确定吗？') && act(() => api('POST', `accounts/${a.id}/unassign`), '已收回')) : null,
        btn('记录', () => showEvents(a)),
        !a.device_id && me.user.role === 'owner' ? btn('删除记录', () => confirm(`删除「${a.label}」的后台记录？`) && act(() => api('DELETE', `accounts/${a.id}`), '已删除'), 'danger') : null));
  });
  return [
    el('p', { class: 'muted' }, '账号由员工在 WAswitch 里"加入团队"时自动出现在这里。分给别人后，新电脑需要自己填代理并扫码；代理和登录数据不会经过后台。'),
    el('div', { class: 'wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['账号', '模式', '组', '分给', '应在国家', '操作'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows))),
    el('div', { id: 'detail' }),
  ];
}

function editAccount(a) {
  const f = {
    label: el('input', { value: a.label, maxlength: 40 }),
    number_label: el('input', { value: a.number_label || '', maxlength: 40, placeholder: '号码备注（手填）' }),
    color: el('select', {}, COLORS.map((c) => el('option', { value: c, selected: c === a.color }, c))),
    expected_country: el('input', { value: a.expected_country || '', maxlength: 2, placeholder: '如 US', size: 4 }),
    note: el('input', { value: a.note || '', maxlength: 500, placeholder: '备注（会显示给员工）', size: 30 }),
  };
  const group = me.user.role === 'owner' ? el('select', {}, el('option', { value: '' }, '未分组'), me.groups.map((g) => el('option', { value: g.id, selected: g.id === a.group_id }, g.name))) : null;
  const form = el('form', { class: 'row', onsubmit: (e) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(f).map(([k, n]) => [k, n.value.trim()]));
    body.expected_country = body.expected_country.toUpperCase();
    if (group) body.group_id = group.value;
    act(() => api('PATCH', `accounts/${a.id}`, body), '已保存');
  } }, el('b', {}, `编辑「${a.label}」`), Object.values(f), group, el('button', { class: 'btn primary', type: 'submit' }, '保存'));
  document.getElementById('detail').replaceChildren(form);
}

async function showEvents(a) {
  try {
    const data = await api('GET', `accounts/${a.id}/events`);
    document.getElementById('detail').replaceChildren(el('h2', {}, `「${a.label}」最近的状态变化`),
      data.events.length ? el('table', {}, el('tbody', {}, data.events.map((e) => el('tr', {}, el('td', {}, time(e.at)), el('td', {}, EVENT_TEXT[e.kind] || e.kind), el('td', { class: 'muted' }, e.detail)))))
        : el('p', { class: 'muted' }, '30 天内没有变化。'));
  } catch (e) { toast(e.message); }
}

async function peoplePage() {
  const data = await api('GET', 'users');
  const now = data.server_time;
  const owner = me.user.role === 'owner';
  const groups = new Map(me.groups.map((g) => [g.id, g.name]));
  const name = el('input', { placeholder: '名字', maxlength: 40, required: true });
  const email = el('input', { placeholder: '邮箱（主管和老板必填，用来登录后台）', maxlength: 120, size: 32 });
  const role = owner ? el('select', {}, ['agent', 'supervisor', 'owner'].map((r) => el('option', { value: r }, ROLE_TEXT[r]))) : null;
  const group = owner ? el('select', {}, el('option', { value: '' }, '不分组'), me.groups.map((g) => el('option', { value: g.id }, g.name))) : null;
  const add = el('form', { class: 'row', onsubmit: (e) => {
    e.preventDefault();
    act(() => api('POST', 'users', { name: name.value, email: email.value, role: role ? role.value : 'agent', group_id: group ? group.value : undefined }), '已添加');
  } }, name, email, role, group, el('button', { class: 'btn primary', type: 'submit' }, '添加'));

  const codeBox = el('div');
  const rows = data.users.map((u) => {
    const devs = data.devices.filter((d) => d.user_id === u.id);
    return el('tr', {},
      el('td', {}, u.name, u.disabled_at ? el('span', { class: 'bad' }, '（已停用）') : null, u.email ? el('div', { class: 'muted' }, u.email) : null),
      el('td', {}, ROLE_TEXT[u.role], u.group_id ? el('div', { class: 'muted' }, groups.get(u.group_id) || '') : null),
      el('td', {}, devs.length ? devs.map((d) => el('div', {},
        el('span', { class: `dot ${d.revoked_at ? 'bad' : now - d.last_seen_at < 6 * 60 * 1000 ? 'good' : ''}` }),
        d.name, el('span', { class: 'muted' }, ` · ${d.revoked_at ? '已停用' : ago(d.last_seen_at, now)} · v${d.app_version || '?'} ${d.platform}`),
        d.revoked_at ? btn('恢复', () => act(() => api('POST', `devices/${d.id}/restore`), '已恢复'))
          : btn('停用', () => confirm(`停用「${d.name}」？这台电脑下次连上后台时，团队号会停止并隐藏（数据保留，可以恢复）。`) && act(() => api('POST', `devices/${d.id}/revoke`), '已停用'), 'danger'),
        btn('改名', () => { const n = prompt('电脑名称', d.name); if (n) act(() => api('PATCH', `devices/${d.id}`, { name: n }), '已改名'); })))
        : el('span', { class: 'muted' }, '还没登记电脑')),
      el('td', {},
        u.disabled_at ? null : btn('生成登记码', () => act(async () => {
          const r = await api('POST', `users/${u.id}/enroll-code`);
          codeBox.replaceChildren(el('div', { class: 'card' }, `给 ${u.name} 的登记码（15 分钟内有效，只能用一次）：`, el('div', { class: 'code' }, r.code),
            el('div', { class: 'muted' }, '在 WAswitch 设置 → 团队 里填入后台地址和这个码。')));
        })),
        u.id === me.user.id ? null : btn(u.disabled_at ? '启用' : '停用', () => act(() => api('PATCH', `users/${u.id}`, { disabled: !u.disabled_at }), '已保存'), u.disabled_at ? '' : 'danger')));
  });
  return [el('h2', {}, '添加人员'), add, codeBox, el('h2', {}, '人员和电脑'),
    el('div', { class: 'wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['人', '角色', '电脑', '操作'].map((h) => el('th', {}, h)))), el('tbody', {}, rows)))];
}

async function auditPage() {
  const data = await api('GET', 'audit');
  return [el('div', { class: 'wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ['时间', '谁', '做了什么', '对象', '内容'].map((h) => el('th', {}, h)))),
    el('tbody', {}, data.entries.map((e) => el('tr', {}, el('td', {}, time(e.at)), el('td', {}, e.actor_name || e.actor_id), el('td', {}, e.action), el('td', { class: 'muted' }, e.target), el('td', { class: 'muted' }, e.detail)))))),
  me.user.role === 'owner' ? null : el('p', { class: 'muted' }, '主管只能看到自己的操作。')];
}

function settingsPage() {
  const allow = el('input', { type: 'checkbox', checked: me.settings.allow_private });
  allow.addEventListener('change', () => act(() => api('PUT', 'settings', { allow_private: allow.checked }), '已保存'));
  const gname = el('input', { placeholder: '组名', maxlength: 40, required: true });
  return [
    el('h2', {}, '私人号'),
    el('label', {}, allow, ' 允许员工在团队电脑上保留没加入团队的私人号（关掉后，私人号会停止并隐藏，数据不删）'),
    el('h2', {}, '小组'),
    el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); act(() => api('POST', 'groups', { name: gname.value }), '已添加'); } }, gname, el('button', { class: 'btn primary', type: 'submit' }, '添加小组')),
    el('ul', {}, me.groups.map((g) => el('li', {}, g.name))),
  ];
}

const PAGES = { overview: overviewPage, accounts: accountsPage, people: peoplePage, audit: auditPage, settings: settingsPage };

async function render() {
  const main = document.getElementById('main');
  try {
    me = await api('GET', 'me');
    renderTabs();
    main.replaceChildren(...[await PAGES[tab]()].flat().filter(Boolean));
  } catch (e) {
    main.replaceChildren(el('p', { class: 'bad' }, e.message));
  }
  clearTimeout(timer);
  if (tab === 'overview') timer = setTimeout(() => { if (!document.hidden) render(); else timer = setTimeout(render, 30000); }, 30000);
}

render();
