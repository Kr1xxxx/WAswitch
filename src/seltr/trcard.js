// 气泡里译文的编辑小窗（点译文末尾的小铅笔弹出）：改译文、看翻译信息、纠错、采用纠错建议。
// 网页号的小视图（seltr.js，盖在账号页面上面）和轻量号聊天页（shell 的 lite.js）共用这一份，样式在 card.css 的 .tc-*。
// 只用 textContent 放文字，不拼 HTML。状态由调用方给（主进程 FloatCore.entry 的字段 + draft）。
(function (root) {
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function btn(label, cls, onClick) {
    const b = el('button', `tc-btn${cls ? ` ${cls}` : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // handlers：save(text) 保存；fix(text) 纠错（text 和译文不同先保存）；take(yes) 采用 / 不用纠错建议；
  // draft(text) 改了没保存的字（收起后下次打开还在）；key(pid) 去填密钥；resized() 高度变了
  // 返回 { root, set(st), focus() }。st：{ h, state, orig, tr, edited, fixed, suggest, err, errPid, rows, draft }
  function TrCard(handlers) {
    const box = el('div', 'tc');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', '编辑译文');
    const field = el('div', 'tc-field');
    const ta = el('textarea');
    ta.setAttribute('aria-label', '译文');
    ta.maxLength = 4000;
    field.append(ta);
    const sg = el('div', 'tc-sg');
    const err = el('div', 'tc-err');
    const info = el('div', 'tc-info');
    const foot = el('div', 'tc-foot');
    box.append(field, sg, err, info, foot);
    let st = null;
    let base = null; // 框里的字是按哪条译文填的：译文换了（纠错好了）才重新填
    let key = '';

    const busy = () => !!st && (st.state === 'queued' || st.state === 'running');
    const changed = () => !!st && ta.value.trim() !== '' && ta.value !== st.tr;
    function save() {
      if (!st || busy() || !changed()) return;
      handlers.save(ta.value);
    }
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      if (e.shiftKey) return;
      e.preventDefault();
      save();
    });
    ta.addEventListener('input', () => { handlers.draft(ta.value); drawFoot(); });

    function drawFoot() {
      const kids = [];
      if (st.suggest && !busy()) {
        kids.push(btn('不用', '', () => handlers.take(false)), btn('采用', 'primary', () => handlers.take(true)));
      } else {
        if (busy()) kids.push(el('span', 'tc-wait', '纠错中…'));
        else if (st.orig) kids.push(btn('纠错', '', () => handlers.fix(ta.value)));
        const s = btn('保存', 'primary', save);
        s.disabled = busy() || !changed();
        kids.push(s);
      }
      foot.replaceChildren(...kids);
    }

    function set(next) {
      st = next || null;
      if (!st) return;
      if (base === null || st.tr !== base || st.h !== key) {
        // 第一次打开、换了一条、或译文被换掉（纠错好了）：框里换成这条现在的译文（打开时有没保存的字就用它）
        const fresh = base === null || st.h !== key;
        key = st.h;
        base = st.tr;
        ta.value = fresh && typeof st.draft === 'string' && st.draft ? st.draft : st.tr;
      }
      ta.readOnly = busy();
      field.classList.toggle('ro', busy());
      // 纠错建议（手动改过的再纠错）
      sg.hidden = !st.suggest;
      if (st.suggest) sg.replaceChildren(el('small', '', '纠错建议'), el('span', '', st.suggest));
      // 纠错失败：红字；密钥的问题多一个「去填密钥」
      err.hidden = !st.err;
      if (st.err) {
        err.replaceChildren(el('span', '', st.err));
        if (st.errPid) err.append(btn('去填密钥', 'link', () => handlers.key(st.errPid)));
      }
      // 翻译信息：已手动修改 / 已纠错，翻译（纠错）时间、用时、模型
      const parts = [];
      if (st.edited) parts.push(el('span', 'tc-tag', '已手动修改'));
      else if (st.fixed) parts.push(el('span', 'tc-tag', '已纠错'));
      for (const [k, v] of Array.isArray(st.rows) ? st.rows : []) {
        const r = el('span', 'tc-row', k);
        r.append(el('b', '', v));
        parts.push(r);
      }
      info.hidden = !parts.length;
      info.replaceChildren(...parts);
      drawFoot();
      if (handlers.resized) handlers.resized();
    }
    function focus() {
      ta.focus({ preventScroll: true });
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }
    // 收起后再打开另一条：下次 set 当作第一次
    function reset() { st = null; base = null; key = ''; ta.value = ''; }
    return { root: box, set, focus, reset, get text() { return ta.value; } };
  }
  root.TrCard = TrCard;
})(typeof window !== 'undefined' ? window : globalThis);
