import test from 'node:test';
import assert from 'node:assert/strict';
import { Receiver } from '../src/bridge/receiver.js';
import { buildPollPlan } from '../src/bridge/poll-sql.js';
import { effectivePollChats } from '../src/tasks/doctor.js';
import { ChatProfiles } from '../src/core/chats.js';
import { AIReply } from '../src/ai/replier.js';
import { AIClient } from '../src/ai/client.js';

const silence = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * 假 hook：模拟「群里已有 4905 条历史、4906 是刚发的」。
 * MAX(local_id) 返回 4905 —— 对应 initWatermark 的水位对齐。
 */
function fakeHook({ maxId = 4905, ids = [4905, 4906] } = {}) {
  return {
    async queryDb(sql) {
      const s = String(sql || '');
      if (/MAX\s*\(\s*local_id\s*\)/i.test(s)) return { status: 0, data: [{ msgid: maxId }] };
      if (/Name2Id/i.test(s)) return { status: 0, data: [{ rowid: 9, user_name: 'wxid_peer' }] };
      if (/^\s*SELECT\s+local_id\s+FROM/i.test(s)) return { status: 0, data: ids.map((id) => ({ local_id: id })) };
      if (/AS\s+msgid/i.test(s)) {
        const id = Number(/local_id\s*=\s*(\d+)/i.exec(s)?.[1] || 0);
        return { status: 0, data: [{ msgid: id, rid: 9, content: `消息${id}`, createTime: 1700000000 }] };
      }
      return { status: 0, data: [] };
    },
  };
}

test('监听会话 = WX_POLL_CHATS 与按会话配置的并集', () => {
  const cfg = {
    wechat: { pollChats: ['111@chatroom'] },
    chats: { '222@chatroom': { enabled: true }, '333@chatroom': { enabled: false } },
  };
  assert.deepEqual(effectivePollChats(cfg), ['111@chatroom', '222@chatroom']);
});

test('起服务时没有会话，加入第一个群后立刻开始收消息（不用重启）', async () => {
  const hook = fakeHook();
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
    pollPlan: [],
    logger: silence,
  });

  const got = [];
  receiver.on('message', (m) => got.push(m));
  await receiver.start(); // 一个会话都没有 —— 轮询不会启动

  // 用户在界面里加入新群（写 config.json + WX_POLL_CHATS）
  const res = await receiver.setPlan(buildPollPlan(['123456@chatroom'], { limit: 30, dbBase: 'message_0.db' }));
  assert.deepEqual(res.added, ['123456@chatroom']);
  await receiver.startPoll();

  await new Promise((r) => setTimeout(r, 250));
  await receiver.stop();

  assert.equal(receiver.stats.poll, 1, '只投递新增的那一条');
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '消息4906', '历史消息 4905 已被水位挡掉，不会一进群就刷屏');
  assert.equal(got[0].chatId, '123456@chatroom');
});

test('移除会话后不再轮询它', async () => {
  const chatId = '123456@chatroom';
  const receiver = new Receiver({
    cfg: { receiveMode: 'poll', webhookPort: 0, pollDb: 'message_0.db', pollIntervalMs: 5000, webhookIdleFallbackMs: 0, selfId: 'wxid_self' },
    hook: fakeHook(),
    pollPlan: buildPollPlan([chatId], { limit: 30, dbBase: 'message_0.db' }),
    logger: silence,
  });
  await receiver.initWatermark(receiver.pollPlan);
  assert.equal(receiver.watermark.get(chatId), 4905);

  const res = await receiver.setPlan([]);
  assert.deepEqual(res.removed, [chatId]);
  assert.equal(receiver.pollPlan.length, 0);
  assert.equal(receiver.watermark.has(chatId), false);
});

test('新群的策略热更新后立刻生效（不必重启）', async (t) => {
  const orig = AIClient.prototype.chat;
  t.after(() => {
    AIClient.prototype.chat = orig;
  });
  AIClient.prototype.chat = async () => ({ text: '在的', usage: null, model: 'm' });

  const ai = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' });
  const air = new AIReply({
    cfg: { enabled: true, groupReply: 'never', maxReplyChars: 900, stripMarkdown: false },
    ai,
    memory: { history: () => [], push: () => {} },
    hook: { sendText: async () => ({ ok: true }) },
    logger: silence,
    profiles: new ChatProfiles({ chats: {} }),
  });

  const msg = { chatId: 'new@chatroom', senderId: 'wxid_peer', text: '你好', kind: 'text', chatType: 'group' };
  assert.equal(await air.handle(msg), null, '新群还没配置，按全局 never 不回');

  // 用户在界面里把这个群设成 always —— 不重启也要生效
  air.applyConfig({ enabled: true, groupReply: 'never', maxReplyChars: 900, stripMarkdown: false }, {
    'new@chatroom': { groupReply: 'always' },
  });
  assert.equal(air.overrideFor('new@chatroom').groupReply, 'always');
  assert.equal(await air.handle(msg), '在的');
});
