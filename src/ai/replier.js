import fs from 'node:fs';
import { TriggerPolicy } from './trigger.js';
import { RateLimiter } from './limiter.js';
import { buildMessages, DEFAULT_PERSONA } from './prompt.js';
import { Responder, stripMarkdown, splitReply } from './responder.js';
import { ChatProfiles } from '../chats.js';
import { AIClient } from './client.js';

/**
 * 微信侧的 AI 回复总入口。
 *
 * 这里是「流水线门面」：真正的判断拆到 trigger / limiter / prompt / responder，
 * 本类只负责把四段串起来并对外保持稳定 API。
 *
 * 流程：归一化消息 → 触发判定 → 限流 → 组 prompt → 调模型 → 清洗 → 发回微信 → 记上下文
 *
 * 「按会话差异化」通过 ChatProfiles 实现：config.json 里给某个群单独配
 * enabled / groupReply / triggerPrefix / personaFile，只在那个会话生效。
 */
export class AIReply {
  constructor({ cfg, ai, memory, hook, logger, selfWxid = '', profiles = null, selfFilter = null, masterSwitch = null }) {
    this.cfg = cfg;
    this.ai = ai;
    this.memory = memory;
    this.hook = hook;
    this.log = logger;
    this.selfWxid = selfWxid || '';
    /** sender | id —— 判定「这条是不是我自己发的」 */
    this.selfMode = cfg.selfMode || 'sender';
    this.selfFilter = selfFilter;
    /** 总闸：暂停时不回复任何消息 */
    this.masterSwitch = masterSwitch;

    this.trigger = new TriggerPolicy(cfg);
    this.limiter = new RateLimiter(cfg);
    this.responder = new Responder({ ai, cfg, hook, logger, selfFilter });
    this.profiles = profiles || new ChatProfiles({ chats: {}, logger });
    /** 全局 AI 配置（作为「按会话覆盖」的缺省值）。 */
    this.aiConfig = {
      baseUrl: ai?.baseUrl,
      apiKey: ai?.apiKey,
      model: ai?.model,
      timeoutMs: ai?.timeoutMs,
    };
    this.defaultAI = ai;
    this.persona = loadPersona(cfg);
    this.stats = { handled: 0, replied: 0, skipped: 0, failed: 0, filtered: 0, echo: 0, paused: 0 };
    /** 最近发出去的内容，用于识别「自己发出去的消息又被收回来」 */
    this.outbound = [];
  }

  /** 兼容旧调用点：直接读写限流器的状态。 */
  get lastReplyAt() {
    return this.limiter.lastReplyAt;
  }

  set lastReplyAt(v) {
    this.limiter.lastReplyAt = v;
  }

  get replyTimes() {
    return this.limiter.replyTimes;
  }

  set replyTimes(v) {
    this.limiter.replyTimes = v;
  }

  /** 该会话的覆盖项（没有就是空对象）。 */
  overrideFor(chatId) {
    try {
      return this.profiles.get(chatId) || {};
    } catch {
      return {};
    }
  }

  /**
   * 该会话实际要用的模型客户端。
   * 会话在 config.json 里配了 baseUrl / apiKey / model 任意一项，就据此新建一个客户端；
   * 没配就沿用全局那个（避免每次都 new）。
   * @param {object} overrides ChatProfiles.get() 的返回值
   * @returns {AIClient}
   */
  aiForChat(overrides = {}) {
    const o = overrides || {};
    if (!o.baseUrl && !o.apiKey && !o.model) return this.defaultAI;
    try {
      return new AIClient({
        baseUrl: o.baseUrl || this.aiConfig.baseUrl,
        apiKey: o.apiKey ?? this.aiConfig.apiKey,
        model: o.model || this.aiConfig.model,
        timeoutMs: this.aiConfig.timeoutMs,
        logger: this.log,
      });
    } catch {
      return this.defaultAI;
    }
  }

  /** 触发判定（不含限流）。 */
  shouldReply(msg) {
    return this.trigger.decide(msg, {
      selfWxid: this.selfWxid,
      overrides: this.overrideFor(msg?.chatId),
    }).ok;
  }

  /** 限流判定，兼容旧签名。 */
  rateLimited(msg) {
    return this.limiter.check(msg);
  }

  stripPrefix(msg) {
    return this.trigger.stripPrefix(msg, this.overrideFor(msg?.chatId));
  }

  /**
   * 自己发出去的消息又被 hook 推回来 —— 那是回声，不是提问。
   * 已知本机 wxid 时由收消息层直接挡掉；这里做内容级兜底，
   * 防止「wxid 读不出来 → 自己的回复被当成别人提问 → 无限自问自答」。
   */
  isSelfEcho(msg) {
    if (!msg || !msg.text) return false;
    if (this.selfFilter?.isEcho(msg)) return true;
    const now = Date.now();
    this.outbound = this.outbound.filter((o) => now - o.at < 20000);
    const text = String(msg.text).trim();
    return this.outbound.some((o) => o.text === text);
  }

  async handle(msg) {
    // 总闸：配置关掉或哨兵文件存在，就一条都不回。
    // 这是「随时能拉下」的硬保证 —— 宁可不回，也不能失控刷屏。
    if (this.cfg.masterSwitch === false || this.masterSwitch?.isPaused()) {
      this.stats.paused += 1;
      this.log.info?.('总闸处于关闭状态，本次不回复');
      return null;
    }

    const overrides = this.overrideFor(msg?.chatId);
    const decision = this.trigger.decide(msg, { selfWxid: this.selfWxid, overrides });
    if (!decision.ok) {
      this.stats.filtered += 1;
      this.log.debug?.(`${msg?.chatId || '-'} 未触发(${decision.reason})，跳过`);
      return null;
    }

    if (this.selfMode !== 'id' && this.selfWxid && msg.senderId && msg.senderId === this.selfWxid) {
      this.stats.filtered += 1;
      return null;
    }
    if (this.selfFilter?.isSentId(msg.chatId, msg.id)) {
      this.stats.filtered += 1;
      return null;
    }
    if (this.isSelfEcho(msg)) {
      this.stats.echo += 1;
      this.log.info?.(`识别到自己的回声，忽略: ${String(msg.text).slice(0, 40)}`);
      return null;
    }

    const limited = this.limiter.check(msg);
    if (limited) {
      this.stats.skipped += 1;
      this.log.debug?.(`${msg.chatId} 触发限流(${limited})，跳过`);
      return null;
    }

    const userText = decision.userText;
    this.limiter.begin(msg.chatId);
    this.stats.handled += 1;

    try {
      const persona = this.profiles.persona(msg.chatId, this.persona);
      const messages = buildMessages({
        persona,
        msg,
        history: this.memory.history(msg.chatId),
        cfg: { ...this.cfg, groupReply: overrides.groupReply || this.cfg.groupReply },
        userText,
      });

      // 按会话覆盖模型：没配就用全局（aiForChat 已处理），传入而非改共享实例，避免并发串台。
      const perChatAI = this.aiForChat(overrides);
      const raw = await this.responder.generate(messages, { ai: perChatAI });
      const parts = this.responder.prepare(raw);
      if (!parts.length) {
        this.stats.failed += 1;
        return null;
      }

      const delivered = await this.responder.deliver(msg.chatId, raw);
      if (!delivered.ok) {
        this.stats.failed += 1;
        this.log.warn(`AI 回复发送失败: ${delivered.message}`);
        return null;
      }

      const text = parts.join('\n');
      this.memory.push(msg.chatId, 'user', userText);
      this.memory.push(msg.chatId, 'assistant', text);
      this.limiter.mark(msg.chatId);
      this.outbound.push({ text, at: Date.now() });
      if (this.outbound.length > 50) this.outbound.shift();
      this.stats.replied += 1;
      this.log.info(`AI→${msg.chatId} ${truncate(text, 40)}`);
      return text;
    } catch (err) {
      this.stats.failed += 1;
      this.log.warn(`AI 调用失败: ${err.message}`);
      return null;
    } finally {
      this.limiter.end(msg.chatId);
    }
  }
}

/** 人设：文件优先于内联文本，再退回内置默认。 */
function loadPersona(cfg) {
  if (cfg.personaFile) {
    try {
      const text = fs.readFileSync(cfg.personaFile, 'utf8').trim();
      if (text) return text;
    } catch {
      /* 读不到就用下一档 */
    }
  }
  if (cfg.systemPrompt && cfg.systemPrompt.trim()) return cfg.systemPrompt.trim();
  return DEFAULT_PERSONA;
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export { stripMarkdown, splitReply, DEFAULT_PERSONA };
