// Server audit regressions with real handlers and in-memory SQLite. No external calls.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fakeD1 } from '../server/test/fake-d1.mjs';
import { handleAdmin } from '../server/src/admin.js';
import { uploadChats, pushCrm, CRM_MAX_UPLOAD } from '../server/src/crm.js';
const db = fakeD1(fileURLToPath(new URL('../server/migrations', import.meta.url)));
const id = () => crypto.randomUUID();
const group = id(), owner = id(), supervisor = id(), target = id(), device = id(), account = id();
db.raw.prepare('INSERT INTO groups(id,name) VALUES(?,?)').run(group, 'Test');
for (const [uid, role, email] of [[owner, 'owner', 'owner@example.test'], [supervisor, 'supervisor', 'sup@example.test'], [target, 'agent', 'target@example.test']]) {
  db.raw.prepare('INSERT INTO users(id,name,email,role,group_id,created_at) VALUES(?,?,?,?,?,0)').run(uid, role, email, role, group);
}
const admin = (email, user, body) => handleAdmin(new Request('https://test.invalid/api/admin/users/' + user, {
  method: 'PATCH', headers: { 'content-type': 'application/json', 'x-waswitch-admin': '1' }, body: JSON.stringify(body),
}), { DB: db }, '/api/admin/users/' + user, { email });
try {
  assert.equal((await admin('sup@example.test', target, { name: 'Allowed' })).status, 200);
  const prepare = db.prepare;
  for (const mutation of ['promotion', 'target-group', 'actor-role', 'actor-group', 'actor-disabled']) {
    db.raw.prepare("UPDATE users SET role='agent', group_id=?, disabled_at=NULL WHERE id=?").run(group, target);
    db.raw.prepare("UPDATE users SET role='supervisor', group_id=?, disabled_at=NULL WHERE id=?").run(group, supervisor);
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    let blocked = false;
    db.prepare = sql => {
      const stmt = prepare(sql);
      if (!blocked && sql.startsWith('UPDATE users SET disabled_at')) {
        blocked = true;
        const bind = stmt.bind.bind(stmt);
        stmt.bind = (...args) => {
          const bound = bind(...args), first = bound.first.bind(bound);
          bound.first = async () => { entered(); await wait; return first(); };
          return bound;
        };
      }
      return stmt;
    };
    const pending = admin('sup@example.test', target, { disabled: true });
    await ready;
    if (mutation === 'promotion') assert.equal((await admin('owner@example.test', target, { role: 'owner' })).status, 200);
    if (mutation === 'target-group') db.raw.prepare('UPDATE users SET group_id=NULL WHERE id=?').run(target);
    if (mutation === 'actor-role') db.raw.prepare("UPDATE users SET role='agent' WHERE id=?").run(supervisor);
    if (mutation === 'actor-group') db.raw.prepare('UPDATE users SET group_id=NULL WHERE id=?').run(supervisor);
    if (mutation === 'actor-disabled') db.raw.prepare('UPDATE users SET disabled_at=1 WHERE id=?').run(supervisor);
    release();
    assert.equal((await pending).status, 403, mutation);
    assert.equal(db.raw.prepare('SELECT disabled_at FROM users WHERE id=?').get(target).disabled_at, null, mutation);
    db.prepare = prepare;
  }
  console.log('PASS 7: supervisor commit-time authorization (5 interleavings + allowed update)');

  db.raw.prepare('INSERT INTO devices(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,0)').run(device, target, 'Device', 'synthetic-hash');
  db.raw.prepare('INSERT INTO wa_accounts(id,label,device_id,user_id,group_id,crm_sync,created_at,updated_at) VALUES(?,?,?,?,?,1,0,0)').run(account, 'Account', device, target, group);
  db.raw.prepare('INSERT INTO device_seats VALUES(?,?,1,0)').run(device, account);
  const received = [];
  const env = { DB: db, CRM_PUSH: '1', CRM_KEY: Buffer.alloc(32, 7).toString('base64'), LAICRM_SECRET: 'synthetic-signing-key-'.repeat(3),
    LAICRM: { fetch: async request => {
      const data = await request.json(); received.push(...data.messages);
      return Response.json({ results: data.messages.map(m => ({ id: m.id, status: 'stored' })) });
    } } };
  const items = Array.from({ length: 24 }, (_, i) => ({ k: 'TESTMSG' + String(i).padStart(6, '0'), peer: '15550000000', out: false, at: Date.now() - 1000 + i, approx: false, text: '你好🙂'.repeat(1200) }));
  const body = JSON.stringify({ v: 1, team_id: account, items });
  assert.ok(Buffer.byteLength(body) > 280 * 1024 && Buffer.byteLength(body) < CRM_MAX_UPLOAD);
  const answer = await uploadChats(new Request('https://test.invalid/api/device/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), env, { id: device });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).accepted, items.length);
  const batch = db.raw.prepare('SELECT * FROM crm_batches').get();
  assert.ok(batch.data.length > 300000 && !batch.data.includes('你好'));
  const key = await crypto.subtle.importKey('raw', Buffer.alloc(32, 7), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(batch.iv, 'base64'),
    additionalData: new TextEncoder().encode(batch.id + '|' + account + '|' + device) }, key, Buffer.from(batch.data, 'base64'));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), items);
  const pushed = await pushCrm(env);
  assert.equal(pushed.batches, 1);
  assert.deepEqual(received.map(m => m.text), items.map(m => m.text));
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM crm_batches').get().n, 0);
  console.log('PASS 3: near-limit Unicode upload, AES round-trip and split CRM delivery');
} finally { db.raw.close(); }
