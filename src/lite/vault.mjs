// 轻量模式的本地数据：登录凭据和聊天缓存都用 AES-256-GCM 加密后写盘。
// 密钥由主进程生成，用系统钥匙串加密保存在 accounts.json 里，启动时传给这个进程，不落盘明文。
// 写盘：登录凭据（creds）一变就立即写，避免崩溃时丢掉；Signal 密钥 1.5 秒防抖，聊天缓存 10 秒防抖；停止和退出时立即写。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { initAuthCreds, BufferJSON, proto } from 'baileys';

const MAGIC = Buffer.from('WAS1');

export function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(key, data) {
  if (data.length < 32 || !data.subarray(0, 4).equals(MAGIC)) throw new Error('文件格式不对');
  const iv = data.subarray(4, 16);
  const tag = data.subarray(16, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
}

// 读加密的 JSON。文件不存在返回 null；存在但解不开时抛错（绝不能当成空数据覆盖掉）
export function readSealed(file, key) {
  let raw;
  try { raw = fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(decrypt(key, raw).toString('utf8'), BufferJSON.reviver);
}

export function writeSealed(file, key, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, encrypt(key, Buffer.from(JSON.stringify(value, BufferJSON.replacer))), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 防抖写盘
export function debounced(fn, ms) {
  let timer = null;
  const run = () => { clearTimeout(timer); timer = null; fn(); };
  return {
    schedule() { if (!timer) timer = setTimeout(run, ms); },
    flush() { if (timer) run(); },
    cancel() { clearTimeout(timer); timer = null; },
  };
}

// Baileys 需要的登录状态：{ state: { creds, keys }, saveCreds, flush, wipe }
export function makeAuthState(dir, key, onError) {
  const file = path.join(dir, 'auth.enc');
  const data = readSealed(file, key) || { creds: initAuthCreds(), keys: {} };
  let alive = true;
  const save = debounced(() => {
    if (!alive) return;
    try { writeSealed(file, key, data); } catch (e) { onError(e); }
  }, 1500);

  const keys = {
    async get(type, ids) {
      const bucket = data.keys[type] || {};
      const out = {};
      for (const id of ids) {
        let value = bucket[id];
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        out[id] = value;
      }
      return out;
    },
    async set(changes) {
      for (const type of Object.keys(changes)) {
        const bucket = data.keys[type] || (data.keys[type] = {});
        for (const [id, value] of Object.entries(changes[type])) {
          if (value) bucket[id] = value; else delete bucket[id];
        }
      }
      save.schedule();
    },
  };

  return {
    state: { creds: data.creds, keys },
    // 凭据变化不频繁，立即写盘（连同已有的密钥），不等防抖
    saveCreds: () => { save.schedule(); save.flush(); },
    flush: () => save.flush(),
    // 退出登录后删掉凭据，下次启动重新扫码
    wipe() {
      alive = false;
      save.cancel();
      fs.rmSync(file, { force: true });
    },
  };
}
