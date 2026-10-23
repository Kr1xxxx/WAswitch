// 轻量模式自检要在真正运行的环境里跑：Electron 内置的 Node（版本和内置 fetch 都和系统 Node 不同）。
// 系统 Node 也跑一遍，两边都通过才算通过。
const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron'); // 在普通 Node 里 require('electron') 返回 Electron 可执行文件的路径

const script = path.join(__dirname, 'check-lite.mjs');
const runs = [
  ['Electron 内置 Node', electron, { ...process.env, ELECTRON_RUN_AS_NODE: '1' }],
  ['系统 Node', process.execPath, process.env],
];
let ok = true;
for (const [label, bin, env] of runs) {
  console.log(`\n===== ${label} =====`);
  const r = spawnSync(bin, [script], { stdio: 'inherit', env });
  if (r.status !== 0) ok = false;
}
process.exit(ok ? 0 : 1);
