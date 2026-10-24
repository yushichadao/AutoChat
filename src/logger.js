const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

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
    const line = `${ts()} ${lv.toUpperCase().padEnd(5)} [${scope}]`;
    if (lv === 'error') console.error(line, ...args);
    else if (lv === 'warn') console.warn(line, ...args);
    else console.log(line, ...args);
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
