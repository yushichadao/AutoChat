/**
 * 本地文件浏览 / 预览接口（供界面「选择文件 / 目录」与人设预览用）。
 *
 * 安全边界：
 *  - 服务只绑本机 + 令牌校验（与其它 /api 一致），调用者本就是本机操作者；
 *  - list 只回目录名与文件名，不回内容；read 只允许 txt / md 预览、64KB 截断，
 *    不提供任意文件读取（exe / db / env 一律拒绝）。
 */
import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_EXT = /\.(txt|md|markdown)$/i;
const MAX_PREVIEW_BYTES = 64 * 1024;

/** 列目录。dir 为空时返回 Windows 盘符列表作为根。 */
export const routes = {
  'GET /api/fs/list': async ({ url }) => {
    const raw = (url.searchParams.get('dir') || '').trim();
    if (!raw) {
      const roots = [];
      for (let c = 65; c <= 90; c += 1) {
        const d = `${String.fromCharCode(c)}:\\`;
        try { if (fs.existsSync(d)) roots.push(d); } catch { /* 跳过不可访问的盘 */ }
      }
      return { status: 200, body: { roots } };
    }
    const dir = path.resolve(raw);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return { status: 200, body: { error: String(e && e.message ? e.message : e) } };
    }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    const cmp = (a, b) => a.localeCompare(b, 'zh-CN');
    dirs.sort(cmp);
    files.sort(cmp);
    const parent = path.dirname(dir);
    return { status: 200, body: { dir, parent: parent && parent !== dir ? parent : '', dirs, files } };
  },

  /** 预览文本文件（人设等），只放行 txt / md，64KB 截断。 */
  'GET /api/fs/read': async ({ url }) => {
    const p = (url.searchParams.get('path') || '').trim();
    if (!p) return { status: 400, body: { error: '缺少 path' } };
    if (!PREVIEW_EXT.test(p)) return { status: 400, body: { error: '只支持预览 .txt / .md 文件' } };
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return { status: 400, body: { error: '不是文件' } };
      const len = Math.min(st.size, MAX_PREVIEW_BYTES);
      const fd = fs.openSync(p, 'r');
      let text = '';
      try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, 0);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { status: 200, body: { path: p, size: st.size, truncated: st.size > len, text } };
    } catch (e) {
      return { status: 200, body: { error: String(e && e.message ? e.message : e) } };
    }
  },
};
