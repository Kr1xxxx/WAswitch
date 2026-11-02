// 写剪贴板并确认写进去了（界面上的「复制」按钮靠它决定要不要打对勾）。
// Windows 上别的程序（剪贴板工具、输入法、聊天软件）正占着剪贴板时，Chromium 只重试约 20 毫秒，写不进去也不报错：
// 写完读回来对比，不一致就隔一会儿重写，最多 3 次。Electron 的剪贴板接口都是异步的。
const RETRY_MS = [50, 150, 300];
const MAX_LEN = 4000;
const norm = (s) => String(s).replace(/\r\n/g, '\n');

function makeCopyText(clipboard, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  return async function copyText(text) {
    if (typeof text !== 'string' || !text) return false;
    const want = text.slice(0, MAX_LEN);
    for (let i = 0; i <= RETRY_MS.length; i += 1) {
      if (i > 0) await wait(RETRY_MS[i - 1]);
      try {
        await clipboard.writeText(want);
        if (norm(await clipboard.readText()) === norm(want)) return true;
      } catch { /* 剪贴板被占着：下一轮再试 */ }
    }
    return false;
  };
}

module.exports = { makeCopyText, RETRY_MS };
