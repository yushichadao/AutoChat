import { ROOT } from '../../core/paths.js';
import { section, line, json } from '../ui.js';
import { readContext, clearContext } from '../../tasks/context.js';

/**
 * autochat context —— 查看 / 清空上下文记忆。
 */
export async function run(ctx) {
  const chatId = ctx.positional[0];
  if (ctx.flag('clear')) {
    const r = clearContext(chatId ? chatId : '', ROOT);
    line(r.ok ? 'ok' : 'bad', '已清空', r.removed);
    return;
  }

  const info = readContext(ROOT);
  if (ctx.flag('json')) {
    json(info);
    return;
  }

  section('上下文记忆');
  if (!info.exists) {
    line('warn', '(还没有上下文记录)');
    return;
  }
  if (info.broken) {
    line('bad', '上下文文件损坏', info.file);
    return;
  }
  const rows = info.sessions.filter((s) => (chatId ? s.chatId === chatId : true));
  if (!rows.length) {
    line('warn', chatId ? '这个会话还没有上下文' : '(空)');
    return;
  }
  for (const s of rows) {
    line('ok', s.chatId, s.messages + ' 条 · ' + new Date(s.updatedAt).toLocaleString());
    for (const m of s.last) {
      console.log('      ' + (m.role === 'user' ? '›' : '‹') + ' ' + m.content);
    }
  }
}
