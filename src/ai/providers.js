/**
 * 模型接入方式预设表（面向新手）。
 *
 * 小白卡住的地方从来不是「JSON 怎么写」，而是三件事：
 *   ① 地址填哪个        ② 模型叫什么        ③ 要不要密钥、去哪拿
 * 这里把答案连同「一步步怎么做」都写死，用户只要点一下、照着做就行。
 *
 * 全部走 OpenAI 兼容协议（地址 + /v1/chat/completions），
 * 所以本项目不需要任何厂商 SDK，换服务商只改三个东西：地址、模型名、密钥。
 */

/**
 * @typedef {object} Provider
 * @property {string} id            内部标识
 * @property {string} name          显示给人看的名字
 * @property {string} group         分组：本地 / 云端 / 自定义
 * @property {string} baseUrl       接口地址（用户不用手填）
 * @property {string} model         默认模型名（用户不用手填）
 * @property {boolean} needsKey     要不要密钥
 * @property {string[]} steps       一步步怎么做（大白话）
 * @property {string} keyHint       密钥去哪拿
 * @property {string} keyUrl        密钥申请页面
 * @property {string} tip           常见坑
 */

/** @type {Provider[]} */
export const PROVIDERS = [
  {
    id: 'ollama',
    name: 'Ollama（本地，免费离线）',
    group: '本地',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    steps: [
      '装好 Ollama（官网下载，一路下一步）',
      '打开命令提示符（开始菜单搜 cmd），输入：ollama serve',
      '再开一个命令提示符，输入：ollama pull qwen2.5:7b（把模型下载下来）',
      '保持 ollama serve 那个黑窗口开着，回到这里点「测试一下」',
    ],
    keyHint: '本地模型不需要密钥',
    keyUrl: 'https://ollama.com/download',
    tip: 'ollama serve 那个黑窗口关掉，模型就断了 —— 用 AutoChat 期间别关它',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地，界面友好）',
    group: '本地',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    needsKey: false,
    steps: [
      '装好 LM Studio 并打开',
      '左侧点「Local Server」标签',
      '选一个已下载的模型，点「Start Server」',
      '回到这里点「测试一下」',
    ],
    keyHint: '本地模型不需要密钥',
    keyUrl: 'https://lmstudio.ai',
    tip: '模型要先在「My Models」里下载好，服务器才有模型可用',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp / vLLM / One-API（自建）',
    group: '本地',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: '',
    needsKey: false,
    steps: [
      '先让模型服务跑起来（llama.cpp 用 llama-server，vLLM 用 vllm serve）',
      '默认监听 8000 端口就不用改地址',
      '回到这里点「拉取模型」看看有哪些模型，选一个填进去',
      '点「测试一下」',
    ],
    keyHint: '自建服务一般不需要密钥',
    keyUrl: '',
    tip: '端口被改了就同步改上面的地址；One-API 也走这个协议，还能转发到云端',
  },
  {
    id: 'openai',
    name: 'OpenAI（云端，最稳）',
    group: '云端',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    steps: [
      '打开 platform.openai.com，用邮箱注册并登录',
      '右上角 API keys 里点 Create new secret key，复制下来（只显示一次）',
      '粘到「密钥」输入框',
      '点「测试一下」',
    ],
    keyHint: '在 platform.openai.com 的 API keys 页面创建，形如 sk- 开头',
    keyUrl: 'https://platform.openai.com/api-keys',
    tip: '要先在 Billing 里加充值才能用；国内直连可能不通',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek（云端，便宜）',
    group: '云端',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsKey: true,
    steps: [
      '打开 platform.deepseek.com，注册并登录',
      '右上角「API Keys」里创建一个密钥，复制下来（只显示一次，存好）',
      '把密钥粘到下面的「密钥」输入框',
      '点「测试一下」',
    ],
    keyHint: '在 platform.deepseek.com 的 API Keys 页面创建，形如 sk- 开头',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    tip: '按量付费，新账号通常有几元免费额度',
  },
  {
    id: 'moonshot',
    name: 'Kimi / 月之暗面（云端，长文本强）',
    group: '云端',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    needsKey: true,
    steps: [
      '打开 platform.moonshot.cn，注册并登录',
      '在「API Key」页面创建密钥并复制',
      '粘到「密钥」输入框',
      '点「测试一下」',
    ],
    keyHint: '在 platform.moonshot.cn 的 API Key 页面创建，形如 sk- 开头',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    tip: '不同模型上下文长度不同，群里长对话建议选 32k 以上的模型',
  },
  {
    id: 'qwen',
    name: '通义千问 / DashScope（云端）',
    group: '云端',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    needsKey: true,
    steps: [
      '打开 bailian.console.aliyun.com，注册并登录（阿里云账号）',
      '开通「百炼」，在「API Key 管理」创建密钥',
      '粘到「密钥」输入框',
      '点「测试一下」',
    ],
    keyHint: '在百炼控制台的 API Key 管理页面创建，形如 sk- 开头',
    keyUrl: 'https://bailian.console.aliyun.com/',
    tip: '阿里云账号要先开通百炼才发得了密钥',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM（云端，有免费模型）',
    group: '云端',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    needsKey: true,
    steps: [
      '打开 open.bigmodel.cn，注册并登录',
      '在「API Key」里创建密钥（免费模型也有额度）',
      '粘到「密钥」输入框',
      '点「测试一下」',
    ],
    keyHint: '在 open.bigmodel.cn 的 API Key 管理页面创建，形如 id- 开头',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    tip: 'glm-4-flash 是免费的，适合先试手',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow（云端，模型多）',
    group: '云端',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    needsKey: true,
    steps: [
      '打开 siliconflow.cn，注册并登录（有免费额度）',
      '「账户 → API 密钥」创建并复制（形如 sk- 开头）',
      '粘到「密钥」输入框',
      '点「测试一下」',
    ],
    keyHint: '在 siliconflow.cn 的「API 密钥」页面创建',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    tip: '模型名带斜杠（如 Qwen/Qwen2.5-7B-Instruct），别漏掉前半段',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter（云端，一个 Key 用多家模型）',
    group: '云端',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    needsKey: true,
    steps: [
      '打开 openrouter.ai，注册并登录',
      '右上角「Keys」创建密钥',
      '粘到「密钥」输入框',
      '点「拉取模型」挑一个，或直接用默认',
    ],
    keyHint: '在 openrouter.ai 的 Keys 页面创建，形如 sk-or- 开头',
    keyUrl: 'https://openrouter.ai/keys',
    tip: '模型名带厂商前缀（如 openai/gpt-4o-mini）',
  },
  {
    id: 'gemini',
    name: 'Google Gemini（云端，有免费额度）',
    group: '云端',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    needsKey: true,
    steps: [
      '打开 aistudio.google.com，用 Google 账号登录',
      '点「Get API Key」创建密钥',
      '粘到「密钥」输入框',
      '点「测试一下」',
    ],
    keyHint: '在 aistudio.google.com/apikey 页面创建，形如 AIza 开头',
    keyUrl: 'https://aistudio.google.com/apikey',
    tip: '这里用的是 Gemini 的 OpenAI 兼容入口，地址不要自己改',
  },
  {
    id: 'custom',
    name: '其它 / 我自己知道地址',
    group: '自定义',
    baseUrl: '',
    model: '',
    needsKey: true,
    steps: [
      '把服务商给的「接口地址」原样粘进上面的输入框（一般以 /v1 结尾）',
      '把模型名填进去（服务商页面上的模型 ID）',
      '有密钥就填，没有就留空',
      '点「测试一下」',
    ],
    keyHint: '服务商给的密钥，通常以 sk- 开头',
    keyUrl: '',
    tip: '地址要填到 /v1 为止，别自己加 /chat/completions',
  },
];

/** 本机常见的模型服务端口，用来自动发现已经跑起来的服务。 */
export const LOCAL_PORTS = [
  { port: 11434, name: 'Ollama', providerId: 'ollama' },
  { port: 1234, name: 'LM Studio', providerId: 'lmstudio' },
  { port: 8000, name: 'llama.cpp / vLLM / One-API', providerId: 'llamacpp' },
  { port: 5000, name: '常见自建推理服务', providerId: 'llamacpp' },
  { port: 8080, name: '常见自建推理服务', providerId: 'llamacpp' },
  { port: 4891, name: 'Jan / LM Studio 新版', providerId: 'lmstudio' },
];

/** 按 id 找预设。 */
export function findProvider(id) {
  const key = String(id || '').trim().toLowerCase();
  return PROVIDERS.find((p) => p.id === key) || null;
}

/**
 * 猜「当前配置属于哪个服务商」：按地址反查。
 * 用户手填地址时也能在界面上显示「你现在用的是：DeepSeek」。
 */
export function guessProvider(baseUrl) {
  const b = String(baseUrl || '').trim().toLowerCase();
  if (!b) return null;
  let best = null;
  for (const p of PROVIDERS) {
    if (!p.baseUrl) continue;
    const host = p.baseUrl.split('/')[2] || '';
    if (!host) continue;
    if (b.includes(host) && (!best || p.baseUrl.length > best.baseUrl.length)) best = p;
  }
  return best;
}

/** 分组：本地 / 云端 / 自定义，界面按这个顺序展示。 */
export function groupedProviders() {
  const order = ['本地', '云端', '自定义'];
  const groups = order.map((g) => ({ group: g, items: PROVIDERS.filter((p) => p.group === g) }));
  return groups.filter((g) => g.items.length);
}

