import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../src/ai/tools/loop.js';
import { callTool, allSkillNames, listToolDefs } from '../src/ai/tools/registry.js';

/** 一个按序列返回固定响应的假 AIClient。 */
function mockAI(sequence) {
  let i = 0;
  return {
    chat() {
      return Promise.resolve(sequence[i++] || { text: '兜底回复', toolCalls: [] });
    },
  };
}

test('registry: 内置技能齐全', () => {
  const names = allSkillNames();
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('calculator'));
  assert.ok(names.includes('time'));
  assert.equal(listToolDefs(['calculator']).length, 1);
  assert.equal(listToolDefs(['calculator'])[0].function.name, 'calculator');
});

test('registry: calculator / time 直接计算', async () => {
  assert.deepEqual(await callTool('calculator', { expression: '2*3+1' }), { result: 7 });
  const t = await callTool('time', {});
  assert.ok(t.time);
  assert.ok(t.iso);
});

test('SK1: 工具关闭（白名单空）→ 走原单次 completion，无执行循环', async () => {
  const ai = mockAI([{ text: '直接回', toolCalls: [] }]);
  const r = await runToolLoop({ messages: [{ role: 'user', content: 'hi' }], ai, allowedTools: [], maxRounds: 5 });
  assert.equal(r.rounds, 1);
  assert.equal(r.calls.length, 0);
  assert.equal(r.text, '直接回');
});

test('SK2: tool_calls 解析 + 执行循环：计算后被回填再调用', async () => {
  const ai = mockAI([
    { text: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+2"}' } }] },
    { text: '答案是 3', toolCalls: [] },
  ]);
  const r = await runToolLoop({ messages: [{ role: 'user', content: '1+2' }], ai, allowedTools: ['calculator'], maxRounds: 5 });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'calculator');
  assert.deepEqual(r.calls[0].result, { result: 3 });
  assert.equal(r.text, '答案是 3');
});

test('SK3: 白名单拦截未授权工具', async () => {
  const ai = mockAI([
    { text: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] },
    { text: 'ok', toolCalls: [] },
  ]);
  const r = await runToolLoop({ messages: [{ role: 'user', content: 'x' }], ai, allowedTools: ['calculator'], maxRounds: 5 });
  assert.equal(r.calls[0].name, 'web_search');
  assert.ok(r.calls[0].result && r.calls[0].result.error, '未授权工具应被拦截');
});

test('SK3: AI_TOOLS_MAX_ROUNDS 防死循环', async () => {
  const ai = mockAI([
    { text: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } }] },
    { text: '', toolCalls: [{ id: 'c2', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2+2"}' } }] },
    { text: '最终', toolCalls: [] },
  ]);
  const r = await runToolLoop({ messages: [{ role: 'user', content: 'x' }], ai, allowedTools: ['calculator'], maxRounds: 2 });
  assert.equal(r.rounds, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.text, '最终');
});

test('SK4: web_search 收编为内置 skill，复用 provider（mock fetch）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [{ title: 'T', url: 'https://x.com', content: '一些内容' }] }) });
  try {
    const ai = mockAI([
      { text: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"今天新闻"}' } }] },
      { text: '据检索，今天…', toolCalls: [] },
    ]);
    const r = await runToolLoop({
      messages: [{ role: 'user', content: '今天新闻' }],
      ai,
      allowedTools: ['web_search'],
      maxRounds: 5,
      toolCtx: { webSearchConfig: { provider: 'tavily', key: 'k', maxResults: 5, maxChars: 4000, prefix: '/web' } },
    });
    assert.equal(r.calls[0].name, 'web_search');
    assert.ok(r.calls[0].result.context, 'web_search 技能应返回检索上下文');
    assert.match(r.calls[0].result.context, /https:\/\/x\.com/);
    assert.equal(r.text, '据检索，今天…');
  } finally {
    globalThis.fetch = orig;
  }
});

test('SK5: web_search 技能 custom 服务商免 key（自建 SearXNG 场景）', async () => {
  const noEndpoint = await callTool('web_search', { query: '天气' }, { webSearchConfig: { provider: 'custom', key: '', customEndpoint: '' } });
  assert.match(String(noEndpoint.error), /AI_WEB_SEARCH_CUSTOM_URL/, 'custom 缺的是端点不是 key');
  const tavilyNoKey = await callTool('web_search', { query: '天气' }, { webSearchConfig: { provider: 'tavily', key: '' } });
  assert.match(String(tavilyNoKey.error), /AI_WEB_SEARCH_KEY/, 'tavily 没 key 才报 key 错');
});
