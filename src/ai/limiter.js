/**
 * 限流与并发控制。
 *
 * 三道闸门：
 *  1) 同会话冷却：避免一个人连续追问时被连着回复
 *  2) 全局每小时配额：兜底，防止被刷
 *  3) 全局并发上限：防止群成员恶意 @ 一下就让模型并行跑一堆请求
 */
import fs from 'node:fs';
import path from 'node:path';

/** 同时处理中的消息数上限（按配置）。 */
export class RateLimiter {
  constructor(cfg = {}, { statsFile = '', logger } = {}) {
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
    /** 三个独立闸门的跳过计数（ observability，见 R16 / GAP5）。 */
    this.cooldownHits = 0;
    this.quotaHits = 0;
    this.concurrentHits = 0;
    /** 把三类计数快照落盘，供 `autochat status` / GUI 跨进程读取（见 R16）。 */
    this.statsFile = statsFile;
    this.log = logger;
    if (statsFile) {
      this._flushTimer = setInterval(() => this.flush(), 10000);
      this._flushTimer.unref?.();
    }
  }

  /**
   * 配置热更新：只改数值。
   * 冷却时刻、配额窗口、并发占用都是运行时状态，不能因为改了一次配置就被清空。
   */
  applyCfg(cfg = {}) {
    this.cooldownMs = Number(cfg.cooldownMs) || 0;
    this.maxPerHour = Number(cfg.maxPerHour) || 0;
    const mc = Number(cfg.maxConcurrent);
    this.maxConcurrent = Number.isFinite(mc) && mc >= 0 ? mc : 2;
  }

  /** 当前限流统计快照（R16 / GAP5）。 */
  stats() {
    const now = Date.now();
    const windowStart = now - 3600 * 1000;
    const inWindow = this.replyTimes.filter((t) => t > windowStart).length;
    return {
      cooldownMs: this.cooldownMs,
      maxPerHour: this.maxPerHour,
      maxConcurrent: this.maxConcurrent,
      inflight: this.inflight.size,
      repliedInLastHour: inWindow,
      cooldownHits: this.cooldownHits,
      quotaHits: this.quotaHits,
      concurrentHits: this.concurrentHits,
    };
  }

  /** 把统计快照写入 statsFile（无文件则 no-op）。 */
  flush() {
    if (!this.statsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.statsFile), { recursive: true });
      fs.writeFileSync(this.statsFile, JSON.stringify(this.stats()));
    } catch (err) {
      this.log?.debug?.(`限流统计写入失败: ${err.message}`);
    }
  }

  /** @returns {'cooldown'|'quota'|'concurrent'|null} */
  check(msg) {
    const now = Date.now();
    const last = this.lastReplyAt.get(msg.chatId) || 0;
    if (this.cooldownMs > 0 && now - last < this.cooldownMs) {
      this.cooldownHits += 1;
      return 'cooldown';
    }

    if (this.maxPerHour > 0) {
      const windowStart = now - 3600 * 1000;
      this.replyTimes = this.replyTimes.filter((t) => t > windowStart);
      if (this.replyTimes.length >= this.maxPerHour) {
        this.quotaHits += 1;
        return 'quota';
      }
    }

    if (this.maxConcurrent >= 1 && this.inflight.size >= this.maxConcurrent) {
      this.concurrentHits += 1;
      return 'concurrent';
    }
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
