// 编辑账号时代理密码保留/换新/清空的判断（src/proxy-parse.js 的 passwordPlan），保存和测试共用
const assert = require('assert');
const { parse, passwordPlan, keepOldPassword } = require('../src/proxy-parse');

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

// 审计第 4 条：重新填了同一个密码 → 沿用原来的加密密码，不算改了（不重建页面）
assert.strictEqual(keepOldPassword(passwordPlan(OLD, 'http://alice@1.2.3.4:8080', 'pw'), 'pw'), true);
assert.strictEqual(keepOldPassword(passwordPlan(OLD, 'http://alice:pw@1.2.3.4:8080', ''), 'pw'), true);
assert.strictEqual(keepOldPassword(passwordPlan(OLD, 'http://alice@1.2.3.4:8080', ''), 'pw'), true);
// 填了不同的密码、原来没有密码或解不开 → 重新加密
assert.strictEqual(keepOldPassword(passwordPlan(OLD, 'http://alice@1.2.3.4:8080', 'pw2'), 'pw'), false);
assert.strictEqual(keepOldPassword(passwordPlan(OLD, 'http://alice@1.2.3.4:8080', 'pw'), ''), false);
// 清掉密码的情况（审计第 1 条）不受影响：不会把旧密码留给新代理
assert.strictEqual(keepOldPassword(passwordPlan(OLD, 'http://bob@5.6.7.8:8080', ''), 'pw'), false);
assert.strictEqual(keepOldPassword(passwordPlan(OLD, '', ''), 'pw'), false);

// 写了和协议默认值相同的端口（http 80、https 443）也要认：new URL() 会把它丢掉
const NO_PORT = '代理地址需要包含 IP 和端口，例如 socks5://127.0.0.1:7891';
const p80 = parse('http://1.2.3.4:80');
assert.strictEqual(p80.error, undefined);
assert.strictEqual(p80.port, 80);
assert.strictEqual(p80.rules, 'http://1.2.3.4:80');
assert.strictEqual(p80.display, 'http://1.2.3.4:80');
const p443 = parse('https://p.example:443');
assert.deepStrictEqual([p443.port, p443.rules, p443.display], [443, 'https://p.example:443', 'https://p.example:443']);
assert.strictEqual(parse('http://alice:pw@1.2.3.4:80/').display, 'http://alice@1.2.3.4:80');
assert.strictEqual(parse('http://alice:pw@1.2.3.4:80/').port, 80);
assert.strictEqual(parse('http://1.2.3.4:8080').port, 8080);
assert.strictEqual(parse('http://1.2.3.4:8080').rules, 'http://1.2.3.4:8080');
assert.strictEqual(parse('socks5://1.2.3.4:1080').rules, 'socks5://1.2.3.4:1080');
// IPv6：有端口能用，没写端口仍然报错
assert.strictEqual(parse('socks5://[::1]:1080').port, 1080);
assert.strictEqual(parse('socks5://[::1]:1080').rules, 'socks5://[::1]:1080');
assert.strictEqual(parse('http://[::1]:80').port, 80);
assert.strictEqual(parse('http://[::1]:80').rules, 'http://[::1]:80');
assert.strictEqual(parse('http://[::1]').error, NO_PORT);
assert.strictEqual(parse('socks5://[::1]').error, NO_PORT);
// 真的没写端口：报错不变
assert.strictEqual(parse('http://1.2.3.4').error, NO_PORT);
assert.strictEqual(parse('https://1.2.3.4/').error, NO_PORT);
assert.strictEqual(parse('socks5://1.2.3.4').error, NO_PORT);
assert.strictEqual(parse('http://alice@1.2.3.4').error, NO_PORT);
assert.strictEqual(parse('http://1.2.3.4/path:80').error, NO_PORT);
// 80 端口的地址能沿用旧密码
assert.deepStrictEqual(passwordPlan('http://alice@1.2.3.4:80', 'http://alice@1.2.3.4:80', ''), { kind: 'old' });

console.log('check-proxy-pass: ok');
