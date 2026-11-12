// 自检用：临时配置里的团队设置写成「不用登录」，团队后台指向本机一个没人听的端口。
// 新装的软件在问到后台以前按「必须登录」锁住（src/team DEFAULT_POLICY），不写这个，账号页面不会打开；
// 后台指向本机，自检也不会去问正式的 laicrm.com。要测登录的自检（check-login-lock）自己写 team.json。
const fs = require('fs');
const path = require('path');

const DEAD_TEAM_SERVER = 'http://127.0.0.1:10';

// profileDir = 软件的 userData 文件夹（accounts.json 所在的地方）。返回启动软件时要加的环境变量，每次启动都要带上：
// team.json 里记着后台地址，和这次启动的后台对不上时软件当成换了后台，又按「必须登录」锁住
function teamOff(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const file = path.join(profileDir, 'team.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ server: DEAD_TEAM_SERVER, policy: 'off' }));
  return { WASWITCH_TEST_TEAM_SERVER: DEAD_TEAM_SERVER };
}

module.exports = { teamOff, DEAD_TEAM_SERVER };
