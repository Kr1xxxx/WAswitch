// 试验第二轮：装字体前已开着的页面（同一个 http 源）装完后：原页面、刷新、同源新标签、别的源新标签；
// 以及 @font-face 的 font-weight 描述符怎么写，local() 才拿得到 400 和 700
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const electronPath = require('electron');
const [oppoFile, notoFile] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const probeSrc = fs.readFileSync(path.join(here, 'probe.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - T0) / 1000).toFixed(1)}s`, ...a);
setTimeout(() => { log('WATCHDOG'); process.exit(1); }, 7 * 60 * 1000).unref();
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + what)), ms))]);

const faces = [];
for (const n of ['OPPO Sans 4.0 Regular', 'OPPO Sans 4.0 Bold', 'OPPO Sans 4.0', 'OPPOSans40']) for (const w of ['100 700', '400', '700', '']) faces.push({ font: 'oppo', src: `local("${n}")`, weight: w });
for (const n of ['Noto Serif SC', 'Noto Serif SC Regular', 'Noto Serif SC Bold', 'NotoSerifSC-Regular', 'NotoSerifSC-Bold']) for (const w of ['200 900', '400', '700', '']) faces.push({ font: 'noto', src: `local("${n}")`, weight: w });
// 网页实际会写的：两个 face 分别对应 400 和 700
const spec = { text: 'Hamburgefonstiv WAswitch 0123456789 你好世界中文字重', faces, families: ['OPPO Sans 4.0', 'Noto Serif SC'] };
const quick = { ...spec, faces: [{ font: 'oppo', src: 'local("OPPO Sans 4.0 Regular")', weight: '100 700' }, { font: 'noto', src: 'local("Noto Serif SC")', weight: '200 900' }] };

const page = '<!doctype html><meta charset=utf-8><body></body>';
const mk = () => new Promise((r) => { const s = http.createServer((q, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page); }).listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}/`)); });
const originA = await mk();
const originB = (await mk()).replace('127.0.0.1', 'localhost');

function short(x) {
  if (typeof x === 'string') return 'ERROR ' + x;
  const ok = x.faces.filter((f) => f.load === 'ok');
  const fam = x.families.map((f) => `${f.fam}:${f.w400 === x.base.w400 ? 'fallback' : 'found'}`).join(',');
  return `${ok.length}/${x.faces.length} local ok; ${fam}`;
}
function full(x) {
  for (const f of x.faces) console.log(`    ${f.src} desc=${f.desc}: ${f.load}${f.load === 'ok' ? ` 400=${f.w400} 700=${f.w700}${f.w400 !== f.w700 ? ' DIFF' : ' SAME'}` : ''}`);
  for (const f of x.families) console.log(`    family ${f.fam}: 400=${f.w400} 700=${f.w700} (fallback ${x.base.w400})`);
}

// Electron：一直开着，按命令在原窗口、刷新后、新窗口里量
const edir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
fs.writeFileSync(path.join(edir, 'url'), originA);
const ep = spawn(electronPath, [path.join(here, 'electron-main2.js'), edir], { stdio: 'inherit' });
let en = 0;
async function waitFile(f, ms = 60000) { const t = Date.now(); while (!fs.existsSync(f)) { if (Date.now() - t > ms) throw new Error('timeout ' + f); await sleep(200); } await sleep(100); return fs.readFileSync(f, 'utf8'); }
async function eCmd(mode, sp) { const n = en++; fs.writeFileSync(path.join(edir, `cmd-${n}.json`), JSON.stringify({ mode, spec: sp })); return JSON.parse(await waitFile(path.join(edir, `res-${n}.json`))); }
await waitFile(path.join(edir, 'ready'));

const C = await chromium.launch({ channel: 'chrome', headless: false });
const cp = await C.newPage(); await cp.goto(originA);
const ev = (p, sp) => p.evaluate(`(${probeSrc})(${JSON.stringify(sp)})`);
log('before: chrome', short(await ev(cp, quick)), '| electron', short(await eCmd('same', quick)));

const dir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts');
fs.mkdirSync(dir, { recursive: true });
const key = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
for (const [src, base, reg] of [[oppoFile, 'OPPOSans4.0-4f58dbaeaea7.ttf', 'OPPO Sans 4.0 (TrueType)'], [notoFile, 'NotoSerifSC-050080d9255a.ttf', 'Noto Serif SC (TrueType)']]) {
  fs.copyFileSync(src, path.join(dir, base));
  execFileSync('reg', ['add', key, '/v', reg, '/t', 'REG_SZ', '/d', path.join(dir, base), '/f']);
}
log('installed');
await sleep(3000);
log('chrome same page', short(await ev(cp, quick)));
await cp.reload(); log('chrome same page after reload', short(await ev(cp, quick)));
const cp2 = await C.newPage(); await cp2.goto(originA); log('chrome new tab same origin', short(await ev(cp2, quick)));
const cp3 = await C.newPage(); await cp3.goto(originB); log('chrome new tab other origin', short(await ev(cp3, quick)));
await cp3.reload(); log('chrome other origin reload', short(await ev(cp3, quick)));
await cp.goto(originB); log('chrome old tab navigate to other origin', short(await ev(cp, quick)));
await cp2.close(); await cp3.close();
const cp4 = await C.newPage(); await cp4.goto(originA); log('chrome new tab same origin after closing others', short(await ev(cp4, quick)));
log('electron same', short(await eCmd('same', quick)));
log('electron reload', short(await eCmd('reload', quick)));
log('electron new window', short(await eCmd('new', quick)));
// 描述符细节，在认得字体的新标签里量
const cp5 = await C.newPage(); await cp5.goto(originB);
log('descriptor details (chrome, fresh tab):'); full(await ev(cp5, spec));
fs.writeFileSync(path.join(edir, `cmd-${en}.json`), JSON.stringify({ mode: 'quit' }));
await C.close();
log('DONE');
process.exit(0);
