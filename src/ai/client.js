/**
 * OpenAI 兼容的 Chat Completions 客户端。
 * hy3 走的就是这个协议：
 *   腾讯云 TokenHub  https://tokenhub.tencentmaas.com/v1  + Bearer <API Key>
 *   CodeBuddy 本地网关 http://127.0.0.1:8787/v1          + 任意 key
 * 所以这里不写死任何厂商，只认 /chat/completions。
 */
import { buildReasoningParams, describeParams, unsupportedReasoning } from '../core/reasoning.js';

export class AIClient {
  constructor({ baseUrl, apiKey, model, timeoutMs, logger, reasoningEffort, reasoningFormat, reasoningBudget }) {
    this.baseUrl = normalizeBase(baseUrl);
    this.apiKey = apiKey || '';
    this.model = model || 'hy3';
    // 0 / 负数 / 未填 = 不限时；正数才设超时
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
    this.log = logger;
    /** 思考强度：off | low | medium | high（缺省交给上层给，见 chat()） */
    this.reasoningEffort = reasoningEffort;
    this.reasoningFormat = reasoningFormat;
    this.reasoningBudget = reasoningBudget;
    this.stats = { calls: 0, failed: 0, totalMs: 0 };
  }

  endpoint(path = '/chat/completions') {
    return `${this.baseUrl}${path}`;
  }

  /**
   * @param {Array<{role:string,content:string}>} messages
   * @returns {Promise<{text:string, usage:object|null, model:string}>}
   */
  async chat(messages, { maxTokens, temperature, reasoningEffort, reasoningFormat, reasoningBudget, tools, toolChoice } = {}) {
    const body = {
      model: this.model,
      messages,
      stream: false,
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens; // 0 = 不限制 token 数
    if (Number.isFinite(temperature)) body.temperature = temperature;

    // 思考参数：档位 + 该服务商要的字段格式（auto 时按本客户端的模型名判断）。
    const effort = reasoningEffort ?? this.reasoningEffort;
    const format = reasoningFormat ?? this.reasoningFormat;
    const budget = reasoningBudget ?? this.reasoningBudget;
    const reasoning = buildReasoningParams({ effort, format, budget, model: this.model, baseUrl: this.baseUrl });
    const reasoningKeys = Object.keys(reasoning);
    if (reasoningKeys.length) {
      Object.assign(body, reasoning);
      this.log?.debug?.(`思考参数：${describeParams(reasoning)}`);
    }

    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }

    const controller = new AbortController();
    const timer = this.timeoutMs && this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    const started = Date.now();

    try {
      this.stats.calls += 1;
      let res = await this.post(body, controller.signal);
      let text = await res.text();

      // 服务端不认这套思考参数（换个模型 / 换个服务商就常见）时，
      // 自动去掉再试一次 —— 宁可少一次思考，也不能让助手彻底不说话。
      if (!res.ok && reasoningKeys.length && (res.status === 400 || res.status === 422) && unsupportedReasoning(text)) {
        this.log?.warn?.(
          `服务端不认思考参数（${reasoningKeys.join('、')}），已去掉后重试：${truncate(text, 120)}`
        );
        for (const k of reasoningKeys) delete body[k];
        res = await this.post(body, controller.signal);
        text = await res.text();
      }

      if (!res.ok) {
        throw new Error(`AI 接口 ${res.status}: ${truncate(text, 200)}`);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`AI 返回非 JSON: ${truncate(text, 200)}`);
      }

      const content = extractContent(json);
      const toolCalls = extractToolCalls(json);
      if (!content && (!toolCalls || !toolCalls.length)) throw new Error('AI 返回内容为空');

      this.stats.totalMs += Date.now() - started;
      return { text: content, toolCalls: toolCalls || [], usage: json.usage || null, model: json.model || this.model };
    } catch (err) {
      this.stats.failed += 1;
      if (err.name === 'AbortError') throw new Error(`AI 请求超时（${this.timeoutMs}ms）`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 发一次请求（带鉴权）。 */
  async post(body, signal) {
    return fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
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

/** 解析模型返回的 tool_calls（OpenAI 兼容格式）。 */
export function extractToolCalls(json) {
  const tcs = json?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(tcs) || !tcs.length) return [];
  return tcs.map((tc) => ({
    id: tc.id,
    type: tc.type || 'function',
    function: { name: tc.function?.name, arguments: tc.function?.arguments },
  }));
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
