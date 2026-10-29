// 隔离自检：逐个测试每个账号的代理出口，找出走真实 IP 的号、共用出口的号、时区和出口对不上的号。
// 还有自检里的“改成和出口一致”。从 main.js 拆出来，会变的状态通过 ctx 读，见 main.js 里的 ctx。
const { session } = require('electron');
const fingerprint = require('./fingerprint');
const proxy = require('./proxy');
const { isValidRegion, regionForTimezone, regionLabel } = require('./regions');

function setupCheckIpc(ctx) {
  const {
    handleShell, findAcc, isLite, visibleAccounts, views, problems, LITE_SCHEMES, WA_URL, webrtcPolicy,
    regionName, recordExit, saveAccounts, pushState, createView, destroyView, refresh, directTz,
  } = ctx;

  handleShell('check:run', async () => {
    const items = [];
    const list = visibleAccounts(); // 停着的号（被团队后台收回等）不运行、不显示，自检也不算它
    const byPort = new Map();
    const byIp = new Map();
    // 直连分两种：网页号跟随系统代理，轻量号用这台电脑的真实 IP。同一种直连的号一定是同一个出口 IP
    const directWeb = list.filter((a) => !proxy.parse(a.proxy) && !isLite(a)).map((a) => a.name);
    const directLite = list.filter((a) => !proxy.parse(a.proxy) && isLite(a)).map((a) => a.name);
    // 多个号直连是允许的，只提醒一句（黄色，不算出错）
    if (directWeb.length > 1) items.push({ level: 'warn', title: `${directWeb.join('、')} 都是直连`, detail: '这几个号都跟随系统代理，出口 IP 相同，在 WhatsApp 看来在同一个地方，有被关联的风险。' });
    if (directLite.length > 1) items.push({ level: 'warn', title: `${directLite.join('、')} 都是轻量直连`, detail: '这几个号都用这台电脑的真实 IP，在 WhatsApp 看来在同一个地方，有被关联的风险。' });
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 直连网页号的出口就是系统代理的出口，查一次大家共用
    const sysExit = directWeb.length ? await proxy.testSystem() : null;
    for (const acc of list) {
      const p = proxy.parse(acc.proxy);
      if (!p) {
        if (!isLite(acc) && directWeb.length < 2) items.push({ level: 'warn', title: `${acc.name}：直连`, detail: '没有设代理，跟随电脑的系统代理：Clash 开着系统代理时走 Clash 当前节点，关了就是这台电脑的真实 IP。' });
        if (!isLite(acc) && sysExit && sysExit.ok) {
          const effTz = fingerprint.resolve(acc.fingerprint).timezone || localTz;
          const fixRegion = regionForTimezone(sysExit.timezone);
          if (effTz !== sysExit.timezone) {
            items.push({
              level: 'warn',
              title: `${acc.name}：时区和出口对不上`,
              detail: `系统代理现在的出口在 ${sysExit.timezone} 时区，${fingerprint.resolve(acc.fingerprint).timezone ? `账号设的是 ${effTz}` : `时区跟随本机（${localTz}）`}，对不上。`,
              fix: fixRegion ? { id: acc.id, region: fixRegion, label: regionLabel(fixRegion) } : null,
            });
          }
        }
        if (isLite(acc) && directLite.length < 2) items.push({ level: 'warn', title: `${acc.name}：轻量直连`, detail: '没有设代理，不经过系统代理，用这台电脑的真实 IP（Clash 开 TUN 模式时走 Clash）。' });
        continue;
      }
      if (p.error) { items.push({ level: 'bad', title: `${acc.name}：代理设置有误`, detail: p.error }); continue; }
      const key = `${p.host}:${p.port}`;
      byPort.set(key, [...(byPort.get(key) || []), acc.name]);
      if (isLite(acc)) {
        if (!LITE_SCHEMES.includes(p.scheme)) items.push({ level: 'bad', title: `${acc.name}：轻量模式不支持这种代理`, detail: '请换成 socks5:// 或 http:// 开头的代理地址。' });
      } else {
        // 会话里的代理规则不能带“直连”兜底
        const rule = await session.fromPartition(`persist:wa-${acc.id}`).resolveProxy(WA_URL);
        if (/DIRECT/i.test(rule)) items.push({ level: 'bad', title: `${acc.name}：代理可能漏走本机网络`, detail: '请重启 WAswitch 后再检查。' });
      }
      const res = await proxy.test(acc.proxy, proxy.decryptPassword(acc.proxyPassword));
      if (!res.ok) { items.push({ level: 'bad', title: `${acc.name}：代理连不上`, detail: res.error, raw: res.detail || '' }); continue; }
      recordExit(acc, res.ip);
      acc.exitLabel = regionName(res.country);
      byIp.set(res.ip, [...(byIp.get(res.ip) || []), acc.name]);
      const tz = fingerprint.resolve(acc.fingerprint).timezone;
      const place = [acc.exitLabel, res.city].filter(Boolean).join(' ');
      // 轻量模式没有浏览器环境，不涉及时区
      if (isLite(acc)) { items.push({ level: 'ok', title: `${acc.name}（轻量模式）：IP ${res.ip}（${place}）` }); continue; }
      // 跟随本机时，实际时区就是本机时区
      const effTz = tz || localTz;
      const fixRegion = regionForTimezone(res.timezone);
      const fix = fixRegion ? { id: acc.id, region: fixRegion, label: regionLabel(fixRegion) } : null;
      if (effTz !== res.timezone) {
        items.push({
          level: 'warn',
          title: `${acc.name}：IP ${res.ip}（${place}）`,
          detail: tz
            ? `IP 在 ${res.timezone} 时区，账号设的是 ${tz}，对不上。${fix ? '' : '请在编辑账号里选一个最接近的地区。'}`
            : `时区跟随本机（${localTz}），但 IP 在 ${res.timezone}，对不上。${fix ? '' : '请在编辑账号里选一个最接近的地区。'}`,
          fix,
        });
      } else {
        items.push({ level: 'ok', title: `${acc.name}：IP ${res.ip}（${place}）`, detail: '时区和 IP 一致。' });
      }
    }
    for (const [key, names] of byPort) {
      if (names.length > 1) items.push({ level: 'bad', title: `${names.join('、')} 共用同一个代理端口`, detail: `${key}。它们会用同一个 IP，建议每个号一个端口。` });
    }
    for (const [ip, names] of byIp) {
      if (names.length > 1) items.push({ level: 'bad', title: `${names.join('、')} 的出口 IP 相同`, detail: `${ip}。在 WhatsApp 看来这几个号在同一个地方。` });
    }
    // 只看走代理的轻量号（直连的轻量号在另一个进程里，上面已经算进直连号）
    if (list.some((a) => isLite(a) && proxy.parse(a.proxy))) {
      items.push(ctx.liteGuardHits
        ? { level: 'bad', title: `轻量模式：拦下了 ${ctx.liteGuardHits} 次绕过代理的连接`, detail: '没有发出去，本机 IP 没暴露。日志里记着拦下的是哪些连接。', logs: true }
        : { level: 'ok', title: '轻量模式：都走代理，没有漏' });
    }
    // WebRTC：走代理的号必须只走代理；直连号按“允许通话”开关分别显示
    const webrtcBad = list.filter((a) => !isLite(a) && views.has(a.id) && views.get(a.id).webContents.getWebRTCIPHandlingPolicy() !== webrtcPolicy(a));
    const proxied = list.filter((a) => !isLite(a) && a.proxy);
    if (webrtcBad.length) items.push({ level: 'bad', title: `${webrtcBad.map((a) => a.name).join('、')}：通话的网络设置没生效`, detail: '请重启 WAswitch 后再检查。' });
    else if (proxied.length) items.push({ level: 'ok', title: '走代理的号：通话也走代理，不暴露本机 IP' });
    for (const a of list.filter((x) => !isLite(x) && !x.proxy && x.allowCalls)) {
      items.push({ level: 'warn', title: `${a.name}：允许通话（直连）`, detail: '通话会用本机 IP，可能和聊天的 IP 不一样。不打电话就在编辑账号里关掉。' });
    }
    const uaOk = list.every((a) => !/Electron|waswitch/i.test(fingerprint.resolve(a.fingerprint).userAgent));
    items.push({ level: uaOk ? 'ok' : 'bad', title: '浏览器标识正常，看不出是多开软件' });
    saveAccounts();
    pushState();
    return { items, time: new Date().toLocaleString('zh-CN') };
  });

  // 隔离自检里的“改成和出口一致”：只改地区（时区），然后重建页面
  handleShell('check:fix', async ({ id, region } = {}) => {
    const acc = findAcc(id);
    if (!acc || isLite(acc) || !isValidRegion(region) || region === 'auto') return { error: '改不了' };
    if (acc.fingerprint.region === region) return { ok: true };
    // 直连网页号和后台跟随出口走同一条路：页面不重开，直接换时区
    if (!proxy.parse(acc.proxy)) {
      await directTz.apply(acc, region);
      saveAccounts();
      refresh();
      return { ok: true };
    }
    acc.fingerprint.region = region;
    saveAccounts();
    destroyView(acc.id);
    problems.delete(acc.id);
    await createView(acc);
    refresh();
    return { ok: true, reloaded: true };
  });
}

module.exports = { setupCheckIpc };
