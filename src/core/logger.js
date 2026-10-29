const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * 日志脱敏开关（对外项目默认开启）。
 * 默认所有日志里的微信群 id、助手 wxid 都会被打码，避免把真实会话标识泄露出去。
 * 本地调试要看完整信息时，设 AUTOCHAT_MASK=0 关闭脱敏。
 * 每次 emit 读取，确保既支持 shell 环境变量，也支持写在 .env 里。
 */
const maskEnabled = () => process.env.AUTOCHAT_MASK !== '0';

/** 把一段疑似微信标识的 token 打码：保留可辨识后缀，遮住中间。 */
function maskToken(tok) {
  if (/^wxid_/i.test(tok)) {
    return tok.length <= 8 ? 'wxid_****' : `wxid_****${tok.slice(-3)}`;
  }
  if (/@chatroom$/i.test(tok)) {
    const at = tok.lastIndexOf('@');
    const head = tok.slice(0, at);
    return head.length <= 4 ? `****${tok.slice(at)}` : `****${head.slice(-4)}${tok.slice(at)}`;
  }
  return tok;
}

/** 对字符串做脱敏；非字符串原样返回。 */
function mask(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/(wxid_[A-Za-z0-9_-]+)|([A-Za-z0-9_-]+@chatroom)/g, (m) => maskToken(m));
}

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function normalizeLevel(value) {
  const v = String(value || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, v) ? v : 'info';
}

export function createLogger(scope = 'app', level = 'info') {
  const threshold = LEVELS[normalizeLevel(level)] ?? LEVELS.info;

  const emit = (lv, args) => {
    if (LEVELS[lv] < threshold) return;
    const out = maskEnabled() ? args.map((a) => (typeof a === 'string' ? mask(a) : a)) : args;
    const line = `${ts()} ${lv.toUpperCase().padEnd(5)} [${scope}]`;
    if (lv === 'error') console.error(line, ...out);
    else if (lv === 'warn') console.warn(line, ...out);
    else console.log(line, ...out);
  };

  return {
    level: normalizeLevel(level),
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    child: (sub) => createLogger(`${scope}:${sub}`, level),
  };
}
