// 试验：按当前用户装字体前后，Electron / Chrome / Edge 里 local() 认不认、字重变不变、要不要重启
// node run.mjs <names.json> <oppo.ttf> <noto.ttf>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const electronPath = require('electron');
const results = {};
const [namesFile, oppoFile, notoFile] = process.argv.slice(2);
const names = JSON.parse(fs.readFileSync(namesFile, 'utf8'));
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const probeSrc = fs.readFileSync(path.join(here, 'probe.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - T0) / 1000).toFixed(1)}s`, ...a);
setTimeout(() => { log('WATCHDOG: 7 分钟没跑完，退出'); console.log(JSON.stringify(results)); process.exit(1); }, 7 * 60 * 1000).unref();
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + what)), ms))]);

function cands(key, extra) {
  const d = names[key]; const set = new Set(extra);
  for (const k of ['family', 'full', 'ps', 'typo']) if (d[k]) set.add(d[k]);
  const fam = d.typo || d.family;
  for (const i of d.instances) { if (i.sub) set.add(`${fam} ${i.sub}`); if (i.ps) set.add(i.ps); }
  return [...set];
}
const oppoNames = cands('oppo', ['OPPO Sans 4.0', 'OPPOSans4.0', 'OPPO Sans 4.0 Regular', 'OPPO Sans 4.0 Bold']);
const notoNames = cands('noto', ['Noto Serif SC Bold', 'NotoSerifSC-Bold', 'Noto Serif SC', 'Noto Serif SC Regular', 'NotoSerifSC-Regular']);
const spec = {
  text: 'Hamburgefonstiv WAswitch 0123456789 你好世界中文字重',
  faces: [...oppoNames.map((n) => ({ font: 'oppo', src: `local("${n}")` })), ...notoNames.map((n) => ({ font: 'noto', src: `local("${n}")` }))],
  families: [...new Set([names.oppo.family, names.oppo.typo, names.noto.family, names.noto.typo, 'OPPO Sans 4.0', 'Noto Serif SC'].filter(Boolean))],
};

// ---- Electron 一直开着
const edir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
let eN = 0;
function startElectron(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fp-${tag}-`));
  const p = spawn(electronPath, [path.join(here, 'electron-main.js'), dir], { stdio: 'inherit' });
  return { dir, p, n: 0 };
}
async function waitFile(f, ms = 60000) { const t = Date.now(); while (!fs.existsSync(f)) { if (Date.now() - t > ms) throw new Error('timeout ' + f); await sleep(200); } await sleep(100); return fs.readFileSync(f, 'utf8'); }
async function eCheck(e) { const n = e.n++; fs.writeFileSync(path.join(e.dir, `cmd-${n}.json`), JSON.stringify(spec)); return JSON.parse(await waitFile(path.join(e.dir, `res-${n}.json`))); }
async function eQuit(e) { fs.writeFileSync(path.join(e.dir, `cmd-${e.n}.json`), JSON.stringify({ quit: true })); await sleep(1000); try { e.p.kill(); } catch {} }

async function bOpen(channel) { const b = await chromium.launch({ channel, headless: false }); const page = await b.newPage(); await page.goto('data:text/html,<!doctype html><meta charset=utf-8><body></body>'); return { b, page, ver: b.version() }; }
async function bCheck(o) {
  const same = await o.page.evaluate(`(${probeSrc})(${JSON.stringify(spec)})`);
  const p2 = await o.b.newPage(); await p2.goto('data:text/html,<!doctype html><meta charset=utf-8><body></body>');
  const fresh = await p2.evaluate(`(${probeSrc})(${JSON.stringify(spec)})`); await p2.close();
  return { samePage: same, newWindow: fresh };
}

function install() {
  const dir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts');
  fs.mkdirSync(dir, { recursive: true });
  const key = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
  for (const [src, base, reg] of [[oppoFile, 'OPPOSans4.0-4f58dbae.ttf', 'OPPO Sans 4.0 (TrueType)'], [notoFile, 'NotoSerifSC-050080d9.ttf', 'Noto Serif SC (TrueType)']]) {
    const dst = path.join(dir, base);
    fs.copyFileSync(src, dst);
    execFileSync('reg', ['add', key, '/v', reg, '/t', 'REG_SZ', '/d', dst, '/f'], { stdio: 'inherit' });
  }
}
function broadcast() {
  const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.UIntPtr w, System.IntPtr l, uint f, uint t, out System.UIntPtr r);'; $r=[System.UIntPtr]::Zero; [W.U]::SendMessageTimeout([System.IntPtr]0xffff, 0x001D, [System.UIntPtr]::Zero, [System.IntPtr]::Zero, 2, 2000, [ref]$r) | Out-Null; 'WM_FONTCHANGE sent'`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
}

function summarize(phase, who, r) {
  results[`${phase}/${who}`] = r;
  for (const kind of ['samePage', 'newWindow']) {
    const x = r[kind]; if (typeof x === 'string') { console.log(`[${phase}] ${who} ${kind}: ERROR ${x}`); continue; }
    const ok = x.faces.filter((f) => f.load === 'ok').map((f) => `${f.src}${f.w400 !== f.w700 ? ' [400≠700]' : ' [400=700]'} ${f.w400}/${f.w700}`);
    const fam = x.families.map((f) => `${f.fam}:${f.w400 === x.base.w400 ? 'fallback' : 'found'}${f.w400 !== f.w700 ? '[400≠700]' : '[400=700]'} ${f.w400}/${f.w700}`);
    console.log(`[${phase}] ${who} ${kind}: local ok = ${ok.length ? '\n    ' + ok.join('\n    ') : '(none)'}\n  family: ${fam.join(' | ')}  base ${x.base.w400}/${x.base.w700}`);
  }
}

log('start electron', electronPath);
const E1 = startElectron('e1');
console.log('electron chrome', await waitFile(path.join(E1.dir, 'ready')));
log('start chrome');
const C1 = await withTimeout(bOpen('chrome'), 90000, 'chrome'); console.log('chrome', C1.ver);
log('start edge');
const M1 = await withTimeout(bOpen('msedge'), 90000, 'edge'); console.log('edge', M1.ver);
const all = async (phase, list) => { for (const [who, fn] of list) { log('check', phase, who); try { summarize(phase, who, await withTimeout(fn(), 90000, phase + who)); } catch (e) { log('FAIL', phase, who, String(e)); } } };
await all('1-before', [['electron', () => eCheck(E1)], ['chrome', () => bCheck(C1)], ['edge', () => bCheck(M1)]]);
install();
await sleep(3000);
await all('2-after-install', [['electron', () => eCheck(E1)], ['chrome', () => bCheck(C1)], ['edge', () => bCheck(M1)]]);
await sleep(30000);
await all('3-after-30s', [['electron', () => eCheck(E1)], ['chrome', () => bCheck(C1)], ['edge', () => bCheck(M1)]]);
broadcast();
await sleep(3000);
await all('4-after-WM_FONTCHANGE', [['electron', () => eCheck(E1)], ['chrome', () => bCheck(C1)], ['edge', () => bCheck(M1)]]);
await eQuit(E1); await C1.b.close(); await M1.b.close();
const E2 = startElectron('e2'); await waitFile(path.join(E2.dir, 'ready'));
const C2 = await bOpen('chrome'); const M2 = await bOpen('msedge');
await all('5-restarted', [['electron', () => eCheck(E2)], ['chrome', () => bCheck(C2)], ['edge', () => bCheck(M2)]]);
await eQuit(E2); await C2.b.close(); await M2.b.close();
fs.writeFileSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'font-probe.json'), JSON.stringify(results, null, 1));
console.log('DONE');
process.exit(0);
