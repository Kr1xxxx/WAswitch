// 网页号账号页面上面的小视图：「翻译」按钮，点了变成悬浮译文窗；或者气泡译文的编辑小窗（点译文末尾的小铅笔）。
// 状态都由主进程推过来（sel-translate.js）
const card = window.SelCard({
  go: () => window.seltr.go(),
  copy: (text) => window.seltr.copy(text),
  retry: () => window.seltr.retry(),
});
const sizeSoon = () => requestAnimationFrame(() => window.seltr.size(document.body.firstElementChild.offsetHeight));
const tr = window.TrCard({
  save: (text) => window.seltr.trSave(text),
  fix: (text) => window.seltr.trFix(text),
  take: (yes) => window.seltr.trTake(yes),
  // 改了没保存的字每次都告诉主进程（收起后下次打开还在）
  draft: (text) => window.seltr.trDraft(text),
  resized: sizeSoon,
});
document.body.append(card.root);
let mode = '';
window.seltr.onState((st) => {
  if (st && st.mode === 'tr') {
    const first = mode !== 'tr' || st.open;
    if (first) tr.reset();
    mode = 'tr';
    if (card.root.isConnected) card.root.replaceWith(tr.root);
    tr.set(st);
    if (first) tr.focus();
    sizeSoon();
    return;
  }
  mode = st && st.mode;
  if (tr.root.isConnected) tr.root.replaceWith(card.root);
  card.set(st);
  // 译文窗高度跟着内容走：量好告诉主进程改视图大小
  if (st && st.mode === 'card') sizeSoon();
});
// 透明边上点一下当作点空白：收起
document.addEventListener('mousedown', (e) => { if (!document.body.firstElementChild.contains(e.target)) window.seltr.hide(); });
window.seltr.ready();
