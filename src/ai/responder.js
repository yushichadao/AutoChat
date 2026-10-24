/**
 * 生成与投递：调模型 → 清洗 → 拆条 → 发回微信。
 *
 * 清洗和拆条独立成函数，是为了以后接「带引用」「带图片」等新输出形式时，
 * 只改这里，不用碰触发与限流。
 */

/** 微信不渲染 markdown，把标记去掉但保留文字结构。 */
export function stripMarkdown(input) {
  let s = String(input).replace(/\r\n/g, '\n');
  s = s.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/^\s*[-*+]\s+/gm, '· ');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 超长回复按段落切成多条，避免被微信截断或触发风控。 */
export function splitReply(text, maxChars) {
  const limit = Math.max(50, Number(maxChars) || 900);
  if (text.length <= limit) return [text];

  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export class Responder {
  constructor({ ai, cfg = {}, hook, logger, selfFilter = null }) {
    this.ai = ai;
    this.cfg = cfg;
    this.hook = hook;
    this.log = logger;
    /** 用来登记「哪些消息是我自己发的」，见 bridge/self-filter.js */
    this.selfFilter = selfFilter;
  }

  /** 调模型。ai 可传入覆盖（按会话切换模型时用），缺省用构造时的全局实例。 */
  async generate(messages, opts = {}) {
    const ai = opts.ai || this.ai;
    const res = await ai.chat(messages, {
      maxTokens: this.cfg.maxTokens,
      temperature: this.cfg.temperature,
    });
    return res.text;
  }

  /** 清洗 + 拆条。 */
  prepare(raw) {
    let text = String(raw ?? '');
    if (this.cfg.stripMarkdown) text = stripMarkdown(text);
    text = text.trim();
    if (!text) return [];
    return splitReply(text, this.cfg.maxReplyChars);
  }

  /**
   * 把文本发回微信。
   *
   * 发送的同时把「这条是我自己发的」登记下来：
   *  · 文本先记一份（回声兜底）
   *  · 发出后回查库拿到新写入的 local_id，登记进已发清单（精确过滤用）
   *
   * @returns {{ok:boolean, count:number, message?:string}}
   */
  async deliver(to, text) {
    const parts = this.prepare(text);
    if (!parts.length) return { ok: false, count: 0, message: '回复内容为空' };

    let sent = 0;
    // 只有「按 id 判定自己发的」模式才需要回查库，sender 模式不做这步（省一次查询）
    const needIds = this.selfFilter?.mode === 'id';
    for (const part of parts) {
      this.selfFilter?.rememberOutgoing(to, part);
      const before =
        needIds && typeof this.hook.maxLocalId === 'function'
          ? await this.hook.maxLocalId(to).catch(() => 0)
          : 0;
      const r = await this.hook.sendText(to, part);
      if (!r.ok) {
        return { ok: false, count: sent, message: r.message || '发送失败' };
      }
      sent += 1;
      if (needIds && typeof this.hook.captureSentIds === 'function') {
        const ids = await this.hook.captureSentIds(to, before).catch(() => []);
        if (ids.length) this.selfFilter.markSent(to, ids);
      }
    }
    return { ok: true, count: sent };
  }
}
