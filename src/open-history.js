// 侧栏「开聊」页下面的开聊历史：在这一页成功开过的号码，最近的在最前面。
// 只存本机（open-history.json），每条 { accountId, digits, at }，名字显示时去客户资料里查（改了名字跟着变）。
// 同一个号下的同一个号码再开一次：旧的那条挪到最前面，不重复。最多留 50 条
const fs = require('fs');
const { writeJsonAtomic } = require('./atomic');

const KEEP = 50;
const valid = (e) => !!e && typeof e.accountId === 'string' && /^\d{7,15}$/.test(String(e.digits)) && Number.isFinite(e.at);

function createOpenHistory(file) {
  let list = null;
  function load() {
    if (list) return list;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      list = Array.isArray(d) ? d.filter(valid).map(({ accountId, digits, at }) => ({ accountId, digits: String(digits), at })).slice(0, KEEP) : [];
    } catch {
      list = []; // 没有或坏了：从空的开始（丢了也只是少几条历史）
    }
    return list;
  }
  function add(accountId, digits, at = Date.now()) {
    const d = String(digits);
    list = [{ accountId, digits: d, at }, ...load().filter((e) => !(e.accountId === accountId && e.digits === d))].slice(0, KEEP);
    try { writeJsonAtomic(file, list); } catch (e) { console.warn(`开聊历史没存上：${e.code || e.message}`); }
  }
  return { add, list: () => load().slice() };
}

// 页面上显示的：只留 keep(accountId) 为真的（还在的网页号；删掉、停用、轻量号下的不显示），最多 n 条
const shownOpens = (list, keep, n = 8) => list.filter((e) => keep(e.accountId)).slice(0, n);

module.exports = { createOpenHistory, shownOpens, KEEP };
