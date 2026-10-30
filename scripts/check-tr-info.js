// 点收到消息译文右下角的时间弹出的翻译详情：时间、用时、模型怎么写（shen 2026-10-30）。纯函数，不连网络。
const assert = require('assert');
const T = require('../src/shell/tr-info.js');

// 按本机时间造时刻，所以在哪个时区跑都一样
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const now = at(2026, 10, 30, 21, 10);

// 时间：今天、昨天、今年更早、不是今年；零点前后
assert.strictEqual(T.when(at(2026, 10, 30, 20, 45), now), '20:45');
assert.strictEqual(T.when(at(2026, 10, 30, 0, 0), now), '00:00', '今天零点');
assert.strictEqual(T.when(at(2026, 10, 29, 23, 59), now), '昨天 23:59', '昨天最后一分钟');
assert.strictEqual(T.when(at(2026, 10, 29, 9, 5), now), '昨天 09:05');
assert.strictEqual(T.when(at(2026, 10, 28, 20, 45), now), '10月28日 20:45');
assert.strictEqual(T.when(at(2026, 1, 3, 7, 8), now), '1月3日 07:08');
assert.strictEqual(T.when(at(2025, 10, 28, 20, 45), now), '2025年10月28日 20:45');
assert.strictEqual(T.when(at(2025, 12, 31, 23, 59), at(2026, 1, 1, 0, 1)), '昨天 23:59', '跨年的昨天还是昨天');
assert.strictEqual(T.when(at(2025, 12, 30, 23, 59), at(2026, 1, 1, 0, 1)), '2025年12月30日 23:59', '跨年');
assert.strictEqual(T.when(at(2026, 10, 30, 0, 1), at(2026, 10, 30, 0, 2)), '00:01', '零点后一分钟');

// 用时：10 秒以内一位小数，10 秒以上取整，一分钟以上 1 分 5 秒
assert.strictEqual(T.took(400), '0.4 秒');
assert.strictEqual(T.took(1234), '1.2 秒');
assert.strictEqual(T.took(1250), '1.3 秒');
assert.strictEqual(T.took(9940), '9.9 秒');
assert.strictEqual(T.took(9950), '10 秒', '9.95 秒进位成 10 秒，不写 10.0');
assert.strictEqual(T.took(12000), '12 秒');
assert.strictEqual(T.took(12400), '12 秒');
assert.strictEqual(T.took(59400), '59 秒');
assert.strictEqual(T.took(59600), '1 分', '59.6 秒进位');
assert.strictEqual(T.took(60000), '1 分');
assert.strictEqual(T.took(65000), '1 分 5 秒');
assert.strictEqual(T.took(185000), '3 分 5 秒');
assert.strictEqual(T.took(0), '0.0 秒');

// 模型：服务商名加模型名，和翻译页一样；没有模型名的只写名字
assert.strictEqual(T.who('智谱', 'glm-4-flash'), '智谱 glm-4-flash');
assert.strictEqual(T.who('腾讯混元', 'hy-mt2-plus'), '腾讯混元 hy-mt2-plus');
assert.strictEqual(T.who('OpenRouter', 'openai/gpt-4o-mini'), 'OpenRouter openai/gpt-4o-mini');
assert.strictEqual(T.who('DeepL', ''), 'DeepL');
assert.strictEqual(T.who('', ''), '');
assert.strictEqual(T.who(undefined, undefined), '');

// 三行：缺哪项就没有哪一行
const full = { at: at(2026, 10, 30, 20, 45), ms: 1234, name: '智谱', model: 'glm-4-flash', fix: false };
assert.deepStrictEqual(T.rows(full, now), [['翻译时间', '20:45'], ['用时', '1.2 秒'], ['模型', '智谱 glm-4-flash']]);
assert.deepStrictEqual(T.rows({ ...full, fix: true }, now), [['纠错时间', '20:45'], ['用时', '1.2 秒'], ['模型', '智谱 glm-4-flash']], '纠错的写纠错时间');
assert.deepStrictEqual(T.rows({ ...full, name: 'DeepL', model: '' }, now)[2], ['模型', 'DeepL']);
assert.deepStrictEqual(T.rows({ at: full.at, fix: false }, now), [['翻译时间', '20:45']], '老记录只有时间');
assert.deepStrictEqual(T.rows({ at: full.at, fix: true }, now), [['纠错时间', '20:45']]);
assert.deepStrictEqual(T.rows({ at: full.at, ms: 900, fix: false }, now), [['翻译时间', '20:45'], ['用时', '0.9 秒']], '没有模型就没有模型那行');
assert.deepStrictEqual(T.rows({ at: full.at, name: '智谱', fix: false }, now), [['翻译时间', '20:45'], ['模型', '智谱']], '没有用时就没有用时那行');
assert.deepStrictEqual(T.rows(null, now), []);
assert.deepStrictEqual(T.rows({ ms: 5 }, now), []);

// 能不能点：翻好的、读到了消息时间、记着翻译情况
const done = { state: 'done', t: '20:45', via: full };
assert.strictEqual(T.openable(done), true);
assert.strictEqual(T.openable({ ...done, via: null }), false, '老记录手动改过：没有可显示的');
assert.strictEqual(T.openable({ ...done, t: '' }), false, '页面上读不到消息时间');
for (const state of ['skip', 'queued', 'running', 'error', 'manual']) assert.strictEqual(T.openable({ ...done, state }), false, `${state} 的时间不能点`);
assert.strictEqual(T.openable(null), false);
console.log('check-tr-info OK');
