import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';
import { normalizeEffort, normalizeFormat, EFFORT_LEVELS, REASONING_FORMATS } from './reasoning.js';

/**
 * 配置读取与校验（核心层）。
 *
 * 职责边界：只负责把 .env / config.json 变成一份配置对象，不写文件、不做安装动作。
 * 写配置在 `src/core/env-file.js`，安装与卸载在 `src/tasks/install.js`。
 */

/** 极简 .env 解析：注释、export 前缀、引号、\n 转义，后值覆盖前值。 */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      const q = val[0];
      val = val.slice(1, -1);
      if (q === '"') val = val.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (key) out[key] = val;
  }
  return out;
}

const bool = (v, d) => (v === undefined || v === null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const csv = (v) =>
  String(v || '')
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const str = (v, d = '') => (v === undefined || v === null ? d : String(v));
/**
 * 枚举型配置：留空＝用默认值。
 * .env 里写 `AI_GROUP_REPLY=`（留空）本意是「不特别指定」，不该让助手
 * 因为「空字符串不是合法枚举」而拒绝启动；写了但非法，仍然交给 validateConfig 报错。
 */
const enumStr = (v, d) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s || d;
};

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`配置文件解析失败 ${file}: ${err.message}`);
  }
}

/**
 * 读取 config.json 里的「按会话配置」。
 *
 * 形如：
 * {
 *   "chats": {
 *     "123456@chatroom": { "enabled": true, "groupReply": "always", "personaFile": "./persona-group.txt" },
 *     "wxid_friend":     { "enabled": false }
 *   }
 * }
 */
export function pickChats(json) {
  if (json && typeof json.chats === 'object' && json.chats) return json.chats;
  if (json && typeof json.chatProfiles === 'object' && json.chatProfiles) return json.chatProfiles;
  return {};
}

export function loadConfig({ env = process.env, rootDir = ROOT } = {}) {
  // 允许用 WX_ENV_FILE 指定 .env（测试必须指到空路径，否则会被项目根的配置污染）
  const envFile = env.WX_ENV_FILE !== undefined ? path.resolve(env.WX_ENV_FILE) : path.join(rootDir, '.env');
  const envFileExists = Boolean(envFile && fs.existsSync(envFile));
  const fileEnv = envFileExists ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  /**
   * 合并优先级（别搞反）：
   *  · 走真实进程环境时，**.env 优先**。.env 是用户显式写下的配置，
   *    进程环境里残留的同名变量（某次 set 忘了清、或从别的终端继承来的）
   *    必须让位 —— 否则「明明配了 DeepSeek 却跑千问」会静默发生，还查不出来源。
   *  · 调用方显式传入 env 对象时（测试、程序内调用）仍以它为准。
   */
  const ambient = env === process.env;
  const v = ambient ? { ...env, ...fileEnv } : { ...fileEnv, ...env };
  // 记下「环境变量想改、但被 .env 挡住」的键，启动日志里报出来，免得不明不白。
  const shadowedEnv = ambient
    ? Object.keys(fileEnv).filter((k) => env[k] !== undefined && String(env[k]) !== String(fileEnv[k]))
    : [];
  const jsonPath = v.WX_CONFIG_FILE ? path.resolve(v.WX_CONFIG_FILE) : path.join(rootDir, 'config.json');
  let json = {};
  try {
    json = readJson(jsonPath); // config.json 属辅助配置，解析失败不连带主程序起不来
  } catch (err) {
    console.warn(`[config] 读取 ${jsonPath} 失败，按空配置继续：${err.message}`);
  }
  const dataDir = v.WX_DATA_DIR ? path.resolve(v.WX_DATA_DIR) : path.join(rootDir, 'data');

  const cfg = {
    logLevel: str(v.LOG_LEVEL, 'info'),
    /** 运行时状态（版本记忆、方言缓存、AI 上下文）存放目录 */
    dataDir,
    /**
     * 配置来源（启动日志会打印）：读的哪个 .env、哪些环境变量被挡住了。
     * 「模型为什么不是我配的那个」这类问题，靠它一眼定位。
     */
    configSource: {
      envFile,
      envFileExists,
      shadowedEnv,
    },

    wechat: {
      /** proxy = 放 version.dll 到安装目录后重启；inject = 对运行中的进程直接注入 */
      mode: enumStr(v.WX_INJECT_MODE, 'inject'),
      /** 微信安装目录，留空则自动探测注册表与常见路径 */
      installDir: str(v.WX_INSTALL_DIR),
      /** 与当前 hook DLL 匹配的微信安装包（本地 .exe，供逆版本安装） */
      installerPath: str(v.WX_INSTALLER_PATH),
      processName: str(v.WX_PROCESS_NAME, 'Weixin.exe'),
      /** hook DLL 绝对路径（发布包自带适配版；也可填自备的同版本 DLL） */
      dllPath: str(v.WX_DLL_PATH),
      /** DLL 注入后在微信进程内起的 HTTP 端口 */
      port: int(v.WX_HOOK_PORT, 30001),
      host: str(v.WX_HOOK_HOST, '127.0.0.1'),
      /** 注入后等待 HTTP 就绪的最长时间 */
      readyTimeoutMs: int(v.WX_READY_TIMEOUT_MS, 30000),
      /** 接收消息：webhook = DLL 主动推送；poll = 轮询数据库；auto = 两者都试 */
      receiveMode: enumStr(v.WX_RECEIVE_MODE, 'auto'),
      /** hook 已在运行时不重复注入（联调/测试用） */
      skipInject: bool(v.WX_SKIP_INJECT, false),
      /** 读不到版本时手动指定，用于兼容性判断 */
      forceVersion: str(v.WX_FORCE_VERSION),
      /** webhook 监听端口（会写入启动参数 CallBackURL） */
      webhookPort: int(v.WX_WEBHOOK_PORT, 30002),
      /**
       * webhook 监听地址。默认只绑回环，避免局域网任意设备伪造消息触发 AI 回复。
       * 改成 0.0.0.0 必须同时配置 WX_WEBHOOK_TOKEN。
       */
      webhookBind: str(v.WX_WEBHOOK_BIND, '127.0.0.1'),
      /** webhook 鉴权 token（请求头 X-AutoChat-Token 或 ?token=）。留空且绑非回环时启动报错 */
      webhookToken: str(v.WX_WEBHOOK_TOKEN),
      /**
       * 本机微信的 wxid。用于识别「自己发出去的消息」，
       * 否则轮询 MSG 表会把助手自己的回复当成别人的消息，造成自问自答。
       * 留空时会尝试从 /GetSelfProfile 读；仍拿不到则只靠内容启发式兜底。
       */
      selfId: str(v.WX_SELF_ID),
      /**
       * 本机微信的账号名（昵称），身份三要素之一。
       * 留空时用 hook 读到的昵称；再拿不到就退回 wxid —— 总比空着强，
       * 报身份时「账号名」这一项不能缺失。
       */
      selfName: str(v.WX_SELF_NAME),
      /**
       * 判定「这条是不是我自己发的」：
       *   sender —— 按本机 wxid 过滤（默认；适合电脑上登录的号与群里说话的人不是同一个）
       *   id     —— 按「AutoChat 发过的消息 id」精确过滤（电脑微信 = 手机号同号时必须用这个，
       *             否则提问的人就是本机账号，会被全部丢掉）
       * 小号方案（手机主号 + 电脑小号）用 sender 就够，且最稳。
       */
      selfMode: enumStr(v.WX_SELF_MODE, 'sender'),
      /** 轮询时是否强制排除自己的消息（需要 selfId 已知才有效） */
      pollExcludeSelf: bool(v.WX_POLL_EXCLUDE_SELF, true),
      /** hook DLL 的接口路径，不同版本可覆盖 */
      endpoints: {
        sendText: str(v.WX_EP_SEND_TEXT, '/SendTextMsg'),
        sendImage: str(v.WX_EP_SEND_IMAGE, '/SendImgMsg'),

        sendXml: str(v.WX_EP_SEND_XML, '/ForwardXMLMsg'),
        selfProfile: str(v.WX_EP_SELF, '/GetSelfProfile'),
        status: str(v.WX_EP_STATUS, '/QueryDB/status'),
        queryDb: str(v.WX_EP_QUERY_DB, '/QueryDB/execute'),
      },
      /**
       * 微信 FileStorage 根目录（用于把收到的文件消息定位到本机路径，供 AI 读取 docx/xlsx/pdf 等内容）。
       * 留空则按 ~/Documents/WeChat Files/<本机wxid>/FileStorage 自动推导。
       */
      fileStorageBase: str(v.WX_FILE_STORAGE_BASE),
      /** 轮询新消息的 SQL，列名需包含以下字段，可按数据库结构自行改写 */
      pollSql: str(v.WX_POLL_SQL),
      /**
       * 按会话自动生成轮询 SQL 的会话列表（群 wxid / 好友 wxid），逗号分隔。
       * 填了就比手写 SQL 省事：表名、发送者映射、水位全都自动处理。
       *
       * 这是「AI 可以在哪些会话说话」的授权清单，只认用户自己填的这一份。
       * 不要加任何自动补全 / 自动发现：没被列进来的会话一律不监听、不读取、不回复。
       */
      pollChats: csv(v.WX_POLL_CHATS),
      /** 消息库名（会话分表所在） */
      pollDb: str(v.WX_POLL_DB, 'message_0.db'),
      /** 每次轮询取最近多少条 */
      pollLimit: int(v.WX_POLL_LIMIT, 30),
      pollIntervalMs: int(v.WX_POLL_INTERVAL_MS, 1200),
      /** webhook 静默多久后自动启用轮询兜底；0 表示关闭 */
      webhookIdleFallbackMs: int(v.WX_WEBHOOK_IDLE_FALLBACK_MS, 120000),
      /**
       * 漏接补偿（默认开）：周期性复检「最近 N 条消息」，把被自过滤误标 / 竞态跳过而漏掉的用户消息补答。
       * 与增量轮询互补 —— 增量只看水位以上的新消息，一旦某条被 markSent 误标为「自己发的」就永久丢失；
       * 这里直接按 DB 发送者重新判定（绕过 selfFilter 的污染 sent 集合），找出「没有后续 Bot 回复」的用户消息补答。
       * 只复检已越过水位的消息（n <= watermark），因此与新消息的正常处理互不重叠，不会重复回复。
       */
      reconcileEnabled: bool(v.WX_RECONCILE_ENABLED, true),
      reconcileWindow: int(v.WX_RECONCILE_WINDOW, 10),
      reconcileIntervalMs: int(v.WX_RECONCILE_INTERVAL_MS, 20000),
    },

    ai: {
      /**
       * 自动回复开关：0 = 只接收消息、不回复、不调用模型（下次启动生效）。
       *
       * 兼容旧的 AI_MASTER_SWITCH：该键已废弃，语义并入这里。
       * 旧键还在且为 0 时同样视为「不自动回复」，避免升级后行为突变。
       */
      enabled: bool(v.AI_ENABLED, false) && bool(v.AI_MASTER_SWITCH, true),
      /** 旧键是否还写在配置里（体检会提示迁移） */
      deprecatedMasterSwitch: v.AI_MASTER_SWITCH !== undefined,
      /** OpenAI 兼容地址，填到 /v1 为止，例如 https://tokenhub.tencentmaas.com/v1 */
      baseUrl: str(v.AI_BASE_URL),
      apiKey: str(v.AI_API_KEY),
      model: str(v.AI_MODEL, 'hy3'),
      timeoutMs: int(v.AI_TIMEOUT_MS, 25000),
      maxTokens: int(v.AI_MAX_TOKENS, 600),
      temperature: Number.isFinite(Number(v.AI_TEMPERATURE)) && v.AI_TEMPERATURE !== '' ? Number(v.AI_TEMPERATURE) : 0.8,
      /**
       * 思考强度：off | low | medium | high（默认 off = 不带任何思考参数）。
       * 写错的值会退回 off，不会让助手失声。
       */
      reasoningEffort: normalizeEffort(v.AI_REASONING_EFFORT),
      /** 原始写法（体检用来提示写错了，不影响实际生效值） */
      reasoningEffortRaw: str(v.AI_REASONING_EFFORT),
      /**
       * 思考参数格式：不同厂商字段不一样，按模型或手动指定。
       *   auto      —— 按模型名自动判断（推荐；猜错了会自动去掉重试，不会哑）
       *   standard  —— reasoning_effort（OpenAI o 系列 / gpt-5 / Grok / 多数网关）
       *   openrouter—— reasoning.effort
       *   qwen      —— enable_thinking + thinking_budget（通义 Qwen3、百度 ERNIE）
       *   anthropic —— thinking.budget_tokens（Claude 系）
       *   gemini    —— extra_body.google.thinking_config（Gemini）
       *   thinking  —— thinking.type 开关（DeepSeek / 智谱 GLM / Kimi / 混元）
       *   ollama    —— think（本地 gpt-oss、llama3.x）
       */
      reasoningFormat: normalizeFormat(v.AI_REASONING_FORMAT),
      reasoningFormatRaw: str(v.AI_REASONING_FORMAT),
      /** 思考预算 token（按 token 预算表达强弱的格式生效；0 = 按档位自动换算） */
      reasoningBudget: int(v.AI_REASONING_BUDGET, 0),
      /** 人设，优先级：按会话覆盖 > 文件 > 内联文本 > 默认 */
      personaFile: str(v.AI_PERSONA_FILE),
      /**
       * 人设名（身份三要素之一）。
       * 没填就用人设文件的文件名（去掉扩展名），再没有就用「AutoChat助手」。
       */
      personaName: str(v.AI_PERSONA_NAME),
      systemPrompt: str(v.AI_SYSTEM_PROMPT),
      /** 每个会话保留的上下文轮数（一问一答算一轮） */
      contextTurns: int(v.AI_CONTEXT_TURNS, 8),
      /** 上下文闲置多久后清空 */
      contextTtlMs: int(v.AI_CONTEXT_TTL_MS, 30 * 60 * 1000),
      /** 上下文字符预算上限（超了从最早的开始丢，防止请求被模型截断） */
      contextMaxChars: int(v.AI_CONTEXT_MAX_CHARS, 6000),
      /** 同一会话两次回复的最小间隔 */
      cooldownMs: int(v.AI_COOLDOWN_MS, 3000),
      /** 全局每小时最多回复条数，0 表示不限 */
      maxPerHour: int(v.AI_MAX_PER_HOUR, 120),
      /** never | mention | always —— 群聊里什么时候回（留空＝mention） */
      groupReply: enumStr(v.AI_GROUP_REPLY, 'mention'),
      /** 私聊是否只在带前缀时回复；false 表示私聊直接回 */
      privateRequirePrefix: bool(v.AI_PRIVATE_REQUIRE_PREFIX, false),
      /** 触发前缀，留空表示不需要 */
      triggerPrefix: str(v.AI_TRIGGER_PREFIX),
      /** 同时最多处理几条消息（全局并发上限，防止群成员恶意刷 @ 消耗额度） */
      maxConcurrent: int(v.AI_MAX_CONCURRENT, 2),
      /**
       * 群聊里被 @ 时认可的称呼，逗号分隔（如：小助手,助手）。
       * 配了之后只有 @ 到这些称呼才算被点名；留空则退回「文本里出现 @ 就算」。
       */
      groupAtNames: csv(v.AI_GROUP_AT_NAMES),
      /**
       * 命中就拒绝回复的短语，逗号分隔（别回我 / 不用理我 / 安静 …）。
       * 留空则使用内置默认集合。
       */
      rejectPatterns: csv(v.AI_REJECT_PATTERNS),
      /** 白名单：非空时只有这些会话回；黑名单优先于白名单 */
      allowChats: csv(v.AI_ALLOW_CHATS),
      denyChats: csv(v.AI_DENY_CHATS),
      /** 回复拆条的最大字符数（超出拆成多条）；改这项在生产中现在会真正生效 */
      maxReplyChars: int(v.AI_MAX_REPLY_CHARS, 900),
      /** 是否在回复发给微信前去掉 markdown 标记（如 **粗体**、`代码`）；默认开 */
      stripMarkdown: bool(v.AI_STRIP_MARKDOWN, true),
      /**
       * 视觉模型：收到带图的消息时用来「看图」的模型（OpenAI 兼容，需支持 image_url 内容块，
       * 如 gpt-4o / gpt-image-1 类）。留空则回落到 AI_MODEL（多数多模态模型同时支持文本与图片）。
       * 见 §3.1 多模态路线：先接云端视觉模型，本地视觉模型后续。
       */
      visionModel: str(v.AI_VISION_MODEL),
      /**
       * 本地模型不支持看图时的提示文案（IR3）。
       * 本机纯文本模型收到 image_url 只会报错或忽略图片，与其静默失败不如明确告知。
       * 留空用内置默认文案。判定发生在读图之前，图片字节不会离开本机（见 vision.js visionSupport）。
       */
      visionUnsupportedText: str(
        v.AI_VISION_UNSUPPORTED_TEXT,
        '你当前用的模型不支持看图。要识别图片，请在配置里把「视觉模型」设为支持 image_url 的模型（本机纯文本模型无法看图）。'
      ),
      /**
       * 入站图片 / 附件「体积护栏」（字节）：超过此大小的图不送模型（防 base64 外发爆 token / 费用）。
       * 0 = 不限制。被拦下的图会跳过并在日志里说明，但不写图字节、不落盘（见 IR13 / F12）。
       */
      maxImageBytes: int(v.AI_MAX_IMAGE_BYTES, 8 * 1024 * 1024),
      /**
       * 长期记忆摘要间隔（轮）：每累计 N 轮对话把当前转录并入持久摘要库（MS2）。
       * 太大=摘要太稀、太小=频繁重写；默认 8。
       */
      summaryInterval: int(v.AI_MEMORY_SUMMARY_INTERVAL, 8),
      /**
       * 回复模式：
       *  · 'single'（默认）= 逐条回复，每条触发消息独立回答一次；
       *  · 'batch' = 多消息合批，攒一个窗口内的多条群消息，统一回答一次。
       * 按会话可在 config.json 的 chats[id].replyMode 覆盖。
       */
      replyMode: str(v.AI_REPLY_MODE, 'single'),
      /** 合批窗口时长（毫秒）：自第一条触发消息起最多攒多久（用户定为 10 分钟）。 */
      batchWindowMs: int(v.AI_BATCH_WINDOW_MS, 10 * 60 * 1000),
      /** 合批条数上限：窗口内「符合触发、尚未单独处理」的消息攒够多少条就立即发（用户定为近 10 条）。 */
      batchMaxMessages: int(v.AI_BATCH_MAX_MESSAGES, 10),
      /** 合批静默期（毫秒）：最后一条消息后等这么久没新人说话就发，避免只 1 条 @ 也要等满整个窗口。 */
      batchFlushDelayMs: int(v.AI_BATCH_FLUSH_DELAY_MS, 20000),
      /** 联网搜索（§16.2）：默认关闭、显式 opt-in；开启后查询发往第三方 provider（与本地/云端模型无关）。 */
      webSearch: bool(v.AI_WEB_SEARCH, false),
      webSearchProvider: str(v.AI_WEB_SEARCH_PROVIDER, 'tavily'),
      webSearchKey: str(v.AI_WEB_SEARCH_KEY),
      webSearchMode: str(v.AI_WEB_SEARCH_MODE, 'auto'),
      webSearchPrefix: str(v.AI_WEB_SEARCH_TRIGGER, '/web'),
      webSearchMaxResults: int(v.AI_WEB_SEARCH_MAX_RESULTS, 5),
      webSearchMaxChars: int(v.AI_WEB_SEARCH_MAX_CHARS, 4000),
      webSearchCustomEndpoint: str(v.AI_WEB_SEARCH_CUSTOM_URL),
      /** AI 工具调用 / Skills 框架（§16.4）：默认关闭，白名单 + 最大轮次护栏。 */
      aiTools: bool(v.AI_TOOLS, false),
      aiToolsAllow: csv(v.AI_TOOLS_ALLOW),
      aiToolsMaxRounds: int(v.AI_TOOLS_MAX_ROUNDS, 3),
      /**
       * 高级模式·按复杂度双模型路由（§16.5）：
       *  · 关闭（默认）＝ 始终用用户配的 AI_MODEL 这一个模型，行为可预测；
       *  · 开启 ＝ 按复杂度在「轻量模型」与「主模型」之间切换，两个模型都由用户指定。
       * 复杂度判定走规则（不看模型、不额外调一次接口），因此不增加延迟。
       */
      modelRouting: bool(v.AI_MODEL_ROUTING, false),
      /**
       * 轻量模型（简单任务用，用户指定）。留空则回落到主模型 ——
       * 避免「开了路由却没配第二模型」导致请求打到空 endpoint。
       */
      lightModel: str(v.AI_LIGHT_MODEL),
      lightBaseUrl: str(v.AI_LIGHT_BASE_URL),
      lightApiKey: str(v.AI_LIGHT_API_KEY),
      /**
       * 长任务占位（§16.5）：先发一条「正在XX中……」，结果另起一条新消息。
       * 微信不支持对已发消息做原地替换，所以这是两条真消息，不是原地占位。
       * 默认开启（用户 2026-10-27 定为 B 方案）：判定为长任务就先告知，别让人对着空白干等。
       * 长任务本身稀少（需先开了联网 / 工具 / 文档解读），不会打扰日常闲聊；不想发可关。
       */
      longTaskNotice: bool(v.AI_LONG_TASK_NOTICE, true),
      /** 文档解读（§16.6 基础办公）：默认关闭；开启后入站附件抽取文本注入上下文。 */
      docAnalysis: bool(v.AI_DOC_ANALYSIS, false),
      /** 单份文档抽取的字符上限（防长文档撑爆上下文，0＝不限） */
      docMaxChars: int(v.AI_DOC_MAX_CHARS, 12000),
      /** 生成文档的输出目录（沙箱，write_doc 只能写这里）；留空＝ dataDir/outbox */
      docOutDir: str(v.AI_DOC_OUT_DIR) || path.join(dataDir, 'outbox'),
    },

    /** 按会话（群 wxid / 好友 wxid）的差异化配置，见 pickChats 说明 */
    chats: pickChats(json),
  };

  return cfg;
}

/** 返回配置问题清单，空数组表示可用。 */
export function validateConfig(cfg) {
  const errs = [];
  const w = cfg.wechat;

  if (!['proxy', 'inject'].includes(w.mode)) errs.push(`WX_INJECT_MODE 只能是 proxy 或 inject，当前 ${w.mode}`);
  if (!['webhook', 'poll', 'auto'].includes(w.receiveMode)) errs.push(`WX_RECEIVE_MODE 只能是 webhook/poll/auto`);
  if (w.mode === 'inject' && !w.dllPath && !w.skipInject) {
    errs.push('inject 模式必须设置 WX_DLL_PATH（hook DLL 的绝对路径）');
  }
  if (w.mode === 'proxy' && !w.dllPath && !w.skipInject && w.receiveMode !== 'poll') {
    errs.push('proxy 模式需要 WX_DLL_PATH 才能部署 version.dll');
  }
  if (w.port <= 0 || w.port > 65535) errs.push(`WX_HOOK_PORT 非法: ${w.port}`);
  if (w.webhookPort <= 0 || w.webhookPort > 65535) errs.push(`WX_WEBHOOK_PORT 非法: ${w.webhookPort}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(w.webhookBind) && !w.webhookToken) {
    errs.push(
      `WX_WEBHOOK_BIND=${w.webhookBind} 会把消息入口暴露到网络上，必须同时设置 WX_WEBHOOK_TOKEN（建议直接用默认的 127.0.0.1）`
    );
  }

  const a = cfg.ai;
  if (a.enabled && !a.baseUrl) errs.push('AI_ENABLED=1 但没有配置 AI_BASE_URL');
  if (a.enabled && !a.model) errs.push('AI_ENABLED=1 但没有配置 AI_MODEL');
  if (!['never', 'mention', 'always'].includes(a.groupReply)) {
    errs.push(`AI_GROUP_REPLY 只能是 never/mention/always，当前 ${a.groupReply}`);
  }
  if (a.enabled && a.maxPerHour < 0) errs.push('AI_MAX_PER_HOUR 不能为负');
  // 0 表示「不设并发上限」（与 .env.example 注释一致），负数才非法
  if (a.enabled && a.maxConcurrent < 0) errs.push('AI_MAX_CONCURRENT 不能为负数');
  if (a.enabled && a.baseUrl && !/^https?:\/\//i.test(a.baseUrl) && !/^[\w.-]+(:\d+)?(\/.*)?$/.test(a.baseUrl)) {
    errs.push(`AI_BASE_URL 格式可疑: ${a.baseUrl}`);
  }
  // 思考强度写错时要明确报出来（而不是悄悄退回 off），否则用户以为开了其实没开
  const rawEffort = String(a.reasoningEffortRaw || '').trim().toLowerCase();
  if (rawEffort && !EFFORT_LEVELS.includes(rawEffort) && !['none', 'false', '0', 'true', '1', 'minimal'].includes(rawEffort)) {
    errs.push(`AI_REASONING_EFFORT 只能是 off/low/medium/high，当前 ${a.reasoningEffortRaw}`);
  }
  const rawFormat = String(a.reasoningFormatRaw || '').trim().toLowerCase();
  if (rawFormat && !REASONING_FORMATS.includes(rawFormat) && !['dashscope', 'siliconflow', 'tongyi', 'openai', 'qwen3', 'claude', 'google', 'deepseek', 'glm', 'kimi', 'moonshot'].includes(rawFormat)) {
    errs.push(`AI_REASONING_FORMAT 只能是 ${REASONING_FORMATS.join('/')}，当前 ${a.reasoningFormatRaw}`);
  }
  if (a.reasoningBudget < 0) errs.push('AI_REASONING_BUDGET 不能为负数');

  for (const [chatId, c] of Object.entries(cfg.chats || {})) {
    if (!chatId) errs.push('config.json 里 chats 的键不能为空');
    if (c && c.groupReply && !['never', 'mention', 'always'].includes(c.groupReply)) {
      errs.push(`chats.${chatId}.groupReply 只能是 never/mention/always，当前 ${c.groupReply}`);
    }
    if (c && c.reasoningEffort && !EFFORT_LEVELS.includes(String(c.reasoningEffort).toLowerCase())) {
      errs.push(`chats.${chatId}.reasoningEffort 只能是 off/low/medium/high，当前 ${c.reasoningEffort}`);
    }
  }

  return errs;
}
