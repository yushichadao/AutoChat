/**
 * 群聊多消息合批回复（G33/R28）聚合层测试。
 * 不依赖真实模型：用 fake shouldReplyFn + onFlush 记录，验证窗口 / 条数 / 上下文 / 覆盖语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BatchAggregator } from '../src/ai/batch-aggregator.js';

function makeAgg(overrides = {}) {
  const cfg = {
    replyMode: 'batch',
    batchWindowMs: 10000,
    batchMaxMessages: 10,
    batchFlushDelayMs: 5,
    ...overrides,
  };
  const calls = [];
  const agg = new BatchAggregator({
    cfg,
    profiles: { get: () => ({}) },
    shouldReplyFn: (m) => !!m._t,
    onFlush: (cid, s) => calls.push({ chatId: cid, s }),
  });
  return { agg, calls };
}

const gmsg = (name, text, triggered) => ({
  chatId: 'g@chatroom',
  chatType: 'group',
  senderName: name,
  senderId: 'id_' + name,
  text,
  _t: triggered,
});

test('达到条数上限立即 flush（不依赖定时器）', () => {
  const { agg, calls } = makeAgg({ batchMaxMessages: 3 });
  agg.push(gmsg('张三', '@bot 你好', true));
  agg.push(gmsg('李四', '@bot 在吗', true));
  const r = agg.push(gmsg('王五', '@bot 问个事', true));
  assert.equal(r, true, '第 3 条应被聚合器消费');
  assert.equal(calls.length, 1, '第 3 条触发后应立刻 flush 一次');
  assert.equal(calls[0].s.batchCount, 3);
  assert.match(calls[0].s.text, /张三/);
  assert.match(calls[0].s.text, /李四/);
  assert.match(calls[0].s.text, /王五/);
  assert.equal(calls[0].s.batch, true, '合成消息应带 batch 标记，让 replier 跳过触发判定');
  agg.stop();
});

test('single 模式：push 返回 false，交回单条路径', () => {
  const { agg } = makeAgg({ replyMode: 'single' });
  const r = agg.push(gmsg('张三', '@bot 你好', true));
  assert.equal(r, false);
  agg.stop();
});

test('非群消息：batch 模式也返回 false', () => {
  const { agg } = makeAgg();
  const r = agg.push({ chatId: 'f1', chatType: 'private', senderName: '好友', text: '@bot hi', _t: true });
  assert.equal(r, false);
  agg.stop();
});

test('窗口内普通群友的话也并入（他人发言作为上下文）', async () => {
  const { agg, calls } = makeAgg({ batchMaxMessages: 10, batchFlushDelayMs: 5 });
  agg.push(gmsg('张三', '今天天气不错', false)); // 普通发言
  agg.push(gmsg('李四', '@bot 帮我查下', true)); // 触发
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 1, '应静默期后 flush');
  assert.equal(calls[0].s.batchCount, 2, '普通发言也应进入缓冲');
  assert.match(calls[0].s.text, /张三.*今天天气不错/);
  assert.match(calls[0].s.text, /李四.*帮我查下/);
  agg.stop();
});

test('只有一条触发消息：等静默期后 flush（不会永远不开火）', async () => {
  const { agg, calls } = makeAgg({ batchMaxMessages: 10, batchFlushDelayMs: 5 });
  agg.push(gmsg('张三', '@bot 在吗', true));
  assert.equal(calls.length, 0, '单条不应立即 flush');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].s.batchCount, 1);
  agg.stop();
});

test('按会话覆盖：全局 batch，但某群配了 single → 该群走单条', () => {
  const cfg = { replyMode: 'batch', batchWindowMs: 10000, batchMaxMessages: 10, batchFlushDelayMs: 5 };
  const agg = new BatchAggregator({
    cfg,
    profiles: { get: (id) => (id === 'g@chatroom' ? { replyMode: 'single' } : {}) },
    shouldReplyFn: (m) => !!m._t,
    onFlush: () => {},
  });
  const r = agg.push(gmsg('张三', '@bot 你好', true));
  assert.equal(r, false, '该群被覆盖为 single，不应进聚合器');
  agg.stop();
});

test('多群互不串窗口', async () => {
  const { agg, calls } = makeAgg({ batchMaxMessages: 10, batchFlushDelayMs: 5 });
  agg.push({ ...gmsg('A1', '@bot 1', true), chatId: 'ga' });
  agg.push({ ...gmsg('B1', '@bot 1', true), chatId: 'gb' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 2, '两个群各自独立 flush');
  assert.ok(calls.every((c) => c.s.batchCount === 1));
  agg.stop();
});
