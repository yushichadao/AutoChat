import fs from 'node:fs';
import path from 'node:path';

/**
 * 按会话维护上下文。
 * 只留最近 N 轮，闲置超时清空，落盘用节流写避免每条消息都打磁盘。
 *
 * 落盘采用「临时文件 + rename」原子替换：写到一半崩了也不会留下半个损坏的
 * JSON（旧实现直接 writeFileSync，崩一次上下文就全丢）。
 */

/** 落盘格式版本，便于以后迁移。 */
export const SCHEMA_VERSION = 1;

export class Memory {
  constructor({ maxTurns = 8, ttlMs = 30 * 60 * 1000, maxChars = 0, file = '', logger } = {}) {
    this.maxTurns = Math.max(1, maxTurns);
    this.ttlMs = ttlMs;
    /** 上下文字符预算：超了从最早的开始丢（0 = 不限） */
    this.maxChars = Number(maxChars) || 0;
    this.file = file;
    this.log = logger;
    this.sessions = new Map(); // chatId -> { messages: [{role,content,at}], updatedAt }
    this.dirty = false;
    this.flushTimer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      const now = Date.now();
      // 新版：{ __v: 1, sessions: {...} }；旧版：{ chatId: {...} } 平铺
      const bag = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : raw;
      for (const [chatId, s] of Object.entries(bag || {})) {
        if (chatId === '__v') continue;
        // ttlMs = 0 表示永不过期，不能按「已过期」丢掉
        const expired = this.ttlMs > 0 && now - (s.updatedAt || 0) > this.ttlMs;
        if (!s?.messages || expired) continue;
        this.sessions.set(chatId, { messages: s.messages, updatedAt: s.updatedAt || now });
      }
    } catch (err) {
      this.log?.debug?.(`上下文读取失败，忽略: ${err.message}`);
    }
  }

  scheduleFlush() {
    if (!this.file || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 5000);
    this.flushTimer.unref?.();
  }

  /** 原子写：先写临时文件再 rename，避免崩溃留下半个损坏的 JSON。 */
  flush() {
    if (!this.file || !this.dirty) return;
    try {
      const sessions = {};
      for (const [chatId, s] of this.sessions) sessions[chatId] = s;
      const payload = JSON.stringify({ __v: SCHEMA_VERSION, sessions });
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log?.debug?.(`上下文写入失败: ${err.message}`);
    }
  }

  /** 取历史（已过期则清空）。 */
  history(chatId) {
    const s = this.sessions.get(chatId);
    if (!s) return [];
    if (this.ttlMs > 0 && Date.now() - s.updatedAt > this.ttlMs) {
      this.sessions.delete(chatId);
      return [];
    }
    return this.fit(s.messages.map((m) => ({ role: m.role, content: m.content })));
  }

  /**
   * 按字符预算裁剪：保留最近的，总量不超 maxChars。
   * 至少留一条（哪怕它自己就超预算），否则模型会收到空上下文。
   */
  fit(messages) {
    if (!this.maxChars || !messages.length) return messages;
    let total = 0;
    const out = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const len = (messages[i]?.content || '').length;
      if (out.length && total + len > this.maxChars) break;
      total += len;
      out.unshift(messages[i]);
    }
    return out;
  }

  push(chatId, role, content) {
    if (!content) return;
    let s = this.sessions.get(chatId);
    if (!s) {
      s = { messages: [], updatedAt: Date.now() };
      this.sessions.set(chatId, s);
    }
    s.messages.push({ role, content, at: Date.now() });
    // 一问一答算一轮，多留一倍容错
    const keep = this.maxTurns * 2;
    if (s.messages.length > keep) s.messages = s.messages.slice(-keep);
    s.updatedAt = Date.now();
    this.dirty = true;
    this.scheduleFlush();
  }

  reset(chatId) {
    this.sessions.delete(chatId);
    this.dirty = true;
    this.scheduleFlush();
  }

  /** 清掉所有过期会话，定期调用即可。 */
  cleanup() {
    if (!this.ttlMs) return 0;
    const now = Date.now();
    let n = 0;
    for (const [chatId, s] of this.sessions) {
      if (now - s.updatedAt > this.ttlMs) {
        this.sessions.delete(chatId);
        n += 1;
      }
    }
    if (n) {
      this.dirty = true;
      this.scheduleFlush();
    }
    return n;
  }

  get size() {
    return this.sessions.size;
  }
}
