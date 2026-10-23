// 左侧账号栏：点击切换，右键删除，双击改名，"+" 新增账号。
const list = document.getElementById('list');
const unread = {};
let state = { accounts: [], activeId: null };

function render() {
  list.innerHTML = '';
  state.accounts.forEach((acc, i) => {
    const b = document.createElement('button');
    b.className = 'acc' + (acc.id === state.activeId ? ' active' : '');
    b.title = acc.name;
    b.textContent = String(i + 1);
    if (unread[acc.id]) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = unread[acc.id];
      b.appendChild(badge);
    }
    b.onclick = () => window.wa.switchTo(acc.id);
    // Electron 不支持 prompt()，这里用一个临时输入框改名
    b.ondblclick = () => {
      const input = document.createElement('input');
      input.value = acc.name;
      input.style.cssText = 'width:64px;font-size:12px';
      const done = () => { if (input.value.trim()) window.wa.rename(acc.id, input.value.trim()); else render(); };
      input.onkeydown = (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') render(); };
      input.onblur = done;
      b.replaceWith(input);
      input.focus();
      input.select();
    };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm(`删除「${acc.name}」并退出登录？`)) window.wa.remove(acc.id);
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
