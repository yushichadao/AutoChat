import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, dedupeKey, extractAtUsers, stripSenderPrefix } from '../src/protocol/normalize.js';

test('平铺结构可归一化', () => {
  const msg = normalizeMessage({ msgid: 'm1', wxid: 'wxid_a', content: 'hello', type: 1, createTime: 1700000000 });
  assert.equal(msg.chatType, 'private');
  assert.equal(msg.chatId, 'wxid_a');
  assert.equal(msg.senderId, 'wxid_a');
  assert.equal(msg.text, 'hello');
  assert.equal(msg.kind, 'text');
});

test('data 包裹结构可归一化', () => {
  const msg = normalizeMessage({ type: 1, data: { msgid: 'm2', from: 'wxid_b', msg: 'hi' } });
  assert.equal(msg.senderId, 'wxid_b');
  assert.equal(msg.text, 'hi');
});

test('带 roomid 判定为群聊', () => {
  const msg = normalizeMessage({ wxid: 'wxid_c', roomid: '123@chatroom', content: '群消息' });
  assert.equal(msg.chatType, 'group');
  assert.equal(msg.chatId, '123@chatroom');
});

test('自己发的消息被过滤', () => {
  const msg = normalizeMessage({ wxid: 'wxid_self', content: 'x' }, { selfId: 'wxid_self' });
  assert.equal(msg, null);
});

test('图片消息收集路径', () => {
  const msg = normalizeMessage({ wxid: 'wxid_d', type: 3, file: 'C:/tmp/a.dat' });
  assert.equal(msg.kind, 'image');
  assert.deepEqual(msg.images, ['C:/tmp/a.dat']);
});

test('XML 内容识别为卡片', () => {
  const msg = normalizeMessage({ wxid: 'wxid_e', type: 49, content: '<msg><appmsg /></msg>' });
  assert.equal(msg.kind, 'xml');
});

test('缺少发送者与内容时返回 null', () => {
  assert.equal(normalizeMessage({}), null);
  assert.equal(normalizeMessage(null), null);
});

test('去重键包含会话、发送者、消息 id', () => {
  const msg = normalizeMessage({ msgid: 'm9', wxid: 'wxid_f', content: 'z' });
  assert.equal(dedupeKey(msg), 'wxid_f|wxid_f|m9');
});

test('XML 里的结构化 @ 会被解析出来', () => {
  const xml =
    '<msg><atuserlist><atuser wxid="wxid_me" /><atuser wxid="wxid_you" /></atuserlist></msg>';
  assert.deepEqual(extractAtUsers(xml), ['wxid_me', 'wxid_you']);

  const msg = normalizeMessage({ wxid: 'wxid_me', type: 49, content: xml });
  assert.deepEqual(msg.atUsers, ['wxid_me', 'wxid_you']);
});

test('群名会被抽出来，供 prompt 使用', () => {
  const msg = normalizeMessage({
    wxid: 'wxid_g',
    roomid: '123@chatroom',
    roomName: '产品交流群',
    content: 'hi',
  });
  assert.equal(msg.chatName, '产品交流群');
});

test('群消息正文里的 wxid 前缀会被剥掉', () => {
  assert.equal(stripSenderPrefix('wxid_abc123:\n你好'), '你好');
  // 本地库里群消息的前缀和正文在同一行（"wxid_xxx:内容"），
  // 不剥的话模型会把 wxid 当成内容抄进回复里（实测踩过）。
  assert.equal(stripSenderPrefix('wxid_abc123:你好'), '你好');
  assert.equal(stripSenderPrefix('wxid_abc123:\n在吗'), '在吗');
  // 不是前缀就别乱剥
  assert.equal(stripSenderPrefix('你好'), '你好');
  assert.equal(stripSenderPrefix('这里提到 wxid_abc123:xxx 但不是开头'), '这里提到 wxid_abc123:xxx 但不是开头');
  const msg = normalizeMessage({ wxid: 'wxid_g', roomid: '1@chatroom', content: 'wxid_abc123:\n在吗' });
  assert.equal(msg.text, '在吗');
});
