// Test-only app entry: explicitly isolate data before the main module takes its lock.
const { app } = require('electron');
const fs = require('fs');
const { teamOff } = require('./team-off');
const profile = process.env.WASWITCH_TEST_PROFILE;
if (!profile || !fs.existsSync(profile)) throw new Error('Missing isolated view-race profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
// 新装的软件问到后台以前按「必须登录」锁住：这里的自检要账号页面直接打开，团队设置写成不用登录（见 team-off.js）
Object.assign(process.env, teamOff(profile));
require('../../src/main');
