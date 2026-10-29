import fs from 'node:fs';
import path from 'node:path';

/**
 * 按体积轮转的日志文件写入器（L7）。
 *
 * 设计要点：
 *  - 每次写入前检查当前文件体积，超过 maxBytes 就「先关旧、再起新」，并把旧文件按 .1/.2/… 逐代后移。
 *  - 保留 generations 代（默认 3，即 .out / .out.1 / .out.2），再多就丢最老的。
 *  - 写入失败不抛（日志本身不能让主流程崩），仅吞掉错误。
 *  - 与 shell 重定向（>> autochat.out）二选一：启用本写入器时应让启动器不再重定向 stdout，
 *    否则会双写。后台启动器默认仍用 shell 重定向 + 启动时轮转（见 tasks/service.js 的 rotateLog）。
 */
export class RotatingFileWriter {
  /**
   * @param {string} file 主日志路径（如 data/autochat.out）
   * @param {{maxBytes?:number, generations?:number, logger?:object}} [opts]
   */
  constructor(file, { maxBytes = 2 * 1024 * 1024, generations = 3, logger } = {}) {
    this.file = file;
    this.maxBytes = maxBytes > 0 ? maxBytes : 2 * 1024 * 1024;
    this.generations = generations >= 1 ? generations : 1;
    this.log = logger;
    /** @type {number|null} */
    this.fd = null;
    this.size = 0;
    this._init();
  }

  _init() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 接续已有文件：从当前末尾继续，不覆盖历史
      if (fs.existsSync(this.file)) this.size = fs.statSync(this.file).size;
      this.fd = fs.openSync(this.file, 'a');
    } catch (err) {
      this.fd = null;
      this.log?.warn?.(`日志文件无法打开，改回 stdout: ${err.message}`);
    }
  }

  /** 把一代文件重命名为下一代（.1 -> .2，…，最老的超出 generations 的删除）。 */
  _shiftGenerations() {
    for (let i = this.generations; i >= 1; i--) {
      const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const dst = `${this.file}.${i}`;
      try {
        if (fs.existsSync(src)) {
          if (i === this.generations && fs.existsSync(dst)) fs.unlinkSync(dst);
          fs.renameSync(src, dst);
        }
      } catch {
        /* 某一代价不动就跳过 */
      }
    }
  }

  _rotate() {
    try {
      if (this.fd !== null) {
        fs.closeSync(this.fd);
        this.fd = null;
      }
    } catch {
      /* 关不掉也继续 */
    }
    this._shiftGenerations();
    try {
      this.fd = fs.openSync(this.file, 'a');
      this.size = fs.statSync(this.file).size;
    } catch (err) {
      this.fd = null;
      this.log?.warn?.(`日志轮转后无法重新打开: ${err.message}`);
    }
  }

  /** 写一行（自动 append 换行）。 */
  write(line) {
    if (this.fd === null) return false;
    const buf = Buffer.from(line + '\n', 'utf8');
    if (this.size + buf.length > this.maxBytes) this._rotate();
    if (this.fd === null) return false;
    try {
      fs.writeSync(this.fd, buf);
      this.size += buf.length;
      return true;
    } catch {
      return false;
    }
  }

  /** 主动轮转（如收到 SIGHUP / 定时触发）。 */
  rotate() {
    this._rotate();
  }

  close() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* noop */
      }
      this.fd = null;
    }
  }
}
