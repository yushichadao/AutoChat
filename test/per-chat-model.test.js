import test from 'node:test';
import assert from 'node:assert/strict';
import { AIReply } from '../src/ai/replier.js';
import { Responder } from '../src/ai/responder.js';
import { AIClient } from '../src/ai/client.js';

function makeReply(chatOverrides = {}) {
  const ai = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'global-model' });
  return new AIReply({
    cfg: { enabled: true },
    ai,
    memory: { history: () => [], push: () => {} },
    hook: { sendText: async () => ({ ok: true }) },
    logger: { warn() {}, info() {}, debug() {} },
    profiles: { get: () => chatOverrides, persona: () => 'p' },
  });
}

test('未配覆盖 → 复用全局客户端', () => {
  const r = makeReply({});
  const c = r.aiForChat({});
  assert.equal(c, r.defaultAI);
  assert.equal(c.model, 'global-model');
});

test('会话配 model → 新建客户端且 model 生效', () => {
  const r = makeReply({ model: 'group-model' });
  const c = r.aiForChat({ model: 'group-model' });
  assert.notEqual(c, r.defaultAI);
  assert.equal(c.model, 'group-model');
  assert.equal(c.baseUrl, 'https://api.example.com/v1');
});

test('会话配 baseUrl/apiKey/model → 全部覆盖', () => {
  const r = makeReply({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'local', model: 'llama' });
  const c = r.aiForChat({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'local', model: 'llama' });
  assert.equal(c.baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(c.apiKey, 'local');
  assert.equal(c.model, 'llama');
});

test('Responder.generate 用传入的 ai 覆盖', async () => {
  const fakeAI = { chat: async () => ({ text: 'hi', usage: null, model: 'm' }) };
  const resp = new Responder({ ai: { chat: async () => ({ text: 'x' }) }, cfg: {} });
  const out = await resp.generate([{ role: 'user', content: '?' }], { ai: fakeAI });
  assert.equal(out, 'hi');
});

test('handle 按会话选模型（端到端，不真发请求）', async (t) => {
  const orig = AIClient.prototype.chat;
  t.after(() => {
    AIClient.prototype.chat = orig;
  });
  const calls = [];
  AIClient.prototype.chat = async function () {
    calls.push(this.model);
    return { text: 'ok', usage: null, model: this.model };
  };

  const ai = new AIClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'global-model' });
  const reply = new AIReply({
    cfg: { enabled: true },
    ai,
    memory: { history: () => [], push: () => {} },
    hook: { sendText: async () => ({ ok: true }) },
    logger: { warn() {}, info() {}, debug() {} },
    profiles: {
      get: (id) => (id === 'group@chatroom' ? { model: 'group-model', groupReply: 'always' } : {}),
      persona: () => 'p',
    },
  });

  await reply.handle({ chatId: 'group@chatroom', senderId: 'other', text: '你好', kind: 'text', chatType: 'group' });
  await reply.handle({ chatId: 'friend', senderId: 'other', text: '你好', kind: 'text', chatType: 'private' });

  assert.deepEqual([...calls].sort(), ['global-model', 'group-model']);
});
