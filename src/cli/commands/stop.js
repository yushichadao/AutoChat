import { ROOT } from '../../core/paths.js';
import { section, line, json, hint } from '../ui.js';
import { stopService } from '../../tasks/service.js';

/**
 * autochat stop —— 停止助手服务。
 */
export async function run(ctx) {
  const r = await stopService(ROOT);
  if (ctx.flag('json')) {
    json(r);
    return;
  }
  section('停止助手服务');
  line(r.ok ? 'ok' : 'bad', r.ok ? '已停止' : '停止失败', r.message);
  if (r.ok) hint('微信进程里可能还驻留着已注入的 hook DLL，重启微信即可清除');
}
