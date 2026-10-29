// 安全写文件（src/atomic.js）：写完内容正确、不留临时文件、权限对、覆盖旧文件；坏文件备份能被认出来；
// Windows 上改名被锁时重试；不抛错的保存只记一次日志
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, writeJsonAtomic, writeJsonQuiet, hasBrokenBackup } = require('../src/atomic');

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

  // 改名被锁（Windows 杀毒软件）：模拟 Windows，换掉 fs.renameSync
  const realRename = fs.renameSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const fakeRename = (codes) => {
    let calls = 0;
    fs.renameSync = (a, b) => {
      const code = codes[calls++];
      if (code) throw Object.assign(new Error(code), { code });
      realRename(a, b);
    };
    return () => calls;
  };
  const setPlatform = (p) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try {
    setPlatform('win32');
    const locked = path.join(dir, 'locked.json');
    // 前两次 EPERM，第三次成功
    let calls = fakeRename(['EPERM', 'EPERM']);
    writeJsonAtomic(locked, { a: 1 }, 2);
    assert.strictEqual(calls(), 3);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(locked, 'utf8')), { a: 1 });
    // 一直 EBUSY：最后抛出，总共不到 1 秒
    calls = fakeRename(Array(50).fill('EBUSY'));
    const t0 = Date.now();
    assert.throws(() => writeJsonAtomic(locked, { a: 2 }), { code: 'EBUSY' });
    assert.ok(Date.now() - t0 < 1000, `重试太久：${Date.now() - t0}ms`);
    assert.strictEqual(calls(), 10);
    // 别的错误不重试
    calls = fakeRename(['ENOENT']);
    assert.throws(() => writeJsonAtomic(locked, {}), { code: 'ENOENT' });
    assert.strictEqual(calls(), 1);
    // Mac 上 EPERM 也不重试
    setPlatform('darwin');
    calls = fakeRename(['EPERM']);
    assert.throws(() => writeJsonAtomic(locked, {}), { code: 'EPERM' });
    assert.strictEqual(calls(), 1);
  } finally {
    fs.renameSync = realRename;
    Object.defineProperty(process, 'platform', realPlatform);
  }

  // 不抛错的保存：失败返回 false 并记日志，连续失败只记一次，成功后再失败重新记
  const realWarn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const bad = path.join(dir, 'no', 'settings.json');
    assert.strictEqual(writeJsonQuiet(bad, {}), false);
    assert.strictEqual(writeJsonQuiet(bad, {}), false);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /settings\.json 保存失败：ENOENT/);
    fs.mkdirSync(path.dirname(bad));
    assert.strictEqual(writeJsonQuiet(bad, { b: 1 }, 2), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(bad, 'utf8')), { b: 1 });
    fs.rmSync(path.dirname(bad), { recursive: true });
    assert.strictEqual(writeJsonQuiet(bad, {}), false);
    assert.strictEqual(warns.length, 2);
  } finally {
    console.warn = realWarn;
  }

  console.log('安全写文件自检通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
