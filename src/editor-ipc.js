// 编辑账号页（新建和修改共用）的接口：读表单、查本机代理端口、测试代理、保存。
// 从 main.js 拆出来。会变的界面状态（accounts、page、activeId 等）通过 ctx 读写，见 main.js 里的 ctx。
const { dialog, safeStorage } = require('electron');
const fingerprint = require('./fingerprint');
const proxy = require('./proxy');
const ports = require('./ports');
const { isValidRegion, regionForTimezone, regionLabel } = require('./regions');
const { canEncrypt } = require('./secure-storage');
const { newAccountId } = require('./account-id');

function setupEditorIpc(ctx) {
  const {
    handleShell, findAcc, isParked, isLite, visibleAccounts, nextName, nextColor, cleanNote, cleanPhone, applyPhone,
    COLORS, LITE_SCHEMES, newLiteKey, regionName, exitIps, exitChanges, recordExit, problems,
    saveAccounts, startAccount, startLite, createView, destroyView, refresh, notifier,
  } = ctx;
  let lastTest = null; // 编辑页最近一次测试的结果，保存时记下出口所在地

  handleShell('editor:load', (id) => {
    const acc = findAcc(id);
    return {
      id: acc ? acc.id : null,
      isNew: !acc,
      name: acc ? acc.name : String(ctx.editorPrefill?.name || nextName()).slice(0, 40),
      note: acc ? acc.note : '',
      phone: acc ? acc.phone : '',
      color: acc ? acc.color : ctx.editorColor || nextColor(),
      proxy: acc ? acc.proxy : '',
      hasPassword: !!(acc && acc.proxyPassword),
      region: acc ? acc.fingerprint.region : (fingerprint.regions[ctx.editorPrefill?.region] ? ctx.editorPrefill.region : 'auto'),
      regions: Object.entries(fingerprint.regions).map(([key, v]) => ({ key, label: v.label })),
      regionLabel: acc ? regionLabel(acc.fingerprint.region) : '',
      uiLanguage: fingerprint.UI_LANGUAGE_LABEL,
      mode: acc ? acc.mode : 'web',
      allowCalls: !!(acc && acc.allowCalls),
      // 新账号：还没有主号时默认就是主号
      primary: acc ? acc.primary : !ctx.accounts.some((a) => a.primary),
      primaryName: ctx.accounts.find((a) => a.primary && a.id !== id)?.name || '',
      // 别的直连号（编辑页选直连时提醒一句同一出口 IP）
      otherDirect: visibleAccounts().filter((a) => a.id !== id && !a.proxy).map((a) => a.name),
      liteAvailable: canEncrypt(safeStorage),
      platform: process.platform,
    };
  });

  // 编辑页的代理预设：本机 7890–7899 哪些端口开着、能不能用、被哪个号占了
  handleShell('editor:ports', async (id) => {
    const list = await ports.probeAll();
    const used = ports.usage(ctx.accounts.filter((a) => !isParked(a)), id);
    return list.map((p) => ({ ...p, usedBy: used[p.port] || [] }));
  });

  // 主号的出口 IP（轻量小号不能和主号用同一个 IP）。主号没设代理时查本机直连的出口。
  async function primaryExit(exceptId) {
    const primary = ctx.accounts.find((a) => a.primary && a.id !== exceptId);
    if (!primary) return { ip: null };
    if (primary.proxy && exitIps.has(primary.id)) return { ip: exitIps.get(primary.id), name: primary.name };
    const res = primary.proxy ? await proxy.test(primary.proxy, proxy.decryptPassword(primary.proxyPassword)) : await proxy.testDirect();
    if (!res.ok) return { error: `查不到主号「${primary.name}」的出口 IP（${res.error}），没法确认这个号和主号不在同一个 IP，暂时不能保存。请确认主号的网络正常后再试。` };
    if (primary.proxy) recordExit(primary, res.ip);
    return { ip: res.ip, name: primary.name };
  }

  // 测试代理：返回出口 IP、所在地、时区，给出匹配的地区，并提示和别的账号出口相同
  handleShell('editor:test', async ({ id, proxy: proxyText, password } = {}) => {
    const acc = findAcc(id);
    const pass = proxy.passwordFor(acc ? acc.proxy : '', acc ? acc.proxyPassword : '', String(proxyText || ''), password);
    const res = await proxy.test(String(proxyText || ''), pass);
    if (!res.ok) return res;
    res.region = regionForTimezone(res.timezone);
    if (res.region) res.regionLabel = regionLabel(res.region);
    res.country = regionName(res.country);
    const same = ctx.accounts.find((a) => a.id !== id && exitIps.get(a.id) === res.ip);
    const before = same ? null : ctx.accounts.find((a) => a.id !== id && a.lastExit && a.lastExit.ip === res.ip);
    if (same) res.sameAs = same.name;
    else if (before) { res.sameAs = before.name; res.sameAt = before.lastExit.at; }
    lastTest = { proxy: proxy.parse(proxyText)?.rules, ip: res.ip, label: res.country, region: res.region };
    return res;
  });

  handleShell('editor:save', async ({ id, name, note, phone, color, proxy: proxyText, password, region, mode, primary, liteConfirm, allowCalls } = {}) => {
    name = String(name || '').trim().slice(0, 40);
    note = cleanNote(note);
    phone = cleanPhone(phone);
    if (!name) return { error: '请填写名称' };
    if (!COLORS.includes(color)) color = nextColor();
    const parsed = proxy.parse(String(proxyText || ''));
    if (parsed && parsed.error) return { error: parsed.error };
    if (!isValidRegion(region)) region = 'auto';
    const proxyStored = parsed ? parsed.display : '';
    // 允许通话只对网页版直连号有意义
    const callsWanted = allowCalls === true && !parsed && mode !== 'lite';
    let acc = findAcc(id);
    // 模式只在添加时选，之后不能改（换模式等于换一台关联设备）
    mode = acc ? acc.mode : (mode === 'lite' ? 'lite' : 'web');
    // 主号只能在别的账号里勾选来更换，不能直接取消
    const wantPrimary = mode === 'web' && (primary === true || !!(acc && acc.primary) || !ctx.accounts.some((a) => a.primary && a.id !== id));
    const testedNow = lastTest && parsed && lastTest.proxy === parsed.rules ? lastTest : null;
    if (mode === 'lite') {
      if (primary === true) return { error: '主号只能用网页版，不能用轻量模式' };
      if (!acc && liteConfirm !== true) return { error: '请先勾选下面的风险确认' };
      // 直连可以（用户自己选，编辑页有风险提示）；设了代理就要测试通过、出口不能和主号相同
      if (parsed && !LITE_SCHEMES.includes(parsed.scheme)) return { error: '轻量模式只支持 socks5 和 http 代理' };
      const proxyChanged = !acc || acc.proxy !== proxyStored || !!String(password || '');
      if (parsed && proxyChanged) {
        if (!testedNow) return { error: '请先点“测试”，代理测试通过后才能保存' };
        const pe = await primaryExit(id);
        if (pe.error) return { error: pe.error };
        if (pe.ip && pe.ip === testedNow.ip) return { error: `这个代理的出口 IP（${testedNow.ip}）和主号「${pe.name}」相同。轻量小号必须和主号用不同的 IP，请换一个代理端口或节点。` };
      }
    }

    // 后台分来的号第一次保存：填了代理必须测试通过；不填就是直连（编辑页有一行风险提示，不拦）
    if (acc && acc.teamNeedsProxy && mode === 'web' && parsed && !testedNow) return { error: '请先点“测试”，代理测试通过后才能保存' };

    // 密码：新填的优先；地址里带的其次；都没有时，只有主机、端口、用户名都没变才保留原来的，否则清掉
    const plan = proxy.passwordPlan(acc ? acc.proxy : '', String(proxyText || ''), password);
    let encPassword = plan.kind === 'old' ? acc.proxyPassword : '';
    try {
      if (plan.kind === 'new') encPassword = proxy.encryptPassword(plan.password);
    } catch (e) {
      return { error: e.message };
    }
    // 测试过的出口所在地显示在侧栏
    let tested = lastTest && parsed && lastTest.proxy === parsed.rules ? lastTest : null;
    // 网页版选了“跟随本机”又设了代理：没测过就先测一次，按出口所在地填好时区。
    // 测不通也照样保存；用户自己选了地区的不改
    if (mode === 'web' && parsed && region === 'auto') {
      if (!tested) {
        const res = await proxy.test(String(proxyText || ''), proxy.passwordFor(acc ? acc.proxy : '', acc ? acc.proxyPassword : '', String(proxyText || ''), password));
        if (res.ok) tested = { proxy: parsed.rules, ip: res.ip, label: regionName(res.country), region: regionForTimezone(res.timezone) };
      }
      if (tested && tested.region) region = tested.region;
    }

    let liteKey = '';
    if (mode === 'lite' && !acc) {
      try { liteKey = newLiteKey(); } catch (e) { return { error: e.message }; }
    }
    // 换了主号、或主号换了代理：轻量小号只在保存时和主号比过出口，提醒跑一次隔离自检
    const oldPrimary = ctx.accounts.find((a) => a.primary);
    const primaryMoved = wantPrimary && oldPrimary && oldPrimary.id !== id;
    const primaryProxyChanged = wantPrimary && acc && acc.primary && acc.proxy !== proxyStored;
    const remindCheck = (primaryMoved || primaryProxyChanged) && ctx.accounts.some(isLite);
    if (wantPrimary) for (const a of ctx.accounts) if (a.id !== id) a.primary = false;

    const teamFirstSave = !!(acc && acc.teamNeedsProxy);
    if (teamFirstSave) { acc.teamNeedsProxy = false; problems.delete(acc.id); }
    if (!acc) {
      acc = { id: newAccountId(ctx.accounts), name, note, phone, phoneManual: !!phone, color, proxy: proxyStored, proxyPassword: encPassword, exitLabel: tested ? tested.label : '', fingerprint: fingerprint.generate(region), muted: false, mode, primary: wantPrimary, liteKey, loggedIn: false, allowCalls: callsWanted };
      ctx.accounts.push(acc);
      if (tested) recordExit(acc, tested.ip);
      saveAccounts();
      ctx.page = 'account';
      ctx.activeId = acc.id;
      await startAccount(acc);
      refresh();
    } else if (isLite(acc)) {
      const changed = acc.proxy !== proxyStored || acc.proxyPassword !== encPassword;
      if (acc.proxy !== proxyStored) { acc.exitLabel = ''; acc.lastExit = null; exitIps.delete(acc.id); exitChanges.delete(acc.id); }
      if (tested) { acc.exitLabel = tested.label; recordExit(acc, tested.ip); }
      acc.name = name;
      acc.note = note;
      applyPhone(acc, phone);
      acc.color = color;
      acc.proxy = proxyStored;
      acc.proxyPassword = encPassword;
      saveAccounts();
      ctx.page = 'account';
      ctx.activeId = acc.id;
      if (changed || teamFirstSave) { problems.delete(acc.id); startLite(acc); }
      refresh();
    } else {
      acc.primary = wantPrimary;
      const changed = acc.proxy !== proxyStored || acc.proxyPassword !== encPassword || acc.fingerprint.region !== region || acc.allowCalls !== callsWanted;
      acc.allowCalls = callsWanted;
      if (acc.proxy !== proxyStored) { acc.exitLabel = ''; acc.lastExit = null; exitIps.delete(acc.id); exitChanges.delete(acc.id); }
      if (tested) { acc.exitLabel = tested.label; recordExit(acc, tested.ip); }
      acc.name = name;
      acc.note = note;
      applyPhone(acc, phone);
      acc.color = color;
      acc.proxy = proxyStored;
      acc.proxyPassword = encPassword;
      // 只改地区（时区），浏览器标识保持不变
      acc.fingerprint.region = region;
      saveAccounts();
      ctx.page = 'account';
      ctx.activeId = acc.id;
      if (changed || teamFirstSave) {
        destroyView(acc.id);
        problems.delete(acc.id);
        await createView(acc);
      }
      refresh();
    }
    notifier.refresh();
    if (remindCheck) {
      dialog.showMessageBox(ctx.win, {
        type: 'info',
        title: '请跑一次隔离自检',
        message: primaryMoved ? '主号已更换' : '主号的代理已修改',
        detail: '轻量小号只在保存时和主号比较过出口 IP。请到 设置 › 隔离自检 跑一次，确认小号和主号不在同一个 IP。',
      }).catch(() => {});
    }
    return { ok: true };
  });

  return {
    resetTest() { lastTest = null; }, // 打开编辑页时清掉上一次的测试结果
  };
}

module.exports = { setupEditorIpc };
