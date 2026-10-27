const $ = (id) => document.getElementById(id);
const time = (t) => new Date(t).toLocaleTimeString();

function render(s) {
  $('enabled').checked = s.enabled;
  const st = $('state');
  if (s.error) { st.className = 'bad'; st.textContent = `没能开启：${s.error}`; }
  else if (s.running) { st.className = 'ok'; st.textContent = `运行中：${s.url}`; }
  else { st.className = ''; st.textContent = '已关闭'; }
  $('details').hidden = !s.running;
  $('claudeCode').textContent = s.snippets.claudeCode;
  $('claudeDesktop').textContent = s.snippets.claudeDesktop;
  const body = $('clients');
  body.innerHTML = '';
  for (const c of s.clients) {
    const tr = document.createElement('tr');
    for (const v of [c.name, time(c.connectedAt), time(c.lastSeen), String(c.calls)]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  $('noClients').hidden = s.clients.length > 0;

  $('layer2').checked = s.layer2;
  $('preview').checked = s.preview;
  $('preview').disabled = !s.layer2;
  const allows = $('allows');
  allows.innerHTML = '';
  for (const a of s.allows) {
    const li = document.createElement('li');
    li.textContent = `允许客户端（自称 ${a.client}）读「${a.account}」的${a.kind === 'messages' ? '聊天消息' : `对话列表${a.preview ? '（含预览）' : ''}`}，到 ${time(a.until)}`;
    const btn = document.createElement('button');
    btn.textContent = '撤销';
    btn.onclick = async () => render(await window.mcp.revoke(a.key));
    li.appendChild(btn);
    allows.appendChild(li);
  }
  $('allowsBox').hidden = !s.allows.length;
  const log = $('readLog');
  log.innerHTML = '';
  for (const r of s.readLog) {
    const li = document.createElement('li');
    li.textContent = r.kind === 'search'
      ? `${time(r.at)} ${r.client} 在「${r.account}」里找「${r.query}」，找到 ${r.count} 个对话${r.preview ? '（含预览）' : ''}`
      : r.kind === 'messages'
      ? `${time(r.at)} ${r.client} 读了「${r.account}」的 ${r.count} 条消息`
      : `${time(r.at)} ${r.client} 读了「${r.account}」${r.count} 个对话${r.preview ? '（含预览）' : ''}`;
    log.appendChild(li);
  }
  $('logBox').hidden = !s.readLog.length;

  $('drafts').checked = s.drafts;
  const draftLog = $('draftLog');
  draftLog.innerHTML = '';
  const RESULT = { placed: '已放进输入框', pending: '在窗口顶部等你确认', busy: '上一条还没处理，没放', gone: '账号不存在' };
  for (const d of s.draftLog || []) {
    const li = document.createElement('li');
    li.textContent = `${time(d.at)} ${d.client} 给「${d.account}」的「${d.chat}」起草了 ${d.chars} 字：${RESULT[d.result] || d.result}`;
    draftLog.appendChild(li);
  }
  $('draftLogBox').hidden = !(s.draftLog || []).length;

  $('customers').checked = !!s.customers;
  const cAllows = $('customerAllows');
  cAllows.innerHTML = '';
  for (const a of s.customerAllows || []) {
    const li = document.createElement('li');
    li.textContent = `允许客户端（自称 ${a.client}）搜索客户资料，到 ${time(a.until)}`;
    const btn = document.createElement('button');
    btn.textContent = '撤销';
    btn.onclick = async () => render(await window.mcp.revokeCustomers(a.key));
    li.appendChild(btn);
    cAllows.appendChild(li);
  }
  $('customerAllowsBox').hidden = !(s.customerAllows || []).length;
  const cLog = $('customerLog');
  cLog.innerHTML = '';
  for (const r of s.customerLog || []) {
    const li = document.createElement('li');
    li.textContent = `${time(r.at)} ${r.client} 搜了 ${r.query}，返回 ${r.count} 个客户`;
    cLog.appendChild(li);
  }
  $('customerLogBox').hidden = !(s.customerLog || []).length;
  $('helpers').checked = !!s.helpers;
  $('customerEdit').checked = !!s.customerEdit;
  renderAiLog(s.aiLog || []);
}

// AI 操作记录：每条写清改了谁、改了什么（之前 → 之后），后面一个“撤销”按钮
const when = (t) => new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const short = (v, n = 40) => { const t = String(v).replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n)}…` : t; };
function showValue(field, v) {
  if (field === 'tags') return v && v.length ? v.join('、') : '无';
  if (field === 'followUpAt') return v ? when(v) : '无';
  return v ? `「${short(v)}」` : '空';
}
function renderAiLog(list) {
  const ul = $('aiLog');
  ul.innerHTML = '';
  for (const e of list) {
    const li = document.createElement('li');
    const what = document.createElement('div');
    what.className = 'what';
    const head = document.createElement('div');
    head.textContent = e.op === 'create'
      ? `新建客户「${e.customer}」${e.account ? `（${e.account}）` : ''}`
      : `改了「${e.customer}」${e.account ? `（${e.account}）` : ''}`;
    what.appendChild(head);
    const body = document.createElement('div');
    body.className = 'meta';
    body.textContent = e.changes.map((c) => (e.op === 'create'
      ? `${c.label}：${showValue(c.field, c.after)}`
      : `${c.label}：${showValue(c.field, c.before)} → ${showValue(c.field, c.after)}`)).join('；');
    what.appendChild(body);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${when(e.at)} · ${e.client}${e.undone && e.undoNote !== '已撤销' ? ` · ${e.undoNote}` : ''}`;
    what.appendChild(meta);
    li.appendChild(what);
    if (e.undone) {
      const done = document.createElement('span');
      done.className = 'done';
      done.textContent = '已撤销';
      li.appendChild(done);
    } else {
      const btn = document.createElement('button');
      btn.textContent = '撤销';
      btn.onclick = async () => {
        btn.disabled = true;
        const r = await window.mcp.undo(e.id);
        const msg = $('undoMsg');
        msg.textContent = r.message;
        msg.className = `hint ${r.ok ? 'ok' : 'bad'}`;
        render(r.view);
      };
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
  $('aiLogBox').hidden = !list.length;
}

$('layer2').onchange = async (e) => render(await window.mcp.setLayer2(e.target.checked));
$('preview').onchange = async (e) => render(await window.mcp.setPreview(e.target.checked));
$('drafts').onchange = async (e) => render(await window.mcp.setDrafts(e.target.checked));
$('customers').onchange = async (e) => render(await window.mcp.setCustomers(e.target.checked));
$('helpers').onchange = async (e) => render(await window.mcp.setHelpers(e.target.checked));
$('customerEdit').onchange = async (e) => render(await window.mcp.setCustomerEdit(e.target.checked));

$('enabled').onchange = async (e) => render(await window.mcp.setEnabled(e.target.checked));
$('regenerate').onclick = async () => render(await window.mcp.regenerate());
// 复制成功：按钮原地换成绿色小对勾（同位置同大小），约 1.5 秒后变回，和主窗口一致
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
for (const b of document.querySelectorAll('[data-copy]')) {
  const label = b.textContent;
  b.onclick = async () => {
    await window.mcp.copy(b.dataset.copy);
    clearTimeout(b._t);
    if (!b.classList.contains('copy-ok')) b.style.minWidth = `${b.offsetWidth}px`;  // 高度由 CSS 固定
    b.innerHTML = CHECK_SVG;
    b.title = '已复制';
    b.classList.add('copy-ok');
    b._t = setTimeout(() => { b.textContent = label; b.title = ''; b.style.minWidth = ''; b.classList.remove('copy-ok'); }, 1500);
  };
}
window.mcp.onUpdate(render);
window.mcp.status().then(render);
