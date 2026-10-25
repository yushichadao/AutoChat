import fs from 'node:fs';
import path from 'node:path';
import { ps } from '../core/win.js';
import { lockWeChatUpdate } from './install.js';

/**
 * 锁定微信版本任务（任务层）。
 *
 * 职责边界：阻断微信自动更新（把 update 目录换成只读文件），
 * 以及查询「当前是否已锁定」。
 */

export { lockWeChatUpdate };

/** 微信 update 目录路径。 */
export function updateDir() {
  return path.join(process.env.APPDATA || '', 'Tencent', 'xwechat', 'update');
}

/** 微信更新通道是否已被锁定（update 被换成只读文件）。 */
export async function isVersionLocked() {
  const up = updateDir();
  if (!fs.existsSync(up)) return false;
  try {
    if (fs.statSync(up).isDirectory()) return false;
  } catch {
    return false;
  }
  const { out } = await ps(
    `(Get-Item -LiteralPath '${up.replace(/'/g, "''")}' -ErrorAction SilentlyContinue).IsReadOnly`
  );
  return String(out).trim() === 'True';
}
