// 通知弹窗页面：只负责把主进程发来的卡片画出来，再把点击和“鼠标停在上面”告诉主进程。
// 所有文字都用 textContent 放进去，不拼 HTML。
(() => {
  const zone = document.getElementById('zone');
  const LOGO = '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26282C"/><stop offset="1" stop-color="#0B0B0D"/></linearGradient><linearGradient id="la" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#EBCF92"/><stop offset="1" stop-color="#B48A45"/></linearGradient></defs><rect width="100" height="100" rx="22" fill="url(#lg)"/><path d="M43 35A22 22 0 0 1 65 57A22 22 0 0 1 43 79H21V57A22 22 0 0 1 43 35Z" fill="#fff"/><path d="M69 21A10 10 0 0 1 79 31V41H69A10 10 0 0 1 59 31A10 10 0 0 1 69 21Z" fill="url(#la)"/></svg>';
  const LOCK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const seen = new Set(); // 已经画过的卡片，只有新卡片带滑入动画
  let state = { cards: [], more: 0, platform: 'darwin' };

  const h = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const svg = (markup, cls) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = markup; // 只用上面两个写死的图标
    const el = tpl.content.firstElementChild;
    if (cls) el.setAttribute('class', cls);
    return el;
  };

  function timeText(at) {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 60) return '现在';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function avatar(c) {
    const a = c.avatar || {};
    if (a.lock) {
      const el = h('span', 'av lock');
      el.append(svg(LOCK), svg(LOGO, 'badge'));
      return el;
    }
    if (a.logo) {
      const el = h('span', 'av logo');
      el.append(svg(LOGO, 'big'));
      return el;
    }
    const el = h('span', 'av', a.text || '#');
    el.style.background = a.color || '#5A5F8C';
    el.append(svg(LOGO, 'badge'));
    return el;
  }

  function card(c) {
    const el = h('div', `nt${c.avatar && c.avatar.lock ? ' locked' : ''}${seen.has(c.uid) ? '' : ' in'}`);
    seen.add(c.uid);
    el.dataset.uid = String(c.uid);
    el.dataset.act = 'open';
    const x = h('button', 'x', '✕');
    x.dataset.act = 'close';
    x.setAttribute('aria-label', '关闭');
    const top = h('div', 'top');
    const body = h('div', 'body');
    const line1 = h('div', 'line1');
    line1.append(h('span', 'who', c.who || ''));
    if (c.count > 1) line1.append(h('span', 'cnt', `${c.count} 条`));
    if (c.again) line1.append(h('span', 'again', '稍后提醒'));
    const t = h('time', null, timeText(c.at));
    t.dataset.at = String(c.at);
    line1.append(t);
    body.append(line1);
    if (c.acc && c.kind === 'msg') {
      const meta = h('div', 'meta');
      const chip = h('span', 'acc');
      const dot = h('i');
      dot.style.background = c.acc.color || '#888';
      chip.append(dot, document.createTextNode(c.acc.name || ''));
      meta.append(chip);
      body.append(meta);
    }
    body.append(h('div', 'txt', c.text || ''));
    top.append(avatar(c), body);
    const acts = h('div', `acts${c.actions.length === 1 ? ' one' : ''}`);
    for (const a of c.actions) {
      const b = h('button', `btn${a === 'open' ? ' pri' : ''}`, a === 'open' ? '打开' : '稍后');
      b.dataset.act = a;
      acts.append(b);
    }
    el.append(x, top, acts);
    return el;
  }

  function render() {
    document.body.classList.toggle('win', state.platform === 'win32');
    zone.replaceChildren(...state.cards.map(card));
    if (state.more > 0) {
      const more = h('div', 'more');
      more.append(document.createTextNode(`还有 ${state.more} 条 · `));
      const b = h('button', null, '全部收起');
      b.dataset.act = 'clear';
      more.append(b);
      zone.append(more);
    }
    // 只留还在的卡片，免得集合一直变大
    const live = new Set(state.cards.map((c) => c.uid));
    for (const uid of seen) if (!live.has(uid)) seen.delete(uid);
    checkHover();
  }

  // 提示音：两个很短的音，不用音频文件
  let audio = null;
  function ding() {
    try {
      audio = audio || new AudioContext();
      const now = audio.currentTime;
      for (const [freq, at] of [[880, 0], [1320, 0.11]]) {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, now + at);
        g.gain.linearRampToValueAtTime(0.12, now + at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
        o.connect(g).connect(audio.destination);
        o.start(now + at);
        o.stop(now + at + 0.25);
      }
    } catch {
      // 放不出声音就算了
    }
  }

  // 鼠标是否停在卡片上：窗口平时是点穿的，主进程靠这个决定要不要接收点击、要不要暂停倒计时
  let hovering = false;
  let lastPoint = null;
  function setHover(on) {
    if (on === hovering) return;
    hovering = on;
    window.pp.hover(on);
  }
  function checkHover() {
    if (!lastPoint) return;
    const el = document.elementFromPoint(lastPoint.x, lastPoint.y);
    setHover(!!(el && el.closest('.nt, .more')));
  }
  document.addEventListener('mousemove', (e) => { lastPoint = { x: e.clientX, y: e.clientY }; checkHover(); });
  document.addEventListener('mouseleave', () => { lastPoint = null; setHover(false); });

  zone.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'clear') { window.pp.act(0, 'clear'); return; }
    const nt = t.closest('.nt');
    if (nt) window.pp.act(nt.dataset.uid, act);
  });

  setInterval(() => {
    for (const t of zone.querySelectorAll('time[data-at]')) t.textContent = timeText(Number(t.dataset.at));
  }, 30 * 1000);

  window.pp.onState((s) => {
    state = s || { cards: [], more: 0 };
    if (s && s.sound) ding();
    render();
  });
  window.pp.ready();
})();
