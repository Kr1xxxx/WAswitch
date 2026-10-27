// 编辑账号时代理密码保留/换新/清空的判断（src/proxy-parse.js 的 passwordPlan），保存和测试共用
const assert = require('assert');
const { passwordPlan } = require('../src/proxy-parse');

const OLD = 'http://alice@1.2.3.4:8080';
// 什么都没改、没填新密码：沿用旧密码
assert.deepStrictEqual(passwordPlan(OLD, 'http://alice@1.2.3.4:8080', ''), { kind: 'old' });
// 主机名大小写不同算同一个
assert.deepStrictEqual(passwordPlan('http://alice@Proxy.Example.com:8080', 'http://alice@proxy.example.com:8080', ''), { kind: 'old' });
// 审计第 1 条：换了地址和用户名、没填密码 → 不能把 alice 的密码发给新代理
assert.deepStrictEqual(passwordPlan(OLD, 'http://bob@5.6.7.8:8080', ''), { kind: 'none' });
// 只换主机 / 只换端口 / 只换用户名，也都清掉
assert.deepStrictEqual(passwordPlan(OLD, 'http://alice@5.6.7.8:8080', ''), { kind: 'none' });
assert.deepStrictEqual(passwordPlan(OLD, 'http://alice@1.2.3.4:9090', ''), { kind: 'none' });
assert.deepStrictEqual(passwordPlan(OLD, 'http://bob@1.2.3.4:8080', undefined), { kind: 'none' });
// 新填的密码优先，地址里带的其次
assert.deepStrictEqual(passwordPlan(OLD, 'http://bob@5.6.7.8:8080', 'pw2'), { kind: 'new', password: 'pw2' });
assert.deepStrictEqual(passwordPlan(OLD, 'http://bob:inurl@5.6.7.8:8080', ''), { kind: 'new', password: 'inurl' });
assert.deepStrictEqual(passwordPlan(OLD, 'http://bob:inurl@5.6.7.8:8080', 'typed'), { kind: 'new', password: 'typed' });
// 新地址没有用户名、改成直连、地址写错：都不用密码
assert.deepStrictEqual(passwordPlan(OLD, 'http://1.2.3.4:8080', 'pw'), { kind: 'none' });
assert.deepStrictEqual(passwordPlan(OLD, '', ''), { kind: 'none' });
assert.deepStrictEqual(passwordPlan(OLD, '1.2.3.4:8080', ''), { kind: 'none' });
// 新账号（没有旧地址）没填密码
assert.deepStrictEqual(passwordPlan('', 'http://alice@1.2.3.4:8080', ''), { kind: 'none' });

console.log('check-proxy-pass: ok');
