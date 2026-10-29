import { TriggerPolicy } from './trigger.js';
import { RateLimiter } from './limiter.js';
import { buildMessages, DEFAULT_PERSONA } from './prompt.js';
import { Responder, stripMarkdown, splitReply } from './responder.js';
import { runSearch, shouldSearch } from './tools/web-search.js';
import { extractText } from './tools/office.js';
import { pickModelTier, isLongTask, longTaskLabel } from './router.js';
import { runToolLoop } from './tools/loop.js';
import { allSkillNames } from './tools/registry.js';
import { readImageContent, visionSupport } from './vision.js';
import { MemorySummary } from './memory-summary.js';
import path from 'node:path';
import { ChatProfiles } from '../core/chats.js';
import { AIClient } from './client.js';
import * as persona from './persona.js';

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
  constructor({ cfg, ai, memory, hook, logger, selfWxid = '', selfName = '', profiles = null, selfFilter = null, pauseState = null }) {
    this.cfg = cfg;
    this.ai = ai;
    this.memory = memory;
    this.hook = hook;
    this.log = logger;
    this.selfWxid = selfWxid || '';
    /** 本机微信账号名（昵称）：报身份用 */
    this.selfName = selfName || cfg.selfName || '';
    /** sender | id —— 判定「这条是不是我自己发的」 */
    this.selfMode = cfg.selfMode || 'sender';
    this.selfFilter = selfFilter;
    /** 暂停状态：暂停时不回复任何消息（仍接收、仍记日志） */
    this.pauseState = pauseState;

    this.trigger = new TriggerPolicy(cfg);
    this.limiter = new RateLimiter(cfg, {
      statsFile: this.dataDir ? path.join(this.dataDir, 'rate-limit-stats.json') : '',
      logger,
    });
    this.responder = new Responder({ ai, cfg, hook, logger, selfFilter });
    this.profiles = profiles || new ChatProfiles({ chats: {}, logger });
    /** 全局 AI 配置（作为「按会话覆盖」的缺省值）。 */
    this.aiConfig = {
      baseUrl: ai?.baseUrl,
      apiKey: ai?.apiKey,
      model: ai?.model,
      timeoutMs: ai?.timeoutMs,
      reasoningEffort: ai?.reasoningEffort ?? cfg.reasoningEffort,
      reasoningFormat: ai?.reasoningFormat ?? cfg.reasoningFormat,
      reasoningBudget: ai?.reasoningBudget ?? cfg.reasoningBudget,
    };
    this.defaultAI = ai;
    this.persona = loadPersona(cfg);
    /** 人设名（身份三要素之一） */
    this.personaName = persona.personaName(cfg);
    this.stats = { handled: 0, replied: 0, skipped: 0, failed: 0, filtered: 0, echo: 0, paused: 0 };
    /** 最近发出去的内容，用于识别「自己发出去的消息又被收回来」 */
    this.outbound = [];
    /** 运行时数据目录（来自 loadConfig；测试可能不传，此时摘要库仅内存、不落盘）。 */
    this.dataDir = cfg.dataDir || '';
    /** 并发去重：正在处理的消息 id，防止「正常路径」与「漏接补偿复检」同时派发同一条消息导致双重回复。 */
    this.inflight = new Map();
    /** 长期记忆摘要（MS2/3/4/7）：持久库，独立于易失的 context；默认抽取式、离线可用。 */
    this.memorySummary = new MemorySummary({
      file: this.dataDir ? path.join(this.dataDir, 'ai-memory-summary.json') : '',
      logger,
      interval: cfg.summaryInterval || 8,
    });
    /** 每个会话累计多少轮后做一次摘要并入持久库 */
    this.summaryCounters = new Map();
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

  /**
   * 该会话用的人设名：会话单独配了人设文件时用它的文件名，否则用全局人设名。
   */
  personaNameFor(chatId) {
    const ov = this.overrideFor(chatId);
    if (ov && ov.personaFile) return persona.personaName(this.cfg, ov.personaFile);
    return this.personaName;
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
   * 会话在 config.json 里配了 baseUrl / apiKey / model / reasoningEffort 任意一项，就据此新建一个客户端；
   * 没配就沿用全局那个（避免每次都 new）。
   * @param {object} overrides ChatProfiles.get() 的返回值
   * @returns {AIClient}
   */
  aiForChat(overrides = {}) {
    const o = overrides || {};
    if (!o.baseUrl && !o.apiKey && !o.model && !o.reasoningEffort) return this.defaultAI;
    try {
      return new AIClient({
        baseUrl: o.baseUrl || this.aiConfig.baseUrl,
        apiKey: o.apiKey ?? this.aiConfig.apiKey,
        model: o.model || this.aiConfig.model,
        timeoutMs: this.aiConfig.timeoutMs,
        reasoningEffort: o.reasoningEffort || this.aiConfig.reasoningEffort,
        reasoningFormat: o.reasoningFormat || this.aiConfig.reasoningFormat,
        reasoningBudget: Number.isFinite(Number(o.reasoningBudget))
          ? Number(o.reasoningBudget)
          : this.aiConfig.reasoningBudget,
        logger: this.log,
      });
    } catch {
      return this.defaultAI;
    }
  }

  /**
   * 该消息实际要用的模型客户端（含多模态路由）。
   * 带图的消息优先走视觉模型（cfg.visionModel，留空则回落全局 / 按会话覆盖）；
   * 纯文本消息走 aiForChat 的常规逻辑。
   */
  aiForContent(msg, overrides) {
    const o = overrides || {};
    const hasImages = Array.isArray(msg?.images) && msg.images.length > 0;
    if (hasImages && this.cfg.visionModel) {
      return this.aiForChat({ ...o, model: this.cfg.visionModel });
    }
    return this.aiForChat(o);
  }

  /**
   * 轻量模型客户端（§16.5 高级模式里的第二模型，**完全由用户指定**）。
   * 没配 AI_LIGHT_MODEL 时返回 null，由调用方回落主模型 ——
   * 避免「开了路由却没配第二模型」时把请求打到空 endpoint。
   * @param {object} overrides 按会话覆盖（lightBaseUrl / lightModel / lightApiKey）
   * @returns {AIClient|null}
   */
  aiForLight(overrides = {}) {
    const o = overrides || {};
    const model = o.lightModel || this.cfg.lightModel;
    if (!model) return null;
    try {
      return new AIClient({
        baseUrl: o.lightBaseUrl || this.cfg.lightBaseUrl || this.aiConfig.baseUrl,
        apiKey: o.lightApiKey ?? this.cfg.lightApiKey ?? this.aiConfig.apiKey,
        model,
        timeoutMs: this.aiConfig.timeoutMs,
        reasoningEffort: o.reasoningEffort || this.aiConfig.reasoningEffort,
        reasoningFormat: o.reasoningFormat || this.aiConfig.reasoningFormat,
        reasoningBudget: this.aiConfig.reasoningBudget,
        logger: this.log,
      });
    } catch {
      return null;
    }
  }

  /**
   * 联网搜索（§16.2 策略 B）：若开启且本消息命中触发，则检索并拼成上下文，由调用方作为
   * 一条 system 消息插入。失败不影响本次回复。per-chat 覆盖优先于全局配置。
   * @param {string} text 用户文本
   * @param {object} [overrides] 来自 ChatProfiles 的按会话覆盖
   * @returns {Promise<string|null>}
   */
  async buildWebSearchContext(text, overrides = {}) {
    const cfg = this.cfg;
    // 灰度互补：本会话若启用了 AI 工具，联网搜索交给 web_search 技能处理，
    // 避免与策略 B 预注入重复检索（同一查询搜两次、还浪费一轮延迟）。
    const toolsOn = overrides.aiTools !== undefined ? overrides.aiTools : cfg.aiTools;
    if (toolsOn) return null;
    const enabled = overrides.webSearch !== undefined ? overrides.webSearch : cfg.webSearch;
    if (!enabled) return null;
    const r = await runSearch({
      query: text,
      config: {
        enabled: true,
        provider: overrides.webSearchProvider || cfg.webSearchProvider,
        apiKey: overrides.webSearchKey || cfg.webSearchKey,
        mode: overrides.webSearchMode || cfg.webSearchMode,
        prefix: overrides.webSearchPrefix || cfg.webSearchPrefix,
        maxResults: cfg.webSearchMaxResults || 5,
        maxChars: cfg.webSearchMaxChars || 4000,
        customEndpoint: overrides.webSearchCustomEndpoint || cfg.webSearchCustomEndpoint,
      },
    });
    if (r && r.context) {
      this.log.info?.(`联网搜索触发（provider=${r.provider}，结果 ${r.results.length} 条），已注入上下文`);
      return r.context;
    }
    return null;
  }

  /**
   * 文档解读（§16.6 基础办公）：把入站附件抽成文本，作为 system 消息注入上下文。
   *
   * 默认关闭（须显式 opt-in）。抽取是**纯本地**的（零依赖解析，不发往任何外部服务），
   * 与"联网搜索"是两回事。单份超长按 AI_DOC_MAX_CHARS 截断；某份失败只记日志，
   * 不影响本轮回复 —— 不因一个打不开的文件让助手失声。
   * @param {object} msg 归一化消息（含 files）
   * @param {object} [overrides] 按会话覆盖
   * @returns {Promise<string|null>}
   */
  async buildDocContext(msg, overrides = {}) {
    const cfg = this.cfg;
    const on = overrides.docAnalysis !== undefined ? overrides.docAnalysis : cfg.docAnalysis;
    if (!on) return null;
    const files = Array.isArray(msg?.files) ? msg.files : [];
    if (!files.length) return null;
    const maxChars = Number(cfg.docMaxChars) > 0 ? Number(cfg.docMaxChars) : 0;

    const parts = [];
    for (const f of files) {
      const r = extractText(f, { maxChars });
      const name = path.basename(String(f));
      if (r.ok && r.text) {
        parts.push(`【附件 ${name}（${r.kind}${r.truncated ? '，已截断' : ''}）】\n${r.text}`);
      } else {
        parts.push(`【附件 ${name}】抽取失败：${r.reason || '未知原因'}`);
        this.log.warn?.(`文档抽取失败 ${f}：${r.reason || '未知原因'}`);
      }
    }
    if (!parts.length) return null;
    this.log.info?.(`文档解读：${files.length} 个附件已抽取并注入上下文（本地解析，未外发）`);
    return `以下是用户发来的附件内容，请基于它回答：\n\n${parts.join('\n\n')}`;
  }

  /**
   * 生成回复：未开启工具调用时走原单次 completion；开启时走 ReAct 工具循环（§16.4）。
   * 白名单 + 最大轮次 + 工具执行上下文（含联网搜索配置，供 web_search 技能复用 §16.2 provider）。
   * @param {Array} messages 已含搜索上下文的 messages
   * @param {object} ai 本次要用的 AI 客户端
   * @param {object} [overrides] 按会话覆盖
   * @returns {Promise<string>}
   */
  async runReply(messages, ai, overrides = {}) {
    const cfg = this.cfg;
    const toolsOn = overrides.aiTools !== undefined ? overrides.aiTools : cfg.aiTools;
    if (!toolsOn) return this.responder.generate(messages, { ai });

    const allow = (overrides.aiToolsAllow && overrides.aiToolsAllow.length)
      ? overrides.aiToolsAllow
      : (cfg.aiToolsAllow && cfg.aiToolsAllow.length ? cfg.aiToolsAllow : allSkillNames());
    const maxRounds = Number.isFinite(Number(cfg.aiToolsMaxRounds)) && cfg.aiToolsMaxRounds > 0 ? cfg.aiToolsMaxRounds : 3;
    const toolCtx = {
      webSearchConfig: {
        provider: overrides.webSearchProvider || cfg.webSearchProvider,
        key: overrides.webSearchKey || cfg.webSearchKey,
        prefix: overrides.webSearchPrefix || cfg.webSearchPrefix,
        maxResults: cfg.webSearchMaxResults || 5,
        maxChars: cfg.webSearchMaxChars || 4000,
        customEndpoint: overrides.webSearchCustomEndpoint || cfg.webSearchCustomEndpoint,
      },
      /** 文档生成输出目录（沙箱，write_doc 只能写这里）；未配则落到 dataDir/outbox */
      docOutDir: cfg.docOutDir || (this.dataDir ? path.join(this.dataDir, 'outbox') : ''),
    };
    this.log.info?.(`AI 工具调用启用（白名单：${allow.join(',')}，最大轮次 ${maxRounds}）`);
    const loop = await runToolLoop({ messages, ai, allowedTools: allow, maxRounds, toolCtx, log: this.log });
    return loop.text;
  }

  /**
   * 配置热更新：常驻进程里改了 .env / config.json 不必重启。
   *
   * 只换「策略」部分 —— AI 客户端、上下文记忆、限流与冷却状态都原地保留，
   * 否则一次改配置就会打断正在进行的对话、把冷却清零。
   *
   * @param {object} nextCfg 新的 AI 配置（含 selfMode）
   * @param {object} [chats] 新的按会话配置（config.json 的 chats）
   */
  applyConfig(nextCfg, chats) {
    if (chats && typeof chats === 'object') this.profiles.setChats(chats);
    const cfg = { ...(nextCfg || this.cfg) };
    this.cfg = cfg;
    // 白/黑名单、@ 称呼在 TriggerPolicy 构造时被摊平成 Set，配置变了只能整个重建
    this.trigger = new TriggerPolicy(cfg);
    // 限流器有状态，就地更新数值
    this.limiter.applyCfg(cfg);
    this.responder.cfg = cfg;
    if (cfg.personaFile !== undefined || cfg.systemPrompt !== undefined) this.persona = loadPersona(cfg);
    if (cfg.personaName !== undefined || cfg.personaFile !== undefined) this.personaName = persona.personaName(cfg);
    return cfg;
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
    // 暂停状态：哨兵文件存在就一条都不回（配置层的开关在启动时就决定了要不要建这条流水线）。
    // 这是「随时能拉下」的硬保证 —— 宁可不回，也不能失控刷屏。
    if (this.pauseState?.isPaused()) {
      this.stats.paused += 1;
      this.log.info?.('自动回复已暂停，本次不回复');
      return null;
    }

    const overrides = this.overrideFor(msg?.chatId);
    let decision = null;
    let userText = '';
    if (msg.batch) {
      // 合批合成消息：聚合器已经攒好窗口内多条发言，这里直接跳过触发判定，用整段对话文本
      userText = String(msg.text || '');
    } else {
      decision = this.trigger.decide(msg, { selfWxid: this.selfWxid, overrides });
      if (!decision.ok) {
        this.stats.filtered += 1;
        this.log.debug?.(`${msg?.chatId || '-'} 未触发(${decision.reason})，跳过`);
        return null;
      }
      userText = decision.userText;
    }

    if (this.selfMode !== 'id' && this.selfWxid && msg.senderId && msg.senderId === this.selfWxid) {
      this.stats.filtered += 1;
      return null;
    }
    // 复检补答消息（msg.reconcile）：其 id 可能已被 selfFilter 误标进 sent 集合，
    // 此处跳过 isSentId 校验，改由 receiver 复检时已用 DB 发送者权威判定过，避免被误杀。
    if (!msg.reconcile && this.selfFilter?.isSentId(msg.chatId, msg.id)) {
      this.stats.filtered += 1;
      return null;
    }
    if (this.isSelfEcho(msg)) {
      this.stats.echo += 1;
      this.log.info?.(`识别到自己的回声，忽略: ${String(msg.text).slice(0, 40)}`);
      return null;
    }

    // 同一条消息并发去重：防止「正常增量路径」与「漏接补偿复检」同时派发同一条消息导致双重回复。
    // 复检消息（msg.reconcile）也走这里，保证不会和正常路径重复回复同一条。
    const mid = msg?.id;
    if (mid) {
      if (this.inflight.has(mid)) {
        this.stats.skipped += 1;
        return null;
      }
      this.inflight.set(mid, Date.now());
    }

    const limited = this.limiter.check(msg);
    if (limited) {
      this.stats.skipped += 1;
      this.log.info(`${msg.chatId} 触发限流(${limited})，本次不回复`);
      return null;
    }

    this.limiter.begin(msg.chatId);
    this.stats.handled += 1;

    try {
      const persona = this.profiles.persona(msg.chatId, this.persona);
      // 按会话覆盖模型：没配就用全局（aiForChat 已处理），传入而非改共享实例，避免并发串台。
      const perChatAI = this.aiForChat(overrides);

      // 多模态（§3.1 图→文）：把入站图片读成 image_url 内容块，并路由到视觉模型。
      let userContent = undefined;
      let aiForThis = perChatAI;
      if (msg.images && msg.images.length) {
        // IR3：本机纯文本模型不支持视觉 —— 明确告知用户，而不是送进去报 400 / 静默忽略。
        // 判定在读图之前，所以这里图片不会被读盘、不会组装 image_url、字节不会离开本机。
        const vs = visionSupport({ baseUrl: this.cfg.baseUrl, visionModel: this.cfg.visionModel });
        if (!vs.ok) {
          this.stats.filtered += 1;
          this.log.info(
            `${msg.chatId} 图片消息：本地模型不支持视觉（未配 AI_VISION_MODEL），已提示用户；图片未读盘、未出机`
          );
          const tip = this.cfg.visionUnsupportedText || '当前模型不支持看图。';
          const d = await this.responder.deliver(msg.chatId, tip);
          return d.ok ? tip : null;
        }
        const vc = readImageContent(msg.images, { maxBytes: this.cfg.maxImageBytes, logger: this.log });
        const blocks = vc.blocks.slice();
        if (userText) blocks.push({ type: 'text', text: userText });
        if (!blocks.length) {
          // 图全被体积护栏拦下、又没文字 → 没有有效输入，不当作一次回复
          this.stats.filtered += 1;
          this.log.info(`${msg.chatId} 图片消息无有效输入（${vc.skipped.length} 张被护栏拦下且无文字），跳过`);
          return null;
        }
        userContent = blocks;
        // 带图消息走视觉模型（回落逻辑见 aiForContent）
        aiForThis = this.aiForContent(msg, overrides);
        this.log.info(
          `图片消息：送视觉模型 ${(aiForThis && aiForThis.model) || '默认'}（${vc.blocks.length} 张纳入，${vc.skipped.length} 张跳过）`
        );
      }

      // ── §16.5 复杂度信号：一次算好，双模型路由与长任务提示共用 ──
      const hasAttachment = Boolean(msg.files && msg.files.length);
      const toolsOn = overrides.aiTools !== undefined ? overrides.aiTools : this.cfg.aiTools;
      const wsEnabled = overrides.webSearch !== undefined ? overrides.webSearch : this.cfg.webSearch;
      // 开启工具时联网交给 web_search 技能、策略 B 不预注入（见 buildWebSearchContext），此处同样排除
      const willSearch = Boolean(
        wsEnabled && !toolsOn && shouldSearch(userText, {
          mode: overrides.webSearchMode || this.cfg.webSearchMode,
          prefix: overrides.webSearchPrefix || this.cfg.webSearchPrefix,
        })
      );

      // ── §16.5 双模型路由：默认关闭＝始终用用户配的那一个模型 ──
      // 图片消息优先走视觉模型（上面 aiForContent 已处理），不参与轻量 / 主模型切换。
      const routingOn = overrides.modelRouting !== undefined ? overrides.modelRouting : this.cfg.modelRouting;
      if (routingOn && !(msg.images && msg.images.length)) {
        const picked = pickModelTier({ text: userText, hasAttachment, willSearch, toolsOn });
        if (picked.tier === 'light') {
          const lightAI = this.aiForLight(overrides);
          if (lightAI) {
            aiForThis = lightAI;
            this.log.info(`模型路由：${picked.reason} → 轻量模型 ${lightAI.model}`);
          } else {
            this.log.info(`模型路由：${picked.reason} → 想用轻量模型但未配 AI_LIGHT_MODEL，回落主模型`);
          }
        } else {
          this.log.info(`模型路由：${picked.reason} → 主模型`);
        }
      }

      // ── §16.5 长任务占位：先发一条「正在XX中……」，结果另起一条新消息 ──
      // 微信不支持对已发消息做原地替换，所以这里不是原地占位，而是两条真消息。
      const noticeOn = overrides.longTaskNotice !== undefined ? overrides.longTaskNotice : this.cfg.longTaskNotice;
      // 传入 userText：生成型任务（写代码 / 长文）不依赖工具，只能从文本识别
      if (noticeOn && isLongTask({ hasAttachment, willSearch, toolsOn, text: userText })) {
        try {
          await this.responder.sendNotice(msg.chatId, longTaskLabel({ hasAttachment, willSearch, toolsOn, text: userText }));
        } catch (e) {
          this.log.warn?.(`长任务提示发送失败（不影响回复）: ${e.message}`);
        }
      }

      const messages = buildMessages({
        persona,
        msg,
        history: this.memory.history(msg.chatId),
        // 身份要素（账号名 + 人设名 + 模型名 + 运行方式）带进 prompt
        cfg: {
          ...this.cfg,
          groupReply: overrides.groupReply || this.cfg.groupReply,
          model: (aiForThis && aiForThis.model) || this.aiConfig.model,
          // 按会话覆盖可能换了接口地址，运行方式要以这条消息真正走的那个为准
          baseUrl: (aiForThis && aiForThis.baseUrl) || this.aiConfig.baseUrl || this.cfg.baseUrl,
          account: this.selfName,
          personaName: this.personaNameFor(msg.chatId),
        },
        userText,
        userContent,
        // 长期记忆摘要回注（MS5）：跨会话记得偏好 / 约定
        memorySummary: this.memorySummary.get(msg.chatId)?.summary || null,
      });
      const searchCtx = await this.buildWebSearchContext(userText, overrides);
      if (searchCtx) messages.splice(1, 0, { role: 'system', content: searchCtx });

      // 文档解读（§16.6）：本地抽取附件文本后注入，与联网搜索同一注入手法
      const docCtx = await this.buildDocContext(msg, overrides);
      if (docCtx) messages.splice(1, 0, { role: 'system', content: docCtx });

      const raw = await this.runReply(messages, aiForThis, overrides);
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
      // 长期记忆摘要：每累计 summaryInterval 轮把当前转录并入持久库（抽取式、离线）。
      try {
        const n = (this.summaryCounters.get(msg.chatId) || 0) + 1;
        if (n >= (this.cfg.summaryInterval || 8)) {
          this.summaryCounters.set(msg.chatId, 0);
          const transcript = this.memory.history(msg.chatId);
          if (transcript.length) await this.memorySummary.ingest(msg.chatId, transcript);
        } else {
          this.summaryCounters.set(msg.chatId, n);
        }
      } catch (e) {
        this.log.warn?.(`记忆摘要更新失败（不影响回复）: ${e.message}`);
      }
      if (this.outbound.length > 50) this.outbound.shift();
      this.stats.replied += 1;
      // 把这次实际用的模型写进日志：按会话可能覆盖了全局模型，
      // 出问题时一眼就能看出「这次到底是谁答的」。
      this.log.info(`AI→${msg.chatId} [${(aiForThis && aiForThis.model) || '未知模型'}] ${truncate(text, 40)}`);
      return text;
    } catch (err) {
      this.stats.failed += 1;
      this.log.warn(`AI 调用失败: ${err.message}`);
      return null;
    } finally {
      if (mid) this.inflight.delete(mid);
      this.limiter.end(msg.chatId);
    }
  }
}

/** 人设：走 src/ai/persona.js（文件 > 内联文本 > 内置默认，默认人设自带 AI 身份披露）。 */
function loadPersona(cfg) {
  return persona.loadPersona(cfg).text;
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export { stripMarkdown, splitReply, DEFAULT_PERSONA };
