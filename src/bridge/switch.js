import fs from 'node:fs';
import path from 'node:path';

/**
 * 总闸（master switch）。
 *
 * 自动化最怕的是「停不下来」。所以做三层，越靠后越硬：
 *
 *   1) 配置层   AI_ENABLED=0          → 启动时就不回复
 *   2) 哨兵文件 data/paused 存在      → 运行中立刻停止回复（仍接收、仍记日志）
 *   3) 进程层   结束进程                → 什么都不跑了
 *
 * 第 2 层是关键：不用重启、不用进 GUI，命令行一条命令就能拉下，
 * 而且是「文件即状态」—— 崩了重启后仍然是暂停状态（不会莫名其妙自己活过来）。
 *
 * 状态文件里写一行原因，方便看日志时知道是谁、为什么关的。
 */
export class MasterSwitch {
  constructor({ file, logger } = {}) {
    this.file = file || '';
    this.log = logger;
    this.cached = false;
    this.cachedAt = 0;
    this.cacheMs = 500;
  }

  /** 是否处于暂停状态（带 500ms 缓存，避免每条消息都去 stat）。 */
  isPaused() {
    if (!this.file) return false;
    const now = Date.now();
    if (this.cached && now - this.cachedAt < this.cacheMs) return this.cached === 'paused';
    let state = 'off';
    try {
      if (fs.existsSync(this.file)) {
        const text = fs.readFileSync(this.file, 'utf8').trim();
        state = 'paused'; // 哨兵文件存在即暂停（内容仅记录原因，不影响状态）
      }
    } catch (err) {
      this.log?.debug?.(`总闸状态读取失败: ${err.message}`);
    }
    this.cached = state;
    this.cachedAt = now;
    return state === 'paused';
  }

  /** 暂停自动回复。 */
  pause(reason = '手动暂停') {
    if (!this.file) return { ok: false, message: '没有配置暂停哨兵文件' };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        `paused at ${new Date().toISOString()}\nreason: ${String(reason).slice(0, 200)}\n`
      );
      this.cached = 'paused';
      this.cachedAt = Date.now();
      return { ok: true, message: '已暂停自动回复' };
    } catch (err) {
      return { ok: false, message: `暂停失败: ${err.message}` };
    }
  }

  /** 恢复自动回复。 */
  resume() {
    if (!this.file) return { ok: false, message: '没有配置暂停哨兵文件' };
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      this.cached = 'off';
      this.cachedAt = Date.now();
      return { ok: true, message: '已恢复自动回复' };
    } catch (err) {
      return { ok: false, message: `恢复失败: ${err.message}` };
    }
  }

  /** 当前状态快照。 */
  status() {
    const paused = this.isPaused();
    let reason = '';
    if (paused && this.file) {
      try {
        reason = fs.readFileSync(this.file, 'utf8').trim();
      } catch {
        /* 读不到就当没写原因 */
      }
    }
    return { paused, reason, file: this.file };
  }
}

/**
 * 单实例判定（纯函数，方便测试）。
 *
 * 两个助手同时跑会对着同一个群各回一遍：既重复回复，又双倍烧额度。
 * 所以新实例启动前先看「上一个实例」是不是还活着：
 * 活着就让位（退出），死了才接管。
 *
 * @param {number|string} existingPid pid 文件里记着的上一个实例
 * @param {number} currentPid 本进程 pid
 * @param {boolean} alive 上一个实例是否还活着
 */
export function shouldYieldToExisting(existingPid, currentPid, alive) {
  const a = Number(existingPid);
  const b = Number(currentPid);
  if (!Number.isFinite(a) || a <= 0) return false;
  if (a === b) return false;
  return Boolean(alive);
}

/** 进程 pid 文件：给「停止服务」用。 */
export class PidFile {
  constructor({ file } = {}) {
    this.file = file || '';
  }

  write(pid = process.pid) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, String(pid));
    } catch {
      /* 写不进去不影响主流程 */
    }
  }

  read() {
    if (!this.file || !fs.existsSync(this.file)) return 0;
    try {
      const n = Number(fs.readFileSync(this.file, 'utf8').trim());
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  clear() {
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    } catch {
      /* 忽略 */
    }
  }
}
