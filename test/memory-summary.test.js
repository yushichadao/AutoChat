import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemorySummary, extractiveSummary } from '../src/ai/memory-summary.js';

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ms-'));
  return path.join(dir, name);
}

test('extractiveSummary 把转录分类为事实 / 偏好 / 事件', () => {
  const r = extractiveSummary([
    { role: 'user', content: '我叫小明' },
    { role: 'user', content: '我喜欢用本地模型' },
    { role: 'user', content: '明天要去北京' },
    { role: 'assistant', content: '好的' },
  ]);
  assert.ok(r.preferences.some((x) => x.includes('喜欢')));
  assert.ok(r.events.some((x) => x.includes('北京')));
  assert.ok(r.facts.some((x) => x.includes('小明')));
});

test('MemorySummary 并入 + 持久化 + 重载（MS2/4）', async () => {
  const file = tmpFile('summary.json');
  const a = new MemorySummary({ file, logger: { debug() {}, warn() {} } });
  await a.ingest('g@chatroom', [{ role: 'user', content: '我喜欢安静' }]);
  a.flush(); // 测试里立即落盘；实际上由 5s 定时器异步 flush
  // 新实例从同一文件载入
  const b = new MemorySummary({ file, logger: { debug() {}, warn() {} } });
  const got = b.get('g@chatroom');
  assert.ok(got, '重载后仍能读回摘要');
  assert.ok(got.summary.preferences.some((x) => x.includes('安静')));
  assert.equal(fs.existsSync(file), true);
});

test('MemorySummary 合并去重，跨多次 ingest 累积（MS2）', async () => {
  const a = new MemorySummary({ file: tmpFile('s2.json'), logger: { debug() {}, warn() {} } });
  await a.ingest('c', [{ role: 'user', content: '我想学钢琴' }]);
  await a.ingest('c', [{ role: 'user', content: '我想学钢琴' }]); // 重复应去重
  await a.ingest('c', [{ role: 'user', content: '我讨厌噪音' }]);
  const s = a.get('c').summary;
  assert.equal(s.preferences.filter((x) => x.includes('钢琴')).length, 1, '重复偏好被去重');
  assert.ok(s.preferences.some((x) => x.includes('噪音')));
});

test('AI 版摘要：传入 ai 时用模型输出（MS2 增强）', async () => {
  const ai = { chat: async () => ({ text: '前缀 {"facts":["事实A"],"preferences":["偏好A"],"events":["事件A"]} 后缀' }) };
  const a = new MemorySummary({ file: tmpFile('s3.json'), logger: { debug() {}, warn() {} } });
  const s = await a.ingest('c', [{ role: 'user', content: 'x' }], { ai });
  assert.deepEqual(s.facts, ['事实A']);
  assert.deepEqual(s.preferences, ['偏好A']);
  assert.deepEqual(s.events, ['事件A']);
});

test('导出四种形态 + JSON（MS3）', async () => {
  const a = new MemorySummary({ file: tmpFile('s4.json'), logger: { debug() {}, warn() {} } });
  await a.ingest('room1', [
    { role: 'user', content: '我喜欢猫' },
    { role: 'user', content: '昨天买了书' },
  ]);
  const md = a.exportAs({ format: 'memory' });
  assert.match(md, /room1/);
  assert.match(md, /喜欢猫/);
  const diary = a.exportAs({ format: 'diary' });
  const log = a.exportAs({ format: 'log' });
  const journal = a.exportAs({ format: 'journal' });
  assert.notEqual(diary, log);
  assert.notEqual(journal, md);
  const jsonStr = a.exportAs({ format: 'memory', asJson: true });
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.sessions[0].chatId, 'room1');
  // 按会话导出
  const one = a.exportAs({ format: 'memory', scope: 'chat', chatId: 'room1' });
  assert.match(one, /room1/);
});

test('clear 清空摘要库（MS7）', async () => {
  const file = tmpFile('s5.json');
  const a = new MemorySummary({ file, logger: { debug() {}, warn() {} } });
  await a.ingest('c', [{ role: 'user', content: '我怕黑' }]);
  a.clear('c');
  assert.equal(a.get('c'), null);
});

test('buildMessages 把长期摘要回注系统提示（MS5）', async () => {
  const { buildMessages } = await import('../src/ai/prompt.js');
  const summary = { facts: ['他叫小明'], preferences: ['喜欢猫'], events: ['明天去北京'] };
  const msgs = buildMessages({
    persona: '你是助手',
    msg: { chatId: 'c', chatType: 'group', chatName: '群', senderName: '小红' },
    cfg: { account: '我', personaName: '小助', model: 'm' },
    userText: '在吗',
    memorySummary: summary,
  });
  const sys = msgs[0].content;
  assert.match(sys, /他叫小明/);
  assert.match(sys, /喜欢猫/);
  assert.match(sys, /明天去北京/);
  assert.match(sys, /之前的记忆/);
  // 空摘要不注入
  const msgs2 = buildMessages({
    persona: '你是助手',
    msg: { chatId: 'c', chatType: 'private' },
    cfg: { account: '我', personaName: '小助', model: 'm' },
    userText: '在吗',
    memorySummary: null,
  });
  assert.ok(!msgs2[0].content.includes('之前的记忆'));
});
