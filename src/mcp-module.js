// MCP 接口是单独下载的模块，安装包里不带它的代码。
//
// 发版时 CI 先把 src/mcp 和它用的库打成一个文件（scripts/build-mcp.js），把文件名和 sha512 写进
// src/mcp-module.json，再打安装包。所以下载来的文件和安装包本身一样可信：对不上就删掉、不加载。
//
// 用户在 设置 › AI 接口 点“下载”：直连 GitHub（和自动更新一样，只认 GitHub 的下载域名），
// 下到 <userData>/modules/mcp/waswitch-mcp.js（文件名固定，Claude Desktop 配一次就不用改），
// 每次加载前再校验一次。第一次下载后 MCP 是关着的，要用户自己打开开关。
// 软件更新后版本对不上：下载过的电脑自动在后台下配套的新文件，开关状态不变。
// 卸载：关掉 MCP、断开客户端、删文件和 token；各项开关设置保留。
// 开发版（从源码运行，没有 mcp-module.json）直接用仓库里的 src/mcp，不下载。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { finished } = require('stream/promises');
const { writeJsonAtomic } = require('./atomic');
const errtext = require('./errtext');

const FILE = 'waswitch-mcp.js';
const INFO = 'installed.json';
const BRIDGE_ARG = '--waswitch-mcp-bridge';
const MAX_BYTES = 30 * 1024 * 1024;
const AUTO_RETRY_MS = 30 * 60 * 1000; // 软件更新后自动下载失败：过这么久再试

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('base64'))).on('error', reject);
  });
}

// 下载失败的原因说人话；自己写的中文原样用
function downloadErrorText(e) {
  if (e?.code === 'ENOSPC') return '磁盘空间不足，请腾出空间后重试';
  if (['EACCES', 'EPERM', 'EROFS'].includes(e?.code)) return '无法写入模块文件夹，请检查权限后重试';
  if (['EISDIR', 'ENOTDIR', 'ENOENT', 'EEXIST', 'EIO'].includes(e?.code)) return '无法写入模块文件，请检查存储路径和磁盘后重试';
  const raw = errtext.rawOf(e) || String(e && e.message || e);
  if (errtext.hasChinese(raw)) return raw;
  const status = Number(e && e.statusCode) || 0;
  if (status === 404) return '找不到 MCP 文件，这个版本可能还在发布中，过几分钟再试';
  if (status === 403 || status === 429) return 'GitHub 暂时限制了访问，过一会儿再试';
  if (status >= 500) return 'GitHub 那边暂时出错，过一会儿再试';
  return `连不上 GitHub（${errtext.netReason(raw)}）`;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// 安装包里带的 MCP 文件信息；开发版没有
function loadExpected(file) {
  const e = readJson(file);
  return e && typeof e.file === 'string' && typeof e.sha512 === 'string' && /^waswitch-mcp-[\w.-]+\.js$/.test(e.file) ? e : null;
}

class McpModule {
  // opts:
  //   dir        下载到哪（<userData>/modules/mcp）
  //   dataDir    userData（mcp.json、mcp-token.json 在这里）
  //   expected   { version, file, sha512, size } | null
  //   dev        true：没有 expected 时用仓库里的 src/mcp
  //   fetch(url, { onData, signal, maxBytes })   直连下载（updater.request）
  //   start(setupMcp, { uiDir, bridgeArgs }) -> Promise<mcp>   创建并 init，返回 setupMcp 的结果
  //   stopped()  卸载后通知主程序（把 mcp 变量清空）
  //   onChange() 状态变了（刷新设置页）
  //   loadDev()  返回仓库里的 { setupMcp }
  //   execPath   process.execPath（桥接用）
  //   uiDir      MCP 设置窗口的页面所在目录
  //   log(msg)
  constructor(opts) {
    this.o = opts;
    this.file = path.join(opts.dir, FILE);
    this.infoFile = path.join(opts.dir, INFO);
    this.mcp = null;
    this.status = opts.expected ? 'none' : opts.dev ? 'dev' : 'unavailable';
    this.percent = 0;
    this.error = '';
    this.updating = false; // 软件更新后在补下配套的新文件
    this.abort = null;
    this.retryTimer = null;
    this.sig = '';
    // 设置页刷新很频繁，这两个只在启动和下载、卸载时读盘
    this.hasInstalled = !!this.installedInfo();
    const s = readJson(path.join(opts.dataDir, 'mcp.json'));
    this.wasEnabled = !!(s && s.enabled === true);
  }

  installedInfo() { return readJson(this.infoFile); }

  // 之前开着 MCP、但这台电脑还没下载过模块（从带 MCP 的旧版本升级上来）
  legacy() {
    return this.status === 'none' && !this.hasInstalled && this.wasEnabled;
  }

  view() {
    const st = this.mcp ? this.mcp.controller.status() : null;
    return {
      status: this.status,
      percent: this.percent,
      error: this.error,
      updating: this.updating,
      legacy: this.legacy(),
      installed: this.hasInstalled,
      version: this.o.expected ? this.o.expected.version : '',
      sizeMB: this.o.expected && this.o.expected.size ? Math.max(0.1, Math.round((this.o.expected.size / 1048576) * 10) / 10) : 0,
      enabled: !!(st && st.enabled),
      running: !!(st && st.running),
      url: st ? st.url : '',
      runError: st ? st.error : '',
    };
  }

  changed() { try { this.o.onChange(); } catch { /* 设置页还没准备好 */ } }

  // MCP 自己的状态变了（开关、运行、出错）才刷新设置页；客户端每次调用不刷新
  tick() {
    const v = this.view();
    const sig = `${v.enabled}|${v.running}|${v.runError}`;
    if (sig !== this.sig) { this.sig = sig; this.changed(); }
  }

  // 软件启动时调用
  // 开关是开着的才在启动时加载 MCP 代码；关着时不加载，不占内存（打开开关或详细设置时再加载）
  configEnabled() {
    const c = readJson(path.join(this.o.dataDir, 'mcp.json'));
    return !!(c && c.enabled === true);
  }

  async init() {
    if (this.status === 'dev') { if (this.configEnabled()) await this.ensureLoaded(); return; }
    if (this.status === 'unavailable') return;
    const info = this.installedInfo();
    if (!info) return; // 没下载过
    if (info.sha512 === this.o.expected.sha512 && fs.existsSync(this.file)) {
      this.status = 'ready';
      if (!this.configEnabled()) return;
      try { await this.load(); return; } catch (e) { this.o.log?.(`MCP 模块加载失败：${e.message}`); }
    }
    // 下载过，但版本对不上（软件更新了）或文件坏了：自动补下
    this.status = 'none';
    this.updating = true;
    this.download().catch(() => {});
  }

  // 用到时才加载（打开开关、打开详细设置）。本地文件坏了：报错，点“重试”重新下载
  async ensureLoaded() {
    if (this.mcp) return true;
    try {
      if (this.status === 'dev') await this.startWith(this.o.loadDev(), [path.join(this.o.appDir, 'bin', 'waswitch-mcp.js')]);
      else if (this.status === 'ready') await this.load();
      else return false;
      return true;
    } catch (e) {
      this.status = 'error';
      this.error = e.message || String(e);
      this.o.log?.(`MCP 模块加载失败：${this.error}`);
      this.changed();
      return false;
    }
  }

  async download() {
    if (!this.o.expected || this.status === 'downloading' || this.status === 'ready' || this.status === 'dev') return this.view();
    clearTimeout(this.retryTimer);
    const fresh = !this.installedInfo();
    const { expected } = this.o;
    const url = `https://github.com/${this.o.owner}/${this.o.repo}/releases/download/v${expected.version}/${expected.file}`;
    this.status = 'downloading';
    this.percent = 0;
    this.error = '';
    this.abort = new AbortController();
    this.changed();
    const part = `${this.file}.part`;
    let out;
    let completed;
    const hash = crypto.createHash('sha512');
    let lastPush = 0;
    try {
      fs.mkdirSync(this.o.dir, { recursive: true });
      out = fs.createWriteStream(part);
      completed = finished(out);
      await Promise.race([completed, this.o.fetch(url, {
        signal: this.abort.signal,
        maxBytes: MAX_BYTES,
        onData: (chunk, got, total) => {
          out.write(chunk);
          hash.update(chunk);
          const t = total || expected.size || 0;
          this.percent = t ? Math.min(99, Math.floor((got / t) * 100)) : 0;
          if (Date.now() - lastPush > 200) { lastPush = Date.now(); this.changed(); }
        },
      })]);
      out.end();
      await completed;
      if (hash.digest('base64') !== expected.sha512) throw new Error('下载的文件校验不通过（sha512 不一致），已删除');
      fs.renameSync(part, this.file);
      // 第一次下载：开关一律从关开始，要用户自己打开（旧版本开着的也一样）
      if (fresh) this.resetEnabled();
      writeJsonAtomic(this.infoFile, { version: expected.version, sha512: expected.sha512, at: Date.now() }, 2);
      this.hasInstalled = true;
      this.percent = 100;
      // 软件更新后补下的：原来开着就接着开；第一次下载的开关是关的，先不加载
      if (this.configEnabled()) await this.load();
      else this.status = 'ready';
      this.updating = false;
      this.o.log?.(`MCP 模块 ${expected.version} 已下载`);
    } catch (e) {
      this.abort.abort();
      if (out) out.destroy();
      if (completed) await completed.catch(() => {});
      try { fs.unlinkSync(part); } catch { /* 没写出来 */ }
      this.status = 'none';
      this.percent = 0;
      if (!e.cancelled) {
        this.status = 'error';
        this.error = `没下载成功：${downloadErrorText(e)}`;
        this.o.log?.(`MCP 模块下载失败：${this.error}（${errtext.rawOf(e) || e.message}）`);
        if (this.updating) {
          this.retryTimer = setTimeout(() => this.download().catch(() => {}), AUTO_RETRY_MS);
          this.retryTimer.unref?.();
        }
      }
    } finally {
      this.abort = null;
      this.changed();
    }
    return this.view();
  }

  cancel() {
    if (this.abort) this.abort.abort();
    return this.view();
  }

  // 校验后加载
  async load() {
    const got = await sha512File(this.file);
    if (got !== this.o.expected.sha512) {
      try { fs.unlinkSync(this.file); } catch { /* 已经没了 */ }
      throw new Error('MCP 文件校验不通过，已删除');
    }
    delete require.cache[require.resolve(this.file)];
    const mod = require(this.file);
    if (typeof mod.setupMcp !== 'function') throw new Error('MCP 文件内容不对');
    await this.startWith(mod, [this.file, BRIDGE_ARG]);
  }

  async startWith(mod, bridgeArgs) {
    this.mcp = await this.o.start(mod.setupMcp, { uiDir: this.o.uiDir, bridgeArgs });
    if (this.status !== 'dev') this.status = 'ready';
    this.error = '';
    this.changed();
  }

  async setEnabled(on) {
    if (on) await this.ensureLoaded();
    if (this.mcp) await this.mcp.controller.setEnabled(!!on);
    return this.view();
  }

  // 能不能打开详细设置（托盘菜单用）
  available() { return this.status === 'ready' || this.status === 'dev'; }

  async openSettings() {
    if (await this.ensureLoaded()) this.mcp.openSettings();
  }

  resetEnabled() {
    this.wasEnabled = false;
    const file = path.join(this.o.dataDir, 'mcp.json');
    const s = readJson(file);
    if (s && s.enabled) writeJsonAtomic(file, { ...s, enabled: false }, 2);
  }

  async uninstall() {
    if (this.status === 'dev' || this.status === 'unavailable') return this.view();
    this.cancel();
    clearTimeout(this.retryTimer);
    if (this.mcp) {
      const m = this.mcp;
      this.mcp = null;
      try { await m.dispose(); } catch (e) { this.o.log?.(`MCP 关闭出错：${e.message}`); }
      this.o.stopped?.();
    }
    try { delete require.cache[require.resolve(this.file)]; } catch { /* 没加载过 */ }
    this.resetEnabled();
    for (const f of [this.file, `${this.file}.part`, this.infoFile, path.join(this.o.dataDir, 'mcp-token.json')]) {
      try { fs.unlinkSync(f); } catch { /* 本来就没有 */ }
    }
    this.hasInstalled = false;
    this.status = 'none';
    this.updating = false;
    this.error = '';
    this.percent = 0;
    this.changed();
    return this.view();
  }

  async close() {
    this.cancel();
    clearTimeout(this.retryTimer);
    if (this.mcp) await this.mcp.close();
  }
}

module.exports = { McpModule, loadExpected, sha512File, FILE, BRIDGE_ARG };
