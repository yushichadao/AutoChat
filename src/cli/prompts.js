import process from 'node:process';

/**
 * 终端问答原语（CLI）。
 *
 * 职责边界：只负责「问一句话、拿一个答案」，以及输入守卫。
 * 具体问什么、怎么用答案，交给各个命令。
 */

/** 输入里不允许出现的符号（含反引号）。 */
const FORBIDDEN = [';', '&', '|', String.fromCharCode(96)];

/** 输入守卫：这里只填内容，不接受命令。 */
export function guardInput(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (t.length > 300) return '输入太长了，检查一下是不是粘错了东西';
  const first = t.charAt(0);
  if (first === '-' || first === '/') return '这里只填内容，不用以 - 或 / 开头';
  for (const ch of FORBIDDEN) {
    if (t.includes(ch)) return '这里不能包含分号、竖线、反引号这些符号';
  }
  return null;
}

/**
 * 创建问答器。
 * TTY 下逐句问；被管道喂输入时一次性读完，按行取。
 */
export async function createPrompter() {
  const isTty = Boolean(process.stdin.isTTY);
  let rl = null;
  let pending = [];

  if (!isTty) {
    const raw = await new Promise((resolve) => {
      let s = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => {
        s += d;
      });
      process.stdin.on('end', () => resolve(s));
      process.stdin.on('error', () => resolve(s));
    });
    pending = raw
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.length);
  } else {
    const { default: readline } = await import('node:readline/promises');
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  const ask = async (question, def = '') => {
    const tip = def ? ' [' + def + ']' : '';
    if (!isTty) {
      const first = pending.shift();
      const a = first == null ? '' : first;
      console.log(question + tip + '：' + a);
      return a.trim();
    }
    let a = '';
    try {
      a = String((await rl.question(question + tip + '：')) || '').trim();
    } catch {
      a = '';
    }
    const bad = guardInput(a);
    if (bad) {
      console.log('  ' + bad);
      return ask(question, def);
    }
    return a ? a : def;
  };

  const confirm = async (question, def = true) => {
    const a = (await ask(question + (def ? ' [Y/n]' : ' [y/N]'), '')).toLowerCase();
    if (!a) return def;
    return a === 'y' || a === 'yes';
  };

  const close = () => rl?.close();
  return { ask, confirm, close, isTty };
}
