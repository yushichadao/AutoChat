import fs from 'node:fs';
import path from 'node:path';
import { ROOT, envFile } from './paths.js';
import { loadConfig, parseEnv } from './config.js';

/**
 * 按账号隔离的数据层（核心层）。
 *
 * 设计：同一台电脑先后登录不同微信号时，每个号拥有一套完全独立的数据，
 * 互不串读、互不串写。目录结构：
 *
 *   <dataDir>/accounts/<wxid>/
 *     memory.json     —— 上下文记忆（替代原来的全局 ai-memory.json）
 *     summary.json    —— 长期记忆摘要（替代原来的全局 ai-memory-summary.json）
 *     chats.json      —— 本账号监听的会话及其按会话配置（替代 config.json 的 chats）
 *     ai.json         —— 本账号的 AI/模型配置覆盖（扁平 AI_* 键，叠加在全局 .env 之上）
 *
 * 不兼容旧结构：运行时与 GUI 都只走这里；旧的全局 ai-memory.json / config.json.chats
 * 不再被活动路径读写（它们留在磁盘上无害，但不会被读取）。
 */

/** 当前账号的数据目录；wxid 为空时落到 'unknown'，避免路径出错。 */
export function accountDir(dataDir, wxid) {
  return path.join(dataDir, 'accounts', String(wxid || 'unknown'));
}

export const accountMemoryFile = (dataDir, wxid) => path.join(accountDir(dataDir, wxid), 'memory.json');
export const accountSummaryFile = (dataDir, wxid) => path.join(accountDir(dataDir, wxid), 'summary.json');
export const accountChatsFile = (dataDir, wxid) => path.join(accountDir(dataDir, wxid), 'chats.json');
export const accountAiFile = (dataDir, wxid) => path.join(accountDir(dataDir, wxid), 'ai.json');

/** 解析数据目录（与 loadConfig 规则一致）。 */
export function dataDirOf(rootDir = ROOT) {
  return process.env.WX_DATA_DIR ? path.resolve(process.env.WX_DATA_DIR) : path.join(rootDir, 'data');
}

function readJsonSafe(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonSafe(file, obj) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 读取本账号的会话配置（chats.json）。不存在返回空对象。 */
export function loadAccountChats(dataDir, wxid) {
  const raw = readJsonSafe(accountChatsFile(dataDir, wxid));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** 写入本账号的会话配置（chats.json）。 */
export function saveAccountChats(dataDir, wxid, chats) {
  writeJsonSafe(accountChatsFile(dataDir, wxid), chats && typeof chats === 'object' ? chats : {});
}

/** 读取本账号的 AI 配置覆盖（ai.json，扁平 AI_* 键）。不存在返回空对象。 */
export function loadAccountAi(dataDir, wxid) {
  const raw = readJsonSafe(accountAiFile(dataDir, wxid));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** 写入本账号的 AI 配置覆盖（ai.json，扁平 AI_* 键）。 */
export function saveAccountAi(dataDir, wxid, ai) {
  writeJsonSafe(accountAiFile(dataDir, wxid), ai && typeof ai === 'object' ? ai : {});
}

/**
 * 派生「本账号配置」：在全局配置（.env + config.json）之上，叠加当前账号的
 * 会话配置（chats.json）与 AI 配置覆盖（ai.json）。
 *
 * 实现方式：把扁平的 ai.json 键并入环境变量，再走一遍 loadConfig 归一化，
 * 这样所有 AI_* 键的解析逻辑与 .env 完全一致，不重复实现。
 *
 * @param {{rootDir?:string, wxid?:string}} opts
 * @returns {object} cfg（含 cfg.chats 已替换为当前账号的 chats.json）
 */
export function loadAccountConfig({ rootDir = ROOT, wxid } = {}) {
  const base = loadConfig({ rootDir });
  const dataDir = base.dataDir;
  const wx = wxid || '';

  const flatAccount = loadAccountAi(dataDir, wx);

  let cfg = base;
  if (flatAccount && Object.keys(flatAccount).length) {
    const f = envFile(rootDir);
    let fileEnv = {};
    if (fs.existsSync(f)) {
      try {
        fileEnv = parseEnv(fs.readFileSync(f, 'utf8'));
      } catch {
        fileEnv = {};
      }
    }
    // 进程环境 < .env 文件 < 本账号 ai.json（覆盖优先级最高）
    const merged = { ...process.env, ...fileEnv, ...flatAccount };
    cfg = loadConfig({ env: merged, rootDir });
  }

  // 会话配置始终以本账号 chats.json 为准；未指定账号落到 'unknown'（通常为空），
  // 绝不回退旧的全局 config.json.chats —— 否则换号后旧会话会漏给新号。
  cfg.chats = loadAccountChats(dataDir, wx);
  return cfg;
}

/**
 * 手动指定的「当前账号」覆盖（优先于 hook 自动探测）。
 * 用途：用户显式在某个号下操作、但 hook 自动探测偶发拿不到 wxid 时，
 * 用它保证 GUI / 助手稳定地认准这一个号，避免被探测抖动带偏。
 * 存于 <dataDir>/active-account.json。
 */
export function activeAccountFile(dataDir) {
  return path.join(dataDir, 'active-account.json');
}
export function loadActiveAccount(dataDir) {
  const raw = readJsonSafe(activeAccountFile(dataDir));
  return raw && typeof raw === 'object'
    ? { wxid: String(raw.wxid || ''), nickname: String(raw.nickname || '') }
    : { wxid: '', nickname: '' };
}
export function saveActiveAccount(dataDir, wxid, nickname) {
  writeJsonSafe(activeAccountFile(dataDir), {
    wxid: String(wxid || ''),
    nickname: String(nickname || ''),
  });
}
