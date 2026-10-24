import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AIClient, normalizeBase, extractContent } from '../src/ai/client.js';
import { Memory } from '../src/ai/memory.js';
import { PROVIDERS, findProvider, guessProvider, groupedProviders, LOCAL_PORTS } from '../src/ai/providers.js';
import { explainError, listModels, testChat, reviewConfig } from '../src/ai/probe.js';
import { AIReply, stripMarkdown, splitReply } from '../src/ai/replier.js';

const silence = { debug() {}, info() {}, warn() {}, error() {} };

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
    groupReply: 'mention',
    privateRequirePrefix: false,
    triggerPrefix: '',
    maxReplyChars: 900,
    stripMarkdown: true,
    ...over,
  };
}

/** 假的 OpenAI 兼容服务。 */
async function fakeAI(reply = '好的') {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
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

test('normalizeBase 补 /v1 且去掉尾斜杠', () => {
  assert.equal(normalizeBase('https://tokenhub.tencentmaas.com/v1'), 'https://tokenhub.tencentmaas.com/v1');
  assert.equal(normalizeBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787/v1');
  assert.equal(normalizeBase('https://x.com/v1/'), 'https://x.com/v1');
  assert.equal(normalizeBase('tokenhub.tencentmaas.com'), 'https://tokenhub.tencentmaas.com/v1');
  assert.throws(() => normalizeBase(''), /未配置/);
});

test('extractContent 兼容多种返回形态', () => {
  assert.equal(extractContent({ choices: [{ message: { content: ' a ' } }] }), 'a');
  assert.equal(extractContent({ choices: [{ message: { content: [{ text: 'x' }, { text: 'y' }] } }] }), 'xy');
  assert.equal(extractContent({ choices: [{ message: { reasoning_content: '思考' } }] }), '思考');
  assert.equal(extractContent({ choices: [] }), '');
  assert.equal(extractContent({}), '');
});

test('AIClient 能打通 OpenAI 兼容接口并带上鉴权', async () => {
  const ai = await fakeAI('你好呀');
  const client = new AIClient({ baseUrl: `http://127.0.0.1:${ai.port}`, apiKey: 'sk-test', model: 'hy3', timeoutMs: 3000, logger: silence });

  const res = await client.chat([{ role: 'user', content: 'hi' }], { maxTokens: 20, temperature: 0.5 });
  assert.equal(res.text, '你好呀');
  assert.equal(ai.calls[0].url, '/v1/chat/completions');
  assert.equal(ai.calls[0].auth, 'Bearer sk-test');
  assert.equal(ai.calls[0].body.model, 'hy3');
  assert.equal(ai.calls[0].body.max_tokens, 20);
  ai.server.close();
});

test('接口报错时抛出可读错误', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401).end('{"error":"bad key"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new AIClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: 'x',
    model: 'hy3',
    timeoutMs: 2000,
    logger: silence,
  });
  await assert.rejects(() => client.chat([{ role: 'user', content: 'hi' }]), /401/);
  server.close();
});

test('stripMarkdown 去掉微信不渲染的标记', () => {
  const out = stripMarkdown('**加粗**\n## 标题\n- 一\n- 二\n`code`\n```js\nlet a = 1\n```');
  assert.ok(!out.includes('**'));
  assert.ok(!out.includes('##'));
  assert.ok(!out.includes('```'));
  assert.match(out, /加粗/);
  assert.match(out, /· 一/);
});

test('splitReply 超长按段落切分', () => {
  const text = Array.from({ length: 10 }, (_, i) => `第${i}段内容`).join('\n');
  const parts = splitReply(text, 30);
  assert.ok(parts.length > 1);
  assert.equal(parts.join('\n').replace(/\s/g, ''), text.replace(/\s/g, ''));
  for (const p of parts) assert.ok(p.length <= 64);
});

test('短回复不分条', () => {
  assert.deepEqual(splitReply('短', 900), ['短']);
});

test('Memory 按轮数裁剪并按会话隔离', () => {
  const m = new Memory({ maxTurns: 1, ttlMs: 0 });
  m.push('a', 'user', '1');
  m.push('a', 'assistant', '2');
  m.push('a', 'user', '3');
  m.push('a', 'assistant', '4');
  m.push('a', 'user', '5');
  const h = m.history('a');
  assert.ok(h.length <= 2);
  assert.equal(h.at(-1).content, '5');
  assert.deepEqual(m.history('b'), []);
});

test('触发判断：私聊默认直接回，群聊要 @', () => {
  const hook = { async sendText() { return { ok: true }; } };
  const air = new AIReply({ cfg: aiCfg(), ai: null, memory: new Memory({}), hook, logger: silence });

  assert.equal(air.shouldReply({ chatType: 'private', kind: 'text', text: '在吗', chatId: 'a' }), true);
  assert.equal(air.shouldReply({ chatType: 'group', kind: 'text', text: '大家好', chatId: 'g' }), false);
  assert.equal(air.shouldReply({ chatType: 'group', kind: 'text', text: '@机器人 你好', chatId: 'g' }), true);
  assert.equal(air.shouldReply({ chatType: 'private', kind: 'image', text: '', chatId: 'a' }), false);
});

test('群聊策略 never / always 生效', () => {
  const hook = { async sendText() { return { ok: true }; } };
  const msg = { chatType: 'group', kind: 'text', text: 'hi', chatId: 'g' };
  const never = new AIReply({ cfg: aiCfg({ groupReply: 'never' }), ai: null, memory: new Memory({}), hook, logger: silence });
  const always = new AIReply({ cfg: aiCfg({ groupReply: 'always' }), ai: null, memory: new Memory({}), hook, logger: silence });
  assert.equal(never.shouldReply(msg), false);
  assert.equal(always.shouldReply(msg), true);
});

test('触发前缀能剥离，且只认前缀', () => {
  const hook = { async sendText() { return { ok: true }; } };
  const air = new AIReply({ cfg: aiCfg({ triggerPrefix: '小助手', groupReply: 'mention' }), ai: null, memory: new Memory({}), hook, logger: silence });
  assert.equal(air.shouldReply({ chatType: 'group', kind: 'text', text: '小助手 今天天气', chatId: 'g' }), true);
  assert.equal(air.shouldReply({ chatType: 'group', kind: 'text', text: '@全体 通知', chatId: 'g' }), false);
  assert.equal(air.stripPrefix({ text: '小助手 今天天气' }), '今天天气');
});

test('白名单只放行列出的会话', () => {
  const hook = { async sendText() { return { ok: true }; } };
  const air = new AIReply({
    cfg: aiCfg({ allowChats: ['wxid_ok'] }),
    ai: null,
    memory: new Memory({}),
    hook,
    logger: silence,
  });
  assert.equal(air.shouldReply({ chatType: 'private', kind: 'text', text: 'hi', chatId: 'wxid_ok' }), true);
  assert.equal(air.shouldReply({ chatType: 'private', kind: 'text', text: 'hi', chatId: 'wxid_other' }), false);
});

test('黑名单优先于白名单', () => {
  const hook = { async sendText() { return { ok: true }; } };
  const air = new AIReply({
    cfg: aiCfg({ allowChats: ['wxid_both'], denyChats: ['wxid_both'] }),
    ai: null,
    memory: new Memory({}),
    hook,
    logger: silence,
  });
  assert.equal(air.shouldReply({ chatType: 'private', kind: 'text', text: 'hi', chatId: 'wxid_both' }), false);
});

test('冷却与每小时配额生效', () => {
  const hook = { async sendText() { return { ok: true }; } };
  const msg = { chatType: 'private', kind: 'text', text: 'hi', chatId: 'a' };

  const cooled = new AIReply({ cfg: aiCfg({ cooldownMs: 60000 }), ai: null, memory: new Memory({}), hook, logger: silence });
  cooled.lastReplyAt.set('a', Date.now());
  assert.equal(cooled.rateLimited(msg), 'cooldown');

  const quota = new AIReply({ cfg: aiCfg({ maxPerHour: 2 }), ai: null, memory: new Memory({}), hook, logger: silence });
  quota.replyTimes = [Date.now(), Date.now()];
  assert.equal(quota.rateLimited(msg), 'quota');
});

test('handle 走完整链路：调模型、清洗、发送、记上下文', async () => {
  const ai = await fakeAI('**你好**，我在');
  const sent = [];
  const hook = {
    async sendText(to, text) {
      sent.push({ to, text });
      return { ok: true };
    },
  };
  const client = new AIClient({ baseUrl: `http://127.0.0.1:${ai.port}`, apiKey: 'k', model: 'hy3', timeoutMs: 3000, logger: silence });
  const memory = new Memory({ maxTurns: 4, ttlMs: 0 });
  const air = new AIReply({ cfg: aiCfg(), ai: client, memory, hook, logger: silence });

  const out = await air.handle({ chatType: 'private', kind: 'text', text: '在吗', chatId: 'wxid_a', senderName: '朋友', senderId: 'wxid_a' });

  assert.equal(out, '你好，我在');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'wxid_a');
  assert.equal(sent[0].text, '你好，我在');
  assert.equal(memory.history('wxid_a').length, 2);

  // 第二次调用应该把历史一起发过去
  await air.handle({ chatType: 'private', kind: 'text', text: '继续', chatId: 'wxid_a', senderName: '朋友', senderId: 'wxid_a' });
  const secondMessages = ai.calls[1].body.messages;
  assert.ok(secondMessages.some((m) => m.content === '在吗'), '应当带上上一轮用户消息');
  assert.ok(secondMessages.some((m) => m.role === 'assistant'), '应当带上上一轮回复');
  ai.server.close();
});

test('模型调用失败时返回 null 且计数', async () => {
  const server = http.createServer((req, res) => res.writeHead(500).end('boom'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new AIClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', model: 'hy3', timeoutMs: 2000, logger: silence });
  const hook = { async sendText() { return { ok: true }; } };
  const air = new AIReply({ cfg: aiCfg(), ai: client, memory: new Memory({}), hook, logger: silence });

  const out = await air.handle({ chatType: 'private', kind: 'text', text: 'hi', chatId: 'a', senderName: 'x', senderId: 'a' });
  assert.equal(out, null);
  assert.equal(air.stats.failed, 1);
  server.close();
});

// ── 模型接入（面向新手的那层）────────────────────────────────────────

test('服务商预设：每条都有名字、步骤和提示', () => {
  assert.ok(PROVIDERS.length >= 8);
  for (const p of PROVIDERS) {
    assert.ok(p.id && p.name, '缺 id 或 name');
    assert.ok(Array.isArray(p.steps) && p.steps.length >= 3, `${p.id} 的步骤太少`);
    assert.equal(typeof p.needsKey, 'boolean');
    if (p.id !== 'custom') {
      assert.match(p.baseUrl, /^https?:\/\//, `${p.id} 的地址不对`);
      assert.match(p.baseUrl, /\/v\d+[a-z]*(\/|$)/, `${p.id} 的地址要带版本号`);
    }
  }
});

test('服务商预设：本地的那几个都不需要密钥', () => {
  for (const p of PROVIDERS.filter((x) => x.group === '本地')) {
    assert.equal(p.needsKey, false, `${p.id} 本地模型不该要密钥`);
  }
});

test('按 id 找预设 / 按地址猜预设', () => {
  assert.equal(findProvider('ollama').baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(findProvider('DEEPSEEK').id, 'deepseek');
  assert.equal(findProvider('不存在的'), null);
  assert.equal(guessProvider('https://api.deepseek.com/v1').id, 'deepseek');
  assert.equal(guessProvider('http://127.0.0.1:11434/v1').id, 'ollama');
  assert.equal(guessProvider('https://api.openai.com/v1').id, 'openai');
  assert.equal(guessProvider(''), null);
});

test('分组顺序：本地 → 云端 → 自定义', () => {
  const groups = groupedProviders().map((g) => g.group);
  assert.deepEqual(groups, ['本地', '云端', '自定义']);
});

test('本地端口表覆盖 Ollama / LM Studio / vLLM', () => {
  const ports = LOCAL_PORTS.map((p) => p.port);
  assert.ok(ports.includes(11434));
  assert.ok(ports.includes(1234));
  assert.ok(ports.includes(8000));
});

test('错误翻译：把技术报错变成人话 + 下一步', () => {
  const cases = [
    ['fetch failed: connect ECONNREFUSED 127.0.0.1:11434', 'http://127.0.0.1:11434/v1', /还没启动/],
    ['HTTP 401: invalid api key', 'https://api.deepseek.com/v1', /密钥不对/],
    ['HTTP 404: model not found', 'https://api.deepseek.com/v1', /模型名不对/],
    ['HTTP 429: rate limit exceeded', 'https://api.deepseek.com/v1', /额度用完/],
    ['HTTP 500: internal server error', 'https://api.deepseek.com/v1', /服务商那边出错/],
    ['getaddrinfo ENOTFOUND api.example.com', 'https://api.example.com/v1', /找不到这个网址/],
  ];
  for (const [raw, url, want] of cases) {
    const ex = explainError(new Error(raw), { baseUrl: url });
    assert.match(ex.title, want, `翻译不对：${raw}`);
    assert.ok(ex.detail && ex.detail.length > 5, `要给出下一步：${raw}`);
    assert.ok(ex.fix, `要给出修复方向：${raw}`);
  }
  const fallback = explainError(new Error('某种没见过的问题'), {});
  assert.ok(fallback.title && fallback.detail);
});

test('配置点评：地址 / 密钥 / 模型名的问题都能看出来', () => {
  assert.match(reviewConfig({})[0].text, /还没填模型服务地址/);
  const noV1 = reviewConfig({ baseUrl: 'http://api.deepseek.com' }).map((t) => t.text).join(' ');
  assert.match(noV1, /\/v1/);
  const withPath = reviewConfig({ baseUrl: 'https://api.deepseek.com/v1/chat/completions' }).map((t) => t.text).join(' ');
  assert.match(withPath, /别把 \/chat\/completions/);
  const cloudNoKey = reviewConfig({ baseUrl: 'https://api.deepseek.com/v1', model: 'x' }).map((t) => t.text).join(' ');
  assert.match(cloudNoKey, /需要密钥/);
  assert.match(reviewConfig({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'q' })[0].text, /点「测试一下」/);
});

test('拉模型列表 / 试聊：对着本地假服务跑通', async () => {
  let seenAuth = '';
  const server = http.createServer((req, res) => {
    seenAuth = req.headers.authorization || '';
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const got = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: got.model,
            choices: [{ message: { role: 'assistant', content: `echo:${got.model}` } }],
          })
        );
      });
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  const models = await listModels({ baseUrl: base, apiKey: 'k' });
  assert.equal(models.ok, true);
  assert.deepEqual(models.models, ['model-a', 'model-b']);
  assert.equal(seenAuth, 'Bearer k');

  const chat = await testChat({ baseUrl: base, apiKey: 'k', model: 'model-a' });
  assert.equal(chat.ok, true);
  assert.match(chat.reply, /echo:model-a/);
  assert.ok(chat.ms >= 0);

  server.close();
});

test('试聊失败时给出人话而不是原始报错', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const r = await testChat({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'wrong',
    model: 'x',
  });
  assert.equal(r.ok, false);
  assert.match(r.title, /密钥不对/);
  assert.ok(r.detail.includes('复制'));
  server.close();
});
