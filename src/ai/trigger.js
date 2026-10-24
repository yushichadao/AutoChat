/**
 * 触发策略：决定「这条消息要不要回」。
 *
 * 单独成模块的目的：以后要加「只回管理员」「只回白名单群主」「按关键词唤醒」
 * 「按发言人区分人设」等策略，只需要在这里加一条规则，不用动模型调用与发送逻辑。
 *
 * 支持「按会话覆盖」：config.json 里给某个群配了 groupReply / triggerPrefix，
 * 就只在那个会话里生效，其余会话沿用全局设置。
 */

/** 默认拒绝回复的短语（对方明确表示不想被打扰）。 */
export const DEFAULT_REJECT_PATTERNS = [
  '别回',
  '不用理',
  '不要回',
  '别理我',
  '安静',
  '闭嘴',
  '别说话',
  '不回复',
  '不用回',
  '别闹',
];

export class TriggerPolicy {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.allow = new Set(cfg.allowChats || []);
    this.deny = new Set(cfg.denyChats || []);
    this.atNames = cfg.groupAtNames || [];
    this.rejectPatterns =
      Array.isArray(cfg.rejectPatterns) && cfg.rejectPatterns.length
        ? cfg.rejectPatterns
        : DEFAULT_REJECT_PATTERNS;
  }

  /** 黑名单优先于白名单；白名单为空表示不限。 */
  allowed(chatId) {
    if (this.deny.has(chatId)) return false;
    if (this.allow.size && !this.allow.has(chatId)) return false;
    return true;
  }

  /** 命中「别回我」这类否定语义就不回。 */
  rejected(msg) {
    const text = String(msg?.text || '');
    if (!text) return null;
    for (const p of this.rejectPatterns) {
      if (p && text.includes(p)) return p;
    }
    return null;
  }

  /**
   * 群里是不是在叫我们。
   * 优先级：触发前缀 > 结构化 @ 列表 > @昵称 > 任意 @
   * 一旦能拿到结构化 @ 列表，就不再用「文本里有 @」兜底，避免 @ 别人时误触发。
   */
  mentionsUs(msg, selfWxid = '') {
    const text = String(msg?.text || '');
    const atUsers = Array.isArray(msg?.atUsers) ? msg.atUsers : [];

    if (atUsers.length) {
      if (selfWxid && atUsers.includes(selfWxid)) return true;
      if (this.atNames.length) {
        return this.atNames.some((n) => atUsers.some((a) => a.includes(n) || n.includes(a)));
      }
      return false;
    }
    if (this.atNames.length) {
      return this.atNames.some((n) => text.includes(`@${n}`));
    }
    return /@/.test(text);
  }

  /** 群聊里判断是不是在叫我们（overrides 优先于全局配置）。 */
  isAddressed(msg, selfWxid = '', overrides = {}) {
    const prefix = overrides.triggerPrefix !== undefined ? overrides.triggerPrefix : this.cfg.triggerPrefix;
    if (prefix) return String(msg?.text || '').trimStart().startsWith(prefix);
    if (msg?.chatType !== 'group') return true;
    const groupReply = overrides.groupReply || this.cfg.groupReply;
    if (groupReply === 'always') return true;
    if (groupReply === 'never') return false;
    return this.mentionsUs(msg, selfWxid);
  }

  stripPrefix(msg, overrides = {}) {
    const prefix = overrides.triggerPrefix !== undefined ? overrides.triggerPrefix : this.cfg.triggerPrefix;
    if (!prefix) return msg.text;
    const t = String(msg.text || '').trimStart();
    return t.startsWith(prefix) ? t.slice(prefix.length).trimStart() : t;
  }

  /**
   * 总判定。
   * @param {object} msg
   * @param {{selfWxid?:string, overrides?:object}} opts
   * @returns {{ok:boolean, reason?:string, userText?:string}}
   */
  decide(msg, { selfWxid = '', overrides = {} } = {}) {
    const enabled = overrides.enabled !== undefined ? overrides.enabled : this.cfg.enabled;
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (!msg) return { ok: false, reason: 'empty' };
    if (msg.kind !== 'text') return { ok: false, reason: 'not-text' };
    if (!String(msg.text || '').trim()) return { ok: false, reason: 'blank' };
    if (!this.allowed(msg.chatId)) return { ok: false, reason: 'not-allowed' };

    const reject = this.rejected(msg);
    if (reject) return { ok: false, reason: `rejected:${reject}` };

    if (msg.chatType === 'private') {
      if (this.cfg.privateRequirePrefix && !overrides.triggerPrefix && !this.cfg.triggerPrefix) {
        return { ok: false, reason: 'private-require-prefix' };
      }
      if (this.cfg.privateRequirePrefix && !this.isAddressed(msg, selfWxid, overrides)) {
        return { ok: false, reason: 'private-not-addressed' };
      }
      return { ok: true, userText: this.stripPrefix(msg, overrides) };
    }

    if (!this.isAddressed(msg, selfWxid, overrides)) return { ok: false, reason: 'not-addressed' };
    return { ok: true, userText: this.stripPrefix(msg, overrides) };
  }
}
