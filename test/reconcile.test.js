import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Receiver } from '../src/bridge/receiver.js';
import { buildPollPlan } from '../src/bridge/poll-sql.js';
import { AIReply } from '../src/ai/replier.js';
import { AIClient } from '../src/ai/client.js';
import { Memory } from '../src/ai/memory.js';

const silence = { debug() {}, info() {}, warn() {}, error() {} };
// 诊断用 logger：把被吞的 debug/error 打印出来
const loud = {
  debug: (...a) => console.log('[DBG]', ...a),
  info: () => {},
  warn: (...a) => console.log('[WRN]', ...a),
  error: (...a) => console.log('[ERR]', ...a),
};

/** 复检扫描的假 hook：按 local_id 精确返回该行，MAX 返回水位，Name2Id 解析发送者。 */
function fakeHook({ rowsBy, senders, maxId }) {
  return {
    async queryDb(sql) {
      const s = String(sql || '');
      if (/MAX\s*\(\s*local_id\s*\)/i.test(s)) return { status: 0, data: [{ msgid: maxId }] };
      if (/Name2Id/i.test(s)) return { status: 0, data: senders };
      if (/^\s*SELECT\s+local_id\s+FROM/i.test(s)) {
        return { status: 0, data: Object.keys(rowsBy).map((id) => ({ local_id: Number(id) })) };
      }
      if (/AS\s+msgid/i.test(s)) {
        const m = /local_id\s*=\s*(\d+)/i.exec(s);
        const id = m && m[1];
        return { status: 0, data: id && rowsBy[id] ? [rowsBy[id]] : [] };
      }
      return { status: 0, data: [] };
    },
  };
}

test('reconcile 只补答「其后没有 Bot 回复」的用户消息，且不重复回复', async () => {
  const chatId = '123456@chatroom';
  const selfId = 'wxid_self';
  // 最近 5 条：#100/#102/#104 是用户消息，#101/#103 是 Bot 自己回复；#104 之后无回复（漏答）
  const rowsBy = {
    100: { msgid: 100, rid: 2, content: '你好', createTime: 1700000000 },
    101: { msgid: 101, rid: 1, content: 'reply to 100', createTime: 1700000001 },
    102: { msgid: 102, rid: 2, content: '问题A', createTime: 1700000002 },
    103: { msgid: 103, rid: 1, content: 'reply to 102', createTime: 1700000003 },
    104: { msgid: 104, rid: 2, content: '漏答的问题B', createTime: 1700000004 },
  };
  const senders = [
    { rowid: 1, user_name: selfId },
    { rowid: 2, user_name: 'wxid_peer' },
  ];
  const hook = fakeHook({ rowsBy, senders, maxId: 104 });
  const receiver = new Receiver({
    cfg: {
      receiveMode: 'poll',
      webhookPort: 0,
      pollDb: 'message_0.db',
      pollIntervalMs: 60,
      webhookIdleFallbackMs: 0,
      selfId,
      reconcileEnabled: true,
      reconcileWindow: 10,
      reconcileIntervalMs: 80,
    },
    hook,
    logger: loud,
    pollPlan: buildPollPlan([chatId], { limit: 30, dbBase: 'message_0.db' }),
  });

  const got = [];
  receiver.on('message', (m) => got.push(m));
  await receiver.start();
  await new Promise((r) => setTimeout(r, 150)); // 等 initWatermark 把水位对齐
  // 复检定时器间隔被硬性夹到最小 5s（startReconcile），单元测试不等定时器，直接触发一次
  await receiver.reconcile();
  await receiver.stop();

  assert.equal(got.length, 1, '只应补答 1 条漏答消息');
  assert.equal(got[0].id, '104', '补答的是 #104（其后无 Bot 回复）');
  assert.equal(got[0].text, '漏答的问题B');
  assert.equal(got[0].reconcile, true, '复检消息带 reconcile 标记');
});

test('reconcile 不补答 groupReply=never 的群（即便其后没有 Bot 回复）', async () => {
  const chatId = 'nevergroup@chatroom';
  const selfId = 'wxid_self';
  // never 群里有一条用户消息、其后没有任何 Bot 回复；正常路径本就不回，复检也不该补答
  const rowsBy = {
    100: { msgid: 100, rid: 2, content: '用户问的问题', createTime: 1700000000 },
  };
  const senders = [
    { rowid: 1, user_name: selfId },
    { rowid: 2, user_name: 'wxid_peer' },
  ];
  const hook = fakeHook({ rowsBy, senders, maxId: 100 });
  const receiver = new Receiver({
    cfg: {
      receiveMode: 'poll',
      webhookPort: 0,
      pollDb: 'message_0.db',
      pollIntervalMs: 60,
      webhookIdleFallbackMs: 0,
      selfId,
      reconcileEnabled: true,
      reconcileWindow: 10,
      reconcileIntervalMs: 80,
    },
    hook,
    logger: silence,
    // 该群被显式配置为 never：复检应跳过
    pollPlan: buildPollPlan([chatId], { limit: 30, dbBase: 'message_0.db', groupReplyFor: () => 'never' }),
  });

  const got = [];
  receiver.on('message', (m) => got.push(m));
  await receiver.start();
  await new Promise((r) => setTimeout(r, 150)); // 等 initWatermark 把水位对齐
  await receiver.reconcile();
  await receiver.stop();

  assert.equal(got.length, 0, 'never 群不应被复检补答');
});

test('reconcile 对已被 selfFilter 误标为「自己发的」消息仍会补答', async () => {
  const chatId = '123456@chatroom';
  const selfId = 'wxid_self';
  const rowsBy = {
    100: { msgid: 100, rid: 1, content: 'bot 自己的回复（被误标）', createTime: 1700000001 },
    101: { msgid: 101, rid: 2, content: '用户问的真实问题', createTime: 1700000002 },
  };
  const senders = [
    { rowid: 1, user_name: selfId },
    { rowid: 2, user_name: 'wxid_peer' },
  ];
  const hook = fakeHook({ rowsBy, senders, maxId: 101 });
  // selfFilter 把 #101 误标成已发（污染 sent 集合）——正常增量路径会因此丢弃它
  // 补齐 Responder.deliver 会用到的方法：mock 缺方法会在发送时抛错
  const pollutedSelf = {
    mode: 'id',
    isSelfMessage: () => true,
    isSentId: () => true,
    isEcho: () => false,
    rememberOutgoing() {},
    markSent() {},
  };
  const receiver = new Receiver({
    cfg: {
      receiveMode: 'poll',
      webhookPort: 0,
      pollDb: 'message_0.db',
      pollIntervalMs: 60,
      webhookIdleFallbackMs: 0,
      selfId,
      reconcileEnabled: true,
      reconcileWindow: 10,
      reconcileIntervalMs: 80,
    },
    hook,
    logger: loud,
    selfFilter: pollutedSelf,
    pollPlan: buildPollPlan([chatId], { limit: 30, dbBase: 'message_0.db' }),
  });

  const got = [];
  receiver.on('message', (m) => got.push(m));
  await receiver.start();
  await new Promise((r) => setTimeout(r, 150)); // 等 initWatermark 把水位对齐
  // 复检定时器间隔被硬性夹到最小 5s（startReconcile），单元测试不等定时器，直接触发一次
  await receiver.reconcile();
  await receiver.stop();

  // 即使 selfFilter 把 #101 判成自己发的，复检仍按 DB 发送者（wxid_peer）补答它
  assert.equal(got.length, 1);
  assert.equal(got[0].id, '101');
  assert.equal(got[0].senderId, 'wxid_peer');
});

/** 假的 OpenAI 兼容服务（复检消息需绕过 isSentId 门禁验证）。 */
async function fakeAI(reply = '已补答') {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'hy3',
          usage: { total_tokens: 10 },
          choices: [{ message: { role: 'assistant', content: reply } }],
        })
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, calls, port: server.address().port };
}

function aiCfg(over = {}) {
  return {
    enabled: true,
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'k',
    model: 'hy3',
    timeoutMs: 3000,
    maxTokens: 100,
    temperature: 0.8,
    personaFile: '',
    systemPrompt: '',
    contextTurns: 4,
    contextTtlMs: 0,
    cooldownMs: 0,
    maxPerHour: 0,
    groupReply: 'always',
    privateRequirePrefix: false,
    triggerPrefix: '',
    maxReplyChars: 900,
    stripMarkdown: true,
    ...over,
  };
}

test('AIReply.handle 对 reconcile 消息绕过 isSentId 门禁（即便被误标为已发）', async () => {
  const { server, port } = await fakeAI('已补答');
  // 必须 finally 关闭：断言失败若不关 server，进程会一直挂着不退出（曾导致全量测试卡死）
  try {
  const ai = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'hy3' });
  const hook = { async sendText() { return { ok: true }; } };
  // selfFilter 误标：isSentId 对该消息返回 true（模拟 markSent 误捕获）
  // 同上：把 deliver 依赖的方法补齐，否则断言还没跑到就先抛错
  const pollutedSelf = {
    mode: 'id',
    isSelfMessage: () => false,
    isSentId: () => true,
    isEcho: () => false,
    rememberOutgoing() {},
    markSent() {},
  };
  const air = new AIReply({
    cfg: aiCfg({ selfMode: 'id', groupReply: 'always' }),
    ai,
    memory: new Memory({}),
    hook,
    logger: loud,
    selfFilter: pollutedSelf,
    pauseState: { isPaused: () => false },
  });

  const msg = {
    chatType: 'group',
    kind: 'text',
    text: '漏答的问题B',
    chatId: '123456@chatroom',
    senderId: 'wxid_peer',
    id: '104',
    reconcile: true,
  };
  const out = await air.handle(msg);
  assert.equal(out, '已补答', 'reconcile 消息应绕过 isSentId 被正常回复');
  assert.equal(air.stats.replied, 1);

  // 对照组：没有 reconcile 标记时，同样的误标会导致被过滤（验证了绕过是必要的）
  const air2 = new AIReply({
    cfg: aiCfg({ selfMode: 'id', groupReply: 'always' }),
    ai,
    memory: new Memory({}),
    hook,
    logger: loud,
    selfFilter: pollutedSelf,
    pauseState: { isPaused: () => false },
  });
  const out2 = await air2.handle({ ...msg, reconcile: false });
  assert.equal(out2, null, '无 reconcile 标记时仍会被 isSentId 误杀');
  assert.equal(air2.stats.filtered, 1);

  } finally {
    server.close();
  }
});
