// 编辑账号页（新建和修改共用）的接口：读表单、查本机代理端口、测试代理、保存。
// 从 main.js 拆出来。会变的界面状态（accounts、page、activeId 等）通过 ctx 读写，见 main.js 里的 ctx。
const { safeStorage } = require('electron');
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
      // 别的直连号（编辑页选直连时提醒一句同一出口 IP）：网页版跟随系统代理，轻量版用真实 IP，分开算
      otherDirect: visibleAccounts().filter((a) => a.id !== id && !a.proxy && !isLite(a)).map((a) => a.name),
      otherLiteDirect: visibleAccounts().filter((a) => a.id !== id && !a.proxy && isLite(a)).map((a) => a.name),
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

  // 主号的出口 IP（轻量小号不能和主号用同一个 IP）。主号没设代理时跟随系统代理，按系统代理查。
  async function primaryExit(exceptId) {
    const primary = ctx.accounts.find((a) => a.primary && a.id !== exceptId);
    if (!primary) return { ip: null };
    if (primary.proxy && exitIps.has(primary.id)) return { ip: exitIps.get(primary.id), name: primary.name };
    const res = primary.proxy ? await proxy.test(primary.proxy, proxy.decryptPassword(primary.proxyPassword)) : await proxy.testSystem();
    if (!res.ok) return { error: `查不到主号「${primary.name}」的出口 IP（${res.error}），没法确认这个号和主号不在同一个 IP，暂时不能保存。请确认主号的网络正常后再试。` };
    if (primary.proxy) recordExit(primary, res.ip);
    return { ip: res.ip, name: primary.name };
  }

  // 测试代理：返回出口 IP、所在地、时区，给出匹配的地区，并提示和别的账号出口相同。
  // 不填代理也能测：网页号按系统代理查（它就是这么上网的），轻量号查这台电脑的真实 IP
  handleShell('editor:test', async ({ id, proxy: proxyText, password, mode } = {}) => {
    const acc = findAcc(id);
    const direct = !String(proxyText || '').trim();
    const lite = acc ? isLite(acc) : mode === 'lite';
    let res;
    if (direct) res = lite ? await proxy.testDirect() : await proxy.testSystem();
    else res = await proxy.test(String(proxyText || ''), proxy.passwordFor(acc ? acc.proxy : '', acc ? acc.proxyPassword : '', String(proxyText || ''), password));
    if (!res.ok) return res;
    res.region = regionForTimezone(res.timezone);
    if (res.region) res.regionLabel = regionLabel(res.region);
    res.country = regionName(res.country);
    const same = ctx.accounts.find((a) => a.id !== id && exitIps.get(a.id) === res.ip);
    const before = same ? null : ctx.accounts.find((a) => a.id !== id && a.lastExit && a.lastExit.ip === res.ip);
    if (same) res.sameAs = same.name;
    else if (before) { res.sameAs = before.name; res.sameAt = before.lastExit.at; }
    if (direct) res.direct = lite ? 'real' : 'system';
    // 直连的测试结果用两个记号区分：系统代理（网页号）和真实 IP（轻量号），保存时只认网页号那种
    lastTest = { proxy: direct ? (lite ? '(real)' : '(system)') : proxy.parse(proxyText)?.rules, ip: res.ip, label: res.country, region: res.region };
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
    // 重新填了同一个密码也算没改，沿用原来那份（下面比较 changed 时才不会误判）
    const keepOld = !!acc && proxy.keepOldPassword(plan, plan.kind === 'new' ? proxy.decryptPassword(acc.proxyPassword) : '');
    let encPassword = keepOld ? acc.proxyPassword : '';
    try {
      if (plan.kind === 'new' && !keepOld) encPassword = proxy.encryptPassword(plan.password);
    } catch (e) {
      return { error: e.message };
    }
    // 测试过的出口所在地显示在侧栏
    let tested = lastTest && parsed && lastTest.proxy === parsed.rules ? lastTest : null;
    // 网页版时区还没定（“跟随本机”）：没测过就先测一次，按出口所在地填好时区。
    // 直连号按系统代理测（它就是这么上网的）。测不通也照样保存；用户自己选了地区的不改。
    // 代理号只改名字、备注、颜色时不测（不然每次保存都要等几秒）：只有新号、代理或密码变了、
    // 还不知道出口所在地、或刚从别的地区改回“跟随本机”时才测
    const exitUnknown = !acc || acc.proxy !== proxyStored || (plan.kind === 'new' && !keepOld) || !acc.exitLabel || acc.fingerprint.region !== 'auto';
    let directTested = !parsed && lastTest && lastTest.proxy === '(system)' ? lastTest : null;
    if (mode === 'web' && region === 'auto') {
      if (parsed && !tested && exitUnknown) {
        const res = await proxy.test(String(proxyText || ''), proxy.passwordFor(acc ? acc.proxy : '', acc ? acc.proxyPassword : '', String(proxyText || ''), password));
        if (res.ok) tested = { proxy: parsed.rules, ip: res.ip, label: regionName(res.country), region: regionForTimezone(res.timezone) };
      } else if (!parsed && !directTested) {
        const res = await proxy.testSystem();
        if (res.ok) directTested = { region: regionForTimezone(res.timezone) };
      }
      const pick = parsed ? tested : directTested;
      if (pick && pick.region) region = pick.region;
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
      // 换了代理：上面已经和主号比过；改成直连的没比过，后台再比一次
      if (changed) { ctx.primaryClash.delete(acc.id); if (!parsed) ctx.comparePrimary(); }
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
    // 不弹窗提醒去自检：后台自动和主号比一次出口，撞了在侧栏和顶栏标出来
    if (remindCheck) ctx.comparePrimary();
    return { ok: true };
  });

  return {
    resetTest() { lastTest = null; }, // 打开编辑页时清掉上一次的测试结果
  };
}

module.exports = { setupEditorIpc };
