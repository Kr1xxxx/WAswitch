// 日志：每天一个文件，保留最近 7 天，放在 用户数据目录/logs 下。
// 只记录软件自己的运行情况（启动、代理错误、页面崩溃等），不记录聊天内容和号码。
// 真机出问题时，把日志文件发过来就能排查。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const util = require('util');

const KEEP_DAYS = 7;
let dir = null;

const today = () => new Date().toISOString().slice(0, 10);
const logDir = () => dir;

function write(level, args) {
  if (!dir) return;
  const line = `${new Date().toISOString()} [${level}] ${util.format(...args)}\n`;
  try { fs.appendFileSync(path.join(dir, `waswitch-${today()}.log`), line); } catch { /* 磁盘满或无权限时不影响运行 */ }
}

function cleanup() {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^waswitch-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* 忽略 */ }
}

// 把 console 的输出同时写进日志文件，并记录未处理的异常。
// onFatal(error)：未捕获的异常记完日志后调用（提示并重启），不让软件带着坏状态继续跑。
function init(onFatal) {
  dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  cleanup();
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => { original(...args); write(level, args); };
  }
  process.on('uncaughtException', (e) => {
    console.error('未捕获的异常：', e && e.stack ? e.stack : e);
    if (onFatal) onFatal(e);
  });
  // 异步操作失败（比如某个账号的代理测试出错）只记录，不影响其他账号
  process.on('unhandledRejection', (e) => console.error('未处理的 Promise 错误：', e && e.stack ? e.stack : e));
  console.log(`WAswitch ${app.getVersion()} 启动，Electron ${process.versions.electron}，Chrome ${process.versions.chrome}，${process.platform} ${process.arch}`);
}

module.exports = { init, logDir };
