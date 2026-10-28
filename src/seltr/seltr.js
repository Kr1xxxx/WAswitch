// 按钮四周留给阴影的透明边：点到这里当作点空白，收起按钮
document.getElementById('go').addEventListener('click', () => window.seltr.go());
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#go')) window.seltr.hide(); });
