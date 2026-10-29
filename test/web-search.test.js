import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSearch, cleanResults, formatContext, runSearch } from '../src/ai/tools/web-search.js';

test('shouldSearch: always 模式恒真（空文本除外）', () => {
  assert.equal(shouldSearch('你好', { mode: 'always' }), true);
  assert.equal(shouldSearch('', { mode: 'always' }), false);
});

test('shouldSearch: prefix 模式仅前缀命中', () => {
  assert.equal(shouldSearch('/web 北京天气', { mode: 'prefix', prefix: '/web' }), true);
  assert.equal(shouldSearch('请 /web 查一下', { mode: 'prefix', prefix: '/web' }), false);
});

test('shouldSearch: auto 模式按启发式', () => {
  assert.equal(shouldSearch('今天天气怎么样', { mode: 'auto' }), true); // 时间敏感词
  assert.equal(shouldSearch('帮我搜索一下比特币价格', { mode: 'auto' }), true); // 显式检索词
  assert.equal(shouldSearch('讲个笑话', { mode: 'auto' }), false); // 无关
});

test('cleanResults: 限制条数 / 截断 / 过滤广告', () => {
  const raw = [
    { title: 'A', url: 'https://a.com', snippet: 'x'.repeat(5000) },
    { title: '广告', url: 'https://ad.com', snippet: 'short' },
    { title: 'B', url: 'https://b.com', snippet: 'hello' },
    { title: '', url: 'https://c.com', snippet: 'no title' },
    { title: 'C', url: 'https://c.com', snippet: 'world' },
  ];
  const out = cleanResults(raw, { maxResults: 3, maxChars: 100 });
  assert.ok(out.length <= 3, '条数受 maxResults 限制');
  assert.ok(out.every((r) => r.snippet.length <= 100), '片段受 maxChars 截断');
  assert.ok(!out.some((r) => r.title === '广告'), '过滤广告');
  assert.ok(out.some((r) => r.title === 'A'), '保留正常结果');
});

test('formatContext: 有结果拼文本，无结果返回空', () => {
  assert.equal(formatContext([], 'q'), '');
  const ctx = formatContext([{ title: 'A', url: 'https://a.com', snippet: 'hi' }], 'q');
  assert.match(ctx, /联网检索结果/);
  assert.match(ctx, /https:\/\/a\.com/);
});

test('runSearch: 关闭时不发任何请求（WS1）', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('不应被调用'); };
  const r = await runSearch({ query: '今天新闻', config: { enabled: false }, fetchImpl });
  assert.equal(r, null);
  assert.equal(called, false);
});

test('runSearch: 需要 key 但没给 → 不发请求返回 null', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('不应被调用'); };
  const r = await runSearch({
    query: '/web 测试',
    config: { enabled: true, provider: 'tavily', apiKey: '', mode: 'prefix', prefix: '/web' },
    fetchImpl,
  });
  assert.equal(r, null);
  assert.equal(called, false);
});

test('runSearch: tavily 正常检索并清洗注入（mock fetch）', async () => {
  const fakeData = { results: [{ title: 'T', url: 'https://x.com', content: '一些内容' }] };
  const fetchImpl = async (url, init) => {
    assert.match(url, /tavily\.com/);
    assert.equal(init.method, 'POST');
    return { ok: true, json: async () => fakeData };
  };
  const r = await runSearch({
    query: '/web 测试',
    config: { enabled: true, provider: 'tavily', apiKey: 'k', mode: 'prefix', prefix: '/web' },
    fetchImpl,
  });
  assert.ok(r && r.context);
  assert.match(r.context, /https:\/\/x\.com/);
  assert.equal(r.provider, 'tavily');
});

test('runSearch: serpapi / bing 解析', async () => {
  const serp = { organic_results: [{ title: 'S', link: 'https://s.com', snippet: 'snip' }] };
  const bing = { webPages: { value: [{ name: 'B', url: 'https://b.com', snippet: 'bb' }] } };
  const mk = (data) => async () => ({ ok: true, json: async () => data });
  const rs = await runSearch({
    query: '/web x', config: { enabled: true, provider: 'serpapi', apiKey: 'k', mode: 'prefix', prefix: '/web' }, fetchImpl: mk(serp),
  });
  assert.match(rs.context, /https:\/\/s\.com/);
  const rb = await runSearch({
    query: '/web x', config: { enabled: true, provider: 'bing', apiKey: 'k', mode: 'prefix', prefix: '/web' }, fetchImpl: mk(bing),
  });
  assert.match(rb.context, /https:\/\/b\.com/);
});
