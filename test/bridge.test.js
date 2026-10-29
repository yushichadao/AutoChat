import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeDbContent } from '../src/protocol/db-decode.js';
import { chatTable, buildPollSql, buildRowSql, buildPollPlan } from '../src/bridge/poll-sql.js';
import { SelfFilter } from '../src/bridge/self-filter.js';
import { PauseState, PidFile, shouldYieldToExisting } from '../src/core/pause.js';
import { Memory } from '../src/ai/memory.js';

test('库里的 content：明文原样返回', () => {
  assert.equal(decodeDbContent('你好呀'), '你好呀');
  assert.equal(decodeDbContent('<msg><appmsg>...</appmsg></msg>'), '<msg><appmsg>...</appmsg></msg>');
  assert.equal(decodeDbContent(''), '');
});

test('库里的 content：十六进制能还原成文本', () => {
  const hex = Buffer.from('1+1 等于几', 'utf8').toString('hex');
  assert.equal(decodeDbContent(hex), '1+1 等于几');
});

test('库里的 content：看着像 hex 但解出来不是人话，就保持原文', () => {
  // '1234' 是合法 hex，但解出来是控制字符 —— 必须当原文
  assert.equal(decodeDbContent('1234'), '1234');
  assert.equal(decodeDbContent('deadbeef'), 'deadbeef');
});

test('库里的 content：zstd 压缩帧能解开', (t) => {
  if (typeof zlib.zstdCompressSync !== 'function') return t.skip('Node 不带 zstd');
  const zstd = zlib.zstdCompressSync(Buffer.from('压缩之后的正文', 'utf8'));
  const hex = zstd.toString('hex');
  assert.equal(decodeDbContent(hex), '压缩之后的正文');
});

test('会话分表名 = Msg_ + md5(会话id)', () => {
  // 微信把每个会话的消息存在这张表里
  assert.equal(chatTable('59074288439@chatroom'), 'Msg_796a1139482a98c39c08ec15b122cf9d');
});

test('轮询批次只取 local_id；单行明细取完整内容', () => {
  // 批次只取主键：hook 对「多列 + message_content + WHERE」查询会返回空，
  // 因此批次严禁选 message_content / JOIN，正文靠 buildRowSql 逐条取。
  // 类型过滤需含文件(49)/图片(3)/语音(34)/视频(43)/表情(47)+文本(1)，否则文件类消息进不来。
  const batch = buildPollSql('123@chatroom', 20);
  assert.match(batch, /SELECT local_id FROM/);
  assert.match(batch, /local_type IN \(1,3,34,43,47,49\)/);
  assert.match(batch, /LIMIT 20/);
  assert.ok(!/message_content/.test(batch), '批次不能选 message_content');
  assert.ok(!/Name2Id/.test(batch), '批次不能 JOIN');

  const row = buildRowSql('123@chatroom', 7);
  assert.ok(row, '合法 id 应有 SQL');
  assert.match(row, /AS msgid/);
  assert.match(row, /AS rid/);
  assert.match(row, /AS content/);
  assert.match(row, /WHERE local_id = 7/);
  assert.equal(buildRowSql('123@chatroom', NaN), null, '非法 id 应返回 null');
});

test('轮询计划逐个会话生成', () => {
  const plan = buildPollPlan(['1@chatroom', '', 'wxid_x'], { limit: 5 });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].chatId, '1@chatroom');
  assert.ok(plan[0].table.startsWith('Msg_'));
  assert.equal(plan[1].chatId, 'wxid_x');
});

test('自消息判定：sender 模式按 wxid 挡', () => {
  const f = new SelfFilter({ mode: 'sender', selfId: 'wxid_me' });
  assert.equal(f.isSelfMessage({ chatId: 'c', id: '1', senderId: 'wxid_me' }), true);
  assert.equal(f.isSelfMessage({ chatId: 'c', id: '2', senderId: 'wxid_other' }), false);
});

test('自消息判定：id 模式只挡登记过的 id（同号场景的关键）', () => {
  const f = new SelfFilter({ mode: 'id', selfId: 'wxid_me' });
  // 同号：提问的人也是本机 wxid，必须放行
  assert.equal(f.isSelfMessage({ chatId: 'c', id: '10', senderId: 'wxid_me', text: '在吗' }), false);
  f.markSent('c', [11]);
  assert.equal(f.isSelfMessage({ chatId: 'c', id: '11', senderId: 'wxid_me', text: '机器人的回复' }), true);
});

test('自消息判定：内容回声兜底', () => {
  const f = new SelfFilter({ mode: 'id', selfId: 'wxid_me' });
  f.rememberOutgoing('c', '这是刚发出去的话');
  assert.equal(f.isSelfMessage({ chatId: 'c', id: '99', senderId: 'wxid_me', text: '这是刚发出去的话' }), true);
  assert.equal(f.isSelfMessage({ chatId: 'c', id: '98', senderId: 'wxid_me', text: '别的话' }), false);
});

test('暂停状态：哨兵文件存在即暂停，删掉即恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-switch-'));
  const file = path.join(dir, 'paused');
  const sw = new PauseState({ file });

  assert.equal(sw.isPaused(), false);
  assert.equal(sw.pause('测试').ok, true);
  assert.equal(sw.isPaused(), true);
  assert.match(sw.status().reason, /测试/);
  assert.equal(sw.resume().ok, true);
  assert.equal(sw.isPaused(), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pid 文件：写入、读回、清空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-pid-'));
  const pid = new PidFile({ file: path.join(dir, 'autochat.pid') });
  pid.write(4321);
  assert.equal(pid.read(), 4321);
  pid.clear();
  assert.equal(pid.read(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('单实例保护：已有活实例就让位，死实例就接管', () => {
  // 上一个实例还活着 → 本实例退出
  assert.equal(shouldYieldToExisting(1234, 5678, true), true);
  // 上一个实例已经死了 → 本实例接管
  assert.equal(shouldYieldToExisting(1234, 5678, false), false);
  // pid 文件是空的 / 非法 → 直接接管
  assert.equal(shouldYieldToExisting(0, 5678, true), false);
  assert.equal(shouldYieldToExisting('', 5678, true), false);
  assert.equal(shouldYieldToExisting(undefined, 5678, true), false);
  // 就是自己（重启时 pid 文件里可能还是自己）→ 不让位
  assert.equal(shouldYieldToExisting(5678, 5678, true), false);
});

test('上下文：字符预算超了就从最早的开始丢', () => {
  const m = new Memory({ maxTurns: 10, ttlMs: 0, maxChars: 20 });
  m.push('c', 'user', '1234567890');
  m.push('c', 'assistant', '1234567890');
  m.push('c', 'user', '最后一句');
  const hist = m.history('c');
  assert.ok(hist.length < 3, '超预算的历史应该被裁掉');
  assert.equal(hist[hist.length - 1].content, '最后一句');
});

test('上下文：重启后还在（落盘）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-mem-'));
  const file = path.join(dir, 'ai-memory.json');
  const m1 = new Memory({ maxTurns: 4, ttlMs: 0, file });
  m1.push('c', 'user', '记得我');
  m1.flush();

  const m2 = new Memory({ maxTurns: 4, ttlMs: 0, file });
  assert.equal(m2.history('c')[0].content, '记得我');
  fs.rmSync(dir, { recursive: true, force: true });
});
