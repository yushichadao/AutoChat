import process from 'node:process';

/**
 * 终端输出层（CLI）。
 *
 * 职责边界：只管怎么把字打出来——颜色、缩进、层级、JSON。
 * 不做业务判断，也不读文件。
 *
 * 颜色默认跟随终端：管道重定向到文件时自动关闭 ANSI，
 * 否则日志文件里会塞满转义符。
 */

const CODES = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

let colorEnabled = Boolean(process.stdout.isTTY);

/** 强制开关颜色（测试或 --no-color 用）。 */
export function setColor(on) {
  colorEnabled = Boolean(on);
}

/** 颜色是否开启。 */
export function hasColor() {
  return colorEnabled;
}

/** 给一段文字套上颜色码。 */
export function paint(name, text) {
  if (!colorEnabled) return String(text);
  const code = CODES[name];
  return code ? code + String(text) + CODES.reset : String(text);
}

/** 退出码约定：0 正常 / 1 参数或运行错误 / 2 体检存在 bad 项。 */
export const EXIT = { ok: 0, error: 1, unhealthy: 2 };

/** 小节标题。 */
export function section(title) {
  console.log('\n' + paint('bold', title));
}

/** 一条结论：ok / warn / bad。 */
export function line(level, name, detail = '') {
  const icon = level === 'ok' ? '✓' : level === 'warn' ? '!' : '✗';
  const color = level === 'ok' ? 'green' : level === 'warn' ? 'yellow' : 'red';
  const tail = detail ? ' ' + paint('dim', detail) : '';
  console.log('  ' + paint(color, icon) + ' ' + name + tail);
}

/** 补充说明（灰色小字）。 */
export function hint(text) {
  console.log('  ' + paint('dim', text));
}

/** 下一步建议。 */
export function next(text) {
  console.log('  ' + paint('cyan', '→ 下一步：') + text);
}

/** 键值表。 */
export function table(rows, headers = []) {
  if (headers.length) {
    console.log('  ' + paint('dim', headers.join('  ')));
  }
  for (const row of rows) {
    console.log('  ' + row.join('  '));
  }
}

/** 以 JSON 输出（--json 用）。 */
export function json(data) {
  console.log(JSON.stringify(data, null, 2));
}

/** 报错并设置退出码。 */
export function fail(message, code = EXIT.error) {
  console.error(paint('red', '✗ ') + message);
  process.exitCode = code;
}

/** 成功提示。 */
export function ok(message) {
  console.log(paint('green', '✓ ') + message);
}
