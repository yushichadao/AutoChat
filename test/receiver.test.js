import test from 'node:test';
import assert from 'node:assert/strict';
import { Receiver } from '../src/bridge/receiver.js';

const silence = { debug() {}, info() {}, warn() {}, error() {} };

function fakeHook(rows) {
  let queries = 0;
  return {
    get queries() {
      return queries;
    },
    async queryDb() {
      queries += 1;
      return { status: 0, data: rows };
    },
  };
}

test('webhook 一直静默时自动启用轮询兜底', async () => {
  const hook = fakeHook([{ msgid: 'm1', wxid: 'wxid_peer', content: '兜底来的' }]);
  const receiver = new Receiver({
    cfg: {
      receiveMode: 'webhook',
      webhookPort: 0,
      pollSql: 'SELECT 1',
      pollIntervalMs: 60,
      webhookIdleFallbackMs: 120,
      selfId: 'wxid_self',
    },
    hook,
    logger: silence,
  });

  const got = [];
  receiver.on('message', (m) => got.push(m));

  await receiver.start();
  await new Promise((r) => setTimeout(r, 700));
  await receiver.stop();

  assert.ok(hook.queries > 0, '应该已经开始查库');
  assert.ok(got.length > 0, '应该收到了兜底消息');
  assert.equal(got[0].text, '兜底来的');
  assert.equal(receiver.stats.poll > 0, true);
});

test('没有配置 pollSql 时不会启用兜底', async () => {
  const hook = fakeHook([]);
  const receiver = new Receiver({
    cfg: {
      receiveMode: 'webhook',
      webhookPort: 0,
      pollSql: '',
      pollIntervalMs: 60,
      webhookIdleFallbackMs: 80,
      selfId: '',
    },
    hook,
    logger: silence,
  });
  await receiver.start();
  await new Promise((r) => setTimeout(r, 400));
  await receiver.stop();
  assert.equal(hook.queries, 0);
});

test('重复消息只算一次', async () => {
  const hook = fakeHook([
    { msgid: 'same', wxid: 'wxid_peer', content: '重复' },
    { msgid: 'same', wxid: 'wxid_peer', content: '重复' },
  ]);
  const receiver = new Receiver({
    cfg: {
      receiveMode: 'poll',
      webhookPort: 0,
      pollSql: 'SELECT 1',
      pollIntervalMs: 5000,
      webhookIdleFallbackMs: 0,
      selfId: '',
    },
    hook,
    logger: silence,
  });

  const got = [];
  receiver.on('message', (m) => got.push(m));
  await receiver.start();
  await new Promise((r) => setTimeout(r, 150));
  await receiver.stop();

  assert.equal(got.length, 1);
  assert.equal(receiver.stats.dropped, 1);
});
