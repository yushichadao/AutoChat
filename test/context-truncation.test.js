import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/ai/memory.js';

/** R22：上下文溢出 / 超长对话截断：转录超限时按轮次与字符预算裁剪，不丢关键结构。 */
test('Memory.push 超过 maxTurns 后只保留最近 N 轮（R22）', () => {
  const m = new Memory({ maxTurns: 3, ttlMs: 0, maxChars: 0 });
  for (let i = 0; i < 20; i++) m.push('c', i % 2 ? 'user' : 'assistant', `第${i}条`);
  // 一问一答算一轮，push 保留 maxTurns*2 = 6 条
  assert.equal(m.history('c').length, 6);
  // 最新一条应是最后写入的
  assert.equal(m.history('c').slice(-1)[0].content, '第19条');
});

test('Memory.fit 按字符预算从最早的开始丢（R22）', () => {
  const m = new Memory({ maxTurns: 100, ttlMs: 0, maxChars: 30 });
  m.push('c', 'user', 'A'.repeat(20));
  m.push('c', 'assistant', 'B'.repeat(20));
  m.push('c', 'user', 'C'.repeat(20));
  const hist = m.history('c');
  // 总量超 30 时从最早丢弃，但至少留一条
  let total = 0;
  for (const x of hist) total += x.content.length;
  assert.ok(total <= 30, '字符预算内');
  assert.ok(hist.length >= 1, '至少留一条');
  assert.equal(hist.slice(-1)[0].content, 'C'.repeat(20), '最新一条必留');
});

test('Memory 超长对话截断后仍能正常喂模型（history 返回干净数组）', () => {
  const m = new Memory({ maxTurns: 2, ttlMs: 0, maxChars: 50 });
  for (let i = 0; i < 50; i++) m.push('c', 'user', `消息${i}`);
  const hist = m.history('c');
  assert.ok(Array.isArray(hist));
  assert.ok(hist.every((x) => x.role && typeof x.content === 'string'));
});
