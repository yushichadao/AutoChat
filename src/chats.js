import fs from 'node:fs';
import path from 'node:path';

/**
 * 按会话（群 / 好友）的差异化配置。
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
 * 某个群不想让机器人说话，只要 enabled=false。
 */
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
   * 该会话的覆盖项。未配置的字段返回 undefined，表示「沿用全局设置」。
   *
   * 其中 model / baseUrl / apiKey 用来给这个会话单独指定模型
   * （例如某个群想用更便宜的模型、或者单独走一个本地推理服务）。
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
        text = fs.readFileSync(file, 'utf8').trim();
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
