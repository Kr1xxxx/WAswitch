// 安全写文件（src/atomic.js）：写完内容正确、不留临时文件、权限对、覆盖旧文件；坏文件备份能被认出来
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, writeJsonAtomic, hasBrokenBackup } = require('../src/atomic');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-atomic-'));
try {
  const file = path.join(dir, 'accounts.json');

  // 新写、覆盖、缩进和原来一样
  writeJsonAtomic(file, [{ id: '1' }], 2);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify([{ id: '1' }], null, 2));
  writeJsonAtomic(file, [{ id: '1' }, { id: '2' }]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: '1' }, { id: '2' }]);
  assert.ok(!fs.existsSync(`${file}.tmp`), '不应留下临时文件');

  // 上次断电留下的临时文件（还是只读的）不影响这次写
  fs.writeFileSync(`${file}.tmp`, 'garbage', { mode: 0o400 });
  writeJsonAtomic(file, [], 2);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '[]');

  // Buffer 和权限
  const secret = path.join(dir, 'queue.bin');
  writeFileAtomic(secret, Buffer.from([1, 2, 3]), { mode: 0o600 });
  assert.deepStrictEqual([...fs.readFileSync(secret)], [1, 2, 3]);
  if (process.platform !== 'win32') {
    fs.writeFileSync(`${secret}.tmp`, 'x', { mode: 0o644 });
    writeFileAtomic(secret, 'y', { mode: 0o600 });
    assert.strictEqual(fs.statSync(secret).mode & 0o777, 0o600, '旧临时文件的宽权限不能带过去');
  }

  // 写失败（目标文件夹不存在）要抛出来，不能悄悄当成功
  assert.throws(() => writeJsonAtomic(path.join(dir, 'no', 'x.json'), {}));

  // 损坏备份：没有时 false，有 accounts.json.broken-* 时 true，别的文件的备份不算
  assert.strictEqual(hasBrokenBackup(file), false);
  fs.writeFileSync(path.join(dir, 'groups.json.broken-1'), '');
  assert.strictEqual(hasBrokenBackup(file), false);
  fs.writeFileSync(path.join(dir, 'accounts.json.broken-123'), '');
  assert.strictEqual(hasBrokenBackup(file), true);
  // 文件夹读不了时宁可当作有备份（不清理）
  assert.strictEqual(hasBrokenBackup(path.join(dir, 'nope', 'accounts.json')), true);

  console.log('安全写文件自检通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
