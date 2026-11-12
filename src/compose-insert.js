// 网页号的「放进输入框」（翻译页的「放进输入框」、话术的「插入」）：等于帮用户点一下对话下方的输入框，再按一次 Ctrl+V。
// 会覆盖剪贴板；不发回车、不模拟按键，发送永远由人来按。
// 用户点了按钮就是要放进输入框，所以光标不在那里（点过消息、在搜索框里）时先把光标放进去（wa-page.js 的 focusCompose），
// 接在已有文字的后面；光标本来就在输入框里就贴在光标处。
//
// deps（main.js 提供）：
//   blocked() -> '' | 'changed' | ...    换号、锁定、页面有问题时不贴，原因原样返回
//   wc()                                   这个号的页面（blocked() 为空时一定有）
//   copyText(text) -> Promise<boolean>     写进剪贴板并读回来确认（copy-text.js）
//   focusCompose(wc) -> Promise<'compose' | 'none' | 'other' | 'unknown'>
// 返回 'ok' | 'no_chat'（没打开对话）| 'focus'（光标放不进输入框）| 'clip'（剪贴板没写上）| blocked() 的原因 | 'changed'
async function pasteToCompose(text, { blocked, wc, copyText, focusCompose }) {
  const ready = async () => {
    const before = blocked();
    if (before) return before;
    const page = wc();
    page.focus(); // 先把键盘焦点给这个号的页面（贴完本来也要给），再放光标
    const focus = await focusCompose(page);
    const after = blocked(); // 放光标期间可能换号、锁定
    if (after) return after;
    return { compose: '', none: 'no_chat', other: 'focus' }[focus] ?? 'changed';
  };
  let err = await ready();
  if (err) return err;
  // 剪贴板是异步的，别的程序占着时可能悄悄写不进去：写完读回来确认，没写上就不贴，免得把剪贴板里的旧内容贴进客户的输入框
  if (!(await copyText(text))) return 'clip';
  err = await ready(); // 写剪贴板可能重试半秒左右，期间用户可能点了别处
  if (err) return err;
  const page = wc();
  page.focus();
  page.paste();
  return 'ok';
}

module.exports = { pasteToCompose };
