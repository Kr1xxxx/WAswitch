// 左侧账号栏：点击切换，右键打开菜单，"+" 新增账号。
const list = document.getElementById('list');
const unread = {};
let state = { accounts: [], activeId: null };

function render() {
  list.innerHTML = '';
  state.accounts.forEach((acc, i) => {
    const b = document.createElement('button');
    b.className = 'acc' + (acc.id === state.activeId ? ' active' : '');
    b.title = acc.problem ? `${acc.name}\n⚠ ${acc.problem}` : acc.name;
    b.textContent = String(i + 1);
    if (unread[acc.id]) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = unread[acc.id];
      b.appendChild(badge);
    }
    if (acc.problem) {
      const warn = document.createElement('span');
      warn.className = 'warn';
      warn.textContent = '!';
      warn.setAttribute('aria-label', acc.problem);
      b.appendChild(warn);
    }
    b.onclick = () => window.wa.switchTo(acc.id);
    // 右键打开菜单：编辑名称/代理/地区、重新加载、删除
    b.oncontextmenu = (e) => {
      e.preventDefault();
      window.wa.context(acc.id);
    };
    list.appendChild(b);
  });
  const add = document.createElement('button');
  add.id = 'add';
  add.textContent = '+';
  add.title = '添加账号';
  add.onclick = () => window.wa.add();
  list.appendChild(add);
}

window.wa.onState((s) => { state = s; render(); });
window.wa.onUnread(({ id, count }) => { unread[id] = count; render(); });
