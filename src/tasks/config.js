import { readEnvFile, setEnvValues } from '../core/env-file.js';
import { envFile, ROOT } from '../core/paths.js';

/**
 * 配置读写任务（任务层）。
 *
 * 职责边界：「哪些键允许被改」与「给界面看时怎么脱敏」只在这里定义一次，
 * CLI 与图形化配置器共用，避免两边白名单不一致。
 */

/** 敏感键：只回传「是否已配置」，真实值绝不下发到浏览器。 */
export const SENSITIVE_ENV = new Set(['AI_API_KEY', 'WX_WEBHOOK_TOKEN', 'AI_WEB_SEARCH_KEY', 'AI_LIGHT_API_KEY']);

/** 允许被界面修改的 .env 键（白名单）。 */
export const EDITABLE_ENV = new Set([
  'AI_ENABLED', 'AI_MASTER_SWITCH', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL',
  'AI_TIMEOUT_MS', 'AI_MAX_TOKENS', 'AI_TEMPERATURE', 'AI_CONTEXT_TURNS',
  'AI_REASONING_EFFORT', 'AI_REASONING_FORMAT', 'AI_REASONING_BUDGET',
  'AI_CONTEXT_TTL_MS', 'AI_CONTEXT_MAX_CHARS', 'AI_COOLDOWN_MS', 'AI_MAX_PER_HOUR',
  'AI_MAX_CONCURRENT', 'AI_GROUP_REPLY', 'AI_TRIGGER_PREFIX', 'AI_GROUP_AT_NAMES',
  'AI_ALLOW_CHATS', 'AI_DENY_CHATS', 'AI_MAX_REPLY_CHARS', 'AI_STRIP_MARKDOWN',
  'AI_VISION_MODEL', 'AI_VISION_UNSUPPORTED_TEXT', 'AI_MAX_IMAGE_BYTES', 'AI_MEMORY_SUMMARY_INTERVAL',
  'AI_REPLY_MODE', 'AI_BATCH_WINDOW_MS', 'AI_BATCH_MAX_MESSAGES', 'AI_BATCH_FLUSH_DELAY_MS',
  'AI_PERSONA_FILE', 'AI_PERSONA_NAME', 'AI_SYSTEM_PROMPT', 'WX_SELF_ID', 'WX_SELF_NAME', 'WX_SELF_MODE',
  'WX_RECEIVE_MODE', 'WX_POLL_CHATS', 'WX_POLL_DB', 'WX_POLL_LIMIT',
  'WX_POLL_INTERVAL_MS', 'WX_INJECT_MODE', 'WX_DLL_PATH', 'WX_INSTALL_DIR', 'WX_INSTALLER_PATH',
  'WX_HOOK_PORT', 'WX_WEBHOOK_PORT', 'WX_WEBHOOK_TOKEN', 'LOG_LEVEL',
  'AI_WEB_SEARCH', 'AI_WEB_SEARCH_PROVIDER', 'AI_WEB_SEARCH_KEY', 'AI_WEB_SEARCH_MODE',
  'AI_WEB_SEARCH_TRIGGER', 'AI_WEB_SEARCH_MAX_RESULTS', 'AI_WEB_SEARCH_MAX_CHARS', 'AI_WEB_SEARCH_CUSTOM_URL',
  'AI_TOOLS', 'AI_TOOLS_ALLOW', 'AI_TOOLS_MAX_ROUNDS',
  'AI_MODEL_ROUTING', 'AI_LIGHT_MODEL', 'AI_LIGHT_BASE_URL', 'AI_LIGHT_API_KEY',
  'AI_LONG_TASK_NOTICE',
  'AI_DOC_ANALYSIS', 'AI_DOC_MAX_CHARS', 'AI_DOC_OUT_DIR',
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

/**
 * 把「启用的会话」并入 WX_POLL_CHATS（并集）。
 *
 * 为什么必须自动做：当前适配的 hook DLL 不支持消息回调，只能轮询；
 * 新手不知道还有 WX_POLL_CHATS 要填，结果就是「会话加了、助手装死」。
 * 只做并集：用户手填的其它会话不会被删，明确移除的才剔除。
 *
 * @returns {string[]} 同步后的监听列表
 */
export function syncPollChats(chats, removed = [], rootDir = ROOT) {
  const env = readEditableEnv(rootDir);
  const cur = String(env.WX_POLL_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const enabled = Object.keys(chats || {}).filter((id) => (chats[id] || {}).enabled !== false);
  const gone = new Set((removed || []).map(String));
  const next = [];
  for (const id of [...cur, ...enabled]) {
    if (!id || gone.has(id) || next.includes(id)) continue;
    next.push(id);
  }
  if (next.join(',') !== cur.join(',')) writeEditableEnv({ WX_POLL_CHATS: next.join(',') }, rootDir);
  return next;
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
