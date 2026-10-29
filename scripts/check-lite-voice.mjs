// 轻量号语音自检（不联网）：
// 1) 聊天缓存：客户发来的语音记下载信息（加密写盘、重启还在、按对话删），消息上只有时长；自己发的语音不记
// 2) Session.voice：用这个号自己的代理下载（dispatcher），链接过期（410）先请手机重新上传再下，超大的不要
// 用法：node scripts/check-lite-voice.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { Readable } from 'node:stream';

const { ChatStore, voiceOf, MAX_VOICES } = await import('../src/lite/store.mjs');
const { Session, VOICE_MAX_BYTES } = await import('../src/lite/session.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-voice-'));
const key = crypto.randomBytes(32);
const jid = '447700900123@s.whatsapp.net';
const mediaKey = crypto.randomBytes(32);
const audio = (seconds, extra = {}) => ({ audioMessage: { mediaKey, directPath: '/v/t62.7117-24/abc.enc?ccb=11', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', seconds, ptt: true, mimetype: 'audio/ogg; codecs=opus', ...extra } });

// 1) 缓存
const store = new ChatStore(tmp, key, (e) => { throw e; });
let r = store.addMessage({ key: { remoteJid: jid, id: 'IN1', fromMe: false }, messageTimestamp: 1730000000, message: audio(23) }, { countUnread: true });
assert.deepStrictEqual([r.added, r.incoming], [true, true]);
store.addMessage({ key: { remoteJid: jid, id: 'OUT1', fromMe: true }, messageTimestamp: 1730000001, message: audio(4) }, { countUnread: true });
store.addMessage({ key: { remoteJid: jid, id: 'BAD', fromMe: false }, messageTimestamp: 1730000002, message: { audioMessage: { seconds: 3 } } }, { countUnread: true });
const list = store.messages(jid);
assert.deepStrictEqual(list.map((m) => [m.id, m.text, m.voice]), [['IN1', '[语音]', 23], ['OUT1', '[语音]', undefined], ['BAD', '[语音]', undefined]]);
assert(!JSON.stringify(list).includes(mediaKey.toString('base64')), '推给界面的消息里没有 mediaKey');
const v = store.voice(jid, 'IN1');
assert.deepStrictEqual({ ...v, mk: Buffer.from(v.mk, 'base64').equals(mediaKey) }, { mk: true, dp: '/v/t62.7117-24/abc.enc?ccb=11', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', s: 23 });
assert.strictEqual(store.voice(jid, 'OUT1'), null, '自己发的语音不记');
assert.strictEqual(store.voice(jid, 'BAD'), null, '没有下载信息的不记');
assert.strictEqual(voiceOf({ conversation: 'hi' }), null);
// 群里的语音记下是谁发的（手机重新上传时要用）
const gid = '120363000000000000@g.us';
store.addMessage({ key: { remoteJid: gid, id: 'G1', fromMe: false, participant: '33612345678@s.whatsapp.net' }, pushName: 'Claire', messageTimestamp: 1730000003, message: audio(9) }, { countUnread: false });
assert.strictEqual(store.voice(gid, 'G1').p, '33612345678@s.whatsapp.net');
// 加密写盘、重启还在
store.save.flush();
assert(!fs.readFileSync(path.join(tmp, 'chats.enc')).includes(Buffer.from(mediaKey.toString('base64'))), '写盘是加密的');
const again = new ChatStore(tmp, key, (e) => { throw e; });
assert.strictEqual(again.voice(jid, 'IN1').s, 23);
assert.strictEqual(again.messages(jid)[0].voice, 23);
// 删对话一起删
again.remove(gid);
assert.strictEqual(again.voice(gid, 'G1'), null);
// 上限
for (let i = 0; i < MAX_VOICES + 5; i += 1) again.addMessage({ key: { remoteJid: jid, id: `M${i}`, fromMe: false }, messageTimestamp: 1730001000 + i, message: audio(1) }, { countUnread: false });
assert.strictEqual(again.voices.size, MAX_VOICES);
again.save.cancel();

// 2) 下载
const posts = [];
const s = new Session({ id: 'x', proxy: 'socks5h://127.0.0.1:7891', dir: tmp, key: key.toString('hex'), os: 'win32' }, (m) => posts.push(m));
s.store = new ChatStore(tmp, key, (e) => { throw e; });
s.transport = { dispatcher: { name: 'proxy-dispatcher' } };
const calls = [];
let fail = 0;
const download = async (media, type, opts) => {
  calls.push({ media, type, opts });
  if (fail > 0) { fail -= 1; throw Object.assign(new Error('Failed to fetch stream'), { output: { statusCode: 410 } }); }
  return Readable.from([Buffer.from('OggS'), Buffer.from('-opus-bytes')]);
};
let bytes = await s.voice(jid, 'IN1', { download });
assert.strictEqual(bytes.toString(), 'OggS-opus-bytes');
assert.strictEqual(calls[0].type, 'audio');
assert(calls[0].media.mediaKey.equals(mediaKey));
assert.strictEqual(calls[0].media.directPath, '/v/t62.7117-24/abc.enc?ccb=11');
assert.strictEqual(calls[0].opts.options.dispatcher.name, 'proxy-dispatcher', '只走这个号自己的代理');
// 链接过期：请手机重新上传，换新地址再下
fail = 1;
calls.length = 0;
s.status = 'open';
const asked = [];
s.sock = { updateMediaMessage: async (m) => { asked.push(m); return { ...m, message: { audioMessage: { ...m.message.audioMessage, directPath: '/v/new.enc', url: 'https://mmg.whatsapp.net/v/new.enc' } } }; } };
bytes = await s.voice(jid, 'IN1', { download });
assert.strictEqual(bytes.toString(), 'OggS-opus-bytes');
assert.strictEqual(asked.length, 1);
assert.deepStrictEqual(asked[0].key, { remoteJid: jid, id: 'IN1', fromMe: false });
assert.deepStrictEqual(calls.map((c) => c.media.directPath), ['/v/t62.7117-24/abc.enc?ccb=11', '/v/new.enc']);
assert.strictEqual(s.store.voice(jid, 'IN1').dp, '/v/new.enc', '新地址记下来');
// 没连上时过期了：直接报错，不请手机重传
fail = 1;
s.status = 'reconnecting';
await assert.rejects(() => s.voice(jid, 'IN1', { download }));
// 找不到这条、太大
await assert.rejects(() => s.voice(jid, 'NOPE', { download }), /找不到这条语音/);
const huge = async () => Readable.from([Buffer.alloc(VOICE_MAX_BYTES), Buffer.alloc(10)]);
await assert.rejects(() => s.voice(jid, 'IN1', { download: huge }), /语音太大/);
s.store.save.cancel();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('轻量号语音自检通过（只记客户语音的下载信息、加密写盘、走账号代理下载、过期重传、大小上限）');
