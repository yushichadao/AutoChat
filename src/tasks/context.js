import fs from 'node:fs';
import path from 'node:path';
import { accountMemoryFile } from '../core/account-profile.js';
import { ROOT } from '../core/paths.js';

/**
 * 上下文记忆读取与清空（任务层）。
 * 按当前登录账号隔离：给定 wxid 时读写 data/accounts/<wxid>/memory.json，否则退回旧全局 data/ai-memory.json。
 * 写入与裁剪策略在 src/ai/memory.js。
 */

export function memoryFile(rootDir = ROOT, wxid) {
  const dataDir = process.env.WX_DATA_DIR ? path.resolve(process.env.WX_DATA_DIR) : path.join(rootDir, 'data');
  return wxid ? accountMemoryFile(dataDir, wxid) : path.join(dataDir, 'ai-memory.json');
}

/** 读取全部会话的上下文概览。 */
export function readContext(rootDir = ROOT, wxid) {
  const file = memoryFile(rootDir, wxid);
  if (!fs.existsSync(file)) return { file, sessions: [], count: 0, exists: false };
  let bag = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    bag = raw.sessions || raw || {};
  } catch {
    return { file, sessions: [], count: 0, exists: true, broken: true };
  }
  const sessions = Object.entries(bag)
    .filter(([id]) => id !== '__v')
    .map(([id, s]) => ({
      chatId: id,
      messages: (s?.messages || []).length,
      updatedAt: s?.updatedAt || 0,
      last: (s?.messages || []).slice(-4).map((m) => ({
        role: m.role,
        content: String(m.content || '').slice(0, 120),
      })),
    }));
  return { file, sessions, count: sessions.length, exists: true };
}

/** 清空上下文记忆（不传 chatId 即清空全部）。 */
export function clearContext(chatId = '', rootDir = ROOT, wxid) {
  const file = memoryFile(rootDir, wxid);
  let raw = { __v: 1, sessions: {} };
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      raw = { __v: 1, sessions: {} };
    }
  }
  const bag = raw.sessions || {};
  if (chatId) delete bag[chatId];
  else for (const k of Object.keys(bag)) delete bag[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ __v: 1, sessions: bag }, null, 2), 'utf8');
  return { ok: true, file, removed: chatId || '全部' };
}
