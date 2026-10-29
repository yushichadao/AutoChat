/**
 * 生成与投递：调模型 → 清洗 → 拆条 → 发回微信。
 *
 * 清洗和拆条独立成函数，是为了以后接「带引用」「带图片」等新输出形式时，
 * 只改这里，不用碰触发与限流。
 */
import fs from 'node:fs';
import { parseOutbound, resolveOutboundMedia } from './vision.js';

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
    // 兜底默认值：生产环境的 cfg 来自 loadConfig（已带这些键），这里保证缺省时行为正确。
    this.cfg = { stripMarkdown: true, maxReplyChars: 900, ...cfg };
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
      // 思考强度：客户端自带优先（按会话单独配的模型带自己的档位），再退回全局配置
      reasoningEffort: opts.reasoningEffort ?? ai?.reasoningEffort ?? this.cfg.reasoningEffort,
      reasoningFormat: opts.reasoningFormat ?? ai?.reasoningFormat ?? this.cfg.reasoningFormat,
      reasoningBudget: opts.reasoningBudget ?? ai?.reasoningBudget ?? this.cfg.reasoningBudget,
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
   * 发一条「长任务提示」（§16.5），如「正在解析文件……」。
   *
   * 与 deliver 的区别：
   *  · 只发一行短文本，不做拆条、不解析出站图片 / 文件标记；
   *  · 不写上下文、不记 outbound —— 它是过程提示，不是一次「回答」；
   *  · 结果正文由调用方随后**另起一条新消息**发送（微信不支持原地替换，见 §16.5）。
   *
   * 仍登记 selfFilter（回声兜底），因为它确实是 bot 发出去的一条消息。
   * @returns {Promise<{ok:boolean, message?:string}>}
   */
  async sendNotice(to, text) {
    const body = String(text ?? '').trim();
    if (!body) return { ok: false, message: '提示为空' };
    this.selfFilter?.rememberOutgoing(to, body);
    const needIds = this.selfFilter?.mode === 'id';
    const before =
      needIds && typeof this.hook.maxLocalId === 'function'
        ? await this.hook.maxLocalId(to).catch(() => 0)
        : 0;
    const r = await this.hook.sendText(to, body);
    if (!r.ok) return { ok: false, message: r.message || '发送失败' };
    if (needIds && typeof this.hook.captureSentIds === 'function') {
      const ids = await this.hook.captureSentIds(to, before).catch(() => []);
      if (ids.length) this.selfFilter.markSent(to, ids);
    }
    return { ok: true };
  }

  /**
   * 把回复发回微信。
   *
   * 出站多模态（§3.1 文→图）：
   *  · 文本段走 stripMarkdown 纯文本（微信不渲染 ``` 围栏，IR10）；
   *  · 模型若返回 [[image:...]] 标记，则走原生 sendImage（IR9 / IR12），
   *    不在文本里塞 markdown 围栏，用户收到的是真正的图片消息。
   *
   * 发送文本的同时把「这条是我自己发的」登记下来（回声兜底 + 回查库精确过滤）。
   *
   * @returns {{ok:boolean, count:number, message?:string}}
   */
  async deliver(to, text) {
    const { text: body, images, files } = parseOutbound(text);
    const parts = this.prepare(body);

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

    // 出站图片：解析标记 → 本机文件路径（data URI 写临时文件）→ 原生图片消息
    for (const token of images) {
      const file = resolveOutboundMedia(token, { tmpDir: this.cfg?.dataDir });
      if (!file) continue;
      const r = await this.hook.sendImage(to, file);
      if (!r.ok) {
        return { ok: false, count: sent, message: r.message || '发送图片失败' };
      }
      sent += 1;
    }

    // 出站文件（§16.4：write_doc 等工具生成的 docx / xlsx）：以原生文件消息发出。
    // 标记此前只被 parseOutbound 解析出来、从未发送，生成的文档实际到不了用户手里。
    for (const token of files) {
      if (!fs.existsSync(token)) {
        this.log?.warn?.(`出站文件不存在，已跳过：${token}`);
        continue;
      }
      // hook 不支持 sendFile（部分 DLL 没有该接口）时降级：把路径告诉用户，别让人以为白等
      const r = typeof this.hook.sendFile === 'function'
        ? await this.hook.sendFile(to, token)
        : { ok: false };
      if (r.ok) { sent += 1; continue; }
      this.log?.warn?.(`发送文件失败，降级为文本：${r.message || 'hook 不支持 sendFile'}`);
      const note = `已生成文件：${token}`;
      const sent2 = await this.hook.sendText(to, note);
      if (sent2.ok) sent += 1;
    }

    if (!sent) return { ok: false, count: 0, message: '回复内容为空' };
    return { ok: true, count: sent };
  }
}
