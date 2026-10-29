// 打包冒烟：启动打包好的程序（空配置），10 秒后它应该还在运行，日志里没有 [error]。
// 运行：node scripts/smoke-packaged.js <可执行文件>（CI 在 Windows 上跑）
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bin = process.argv[2];
if (!bin || !fs.existsSync(bin)) { console.error(`找不到可执行文件：${bin}`); process.exit(1); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-smoke-'));
const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home };
// 输出经由本进程转发，不让子进程直接占着 CI 步骤的输出管道（Windows 上残留的子进程会让步骤卡住）
const child = spawn(bin, ['--no-sandbox'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

setTimeout(() => {
  const running = exited === null;
  if (running) {
    // Windows 上 kill 只结束主进程，GPU、渲染等子进程会留下；用 taskkill /T 连同子进程一起结束
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  }
  const logs = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/^waswitch-.*\.log$/.test(f.name)) logs.push(p); } };
  walk(home);
  // Windows 的数据目录不跟 HOME 走，在 %APPDATA%\\waswitch（CI 机器是全新的，里面只有这次的日志）
  if (process.platform === 'win32' && process.env.APPDATA && fs.existsSync(path.join(process.env.APPDATA, 'waswitch'))) walk(path.join(process.env.APPDATA, 'waswitch'));
  // D:\WAswitch 存在时账号数据（含日志）在 D:\WAswitch\data（src/datadir.js）
  if (process.platform === 'win32' && fs.existsSync('D:\\WAswitch\\data')) walk('D:\\WAswitch\\data');
  const text = logs.map((f) => fs.readFileSync(f, 'utf8')).join('');
  const errors = text.split('\n').filter((l) => l.includes('[error]'));
  console.log(`\n日志文件 ${logs.length} 个；${running ? '10 秒后仍在运行' : `提前退出：${JSON.stringify(exited)}`}`);
  if (errors.length) console.log(errors.join('\n'));
  const ok = running && logs.length > 0 && /启动/.test(text) && !errors.length;
  console.log(ok ? '冒烟通过' : '冒烟失败');
  process.exit(ok ? 0 : 1);
}, 10000);
