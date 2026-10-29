/**
 * 群聊「多消息合批回复」聚合器。
 *
 * 设计（见 plan-2.0.0.md §15 / test-plan.md G33、R28）：
 *  · 触发：第一条「符合触发条件」的群消息开启一个窗口（@我们 / 触发词 / 带图）。
 *  · 攒什么：窗口存活期间，该群**所有**收到的消息都进缓冲（含非触发者的话 —— 这是「别人的话并入」的意义）；
 *           但只有「符合触发且还没被单独回答」的消息计入条数上限。
 *  · 关闭（任一满足即发）：
 *      - 触发消息数达到 batchMaxMessages（近 10 条）；
 *      - 首条触发消息后超过 batchWindowMs（10 分钟，兜底，避免永远不开火）；
 *      - 最后一条消息后静默 batchFlushDelayMs（默认 20s）无新消息（合批体验关键）。
 *  · 回复：把整段对话格式化后作为一条「合成消息」交给 AIReply.handle（msg.batch=true，跳过触发判定）。
 *
 * 隐私：合批会把多人对话交给模型。是否允许云端模型由调用方（GUI 确认 / 配置）决定，
 *       本类只负责聚合与调度，不强制限制（云端限制落在配置层与 GUI 确认）。
 *
 * 不处理：暂停 / 限流 / 自消息过滤 —— 这些在 AIReply.handle 内部照常生效（合成消息同样过一遍）。
 */
export class BatchAggregator {
  /**
   * @param {object} opt
   * @param {object} opt.cfg 全局 ai 配置（含 replyMode / batchWindowMs / batchMaxMessages / batchFlushDelayMs）
   * @param {object} [opt.profiles] 会话配置对象，需支持 get(chatId) 返回 { replyMode? }
   * @param {string} [opt.selfWxid]
   * @param {object} [opt.logger]
   * @param {(msg)=>boolean} opt.shouldReplyFn 判断一条消息是否「符合触发条件」（由 AIReply.shouldReply 注入）
   * @param {(chatId:string, synthetic:object)=>Promise<any>} opt.onFlush 窗口闭合时回调，把合成消息交给 AIReply.handle
   */
  constructor({ cfg, profiles, selfWxid = '', logger, shouldReplyFn, onFlush }) {
    this.cfg = cfg || {};
    this.profiles = profiles;
    this.selfWxid = selfWxid;
    this.log = logger;
    this.shouldReplyFn = shouldReplyFn;
    this.onFlush = onFlush;
    /** chatId -> { msgs:[], triggeredCount, firstTs, windowTimer, flushTimer } */
    this.buffers = new Map();
  }

  replyModeFor(chatId) {
    const c = this.profiles && typeof this.profiles.get === 'function' ? this.profiles.get(chatId) : {};
    return (c && c.replyMode) || this.cfg.replyMode || 'single';
  }

  /**
   * 收到一条消息。返回 true 表示已被聚合器消费（调用方不要再走单条 handle）。
   * 返回 false 表示走原有单条路径。
   */
  push(msg) {
    if (!msg || msg.chatType !== 'group') return false;
    const mode = this.replyModeFor(msg.chatId);
    if (mode !== 'batch') return false;

    const triggered = typeof this.shouldReplyFn === 'function' ? !!this.shouldReplyFn(msg) : false;
    let buf = this.buffers.get(msg.chatId);
    const now = Date.now();
    if (!buf) {
      // 第一条任意群消息就开窗口（不限触发）——这样窗口内普通群友的发言也能并入上下文；
      // 整窗若无一条「该被处理」的消息，flush 时直接丢弃、不回复（见 flush）。
      buf = { msgs: [], triggeredCount: 0, firstTs: now, windowTimer: null, flushTimer: null };
      this.buffers.set(msg.chatId, buf);
    }
    buf.msgs.push({ ...msg, _triggered: triggered, _ts: now });
    if (triggered) buf.triggeredCount += 1;
    this._schedule(msg.chatId, buf);
    return true;
  }

  _schedule(chatId, buf) {
    // 条数达标 → 立即发
    if (buf.triggeredCount >= (this.cfg.batchMaxMessages || 10)) {
      this.flush(chatId);
      return;
    }
    // 重置「最后一条后静默期」定时器
    if (buf.flushTimer) clearTimeout(buf.flushTimer);
    buf.flushTimer = setTimeout(() => this.flush(chatId), this.cfg.batchFlushDelayMs || 20000);
    // 窗口总时长定时器只在创建时设一次
    if (!buf.windowTimer) {
      buf.windowTimer = setTimeout(() => this.flush(chatId), this.cfg.batchWindowMs || 600000);
    }
  }

  /** 强制闭合某个群的窗口（测试 / 进程退出时用）。 */
  flush(chatId) {
    const buf = this.buffers.get(chatId);
    if (!buf) return Promise.resolve(null);
    this.buffers.delete(chatId);
    if (buf.flushTimer) clearTimeout(buf.flushTimer);
    if (buf.windowTimer) clearTimeout(buf.windowTimer);
    if (!buf.msgs.length) return Promise.resolve(null);
    // 整窗没有一条「该被处理」的消息（纯闲聊）→ 丢弃，不回复
    if (!buf.triggeredCount) {
      this.log?.debug?.(`群 ${chatId} 合批窗口闭合但无触发消息，丢弃 ${buf.msgs.length} 条未回复`);
      return Promise.resolve(null);
    }

    const triggered = buf.msgs.filter((m) => m._triggered);
    const lastTrigger = triggered[triggered.length - 1] || buf.msgs[buf.msgs.length - 1];
    const lines = buf.msgs.map((m) => {
      const name = m.senderName || m.senderId || '群友';
      const at = m._triggered ? '（@你）' : '';
      return `[${name}${at}] ${m.text || ''}`;
    });
    const synthetic = {
      batch: true,
      chatId,
      chatType: 'group',
      chatName: lastTrigger.chatName,
      senderId: lastTrigger.senderId,
      senderName: lastTrigger.senderName,
      text:
        '以下是群里最近的多条发言（需要你统一回应，而不是逐条回答）：\n' + lines.join('\n'),
      kind: 'text',
      images: [],
      batchCount: buf.msgs.length,
    };
    this.log?.info?.(`合批回复 ${chatId}：合并 ${buf.msgs.length} 条（触发 ${buf.triggeredCount} 条）`);
    if (typeof this.onFlush !== 'function') return Promise.resolve(null);
    return Promise.resolve(this.onFlush(chatId, synthetic));
  }

  /** 进程退出时清掉所有定时器，避免挂起。 */
  stop() {
    for (const buf of this.buffers.values()) {
      if (buf.flushTimer) clearTimeout(buf.flushTimer);
      if (buf.windowTimer) clearTimeout(buf.windowTimer);
    }
    this.buffers.clear();
  }
}
