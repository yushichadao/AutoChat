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
/**
 * 身份类键（人设名 / 人设文件 / 系统提示）：必须严格按账号隔离，
 * 绝不让全局 .env 里的这些值串到别的账号（否则换号后 AI 会带着「前世」身份复活）。
 * 具体账号（wxid 非空）一律只取本账号 ai.json 里的身份键；本账号没配就回落内置默认，
 * 绝不回落别的账号。未指定账号（legacy / unknown）沿用旧行为，仍从全局 .env 取全量。
 */
/**
 * 身份类键（人设名 / 人设文件 / 系统提示）：必须严格按账号隔离，
 * 绝不让全局 .env 里的这些值串到别的账号（否则换号后 AI 会带着「前世」身份复活）。
 *
 * 重要：只有这三个键按账号隔离落到 ai.json。其余 AI_*（模型 / 接口地址 / 密钥 /
 * 限流等）一律来自全局 .env，不在 ai.json 里承载——否则某个账号的旧 ai.json 会静默
 * 盖掉全局模型，造成「在 GUI/`.env` 里改了模型却不生效」的坑（见 2026-10-30 修复）。
 */
export const IDENTITY_KEYS = ['AI_PERSONA_NAME', 'AI_PERSONA_FILE', 'AI_SYSTEM_PROMPT'];

export function loadAccountConfig({ rootDir = ROOT, wxid } = {}) {
  const base = loadConfig({ rootDir });
  const dataDir = base.dataDir;
  const wx = wxid || '';

  const flatAccount = loadAccountAi(dataDir, wx);

  // 把全局环境（进程环境 + .env 文件）里的身份键摘掉，得到「非身份」全局环境
  const cleanProcess = { ...process.env };
  const f = envFile(rootDir);
  let fileEnv = {};
  if (fs.existsSync(f)) {
    try { fileEnv = parseEnv(fs.readFileSync(f, 'utf8')); } catch { fileEnv = {}; }
  }
  for (const k of IDENTITY_KEYS) { delete cleanProcess[k]; delete fileEnv[k]; }

  // 账号级 ai.json 只承载「身份类键」，其余 AI_* 一律忽略（避免旧 ai.json 静默盖掉全局模型）。
  const accountOnly = {};
  for (const k of IDENTITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(flatAccount, k)) accountOnly[k] = flatAccount[k];
  }

  if (wx) {
    // 具体账号：身份键只来自本账号 ai.json；其余 AI_* 全部来自全局 .env（单一真值）。
    const merged = { ...cleanProcess, ...fileEnv, ...accountOnly };
    const cfg = loadConfig({ env: merged, rootDir });
    cfg.chats = loadAccountChats(dataDir, wx);
    return cfg;
  }

  // 未指定账号（legacy/unknown）：身份键同样只取 ai.json，其余来自全局 .env。
  let cfg = base;
  if (Object.keys(accountOnly).length) {
    const merged = { ...cleanProcess, ...fileEnv, ...accountOnly };
    cfg = loadConfig({ env: merged, rootDir });
  }
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
