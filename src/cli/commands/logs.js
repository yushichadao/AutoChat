import { ROOT } from '../../core/paths.js';
import { section, line, json, hint } from '../ui.js';
import { readLogTail } from '../../tasks/logs.js';

/**
 * autochat logs —— 看服务日志尾部。
 */
export async function run(ctx) {
  const lines = Number(ctx.opt('lines', '200')) || 200;
  const err = ctx.flag('err');
  const r = readLogTail({ rootDir: ROOT, lines, err });

  if (ctx.flag('json')) {
    json(r);
    return;
  }

  section(err ? '错误日志尾部' : '服务日志尾部');
  if (!r.exists) {
    line('warn', '还没有日志文件', r.file);
    hint('日志由「后台启动」产生（autochat start --background）；前台启动时日志直接打在终端里');
    return;
  }
  if (!r.lines.length) {
    line('warn', '日志是空的', r.file);
    return;
  }
  for (const l of r.lines) console.log('  ' + l);
  if (r.truncated) hint('只显示了尾部若干行（更早的内容已被截断）');
}
