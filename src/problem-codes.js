// 问题页上的短代码：用户说一句“显示 P1”，就知道是哪种问题，日志里也记着同一个代码。
// 新加一种问题时在这里配一个代码（scripts/check-review.mjs 会检查有没有漏）。
const PROBLEM_CODES = {
  proxy: 'P1', // 代理连不上（网页号）
  proxyDown: 'P1', // 代理连不上（轻量号）
  unreachable: 'P1', // 轻量号：代理端口通，但当前节点连不上 WhatsApp（直连轻量号用 N1）
  config: 'P2', // 代理设置有误
  teamProxy: 'P3', // 管理员分的号，还没填代理
  network: 'N1', // WhatsApp 页面打不开
  banned: 'L1', // WhatsApp 拒绝连接，可能被封
  replaced: 'L2', // 在别处连上了
  outdated: 'L3', // 协议版本太旧，要更新
  loggedOut: 'L4', // 已退出登录
  stuck: 'L5', // 连接反复失败，已停止重连
  authError: 'D1', // 本机数据读不出
  crashed: 'C1', // 轻量模式后台进程意外退出
  crashLoop: 'C2', // 后台进程反复出错，已停止自动恢复
};

const problemCode = (kind) => PROBLEM_CODES[kind] || '';

module.exports = { PROBLEM_CODES, problemCode };
