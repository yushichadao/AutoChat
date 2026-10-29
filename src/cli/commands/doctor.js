import { ROOT } from '../../core/paths.js';
import { section, line, json, next, EXIT } from '../ui.js';
import { diagnose } from '../../tasks/doctor.js';

/**
 * autochat doctor —— 环境体检：问题清单 + 修复建议。
 * 退出码：0 没问题 / 2 有 bad 项 / 1 体检本身跑不起来。
 *  --scope chats / --chats：只查「哪些群在听」（群可用性），与基础设施体检并列。
 */
export async function run(ctx) {
  const scope = ctx.flag('chats') ? 'chats' : ctx.flag('scope') || 'infra';
  const result = await diagnose({ rootDir: ROOT, scope });
  const items = result.items || [];

  if (ctx.flag('json')) {
    json({ ok: result.ok, items });
    if (!result.ok) process.exitCode = EXIT.unhealthy;
    return;
  }

  section('环境体检');
  for (const it of items) {
    line(it.level, it.name, it.detail);
    if (it.next) next(it.next);
  }

  const bad = items.filter((i) => i.level === 'bad');
  const warn = items.filter((i) => i.level === 'warn');
  section('小结');
  line(bad.length ? 'bad' : 'ok', '阻断项', bad.length ? bad.length + ' 项需要先解决' : '没有');
  line(warn.length ? 'warn' : 'ok', '提醒项', warn.length ? warn.length + ' 项建议处理' : '没有');
  if (!bad.length) {
    line('ok', '助手不理人？', '多半是自动回复被暂停、模型连不上，或群里只有你自己在说话');
  }
  if (bad.length) process.exitCode = EXIT.unhealthy;
}
