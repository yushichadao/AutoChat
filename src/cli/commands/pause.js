import { ROOT } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { section, line, ok, json, next } from '../ui.js';
import { PauseState } from '../../core/pause.js';

/**
 * autochat pause —— 暂停自动回复（立刻生效，仍接收消息、仍记日志）。
 */
export async function run(ctx) {
  const cfg = loadConfig({ rootDir: ROOT });
  const sw = new PauseState({ file: cfg.dataDir + '/paused' });
  const reason = ctx.positional.join(' ') ? ctx.positional.join(' ') : '命令行暂停';
  const r = sw.pause(reason);
  if (ctx.flag('json')) {
    json(r);
    return;
  }
  section('暂停自动回复');
  line(r.ok ? 'ok' : 'bad', r.ok ? '已暂停' : '暂停失败', r.ok ? '原因：' + reason : r.message);
  if (r.ok) next('恢复用 autochat resume');
}
