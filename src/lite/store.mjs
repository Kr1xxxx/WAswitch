// 轻量模式的聊天缓存：只存文字和类型说明（图片、语音等显示成“[图片]”），不下载媒体。
// 每个对话最多保留 500 条，加密后写盘（见 vault.mjs）。
import path from 'node:path';
import { getContentType, normalizeMessageContent, isJidGroup, isJidBroadcast, isJidNewsletter, jidNormalizedUser, proto } from 'baileys';
import { readSealed, writeSealed, debounced } from './vault.mjs';

export const MAX_PER_CHAT = 500;
const MAX_UNREAD_KEYS = 50;
export const MAX_NAMES = 2000; // 联系人名称最多记这么多（通讯录很大时不会整个写盘）
export const MAX_SENT = 50; // 自己发出的消息保留原文，对方没收到、请求重发时用

// 不显示的对话：状态、广播、频道
export const ignoredJid = (jid) => !jid || isJidBroadcast(jid) || isJidNewsletter(jid);

export const toNumber = (t) => {
  if (t === null || t === undefined) return 0;
  if (typeof t === 'object') return typeof t.toNumber === 'function' ? t.toNumber() : Number(t.low || 0);
  return Number(t) || 0;
};

const LABELS = {
  imageMessage: '[图片]',
  videoMessage: '[视频]',
  ptvMessage: '[视频]',
  audioMessage: '[语音]',
  documentMessage: '[文件]',
  documentWithCaptionMessage: '[文件]',
  stickerMessage: '[贴纸]',
  contactMessage: '[名片]',
  contactsArrayMessage: '[名片]',
  locationMessage: '[位置]',
  liveLocationMessage: '[实时位置]',
  pollCreationMessage: '[投票]',
  pollCreationMessageV2: '[投票]',
  pollCreationMessageV3: '[投票]',
  eventMessage: '[活动]',
};
// 不算一条消息的类型（回执、反应、撤回通知、密钥分发等）
const SKIP = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage', 'encReactionMessage']);

// 消息 → 要显示的文字；不显示的返回 null
export function textOf(message) {
  const content = normalizeMessageContent(message);
  if (!content) return null;
  const type = getContentType(content);
  if (!type || SKIP.has(type)) return null;
  const m = content[type];
  if (type === 'conversation') return String(m || '');
  if (type === 'extendedTextMessage') return String(m?.text || '');
  const label = LABELS[type] || '[暂不支持的消息，请在手机上查看]';
  const extra = m?.caption || m?.fileName || m?.name || '';
  return extra ? `${label} ${extra}` : label;
}

export class ChatStore {
  constructor(dir, key, onError) {
    this.file = path.join(dir, 'chats.enc');
    this.key = key;
    this.chats = new Map(); // jid -> { jid, name, unread, ts, preview }
    this.msgs = new Map(); // jid -> [{ id, me, ts, text, from }]
    this.names = new Map(); // jid -> 联系人名称
    this.unreadKeys = new Map(); // jid -> 未读消息的 key（发已读回执用，不写盘）
    this.sent = new Map(); // 消息 id -> 自己发出的消息原文（protobuf，base64），最近 MAX_SENT 条
    this.save = debounced(() => {
      try { writeSealed(this.file, this.key, this.toJSON()); } catch (e) { onError(e); }
    }, 10000);
    const data = readSealed(this.file, key);
    if (data) {
      for (const c of data.chats || []) this.chats.set(c.jid, c);
      for (const [jid, list] of data.msgs || []) this.msgs.set(jid, list);
      for (const [jid, name] of (data.names || []).slice(-MAX_NAMES)) this.names.set(jid, name);
      for (const [id, b64] of data.sent || []) this.sent.set(id, b64);
    }
  }

  toJSON() {
    return { chats: [...this.chats.values()], msgs: [...this.msgs.entries()], names: [...this.names.entries()], sent: [...this.sent.entries()] };
  }

  chat(jid) {
    let c = this.chats.get(jid);
    if (!c) { c = { jid, name: '', unread: 0, ts: 0, preview: '' }; this.chats.set(jid, c); }
    return c;
  }

  nameOf(jid) {
    const c = this.chats.get(jid);
    return (c && c.name) || this.names.get(jid) || this.names.get(jidNormalizedUser(jid)) || '';
  }

  setName(jid, name) {
    if (!jid || !name) return;
    const value = String(name).slice(0, 80);
    if (this.names.get(jid) === value) return;
    this.names.delete(jid); // 重新放到最后，超出上限时先删最久没更新的
    this.names.set(jid, value);
    if (this.names.size > MAX_NAMES) this.names.delete(this.names.keys().next().value);
    this.save.schedule();
  }

  // 来自 chats.upsert / chats.update / 历史同步
  updateChat(c) {
    if (ignoredJid(c.id)) return;
    const chat = this.chat(c.id);
    if (c.name || c.subject) chat.name = String(c.name || c.subject).slice(0, 80);
    if (typeof c.unreadCount === 'number') {
      chat.unread = Math.max(0, c.unreadCount);
      if (!chat.unread) this.unreadKeys.delete(c.id);
    }
    const ts = toNumber(c.conversationTimestamp);
    if (ts > chat.ts) chat.ts = ts;
    this.save.schedule();
  }

  // 加一条消息；返回 { jid, added, incoming } 或 null
  addMessage(msg, { countUnread }) {
    const key = msg.key || {};
    const jid = key.remoteJid;
    if (ignoredJid(jid) || !key.id) return null;
    const text = textOf(msg.message);
    if (text === null) return null;
    const list = this.msgs.get(jid) || [];
    if (list.some((m) => m.id === key.id)) return { jid, added: false };
    const group = isJidGroup(jid);
    const sender = key.participant || '';
    if (msg.pushName && !key.fromMe) this.setName(group ? sender : jid, msg.pushName);
    const item = {
      id: key.id,
      me: !!key.fromMe,
      ts: toNumber(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      text: text.slice(0, 4000),
      from: group && !key.fromMe ? (msg.pushName || this.names.get(sender) || '') : '',
    };
    list.push(item);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
    this.msgs.set(jid, list);
    const chat = this.chat(jid);
    if (item.ts >= chat.ts) { chat.ts = item.ts; chat.preview = (item.from ? `${item.from}：` : '') + item.text.slice(0, 120); }
    const incoming = countUnread && !key.fromMe;
    if (incoming) {
      chat.unread += 1;
      const keys = this.unreadKeys.get(jid) || [];
      keys.push({ remoteJid: jid, id: key.id, participant: key.participant || undefined });
      if (keys.length > MAX_UNREAD_KEYS) keys.splice(0, keys.length - MAX_UNREAD_KEYS);
      this.unreadKeys.set(jid, keys);
    }
    if (key.fromMe) { chat.unread = 0; this.unreadKeys.delete(jid); }
    this.save.schedule();
    return { jid, added: true, incoming };
  }

  // 记下自己发出的消息原文（对方解密失败、请求重发时，Baileys 通过 getMessage 取）
  rememberSent(id, message) {
    if (!id || !message) return;
    this.sent.set(id, Buffer.from(proto.Message.encode(message).finish()).toString('base64'));
    if (this.sent.size > MAX_SENT) this.sent.delete(this.sent.keys().next().value);
    this.save.schedule();
  }

  sentMessage(id) {
    const b64 = this.sent.get(id);
    return b64 ? proto.Message.decode(Buffer.from(b64, 'base64')) : undefined;
  }

  // 标记已读，返回要发已读回执的消息 key
  takeUnread(jid) {
    const chat = this.chats.get(jid);
    const keys = this.unreadKeys.get(jid) || [];
    this.unreadKeys.delete(jid);
    if (chat && chat.unread) { chat.unread = 0; this.save.schedule(); }
    return keys;
  }

  unreadChats() {
    let n = 0;
    for (const c of this.chats.values()) if (c.unread > 0) n += 1;
    return n;
  }

  summary(limit = 300) {
    return [...this.chats.values()]
      .filter((c) => c.ts || c.preview)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map((c) => ({ jid: c.jid, name: this.nameOf(c.jid) || shortJid(c.jid), unread: c.unread, ts: c.ts, preview: c.preview, group: isJidGroup(c.jid) }));
  }

  messages(jid, limit = 200) {
    return (this.msgs.get(jid) || []).slice(-limit);
  }

  remove(jid) {
    this.chats.delete(jid);
    this.msgs.delete(jid);
    this.unreadKeys.delete(jid);
    this.save.schedule();
  }
}

// 没有名字时显示号码部分（群显示“群聊”）
export function shortJid(jid) {
  if (isJidGroup(jid)) return '群聊';
  const user = String(jid).split('@')[0].split(':')[0];
  return jid.endsWith('@s.whatsapp.net') ? `+${user}` : user;
}
