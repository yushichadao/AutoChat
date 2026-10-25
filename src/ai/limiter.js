/**
 * 限流与并发控制。
 *
 * 三道闸门：
 *  1) 同会话冷却：避免一个人连续追问时被连着回复
 *  2) 全局每小时配额：兜底，防止被刷
 *  3) 全局并发上限：防止群成员恶意 @ 一下就让模型并行跑一堆请求
 */

/** 同时处理中的消息数上限（按配置）。 */
export class RateLimiter {
  constructor(cfg = {}) {
    this.cooldownMs = Number(cfg.cooldownMs) || 0;
    this.maxPerHour = Number(cfg.maxPerHour) || 0;
    const mc = Number(cfg.maxConcurrent);
    this.maxConcurrent = Number.isFinite(mc) && mc >= 0 ? mc : 2; // 0 = 不设并发上限
    /** chatId -> 上次回复时刻 */
    this.lastReplyAt = new Map();
    /** 每小时窗口内的时间戳列表 */
    this.replyTimes = [];
    /** 正在处理中的会话 */
    this.inflight = new Set();
  }

  /** @returns {'cooldown'|'quota'|'concurrent'|null} */
  check(msg) {
    const now = Date.now();
    const last = this.lastReplyAt.get(msg.chatId) || 0;
    if (this.cooldownMs > 0 && now - last < this.cooldownMs) return 'cooldown';

    if (this.maxPerHour > 0) {
      const windowStart = now - 3600 * 1000;
      this.replyTimes = this.replyTimes.filter((t) => t > windowStart);
      if (this.replyTimes.length >= this.maxPerHour) return 'quota';
    }

    if (this.maxConcurrent >= 1 && this.inflight.size >= this.maxConcurrent) return 'concurrent';
    return null;
  }

  /** 占用并发槽。 */
  begin(chatId) {
    this.inflight.add(chatId);
  }

  /** 释放并发槽。 */
  end(chatId) {
    this.inflight.delete(chatId);
  }

  /** 记一次成功回复。 */
  mark(chatId) {
    this.lastReplyAt.set(chatId, Date.now());
    this.replyTimes.push(Date.now());
  }
}
