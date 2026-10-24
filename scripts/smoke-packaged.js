// 打包冒烟：启动打包好的程序（空配置），10 秒后它应该还在运行，日志里没有 [error]。
// 运行：node scripts/smoke-packaged.js <可执行文件>（Linux 无界面环境用 xvfb-run）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bin = process.argv[2];
if (!bin || !fs.existsSync(bin)) { console.error(`找不到可执行文件：${bin}`); process.exit(1); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-smoke-'));
const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home };
const child = spawn(bin, ['--no-sandbox'], { env, stdio: 'inherit' });
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

setTimeout(() => {
  const running = exited === null;
  if (running) child.kill('SIGTERM');
  const logs = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/^waswitch-.*\.log$/.test(f.name)) logs.push(p); } };
  walk(home);
  const text = logs.map((f) => fs.readFileSync(f, 'utf8')).join('');
  const errors = text.split('\n').filter((l) => l.includes('[error]'));
  console.log(`\n日志文件 ${logs.length} 个；${running ? '10 秒后仍在运行' : `提前退出：${JSON.stringify(exited)}`}`);
  if (errors.length) console.log(errors.join('\n'));
  const ok = running && logs.length > 0 && /启动/.test(text) && !errors.length;
  console.log(ok ? '冒烟通过' : '冒烟失败');
  process.exit(ok ? 0 : 1);
}, 10000);
