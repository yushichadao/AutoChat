/**
 * OpenAI 兼容的 Chat Completions 客户端。
 * hy3 走的就是这个协议：
 *   腾讯云 TokenHub  https://tokenhub.tencentmaas.com/v1  + Bearer <API Key>
 *   CodeBuddy 本地网关 http://127.0.0.1:8787/v1          + 任意 key
 * 所以这里不写死任何厂商，只认 /chat/completions。
 */
export class AIClient {
  constructor({ baseUrl, apiKey, model, timeoutMs, logger }) {
    this.baseUrl = normalizeBase(baseUrl);
    this.apiKey = apiKey || '';
    this.model = model || 'hy3';
    // 0 / 负数 / 未填 = 不限时；正数才设超时
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
    this.log = logger;
    this.stats = { calls: 0, failed: 0, totalMs: 0 };
  }

  endpoint(path = '/chat/completions') {
    return `${this.baseUrl}${path}`;
  }

  /**
   * @param {Array<{role:string,content:string}>} messages
   * @returns {Promise<{text:string, usage:object|null, model:string}>}
   */
  async chat(messages, { maxTokens, temperature } = {}) {
    const body = {
      model: this.model,
      messages,
      stream: false,
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens; // 0 = 不限制 token 数
    if (Number.isFinite(temperature)) body.temperature = temperature;

    const controller = new AbortController();
    const timer = this.timeoutMs && this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    const started = Date.now();

    try {
      this.stats.calls += 1;
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        this.stats.failed += 1;
        throw new Error(`AI 接口 ${res.status}: ${truncate(text, 200)}`);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`AI 返回非 JSON: ${truncate(text, 200)}`);
      }

      const content = extractContent(json);
      if (!content) throw new Error('AI 返回内容为空');

      this.stats.totalMs += Date.now() - started;
      return { text: content, usage: json.usage || null, model: json.model || this.model };
    } catch (err) {
      this.stats.failed += 1;
      if (err.name === 'AbortError') throw new Error(`AI 请求超时（${this.timeoutMs}ms）`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 兼容 base 带不带 /v1、带不带结尾斜杠。 */
export function normalizeBase(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('AI_BASE_URL 未配置');
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  // 已经带版本号的（/v1、/v4、/v1beta、/v1beta/openai）就别再补 /v1 了
  if (!/\/v\d+[a-z]*(\/|$)/i.test(b)) b = `${b}/v1`;
  return b;
}

/** 兼容 reasoning 模型把正文放在不同字段里的情况。 */
export function extractContent(json) {
  const choice = json?.choices?.[0];
  const msg = choice?.message;
  if (!msg) return '';
  if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
  if (Array.isArray(msg.content)) {
    const joined = msg.content
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .join('')
      .trim();
    if (joined) return joined;
  }
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
    return msg.reasoning_content.trim();
  }
  if (typeof choice.text === 'string') return choice.text.trim();
  return '';
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
