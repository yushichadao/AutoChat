import test from 'node:test';
import assert from 'node:assert/strict';
import { Receiver } from '../src/bridge/receiver.js';
import { buildPollPlan } from '../src/bridge/poll-sql.js';

const silence = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 假 hook：按 SQL 形态返回不同结果，模拟 hook 的真实协议。
 *
 * 轮询分两种取数方式（见 src/bridge/receiver.js）：
 *   · 按会话自动生成：先取主键批次（只取 local_id），再逐条取正文，最后查 Name2Id 解析发送者。
 *     分三步是因为 hook 对「多列 + message_content + WHERE」的批量查询会整批返回空。
 *   · 用户手写 WX_POLL_SQL：一条 SQL 直接返回完整行。
 */
function fakeHook({ batch = [], rows = [], senders = [], custom = [] } = {}) {
  let queries = 0;
  return {
    get queries() {
      return queries;
    },
    async queryDb(sql) {
      queries += 1;
      const s = String(sql || '');
      if (/MAX\s*\(\s*local_id\s*\)/i.test(s)) return { status: 0, data: [{ msgid: 0 }] };
      if (/Name2Id/i.test(s)) return { status: 0, data: senders };
      if (/^\s*SELECT\s+local_id\s+FROM/i.test(s)) return { status: 0, data: batch };
      if (/AS\s+msgid/i.test(s)) return { status: 0, data: rows };
      return { status: 0, data: custom };
    },
  };
}

test('webhook 一直静默时自动启用轮询兜底', async () => {
  // 手写 SQL 路径：兜底轮询必须原样使用用户写的 SQL，并按约定别名解析
  const hook = fakeHook({
    custom: [{ msgid: 'm1', wxid: 'wxid_peer', content: '兜底来的', createTime: 1700000000 }],
  });
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
  const hook = fakeHook({});
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
  const hook = fakeHook({
    custom: [
      { msgid: 'same', wxid: 'wxid_peer', content: '重复', createTime: 1700000000 },
      { msgid: 'same', wxid: 'wxid_peer', content: '重复', createTime: 1700000000 },
    ],
  });
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

test('按会话轮询：先取主键再逐条取正文，发送者由 Name2Id 解析', async () => {
  const chatId = '123456@chatroom';
  const hook = fakeHook({
    batch: [{ local_id: 5 }],
    rows: [{ msgid: 5, rid: 9, content: '按会话来的', createTime: 1700000000 }],
    senders: [{ rowid: 9, user_name: 'wxid_peer' }],
  });
  const receiver = new Receiver({
    cfg: {
      receiveMode: 'poll',
      webhookPort: 0,
      pollDb: 'message_0.db',
      pollIntervalMs: 60,
      webhookIdleFallbackMs: 0,
      selfId: 'wxid_self',
    },
    hook,
    pollPlan: buildPollPlan([chatId], { limit: 30, dbBase: 'message_0.db' }),
    logger: silence,
  });

  const got = [];
  receiver.on('message', (m) => got.push(m));
  await receiver.start();
  await new Promise((r) => setTimeout(r, 200));
  await receiver.stop();

  assert.equal(got.length, 1);
  assert.equal(got[0].text, '按会话来的');
  assert.equal(got[0].senderId, 'wxid_peer');
});
