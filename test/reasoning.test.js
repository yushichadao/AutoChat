import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  buildReasoningParams,
  normalizeEffort,
  normalizeFormat,
  detectFormat,
  detectFormatByBase,
  resolveFormat,
  describeParams,
  explainReasoning,
  unsupportedReasoning,
  EFFORT_LEVELS,
  REASONING_FORMATS,
} from '../src/core/reasoning.js';
import { loadConfig, validateConfig } from '../src/core/config.js';
import { AIClient } from '../src/ai/client.js';
import { AIReply } from '../src/ai/replier.js';
import { Memory } from '../src/ai/memory.js';
import { ChatProfiles } from '../src/core/chats.js';
import { parseEffort, parseFormat } from '../src/cli/commands/effort.js';

const silence = { debug() {}, info() {}, warn() {}, error() {} };

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-reasoning-'));
}

/** 假的 OpenAI 兼容服务：把收到的请求体记下来。 */
async function fakeAI(reply = '好的', handler = null) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push(body);
      if (handler) {
        const custom = handler(body, calls.length);
        if (custom) {
          res.writeHead(custom.status || 400, { 'Content-Type': 'application/json' });
          res.end(custom.text || '{}');
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ model: body.model || 'm', choices: [{ message: { role: 'assistant', content: reply } }] })
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, calls, port: server.address().port };
}

// ── 档位与格式归一化 ──────────────────────────────────────────────────────

test('思考强度：非法值一律退回关闭（不让助手失声）', () => {
  assert.equal(normalizeEffort(undefined), 'off');
  assert.equal(normalizeEffort(''), 'off');
  assert.equal(normalizeEffort('乱写的'), 'off');
  assert.equal(normalizeEffort('HIGH'), 'high');
  assert.equal(normalizeEffort('none'), 'off');
  assert.equal(normalizeEffort('minimal'), 'low');
  assert.deepEqual(EFFORT_LEVELS, ['off', 'low', 'medium', 'high']);
});

test('思考格式：认不出来的退回自动，别把参数发错格式', () => {
  assert.equal(normalizeFormat(undefined), 'auto');
  assert.equal(normalizeFormat('乱写的'), 'auto');
  assert.equal(normalizeFormat('QWEN'), 'qwen');
  assert.equal(normalizeFormat('claude'), 'anthropic');
  assert.equal(normalizeFormat('openai'), 'standard');
  assert.ok(REASONING_FORMATS.indexOf('auto') >= 0, '应该有自动档');
});

// ── 按模型名自动判断格式 ──────────────────────────────────────────────────

test('自动判断：接口地址比模型名更准（同一个模型不同网关字段不同）', () => {
  assert.equal(detectFormatByBase('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(detectFormatByBase('https://api.anthropic.com/v1'), 'anthropic');
  assert.equal(detectFormatByBase('https://generativelanguage.googleapis.com/v1beta'), 'gemini');
  assert.equal(detectFormatByBase('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'qwen');
  assert.equal(detectFormatByBase('https://api.deepseek.com/v1'), 'thinking');
  assert.equal(detectFormatByBase('https://open.bigmodel.cn/api/paas/v4'), 'thinking');
  assert.equal(detectFormatByBase('https://api.openai.com/v1'), 'standard');
  assert.equal(detectFormatByBase('https://127.0.0.1:11434/v1'), '');

  // 地址优先于模型名：OpenRouter 上的 gpt-5 要走 reasoning.effort
  assert.equal(resolveFormat('auto', 'gpt-5', 'https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(resolveFormat('auto', 'qwen3-8b', 'https://openrouter.ai/api/v1'), 'openrouter');
  // 认不出来才按模型名
  assert.equal(resolveFormat('auto', 'qwen3-8b', 'https://127.0.0.1:11434/v1'), 'qwen');
  // 手动指定永远优先
  assert.equal(resolveFormat('qwen', 'gpt-5', 'https://openrouter.ai/api/v1'), 'qwen');
});

test('自动判断：各家模型认各自的字段', () => {
  const cases = [
    ['qwen3-8b', 'qwen'],
    ['Qwen/Qwen3-235B-A22B', 'qwen'],
    ['qwq-32b', 'qwen'],
    ['ernie-4.5-turbo', 'qwen'],
    ['claude-sonnet-4-20250514', 'anthropic'],
    ['anthropic/claude-3.7-sonnet', 'anthropic'],
    ['gemini-2.5-pro', 'gemini'],
    ['deepseek-chat', 'thinking'],
    ['deepseek-reasoner', 'thinking'],
    ['glm-4.6', 'thinking'],
    ['kimi-k2-thinking', 'thinking'],
    ['hunyuan-turbos', 'thinking'],
    ['gpt-5', 'standard'],
    ['o3-mini', 'standard'],
    ['grok-4', 'standard'],
    ['gpt-oss:20b', 'ollama'],
    ['llama3.1:8b', 'ollama'],
  ];
  for (const [model, want] of cases) {
    assert.equal(detectFormat(model), want, `${model} 应该用 ${want}`);
  }
  assert.equal(detectFormat('某个没听说过的模型'), '', '认不出来就返回空');
  assert.equal(resolveFormat('auto', 'qwen3-8b'), 'qwen');
  assert.equal(resolveFormat('auto', '某个没听说过的模型'), 'standard', '认不出来退回最通用那套');
  assert.equal(resolveFormat('qwen', 'gpt-5'), 'qwen', '手动指定优先于自动判断');
});

// ── 各家字段翻译 ──────────────────────────────────────────────────────────

test('标准格式：带 reasoning_effort；关闭时什么字段都不带', () => {
  assert.deepEqual(buildReasoningParams({ effort: 'off', format: 'standard' }), {});
  assert.deepEqual(buildReasoningParams({ effort: 'medium', format: 'standard' }), { reasoning_effort: 'medium' });
  assert.deepEqual(buildReasoningParams({ effort: 'high', format: 'standard' }), { reasoning_effort: 'high' });
});

test('通义格式：enable_thinking + thinking_budget；关闭时显式关掉', () => {
  assert.deepEqual(buildReasoningParams({ effort: 'off', format: 'qwen' }), { enable_thinking: false });
  const high = buildReasoningParams({ effort: 'high', format: 'qwen' });
  assert.equal(high.enable_thinking, true);
  assert.equal(high.thinking_budget, 8192);
  const custom = buildReasoningParams({ effort: 'low', format: 'qwen', budget: 2048 });
  assert.equal(custom.thinking_budget, 2048);
});

test('Claude / Gemini / 思考开关 / Ollama 各自的字段', () => {
  assert.deepEqual(buildReasoningParams({ effort: 'off', format: 'anthropic' }), { thinking: { type: 'disabled' } });
  assert.deepEqual(buildReasoningParams({ effort: 'medium', format: 'anthropic' }), {
    thinking: { type: 'enabled', budget_tokens: 4096 },
  });
  assert.deepEqual(buildReasoningParams({ effort: 'off', format: 'gemini' }), {
    extra_body: { google: { thinking_config: { thinking_budget: 0 } } },
  });
  assert.deepEqual(buildReasoningParams({ effort: 'high', format: 'gemini' }), {
    extra_body: { google: { thinking_config: { thinking_budget: 8192 } } },
  });
  assert.deepEqual(buildReasoningParams({ effort: 'off', format: 'thinking' }), { thinking: { type: 'disabled' } });
  assert.deepEqual(buildReasoningParams({ effort: 'high', format: 'thinking' }), { thinking: { type: 'enabled' } });
  assert.deepEqual(buildReasoningParams({ effort: 'off', format: 'ollama' }), { think: false });
  assert.deepEqual(buildReasoningParams({ effort: 'high', format: 'ollama' }), { think: 'high' });
});

test('OpenRouter：reasoning.effort（可带 max_tokens）', () => {
  assert.deepEqual(buildReasoningParams({ effort: 'off', format: 'openrouter' }), {});
  assert.deepEqual(buildReasoningParams({ effort: 'high', format: 'openrouter' }), {
    reasoning: { effort: 'high', max_tokens: 8192 },
  });
});

test('自动模式：档位按当前模型的字段翻译', () => {
  assert.deepEqual(buildReasoningParams({ effort: 'high', format: 'auto', model: 'qwen3-8b' }), {
    enable_thinking: true,
    thinking_budget: 8192,
  });
  assert.deepEqual(buildReasoningParams({ effort: 'high', format: 'auto', model: 'gpt-5' }), {
    reasoning_effort: 'high',
  });
  assert.deepEqual(buildReasoningParams({ effort: 'off', format: 'auto', model: 'deepseek-chat' }), {
    thinking: { type: 'disabled' },
  });
});

test('能说清「这次到底会发什么」', () => {
  assert.equal(describeParams({ reasoning_effort: 'high' }), 'reasoning_effort=high');
  assert.equal(describeParams({ enable_thinking: true, thinking_budget: 4096 }), 'enable_thinking=true，thinking_budget=4096');
  assert.equal(describeParams({ thinking: { type: 'enabled', budget_tokens: 1024 } }), 'thinking.type=enabled，thinking.budget_tokens=1024');

  const info = explainReasoning({ effort: 'high', format: 'auto', model: 'qwen3-8b' });
  assert.equal(info.format, 'qwen');
  assert.equal(info.kind, 'budget');
  assert.match(info.describe, /enable_thinking/);
  const sw = explainReasoning({ effort: 'high', format: 'auto', model: 'deepseek-chat' });
  assert.equal(sw.kind, 'switch', '只有开关的家族要说清楚');
});

test('能认出「服务端不认思考参数」这类报错', () => {
  assert.equal(unsupportedReasoning('Unrecognized request argument supplied: reasoning_effort'), true);
  assert.equal(unsupportedReasoning('{"error":"enable_thinking is not supported"}'), true);
  assert.equal(unsupportedReasoning('thinking_budget must be <= 32768'), true);
  assert.equal(unsupportedReasoning('Invalid API key provided'), false);
  assert.equal(unsupportedReasoning('model not found'), false);
  assert.equal(unsupportedReasoning(''), false);
});

// ── 配置层 ────────────────────────────────────────────────────────────────

test('配置：AI_REASONING_EFFORT / FORMAT / BUDGET 能读出来', () => {
  const cfg = loadConfig({
    env: { AI_REASONING_EFFORT: 'high', AI_REASONING_FORMAT: 'qwen', AI_REASONING_BUDGET: '2048' },
    rootDir: tmpRoot(),
  });
  assert.equal(cfg.ai.reasoningEffort, 'high');
  assert.equal(cfg.ai.reasoningFormat, 'qwen');
  assert.equal(cfg.ai.reasoningBudget, 2048);
});

test('配置：默认关闭思考、格式默认自动，写错会被体检报出来', () => {
  const cfg = loadConfig({ env: {}, rootDir: tmpRoot() });
  assert.equal(cfg.ai.reasoningEffort, 'off');
  assert.equal(cfg.ai.reasoningFormat, 'auto');

  const bad = loadConfig({ env: { AI_REASONING_EFFORT: '超长' }, rootDir: tmpRoot() });
  assert.equal(bad.ai.reasoningEffort, 'off', '写错的值不能生效');
  assert.ok(
    validateConfig(bad).some((e) => /AI_REASONING_EFFORT/.test(e)),
    '体检要能指出档位写错了'
  );

  const bad2 = loadConfig({ env: { AI_REASONING_FORMAT: '不存在的格式' }, rootDir: tmpRoot() });
  assert.ok(
    validateConfig(bad2).some((e) => /AI_REASONING_FORMAT/.test(e)),
    '体检要能指出格式写错了'
  );
});

// ── 请求链路 ──────────────────────────────────────────────────────────────

test('AIClient：思考强度会进请求体', async () => {
  const ai = await fakeAI('好的');
  const client = new AIClient({
    baseUrl: `http://127.0.0.1:${ai.port}`,
    apiKey: 'k',
    model: 'm',
    timeoutMs: 3000,
    logger: silence,
    reasoningEffort: 'high',
  });
  await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(ai.calls[0].reasoning_effort, 'high');
  ai.server.close();
});

test('AIClient：按模型名自动选对字段（Qwen3 用 enable_thinking）', async () => {
  const ai = await fakeAI('好的');
  const client = new AIClient({
    baseUrl: `http://127.0.0.1:${ai.port}`,
    apiKey: 'k',
    model: 'qwen3-8b',
    timeoutMs: 3000,
    logger: silence,
    reasoningEffort: 'high',
    reasoningFormat: 'auto',
  });
  await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(ai.calls[0].enable_thinking, true);
  assert.equal(ai.calls[0].thinking_budget, 8192);
  assert.equal(ai.calls[0].reasoning_effort, undefined);
  ai.server.close();
});

test('AIClient：关闭思考时请求体不带任何思考字段', async () => {
  const ai = await fakeAI('好的');
  const client = new AIClient({
    baseUrl: `http://127.0.0.1:${ai.port}`,
    apiKey: 'k',
    model: 'm',
    timeoutMs: 3000,
    logger: silence,
    reasoningEffort: 'off',
  });
  await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(ai.calls[0].reasoning_effort, undefined);
  assert.equal(ai.calls[0].enable_thinking, undefined);
  ai.server.close();
});

test('AIClient：服务端不认思考参数时自动去掉重试一次（换模型也不会哑）', async () => {
  const ai = await fakeAI('好的', (body, n) =>
    n === 1 ? { status: 400, text: '{"error":"Unrecognized request argument supplied: reasoning_effort"}' } : null
  );
  const client = new AIClient({
    baseUrl: `http://127.0.0.1:${ai.port}`,
    apiKey: 'k',
    model: 'm',
    timeoutMs: 3000,
    logger: silence,
    reasoningEffort: 'medium',
  });
  const res = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(res.text, '好的');
  assert.equal(ai.calls.length, 2, '应该重试一次');
  assert.equal(ai.calls[0].reasoning_effort, 'medium');
  assert.equal(ai.calls[1].reasoning_effort, undefined, '重试时要把思考参数去掉');
  ai.server.close();
});

test('AIReply：全局思考强度会带到模型请求里', async () => {
  const ai = await fakeAI('好的');
  const hook = { async sendText() { return { ok: true }; } };
  const client = new AIClient({
    baseUrl: `http://127.0.0.1:${ai.port}`,
    apiKey: 'k',
    model: 'm',
    timeoutMs: 3000,
    logger: silence,
    reasoningEffort: 'high',
  });
  const air = new AIReply({
    cfg: { enabled: true, reasoningEffort: 'high', groupReply: 'always', maxReplyChars: 900, stripMarkdown: true },
    ai: client,
    memory: new Memory({}),
    hook,
    logger: silence,
  });
  await air.handle({ chatType: 'private', kind: 'text', text: '在吗', chatId: 'a', senderId: 'a' });
  assert.equal(ai.calls[0].reasoning_effort, 'high');
  ai.server.close();
});

test('按会话配置：某个会话可以单独设思考强度', () => {
  const profiles = new ChatProfiles({
    chats: { 'g@chatroom': { reasoningEffort: 'low' } },
  });
  const air = new AIReply({
    cfg: { enabled: true, reasoningEffort: 'high', groupReply: 'always' },
    ai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', reasoningEffort: 'high' },
    memory: new Memory({}),
    hook: { async sendText() { return { ok: true }; } },
    logger: silence,
    profiles,
  });
  const c = air.aiForChat(profiles.get('g@chatroom'));
  assert.equal(c.reasoningEffort, 'low');
  // 没配的会话沿用全局客户端
  assert.equal(air.aiForChat(profiles.get('other')), air.defaultAI);
});

// ── 命令行 ────────────────────────────────────────────────────────────────

test('命令行：档位解析认英文也认中文', () => {
  assert.equal(parseEffort('high'), 'high');
  assert.equal(parseEffort('高'), 'high');
  assert.equal(parseEffort('中'), 'medium');
  assert.equal(parseEffort('关'), 'off');
  assert.equal(parseEffort('看不懂'), '');
  assert.equal(parseFormat('qwen'), 'qwen');
  assert.equal(parseFormat('通义'), 'qwen');
  assert.equal(parseFormat('claude'), 'anthropic');
  assert.equal(parseFormat('自动'), 'auto');
  assert.equal(parseFormat('看不懂'), '');
});
