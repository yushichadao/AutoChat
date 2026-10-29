import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';
import { loadAccountChats, saveAccountChats, dataDirOf } from './account-profile.js';

/**
 * 按会话配置里允许被界面写入的字段（白名单）。
 * 防止越权写入 apiKey 之类的敏感键。
 */
export const CHAT_FIELDS = new Set([
  'enabled', 'groupReply', 'personaFile', 'model', 'baseUrl', 'systemPrompt', 'triggerPrefix',
  'reasoningEffort', 'reasoningFormat',
  // 归属账号（当前登录微信号 wxid）。带 account 的会话仅当与当前登录账号一致时才监听/回复，
  // 用于同一台电脑先后登录多号时的隔离，防旧号专属群误用于新号。
  'account',
  // 回复模式覆盖：single=逐条（默认）/ batch=多消息合批（见 G33/R28）
  'replyMode',
  // 灰度开关覆盖：按会话单独开 / 关联网搜索与 AI 工具调用（默认跟随全局总开关）。
  'webSearch', 'aiTools',
  'webSearchProvider', 'webSearchMode', 'webSearchPrefix', 'aiToolsAllow',
  // 双模型路由覆盖（§16.5）：路由开关 + 轻量模型的地址 / 名称。
  // 注意：与 apiKey 同理，lightApiKey 属敏感键，不进写入白名单（仅允许手动写 config.json）。
  'modelRouting', 'longTaskNotice', 'lightModel', 'lightBaseUrl',
  // 文档解读覆盖（§16.6）
  'docAnalysis',
]);

/**
 * 按会话（群 / 好友）的差异化配置（核心层）。
 *
 * 职责边界：**按会话配置的唯一读写入口** —— CLI 与图形化配置器都调这里，
 * 避免两份实现各自维护 config.json 导致内容不一致。
 *
 * 写在 config.json 里：
 * {
 *   "chats": {
 *     "123456@chatroom": { "enabled": true, "groupReply": "always", "personaFile": "./persona-group.txt" },
 *     "wxid_friend":     { "enabled": false }
 *   }
 * }
 *
 * 这样同一个号在 A 群是技术答疑、在 B 群是闲聊助手，可以各配各的；
 * 某个群不想让助手说话，只要 enabled=false。
 */
/**
 * 三态布尔：'' / undefined / null ＝「跟随全局」（返回 undefined）；
 * 其余按布尔解析。
 *
 * 关键：界面写进来的是**字符串** '1' / '0'，直接用 Boolean('0') 会得到 true ——
 * 「关」会变成「开」（实测踩坑），所以必须显式把 '0' / 'false' 判为关。
 */
function triBool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return Boolean(v);
}

export class ChatProfiles {
  constructor({ chats = {}, rootDir = '', logger } = {}) {
    this.raw = chats && typeof chats === 'object' ? chats : {};
    this.rootDir = rootDir;
    this.log = logger;
    /** personaFile → 文本，避免每条消息都读盘 */
    this.personaCache = new Map();
  }

  get size() {
    return Object.keys(this.raw).length;
  }

  /** 已配置的会话 id 列表。 */
  ids() {
    return Object.keys(this.raw);
  }

  /**
   * 整体替换会话配置（配置热更新用）。
   *
   * 常驻进程启动时读的那份是快照；用户在界面里加入新群后，不换掉就是
   * 「消息收到了，但用的还是全局策略」—— 看起来像配置没生效。
   * 人设缓存按文件路径保留，不跟着失效。
   */
  setChats(chats) {
    this.raw = chats && typeof chats === 'object' && !Array.isArray(chats) ? chats : {};
    return this.size;
  }

  /**
   * 该会话的覆盖项。未配置的字段返回 undefined，表示「沿用全局设置」。
   *
   * 其中 model / baseUrl / apiKey 用来给这个会话单独指定模型
   * （例如某个群想用更便宜的模型、或者单独走一个本地推理服务），
   * reasoningEffort 用来给这个会话单独指定思考强度
   * （例如技术群开「高」、闲聊群关掉，省 token）。
   * 只要在 config.json 里给了其中任意一项，该会话就会据此新建客户端，
   * 否则沿用全局 AI 配置。
   */
  get(chatId) {
    const c = this.raw[chatId] || {};
    return {
      enabled: c.enabled === undefined ? undefined : Boolean(c.enabled),
      groupReply: c.groupReply || undefined,
      triggerPrefix: c.triggerPrefix === undefined ? undefined : String(c.triggerPrefix),
      personaFile: c.personaFile || undefined,
      systemPrompt: c.systemPrompt || undefined,
      model: c.model || undefined,
      baseUrl: c.baseUrl || undefined,
      apiKey: c.apiKey || undefined,
      /** 该会话专属的思考强度（off/low/medium/high）；没配就是沿用全局 */
      reasoningEffort: c.reasoningEffort || undefined,
      reasoningFormat: c.reasoningFormat || undefined,
      /** 回复模式覆盖：'single' / 'batch'；没配就是沿用全局 */
      replyMode: c.replyMode || undefined,
      /** 灰度开关覆盖：按会话单独开 / 关联网搜索与 AI 工具调用；'' 或没配＝跟随全局 */
      webSearch: triBool(c.webSearch),
      aiTools: triBool(c.aiTools),
      webSearchProvider: c.webSearchProvider || undefined,
      webSearchMode: c.webSearchMode || undefined,
      webSearchPrefix: c.webSearchPrefix === undefined || c.webSearchPrefix === '' ? undefined : String(c.webSearchPrefix),
      aiToolsAllow: c.aiToolsAllow || undefined,
      /** 双模型路由覆盖（§16.5）：'' / 没配＝跟随全局 */
      modelRouting: triBool(c.modelRouting),
      longTaskNotice: triBool(c.longTaskNotice),
      lightModel: c.lightModel || undefined,
      lightBaseUrl: c.lightBaseUrl || undefined,
      /** 文档解读覆盖（§16.6）：'' / 没配＝跟随全局 */
      docAnalysis: triBool(c.docAnalysis),
      /** 敏感键：不进写入白名单，但手动写 config.json 仍生效（与 apiKey 同口径） */
      lightApiKey: c.lightApiKey || undefined,
    };
  }

  /**
   * 会话专属人设文本；没有专属配置时返回 fallback。
   */
  persona(chatId, fallback) {
    const c = this.raw[chatId] || {};
    if (c.personaFile) {
      const key = String(c.personaFile);
      if (this.personaCache.has(key)) return this.personaCache.get(key) || fallback;
      let text = '';
      try {
        const file = path.isAbsolute(key) ? key : path.resolve(this.rootDir, key);
        const base = path.resolve(this.rootDir);
        if (file !== base && !file.startsWith(base + path.sep)) {
          this.log?.warn?.(`会话 ${chatId} 的人设文件路径越界，已忽略: ${key}`);
        } else {
          text = fs.readFileSync(file, 'utf8').trim();
        }
      } catch (err) {
        this.log?.warn?.(`会话 ${chatId} 的人设文件读取失败: ${err.message}`);
      }
      this.personaCache.set(key, text);
      return text || fallback;
    }
    if (c.systemPrompt && String(c.systemPrompt).trim()) return String(c.systemPrompt).trim();
    return fallback;
  }
}

/**
 * 读取「按会话配置」——严格按当前账号隔离。
 * 给定 wxid 时读 data/accounts/<wxid>/chats.json；否则读 'unknown' 账号（通常为空）。
 * 不再回退到旧的全局 config.json.chats，避免换号后旧会话漏给新号。
 *
 * 文件不存在或损坏时返回空对象（配置坏了不该让整个程序起不来）。
 */
export function readChats(rootDir = ROOT, wxid) {
  return loadAccountChats(dataDirOf(rootDir), wxid);
}

/**
 * 写回「按会话配置」——严格按当前账号隔离到 data/accounts/<wxid>/chats.json。
 */
export function writeChats(chats, rootDir = ROOT, wxid) {
  saveAccountChats(dataDirOf(rootDir), wxid, chats);
  return chats;
}
