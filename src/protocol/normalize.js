/**
 * 不同 hook DLL 推上来的消息字段差别很大（wxid / from / fromUser，content / msg / text，
 * roomid / roomId / conversationId…），这里做一次性归一化，
 * 上层只认 NormalizedMessage，不再关心具体厂商。
 *
 * 额外抽出两个对 AI 很关键的字段：
 *  - chatName：群名 / 对方昵称（不知道在跟谁聊，模型就只能说套话）
 *  - atUsers：结构化 @ 列表（部分 DLL 推 XML，从 <atuserlist> 里解析）
 */
import { decodeDbContent } from './db-decode.js';

const SENDER_KEYS = ['wxid', 'from', 'fromUser', 'from_user', 'sender', 'senderId', 'sender_wxid', 'talker'];
const ROOM_KEYS = ['roomid', 'roomId', 'room_id', 'conversationId', 'chatroom', 'chatRoomName', 'to_wxid_group'];
const CONTENT_KEYS = ['content', 'msg', 'text', 'message', 'body'];
const ID_KEYS = ['msgid', 'msgId', 'msg_id', 'id', 'MsgSvrID', 'serverId'];
const TIME_KEYS = ['createTime', 'create_time', 'time', 'timestamp', 'CreateTime'];
const NAME_KEYS = ['senderName', 'sender_name', 'nickname', 'fromNick', 'roomNickName', 'pushContent'];
/** 群名 / 会话名 */
const CHAT_NAME_KEYS = [
  'roomName',
  'room_name',
  'chatRoomName',
  'chatroomName',
  'chatroom_name',
  'groupName',
  'group_name',
  'talkerName',
  'talker_name',
  'peerName',
  'peer_name',
  'chatName',
  'chat_name',
  'remark',
  'conversationName',
];

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

/** DLL 推送常把业务字段包在 data / message / Msg 里，逐层展开找一个含有“发送者 + 内容”的对象。 */
function unwrap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hasMsg = pick(raw, CONTENT_KEYS) !== undefined && pick(raw, SENDER_KEYS) !== undefined;
  if (hasMsg) return raw;
  for (const key of ['data', 'message', 'msg', 'Msg', 'payload', 'result']) {
    const inner = raw[key];
    if (inner && typeof inner === 'object') {
      const found = unwrap(inner);
      if (found) return found;
    }
  }
  return raw;
}

const TYPE_MAP = {
  1: 'text',
  3: 'image',
  34: 'voice',
  37: 'friend_request',
  42: 'card',
  43: 'video',
  47: 'emoji',
  48: 'location',
  49: 'xml',
  10000: 'system',
  10002: 'system',
};

/** 从微信 XML 消息里取结构化 @ 列表：<atuserlist><atuser wxid="..."/></atuserlist> */
export function extractAtUsers(xml) {
  const s = String(xml || '');
  if (!s.includes('<atuserlist')) return [];
  const out = [];
  const re = /<atuser\s+wxid="([^"]+)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 从 XML 里取 <title>（应用消息标题），没有就返回空串。 */
export function extractXmlTitle(xml) {
  const s = String(xml || '');
  const m = /<title>([\s\S]*?)<\/title>/i.exec(s);
  return m ? m[1].trim() : '';
}

/**
 * 有些 DLL 推的群消息正文形如 "wxid_xxx:\n你好"，
 * 把这层前缀剥掉，否则模型会看到一串 wxid。
 *
 * 本地库里更常见的是 "wxid_xxx:你好"（同一行），所以换行可有可无。
 */
export function stripSenderPrefix(text) {
  const s = String(text || '');
  const m = /^wxid_[A-Za-z0-9_-]{4,}:[ \t]*(?:\r?\n)?([\s\S]*)$/.exec(s);
  return m ? m[1] : s;
}

/**
 * @returns {{id,chatType,chatId,chatName,senderId,senderName,text,images,files,kind,atUsers,time,raw}|null}
 */
export function normalizeMessage(raw, { selfId = '', selfMode = 'sender' } = {}) {
  const node = unwrap(raw);
  if (!node) return null;

  const senderId = String(pick(node, SENDER_KEYS) ?? '');
  const roomId = String(pick(node, ROOM_KEYS) ?? '');
  const rawContent = pick(node, CONTENT_KEYS);
  if (!senderId && rawContent === undefined) return null;
  // sender 模式：本机 wxid 发的直接丢掉（手机电脑同号、群里只有别人说话时用）。
  // id 模式不能在这里丢 —— 提问的人就是本机账号，得靠 id 精确过滤，见 bridge/self-filter.js。
  if (selfMode !== 'id' && senderId && selfId && senderId === selfId) return null;

  const numericType = Number(pick(node, ['type', 'msgType', 'msg_type', 'Type']) ?? 0);
  let kind = TYPE_MAP[numericType] || 'text';
  let content = rawContent === undefined ? '' : typeof rawContent === 'string' ? rawContent : String(rawContent);
  let atUsers = [];
  if (/^<msg[\s>]/i.test(content)) {
    kind = 'xml';
    atUsers = extractAtUsers(content);
    const title = extractXmlTitle(content);
    if (title) content = title;
  } else if (kind === 'text') {
    content = stripSenderPrefix(content);
  }

  const isGroup = Boolean(roomId) || /@chatroom$/i.test(senderId);
  const chatId = isGroup ? roomId || senderId : senderId;

  const images = [];
  if (kind === 'image') {
    const p = pick(node, ['file', 'path', 'image', 'thumb', 'filePath']);
    if (typeof p === 'string' && p) images.push(p);
  }

  const chatName = String(pick(node, CHAT_NAME_KEYS) ?? '');

  return {
    id: String(pick(node, ID_KEYS) ?? `${chatId}:${senderId}:${hashText(content)}`),
    chatType: isGroup ? 'group' : 'private',
    chatId,
    chatName,
    senderId,
    senderName: String(pick(node, NAME_KEYS) ?? senderId),
    text: content,
    images,
    files: [],
    kind,
    atUsers,
    time: Number(pick(node, TIME_KEYS) ?? 0) || Math.floor(Date.now() / 1000),
    raw: node,
  };
}

/** 轮询 SQL 返回的行归一化：SQL 别名按约定命名（wxid/content/roomid/msgid/createTime）。 */
export function normalizeDbRow(row, opts) {
  if (!row || typeof row !== 'object') return null;
  const node = { ...row };
  // 库里 content 可能是明文 / hex / zstd，先还原成可读文本
  for (const k of CONTENT_KEYS) {
    if (typeof node[k] === 'string') node[k] = decodeDbContent(node[k]);
  }
  return normalizeMessage(node, opts);
}

export function dedupeKey(m) {
  return `${m.chatId}|${m.senderId}|${m.id}`;
}

/** 内容指纹：无 msgid 时用作去重键的一部分，避免 Date.now() 导致同一条消息每次都判为新。 */
function hashText(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
