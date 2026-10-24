/**
 * 模型连通性探测：拉模型列表、试聊一句、扫描本机已跑起来的服务。
 *
 * 这一层专门伺候新手：
 * - 不只说「请求失败」，而是告诉他「为什么失败、接下来该干什么」；
 * - 能一键扫出本机已经装好并启动的模型服务，不用手填地址。
 */

import { normalizeBase } from './client.js';
import { LOCAL_PORTS } from './providers.js';

/** 统一的错误翻译：技术错误 → 人话 + 下一步怎么办。 */
export function explainError(err, ctx = {}) {
  const raw = String(err?.message || err || '');
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(ctx.baseUrl || '');

  if (/ECONNREFUSED|connect ECONNREFUSED/i.test(raw)) {
    return isLocal
      ? {
          title: '连不上：模型服务还没启动',
          detail:
            '本机这个地址没人应答。先把模型服务跑起来（本地模型要开 ollama serve，或在 LM Studio 里点 Start Server），再回来测试。',
          fix: 'start-service',
        }
      : {
          title: '连不上：地址填错或服务没开',
          detail: '这个地址拒绝了连接。检查一下地址是不是抄错了、有没有少写 /v1。',
          fix: 'check-url',
        };
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return { title: '找不到这个网址', detail: '域名解析不了，多半是地址拼错了，或者网络不通。', fix: 'check-url' };
  }
  if (/401|unauthorized|invalid.?api.?key|incorrect api key/i.test(raw)) {
    return {
      title: '密钥不对',
      detail:
        '服务收到了请求，但不认这个密钥。要么没填，要么复制时漏了字符（常见：少了末尾几个字母、带了空格或引号）。',
      fix: 'check-key',
    };
  }
  if (/403|forbidden|permission/i.test(raw)) {
    return {
      title: '密钥没有权限',
      detail: '密钥被服务拒绝了。可能是没开通这个模型、地区限制，或者用错了密钥类型。',
      fix: 'check-key',
    };
  }
  if (/404|not found|model_not_found|does not exist/i.test(raw)) {
    return {
      title: '模型名不对',
      detail: '地址是通的，但服务里没有这个模型名。点「拉取模型」看看它到底有哪些模型，挑一个填进来。',
      fix: 'pick-model',
    };
  }
  if (/429|rate limit|quota|余额|insufficient/i.test(raw)) {
    return {
      title: '额度用完了或请求太频繁',
      detail: '云端服务一般按量计费，余额不足就会这样。本地模型一般是同时请求太多，等一下再试。',
      fix: 'wait-or-check-balance',
    };
  }
  if (/abort|timeout|超时/i.test(raw)) {
    return {
      title: '太慢了，超时',
      detail: isLocal
        ? '本地模型第一次回答要加载权重，可能要几十秒；机器太慢的话把超时时间调大，或换个更小的模型。'
        : '网络慢或者服务商拥堵。可以调大超时时间，或者换个服务商试试。',
      fix: 'increase-timeout',
    };
  }
  if (/ECONNRESET|socket hang up|terminated/i.test(raw)) {
    return { title: '连接被中断', detail: '刚连上就断了。服务可能崩了或被重启，重启服务再试一次。', fix: 'restart-service' };
  }
  if (/500|502|503|internal server error|bad gateway/i.test(raw)) {
    return { title: '服务商那边出错了', detail: '请求到了，但服务内部出错。稍后重试，或换一家服务商。', fix: 'retry-later' };
  }
  return { title: '没成功', detail: raw ? raw.slice(0, 200) : '未知原因', fix: 'check-url' };
}

/** 拉取服务端可用的模型列表（OpenAI 兼容的 GET /models）。 */
export async function listModels({ baseUrl, apiKey = '', timeoutMs = 8000 } = {}) {
  const base = normalizeBase(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('返回的不是 JSON（地址可能填错了）');
    }
    const list = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.models)
        ? json.models
        : Array.isArray(json)
          ? json
          : [];
    const ids = list
      .map((m) => (typeof m === 'string' ? m : m?.id || m?.name || m?.model || ''))
      .filter(Boolean)
      .map((s) => String(s));
    return { ok: true, base, models: [...new Set(ids)].sort() };
  } catch (err) {
    return { ok: false, base, models: [], error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 试聊一句：真发一次最小请求，确认「地址 + 密钥 + 模型名」三件套都对。
 * 用最省 token 的提示词，返回里带上模型原话，方便用户确认「它真的在回答我」。
 */
export async function testChat({ baseUrl, apiKey = '', model, timeoutMs = 20000 } = {}) {
  const base = normalizeBase(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model || '',
        messages: [{ role: 'user', content: '你好，请回一句「测试成功」就行。' }],
        max_tokens: 32,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      return { ok: false, ms, base, error: err.message, ...explainError(err, { baseUrl: base }) };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        ms,
        base,
        error: '返回的不是 JSON（地址可能填错了）',
        title: '返回格式不对',
        detail: '这个地址不像模型接口，检查是否填到了正确的 /v1 地址。',
      };
    }
    const choice = json?.choices?.[0];
    const reply =
      (typeof choice?.message?.content === 'string' && choice.message.content.trim()) ||
      (Array.isArray(choice?.message?.content)
        ? choice.message.content.map((p) => p?.text || '').join('').trim()
        : '') ||
      (typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.trim() : '') ||
      '';
    if (!reply) {
      return {
        ok: false,
        ms,
        base,
        error: '模型没有返回内容',
        title: '模型没回话',
        detail: '请求成功了但内容是空的，可能是这个模型不支持 chat 接口，换个模型试试。',
      };
    }
    return { ok: true, ms, base, reply: reply.slice(0, 300), model: json.model || model || '' };
  } catch (err) {
    const ms = Date.now() - started;
    if (err?.name === 'AbortError') {
      const e = new Error('timeout');
      return { ok: false, ms, base, error: `超时（${timeoutMs}ms 没等到回复）`, ...explainError(e, { baseUrl: base }) };
    }
    return { ok: false, ms, base, error: err?.message || String(err), ...explainError(err, { baseUrl: base }) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 扫描本机：哪些模型服务已经跑起来了。
 *
 * 这是给新手的「一键搞定」：不用查地址是哪个端口，
 * 扫一遍就知道电脑上有没有 Ollama / LM Studio 在跑，里面有哪些模型。
 */
export async function discoverLocal({ timeoutMs = 1200 } = {}) {
  const results = await Promise.all(
    LOCAL_PORTS.map(async (p) => {
      const base = `http://127.0.0.1:${p.port}/v1`;
      const r = await listModels({ baseUrl: base, timeoutMs });
      if (!r.ok) return null;
      return {
        port: p.port,
        name: p.name,
        providerId: p.providerId,
        baseUrl: base,
        models: r.models,
      };
    })
  );
  return results.filter(Boolean);
}

/** 一句话点评当前配置，像朋友一样给建议。 */
export function reviewConfig({ baseUrl, apiKey, model } = {}) {
  const tips = [];
  const b = String(baseUrl || '').trim();
  if (!b) {
    tips.push({ level: 'bad', text: '还没填模型服务地址 —— 先在上面选一个「本地」或「云端」。' });
    return tips;
  }
  if (!/^https?:\/\//i.test(b)) {
    tips.push({ level: 'warn', text: '地址建议写全 http:// 或 https:// 开头。' });
  }
  if (/\/chat\/completions/i.test(b)) {
    tips.push({ level: 'bad', text: '地址填到 /v1 为止就行，别把 /chat/completions 也写进去。' });
  }
  if (!/\/v\d+(\/|$)/i.test(b)) {
    tips.push({ level: 'warn', text: '地址末尾通常要有 /v1，漏了可能连不上。' });
  }
  if (!model) {
    tips.push({ level: 'warn', text: '还没填模型名 —— 点「拉取模型」看看有哪些，或用默认的。' });
  }
  if (!apiKey && !/127\.0\.0\.1|localhost/i.test(b)) {
    tips.push({ level: 'warn', text: '云端服务一般需要密钥；本地模型才不用填。' });
  }
  if (!tips.length) {
    tips.push({ level: 'ok', text: '看着没问题，点「测试一下」确认一下。' });
  }
  return tips;
}

