// 轻量号的 CRM 采集：从一条 Baileys 消息里取出要同步的字段。
// 规则（审计要求）：
//   - 只收单聊；群、广播、频道、状态一律不收
//   - 按消息自带的时间判断：只收开关打开之后的消息（不看 upsert 的类型，手机发的消息有时是 append）
//   - 对方是 @lid（隐藏号码的编号）时，用 remoteJidAlt 或 Baileys 的 lid 映射找真实号码；找不到就跳过并计数
//   - 先拆开 ephemeral / viewOnce 的外层；表情回应、撤回 / 编辑、投票等不收
//   - 第一次开始采集时，把本机聊天缓存里最近 30 天的单聊补传一次（backfillItems），规则同上
import { toNumber } from './store.mjs';

const MAX_TEXT = 4000;
const PN_RE = /^(\d{6,20})(?::\d+)?@s\.whatsapp\.net$/;
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];
const IGNORE = new Set([
  'reactionMessage', 'encReactionMessage', 'protocolMessage', 'pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3',
  'pollUpdateMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'keepInChatMessage', 'pinInChatMessage', 'editedMessage',
]);
const PLACEHOLDER = {
  imageMessage: '[图片]', videoMessage: '[视频]', ptvMessage: '[视频]', audioMessage: '[语音]', documentMessage: '[文件]',
  stickerMessage: '[贴纸]', locationMessage: '[位置]', liveLocationMessage: '[位置]', contactMessage: '[名片]', contactsArrayMessage: '[名片]',
};

export function unwrap(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i += 1) {
    const w = WRAPPERS.find((k) => m[k] && m[k].message);
    if (!w) break;
    m = m[w].message;
  }
  return m || null;
}

// 返回文字；null = 这条不收（表情回应、撤回、投票等）
export function textOf(message) {
  const m = unwrap(message);
  if (!m) return null;
  if (typeof m.conversation === 'string' && m.conversation) return m.conversation.slice(0, MAX_TEXT);
  if (m.extendedTextMessage && typeof m.extendedTextMessage.text === 'string') return m.extendedTextMessage.text.slice(0, MAX_TEXT);
  const keys = Object.keys(m).filter((k) => m[k] && !IGNORE.has(k));
  if (!keys.length) return null;
  for (const k of keys) {
    if (!PLACEHOLDER[k]) continue;
    const caption = typeof m[k].caption === 'string' ? m[k].caption : '';
    return `${PLACEHOLDER[k]}${caption ? ` ${caption}` : ''}`.slice(0, MAX_TEXT);
  }
  return '[其它消息]';
}

// 对方的真实号码；拿不到返回 ''
async function peerNumber(key, pnForLid) {
  const jid = String(key.remoteJid || '');
  let m = PN_RE.exec(jid);
  if (m) return m[1];
  if (!jid.endsWith('@lid')) return '';
  m = PN_RE.exec(String(key.remoteJidAlt || ''));
  if (m) return m[1];
  if (!pnForLid) return '';
  try {
    m = PN_RE.exec(String((await pnForLid(jid)) || ''));
  } catch {
    return '';
  }
  return m ? m[1] : '';
}

const isOneToOne = (jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

// 返回 null（不收，也不计数）、{ skip: 'nonumber' }（单聊但认不出号码）或 { item }
export async function crmItem(msg, since, pnForLid) {
  if (!msg || !msg.key || !msg.key.id || !msg.message || !since) return null;
  const jid = String(msg.key.remoteJid || '');
  if (!isOneToOne(jid)) return null;
  const at = toNumber(msg.messageTimestamp) * 1000;
  if (!at || at < since) return null;
  const text = textOf(msg.message);
  if (text === null) return null;
  const peer = await peerNumber(msg.key, pnForLid);
  if (!peer) return { skip: 'nonumber' };
  return { item: { mid: String(msg.key.id).slice(0, 200), peer, out: !!msg.key.fromMe, at, text } };
}

// 本机聊天缓存（store.mjs 的 ChatStore）里的文字是给界面看的，换成和 textOf 一样的占位
const STORE_OTHER = '[暂不支持的消息，请在手机上查看]';

// 补传：本机缓存里 since 之后的单聊消息。store: { msgs: Map(jid -> [{ id, me, ts, text }]), altPn, nameOf(jid) }。
// 返回 { items, skipped }（skipped = 单聊但认不出号码的条数）。每条带上对方的 WhatsApp 名字
export async function backfillItems(store, since, pnForLid) {
  const items = [];
  let skipped = 0;
  if (!store || !store.msgs || !since) return { items, skipped };
  for (const [jid, list] of store.msgs) {
    if (!isOneToOne(String(jid)) || !Array.isArray(list)) continue;
    const recent = list.filter((m) => m && m.id && Number(m.ts) * 1000 >= since && typeof m.text === 'string');
    if (!recent.length) continue;
    const peer = await peerNumber({ remoteJid: jid, remoteJidAlt: store.altPn && store.altPn.get(jid) }, pnForLid);
    if (!peer) { skipped += recent.length; continue; }
    const name = (store.nameOf && (store.nameOf(jid) || store.nameOf(`${peer}@s.whatsapp.net`))) || '';
    for (const m of recent) {
      const text = m.text === STORE_OTHER ? '[其它消息]' : m.text.slice(0, MAX_TEXT);
      if (!text) continue;
      items.push({ mid: String(m.id).slice(0, 200), peer, out: !!m.me, at: Number(m.ts) * 1000, text, ...(name ? { name } : {}) });
    }
  }
  return { items, skipped };
}
