// 自检：复制按钮只在剪贴板里真的有这段字时才打对勾（src/copy-text.js）。
// 假剪贴板：前几次写不进去（别的程序占着），或者一直写不进去。运行：node scripts/check-copy-text.js
const { makeCopyText, RETRY_MS } = require('../src/copy-text');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

// failWrites：前几次 writeText 不报错但没写进去；throwReads：前几次 readText 抛错
function fakeClipboard({ failWrites = 0, throwReads = 0, crlf = false } = {}) {
  let content = '旧内容';
  const c = { writes: 0, reads: 0 };
  c.writeText = async (t) => { c.writes += 1; if (c.writes > failWrites) content = crlf ? t.replace(/\n/g, '\r\n') : t; };
  c.readText = async () => { c.reads += 1; if (c.reads <= throwReads) throw new Error('busy'); return content; };
  c.get = () => content;
  return c;
}
const waits = [];
const run = (clip, text) => makeCopyText(clip, async (ms) => { waits.push(ms); })(text);

(async () => {
  let c = fakeClipboard();
  check(await run(c, 'Hello Anna') === true && c.get() === 'Hello Anna' && c.writes === 1, '一次写进去：返回 true，只写一次');

  waits.length = 0; c = fakeClipboard({ failWrites: 2 });
  check(await run(c, 'Guten Tag, Herr Weber') === true && c.writes === 3 && c.get() === 'Guten Tag, Herr Weber', '前两次写不进去：重写，第三次成功返回 true');
  check(waits.join() === RETRY_MS.slice(0, 2).join(), `重写前依次等 ${RETRY_MS.slice(0, 2).join('、')} 毫秒`);

  c = fakeClipboard({ failWrites: 99 });
  check(await run(c, 'Bonjour') === false && c.writes === RETRY_MS.length + 1, `一直写不进去：试 ${RETRY_MS.length + 1} 次后返回 false`);

  c = fakeClipboard({ throwReads: 1 });
  check(await run(c, 'Hola') === true, '读回来时剪贴板被占着（抛错）：当作没写上，重试后成功');

  c = fakeClipboard({ crlf: true });
  check(await run(c, 'line1\nline2') === true && c.writes === 1, 'Windows 换行变成 \\r\\n 不算写失败');

  c = fakeClipboard();
  check(await run(c, '') === false && await run(c, 123) === false && c.writes === 0, '空字符串、不是字符串：返回 false，不碰剪贴板');

  c = fakeClipboard();
  const long = 'x'.repeat(5000);
  check(await run(c, long) === true && c.get().length === 4000, '最长复制 4000 字');

  // 写剪贴板再贴的地方都走 copyText：「插入」「放进输入框」不能直接 clipboard.writeText 后就贴（写不进去会贴出旧内容）
  const read = (f) => require('fs').readFileSync(require('path').join(__dirname, '..', 'src', f), 'utf8');
  const ins = read('compose-insert.js');
  check(/await copyText\(text\)\)\) return 'clip'/.test(ins), "「插入」用 copyText 确认写进去，没写上返回 'clip'");
  check(ins.indexOf('copyText(text)') > -1 && ins.indexOf('copyText(text)') < ins.indexOf('.paste()') && !/clipboard\.writeText/.test(ins), '「插入」先确认再 paste，不直接写剪贴板');
  check(/copyText,\n/.test(read('main.js').slice(read('main.js').indexOf('async function insertText'))), 'main.js 的 insertText 把 copyText 交给 compose-insert.js');

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();
