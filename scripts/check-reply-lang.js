// 工作台“回复”的语言自检：自动 = 中文翻成客户的语言（默认英语），英文等翻成中文；手动选的目标语言优先；⇄ 对调
const assert = require('assert');
const R = require('../src/shell/reply-lang.js');

// 自动检测 + 自动选择
assert.deepStrictEqual(R.pick({ text: '你好，今天发货吗？', src: '', manual: '', autoTarget: '英语' }), { source: '中文', target: '英语' });
assert.deepStrictEqual(R.pick({ text: 'how are you ?', src: '', manual: '', autoTarget: '英语' }), { source: '', target: '中文' });
assert.deepStrictEqual(R.pick({ text: 'Wie viel kostet die Perücke?', src: '', manual: '', autoTarget: '英语' }), { source: '', target: '中文' });
// 中文夹英文行业词还是中文；英文夹一个中文词还是英文
assert.deepStrictEqual(R.pick({ text: '这个 lace front 头套明天发', src: '', manual: '', autoTarget: '英语' }).target, '英语');
assert.deepStrictEqual(R.pick({ text: 'Please send the 头套 tomorrow morning', src: '', manual: '', autoTarget: '英语' }).target, '中文');
// 中文翻成客户的语言（客户资料 / 认出来的）
assert.deepStrictEqual(R.pick({ text: '谢谢', src: '', manual: '', autoTarget: '德语' }), { source: '中文', target: '德语' });
// 客户语言是中文或没有：中文翻成英语
assert.strictEqual(R.pick({ text: '谢谢', autoTarget: '中文' }).target, '英语');
assert.strictEqual(R.pick({ text: '谢谢' }).target, '英语');
// 没写字按中文显示
assert.strictEqual(R.pick({ text: '', autoTarget: '英语' }).target, '英语');
assert.strictEqual(R.pick({ text: '123 ?', autoTarget: '英语' }).target, '英语');
// 手动选的原文语言
assert.deepStrictEqual(R.pick({ text: '你好', src: '英语', manual: '', autoTarget: '英语' }), { source: '英语', target: '中文' });
assert.deepStrictEqual(R.pick({ text: 'hello', src: '中文', manual: '', autoTarget: '法语' }), { source: '中文', target: '法语' });
// 手动选的目标语言优先，不管写的是什么
assert.deepStrictEqual(R.pick({ text: 'hello there', src: '', manual: '西班牙语', autoTarget: '英语' }), { source: '', target: '西班牙语' });
assert.deepStrictEqual(R.pick({ text: '你好', src: '', manual: '法语', autoTarget: '英语' }), { source: '中文', target: '法语' });
// ⇄ 对调
assert.deepStrictEqual(R.swap({ text: '你好', src: '', manual: '', autoTarget: '英语' }), { src: '英语', manual: '中文' });
assert.deepStrictEqual(R.swap({ text: 'hello there', src: '英语', manual: '', autoTarget: '英语' }), { src: '中文', manual: '英语' });
assert.deepStrictEqual(R.swap({ text: 'hello there', src: '', manual: '', autoTarget: '英语' }), { src: '中文', manual: '英语' }); // 认不出原文语言：目标按英语
assert.deepStrictEqual(R.swap({ text: '你好', src: '', manual: '德语', autoTarget: '英语' }), { src: '德语', manual: '中文' });
console.log('check-reply-lang OK');
