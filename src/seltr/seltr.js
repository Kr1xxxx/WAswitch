// 网页号账号页面上面的小视图：「翻译」按钮，点了变成悬浮译文窗。状态都由主进程推过来（sel-translate.js）
const card = window.SelCard({
  go: () => window.seltr.go(),
  copy: (text) => window.seltr.copy(text),
  retry: () => window.seltr.retry(),
});
document.body.append(card.root);
window.seltr.onState((st) => {
  card.set(st);
  // 译文窗高度跟着内容走：量好告诉主进程改视图大小
  if (st && st.mode === 'card') requestAnimationFrame(() => window.seltr.size(card.root.offsetHeight));
});
// 透明边上点一下当作点空白：收起
document.addEventListener('mousedown', (e) => { if (!card.root.contains(e.target)) window.seltr.hide(); });
window.seltr.ready();
