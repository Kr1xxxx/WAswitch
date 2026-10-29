// 每个账号的“设备环境”：浏览器标识（UA 和 Client Hints）、语言、时区。
// 只用 Electron / Chromium 的官方接口设置，不往 WhatsApp 页面注入脚本。
//
// 原则：
// - 浏览器版本跟随 Electron 实际内核版本，平台跟随本机系统，避免“声称的”和“实际的”对不上。
// - 时区跟随账号的地区，地区应与代理出口所在地一致（代理测试时可自动识别）。
// - 语言所有网页版账号统一用中文（shen 的决定，2026-10-24：团队要看得懂界面），不跟地区走。
// - 每个账号创建时生成一次，之后保持不变。
// - seed 字段为以后切换到独立指纹内核（fingerprint-chromium）预留，目前不使用。
//
// 已知局限：调试协议的覆盖只作用于页面本身，不作用于 Web Worker / Service Worker。
// Worker 里读到的时区仍是本机时区（UA 和语言请求头不受影响，因为会话层也设置了）。
const { presets: regions, isValidRegion, timezoneOf } = require('./regions');

// 所有网页版账号统一的界面语言
const UI_LOCALE = 'zh-CN';
const UI_LANGUAGES = ['zh-CN', 'zh', 'en'];
const UI_LANGUAGE_LABEL = '中文';

function hostOs() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function generate(region = 'auto') {
  return {
    version: 2,
    os: hostOs(),
    region: isValidRegion(region) ? region : 'auto',
    seed: Math.floor(Math.random() * 0xffffffff),
  };
}

// 老版本或手动改坏的数据，补齐缺失字段
function normalize(fp) {
  const base = generate();
  if (!fp || typeof fp !== 'object') return base;
  return {
    version: 2,
    os: ['win', 'mac', 'linux'].includes(fp.os) ? fp.os : base.os,
    region: isValidRegion(fp.region) ? fp.region : 'auto',
    seed: Number.isInteger(fp.seed) ? fp.seed : base.seed,
  };
}

function resolve(fp) {
  const full = process.versions.chrome;
  const major = full.split('.')[0];
  // 平台一律跟随本机，不用保存的值：账号数据拷到另一台系统不同的电脑上时，
  // 声称的平台和实际行为对不上反而容易被识别
  const osInfo = {
    win: { ua: 'Windows NT 10.0; Win64; x64', platform: 'Win32', chPlatform: 'Windows', chVersion: '10.0.0', arch: 'x86' },
    mac: { ua: 'Macintosh; Intel Mac OS X 10_15_7', platform: 'MacIntel', chPlatform: 'macOS', chVersion: '14.5.0', arch: process.arch === 'arm64' ? 'arm' : 'x86' },
    linux: { ua: 'X11; Linux x86_64', platform: 'Linux x86_64', chPlatform: 'Linux', chVersion: '6.5.0', arch: 'x86' },
  }[hostOs()];
  return {
    userAgent: `Mozilla/5.0 (${osInfo.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: osInfo.platform,
    // Chromium 会自己给请求头加上 q 权重，这里只给语言列表
    acceptLanguage: UI_LANGUAGES.join(','),
    timezone: timezoneOf(fp.region),
    locale: UI_LOCALE,
    metadata: {
      brands: [
        { brand: 'Google Chrome', version: major },
        { brand: 'Chromium', version: major },
        { brand: 'Not?A_Brand', version: '99' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: full },
        { brand: 'Chromium', version: full },
        { brand: 'Not?A_Brand', version: '99.0.0.0' },
      ],
      fullVersion: full,
      platform: osInfo.chPlatform,
      platformVersion: osInfo.chVersion,
      architecture: osInfo.arch,
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
  };
}

// 通过 Chrome 调试协议设置 UA、Client Hints、语言和时区。
// 必须在打开 WhatsApp 之前调用。
async function attach(wc, fp) {
  const r = resolve(fp);
  // 调试命令要等页面进程创建后才会生效，所以先打开一个空白页
  if (!wc.getURL()) await wc.loadURL('about:blank');
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const send = (method, params) => dbg.sendCommand(method, params).catch((e) => console.warn(method, e.message));
  await send('Emulation.setUserAgentOverride', {
    userAgent: r.userAgent,
    acceptLanguage: r.acceptLanguage,
    platform: r.platform,
    userAgentMetadata: r.metadata,
  });
  // 等空白页期间地区可能被改过（直连号跟随出口），发之前再读一次
  const tz = timezoneOf(fp.region);
  if (tz) await send('Emulation.setTimezoneOverride', { timezoneId: tz });
  if (r.locale) await send('Emulation.setLocaleOverride', { locale: r.locale });
  return r;
}

module.exports = { generate, normalize, resolve, attach, regions, UI_LANGUAGE_LABEL };
