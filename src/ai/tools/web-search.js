/**
 * 联网搜索（Web Search）工具模块。
 *
 * 设计原则（见 plan-2.0.0.md §16.2）：
 *  - 默认关闭、显式 opt-in（隐私 / 离线优先）。
 *  - 策略 B：AutoChat 自己抓网页 → 清洗 → 注入上下文；不依赖模型是否支持 function calling，
 *    因此本地模型（Ollama 等）同样可用（用户开启即自行权衡隐私，见 WS5）。
 *  - provider 可配：tavily / serpapi / bing / custom。
 *
 * 本模块不读全局配置、默认不发起真实网络：runSearch 的 fetch 可注入（测试 mock），
 * 编排为：shouldSearch() 触发判定 → runSearch() 调 provider → cleanResults() 清洗 → formatContext() 拼上下文。
 */

/** 各 provider 的接入定义：buildRequest 产出 {url, init, parse}。 */
export const WEB_SEARCH_PROVIDERS = {
  tavily: {
    name: 'Tavily',
    needsKey: true,
    buildRequest(query, key) {
      return {
        url: 'https://api.tavily.com/search',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: key, query, max_results: 5, include_answer: false }),
        },
        parse: (data) => (data?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content || '' })),
      };
    },
  },
  serpapi: {
    name: 'SerpAPI',
    needsKey: true,
    buildRequest(query, key) {
      const u = new URL('https://serpapi.com/search.json');
      u.searchParams.set('engine', 'google');
      u.searchParams.set('q', query);
      if (key) u.searchParams.set('api_key', key);
      return {
        url: u.toString(),
        init: { method: 'GET' },
        parse: (data) => (data?.organic_results || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || '' })),
      };
    },
  },
  bing: {
    name: 'Bing',
    needsKey: true,
    buildRequest(query, key) {
      const u = new URL('https://api.bing.microsoft.com/v7.0/search');
      u.searchParams.set('q', query);
      return {
        url: u.toString(),
        init: { method: 'GET', headers: { 'Ocp-Apim-Subscription-Key': key || '' } },
        parse: (data) => (data?.webPages?.value || []).map((r) => ({ title: r.name, url: r.url, snippet: r.snippet || '' })),
      };
    },
  },
  custom: {
    name: '自建 / 其它',
    needsKey: false,
    buildRequest(query, key, endpoint) {
      return {
        url: endpoint || '',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, apiKey: key }),
        },
        // 自建服务应返回 { results: [{title, url, snippet}] }
        parse: (data) => (data?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet || '' })),
      };
    },
  },
};

/** 时间敏感 / 需要最新事实的关键词（auto 模式启发式）。 */
export const TIME_SENSITIVE = ['今天', '昨天', '明天', '最新', '现在', '当前', '新闻', '天气', '股价', '汇率', '价格', '2026', '2025', '刚刚', '实时'];
/** 显式要求检索的词。 */
export const EXPLICIT_SEARCH_WORDS = ['搜索', '查一下', '查一查', '上网查', 'google', '网上找'];

/**
 * 触发判定：是否要联网搜。
 * @param {string} text 用户文本
 * @param {{mode?:'always'|'auto'|'prefix', prefix?:string}} [opts]
 * @returns {boolean}
 */
export function shouldSearch(text, { mode = 'auto', prefix = '/web' } = {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (mode === 'always') return true;
  if (mode === 'prefix') return t.startsWith(prefix);
  // auto：显式前缀 或 时间敏感词 或 显式检索词
  if (prefix && t.startsWith(prefix)) return true;
  if (TIME_SENSITIVE.some((k) => t.includes(k))) return true;
  if (EXPLICIT_SEARCH_WORDS.some((k) => t.toLowerCase().includes(k.toLowerCase()))) return true;
  return false;
}

/**
 * 清洗结果：去空、截断、限制条数、过滤明显广告。
 * @param {Array<{title?:string,url?:string,snippet?:string}>} items
 * @param {{maxResults?:number, maxChars?:number}} [opts]
 * @returns {Array<{title:string,url:string,snippet:string}>}
 */
export function cleanResults(items = [], { maxResults = 5, maxChars = 4000 } = {}) {
  const list = (items || [])
    .filter((it) => it && (it.title || it.snippet) && it.url)
    .map((it) => ({
      title: String(it.title || '').slice(0, 200),
      url: String(it.url || ''),
      snippet: String(it.snippet || '').replace(/\s+/g, ' ').trim().slice(0, maxChars),
    }))
    // 标题即「广告/赞助」且无明显正文的，视为广告剔除
    .filter((it) => !/广告|赞助|sponsored/i.test(it.title) || it.snippet.length > 20);
  return list.slice(0, maxResults);
}

/**
 * 把结果拼成可注入上下文的文本。
 * @param {Array} results cleanResults 的输出
 * @param {string} [query] 原始查询（用于标注）
 * @returns {string}
 */
export function formatContext(results = [], query = '') {
  if (!results.length) return '';
  const head = query ? `【联网检索结果（查询：「${query}」）】` : '【联网检索结果】';
  const body = results
    .map((r, i) => `${i + 1}. ${r.title}\n   链接：${r.url}\n   摘要：${r.snippet}`)
    .join('\n\n');
  return `${head}\n${body}\n\n请优先依据上面的检索结果回答，并在回答中标注信息来源链接；若结果与问题无关，可忽略。`;
}

/**
 * 编排：判定 → 调 provider → 清洗 → 拼上下文。
 * @param {object} args
 * @param {string} args.query 用户查询
 * @param {object} [args.config] { enabled, provider, apiKey, mode, prefix, maxResults, maxChars, customEndpoint }
 * @param {Function} [args.fetchImpl] 注入用（测试 mock），默认全局 fetch
 * @returns {Promise<{context:string, results:Array, provider:string}|null>}
 */
export async function runSearch({ query, config = {}, fetchImpl } = {}) {
  const {
    enabled = false,
    provider = 'tavily',
    apiKey = '',
    mode = 'auto',
    prefix = '/web',
    maxResults = 5,
    maxChars = 4000,
    customEndpoint = '',
  } = config;

  if (!enabled) return null; // WS1：默认 off，绝不发请求
  if (!shouldSearch(query, { mode, prefix })) return null;
  const prov = WEB_SEARCH_PROVIDERS[provider] || WEB_SEARCH_PROVIDERS.tavily;
  if (prov.needsKey && !apiKey) return null; // 需要 key 却没给：不发请求，交给上层提示

  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('no fetch implementation available');
  const req = provider === 'custom' ? prov.buildRequest(query, apiKey, customEndpoint) : prov.buildRequest(query, apiKey);
  const resp = await doFetch(req.url, req.init);
  if (!resp.ok) throw new Error(`web search provider ${provider} HTTP ${resp.status}`);
  const data = await resp.json();
  const results = cleanResults(req.parse(data), { maxResults, maxChars });
  const context = formatContext(results, query);
  return { context, results, provider };
}
