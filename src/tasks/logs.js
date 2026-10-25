import fs from 'node:fs';
import { logFiles, ROOT } from '../core/paths.js';

/**
 * 服务日志读取（任务层）。
 *
 * 职责边界：**只读两个固定文件**（data/autochat.out、data/autochat.err），
 * 路径不可由调用方或请求参数指定，避免变成任意文件读取。
 */

/** 单次最多返回的行数。 */
export const MAX_LOG_LINES = 200;
/** 单次最多读取的字节数（从文件尾部往回读）。 */
export const MAX_LOG_BYTES = 256 * 1024;

/** 取文件尾部若干行。 */
export function readTail(file, lines = MAX_LOG_LINES) {
  if (!file || !fs.existsSync(file)) return { file, lines: [], exists: false, truncated: false };
  const want = Math.max(1, Math.min(Number(lines) || MAX_LOG_LINES, MAX_LOG_LINES));
  let size = 0;
  let text = '';
  try {
    size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, MAX_LOG_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { file, lines: [], exists: true, truncated: false };
  }
  const all = text.split(/\r?\n/).filter((l) => l.length);
  const out = all.slice(-want);
  return { file, lines: out, exists: true, truncated: all.length > out.length || size > MAX_LOG_BYTES };
}

/**
 * 读取服务日志尾部。
 * @param {{rootDir?:string, lines?:number, err?:boolean}} opts
 */
export function readLogTail({ rootDir = ROOT, lines = MAX_LOG_LINES, err = false } = {}) {
  const files = logFiles(rootDir);
  return readTail(err ? files.err : files.out, lines);
}
