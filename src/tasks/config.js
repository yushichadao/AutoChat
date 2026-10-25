import { readEnvFile, setEnvValues } from '../core/env-file.js';
import { envFile, ROOT } from '../core/paths.js';

/**
 * 配置读写任务（任务层）。
 *
 * 职责边界：「哪些键允许被改」与「给界面看时怎么脱敏」只在这里定义一次，
 * CLI 与图形化配置器共用，避免两边白名单不一致。
 */

/** 敏感键：只回传「是否已配置」，真实值绝不下发到浏览器。 */
export const SENSITIVE_ENV = new Set(['AI_API_KEY', 'WX_WEBHOOK_TOKEN']);

/** 允许被界面修改的 .env 键（白名单）。 */
export const EDITABLE_ENV = new Set([
  'AI_ENABLED', 'AI_MASTER_SWITCH', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL',
  'AI_TIMEOUT_MS', 'AI_MAX_TOKENS', 'AI_TEMPERATURE', 'AI_CONTEXT_TURNS',
  'AI_CONTEXT_TTL_MS', 'AI_CONTEXT_MAX_CHARS', 'AI_COOLDOWN_MS', 'AI_MAX_PER_HOUR',
  'AI_MAX_CONCURRENT', 'AI_GROUP_REPLY', 'AI_TRIGGER_PREFIX', 'AI_GROUP_AT_NAMES',
  'AI_ALLOW_CHATS', 'AI_DENY_CHATS', 'AI_MAX_REPLY_CHARS', 'AI_STRIP_MARKDOWN',
  'AI_PERSONA_FILE', 'AI_SYSTEM_PROMPT', 'WX_SELF_ID', 'WX_SELF_MODE',
  'WX_RECEIVE_MODE', 'WX_POLL_CHATS', 'WX_POLL_DB', 'WX_POLL_LIMIT',
  'WX_POLL_INTERVAL_MS', 'WX_INJECT_MODE', 'WX_DLL_PATH', 'WX_INSTALL_DIR',
  'WX_HOOK_PORT', 'WX_WEBHOOK_PORT', 'WX_WEBHOOK_TOKEN', 'LOG_LEVEL',
]);

/** 脱敏：把 .env 转成可安全下发给界面的对象（敏感键只留布尔）。 */
export function safeEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = SENSITIVE_ENV.has(k) ? Boolean(v) : v;
  return out;
}

/** 读取 .env（已脱敏）。 */
export function readEditableEnv(rootDir = ROOT) {
  return safeEnv(readEnvFile(envFile(rootDir)));
}

/** 批量写入 .env（只接受白名单键；值为 null 表示删除该行）。 */
export function writeEditableEnv(values, rootDir = ROOT) {
  const updates = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!EDITABLE_ENV.has(k)) continue;
    updates[k] = v === null ? null : String(v);
  }
  return setEnvValues(envFile(rootDir), updates);
}
