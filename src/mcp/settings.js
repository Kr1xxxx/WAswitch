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
}

$('enabled').onchange = async (e) => render(await window.mcp.setEnabled(e.target.checked));
$('regenerate').onclick = async () => render(await window.mcp.regenerate());
for (const b of document.querySelectorAll('[data-copy]')) {
  b.onclick = async () => {
    await window.mcp.copy(b.dataset.copy);
    const old = b.textContent;
    b.textContent = '已复制';
    setTimeout(() => { b.textContent = old; }, 1500);
  };
}
window.mcp.onUpdate(render);
window.mcp.status().then(render);
