// 新账号 id：用当前毫秒数，但保证不和已有账号重复。
// 同一毫秒连建两个号（编辑页新建和后台分号撞上）、或系统时间被往回调过，都不会拿到同一个 id。
// 同一个 id 两个账号时，按 id 找账号只会找到第一个，第二个打不开也删不掉。
let lastIssued = 0;

function newAccountId(accounts, now = Date.now()) {
  let id = Math.max(Math.floor(now), lastIssued + 1);
  while (accounts.some((a) => a.id === String(id))) id += 1;
  lastIssued = id;
  return String(id);
}

module.exports = { newAccountId };
