// 自检：新消息通知正文写出是哪几个对话，读不到名字时退回“有 N 个未读对话”。
// 运行：node scripts/check-notify.js（不用 Electron，electron 模块用假的替掉）
const Module = require('module');

const shown = [];
class FakeNotification {
  constructor(o) { this.o = o; }
  static isSupported() { return true; }
  on() {}
  show() { shown.push(this.o); }
}
const fakeElectron = {
  app: { setBadgeCount() {}, setAppUserModelId() {} },
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  Notification: FakeNotification,
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };

const { unreadNames, unreadBody } = require('../src/notify-text');
const { Notifier } = require('../src/notify');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const eq = (a, b, text) => check(a === b, `${text}（得到“${a}”）`);

// 正文
eq(unreadBody(3, ['Emma Schneider', 'John Miller', 'Lucas Martin']), 'Emma Schneider、John Miller 等 3 个未读对话', '3 个未读、读到 3 个名字：写前两个 + 等 3 个');
eq(unreadBody(2, ['Emma Schneider', 'John Miller']), 'Emma Schneider、John Miller 发来新消息', '2 个未读、2 个名字都写出来');
eq(unreadBody(1, ['Emma Schneider']), 'Emma Schneider 发来新消息', '1 个未读');
eq(unreadBody(1, ['Emma Schneider', 'John Miller']), 'Emma Schneider 发来新消息', '名字比未读数多时只写未读数那么多个');
eq(unreadBody(4, ['Emma Schneider']), 'Emma Schneider 等 4 个未读对话', '只读到 1 个名字（其余没显示在列表里）');
eq(unreadBody(3, []), '有 3 个未读对话', '没读到名字：原来的文案');
eq(unreadBody(3, null), '有 3 个未读对话', '读不到（null）：原来的文案');

// 名字挑选
const chats = [
  { name: 'Team Berlin', unread: 5, muted: true },
  { name: '  Emma   Schneider ', unread: 1 },
  { name: 'Anna Weber', unread: 0 },
  { name: 'John Miller', unread: 2 },
  { name: 'John Miller', unread: 1 },
  { name: 'Ä'.repeat(40), unread: 1 },
];
const names = unreadNames(chats);
check(names[0] === 'Emma Schneider' && names[1] === 'John Miller', `没静音的排前面、空格整理好（${names.slice(0, 2).join(' / ')}）`);
check(!names.includes('Anna Weber'), '没有未读的对话不写');
check(names.filter((n) => n === 'John Miller').length === 1, '同名只写一次');
check(names[2] === `${'Ä'.repeat(30)}…`, '太长的名字截到 30 个字');
check(names[3] === 'Team Berlin', '静音的对话排在最后');
check(unreadNames(undefined).length === 0 && unreadNames([{ unread: 2 }]).length === 0, '列表不对时返回空，不出错');

// Notifier：先读名字再弹，读不到退回原文案
const acc = { id: 'a1', name: '德国客户号' };
function make(unreadChats) {
  return new Notifier({ getAccounts: () => [acc], getWindow: () => null, activate() {}, quit() {}, unreadChats });
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  shown.length = 0;
  let n = make(async () => ['Emma Schneider', 'John Miller']);
  n.update(acc, 3, { isActive: false });
  await tick(10);
  check(shown.length === 1 && shown[0].title === '德国客户号' && shown[0].body === 'Emma Schneider、John Miller 等 3 个未读对话', `读到名字：通知写客户名（${shown[0] && shown[0].body}）`);

  shown.length = 0;
  n = make(async () => null);
  n.update(acc, 2, { isActive: false });
  await tick(10);
  check(shown.length === 1 && shown[0].body === '有 2 个未读对话', '读不到名字：退回“有 N 个未读对话”');

  shown.length = 0;
  n = make(async () => { throw new Error('页面没了'); });
  n.update(acc, 1, { isActive: false });
  await tick(10);
  check(shown.length === 1 && shown[0].body === '有 1 个未读对话', '读名字出错：退回原文案，照样弹');

  shown.length = 0;
  n = make(undefined);
  n.update(acc, 1, { isActive: false });
  await tick(10);
  check(shown.length === 1 && shown[0].body === '有 1 个未读对话', '没有读名字的接口：原文案');

  shown.length = 0;
  n = make(() => new Promise(() => {}));
  n.update(acc, 2, { isActive: false });
  await tick(2200);
  check(shown.length === 1 && shown[0].body === '有 2 个未读对话', '读名字一直不返回：2 秒后用原文案弹出');

  // 读名字期间又来新消息：只弹最新的那条
  shown.length = 0;
  let calls = 0;
  n = make(async () => { calls += 1; await tick(50); return calls === 1 ? ['Emma Schneider'] : ['John Miller', 'Emma Schneider']; });
  n.update(acc, 1, { isActive: false });
  await tick(5);
  n.update(acc, 2, { isActive: false });
  await tick(120);
  check(shown.length === 1 && shown[0].body === 'John Miller、Emma Schneider 发来新消息', `连着来两条只弹最新一条（弹了 ${shown.length} 条）`);

  // 读名字期间未读已经清零：不弹
  shown.length = 0;
  n = make(async () => { await tick(30); return ['Emma Schneider']; });
  n.update(acc, 1, { isActive: false });
  n.update(acc, 0, { isActive: false });
  await tick(60);
  check(shown.length === 0, '读名字期间已经看过（未读清零）：不弹');

  // 静音的号不读名字也不弹
  shown.length = 0;
  let asked = 0;
  n = make(async () => { asked += 1; return ['Emma Schneider']; });
  n.update({ ...acc, muted: true }, 2, { isActive: false });
  await tick(10);
  check(shown.length === 0 && asked === 0, '关了通知的号：不读名字、不弹');

  console.log(failures ? `\n有 ${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();
