import { ROOT } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { section, line, ok, json } from '../ui.js';
import { PauseState } from '../../core/pause.js';

/**
 * autochat resume —— 恢复自动回复。
 */
export async function run(ctx) {
  const cfg = loadConfig({ rootDir: ROOT });
  const sw = new PauseState({ file: cfg.dataDir + '/paused' });
  const r = sw.resume();
  if (ctx.flag('json')) {
    json(r);
    return;
  }
  section('恢复自动回复');
  line(r.ok ? 'ok' : 'bad', r.ok ? '已恢复' : '恢复失败', r.message);
}
