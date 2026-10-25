import { ROOT } from '../../core/paths.js';
import { section, line } from '../ui.js';
import { startGui } from '../../gui/server.js';

/**
 * autochat gui —— 打开图形化配置器。
 * 与命令行平级的另一套入口：能做的事两边都能做。
 */
export async function run(ctx) {
  section('图形化配置器');
  const r = await startGui({
    rootDir: ROOT,
    port: Number(ctx.opt('port', '8788')) || 8788,
    window: ctx.flag('window') ? true : !ctx.flag('no-window'),
  });
  if (r && r.reused) {
    line('ok', '已在运行', '已帮你把窗口重新打开（没有重复起服务）');
  } else {
    line('ok', '已启动', r && r.url ? r.url.replace(/token=[^&]+/i, 'token=***') : '');
  }
}
