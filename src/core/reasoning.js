/**
 * 思考强度（推理模型先想多久再回答）的统一口径。
 *
 * 为什么要单独一个文件：**不同厂商的「思考参数」字段完全不一样**，
 * 同一个「高」在各家要翻译成不同的字段，写死在各处迟早会漏。
 *
 * 目前认识到的几套写法（都是 OpenAI 兼容的 /v1/chat/completions 上加字段）：
 *
 * | 格式        | 字段                                | 谁在用                                        |
 * | ----------- | ----------------------------------- | --------------------------------------------- |
 * | standard    | reasoning_effort=low/medium/high    | OpenAI o 系列 / gpt-5、xAI Grok、多数聚合网关  |
 * | openrouter  | reasoning={effort,max_tokens}      | OpenRouter                                     |
 * | qwen        | enable_thinking + thinking_budget   | 通义 Qwen3 / QwQ、百度 ERNIE、硅基流动          |
 * | anthropic   | thinking={type,budget_tokens}       | Claude 系（走网关时同样吃这套）                |
 * | gemini      | extra_body.google.thinking_config   | Gemini 2.5 / 3                                 |
 * | thinking    | thinking={type:enabled/disabled}    | DeepSeek、智谱 GLM、Kimi、混元                  |
 * | ollama      | think=false / "low" / "medium" / "high" | Ollama 本地模型（gpt-oss、llama3.x）      |
 *
 * 设计约定：
 *  - 「关闭」一律翻译成该家真正的关闭语义（enable_thinking:false / thinking.type:disabled / think:false），
 *    只有 standard 这类没有关闭语义的才「不带任何字段」（用服务端默认）。
 *  - 档位到 token 预算的换算统一走 EFFORT_BUDGETS，各家可以再各自覆盖。
 *  - 猜错了不会把助手弄哑：请求层发现服务端不认这套字段会自动去掉再试一次。
 */

/** 思考档位（从省到费）。 */
export const EFFORT_LEVELS = ['off', 'low', 'medium', 'high'];

/** 档位的中文说法。 */
export const EFFORT_LABELS = { off: '关闭', low: '低', medium: '中', high: '高' };

/** 档位 → 思考 token 预算（各家可再按自己的下限调整）。 */
export const EFFORT_BUDGETS = { low: 1024, medium: 4096, high: 8192 };

/** 可选的思考参数格式。auto = 按接口地址 / 模型名自动判断。 */
export const REASONING_FORMATS = [
  'auto',
  'standard',
  'openrouter',
  'qwen',
  'anthropic',
  'gemini',
  'thinking',
  'ollama',
];

/** 格式的中文说法（界面与命令行提示共用）。 */
export const FORMAT_LABELS = {
  auto: '自动（按接口地址 / 模型名判断）',
  standard: '标准 reasoning_effort（OpenAI o/gpt-5、Grok、多数网关）',
  openrouter: 'OpenRouter reasoning.effort',
  qwen: '通义 enable_thinking（Qwen3、QwQ、百度 ERNIE）',
  anthropic: 'Claude thinking.budget_tokens',
  gemini: 'Gemini thinking_budget',
  thinking: '思考开关 thinking.type（DeepSeek、智谱 GLM、Kimi、混元）',
  ollama: 'Ollama think（gpt-oss 等本地模型）',
};

/**
 * 各类格式的控制方式：
 *  - levels：原生分档（关/低/中/高都分得清）
 *  - budget：只有开关，靠 token 预算体现强弱
 *  - switch ：只有开/关（分档没意义，强弱由模型自己定）
 */
export const FORMAT_KINDS = {
  standard: 'levels',
  openrouter: 'levels',
  qwen: 'budget',
  anthropic: 'budget',
  gemini: 'budget',
  thinking: 'switch',
  ollama: 'levels',
};

/** 档位归一化：认不出来的一律退回「关闭」（绝不让助手因为一个词失声）。 */
export function normalizeEffort(value) {
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!s) return 'off';
  if (s === 'off' || s === 'none' || s === '0' || s === 'false' || s === 'no') return 'off';
  if (s === 'low' || s === 'minimal') return 'low';
  if (s === 'medium' || s === 'mid') return 'medium';
  if (s === 'high') return 'high';
  return 'off';
}

/** 格式归一化：认不出来退回「自动」。 */
export function normalizeFormat(value) {
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!s) return 'auto';
  if (REASONING_FORMATS.indexOf(s) >= 0) return s;
  const alias = {
    openai: 'standard',
    qwq: 'qwen',
    ernie: 'qwen',
    qwen3: 'qwen',
    claude: 'anthropic',
    google: 'gemini',
    deepseek: 'thinking',
    glm: 'thinking',
    zhipu: 'thinking',
    kimi: 'thinking',
    moonshot: 'thinking',
    or: 'openrouter',
    openrouter: 'openrouter',
    ollama: 'ollama',
    none: 'standard',
    off: 'standard',
  };
  return alias[s] || 'auto';
}

/**
 * 按接口地址猜该用哪套字段（比模型名更可靠：同一个模型不同网关字段不同）。
 *
 * @param {string} baseUrl 接口地址
 * @returns {string} 具体格式名，或 ''（认不出来）
 */
export function detectFormatByBase(baseUrl) {
  const u = String(baseUrl || '').trim().toLowerCase();
  if (!u) return '';
  if (u.indexOf('openrouter.ai') >= 0) return 'openrouter';
  if (u.indexOf('api.anthropic.com') >= 0) return 'anthropic';
  if (u.indexOf('generativelanguage.googleapis.com') >= 0) return 'gemini';
  if (u.indexOf('dashscope.aliyuncs.com') >= 0) return 'qwen';
  if (u.indexOf('api.deepseek.com') >= 0) return 'thinking';
  if (u.indexOf('open.bigmodel.cn') >= 0) return 'thinking';
  if (u.indexOf('api.moonshot.cn') >= 0) return 'thinking';
  if (u.indexOf('openai.com') >= 0 || u.indexOf('api.x.ai') >= 0) return 'standard';
  return '';
}

/**
 * 按模型名猜该用哪套字段。
 *
 * 只认「明确知道支持思考」的模型；猜不出来返回空串（由调用方决定退回哪套）。
 * @param {string} model 模型名（可带厂商前缀，如 openai/gpt-5）
 * @returns {string} 具体格式名，或 ''（认不出来）
 */
export function detectFormat(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return '';
  // 带厂商前缀的（openai/gpt-5、qwen/qwen3-8b）先剥前缀，只看模型名本身
  const name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;

  if (/gpt-oss|llama-?3|llama3/.test(name)) return 'ollama';
  if (/qwen|qwq|ernie/.test(name)) return 'qwen';
  if (/claude/.test(name)) return 'anthropic';
  if (/gemini/.test(name)) return 'gemini';
  if (/deepseek|glm|chatglm|zhipu|kimi|moonshot|hunyuan|minimax|step-?fun/.test(name)) return 'thinking';
  if (/^o[134]-|o[134]$|gpt-?5|gpt-?4\.1.*thinking|grok/.test(name)) return 'standard';
  return '';
}

/**
 * 把「格式 + 模型 + 接口地址」解析成一套确定要发的字段格式。
 * @param {string} format 用户设的格式（auto 会自动判断）
 * @param {string} model 当前用的模型名
 * @param {string} baseUrl 当前用的接口地址
 * @returns {string} 具体格式名
 */
export function resolveFormat(format, model, baseUrl) {
  const f = normalizeFormat(format);
  if (f !== 'auto') return f;
  return detectFormatByBase(baseUrl) || detectFormat(model) || 'standard';
}

/**
 * 各格式的字段构造。
 * @param {{effort:string,budget:number}} o
 * @returns {object} 要并进请求体的字段
 */
function buildByFormat(format, { effort, budget }) {
  const pick = budget > 0 ? budget : EFFORT_BUDGETS[effort] || 0;
  switch (format) {
    case 'standard':
      // 没有「关闭」语义的家族：不带字段＝用服务端默认
      return effort === 'off' ? {} : { reasoning_effort: effort };
    case 'openrouter':
      if (effort === 'off') return {};
      return pick > 0 ? { reasoning: { effort, max_tokens: pick } } : { reasoning: { effort } };
    case 'qwen':
      if (effort === 'off') return { enable_thinking: false };
      return { enable_thinking: true, thinking_budget: pick };
    case 'anthropic':
      if (effort === 'off') return { thinking: { type: 'disabled' } };
      return { thinking: { type: 'enabled', budget_tokens: pick } };
    case 'gemini':
      if (effort === 'off') {
        return { extra_body: { google: { thinking_config: { thinking_budget: 0 } } } };
      }
      return { extra_body: { google: { thinking_config: { thinking_budget: pick } } } };
    case 'thinking':
      return effort === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' } };
    case 'ollama':
      return effort === 'off' ? { think: false } : { think: effort };
    default:
      return {};
  }
}

/**
 * 算出这次请求要带哪些思考字段。
 *
 * @param {object} o
 * @param {string} o.effort  档位 off/low/medium/high
 * @param {string} o.format  格式（auto 会按 model / baseUrl 判断）
 * @param {number} o.budget  思考预算 token（0 = 按档位自动）
 * @param {string} o.model   当前模型名（用于自动判断格式）
 * @param {string} o.baseUrl 当前接口地址（自动判断格式时比模型名更准）
 * @returns {object} 请求体增量（空对象＝这次不带任何思考参数）
 */
export function buildReasoningParams({ effort, format, budget, model, baseUrl } = {}) {
  const e = normalizeEffort(effort);
  const f = resolveFormat(format, model, baseUrl);
  const b = Number(budget);
  return buildByFormat(f, { effort: e, budget: Number.isFinite(b) && b > 0 ? b : 0 });
}

/** 把字段增量写成人话（界面提示 / 命令行回显用）。 */
export function describeParams(params) {
  const p = params || {};
  const bits = [];
  if (p.reasoning_effort) bits.push('reasoning_effort=' + p.reasoning_effort);
  if (p.reasoning) {
    bits.push('reasoning.effort=' + (p.reasoning.effort || '?'));
    if (p.reasoning.max_tokens) bits.push('reasoning.max_tokens=' + p.reasoning.max_tokens);
  }
  if (p.enable_thinking !== undefined) bits.push('enable_thinking=' + p.enable_thinking);
  if (p.thinking_budget) bits.push('thinking_budget=' + p.thinking_budget);
  if (p.thinking) {
    bits.push('thinking.type=' + p.thinking.type);
    if (p.thinking.budget_tokens) bits.push('thinking.budget_tokens=' + p.thinking.budget_tokens);
  }
  if (p.think !== undefined) bits.push('think=' + p.think);
  if (p.extra_body && p.extra_body.google && p.extra_body.google.thinking_config) {
    const tc = p.extra_body.google.thinking_config;
    bits.push('thinking_budget=' + (tc.thinking_budget === undefined ? '?' : tc.thinking_budget));
  }
  return bits.join('，');
}

/** 一次性算好「格式 / 字段 / 描述」，界面与命令行共用。 */
export function explainReasoning({ effort, format, budget, model, baseUrl } = {}) {
  const e = normalizeEffort(effort);
  const f = resolveFormat(format, model, baseUrl);
  const params = buildReasoningParams({ effort: e, format, budget, model, baseUrl });
  return {
    effort: e,
    label: EFFORT_LABELS[e],
    format: f,
    formatLabel: FORMAT_LABELS[f] || f,
    kind: FORMAT_KINDS[f] || 'levels',
    budget: Number(budget) || 0,
    params,
    describe: describeParams(params),
  };
}

/**
 * 判断一段报错是不是「服务端不认这套思考参数」。
 * 只在 400/422 这种「请求本身有问题」的场合用，靠关键词认出具体字段。
 */
export function unsupportedReasoning(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return false;
  const keys = [
    'reasoning_effort',
    'reasoning',
    'enable_thinking',
    'thinking_budget',
    'thinking_config',
    'thinking_level',
    'budget_tokens',
    'thinking',
    'think',
    'effort',
    'extra_body',
  ];
  for (const k of keys) {
    if (s.indexOf(k) >= 0) return true;
  }
  return false;
}
