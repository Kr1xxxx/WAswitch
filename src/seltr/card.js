// 选中聊天文字后的「翻译」小按钮和悬浮译文窗（shen 2026-10-28：点了直接弹悬浮窗，不跳到右侧）。
// 网页号的小视图（seltr.js）和轻量号聊天页（shell 的 lite.js）共用这一份，样式在 card.css。
// 只用 textContent 放文字，不拼 HTML。
(function (root) {
  const SVG = 'http://www.w3.org/2000/svg';
  // 和 shell.js 的 translate 图标同一个
  function trIcon() {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.6 5.5 7M11 5c-.7 3.4-3 6.4-6.5 8', 'M13 21l4-9 4 9M14.5 18h5']) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const COPIED_MS = 1800;

  // handlers：go() 点了「翻译」；copy(text) 复制译文；retry() 出错后重试
  // 返回 { root, set(state) }。state：{ mode: 'button' } 或 { mode: 'card', busy, text, error }
  function SelCard(handlers) {
    const box = el('div', 'sc');
    let copyTimer = null;
    function set(st) {
      clearTimeout(copyTimer);
      box.replaceChildren();
      box.dataset.mode = st && st.mode === 'card' ? 'card' : 'button';
      if (box.dataset.mode === 'button') {
        const b = el('button', 'sc-go');
        b.type = 'button';
        b.append(trIcon(), el('span', '', '翻译'));
        b.addEventListener('mousedown', (e) => e.preventDefault()); // 不把选区点没
        b.addEventListener('click', () => handlers.go());
        box.append(b);
        return;
      }
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', '译文');
      if (st.busy) {
        box.append(el('p', 'sc-dim', '翻译中…'));
        return;
      }
      if (st.error) {
        const retry = el('button', 'sc-btn', '重试');
        retry.type = 'button';
        retry.addEventListener('click', () => handlers.retry());
        box.append(el('p', 'sc-err', st.error), el('div', 'sc-foot', undefined));
        box.lastChild.append(retry);
        return;
      }
      const text = String(st.text || '');
      const copy = el('button', 'sc-btn', '复制');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        handlers.copy(text);
        copy.textContent = '已复制';
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copy.textContent = '复制'; }, COPIED_MS);
      });
      const foot = el('div', 'sc-foot');
      foot.append(copy);
      box.append(el('p', 'sc-text', text), foot);
    }
    set({ mode: 'button' });
    return { root: box, set };
  }
  root.SelCard = SelCard;
})(typeof window !== 'undefined' ? window : globalThis);
