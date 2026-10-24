import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const fileEnv = envFile && fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const v = { ...fileEnv, ...env };
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

    wechat: {
      /** proxy = 放 version.dll 到安装目录后重启；inject = 对运行中的进程直接注入 */
      mode: str(v.WX_INJECT_MODE, 'inject'),
      /** 微信安装目录，留空则自动探测注册表与常见路径 */
      installDir: str(v.WX_INSTALL_DIR),
      processName: str(v.WX_PROCESS_NAME, 'Weixin.exe'),
      /** hook DLL 绝对路径（自备，需与本机微信版本匹配） */
      dllPath: str(v.WX_DLL_PATH),
      /** DLL 注入后在微信进程内起的 HTTP 端口 */
      port: int(v.WX_HOOK_PORT, 30001),
      host: str(v.WX_HOOK_HOST, '127.0.0.1'),
      /** 注入后等待 HTTP 就绪的最长时间 */
      readyTimeoutMs: int(v.WX_READY_TIMEOUT_MS, 30000),
      /** 接收消息：webhook = DLL 主动推送；poll = 轮询数据库；auto = 两者都试 */
      receiveMode: str(v.WX_RECEIVE_MODE, 'auto'),
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
       * 否则轮询 MSG 表会把机器人自己的回复当成别人的消息，造成自问自答。
       * 留空时会尝试从 /GetSelfProfile 读；仍拿不到则只靠内容启发式兜底。
       */
      selfId: str(v.WX_SELF_ID),
      /**
       * 判定「这条是不是我自己发的」：
       *   sender —— 按本机 wxid 过滤（默认；适合电脑上登录的号与群里说话的人不是同一个）
       *   id     —— 按「机器人发过的消息 id」精确过滤（电脑微信 = 手机号同号时必须用这个，
       *             否则提问的人就是本机账号，会被全部丢掉）
       * 双账号方案（手机主号 + 电脑小号）用 sender 就够，且最稳。
       */
      selfMode: str(v.WX_SELF_MODE, 'sender'),
      /** 轮询时是否强制排除自己的消息（需要 selfId 已知才有效） */
      pollExcludeSelf: bool(v.WX_POLL_EXCLUDE_SELF, true),
      /** hook DLL 的接口路径，不同版本可覆盖 */
      endpoints: {
        sendText: str(v.WX_EP_SEND_TEXT, '/SendTextMsg'),
        sendImage: str(v.WX_EP_SEND_IMAGE, '/SendImgMsg'),
        sendFile: str(v.WX_EP_SEND_FILE, '/SendFileMsg'),
        sendXml: str(v.WX_EP_SEND_XML, '/ForwardXMLMsg'),
        selfProfile: str(v.WX_EP_SELF, '/GetSelfProfile'),
        status: str(v.WX_EP_STATUS, '/QueryDB/status'),
        queryDb: str(v.WX_EP_QUERY_DB, '/QueryDB/execute'),
      },
      /** 轮询新消息的 SQL，列名需包含以下字段，可按数据库结构自行改写 */
      pollSql: str(v.WX_POLL_SQL),
      /**
       * 按会话自动生成轮询 SQL 的会话列表（群 wxid / 好友 wxid），逗号分隔。
       * 填了就比手写 SQL 省事：表名、发送者映射、水位全都自动处理。
       */
      pollChats: csv(v.WX_POLL_CHATS),
      /** 消息库名（会话分表所在） */
      pollDb: str(v.WX_POLL_DB, 'message_0.db'),
      /** 每次轮询取最近多少条 */
      pollLimit: int(v.WX_POLL_LIMIT, 30),
      pollIntervalMs: int(v.WX_POLL_INTERVAL_MS, 1200),
      /** webhook 静默多久后自动启用轮询兜底；0 表示关闭 */
      webhookIdleFallbackMs: int(v.WX_WEBHOOK_IDLE_FALLBACK_MS, 120000),
    },

    ai: {
      enabled: bool(v.AI_ENABLED, false),
      /**
       * 总闸：0 = 立即停止自动回复（仍接收、仍记日志）。
       * 运行时还会看「暂停哨兵文件」，两者任一为关就绝不发消息。
       */
      masterSwitch: bool(v.AI_MASTER_SWITCH, true),
      /** OpenAI 兼容地址，填到 /v1 为止，例如 https://tokenhub.tencentmaas.com/v1 */
      baseUrl: str(v.AI_BASE_URL),
      apiKey: str(v.AI_API_KEY),
      model: str(v.AI_MODEL, 'hy3'),
      timeoutMs: int(v.AI_TIMEOUT_MS, 25000),
      maxTokens: int(v.AI_MAX_TOKENS, 600),
      temperature: Number.isFinite(Number(v.AI_TEMPERATURE)) && v.AI_TEMPERATURE !== '' ? Number(v.AI_TEMPERATURE) : 0.8,
      /** 人设，优先级：按会话覆盖 > 文件 > 内联文本 > 默认 */
      personaFile: str(v.AI_PERSONA_FILE),
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
      /** never | mention | always —— 群聊里什么时候回 */
      groupReply: str(v.AI_GROUP_REPLY, 'mention'),
      /** 私聊是否只在带前缀时回复；false 表示私聊直接回 */
      privateRequirePrefix: bool(v.AI_PRIVATE_REQUIRE_PREFIX, false),
      /** 触发前缀，留空表示不需要 */
      triggerPrefix: str(v.AI_TRIGGER_PREFIX),
      /** 同时最多处理几条消息（全局并发上限，防止群成员恶意刷 @ 消耗额度） */
      maxConcurrent: int(v.AI_MAX_CONCURRENT, 2),
      /**
       * 群聊里被 @ 时认可的称呼，逗号分隔（如：小助手,机器人）。
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
  if (a.enabled && a.maxConcurrent < 1) errs.push('AI_MAX_CONCURRENT 至少为 1');
  if (a.enabled && a.baseUrl && !/^https?:\/\//i.test(a.baseUrl) && !/^[\w.-]+(:\d+)?(\/.*)?$/.test(a.baseUrl)) {
    errs.push(`AI_BASE_URL 格式可疑: ${a.baseUrl}`);
  }

  for (const [chatId, c] of Object.entries(cfg.chats || {})) {
    if (!chatId) errs.push('config.json 里 chats 的键不能为空');
    if (c && c.groupReply && !['never', 'mention', 'always'].includes(c.groupReply)) {
      errs.push(`chats.${chatId}.groupReply 只能是 never/mention/always，当前 ${c.groupReply}`);
    }
  }

  return errs;
}
