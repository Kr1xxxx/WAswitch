// Real isolated Electron DOM tests for audited composer and clipboard races.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron');
const waPage = require('../src/wa-page');
const { createDraftPlacer } = require('../src/draft-place');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1000, height: 720, webPreferences: { sandbox: true, contextIsolation: true } });
  const page = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.join(__dirname, 'fixtures/lite-draft.html'));
    await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '../src/shell/shell.css'), 'utf8'));
    await page(`(() => {
      window.fixture = makeLitePage('audit');
      document.body.append(fixture.el);
      window.chats = [{ jid: 'A', name: 'Test customer A' }, { jid: 'B', name: 'Test customer B' }];
      window.openChat = jid => fixture.update({}, { status: 'open', openJid: jid, view: { rev: Date.now(), jid, chats, messages: [] } });
      window.box = () => document.querySelector('textarea');
      window.typeDraft = text => { box().value = text; box().dispatchEvent(new Event('input')); };
      window.wa.liteOpen = (_id, jid) => openChat(jid);
      window.wa.liteSend = (id, jid, text) => {
        window.__sent.push({ id, jid, text });
        return new Promise((resolve, reject) => { window.finishSend = resolve; window.failSend = reject; });
      };
      window.sendDraft = () => document.querySelector('.lite-compose button').click();
      openChat('A'); typeDraft('draft for A');
      document.querySelectorAll('.lite-chat')[1].click();
      return true;
    })()`);
    assert.equal(await page('box().value'), '', 'B must not inherit A draft');
    await page("typeDraft('draft for B'); openChat('A'); true");
    assert.equal(await page('box().value'), 'draft for A');
    await page("sendDraft(); typeDraft('new A while sending'); finishSend({}); true");
    assert.equal(await page('box().value'), 'new A while sending', 'completion preserves newer edit');
    await page("sendDraft(); openChat('B'); typeDraft('new B while A sends'); finishSend({}); true");
    assert.equal(await page('box().value'), 'new B while A sends', 'completion preserves other chat');
    await page("openChat('A'); true");
    assert.equal(await page('box().value'), '', 'unchanged submitted A draft clears while away');
    await page("typeDraft('retry A'); sendDraft(); failSend(new Error('synthetic')); true");
    assert.equal(await page('box().value'), 'retry A');
    assert.equal(await page("document.querySelector('.lite-compose button').disabled"), false);
    assert.ok(await page("document.querySelector('.lite-err').textContent"));
    await page("sendDraft(); finishSend({}); true");
    assert.equal(await page('box().value'), '');
    await page("typeDraft('tail'); sendDraft(); box().value += 'x'; box().dispatchEvent(new Event('input')); finishSend({}); true");
    assert.equal(await page('box().value'), 'x', 'sent text must not stay in the box when typing appends during send');
    await page("typeDraft('lost'); sendDraft(); typeDraft('newer'); failSend(new Error('synthetic')); true");
    assert.equal(await page('box().value'), 'newer', 'failed send must not overwrite newer input');
    await page("typeDraft(''); openChat('B'); openChat('A'); true");
    assert.equal(await page('box().value'), '');
    assert.ok((await page('window.__sent')).every(x => x.jid === 'A'));
    console.log('PASS 1/5: actual lite composer, chat click, drafts, pending sends and failed retry');
    await page("openChat('B'); true");
    if (process.env.WASWITCH_AUDIT_SCREENSHOT) fs.writeFileSync(process.env.WASWITCH_AUDIT_SCREENSHOT, (await win.webContents.capturePage()).toPNG());

    await win.loadFile(path.join(__dirname, 'fixtures/wa-compose.html'));
    const wc = win.webContents;
    await page("document.getElementById('compose').focus(); true");
    let pasteCount = 0;
    const originalPaste = wc.paste.bind(wc);
    wc.paste = () => { pasteCount++; originalPaste(); };
    const deps = {
      findAcc: () => ({ id: 'a' }), isLite: () => false, autoBlock: () => '', stillShown: () => true,
      webContents: () => wc, waPage, ClipboardItem, request: () => null, setRequest() {},
      clipboard: { read: () => clipboard.read(), readText: () => clipboard.readText(), clear: () => clipboard.clear(),
        write: data => clipboard.write(data),
        writeText: async text => {
          await clipboard.writeText(text);
          await page("document.querySelector('[data-id]').setAttribute('data-id', 'false_19999999999@c.us_CHANGED'); true");
        } },
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    };
    const p = createDraftPlacer(deps);
    const result = await p.place({ accountId: 'a', chat: 'Anna Müller', text: 'private A draft' });
    assert.equal(result.result, 'pending');
    assert.equal(pasteCount, 0);
    assert.equal(await page("document.getElementById('compose').textContent"), '');
    assert.equal(wc.listenerCount('input-event'), 0);
    console.log('PASS 8: actual DOM switch with unchanged title during clipboard write prevents native paste');
    const reader = require('../src/read-messages').createMessageReader({ findAcc: () => ({ id: 'a' }), isLite: () => false, webContents: () => wc, waPage });
    const target = await reader.locateChat('a', 'Anna Müller');
    assert.ok(target.ok);
    await page("document.querySelector('[data-id]').setAttribute('data-id', 'false_18888888888@c.us_CHANGED'); true");
    assert.equal((await reader.readMessages('a', { ...target, limit: 20 })).reason, 'changed');
    console.log('PASS 6: actual DOM conversation identifier blocks same-title message read');

    // Missing title selectors still leave a verifiable message conversation ID.
    await page("document.querySelector('#main header').innerHTML = '<strong>Customer</strong>'; true");
    for (const jid of ['15550000000@c.us', '15550000000@s.whatsapp.net', '123456@g.us', '123456@lid']) {
      await page(`document.querySelector('[data-id]').setAttribute('data-id', ${JSON.stringify('false_' + jid + '_READ')}); true`);
      const located = await reader.locateChat('a', '');
      assert.equal(located.ok, true, jid);
      const read = await reader.readMessages('a', { ...located, limit: 20 });
      assert.equal(read.ok, true, jid + ' missing title');
      assert.equal(read.messages[0].text, 'Is the M size still available?');
      assert.equal(read.title, located.title, 'same fallback in confirmation and result');
      await page("document.querySelector('[data-id]').setAttribute('data-id', 'false_19999999999@lid_CHANGED'); true");
      assert.equal((await reader.readMessages('a', { ...located, limit: 20 })).reason, 'changed', jid);
      await page("document.querySelector('[data-id]').setAttribute('data-id', 'unrecognized'); true");
      assert.equal((await reader.readMessages('a', { ...located, limit: 20 })).reason, 'changed');
      assert.equal((await reader.locateChat('a', '')).ok, false);
    }
    console.log('PASS 6 follow-up: real DOM missing titles read correctly; changed/missing identities reject');

    await win.loadFile(path.join(__dirname, 'fixtures/wa-compose.html'));
    await page("document.getElementById('compose').focus(); true");
    await clipboard.writeText('original clipboard');
    let typed = false;
    let keyEvents = 0;
    const onKey = () => { keyEvents++; };
    wc.on('before-input-event', onKey);
    const typingPlacer = createDraftPlacer({ ...deps, clipboard,
      wait: async ms => {
        await new Promise(resolve => setTimeout(resolve, ms));
        if (!typed) {
          assert.equal(await page("document.getElementById('compose').textContent"), 'draft then type');
          typed = true;
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'X' });
          wc.sendInputEvent({ type: 'char', keyCode: 'x' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'X' });
          await page('true');
        }
      },
    });
    assert.deepEqual(await typingPlacer.place({ accountId: 'a', chat: 'Anna Müller', text: 'draft then type' }), { result: 'placed' });
    assert.ok(typed && keyEvents > 0, 'native typing occurred before confirmation');
    assert.equal(await page("document.getElementById('compose').textContent"), 'draft then typex');
    assert.equal(await clipboard.readText(), 'original clipboard');
    assert.deepEqual(await page('window.__ev.sent'), [], 'no messages sent');
    wc.removeListener('before-input-event', onKey);
    assert.equal(wc.listenerCount('before-input-event'), 0);
    console.log('PASS 8 follow-up: native paste then native typing confirms and restores clipboard');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
