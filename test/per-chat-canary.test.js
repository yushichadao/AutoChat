import test from 'node:test';
import assert from 'node:assert/strict';
import { AIReply } from '../src/ai/replier.js';
import { ChatProfiles } from '../src/core/chats.js';

const stubLogger = { info() {}, warn() {}, debug() {}, error() {} };

function makeReplier(chats, extra = {}) {
  const cfg = {
    webSearch: false, // 全局总开关默认关（灰度起点）
    webSearchProvider: 'tavily',
    webSearchKey: 'k',
    webSearchMode: 'auto',
    webSearchPrefix: '/web',
    webSearchMaxResults: 5,
    webSearchMaxChars: 4000,
    aiTools: false, // 全局工具总开关也默认关
    groupReply: 'mention',
    maxPerHour: 120,
    cooldownMs: 3000,
    maxConcurrent: 2,
    enabled: true,
    ...extra,
  };
  return new AIReply({
    cfg,
    ai: { chat: async () => ({ text: '' }) },
    logger: stubLogger,
    profiles: new ChatProfiles({ chats }),
  });
}

test('ChatProfiles.get 返回 per-chat 的 webSearch/aiTools 覆盖', () => {
  const p = new ChatProfiles({ chats: { 'a@chatroom': { webSearch: true }, 'b@chatroom': { aiTools: true, webSearch: false } } });
  assert.equal(p.get('a@chatroom').webSearch, true);
  assert.equal(p.get('b@chatroom').aiTools, true);
  assert.equal(p.get('b@chatroom').webSearch, false);
  // 没配 → 跟随全局（undefined）
  assert.equal(p.get('c@chatroom').webSearch, undefined);
  // 空串表示「跟随全局」，不应被当成 false 卡死
  const p2 = new ChatProfiles({ chats: { 'd@chatroom': { webSearch: '' } } });
  assert.equal(p2.get('d@chatroom').webSearch, undefined);
});

test('会话开关：界面写入的 "0" 必须判为关（字符串真值陷阱）', () => {
  const p = new ChatProfiles({ chats: {
    'a@chatroom': { webSearch: '0', aiTools: '0', modelRouting: '0', docAnalysis: '0', longTaskNotice: '0' },
    'b@chatroom': { webSearch: '1', aiTools: '1', modelRouting: '1', docAnalysis: '1', longTaskNotice: '1' },
  } });
  for (const k of ['webSearch', 'aiTools', 'modelRouting', 'docAnalysis', 'longTaskNotice']) {
    assert.equal(p.get('a@chatroom')[k], false, `"0" 的 ${k} 应为关`);
    assert.equal(p.get('b@chatroom')[k], true, `"1" 的 ${k} 应为开`);
  }
});

test('灰度①：全局关 + 单群开 → 该群触发搜索，其余群不触发', async () => {
  const replier = makeReplier({ 'test@chatroom': { webSearch: true } });
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ results: [{ title: 'T', url: 'https://x.com', content: 'c' }] }) }; };
  try {
    const ovr = replier.profiles.get('test@chatroom');
    const ctx = await replier.buildWebSearchContext('今天天气怎么样', ovr);
    assert.ok(ctx, '开启的群应注入搜索上下文');
    assert.equal(calls, 1);

    // 未配置的群（或空 override）不应触发
    calls = 0;
    const ctx2 = await replier.buildWebSearchContext('今天天气怎么样', {});
    assert.equal(ctx2, null, '全局关且无覆盖时不搜索');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test('灰度②：本会话开 AI 工具 → 关闭策略 B 预注入（避免双重搜索）', async () => {
  const replier = makeReplier({ 't@chatroom': { aiTools: true } });
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ results: [] }) }; };
  try {
    const ovr = replier.profiles.get('t@chatroom');
    const ctx = await replier.buildWebSearchContext('今天有什么新闻', ovr);
    assert.equal(ctx, null, '工具开启时联网搜索交给 web_search 技能，不再预注入');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test('灰度③：全局开 + 单群关 → 该群不搜索（可单独回退）', async () => {
  const replier = makeReplier({}, { webSearch: true });
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ results: [{ title: 'T', url: 'u', content: 'c' }] }) }; };
  try {
    const ctxGlobal = await replier.buildWebSearchContext('今天天气', {});
    assert.ok(ctxGlobal, '全局开时应搜索');
    calls = 0;
    const ovr = { webSearch: false };
    const ctxOff = await replier.buildWebSearchContext('今天天气', ovr);
    assert.equal(ctxOff, null, '单群显式关应压过全局开');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = orig;
  }
});
